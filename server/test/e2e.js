'use strict';

/**
 * End-to-end integration test.
 *
 * Boots a dedicated server instance (separate port, fast system-notice cadence)
 * against the real MySQL instance, then exercises the whole contract:
 *   - HTTP auth (register / login / refresh rotation / reuse detection / logout)
 *   - friend request + accept flow with real WebSocket push
 *   - bidirectional chat over WebSocket + HTTP
 *   - incremental polling cursor
 *   - WebSocket handshake authentication (unauthenticated + invalid token)
 *   - server-side session revocation closing live sockets
 *   - two-minute system notice broadcast (accelerated)
 *
 * Run: node test/e2e.js
 */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const WebSocket = require('ws');

const PORT = Number(process.env.E2E_PORT || 3101);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`  \u2717 ${name}\n      ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: payload, data: payload && payload.data };
}

/** Opens a WS connection and records every frame it receives. */
function openSocket(token) {
  const url = token ? `${WS_BASE}?token=${encodeURIComponent(token)}` : WS_BASE;
  const ws = new WebSocket(url);
  const frames = [];
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore */
    }
  });
  ws.frames = frames;
  ws.received = (type) => frames.filter((f) => f.type === type);
  return ws;
}

function waitForOpen(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Waits until a frame matching `predicate` has been received. */
async function waitForFrame(ws, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = ws.frames.find(predicate);
    if (hit) return hit;
    await sleep(40);
  }
  throw new Error(`frame not received within ${timeoutMs}ms (got: ${ws.frames.map((f) => f.type).join(',') || 'none'})`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
async function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SYSTEM_NOTICE_MS: '2500',
      LOG_LEVEL: 'warn',
      DB_NAME: process.env.DB_NAME || 'stella_im',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return child;
    } catch {
      /* not ready yet */
    }
    await sleep(300);
  }
  child.kill();
  throw new Error('server failed to become healthy');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
async function run() {
  const tag = uniq();
  const alice = { username: `alice_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'Alice' };
  const bob = { username: `bob_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'Bob' };

  console.log(`\nStella IM end-to-end test  (port ${PORT}, users ${alice.username} / ${bob.username})\n`);

  console.log('HTTP auth');
  await check('health endpoint responds', async () => {
    const r = await api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.status, 'up');
  });

  await check('protected route rejects missing token', async () => {
    const r = await api('GET', '/api/friends');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'NO_TOKEN');
  });

  await check('register creates an account and returns tokens', async () => {
    const r = await api('POST', '/api/auth/register', { body: alice });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.data.accessToken && r.data.refreshToken);
    alice.user = r.data.user;
    alice.access = r.data.accessToken;
    alice.refresh = r.data.refreshToken;
  });

  await check('duplicate username is rejected', async () => {
    const r = await api('POST', '/api/auth/register', { body: alice });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'USERNAME_TAKEN');
  });

  await check('weak username is rejected', async () => {
    const r = await api('POST', '/api/auth/register', { body: { username: 'a', password: 'passw0rd' } });
    assert.strictEqual(r.status, 400);
  });

  await check('wrong password is rejected', async () => {
    const r = await api('POST', '/api/auth/login', { body: { username: alice.username, password: 'nope-nope' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'BAD_CREDENTIALS');
  });

  await check('register second user (bob)', async () => {
    const r = await api('POST', '/api/auth/register', { body: bob });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    bob.user = r.data.user;
    bob.access = r.data.accessToken;
    bob.refresh = r.data.refreshToken;
  });

  await check('login returns a fresh session', async () => {
    const r = await api('POST', '/api/auth/login', { body: { username: alice.username, password: alice.password } });
    assert.strictEqual(r.status, 200);
    alice.access = r.data.accessToken;
    alice.refresh = r.data.refreshToken;
  });

  console.log('\nWebSocket handshake authentication');
  await check('unauthenticated handshake is rejected with 401', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_BASE);
      ws.on('open', () => reject(new Error('connection unexpectedly succeeded')));
      ws.on('unexpected-response', (_req, res) => {
        try {
          assert.strictEqual(res.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('error', (err) => {
        if (String(err.message).includes('401')) resolve();
        else reject(err);
      });
    });
  });

  await check('invalid token handshake is rejected', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}?token=not-a-real-jwt`);
      ws.on('open', () => reject(new Error('connection unexpectedly succeeded')));
      ws.on('unexpected-response', (_req, res) => {
        res.statusCode === 401 ? resolve() : reject(new Error(`status ${res.statusCode}`));
      });
      ws.on('error', (err) => {
        if (String(err.message).includes('401')) resolve();
        else reject(err);
      });
    });
  });

  await check('authenticated handshake succeeds and sends ready frame', async () => {
    alice.ws = openSocket(alice.access);
    await waitForOpen(alice.ws, 6000);
    await waitForFrame(alice.ws, (f) => f.type === 'ready');
  });

  await check('bob connects over WebSocket', async () => {
    bob.ws = openSocket(bob.access);
    await waitForOpen(bob.ws, 6000);
  });

  console.log('\nFriendship flow');
  await check('search finds the other user', async () => {
    const r = await api('GET', `/api/friends/search?q=${encodeURIComponent(bob.username)}`, { token: alice.access });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.users.some((u) => u.id === bob.user.id), 'bob not found in search');
  });

  await check('friend request pushes friend:request to recipient', async () => {
    const r = await api('POST', '/api/friends/requests', {
      token: alice.access,
      body: { toUserId: bob.user.id, message: 'hi, let us chat' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const frame = await waitForFrame(bob.ws, (f) => f.type === 'friend:request');
    assert.strictEqual(frame.request.peer.id, alice.user.id);
    bob.requestId = frame.request.id;
  });

  await check('recipient sees the pending request', async () => {
    const r = await api('GET', '/api/friends/requests', { token: bob.access });
    assert.ok(r.data.requests.some((q) => q.id === bob.requestId && q.direction === 'incoming'));
  });

  await check('accept pushes friend:accepted to both sides', async () => {
    const r = await api('POST', `/api/friends/requests/${bob.requestId}/accept`, { token: bob.access });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.status, 'accepted');
    await waitForFrame(alice.ws, (f) => f.type === 'friend:accepted');
    await waitForFrame(bob.ws, (f) => f.type === 'friend:accepted');
  });

  await check('friend list is symmetric', async () => {
    const a = await api('GET', '/api/friends', { token: alice.access });
    const b = await api('GET', '/api/friends', { token: bob.access });
    assert.ok(a.data.friends.some((f) => f.id === bob.user.id));
    assert.ok(b.data.friends.some((f) => f.id === alice.user.id));
  });

  console.log('\nChat');
  const clientMsgId = `e2e-${uniq()}`;
  await check('WS message is persisted, acked to sender and pushed to recipient', async () => {
    alice.ws.send(
      JSON.stringify({ type: 'chat:send', clientMsgId, toUserId: bob.user.id, content: 'hello over ws' })
    );
    const inbound = await waitForFrame(bob.ws, (f) => f.type === 'chat:message' && f.message.clientMsgId === clientMsgId);
    assert.strictEqual(inbound.message.content, 'hello over ws');
    assert.strictEqual(inbound.message.fromUserId, alice.user.id);
    const echo = await waitForFrame(alice.ws, (f) => f.type === 'chat:message' && f.message.clientMsgId === clientMsgId);
    assert.ok(echo.message.id > 0, 'echoed message has no id');
    alice.lastMessageId = echo.message.id;
  });

  await check('HTTP send reaches the recipient over the live socket', async () => {
    const r = await api('POST', '/api/messages', {
      token: bob.access,
      body: { toUserId: alice.user.id, content: 'reply over http', clientMsgId: `e2e-${uniq()}` },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const frame = await waitForFrame(alice.ws, (f) => f.type === 'chat:message' && f.message.content === 'reply over http');
    bob.lastMessageId = r.data.message.id;
    assert.ok(frame.message.id > 0);
  });

  await check('sending to a non-friend is refused', async () => {
    const outsider = { username: `out_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'Out' };
    const reg = await api('POST', '/api/auth/register', { body: outsider });
    const r = await api('POST', '/api/messages', {
      token: reg.data.accessToken,
      body: { toUserId: alice.user.id, content: 'spam' },
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'NOT_FRIENDS');
  });

  await check('history returns the conversation in chronological order', async () => {
    const r = await api('GET', `/api/messages/history?friendId=${bob.user.id}&limit=50`, { token: alice.access });
    assert.strictEqual(r.status, 200);
    const contents = r.data.messages.map((m) => m.content);
    assert.ok(contents.includes('hello over ws'));
    assert.ok(contents.includes('reply over http'));
    const ids = r.data.messages.map((m) => m.id);
    assert.deepStrictEqual(ids, [...ids].sort((x, y) => x - y), 'history not ascending');
  });

  await check('incremental poll returns only rows past the cursor', async () => {
    const r = await api('GET', `/api/messages/poll?sinceId=${alice.lastMessageId}`, { token: alice.access });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.messages.every((m) => m.id > alice.lastMessageId), 'poll returned already-seen rows');
    assert.ok(r.data.messages.length >= 1, 'poll missed the http reply');
  });

  await check('empty poll advances the cursor without duplicates', async () => {
    const first = await api('GET', '/api/messages/poll?sinceId=0', { token: alice.access });
    const maxId = Math.max(0, ...first.data.messages.map((m) => m.id));
    const second = await api('GET', `/api/messages/poll?sinceId=${maxId}`, { token: alice.access });
    assert.strictEqual(second.data.messages.length, 0);
  });

  await check('read receipt propagates to the author', async () => {
    const r = await api('POST', '/api/messages/read', { token: bob.access, body: { ids: [alice.lastMessageId] } });
    assert.strictEqual(r.status, 200);
    await waitForFrame(alice.ws, (f) => f.type === 'chat:status' && f.status === 2);
  });

  await check('friend list exposes the newest message for list previews', async () => {
    const r = await api('GET', '/api/friends', { token: alice.access });
    assert.strictEqual(r.status, 200);
    const entry = r.data.friends.find((f) => f.id === bob.user.id);
    assert.ok(entry, 'friend missing from the list');
    assert.ok(entry.lastMessage, 'friend list did not include lastMessage');
    assert.ok(typeof entry.lastMessage.content === 'string' && entry.lastMessage.content.length > 0);
    assert.strictEqual(entry.lastMessage.fromUserId, bob.user.id, 'lastMessage should be the newest reply');
  });

  await check('friend list reports unread messages for the login snapshot', async () => {
    // Bob sends a message Alice has not read yet.
    const sent = await api('POST', '/api/messages', {
      token: bob.access,
      body: { toUserId: alice.user.id, content: 'unread ping', clientMsgId: `un-${uniq()}` },
    });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    const r = await api('GET', '/api/friends', { token: alice.access });
    const entry = r.data.friends.find((f) => f.id === bob.user.id);
    assert.ok(entry.unread >= 1, `expected unread >= 1, got ${entry.unread}`);

    // Reading it lowers the count on the next snapshot.
    await api('POST', '/api/messages/read', { token: alice.access, body: { ids: [sent.data.message.id] } });
    const after = await api('GET', '/api/friends', { token: alice.access });
    const remaining = after.data.friends.find((f) => f.id === bob.user.id).unread;
    assert.ok(remaining < entry.unread, `unread did not decrease (was ${entry.unread}, now ${remaining})`);
  });

  console.log('\nToken governance');
  await check('refresh rotates the token pair', async () => {
    const r = await api('POST', '/api/auth/refresh', { body: { refreshToken: alice.refresh } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.notStrictEqual(r.data.refreshToken, alice.refresh, 'refresh token was not rotated');
    alice.oldRefresh = alice.refresh;
    alice.access = r.data.accessToken;
    alice.refresh = r.data.refreshToken;
  });

  await check('reusing a rotated refresh token invalidates the whole family', async () => {
    const r = await api('POST', '/api/auth/refresh', { body: { refreshToken: alice.oldRefresh } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'REFRESH_REUSED');
  });

  await check('session revocation closes the live socket', async () => {
    const closed = new Promise((resolve) => bob.ws.once('close', (code) => resolve(code)));
    const r = await api('POST', '/api/auth/logout', { token: bob.access });
    assert.strictEqual(r.status, 200);
    const code = await Promise.race([closed, sleep(4000).then(() => 'timeout')]);
    assert.notStrictEqual(code, 'timeout', 'socket was not closed on logout');
  });

  await check('revoked access token is rejected on REST', async () => {
    const r = await api('GET', '/api/auth/me', { token: bob.access });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'SESSION_REVOKED');
  });

  await check('revoked token cannot complete a WS handshake', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(bob.access)}`);
      ws.on('open', () => reject(new Error('connection unexpectedly succeeded')));
      ws.on('unexpected-response', (_r, res) => (res.statusCode === 401 ? resolve() : reject(new Error(`${res.statusCode}`))));
      ws.on('error', (err) => (String(err.message).includes('401') ? resolve() : reject(err)));
    });
  });

  console.log('\nSystem notice broadcast');
  await check('two-minute job broadcasts a server-time notice to live sockets', async () => {
    const login = await api('POST', '/api/auth/login', { body: { username: bob.username, password: bob.password } });
    bob.access = login.data.accessToken;
    const ws = openSocket(bob.access);
    await waitForOpen(ws, 6000);
    const frame = await waitForFrame(ws, (f) => f.type === 'notice:system', 8000);
    assert.ok(/服务端时间/.test(frame.notice.content), 'notice content missing server time');
    bob.noticeSeen = frame.notice.id;
    ws.close();
  });

  await check('the same notice is available through HTTP polling', async () => {
    const r = await api('GET', `/api/system/notices?sinceId=${bob.noticeSeen - 1}`, { token: bob.access });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.notices.some((n) => n.id === bob.noticeSeen), 'notice not persisted for pollers');
  });

  // -------------------------------------------------------------------------
  // Remaining documented surface: validation, reject flow, auto-accept contract
  // -------------------------------------------------------------------------
  console.log('\nBonus endpoints & validation');

  await check('GET /api/auth/me returns the current user for a valid token', async () => {
    // NB: alice's tokens were deliberately revoked by the refresh-reuse test
    // above, so use bob's freshly-issued session here.
    const r = await api('GET', '/api/auth/me', { token: bob.access });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.user.username, bob.username);
  });

  await check('GET /api/system/time exposes the server clock', async () => {
    const r = await api('GET', '/api/system/time');
    assert.strictEqual(r.status, 200);
    assert.ok(!Number.isNaN(Date.parse(r.data.serverTime)));
    assert.match(r.data.formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  await check('unknown routes return a structured 404', async () => {
    const r = await api('GET', '/api/definitely-not-a-route');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, 'ROUTE_NOT_FOUND');
  });

  // Fresh users so the reject/auto-accept flows cannot disturb the earlier pair.
  const carol = { username: `carol_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'Carol' };
  const dave = { username: `dave_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'Dave' };
  let carolSession;
  let daveSession;

  await check('registers a third and fourth user for the request flows', async () => {
    const c = await api('POST', '/api/auth/register', { body: carol });
    const d = await api('POST', '/api/auth/register', { body: dave });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    assert.strictEqual(d.status, 201, JSON.stringify(d.body));
    carolSession = c.data;
    daveSession = d.data;
  });

  await check('friend request validation rejects self / unknown targets', async () => {
    const self = await api('POST', '/api/friends/requests', {
      token: carolSession.accessToken,
      body: { toUserId: carolSession.user.id },
    });
    assert.strictEqual(self.status, 400);
    assert.strictEqual(self.body.code, 'SELF_REQUEST');

    const ghost = await api('POST', '/api/friends/requests', {
      token: carolSession.accessToken,
      body: { toUserId: 999_999_999 },
    });
    assert.strictEqual(ghost.status, 404);
    assert.strictEqual(ghost.body.code, 'USER_NOT_FOUND');
  });

  let carolRequestId;
  await check('POST /api/friends/requests -> 201 with outcome "requested"', async () => {
    const r = await api('POST', '/api/friends/requests', {
      token: carolSession.accessToken,
      body: { toUserId: daveSession.user.id, message: 'please add me' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.data.outcome, 'requested');
    assert.strictEqual(r.data.request.direction, 'outgoing');
    assert.strictEqual(r.data.request.peer.id, daveSession.user.id);
    carolRequestId = r.data.request.id;
  });

  await check('re-sending without a message keeps the original note', async () => {
    const r = await api('POST', '/api/friends/requests', {
      token: carolSession.accessToken,
      body: { toUserId: daveSession.user.id },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.request.id, carolRequestId, 'a second row was created instead of upserting');
    assert.strictEqual(r.data.request.message, 'please add me', 'the original message was clobbered');
  });

  await check('only the recipient may reject; reject closes without befriending', async () => {
    const wrongUser = await api('POST', `/api/friends/requests/${carolRequestId}/reject`, {
      token: bob.access,
    });
    assert.strictEqual(wrongUser.status, 403);
    assert.strictEqual(wrongUser.body.code, 'NOT_RECIPIENT');

    const rejected = await api('POST', `/api/friends/requests/${carolRequestId}/reject`, {
      token: daveSession.accessToken,
    });
    assert.strictEqual(rejected.status, 200);
    assert.strictEqual(rejected.data.status, 'rejected');

    const again = await api('POST', `/api/friends/requests/${carolRequestId}/reject`, {
      token: daveSession.accessToken,
    });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'REQUEST_CLOSED');

    const unknown = await api('POST', '/api/friends/requests/999999999/accept', {
      token: daveSession.accessToken,
    });
    assert.strictEqual(unknown.status, 404);

    const carolFriends = await api('GET', '/api/friends', { token: carolSession.accessToken });
    assert.strictEqual(carolFriends.data.friends.length, 0, 'reject must not create a friendship');
  });

  await check('a rejected request can be revived and then accepted', async () => {
    const revived = await api('POST', '/api/friends/requests', {
      token: carolSession.accessToken,
      body: { toUserId: daveSession.user.id, message: 'second try' },
    });
    assert.strictEqual(revived.status, 201);
    assert.strictEqual(revived.data.outcome, 'requested');

    const accepted = await api('POST', `/api/friends/requests/${revived.data.request.id}/accept`, {
      token: daveSession.accessToken,
    });
    assert.strictEqual(accepted.status, 200);

    const carolFriends = await api('GET', '/api/friends', { token: carolSession.accessToken });
    assert.ok(carolFriends.data.friends.some((f) => f.id === daveSession.user.id));
  });

  await check('mirrored request auto-accepts with outcome "auto-accepted" and HTTP 200', async () => {
    // dave -> carol while they are already friends must be a conflict...
    const already = await api('POST', '/api/friends/requests', {
      token: daveSession.accessToken,
      body: { toUserId: carolSession.user.id },
    });
    assert.strictEqual(already.status, 409);
    assert.strictEqual(already.body.code, 'ALREADY_FRIENDS');

    // ...so use a fresh pair to exercise the mirrored-pending-request path.
    const eve = { username: `eve_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'Eve' };
    const frank = { username: `frank_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'Frank' };
    const eveSession = (await api('POST', '/api/auth/register', { body: eve })).data;
    const frankSession = (await api('POST', '/api/auth/register', { body: frank })).data;

    const first = await api('POST', '/api/friends/requests', {
      token: eveSession.accessToken,
      body: { toUserId: frankSession.user.id, message: 'hi from eve' },
    });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.data.outcome, 'requested');

    const mirrored = await api('POST', '/api/friends/requests', {
      token: frankSession.accessToken,
      body: { toUserId: eveSession.user.id },
    });
    assert.strictEqual(mirrored.status, 200, `expected 200, got ${mirrored.status}: ${JSON.stringify(mirrored.body)}`);
    assert.strictEqual(mirrored.data.outcome, 'auto-accepted');
    assert.strictEqual(mirrored.data.friend.id, eveSession.user.id);

    const eveFriends = await api('GET', '/api/friends', { token: eveSession.accessToken });
    assert.ok(eveFriends.data.friends.some((f) => f.id === frankSession.user.id), 'auto-accept did not create the friendship');
  });

  await check('message validation rejects empty / self / non-friend targets', async () => {
    const empty = await api('POST', '/api/messages', {
      token: carolSession.accessToken,
      body: { toUserId: daveSession.user.id, content: '   ' },
    });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.body.code, 'EMPTY_CONTENT');

    const self = await api('POST', '/api/messages', {
      token: carolSession.accessToken,
      body: { toUserId: carolSession.user.id, content: 'x' },
    });
    assert.strictEqual(self.status, 400);
    assert.strictEqual(self.body.code, 'SELF_MESSAGE');

    const stranger = await api('POST', '/api/messages', {
      token: carolSession.accessToken,
      body: { toUserId: alice.user.id, content: 'x' },
    });
    assert.strictEqual(stranger.status, 403);
    assert.strictEqual(stranger.body.code, 'NOT_FRIENDS');

    const badHistory = await api('GET', '/api/messages/history?friendId=999999999', { token: carolSession.accessToken });
    assert.strictEqual(badHistory.status, 404);

    const emptyRead = await api('POST', '/api/messages/read', { token: carolSession.accessToken, body: { ids: [] } });
    assert.strictEqual(emptyRead.status, 200);
    assert.strictEqual(emptyRead.data.updated, 0);
  });

  // -------------------------------------------------------------------------
  // Profile editing + one-way friend removal
  // -------------------------------------------------------------------------
  console.log('\nProfile editing & one-way friend removal');

  const profA = { username: `prof_a_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'ProfA' };
  const profB = { username: `prof_b_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: 'ProfB' };
  let pa;
  let pb;

  await check('registers two users and connects both over WebSocket', async () => {
    pa = (await api('POST', '/api/auth/register', { body: profA })).data;
    pb = (await api('POST', '/api/auth/register', { body: profB })).data;
    assert.ok(pa && pb, 'registration failed');
    pa.ws = openSocket(pa.accessToken);
    pb.ws = openSocket(pb.accessToken);
    await waitForOpen(pa.ws, 6000);
    await waitForOpen(pb.ws, 6000);
  });

  await check('befriends them', async () => {
    const request = await api('POST', '/api/friends/requests', {
      token: pa.accessToken,
      body: { toUserId: pb.user.id },
    });
    assert.strictEqual(request.status, 201, JSON.stringify(request.body));
    const accepted = await api('POST', `/api/friends/requests/${request.data.request.id}/accept`, {
      token: pb.accessToken,
    });
    assert.strictEqual(accepted.status, 200);
  });

  await check('PATCH /api/auth/me updates and trims the nickname', async () => {
    const r = await api('PATCH', '/api/auth/me', { token: pa.accessToken, body: { nickname: '  改名后的  ' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.user.nickname, '改名后的');
    assert.strictEqual(r.data.user.avatar, null);
  });

  await check('nickname validation rejects blank and over-long values', async () => {
    const blank = await api('PATCH', '/api/auth/me', { token: pa.accessToken, body: { nickname: '   ' } });
    assert.strictEqual(blank.status, 400);
    assert.strictEqual(blank.body.code, 'INVALID_NICKNAME');

    const tooLong = await api('PATCH', '/api/auth/me', {
      token: pa.accessToken,
      body: { nickname: 'x'.repeat(65) },
    });
    assert.strictEqual(tooLong.status, 400);
    assert.strictEqual(tooLong.body.code, 'INVALID_NICKNAME');
  });

  await check('avatar must be a preset id (arbitrary / URL values are refused)', async () => {
    const injection = await api('PATCH', '/api/auth/me', {
      token: pa.accessToken,
      body: { avatar: 'https://evil.example/x.svg' },
    });
    assert.strictEqual(injection.status, 400);
    assert.strictEqual(injection.body.code, 'INVALID_AVATAR');

    const ok = await api('PATCH', '/api/auth/me', { token: pa.accessToken, body: { avatar: 'p05' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.user.avatar, 'p05');
  });

  await check('avatar can be cleared with null', async () => {
    const r = await api('PATCH', '/api/auth/me', { token: pa.accessToken, body: { avatar: null } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.user.avatar, null);
  });

  await check('a patch with no recognised field is rejected', async () => {
    const r = await api('PATCH', '/api/auth/me', { token: pa.accessToken, body: {} });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'NOTHING_TO_UPDATE');
  });

  await check('profile:updated reaches my own tabs AND all my friends', async () => {
    pa.ws.frames.length = 0;
    pb.ws.frames.length = 0;

    const r = await api('PATCH', '/api/auth/me', {
      token: pa.accessToken,
      body: { nickname: 'ProfA-2', avatar: 'p07' },
    });
    assert.strictEqual(r.status, 200);

    const mine = await waitForFrame(pa.ws, (f) => f.type === 'profile:updated' && f.user.nickname === 'ProfA-2');
    assert.strictEqual(mine.user.avatar, 'p07');

    const theirs = await waitForFrame(pb.ws, (f) => f.type === 'profile:updated' && f.user.id === pa.user.id);
    assert.strictEqual(theirs.user.nickname, 'ProfA-2');
    assert.strictEqual(theirs.user.avatar, 'p07');
  });

  await check('DELETE /api/friends/:id removes ONLY my side', async () => {
    const before = await api('GET', '/api/friends', { token: pb.accessToken });
    assert.ok(before.data.friends.some((f) => f.id === pa.user.id), 'precondition: B should have A');

    const removed = await api('DELETE', `/api/friends/${pb.user.id}`, { token: pa.accessToken });
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
    assert.deepStrictEqual(removed.data, { friendId: pb.user.id, removed: true });

    const mine = await api('GET', '/api/friends', { token: pa.accessToken });
    assert.ok(!mine.data.friends.some((f) => f.id === pb.user.id), 'peer still in my list');

    const theirs = await api('GET', '/api/friends', { token: pb.accessToken });
    assert.ok(theirs.data.friends.some((f) => f.id === pa.user.id), 'peer lost me — removal was not one-way');
  });

  await check('friend:removed reaches my tabs but NOT the peer', async () => {
    await waitForFrame(pa.ws, (f) => f.type === 'friend:removed' && f.friendId === pb.user.id);
    await sleep(400);
    assert.ok(
      !pb.ws.frames.some((f) => f.type === 'friend:removed'),
      'the peer was notified of a one-way removal'
    );
  });

  await check('both sides can STILL chat after a one-way removal (deadlock guard)', async () => {
    const mineToThem = await api('POST', '/api/messages', {
      token: pa.accessToken,
      body: { toUserId: pb.user.id, content: 'after removal', clientMsgId: `ow1-${uniq()}` },
    });
    assert.strictEqual(mineToThem.status, 201, `remover could not send: ${JSON.stringify(mineToThem.body)}`);

    const theirsToMine = await api('POST', '/api/messages', {
      token: pb.accessToken,
      body: { toUserId: pa.user.id, content: 'after removal reply', clientMsgId: `ow2-${uniq()}` },
    });
    assert.strictEqual(theirsToMine.status, 201, `peer could not reply: ${JSON.stringify(theirsToMine.body)}`);
  });

  await check('removing a non-friend is idempotent; removing yourself is rejected', async () => {
    const again = await api('DELETE', `/api/friends/${pb.user.id}`, { token: pa.accessToken });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.removed, false);

    const self = await api('DELETE', `/api/friends/${pa.user.id}`, { token: pa.accessToken });
    assert.strictEqual(self.status, 400);
  });

  await check('a removed peer can be re-added (no ghost-friend deadlock)', async () => {
    const search = await api('GET', `/api/friends/search?q=${encodeURIComponent(pb.user.username)}`, {
      token: pa.accessToken,
    });
    assert.ok(
      search.data.users.some((u) => u.id === pb.user.id && u.isFriend === false),
      'peer is not searchable after removal'
    );

    const reRequest = await api('POST', '/api/friends/requests', {
      token: pa.accessToken,
      body: { toUserId: pb.user.id },
    });
    assert.strictEqual(reRequest.status, 201, `re-request was blocked: ${JSON.stringify(reRequest.body)}`);
    assert.strictEqual(reRequest.data.outcome, 'requested');

    const accepted = await api('POST', `/api/friends/requests/${reRequest.data.request.id}/accept`, {
      token: pb.accessToken,
    });
    assert.strictEqual(accepted.status, 200);

    const mine = await api('GET', '/api/friends', { token: pa.accessToken });
    assert.ok(mine.data.friends.some((f) => f.id === pb.user.id), 'friendship was not restored');
  });

  await check('once BOTH sides remove each other, messaging is refused again', async () => {
    await api('DELETE', `/api/friends/${pb.user.id}`, { token: pa.accessToken });
    await api('DELETE', `/api/friends/${pa.user.id}`, { token: pb.accessToken });

    const r = await api('POST', '/api/messages', {
      token: pa.accessToken,
      body: { toUserId: pb.user.id, content: 'x', clientMsgId: `ow3-${uniq()}` },
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'NOT_FRIENDS');
  });

  await check('profile endpoints require authentication', async () => {
    const patch = await api('PATCH', '/api/auth/me', { body: { nickname: 'nope' } });
    assert.strictEqual(patch.status, 401);
    const del = await api('DELETE', `/api/friends/${pb.user.id}`);
    assert.strictEqual(del.status, 401);
  });

  // -------------------------------------------------------------------------
  // Group chat — WeChat-style direct add, unified messages table
  // -------------------------------------------------------------------------
  console.log('\nGroup chat');

  const mkUser = async (prefix) => {
    const account = { username: `${prefix}_${uniq()}`.slice(0, 32), password: 'passw0rd', nickname: prefix };
    const reg = await api('POST', '/api/auth/register', { body: account });
    assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
    return reg.data;
  };
  const befriend = async (a, b) => {
    const req = await api('POST', '/api/friends/requests', {
      token: a.accessToken,
      body: { toUserId: b.user.id },
    });
    assert.strictEqual(req.status, 201, JSON.stringify(req.body));
    const acc = await api('POST', `/api/friends/requests/${req.data.request.id}/accept`, {
      token: b.accessToken,
    });
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
  };

  const g1 = await mkUser('grp_a');
  const g2 = await mkUser('grp_b');
  const g3 = await mkUser('grp_c');
  const outsider = await mkUser('grp_x');

  await check('registers group users, befriends them and connects sockets', async () => {
    await befriend(g1, g2);
    await befriend(g1, g3);
    g1.ws = openSocket(g1.accessToken);
    g2.ws = openSocket(g2.accessToken);
    g3.ws = openSocket(g3.accessToken);
    await waitForOpen(g1.ws, 6000);
    await waitForOpen(g2.ws, 6000);
    await waitForOpen(g3.ws, 6000);
  });

  let groupId;
  await check('creates a group and pushes group:created to every member', async () => {
    const r = await api('POST', '/api/groups', {
      token: g1.accessToken,
      body: { name: 'E2E Group', memberIds: [g2.user.id] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.data.group.name, 'E2E Group');
    assert.strictEqual(r.data.group.ownerId, g1.user.id);
    assert.strictEqual(r.data.group.memberCount, 2);
    groupId = r.data.group.id;

    const frame = await waitForFrame(g2.ws, (f) => f.type === 'group:created' && f.group.id === groupId);
    assert.strictEqual(frame.group.ownerId, g1.user.id);
  });

  await check('WS group message fans out with author info and mention ids', async () => {
    const clientMsgId = `grp-${uniq()}`;
    g1.ws.send(
      JSON.stringify({
        type: 'chat:send',
        clientMsgId,
        groupId,
        content: 'hello group',
        mentions: [g2.user.id],
      })
    );
    const inbound = await waitForFrame(
      g2.ws,
      (f) => f.type === 'chat:message' && f.message.clientMsgId === clientMsgId
    );
    assert.strictEqual(inbound.message.groupId, groupId);
    assert.strictEqual(inbound.message.fromUserId, g1.user.id);
    assert.strictEqual(inbound.message.fromUser.id, g1.user.id);
    assert.deepStrictEqual(inbound.message.mentions, [g2.user.id]);

    const echo = await waitForFrame(
      g1.ws,
      (f) => f.type === 'chat:message' && f.message.clientMsgId === clientMsgId
    );
    assert.ok(echo.message.id > 0, 'group echo has no id');
    g2.lastGroupMessageId = echo.message.id;
  });

  await check('HTTP group send reaches the other members', async () => {
    const r = await api('POST', '/api/messages', {
      token: g2.accessToken,
      body: { groupId, content: 'reply in group', clientMsgId: `grp-${uniq()}` },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const frame = await waitForFrame(
      g1.ws,
      (f) => f.type === 'chat:message' && f.message.content === 'reply in group'
    );
    assert.strictEqual(frame.message.groupId, groupId);
  });

  await check('group history is chronological and includes the system notice', async () => {
    const r = await api('GET', `/api/groups/${groupId}/messages?limit=50`, { token: g1.accessToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.data.group.id, groupId);
    assert.ok(r.data.members.some((m) => m.id === g2.user.id), 'member roster missing');
    const contents = r.data.messages.map((m) => m.content);
    assert.ok(contents.includes('hello group'));
    assert.ok(contents.includes('reply in group'));
    assert.ok(r.data.messages.some((m) => m.type === 'system'), 'creation system notice missing');
    const ids = r.data.messages.map((m) => m.id);
    assert.deepStrictEqual(ids, [...ids].sort((x, y) => x - y), 'group history not ascending');
  });

  await check('incremental poll includes group messages past the cursor', async () => {
    const baseline = await api('GET', '/api/messages/poll?sinceId=0', { token: g3.accessToken });
    // g3 is not a member yet, so they should NOT see the group.
    assert.ok(
      !baseline.data.messages.some((m) => m.groupId === groupId),
      'non-member received group rows through polling'
    );

    const r = await api('GET', '/api/messages/poll?sinceId=0', { token: g2.accessToken });
    assert.ok(
      r.data.messages.some((m) => m.groupId === groupId),
      'member poll missed group messages'
    );
  });

  await check('unread + @mention flags surface, then clear after read', async () => {
    const before = await api('GET', '/api/groups', { token: g2.accessToken });
    const entry = before.data.groups.find((g) => g.id === groupId);
    assert.ok(entry, 'group missing from g2 list');
    assert.ok(entry.unread >= 1, `expected unread >= 1, got ${entry.unread}`);
    assert.strictEqual(entry.mentioned, true, 'mention flag not set');

    const read = await api('POST', `/api/groups/${groupId}/read`, {
      token: g2.accessToken,
      body: { lastMessageId: 999_999_999 },
    });
    assert.strictEqual(read.status, 200);

    const after = await api('GET', '/api/groups', { token: g2.accessToken });
    const entry2 = after.data.groups.find((g) => g.id === groupId);
    assert.strictEqual(entry2.unread, 0, 'unread did not clear after read');
    assert.strictEqual(entry2.mentioned, false, 'mention flag did not clear');
  });

  await check('only the owner may edit group profile; edits push group:updated', async () => {
    const denied = await api('PATCH', `/api/groups/${groupId}`, {
      token: g2.accessToken,
      body: { name: 'nope' },
    });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'NOT_GROUP_OWNER');

    const renamed = await api('PATCH', `/api/groups/${groupId}`, {
      token: g1.accessToken,
      body: { name: 'E2E Renamed', announcement: 'welcome' },
    });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual(renamed.data.group.name, 'E2E Renamed');

    const frame = await waitForFrame(
      g2.ws,
      (f) => f.type === 'group:updated' && f.group.id === groupId && f.group.name === 'E2E Renamed'
    );
    assert.strictEqual(frame.group.announcement, 'welcome');
  });

  await check('owner adds a friend to the group', async () => {
    // A non-friend cannot be pulled in.
    const rejected = await api('POST', `/api/groups/${groupId}/members`, {
      token: g1.accessToken,
      body: { userIds: [outsider.user.id] },
    });
    assert.strictEqual(rejected.status, 200);
    assert.deepStrictEqual(rejected.data.added, [], 'non-friend was added');

    const added = await api('POST', `/api/groups/${groupId}/members`, {
      token: g1.accessToken,
      body: { userIds: [g3.user.id] },
    });
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    assert.deepStrictEqual(added.data.added, [g3.user.id]);

    const frame = await waitForFrame(g3.ws, (f) => f.type === 'group:member_added' && Number(f.groupId) === groupId);
    assert.ok(frame.members.some((m) => m.id === g3.user.id));
  });

  await check('a newly added member can send; a removed member cannot', async () => {
    const ok = await api('POST', '/api/messages', {
      token: g3.accessToken,
      body: { groupId, content: 'hi from g3', clientMsgId: `grp-${uniq()}` },
    });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));

    const removed = await api('DELETE', `/api/groups/${groupId}/members/${g3.user.id}`, {
      token: g1.accessToken,
    });
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));

    const removedFrame = await waitForFrame(
      g3.ws,
      (f) => f.type === 'group:member_removed' && f.removedUserId === g3.user.id
    );
    assert.ok(removedFrame, 'removed member was not notified');

    const denied = await api('POST', '/api/messages', {
      token: g3.accessToken,
      body: { groupId, content: 'should fail', clientMsgId: `grp-${uniq()}` },
    });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'NOT_GROUP_MEMBER');

    const historyDenied = await api('GET', `/api/groups/${groupId}/messages`, { token: g3.accessToken });
    assert.strictEqual(historyDenied.status, 403);
  });

  await check('mentions of non-members are dropped by the server', async () => {
    const r = await api('POST', '/api/messages', {
      token: g1.accessToken,
      body: { groupId, content: 'mention ghost', clientMsgId: `grp-${uniq()}`, mentions: [g3.user.id] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.data.message.mentions, [], 'non-member mention was persisted');
  });

  await check('a member can leave; afterwards they lose access', async () => {
    const left = await api('POST', `/api/groups/${groupId}/leave`, { token: g2.accessToken });
    assert.strictEqual(left.status, 200, JSON.stringify(left.body));
    assert.strictEqual(left.data.left, true);

    const denied = await api('POST', '/api/messages', {
      token: g2.accessToken,
      body: { groupId, content: 'still here?', clientMsgId: `grp-${uniq()}` },
    });
    assert.strictEqual(denied.status, 403);
  });

  await check('only the owner may dissolve; after dissolve it is gone', async () => {
    const denied = await api('DELETE', `/api/groups/${groupId}`, { token: g2.accessToken });
    assert.strictEqual(denied.status, 403);

    const dissolved = await api('DELETE', `/api/groups/${groupId}`, { token: g1.accessToken });
    assert.strictEqual(dissolved.status, 200, JSON.stringify(dissolved.body));
    assert.strictEqual(dissolved.data.dissolved, true);

    const gone = await api('GET', `/api/groups/${groupId}/messages`, { token: g1.accessToken });
    assert.strictEqual(gone.status, 404);
  });

  await check('group endpoints require authentication', async () => {
    const list = await api('GET', '/api/groups');
    assert.strictEqual(list.status, 401);
    const create = await api('POST', '/api/groups', { body: { name: 'x', memberIds: [] } });
    assert.strictEqual(create.status, 401);
  });

  console.log('\nGroup discovery & join requests');

  let joinGroupId;
  let joinGroupNo;
  await check('a new group carries a searchable 群号', async () => {
    const r = await api('POST', '/api/groups', {
      token: g1.accessToken,
      body: { name: 'Joinable', memberIds: [g2.user.id] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    joinGroupId = r.data.group.id;
    joinGroupNo = r.data.group.groupNo;
    assert.ok(Number.isInteger(joinGroupNo) && joinGroupNo > 0, `groupNo missing: ${joinGroupNo}`);

    outsider.ws = openSocket(outsider.accessToken);
    await waitForOpen(outsider.ws, 6000);
  });

  await check('groups are searchable by 群号 and by name', async () => {
    const byNo = await api('GET', `/api/groups/search?q=${joinGroupNo}`, { token: outsider.accessToken });
    assert.strictEqual(byNo.status, 200);
    assert.ok(byNo.data.groups.some((g) => g.id === joinGroupId), 'search by 群号 missed the group');

    const byName = await api('GET', '/api/groups/search?q=Joinable', { token: outsider.accessToken });
    assert.ok(byName.data.groups.some((g) => g.id === joinGroupId), 'search by name missed the group');
  });

  await check('applying to join notifies the owner and is idempotent', async () => {
    const first = await api('POST', `/api/groups/${joinGroupId}/join-requests`, {
      token: outsider.accessToken,
      body: { message: 'let me in' },
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(first.data.status, 'pending');

    const frame = await waitForFrame(
      g1.ws,
      (f) => f.type === 'group:join_requested' && Number(f.groupId) === joinGroupId
    );
    assert.strictEqual(frame.request.applicant.id, outsider.user.id);
    assert.strictEqual(frame.request.message, 'let me in');
    const requestId = frame.request.id;

    const again = await api('POST', `/api/groups/${joinGroupId}/join-requests`, {
      token: outsider.accessToken,
      body: { message: 'let me in' },
    });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(again.data.id, requestId, 'a second row was created instead of upserting');

    outsider.joinRequestId = requestId;
  });

  await check('a member who is not the owner cannot list or decide requests', async () => {
    const list = await api('GET', `/api/groups/${joinGroupId}/join-requests`, { token: g2.accessToken });
    assert.strictEqual(list.status, 403);
    assert.strictEqual(list.body.code, 'NOT_GROUP_OWNER');

    const decide = await api('POST', `/api/groups/${joinGroupId}/join-requests/${outsider.joinRequestId}/reject`, {
      token: g2.accessToken,
    });
    assert.strictEqual(decide.status, 403);
  });

  await check('owner sees the pending application and approves it', async () => {
    const list = await api('GET', `/api/groups/${joinGroupId}/join-requests`, { token: g1.accessToken });
    assert.strictEqual(list.status, 200);
    assert.ok(
      list.data.requests.some((r) => r.id === outsider.joinRequestId && r.applicant.id === outsider.user.id),
      'pending request not listed for the owner'
    );

    const approved = await api(
      'POST',
      `/api/groups/${joinGroupId}/join-requests/${outsider.joinRequestId}/approve`,
      { token: g1.accessToken }
    );
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    assert.strictEqual(approved.data.status, 'approved');

    const frame = await waitForFrame(
      outsider.ws,
      (f) => f.type === 'group:join_result' && f.status === 'approved'
    );
    assert.ok(frame, 'applicant was not told the application was approved');
  });

  await check('an approved applicant becomes a member and can send', async () => {
    const send = await api('POST', '/api/messages', {
      token: outsider.accessToken,
      body: { groupId: joinGroupId, content: 'thanks for the add', clientMsgId: `grp-${uniq()}` },
    });
    assert.strictEqual(send.status, 201, JSON.stringify(send.body));

    // They now belong, so the group is no longer a search hit for them.
    const search = await api('GET', `/api/groups/search?q=${joinGroupNo}`, { token: outsider.accessToken });
    assert.ok(!search.data.groups.some((g) => g.id === joinGroupId), 'member still sees the group in search');
  });

  await check('a rejected applicant is told, and can apply again', async () => {
    const applied = await api('POST', `/api/groups/${joinGroupId}/join-requests`, {
      token: g3.accessToken,
      body: { message: 'me too' },
    });
    assert.strictEqual(applied.status, 201, JSON.stringify(applied.body));

    const rejected = await api(
      'POST',
      `/api/groups/${joinGroupId}/join-requests/${applied.data.id}/reject`,
      { token: g1.accessToken }
    );
    assert.strictEqual(rejected.status, 200);
    assert.strictEqual(rejected.data.status, 'rejected');

    const frame = await waitForFrame(g3.ws, (f) => f.type === 'group:join_result' && f.status === 'rejected');
    assert.ok(frame, 'applicant was not told the application was rejected');

    const reapplied = await api('POST', `/api/groups/${joinGroupId}/join-requests`, {
      token: g3.accessToken,
      body: { message: 'please' },
    });
    assert.strictEqual(reapplied.status, 201);
    assert.strictEqual(reapplied.data.status, 'pending', 'a rejected application could not be revived');
  });

  await check('group join endpoints require authentication', async () => {
    const search = await api('GET', '/api/groups/search?q=Joinable');
    assert.strictEqual(search.status, 401);
  });

  await api('DELETE', `/api/groups/${joinGroupId}`, { token: g1.accessToken });

  console.log('\nAttachments (image / file)');

  const upload = async (token, filename, mime, bytes) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), filename);
    const res = await fetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = await res.json().catch(() => null);
    return { status: res.status, body: payload, data: payload && payload.data };
  };

  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  let imageAttachmentId;
  let imageSize;

  await check('uploads an image, reported as an image attachment', async () => {
    const r = await upload(g1.accessToken, 'photo.png', 'image/png', PNG_BYTES);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.data.attachment.kind, 'image');
    assert.strictEqual(r.data.attachment.name, 'photo.png');
    assert.strictEqual(r.data.attachment.size, PNG_BYTES.length);
    imageAttachmentId = r.data.attachment.id;
    imageSize = r.data.attachment.size;
  });

  await check('a non-whitelisted image mime is stored as a generic file', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    const r = await upload(g1.accessToken, 'evil.svg', 'image/svg+xml', svg);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.data.attachment.kind, 'file', 'SVG must not be served as an inline image');
  });

  await check('an image over the size cap is rejected', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1); // > 10MB
    const r = await upload(g1.accessToken, 'big.png', 'image/png', big);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'IMAGE_TOO_LARGE');
  });

  await check('sending an image message persists type + attachment and fans out', async () => {
    const clientMsgId = `img-${uniq()}`;
    const r = await api('POST', '/api/messages', {
      token: g1.accessToken,
      body: { toUserId: g2.user.id, clientMsgId, attachmentId: imageAttachmentId },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.data.message.type, 'image');
    assert.strictEqual(r.data.message.content, '[图片]');
    assert.strictEqual(r.data.message.attachment.id, imageAttachmentId);

    const frame = await waitForFrame(
      g2.ws,
      (f) => f.type === 'chat:message' && f.message.clientMsgId === clientMsgId
    );
    assert.strictEqual(frame.message.type, 'image');
    assert.strictEqual(frame.message.attachment.name, 'photo.png');
  });

  await check('someone else cannot send my attachment', async () => {
    const r = await api('POST', '/api/messages', {
      token: g2.accessToken,
      body: { toUserId: g1.user.id, attachmentId: imageAttachmentId, clientMsgId: `x-${uniq()}` },
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'ATTACHMENT_FORBIDDEN');
  });

  await check('raw bytes require a token and match the upload', async () => {
    const noAuth = await fetch(`${BASE}/api/attachments/${imageAttachmentId}/raw`);
    assert.strictEqual(noAuth.status, 401);

    const withAuth = await fetch(
      `${BASE}/api/attachments/${imageAttachmentId}/raw?token=${encodeURIComponent(g1.accessToken)}`
    );
    assert.strictEqual(withAuth.status, 200);
    assert.strictEqual(withAuth.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await withAuth.arrayBuffer());
    assert.strictEqual(bytes.length, imageSize);
    assert.ok(bytes.equals(PNG_BYTES), 'served bytes differ from the uploaded ones');
  });

  await check('a group file message reaches history with its attachment', async () => {
    const created = await api('POST', '/api/groups', {
      token: g1.accessToken,
      body: { name: 'Media', memberIds: [g2.user.id] },
    });
    const gid = created.data.group.id;
    const up = await upload(g1.accessToken, 'notes.txt', 'text/plain', Buffer.from('hello attachment', 'utf8'));
    assert.strictEqual(up.data.attachment.kind, 'file');

    const sent = await api('POST', '/api/messages', {
      token: g1.accessToken,
      body: { groupId: gid, attachmentId: up.data.attachment.id, clientMsgId: `gfile-${uniq()}` },
    });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    assert.strictEqual(sent.data.message.type, 'file');
    assert.ok(sent.data.message.content.startsWith('[文件]'), sent.data.message.content);

    const history = await api('GET', `/api/groups/${gid}/messages`, { token: g2.accessToken });
    const media = history.data.messages.find((m) => m.attachment && m.attachment.name === 'notes.txt');
    assert.ok(media, 'group history lost the attachment');
    assert.strictEqual(media.type, 'file');

    await api('DELETE', `/api/groups/${gid}`, { token: g1.accessToken });
  });

  await check('attachment endpoints require authentication', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${BASE}/api/attachments`, { method: 'POST', body: form });
    assert.strictEqual(res.status, 401);
  });

  g1.ws.close();
  g2.ws.close();
  g3.ws.close();
  outsider.ws.close();

  pa.ws.close();
  pb.ws.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(` - ${f.name}: ${f.err.message}`);
  }
  return failed === 0;
}

(async () => {
  let server;
  try {
    server = await startServer();
    const ok = await run();
    server.kill();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('fatal:', err);
    if (server) server.kill();
    process.exit(1);
  }
})();
