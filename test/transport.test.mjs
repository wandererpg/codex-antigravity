import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { BridgeError, localOrigin, request, discover, LocalRpc, classifyApiError } from '../src/transport.mjs';
import { summarizeTrajectory } from '../src/tasks.mjs';

const csrf = 'test-only-csrf-do-not-echo';

async function profile(t, port = '49123') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-transport-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/test\n`);
  return dir;
}

function desktopReplies({ product = 'antigravity', userAgent = 'Antigravity/2.29.0', targets } = {}) {
  const seen = [];
  const requestFn = async url => {
    seen.push(url);
    if (url.endsWith('/json/version')) return { status: 200, body: JSON.stringify({ 'User-Agent': userAgent }) };
    if (url.endsWith('/json/list')) return {
      status: 200,
      body: JSON.stringify(targets || [
        { type: 'page', url: 'https://127.0.0.1:49234/c/test-conversation' },
        { type: 'iframe', url: 'https://127.0.0.1:49999/plugin' },
        { type: 'page', url: 'https://example.com/' },
      ]),
    };
    if (url === 'https://127.0.0.1:49234/') return {
      status: 200,
      body: `<script>window.__APP_CONFIG__ = ${JSON.stringify({ productName: product, csrfToken: csrf, appVersion: '2.29.0' })};</script>`,
    };
    throw new Error(`Unexpected test request: ${url}`);
  };
  return { seen, requestFn };
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('only literal loopback origins without embedded credentials are accepted', () => {
  assert.equal(localOrigin('https://127.0.0.1:4321/c/test', 'https:'), 'https://127.0.0.1:4321');
  for (const url of [
    'https://example.com:4321/', 'https://localhost:4321/', 'https://[::1]:4321/',
    'https://user:password@127.0.0.1:4321/', 'http://127.0.0.1:4321/',
  ]) assert.throws(() => localOrigin(url, 'https:'), { code: 'INVALID_ENDPOINT' });
  assert.throws(() => request('https://example.com:4321/'), { code: 'INVALID_ENDPOINT' });
});

test('discovery uses current profile ports and never opens unrelated page content', async t => {
  const profileDir = await profile(t);
  const replies = desktopReplies();
  const found = await discover({ profileDir, requestFn: replies.requestFn });
  assert.deepEqual(found, { origin: 'https://127.0.0.1:49234', csrfToken: csrf, version: '2.29.0' });
  assert.deepEqual(replies.seen, [
    'http://127.0.0.1:49123/json/version', 'http://127.0.0.1:49123/json/list', 'https://127.0.0.1:49234/',
  ]);
});

test('discovery refuses multiple eligible service origins', async t => {
  const profileDir = await profile(t);
  const replies = desktopReplies({ targets: [
    { type: 'page', url: 'https://127.0.0.1:49234/c/a' },
    { type: 'page', url: 'https://127.0.0.1:49235/c/b' },
  ] });
  await assert.rejects(discover({ profileDir, requestFn: replies.requestFn }), { code: 'AMBIGUOUS_DESKTOP' });
  assert.equal(replies.seen.length, 2);
});

test('discovery rejects stale ports and mismatched desktop identities', async t => {
  const invalid = await profile(t, '70000');
  await assert.rejects(discover({ profileDir: invalid, requestFn: async () => assert.fail('Must not connect') }), { code: 'INVALID_DISCOVERY' });
  const profileDir = await profile(t);
  await assert.rejects(discover({ profileDir, requestFn: desktopReplies({ userAgent: 'Chrome/1' }).requestFn }), { code: 'WRONG_DESKTOP' });
  await assert.rejects(discover({ profileDir, requestFn: desktopReplies({ product: 'different-app' }).requestFn }), { code: 'UNSUPPORTED_DESKTOP' });
});

test('RPC authenticates locally while connect result omits the CSRF token', async () => {
  const calls = [];
  const rpc = new LocalRpc({
    discoverFn: async () => ({ origin: 'https://127.0.0.1:49234', csrfToken: csrf, version: '2.29.0' }),
    requestFn: async (url, options) => { calls.push({ url, options }); return { status: 200, body: '{"accepted":true}' }; },
  });
  const connected = await rpc.connect();
  assert.deepEqual(connected, { origin: 'https://127.0.0.1:49234', version: '2.29.0' });
  assert.equal(JSON.stringify(connected).includes(csrf), false);
  assert.deepEqual(await rpc.call('GetCapabilities', { example: 1 }), { accepted: true });
  assert.equal(calls[0].url, 'https://127.0.0.1:49234/exa.language_server_pb.LanguageServerService/GetCapabilities');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['Connect-Protocol-Version'], '1');
  assert.equal(calls[0].options.headers['X-Codeium-Csrf-Token'], csrf);
  assert.deepEqual(JSON.parse(calls[0].options.body), { example: 1 });
  await assert.rejects(rpc.call('../GetCapabilities'), { code: 'INVALID_METHOD' });
  assert.equal(calls.length, 1);
});

test('RPC errors distinguish location, authentication and quota without echoing opaque bodies', async () => {
  const examples = [
    [400, 'User location is not supported for the API use.', 'LOCATION_UNSUPPORTED'],
    [401, csrf, 'AUTH_REQUIRED'],
    [429, csrf, 'QUOTA_EXCEEDED'],
    [400, 'resource_exhausted', 'QUOTA_EXCEEDED'],
    [500, csrf, 'ANTIGRAVITY_API_ERROR'],
  ];
  for (const [status, body, code] of examples) {
    const error = classifyApiError(status, body);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(csrf), false);
  }
  const rpc = new LocalRpc({
    discoverFn: async () => ({ origin: 'https://127.0.0.1:49234', csrfToken: csrf, version: '2.29.0' }),
    requestFn: async () => ({ status: 400, body: 'User location is not supported for the API use.' }),
  });
  await assert.rejects(rpc.call('GetCapabilities'), { code: 'LOCATION_UNSUPPORTED' });
});

test('successful non-JSON RPC responses fail clearly', async () => {
  const rpc = new LocalRpc({
    discoverFn: async () => ({ origin: 'https://127.0.0.1:49234', csrfToken: csrf }),
    requestFn: async () => ({ status: 200, body: `<html>${csrf}</html>` }),
  });
  await assert.rejects(rpc.call('GetCapabilities'), error => error.code === 'INVALID_RESPONSE' && !error.message.includes(csrf));
});

test('HTTP transport bounds response size and does not follow redirects', async t => {
  let followed = 0;
  const origin = await localServer(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else if (req.url === '/target') { followed++; res.end('should not be fetched'); }
    else res.end('a'.repeat(1024));
  });
  await assert.rejects(request(`${origin}/large`, { maxBytes: 16 }), { code: 'RESPONSE_TOO_LARGE' });
  const result = await request(`${origin}/redirect`);
  assert.equal(result.status, 302);
  assert.equal(followed, 0);
});

test('HTTP transport times out an unresponsive local service', async t => {
  const origin = await localServer(t, () => {});
  await assert.rejects(request(`${origin}/slow`, { timeout: 25 }), { code: 'TIMEOUT' });
});

test('partial text without a known terminal backend status is not reported as completed', () => {
  const task = { id: 'f440c3c7-705f-4877-bd9b-e48c1fa52709', model: 'test', workspace: 'test' };
  for (const status of [undefined, 0, 'CASCADE_RUN_STATUS_UNSPECIFIED']) {
    const result = summarizeTrajectory({ status, trajectory: { steps: [{ plannerResponse: { response: 'partial text' } }] } }, task);
    assert.equal(result.state, 'unknown');
  }
});

test('a completed finish after an earlier blocking notification clears historical attention', () => {
  const task = { id: 'f440c3c7-705f-4877-bd9b-e48c1fa52709', model: 'test', workspace: 'test' };
  const steps = [
    { notifyUser: { isBlocking: true, notificationContent: 'Please review this step.' } },
    { finish: { outputString: 'Completed after review.' } },
  ];
  const result = summarizeTrajectory({ status: 1, trajectory: { steps } }, task);
  assert.equal(result.state, 'completed');
  assert.equal('attention' in result, false);
  assert.equal(summarizeTrajectory({ status: 1, trajectory: { steps: [{ ...steps[0], status: 9 }] } }, task).state, 'needs_attention');
});
