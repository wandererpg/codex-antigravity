import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { BridgeError, LocalRpc, classifyApiError } from './transport.mjs';
import { selectModel, fallbackModel, routingConfig } from './routing.mjs';
import { resolveWorkspace } from './workspace.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATUS = { 0: 'unknown', 1: 'idle', 2: 'running', 3: 'canceling', 4: 'busy' };

export function summarizeTrajectory(response, task) {
  const steps = response.trajectory?.steps || [];
  const outputs = [];
  const errors = [];
  let needsAttention = false;
  for (const [index, step] of steps.entries()) {
    const output = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || step.notifyUser?.notificationContent || step.finish?.outputString;
    if (index >= (task.errorStepOffset || 0) && typeof output === 'string' && output) outputs.push(output);
    if (step.status === 9 || step.status === 'CORTEX_STEP_STATUS_WAITING') needsAttention = true;
    const err = index >= (task.errorStepOffset || 0) && (step.errorMessage?.error || step.error);
    if (err) {
      const raw = typeof err === 'string' ? err : JSON.stringify(err);
      const classified = classifyApiError(400, raw);
      errors.push({ code: classified.code, message: classified.message });
    }
  }
  const backendStatus = typeof response.status === 'number' ? STATUS[response.status] || 'unknown' : String(response.status || 'unknown').replace('CASCADE_RUN_STATUS_', '').toLowerCase();
  const active = ['running', 'busy', 'canceling'].includes(backendStatus);
  if (!active && !errors.length && task.submissionError) errors.push(task.submissionError);
  const state = needsAttention ? 'needs_attention' : active ? backendStatus : backendStatus !== 'idle' ? 'unknown' : errors.length ? 'failed' : task.cancelConfirmed ? 'canceled' : outputs.length ? 'completed' : 'idle';
  const output = outputs.join('\n\n');
  return {
    task_id: task.id, state, backend_status: backendStatus, model: task.model, effort: task.effort, task_type: task.taskType || 'simple', workspace: task.workspace,
    fallback_used: Boolean(task.fallbackUsed), ...(task.fallbackFrom ? { fallback_from: task.fallbackFrom } : {}),
    step_count: response.numTotalSteps ?? steps.length, output: output.slice(-48000), output_truncated: output.length > 48000,
    errors, ...(needsAttention ? { attention: 'Review this task in Antigravity. The bridge does not approve prompts or permissions automatically.' } : {}),
  };
}

