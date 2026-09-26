/**
 * Realtime engine integration test (Node host).
 *
 * The engine in `public/realtime-engine.js` is framework-free by design, so it
 * can be hosted in Node and exercised against the real backend. This suite covers
 * the resilience requirements that are hard to trigger reliably in a browser:
 *
 *   - auth gating: no token => no connection attempt at all
 *   - handshake rejection -> exponential backoff (+jitter bounds) -> degradation
 *   - HTTP incremental polling actually delivers messages produced while the
 *     socket is down (cursor semantics)
 *   - background recovery back to WebSocket, and frames flowing again
 *   - session revoked by the server (logout) => stop, never reconnect
 *
 * Run: node test/engine.e2e.mjs            (backend must be listening on :3001)
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const POLL_URL = `${BASE}/api/messages/poll`;

await import(new URL('../public/realtime-engine.js', import.meta.url).href);
const { createRealtimeEngine, computeBackoff } = globalThis.StellaRealtime;
assert.ok(typeof createRealtimeEngine === 'function', 'engine failed to register on globalThis');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`  \u2717 ${name}\n      ${error.message}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, body: payload, data: payload?.data };
}

/** Two friends, ready to exchange messages. */
async function makePair() {
  const tag = uniq();
  const alice = { username: `eng_a_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'EngAlice' };
  const bob = { username: `eng_b_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'EngBob' };

  const a = await call('POST', '/api/auth/register', { body: alice });
  const b = await call('POST', '/api/auth/register', { body: bob });
  assert.equal(a.status, 201, `alice register failed: ${JSON.stringify(a.body)}`);
  assert.equal(b.status, 201, `bob register failed: ${JSON.stringify(b.body)}`);

  const request = await call('POST', '/api/friends/requests', {
    token: a.data.accessToken,
    body: { toUserId: b.data.user.id },
  });
  assert.equal(request.status, 201, `friend request failed: ${JSON.stringify(request.body)}`);
  const accepted = await call('POST', `/api/friends/requests/${request.data.request.id}/accept`, {
    token: b.data.accessToken,
  });
  assert.equal(accepted.status, 200, `accept failed: ${JSON.stringify(accepted.body)}`);

  return {
    alice: { ...alice, ...a.data },
    bob: { ...bob, ...b.data },
  };
}

