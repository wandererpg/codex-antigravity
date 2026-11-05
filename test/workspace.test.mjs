import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWorkspace } from '../src/workspace.mjs';

const plugin = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const project = path.join(os.tmpdir(), 'antigravity-workspace-resolution', 'project');
const other = path.join(os.tmpdir(), 'antigravity-workspace-resolution', 'other');
const root = directory => ({ uri: pathToFileURL(directory).href });
const hasCode = code => error => error.code === code;

test('explicit workspace takes priority over roots and cwd', () => {
  assert.deepEqual(resolveWorkspace({ explicitWorkspace: project, roots: [root(other)], workingDirectory: other }), { workspace: project, source: 'explicit' });
});

test('an explicitly chosen plugin project is allowed', () => {
  assert.deepEqual(resolveWorkspace({ explicitWorkspace: plugin }), { workspace: plugin, source: 'explicit' });
});

test('invalid explicit paths are rejected instead of using another directory', () => {
  for (const explicitWorkspace of ['relative/path', '', null, `${project}\0invalid`]) {
    assert.throws(() => resolveWorkspace({ explicitWorkspace, workingDirectory: other }), hasCode('INVALID_WORKSPACE'));
  }
  if (process.platform === 'win32') {
    for (const explicitWorkspace of ['C:relative', '\\unqualified']) {
      assert.throws(() => resolveWorkspace({ explicitWorkspace, workingDirectory: other }), hasCode('INVALID_WORKSPACE'));
    }
  }
});

test('one file URI root outranks a different or absent cwd', () => {
  assert.deepEqual(resolveWorkspace({ roots: [root(project)], workingDirectory: other }), { workspace: project, source: 'root' });
  assert.deepEqual(resolveWorkspace({ roots: [root(project)] }), { workspace: project, source: 'root' });
});

test('file roots decode spaces, percent signs and non-ASCII names', () => {
  const directory = path.join(project, '任务 100%');
  assert.deepEqual(resolveWorkspace({ roots: [root(directory)] }), { workspace: directory, source: 'root' });
});

test('duplicate normalized roots are one root', () => {
  const duplicate = pathToFileURL(path.join(project, '.')).href;
  assert.deepEqual(resolveWorkspace({ roots: [root(project), { uri: duplicate }] }), { workspace: project, source: 'root' });
  if (process.platform === 'win32') {
    assert.equal(resolveWorkspace({ roots: [root(project), root(project.toUpperCase())] }).source, 'root');
  }
});

test('multiple roots select only the one containing cwd', () => {
  assert.deepEqual(resolveWorkspace({ roots: [root(project), root(other)], workingDirectory: path.join(project, 'src') }), { workspace: project, source: 'root' });
});

test('multiple roots do not guess when cwd is outside or missing', () => {
  assert.throws(() => resolveWorkspace({ roots: [root(project), root(other)] }), hasCode('WORKSPACE_REQUIRED'));
  assert.throws(() => resolveWorkspace({ roots: [root(project), root(other)], workingDirectory: os.tmpdir() }), hasCode('WORKSPACE_REQUIRED'));
});

test('overlapping roots remain ambiguous when both contain cwd', () => {
  assert.throws(() => resolveWorkspace({ roots: [root(project), root(path.join(project, 'nested'))], workingDirectory: path.join(project, 'nested', 'src') }), hasCode('WORKSPACE_REQUIRED'));
});

test('a path prefix is not directory containment', () => {
  assert.throws(() => resolveWorkspace({ roots: [root(project), root(other)], workingDirectory: `${project}-unrelated` }), hasCode('WORKSPACE_REQUIRED'));
});

test('unavailable or empty roots use a valid external cwd', () => {
  assert.deepEqual(resolveWorkspace({ workingDirectory: project }), { workspace: project, source: 'cwd' });
  assert.deepEqual(resolveWorkspace({ roots: [], workingDirectory: project }), { workspace: project, source: 'cwd' });
});

test('non-file and malformed roots cannot become filesystem directories', () => {
  const roots = [{ uri: 'https://example.com/project' }, { uri: 'not a URI' }, { uri: `${pathToFileURL(project).href}?wrong=true` }];
  assert.deepEqual(resolveWorkspace({ roots, workingDirectory: other }), { workspace: other, source: 'cwd' });
});

test('plugin startup cwd and all child directories are not fallback workspaces', () => {
  for (const workingDirectory of [plugin, path.join(plugin, 'node_modules'), path.join(plugin, 'scripts'), path.join(plugin, 'src')]) {
    assert.throws(() => resolveWorkspace({ workingDirectory }), hasCode('WORKSPACE_REQUIRED'));
    assert.throws(() => resolveWorkspace({ roots: [root(plugin), root(other)], workingDirectory }), hasCode('WORKSPACE_REQUIRED'));
  }
});

test('a single client root can explicitly identify the plugin as its project', () => {
  assert.deepEqual(resolveWorkspace({ roots: [root(plugin)] }), { workspace: plugin, source: 'root' });
});

test('missing and relative cwd never produce an implicit scratch directory', () => {
  assert.throws(() => resolveWorkspace(), hasCode('WORKSPACE_REQUIRED'));
  assert.throws(() => resolveWorkspace({ workingDirectory: 'relative' }), hasCode('WORKSPACE_REQUIRED'));
});

test('Windows UNC roots remain absolute filesystem paths', { skip: process.platform !== 'win32' }, () => {
  const directory = '\\\\server\\share\\task folder';
  assert.deepEqual(resolveWorkspace({ roots: [root(directory)] }), { workspace: path.resolve(directory), source: 'root' });
});
