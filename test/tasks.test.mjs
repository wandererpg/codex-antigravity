import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tasks } from '../src/tasks.mjs';
import { BridgeError } from '../src/transport.mjs';

const FLASH = 'gemini-3.8-flash-medium';
const OPUS = 'claude-opus-5-5-high';
const OPUS_MEDIUM = 'claude-opus-5-5-medium';
const ARGON = 'gemini-4-argon-medium';
const models = [
  { modelId: FLASH, label: 'Gemini 3.8 Flash (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M319' } },
  { modelId: OPUS, label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' } },
  { modelId: ARGON, label: 'Gemini 4 Argon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M418' } },
  { modelId: OPUS_MEDIUM, label: 'Claude Opus 5.5 (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M401' } },
];

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-tasks-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const rpc = {
    connect: async () => ({ origin: 'https://127.0.0.1:49234', version: '2.29.0' }),
    async call(method, payload = {}) {
      calls.push({ method, payload: structuredClone(payload) });
      if (options.handler) {
        const overridden = await options.handler(method, payload, calls);
        if (overridden !== undefined) return overridden;
      }
      if (method === 'GetCascadeModelConfigData') return { clientModelConfigs: models, defaultOverrideModelConfig: { modelOrAlias: models[2].modelOrAlias } };
      if (method === 'StartCascade') return { cascadeId: randomUUID() };
      if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [{ finish: { outputString: 'Done.' } }] } };
      return {};
    },
  };
  return { tasks: new Tasks({ rpc, dataDir, workspaceContext: options.workspaceContext || (() => ({ workingDirectory: dataDir })) }), calls, dataDir };
}

test('a task is created in an independent conversation and only its id is persisted for ownership', async t => {
  const { tasks, calls, dataDir } = await setup(t);
  const workspace = path.join(dataDir, 'explicit-workspace');
  await mkdir(workspace);
  const first = await tasks.start({ prompt: 'Analyze this supplied text.', workspace, model: FLASH });
  const second = await tasks.start({ prompt: 'Another independent task.', workspace, model: FLASH });
  assert.equal(first.state, 'submitted');
  assert.notEqual(first.task_id, second.task_id);
  assert.equal(first.model, FLASH);
  const starts = calls.filter(c => c.method === 'StartCascade');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].payload.workspaceUris, [pathToFileURL(workspace).href]);
  assert.equal('cascadeId' in starts[0].payload, false);
  const send = calls.find(c => c.method === 'SendUserCascadeMessage');
  assert.equal(send.payload.cascadeId, first.task_id);
  assert.equal(send.payload.blocking, false);
  assert.equal(send.payload.cascadeConfig.plannerConfig.toolConfig.forceDisableToolCalling, true);
  assert.deepEqual(send.payload.cascadeConfig.plannerConfig.requestedModel, models[0].modelOrAlias);
  const recordText = await readFile(path.join(dataDir, 'tasks', `${first.task_id}.json`), 'utf8');
  const record = JSON.parse(recordText);
  assert.equal(record.id, first.task_id);
  assert.equal(record.model, FLASH);
  assert.equal(recordText.includes('Analyze this supplied text.'), false);
});

