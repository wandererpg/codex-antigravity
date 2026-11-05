import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolveWorkspace } from '../src/workspace.mjs';

const name = process.argv[2];
const allowed = new Set(['antigravity_status', 'antigravity_models', 'antigravity_start_task', 'antigravity_get_task', 'antigravity_cancel_task']);
if (!allowed.has(name)) {
  console.error('Usage: node scripts/call.mjs TOOL [--input-file arguments.json | --stdin]');
  process.exit(2);
}
const client = new Client({ name: 'codex-antigravity-local-client', version: '0.2.0' });
try {
  let raw = '{}';
  const inputIndex = process.argv.indexOf('--input-file');
  if (inputIndex >= 0) {
    if (!process.argv[inputIndex + 1]) throw new Error('Missing --input-file path.');
    raw = await readFile(process.argv[inputIndex + 1], 'utf8');
  } else if (process.argv.includes('--stdin')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  const args = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (name === 'antigravity_start_task' && !args.workspace) args.workspace = resolveWorkspace({ workingDirectory: process.cwd() }).workspace;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'inherit' }));
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await client.close(); }