export class Tasks {
  constructor({ rpc = new LocalRpc(), dataDir = path.join(ROOT, '.local'), workspaceContext = () => ({ workingDirectory: process.cwd() }) } = {}) {
    this.rpc = rpc; this.dataDir = dataDir; this.workspaceContext = workspaceContext;
  }
  async status() {
    const desktop = await this.rpc.connect();
    await this.rpc.call('GetCapabilities');
    return { connected: true, desktop_version: desktop.version, endpoint: desktop.origin, integration: 'local-private-api', model_access: 'not_checked', workspace_policy: 'Codex passes the active task workspace on every delegation; no fixed global workspace.' };
  }
  async models() {
    await this.rpc.connect();
    const data = await this.rpc.call('GetCascadeModelConfigData');
    return {
      routing: routingConfig, desktop_default_model: data.defaultOverrideModelConfig?.modelOrAlias,
      models: (data.clientModelConfigs || []).map(m => ({ id: m.modelId || m.modelOrAlias?.model || m.modelOrAlias?.alias, label: m.label, model: m.modelOrAlias, disabled: Boolean(m.disabled) })),
    };
  }
  async load(id) {
    if (!UUID.test(id)) throw new BridgeError('INVALID_TASK_ID', 'A bridge-issued UUID task_id is required.');
    try {
      const task = JSON.parse(await readFile(path.join(this.dataDir, 'tasks', `${id}.json`), 'utf8'));
      if (task.id !== id) throw new Error('mismatch');
      task.cancelRequested ||= await stat(path.join(this.dataDir, 'tasks', `${id}.cancel-requested`)).then(() => true, () => false);
      task.cancelConfirmed ||= await stat(path.join(this.dataDir, 'tasks', `${id}.cancel-confirmed`)).then(() => true, () => false);
      return task;
    } catch { throw new BridgeError('UNKNOWN_TASK', 'This bridge did not create that task. Existing user conversations cannot be read or canceled.'); }
  }
  async save(task) {
    const dir = path.join(this.dataDir, 'tasks');
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${task.id}.json`);
    const temp = `${dest}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(task, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, dest);
  }
  async withActionLock(id, action) {
    const lock = path.join(this.dataDir, 'tasks', `${id}.action-lock`);
    const deadline = Date.now() + 20000;
    while (true) {
      try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(await readFile(lock, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (ownerError) { if (ownerError.code === 'ESRCH') { await rm(lock, { force: true }); continue; } }
          }
        } catch (readError) { if (readError.code === 'ENOENT') continue; }
        if (Date.now() >= deadline) throw new BridgeError('TASK_BUSY', 'Another task action is still running. Poll this task again.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await action(); }
    finally { await rm(lock, { force: true }); }
  }
  async start({ prompt, workspace, model, mode = 'analysis', task_type = 'simple', fallback = true, effort = 'auto' }) {
    if (!['analysis', 'work'].includes(mode)) throw new BridgeError('INVALID_MODE', 'mode must be analysis or work.');
    if (!['simple', 'complex', 'discussion'].includes(task_type)) throw new BridgeError('INVALID_TASK_TYPE', 'task_type must be simple, complex, or discussion.');
    if (!['auto', 'medium', 'high'].includes(effort)) throw new BridgeError('INVALID_EFFORT', 'effort must be auto, medium, or high.');
    if (!prompt?.trim() || prompt.length > 64000) throw new BridgeError('INVALID_PROMPT', 'Provide a task prompt between 1 and 64000 characters.');
    if (workspace && !path.isAbsolute(workspace)) throw new BridgeError('INVALID_WORKSPACE', 'workspace must be an absolute path.');
    const resolved = resolveWorkspace({ ...(workspace ? {} : await this.workspaceContext()), explicitWorkspace: workspace });
    workspace = resolved.workspace;
    try { if (!(await stat(workspace)).isDirectory()) throw new Error('not a directory'); }
    catch { throw new BridgeError('INVALID_WORKSPACE', 'workspace must refer to an existing local directory.'); }
    const available = await this.models();
    const selected = selectModel(available.models, task_type, model, effort);
    const created = await this.rpc.call('StartCascade', {
      workspaceUris: [pathToFileURL(path.resolve(workspace)).href], source: 'CORTEX_TRAJECTORY_SOURCE_SDK',
      ...(selected.model.model ? { requestedModel: selected.model.model } : {}),
    });
    if (!UUID.test(created.cascadeId || '')) throw new BridgeError('INVALID_RESPONSE', 'Antigravity did not return a valid new task ID. No user message was sent.');
    const task = { id: created.cascadeId, model: selected.id, effort: selected.id.match(/-(medium|high)$/)?.[1] || effort, taskType: task_type, fallbackEnabled: fallback, mode, workspace: path.resolve(workspace), workspaceSource: resolved.source, createdAt: new Date().toISOString(), cancelRequested: false };
    await this.save(task);
    try {
      await this.rpc.call('SendUserCascadeMessage', {
        cascadeId: task.id, items: [{ text: `You are working as a delegated worker for Codex. Perform only the task below within the user's authorization. Do not deploy, publish, push, send messages, change credentials, or approve permission requests unless the task explicitly authorizes it. Report completed work, verification, and blockers.\n\n${prompt}` }],
        cascadeConfig: { plannerConfig: { requestedModel: selected.model, ...(mode === 'analysis' ? { toolConfig: { forceDisableToolCalling: true } } : {}) } }, blocking: false, propagateError: true,
      });
    } catch (error) {
      task.submissionError = { code: error.code || 'SUBMISSION_UNCERTAIN', message: error.code ? error.message : 'The message submission failed or timed out; inspect the existing task before retrying.' };
      await this.save(task);
      // Keep the ID: a timed-out send can already have reached the desktop.
      return { task_id: task.id, state: 'submission_error', error: { code: error.code || 'SUBMISSION_UNCERTAIN', message: error.message }, next_step: 'Use antigravity_get_task to inspect this task before submitting another.' };
    }
    return { task_id: task.id, state: 'submitted', model: task.model, effort: task.effort, task_type, mode, workspace: task.workspace, workspace_source: task.workspaceSource, next_step: 'Poll antigravity_get_task. A submitted task does not prove the model can run.' };
  }
  async quotaFallback(task, response, result) {
    if (task.fallbackEnabled === false || task.fallbackUsed || task.cancelRequested || result.state !== 'failed' || !result.errors.length || !result.errors.every(e => routingConfig.quotaFallback.errorCodes.includes(e.code))) return;
    return this.withActionLock(task.id, () => this.sendQuotaFallback(task, response));
  }
  async sendQuotaFallback(task, response) {
    task = await this.load(task.id);
    if (task.cancelRequested || task.fallbackUsed) return;
    const selected = fallbackModel((await this.models()).models, task.taskType, task.model);
    if (!selected) return;
    const claim = path.join(this.dataDir, 'tasks', `${task.id}.fallback-claimed`);
    try { await writeFile(claim, new Date().toISOString(), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    // The exclusive claim survives restarts, so two polling clients cannot retry
    // the same task twice. Never resend a timed-out continuation automatically.
    const latest = await this.load(task.id);
    if (latest.cancelRequested || latest.fallbackUsed) return;
    task = { ...latest, fallbackUsed: true, fallbackFrom: latest.model, model: selected.id, effort: selected.id.match(/-(medium|high)$/)?.[1] || latest.effort, errorStepOffset: response.trajectory?.steps?.length || 0 };
    delete task.submissionError;
    await this.save(task);
    try {
      await this.rpc.call('SendUserCascadeMessage', {
        cascadeId: task.id, items: [{ text: 'The previous Opus model exhausted its quota. Continue the existing authorized task using Gemini 3.8 Flash. Inspect the existing task history and current state; preserve completed work and do not repeat external actions or completed file changes. Report the result and verification. Keep the original task scope and permissions.' }],
        cascadeConfig: { plannerConfig: { requestedModel: selected.model, ...(task.mode === 'analysis' ? { toolConfig: { forceDisableToolCalling: true } } : {}) } }, blocking: false, propagateError: true,
      });
    } catch (error) {
      task.submissionError = { code: error.code || 'SUBMISSION_UNCERTAIN', message: error.code ? error.message : 'Fallback submission failed or timed out. No further automatic retry will be made.' };
      await this.save(task);
      return { ...summarizeTrajectory(response, task), state: 'submission_error', errors: [task.submissionError] };
    }
    return { task_id: task.id, state: 'fallback_submitted', model: task.model, fallback_used: true, fallback_from: task.fallbackFrom, next_step: 'Poll this same task id; Gemini 3.8 Flash is continuing the existing conversation.' };
  }
  async get({ task_id, wait_seconds = 0 }) {
    let task = await this.load(task_id);
    await this.rpc.connect();
    const until = Date.now() + Math.min(30, Math.max(0, wait_seconds)) * 1000;
    let result;
    do {
      task = await this.load(task_id);
      const response = await this.rpc.call('GetCascadeTrajectory', { cascadeId: task.id });
      result = summarizeTrajectory(response, task);
      const fallbackResult = await this.quotaFallback(task, response, result);
      if (fallbackResult) return fallbackResult;
      if (!['running', 'busy', 'canceling'].includes(result.state) || Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (true);
    return result;
  }
  async cancel({ task_id }) {
    const task = await this.load(task_id);
    await writeFile(path.join(this.dataDir, 'tasks', `${task.id}.cancel-requested`), new Date().toISOString(), { mode: 0o600 });
    await this.rpc.connect();
    await this.withActionLock(task.id, async () => {
      await this.rpc.call('CancelCascadeInvocation', { cascadeId: task.id, killBackgroundTasks: true });
      await writeFile(path.join(this.dataDir, 'tasks', `${task.id}.cancel-confirmed`), new Date().toISOString(), { mode: 0o600 });
    });
    return { task_id: task.id, state: 'cancellation_requested' };
  }
}
