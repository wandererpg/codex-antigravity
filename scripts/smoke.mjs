import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const client = new Client({ name: 'codex-antigravity-smoke-test', version: '0.2.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'inherit' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = JSON.parse(result.content.find(c => c.type === 'text').text);
  if (result.isError) throw new Error(JSON.stringify(value));
  return value;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name);
  if (tools.length !== 5) throw new Error(`Expected 5 tools, got ${tools.length}`);
  console.log(JSON.stringify({ tools, status: await call('antigravity_status'), model_count: (await call('antigravity_models')).models.length }, null, 2));
  if (process.argv.includes('--run-model') || process.argv.includes('--work-test')) {
    const work = process.argv.includes('--work-test');
    const workspace = fileURLToPath(new URL(`../.local/smoke-work-${Date.now()}/`, import.meta.url));
    await mkdir(workspace, { recursive: true });
    if (work) {
      await writeFile(path.join(workspace, 'seed.txt'), '7\n11\n13\n', 'utf8');
    }
    const task = await call('antigravity_start_task', work ? {
      workspace, mode: 'work', prompt: 'Bridge smoke test. In the supplied workspace read seed.txt, compute the sum of its integers, and create result.txt containing only the sum. Change no other files. Do not run shell commands or use the network. Then report the sum.',
    } : { workspace, task_type: process.argv.find(a => a.startsWith('--task-type='))?.split('=')[1] || 'simple', effort: process.argv.find(a => a.startsWith('--effort='))?.split('=')[1] || 'auto', prompt: 'Connectivity test: reply with exactly ANTIGRAVITY_MCP_OK. Do not use tools or change files.' });
    console.log(JSON.stringify(task, null, 2));
    const deadline = Date.now() + 120000;
    let result;
    do {
      result = await call('antigravity_get_task', { task_id: task.task_id, wait_seconds: 10 });
      if (['completed', 'failed', 'canceled', 'needs_attention'].includes(result.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== 'completed') throw new Error(`Task did not complete: ${result.state}`);
    if (work) {
      const sum = (await readFile(path.join(workspace, 'result.txt'), 'utf8')).trim();
      if (sum !== '31') throw new Error(`Unexpected work result: ${sum}`);
      console.log('MCP_WORK_TEST_OK: result.txt = 31');
    } else if (!result.output.includes('ANTIGRAVITY_MCP_OK')) throw new Error('Model did not return the expected marker.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