test('unknown model is rejected before creating any Antigravity conversation', async t => {
  const { tasks, calls } = await setup(t);
  await assert.rejects(tasks.start({ prompt: 'A short task.', model: 'unavailable-model' }), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(calls.some(c => ['StartCascade', 'SendUserCascadeMessage'].includes(c.method)), false);
});

test('invalid local inputs do not reach the Antigravity service', async t => {
  const { tasks, calls } = await setup(t);
  await assert.rejects(tasks.start({ prompt: '   ' }), { code: 'INVALID_PROMPT' });
  await assert.rejects(tasks.start({ prompt: 'Task', mode: 'unrecognized' }), { code: 'INVALID_MODE' });
  await assert.rejects(tasks.start({ prompt: 'Task', workspace: 'relative-folder' }), { code: 'INVALID_WORKSPACE' });
  assert.equal(calls.length, 0);
});

test('get and cancel cannot access ids that were not created by this bridge', async t => {
  const { tasks, calls } = await setup(t);
  const foreignId = randomUUID();
  await assert.rejects(tasks.get({ task_id: foreignId }), { code: 'UNKNOWN_TASK' });
  await assert.rejects(tasks.cancel({ task_id: foreignId }), { code: 'UNKNOWN_TASK' });
  await assert.rejects(tasks.get({ task_id: '../other-file' }), { code: 'INVALID_TASK_ID' });
  assert.equal(calls.length, 0);
});

test('owned tasks can be read and canceled without listing user conversations', async t => {
  const { tasks, calls } = await setup(t);
  const submitted = await tasks.start({ prompt: 'A short task.', model: FLASH, task_type: 'simple' });
  const result = await tasks.get({ task_id: submitted.task_id });
  assert.equal(result.state, 'completed');
  assert.equal(result.output, 'Done.');
  const canceled = await tasks.cancel({ task_id: submitted.task_id });
  assert.equal(canceled.state, 'cancellation_requested');
  assert.deepEqual(calls.find(c => c.method === 'CancelCascadeInvocation').payload, { cascadeId: submitted.task_id, killBackgroundTasks: true });
  assert.equal((await tasks.load(submitted.task_id)).cancelRequested, true);
  assert.equal(calls.some(c => /AllCascade|ListConversation/.test(c.method)), false);
});

test('a send timeout keeps the task id and never repeats the model submission', async t => {
  const { tasks, calls } = await setup(t, { handler(method) {
    if (method === 'SendUserCascadeMessage') throw new BridgeError('TIMEOUT', 'Timed out.');
  } });
  const result = await tasks.start({ prompt: 'Task with uncertain submission.', model: FLASH });
  assert.equal(result.state, 'submission_error');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal((await tasks.load(result.task_id)).id, result.task_id);
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 1);
});

