import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { routingConfig } from './config.mjs';

const quotaPatterns = routingConfig.quotaFallback.errorMessagePatterns.map(pattern => new RegExp(pattern, 'i'));

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}

export function localOrigin(value, protocol) {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.protocol !== protocol || !url.port || url.username || url.password) {
    throw new BridgeError('INVALID_ENDPOINT', 'Only a literal 127.0.0.1 endpoint is allowed.');
  }
  return url.origin;
}

// The desktop serves a self-signed certificate. TLS relaxation is scoped to this
// one loopback request; it never changes NODE_TLS_REJECT_UNAUTHORIZED.
export function request(url, { method = 'GET', headers = {}, body, timeout = 15000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const parsed = new URL(url);
  localOrigin(url, parsed.protocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new BridgeError('INVALID_ENDPOINT', 'Unsupported protocol.');
  return new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? https : http).request(parsed, {
      method, headers, ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new BridgeError('RESPONSE_TOO_LARGE', 'Local service response exceeded the size limit.'));
          res.destroy();
          req.destroy();
        }
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new BridgeError('TIMEOUT', 'Local Antigravity request timed out.')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function discover({ profileDir = process.env.ANTIGRAVITY_PROFILE_DIR || path.join(process.env.APPDATA || '', 'Antigravity'), requestFn = request } = {}) {
  let portText;
  try { portText = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; }
  catch { throw new BridgeError('DESKTOP_NOT_RUNNING', 'Open Antigravity Desktop first; its local discovery file was not found.'); }
  if (!/^\d{1,5}$/.test(portText) || +portText < 1 || +portText > 65535) throw new BridgeError('INVALID_DISCOVERY', 'Invalid desktop discovery port.');
  try {
    const debugOrigin = `http://127.0.0.1:${portText}`;
    const version = await requestFn(`${debugOrigin}/json/version`);
    if (version.status !== 200 || !String(JSON.parse(version.body)['User-Agent']).includes('Antigravity/')) {
      throw new BridgeError('WRONG_DESKTOP', 'The discovery endpoint does not identify as Antigravity.');
    }
    const targetRes = await requestFn(`${debugOrigin}/json/list`);
    if (targetRes.status !== 200) throw new BridgeError('INVALID_DISCOVERY', 'Cannot list Antigravity pages.');
    const targets = JSON.parse(targetRes.body);
    const origins = [...new Set(targets.filter(t => t.type === 'page').flatMap(t => {
      try { return [localOrigin(t.url, 'https:')]; } catch { return []; }
    }))];
    if (origins.length !== 1) throw new BridgeError('AMBIGUOUS_DESKTOP', 'Expected one local Antigravity service; no task was submitted.');
    const root = await requestFn(`${origins[0]}/`);
    const match = root.body.match(/window\.__APP_CONFIG__\s*=\s*(\{[^\n]*?\})\s*;/);
    if (root.status !== 200 || !match) throw new BridgeError('UNSUPPORTED_DESKTOP', 'Cannot find desktop API configuration; the application may have changed.');
    const config = JSON.parse(match[1]);
    if (typeof config.csrfToken !== 'string' || !config.csrfToken || String(config.productName).toLowerCase() !== 'antigravity') {
      throw new BridgeError('UNSUPPORTED_DESKTOP', 'Unexpected local desktop API configuration.');
    }
    return { origin: origins[0], csrfToken: config.csrfToken, version: config.appVersion };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('DESKTOP_UNREACHABLE', 'Antigravity local service is unavailable. Restart Antigravity and retry.');
  }
}

export function classifyApiError(status, text) {
  if (/location is not supported|unsupported.{0,20}(country|region)|region.{0,20}not supported/i.test(text)) {
    return new BridgeError('LOCATION_UNSUPPORTED', 'Antigravity rejected the model request: User location is not supported for the API use. The MCP connection cannot remove this service restriction.');
  }
  if (status === 401 || /unauthenticated|not logged in/i.test(text)) return new BridgeError('AUTH_REQUIRED', 'Sign in through Antigravity Desktop and retry.');
  if (status === 429 || quotaPatterns.some(pattern => pattern.test(text))) return new BridgeError('QUOTA_EXCEEDED', 'Antigravity reported a quota or rate limit.');
  // Do not echo opaque backend bodies: they can contain local credentials or user content.
  return new BridgeError('ANTIGRAVITY_API_ERROR', `Antigravity rejected the request (HTTP ${status}). Check the application for details.`);
}

export class LocalRpc {
  constructor({ discoverFn = discover, requestFn = request } = {}) { this.discoverFn = discoverFn; this.requestFn = requestFn; }
  async connect() { this.connection = await this.discoverFn(); return { origin: this.connection.origin, version: this.connection.version }; }
  async call(method, payload = {}) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(method)) throw new BridgeError('INVALID_METHOD', 'Invalid RPC method.');
    if (!this.connection) await this.connect();
    const res = await this.requestFn(`${this.connection.origin}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': this.connection.csrfToken }, body: JSON.stringify(payload),
    });
    if (res.status < 200 || res.status >= 300) throw classifyApiError(res.status, res.body);
    let result;
    try { result = JSON.parse(res.body); } catch { throw new BridgeError('INVALID_RESPONSE', 'Antigravity returned a non-JSON RPC response.'); }
    return result;
  }
}
