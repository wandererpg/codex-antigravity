import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const installer = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));

test('Windows install preserves portable source manifests and isolates local registration', {
  skip: process.platform !== 'win32',
}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-antigravity-install-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('codex-antigravity-install-'));
    await rm(temp, { recursive: true, force: true });
  });

  const source = path.join(temp, 'release source');
  const codexHome = path.join(temp, 'isolated codex home');
  const runtime = path.join(codexHome, 'tools', 'codex-antigravity');
  const taskId = '11111111-1111-4111-8111-111111111111';
  const existingTaskId = '22222222-2222-4222-8222-222222222222';
  const files = {
    'package.json': JSON.stringify({ name: 'codex-antigravity', version: '0.2.1' }),
    'package-lock.json': '{}\n',
    'README.md': '# Portable source\n',
    '.gitignore': '.local/\nnode_modules/\n',
    '.mcp.json': '{"mcpServers":{"codex-antigravity":{"command":"node","args":["${PLUGIN_ROOT}/src/server.mjs"]}}}\n',
    'plugin.json': '{"name":"codex-antigravity","mcpServers":"./mcp.json"}\n',
    'mcp.json': '{"codex-antigravity":{"command":"node","args":["${PLUGIN_ROOT}/src/server.mjs"]}}\n',
    'src/server.mjs': '// This isolated fixture never starts a server.\n',
    'config/routing.json': '{}\n',
    'skills/codex-antigravity/SKILL.md': '# Current collaboration skill\n',
    '.codex-plugin/plugin.json': '{"name":"codex-antigravity"}\n',
    'test/fixture.txt': 'fixture\n',
    [`.local/tasks/${taskId}.json`]: '{"migrated":true}\n',
    [`.local/tasks/${existingTaskId}.json`]: '{"source":"older"}\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(source, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  const copiedInstaller = path.join(source, 'scripts', 'install.ps1');
  await copyFile(installer, copiedInstaller);

  // SkipDependencies needs a recognizable existing runtime and SDK marker. No npm
  // command, real Codex home, desktop service, or cloud model is used by this test.
  await mkdir(path.join(runtime, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
  await writeFile(path.join(runtime, 'package.json'), '{"name":"codex-antigravity"}\n');
  await writeFile(path.join(runtime, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}\n');
  await mkdir(path.join(runtime, '.local', 'tasks'), { recursive: true });
  await writeFile(path.join(runtime, '.local', 'tasks', `${existingTaskId}.json`), '{"runtime":"preserved"}\n');

  const config = 'model = "test-model"\n\n[features]\nexample = true\n\n[mcp_servers.other]\ncommand = "other-server"\n\n[mcp_servers.codex-antigravity]\ncommand = "obsolete-server"\n';
  await writeFile(path.join(codexHome, 'config.toml'), config);
  const oldSkill = '# Previous installed skill\n';
  const legacySkill = '# Legacy skill\n';
  await mkdir(path.join(codexHome, 'skills', 'codex-antigravity'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'codex-antigravity', 'SKILL.md'), oldSkill);
  await mkdir(path.join(codexHome, 'skills', 'antigravity-collaboration'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', 'antigravity-collaboration', 'SKILL.md'), legacySkill);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['path', 'codex_home'].includes(key.toLowerCase())) delete env[key];
  }
  env.CODEX_HOME = codexHome;
  env.Path = `${path.dirname(process.execPath)}${path.delimiter}${process.env.Path || process.env.PATH || ''}`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const install = () => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copiedInstaller, '-SkipDependencies'], {
      cwd: source, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };

  install();
  for (const filename of ['.mcp.json', 'mcp.json', 'plugin.json']) {
    assert.equal(await readFile(path.join(source, filename), 'utf8'), files[filename], `Source ${filename} changed`);
  }
  for (const filename of ['mcp.json', 'plugin.json']) {
    assert.equal(await readFile(path.join(runtime, filename), 'utf8'), files[filename], `Runtime ${filename} was not copied`);
  }
  const localManifest = JSON.parse(await readFile(path.join(runtime, '.mcp.json'), 'utf8'));
  const registration = localManifest.mcpServers['codex-antigravity'];
  assert.equal(path.resolve(registration.command).toLowerCase(), path.resolve(process.execPath).toLowerCase());
  assert.deepEqual(registration.args, [path.join(runtime, 'src', 'server.mjs')]);
  assert.equal(await readFile(path.join(codexHome, 'skills', 'codex-antigravity', 'SKILL.md'), 'utf8'), files['skills/codex-antigravity/SKILL.md']);
  assert.equal(await readFile(path.join(runtime, '.local', 'tasks', `${taskId}.json`), 'utf8'), files[`.local/tasks/${taskId}.json`]);
  assert.equal(await readFile(path.join(runtime, '.local', 'tasks', `${existingTaskId}.json`), 'utf8'), '{"runtime":"preserved"}\n');

  const backupDirectory = path.join(runtime, '.local', 'backups');
  const backups = await readdir(backupDirectory);
  const backupText = await Promise.all(backups.map(name => readFile(path.join(backupDirectory, name), 'utf8')));
  assert.ok(backupText.includes(config), 'Original Codex config was not backed up');
  assert.ok(backupText.includes(oldSkill), 'Previous skill was not backed up');
  assert.ok(backupText.includes(legacySkill), 'Legacy skill was not preserved');

  // Re-running an upgrade must preserve the portable source and unrelated config.
  install();
  const updatedConfig = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.ok(updatedConfig.includes('[features]\nexample = true'));
  assert.ok(updatedConfig.includes('[mcp_servers.other]\ncommand = "other-server"'));
  assert.equal((updatedConfig.match(/^\[mcp_servers\.codex-antigravity\]$/gm) || []).length, 1);
  assert.equal(await readFile(path.join(source, '.mcp.json'), 'utf8'), files['.mcp.json']);
});