test('invalid task creation responses cannot submit a user message', async t => {
  const { tasks, calls } = await setup(t, { handler(method) {
    if (method === 'StartCascade') return { cascadeId: 'not-a-valid-task-id' };
  } });
  await assert.rejects(tasks.start({ prompt: 'Task.', model: FLASH }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.some(c => c.method === 'SendUserCascadeMessage'), false);
});

test('a backend location error is returned as failed even when the task is idle', async t => {
  const { tasks } = await setup(t, { handler(method) {
    if (method === 'GetCascadeTrajectory') return {
      status: 1,
      trajectory: { steps: [
        { plannerResponse: { response: 'Partial response before failure.' } },
        { errorMessage: { error: { userErrorMessage: 'User location is not supported for the API use.' } } },
      ] },
    };
  } });
  const submitted = await tasks.start({ prompt: 'Task.', model: FLASH, task_type: 'simple' });
  const result = await tasks.get({ task_id: submitted.task_id });
  assert.equal(result.state, 'failed');
  assert.equal(result.errors[0].code, 'LOCATION_UNSUPPORTED');
});

const quotaStep = () => ({ errorMessage: { error: { userErrorMessage: 'quota exceeded' } } });

test('task types select the user-requested Flash, Opus and Argon models', async t => {
  const { tasks } = await setup(t);
  for (const [task_type, expected] of [['simple', FLASH], ['complex', OPUS], ['discussion', ARGON]]) {
    const result = await tasks.start({ prompt: 'Task suited to the selected type.', task_type });
    assert.equal(result.model, expected);
    assert.equal((await tasks.load(result.task_id)).taskType, task_type);
  }
});

test('complex auto effort selects Opus High while an explicit Medium choice reaches the task planner', async t => {
  const { tasks, calls } = await setup(t);
  const automatic = await tasks.start({ prompt: 'A complex task.', task_type: 'complex' });
  assert.equal(automatic.model, OPUS);
  assert.equal(automatic.effort, 'high');
  const medium = await tasks.start({ prompt: 'A well-bounded complex task.', task_type: 'complex', effort: 'medium' });
  assert.equal(medium.model, OPUS_MEDIUM);
  assert.equal(medium.effort, 'medium');
  assert.deepEqual(calls.filter(c => c.method === 'SendUserCascadeMessage')[1].payload.cascadeConfig.plannerConfig.requestedModel, models[3].modelOrAlias);
});

test('omitted workspaces refresh from current context and explicit workspace wins over ambiguous roots', async t => {
  let context;
  const { tasks, calls, dataDir } = await setup(t, { workspaceContext: () => context });
  const firstDir = path.join(dataDir, 'first-project');
  const secondDir = path.join(dataDir, 'second-project');
  await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
  context = { workingDirectory: firstDir };
  assert.equal((await tasks.start({ prompt: 'First task.' })).workspace, firstDir);
  context = { workingDirectory: secondDir };
  assert.equal((await tasks.start({ prompt: 'Second task.' })).workspace, secondDir);
  context = { workingDirectory: dataDir, roots: [{ uri: pathToFileURL(firstDir).href }, { uri: pathToFileURL(secondDir).href }] };
  const beforeAmbiguous = calls.length;
  await assert.rejects(tasks.start({ prompt: 'Ambiguous task.' }), { code: 'WORKSPACE_REQUIRED' });
  assert.equal(calls.length, beforeAmbiguous);
  const explicit = await tasks.start({ prompt: 'Explicit task.', workspace: firstDir });
  assert.equal(explicit.workspace, firstDir);
  assert.equal(explicit.workspace_source, 'explicit');
});

test('complex quota failure falls back once within the same conversation and old errors no longer mask success', async t => {
  let fallbackSent = false;
  let newOutputReady = false;
  let activeWorkspace;
  const oldSteps = [{ plannerResponse: { response: 'Opus partial text before quota failure.' } }, quotaStep()];
  const { tasks, calls, dataDir } = await setup(t, { workspaceContext: () => ({ workingDirectory: activeWorkspace }), handler(method, payload, history) {
    if (method === 'SendUserCascadeMessage' && history.filter(c => c.method === method).length === 2) fallbackSent = true;
    if (method === 'GetCascadeTrajectory') return {
      status: 1,
      trajectory: { steps: newOutputReady ? [...oldSteps, { finish: { outputString: 'Flash completed the authorized task.' } }] : oldSteps },
    };
  } });
  activeWorkspace = dataDir;
  const submitted = await tasks.start({ prompt: 'A complex task.', task_type: 'complex' });
  assert.equal(submitted.model, OPUS);
  activeWorkspace = path.join(dataDir, 'new-current-project');
  await mkdir(activeWorkspace);
  const fallback = await tasks.get({ task_id: submitted.task_id });
  assert.equal(fallback.state, 'fallback_submitted');
  assert.equal(fallbackSent, true);
  assert.equal(fallback.model, FLASH);
  const record = await tasks.load(submitted.task_id);
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.fallbackFrom, OPUS);
  assert.equal(record.model, FLASH);
  assert.equal(record.errorStepOffset, oldSteps.length);
  assert.equal(record.workspace, submitted.workspace);
  assert.notEqual(record.workspace, activeWorkspace);
  const sends = calls.filter(c => c.method === 'SendUserCascadeMessage');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].payload.cascadeId, submitted.task_id);
  assert.deepEqual(sends[1].payload.cascadeConfig.plannerConfig.requestedModel, models[0].modelOrAlias);
  assert.equal(sends[1].payload.cascadeConfig.plannerConfig.toolConfig.forceDisableToolCalling, true);
  assert.equal(calls.filter(c => c.method === 'StartCascade').length, 1);
  const stale = await tasks.get({ task_id: submitted.task_id });
  assert.notEqual(stale.state, 'completed');
  assert.equal(stale.output, '');
  newOutputReady = true;
  const done = await tasks.get({ task_id: submitted.task_id });
  assert.equal(done.state, 'completed');
  assert.equal(done.fallback_used, true);
  assert.deepEqual(done.errors, []);
  assert.match(done.output, /Flash completed/);
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 2);
});

test('simple, discussion, and explicitly disabled fallback never switch models on quota failure', async t => {
  for (const options of [{ task_type: 'simple' }, { task_type: 'discussion' }, { task_type: 'complex', fallback: false }]) {
    const { tasks, calls } = await setup(t, { handler(method) {
      if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [quotaStep()] } };
    } });
    const submitted = await tasks.start({ prompt: 'Task.', ...options });
    const failed = await tasks.get({ task_id: submitted.task_id });
    assert.equal(failed.state, 'failed');
    assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 1);
  }
});

test('location, authentication, or mixed errors do not trigger a complex-task quota fallback', async t => {
  for (const errors of [
    ['User location is not supported for the API use.'],
    ['not logged in'],
    ['quota exceeded', 'User location is not supported for the API use.'],
  ]) {
    const { tasks, calls } = await setup(t, { handler(method) {
      if (method === 'GetCascadeTrajectory') return {
        status: 1,
        trajectory: { steps: errors.map(userErrorMessage => ({ errorMessage: { error: { userErrorMessage } } })) },
      };
    } });
    const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
    assert.equal((await tasks.get({ task_id: submitted.task_id })).state, 'failed');
    assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 1);
  }
});