function startEngine({ token, wsUrl = WS_URL, options = {} }) {
  const events = [];
  const engine = createRealtimeEngine({
    getToken: async () => token,
    fetch: (...args) => fetch(...args),
    WebSocket,
    emit: (event) => events.push(event),
    log: () => {},
    ...options,
  });
  engine.configure({ wsUrl, pollUrl: POLL_URL });
  return { engine, events };
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A tiny TCP proxy in front of the backend so the WebSocket link can be cut and
 * restored on the same port, simulating a real network outage.
 */
function createProxy(targetPort, listenPort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const teardown = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', resolve);
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
async function run() {
  console.log(`\nStella realtime engine test  (${BASE})\n`);

  console.log('Auth gating');
  await check('未登录时引擎不发起任何连接，并向上层索要令牌', async () => {
    const { engine, events } = startEngine({ token: null });
    engine.start();
    await sleep(300);
    const snapshot = engine.snapshot();
    assert.equal(snapshot.state, 'idle', `expected idle, got ${snapshot.state}`);
    assert.equal(snapshot.connected, false);
    assert.ok(events.some((e) => e.type === 'need-token'), 'engine never requested a token');
    engine.stop();
  });

  console.log('\nBackoff / degradation');
  await check('退避函数满足指数增长、抖动下限与上限约束', () => {
    assert.equal(computeBackoff(0, 1000, 30000, 0), 1000);
    assert.equal(computeBackoff(1, 1000, 30000, 0), 2000);
    assert.equal(computeBackoff(2, 1000, 30000, 0), 4000);
    assert.equal(computeBackoff(10, 1000, 30000, 0), 30000, 'cap not applied');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const raw = Math.min(30000, 1000 * 2 ** attempt);
      for (let i = 0; i < 40; i += 1) {
        const value = computeBackoff(attempt, 1000, 30000, 0.5);
        assert.ok(value >= raw * 0.5 && value <= raw, `jitter out of range: ${value} vs ${raw}`);
      }
    }
  });

  await check('无效令牌握手被拒 → 指数退避重连 → 超限自动降级轮询', async () => {
    const { engine, events } = startEngine({
      token: 'not.a.valid.token',
      options: {
        baseDelayMs: 60,
        maxDelayMs: 400,
        jitter: 0,
        maxReconnectAttempts: 3,
        wsRecoveryIntervalMs: 60_000,
        pollBaseIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        heartbeatCheckMs: 60_000,
      },
    });
    engine.start();
    await waitFor(
      () => events.some((e) => e.type === 'state' && e.state === 'polling'),
      6000,
      'degradation to polling'
    );

    const delays = events
      .filter((e) => e.type === 'state' && e.state === 'reconnecting' && e.nextRetryMs > 0)
      .map((e) => e.nextRetryMs);
    assert.deepStrictEqual(delays, [60, 120, 240], `unexpected backoff sequence: ${JSON.stringify(delays)}`);
    assert.equal(engine.snapshot().mode, 'poll');
    engine.stop();
  });

  await check('并发 start()/retryNow() 不会创建第二条连接（单连接不变量）', async () => {
    const created = [];
    class FakeSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0; // stays CONNECTING for the whole test
        created.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }

    const engine = createRealtimeEngine({
      getToken: async () => 'fake-token',
      fetch: () => Promise.reject(new Error('polling disabled in this test')),
      WebSocket: FakeSocket,
      emit: () => {},
      log: () => {},
      heartbeatIntervalMs: 60_000,
      heartbeatCheckMs: 60_000,
      baseDelayMs: 10,
      maxReconnectAttempts: 1,
    });
    engine.configure({ wsUrl: 'ws://fake/ws', pollUrl: 'http://fake/poll' });

    // (a) racing calls while the token lookup is still in flight
    engine.start();
    engine.retryNow();
    engine.retryNow();
    await sleep(40);

    // (b) calls while the socket exists but has not opened yet
    engine.retryNow();
    engine.retryNow();
    await sleep(40);

    assert.equal(created.length, 1, `engine opened ${created.length} sockets while one was still connecting`);
    engine.stop();
  });

  console.log('\nPolling fallback + recovery');
  const pair = await makePair();

  await check('长连接中断 → 降级轮询 → 增量拉取到中断期间产生的消息', async () => {
    const proxy = createProxy(3001, 3901);
    await proxy.listen();

    const { engine, events } = startEngine({
      token: pair.alice.accessToken,
      wsUrl: 'ws://127.0.0.1:3901/ws',
      options: {
        baseDelayMs: 80,
        maxDelayMs: 200,
        jitter: 0,
        maxReconnectAttempts: 2,
        wsRecoveryIntervalMs: 500,
        pollBaseIntervalMs: 250,
        pollMaxIntervalMs: 400,
        heartbeatIntervalMs: 60_000,
        heartbeatCheckMs: 60_000,
      },
    });
    engine.start();
    await waitFor(() => engine.snapshot().connected, 4000, 'initial websocket open');
    assert.equal(engine.snapshot().mode, 'ws');

    // Cut the link -> reconnect attempts fail -> degrade to polling.
    await proxy.close();
    await waitFor(() => engine.snapshot().mode === 'poll', 6000, 'degradation to polling');

    // A message produced while the socket is down must still arrive (increment).
    const sent = await call('POST', '/api/messages', {
      token: pair.bob.accessToken,
      body: { toUserId: pair.alice.user.id, content: 'while-you-were-down', clientMsgId: `eng-${uniq()}` },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    await waitFor(
      () => events.some((e) => e.type === 'poll' && e.messages.some((m) => m.content === 'while-you-were-down')),
      6000,
      'incremental poll to deliver the missed message'
    );

    // Restore the network -> engine must climb back to the WebSocket by itself.
    await proxy.listen();
    await waitFor(() => engine.snapshot().connected && engine.snapshot().mode === 'ws', 8000, 'websocket recovery');
    const recoveredAt = events.length;

    // New traffic must arrive as a socket FRAME (not a poll).
    const second = await call('POST', '/api/messages', {
      token: pair.bob.accessToken,
      body: { toUserId: pair.alice.user.id, content: 'back-on-the-socket', clientMsgId: `eng-${uniq()}` },
    });
    assert.equal(second.status, 201);

    await waitFor(
      () =>
        events
          .slice(recoveredAt)
          .some((e) => e.type === 'frame' && e.frame?.type === 'chat:message' && e.frame?.message?.content === 'back-on-the-socket'),
      6000,
      'chat frame after recovery'
    );
    assert.ok(
      !events.slice(recoveredAt).some((e) => e.type === 'state' && e.state === 'polling'),
      'engine fell back to polling again after recovery'
    );

    engine.stop();
    await proxy.close().catch(() => {});
  });

  console.log('\nSession revocation');
  await check('服务端登出（令牌版本失效）→ 引擎收到会话失效并彻底停止重连', async () => {
    const { engine, events } = startEngine({
      token: pair.bob.accessToken,
      options: { baseDelayMs: 60, maxDelayMs: 120, maxReconnectAttempts: 2, heartbeatIntervalMs: 60_000, heartbeatCheckMs: 60_000 },
    });
    engine.start();
    await waitFor(() => engine.snapshot().connected, 4000, 'websocket open');

    const logout = await call('POST', '/api/auth/logout', { token: pair.bob.accessToken });
    assert.equal(logout.status, 200);

    await waitFor(
      () => events.some((e) => e.type === 'session-invalid'),
      5000,
      'session-invalid notification'
    );

    const stateCount = events.length;
    await sleep(400);
    assert.ok(
      !events.slice(stateCount).some((e) => e.type === 'need-token'),
      'engine kept trying to refresh after a deliberate logout'
    );
    assert.equal(engine.snapshot().connected, false);
    engine.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(` - ${f.name}: ${f.error.message}`);
  }
  return failed === 0;
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error('fatal:', error);
    process.exit(1);
  });
