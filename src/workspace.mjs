import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './transport.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function absolutePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) return undefined;
  // Windows also calls "\folder" absolute, although its drive depends on cwd.
  // Accept only a drive-qualified path or a complete UNC path on Windows.
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)) return undefined;
  return path.resolve(value);
}

function fileRoot(root) {
  const uri = typeof root === 'string' ? root : root?.uri;
  if (typeof uri !== 'string') return undefined;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.search || url.hash) return undefined;
    return absolutePath(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function required(message) {
  throw new BridgeError('WORKSPACE_REQUIRED', message);
}

/** Resolve a directory without creating it or checking its filesystem state. */
export function resolveWorkspace({ explicitWorkspace, roots, workingDirectory } = {}) {
  if (explicitWorkspace !== undefined) {
    const workspace = absolutePath(explicitWorkspace);
    if (!workspace) throw new BridgeError('INVALID_WORKSPACE', 'workspace must be an absolute, fully qualified local directory path.');
    return { workspace, source: 'explicit' };
  }

  if (roots !== undefined && !Array.isArray(roots)) required('MCP roots must be a list of file URI roots. Supply the current chat workspace explicitly.');
  const uniqueRoots = new Map();
  for (const root of roots || []) {
    const directory = fileRoot(root);
    if (!directory) continue;
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    uniqueRoots.set(key, directory);
  }
  const directories = [...uniqueRoots.values()];
  if (directories.length === 1) return { workspace: directories[0], source: 'root' };

  const cwd = absolutePath(workingDirectory);
  const usableCwd = cwd && !contains(PLUGIN_ROOT, cwd);
  if (directories.length > 1) {
    const matches = usableCwd ? directories.filter(directory => contains(directory, cwd)) : [];
    if (matches.length === 1) return { workspace: matches[0], source: 'root' };
    required('Multiple MCP roots are available and the current directory does not identify exactly one. Supply the current chat workspace explicitly.');
  }

  if (usableCwd) return { workspace: cwd, source: 'cwd' };
  required('No unambiguous chat workspace is available. Supply its absolute directory; the plugin installation directory is not a workspace fallback.');
}