test('a quota error from the fallback model is reported without an automatic retry loop', async t => {
  let fallbackSent = false;
  const { tasks, calls } = await setup(t, { handler(method, payload, history) {
    if (method === 'SendUserCascadeMessage' && history.filter(c => c.method === method).length === 2) fallbackSent = true;
    if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: fallbackSent ? [quotaStep(), quotaStep()] : [quotaStep()] } };
  } });
  const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
  assert.equal((await tasks.get({ task_id: submitted.task_id })).state, 'fallback_submitted');
  for (let i = 0; i < 2; i++) {
    const result = await tasks.get({ task_id: submitted.task_id });
    assert.equal(result.state, 'failed');
    assert.equal(result.errors[0].code, 'QUOTA_EXCEEDED');
  }
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 2);
});

test('concurrent polling can claim only one quota fallback', async t => {
  const { tasks, calls } = await setup(t, { async handler(method, payload, history) {
    if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [quotaStep()] } };
    if (method === 'SendUserCascadeMessage' && history.filter(c => c.method === method).length === 2) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  } });
  const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
  const results = await Promise.all([tasks.get({ task_id: submitted.task_id }), tasks.get({ task_id: submitted.task_id })]);
  assert.equal(results.filter(r => r.state === 'fallback_submitted').length, 1);
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 2);
  assert.equal((await tasks.load(submitted.task_id)).fallbackUsed, true);
});

test('a fallback send timeout persists uncertainty and is never retried by polling', async t => {
  const { tasks, calls } = await setup(t, { handler(method, payload, history) {
    if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [quotaStep()] } };
    if (method === 'SendUserCascadeMessage' && history.filter(c => c.method === method).length === 2) throw new BridgeError('TIMEOUT', 'Fallback send timed out.');
  } });
  const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
  const failed = await tasks.get({ task_id: submitted.task_id });
  assert.equal(failed.state, 'submission_error');
  const record = await tasks.load(submitted.task_id);
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.submissionError.code, 'TIMEOUT');
  const polled = await tasks.get({ task_id: submitted.task_id });
  assert.equal(polled.state, 'failed');
  assert.equal(polled.errors[0].code, 'TIMEOUT');
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 2);
});

test('a cancellation already in progress prevents a new quota fallback submission', async t => {
  let signalCancel;
  const cancelEntered = new Promise(resolve => { signalCancel = resolve; });
  let releaseCancel;
  const cancellationGate = new Promise(resolve => { releaseCancel = resolve; });
  const { tasks, calls } = await setup(t, { async handler(method) {
    if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [quotaStep()] } };
    if (method === 'CancelCascadeInvocation') { signalCancel(); await cancellationGate; return {}; }
  } });
  const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
  const canceling = tasks.cancel({ task_id: submitted.task_id });
  await cancelEntered;
  const polling = tasks.get({ task_id: submitted.task_id });
  // Permit a lock-based implementation to wait for the in-flight cancellation.
  try { await Promise.race([polling, new Promise(resolve => setTimeout(resolve, 25))]); }
  finally { releaseCancel(); await canceling; }
  await polling;
  assert.equal((await tasks.load(submitted.task_id)).cancelRequested, true);
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 1);
});

test('canceling after a fallback has begun preserves its model metadata and cancels the same conversation', async t => {
  let signalFallback;
  const fallbackEntered = new Promise(resolve => { signalFallback = resolve; });
  let releaseFallback;
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve; });
  const { tasks, calls } = await setup(t, { async handler(method, payload, history) {
    if (method === 'GetCascadeTrajectory') return { status: 1, trajectory: { steps: [quotaStep()] } };
    if (method === 'SendUserCascadeMessage' && history.filter(c => c.method === method).length === 2) {
      signalFallback(); await fallbackGate;
    }
  } });
  const submitted = await tasks.start({ prompt: 'Task.', task_type: 'complex' });
  const polling = tasks.get({ task_id: submitted.task_id });
  await fallbackEntered;
  const canceling = tasks.cancel({ task_id: submitted.task_id });
  releaseFallback();
  await Promise.all([polling, canceling]);
  const record = await tasks.load(submitted.task_id);
  assert.equal(record.cancelRequested, true);
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.model, FLASH);
  assert.equal(calls.filter(c => c.method === 'SendUserCascadeMessage').length, 2);
  assert.equal(calls.find(c => c.method === 'CancelCascadeInvocation').payload.cascadeId, submitted.task_id);
});
