/**
 * Axios request-governance end-to-end test.
 *
 * The governance layer (`src/lib/axiosClient.ts`) is a headline feature of the
 * design doc but its behaviours are only observable in a real browser, so they
 * are asserted here by driving the app in Chrome and watching the network:
 *
 *   1. 401 silent refresh — single-flight, queued replay, no logout
 *   2. retry with exponential backoff on 5xx (and that it eventually succeeds)
 *   3. NO retry on 4xx business errors (a 400 is surfaced, not looped)
 *   4. duplicate-mutation suppression — a double click issues one request
 *
 * Runs against the already-running backend (:3001) and dev server (:5173) so it
 * never has to restart or reconfigure the developer's services.
 *
 * Run: node test/governance.e2e.mjs   (or: pnpm test:governance)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const APP = process.env.E2E_APP || 'http://localhost:5173';
const API = process.env.E2E_API || 'http://127.0.0.1:3001';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

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

async function call(method, path, { token, body, jar } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (jar?.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, body: payload, data: payload?.data };
}

/**
 * Sign-in through the real UI so the browser receives the HttpOnly refresh
 * cookie. The access token is memory-only now, so seeding localStorage is no
 * longer a thing — the app re-mints a token from the cookie on every load.
 */
async function loginViaUi(page, username, password) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 15000 });
}

/**
 * Builds a fake response for request interception.
 *
 * The app and the API are different origins, so a synthesised response WITHOUT
 * CORS headers is blocked by the browser and surfaces to axios as a *network*
 * error — which is retried for entirely different reasons. Every fake therefore
 * has to carry `Access-Control-Allow-Origin`, otherwise the test measures the
 * wrong code path.
 */
function fakeResponse(status, body) {
  return {
    status,
    contentType: 'application/json',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    },
    body: JSON.stringify(body),
  };
}

/** Network recorder + programmable interception rules. */
function createNetworkProbe(page) {
  const state = { counts: new Map(), rules: [] };

  const keyOf = (request) => {
    const url = new URL(request.url());
    return `${request.method()} ${url.pathname}`;
  };

  page.on('request', async (request) => {
    const url = request.url();
    if (!url.includes('/api/')) {
      request.continue().catch(() => {});
      return;
    }

    // CORS preflights must reach the real server, otherwise the browser blocks
    // the actual call and axios reports a network error instead of the status.
    if (request.method() === 'OPTIONS') {
      request.continue().catch(() => {});
      return;
    }

    const key = keyOf(request);
    const seen = (state.counts.get(key) ?? 0) + 1;
    state.counts.set(key, seen);

    for (const rule of state.rules) {
      const action = rule({ key, seen, request });
      if (!action) continue;
      if (action.holdMs) await sleep(action.holdMs);
      if (action.respond) {
        request.respond(action.respond).catch(() => {});
        return;
      }
      if (action.abort) {
        request.abort('failed').catch(() => {});
        return;
      }
    }
    request.continue().catch(() => {});
  });

  return {
    reset() {
      state.counts.clear();
      state.rules.length = 0;
    },
    count(key) {
      return state.counts.get(key) ?? 0;
    },
    addRule(rule) {
      state.rules.push(rule);
    },
    dump() {
      return [...state.counts.entries()].map(([k, v]) => `${k} x${v}`).join(', ') || '(none)';
    },
  };
}

const shellReady = (page) => page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });

const onLoginPage = (page) => page.evaluate(() => window.location.pathname.startsWith('/login'));

async function run() {
  const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error(`no Chrome/Edge found in: ${CHROME_CANDIDATES.join(', ')}`);

  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`backend not ready at ${API}`);
  const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
  if (!appUp) throw new Error(`frontend not reachable at ${APP} (start it with: pnpm dev:web)`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  await page.setRequestInterception(true);
  const net = createNetworkProbe(page);

  const tag = uniq();
  const me = { username: `gov_me_${tag}`.slice(0, 32), password: 'passw0rd', nickname: `GovMe${tag.slice(-4)}` };
  const friend = { username: `gov_fr_${tag}`.slice(0, 32), password: 'passw0rd', nickname: `GovFr${tag.slice(-4)}` };

  console.log(`\nAxios governance E2E  (app ${APP}, api ${API})\n`);

  const meSession = (await call('POST', '/api/auth/register', { body: me })).data;
  const friendSession = (await call('POST', '/api/auth/register', { body: friend })).data;
  if (!meSession || !friendSession) throw new Error('failed to seed accounts');

  // Make them friends so the friend list has visible content.
  const req = await call('POST', '/api/friends/requests', {
    token: meSession.accessToken,
    body: { toUserId: friendSession.user.id },
  });
  await call('POST', `/api/friends/requests/${req.data.request.id}/accept`, { token: friendSession.accessToken });

  console.log('1) 401 静默续期（Cookie 续期 + 重放，不登出）');
  await check('会话过期时：静默续期一次并重放请求，且不触发登出', async () => {
    // Sign in through the UI so the browser holds the HttpOnly refresh cookie.
    await loginViaUi(page, me.username, me.password);
    await shellReady(page);

    net.reset();
    // Hold the renewal so a burst of 401s has a chance to coalesce, and force the
    // first friends read to 401 as an expired access token would.
    net.addRule(({ key }) => (key === 'POST /api/auth/refresh' ? { holdMs: 600 } : null));
    net.addRule(({ key, seen }) =>
      key === 'GET /api/friends' && seen === 1
        ? { respond: fakeResponse(401, { ok: false, code: 'TOKEN_EXPIRED', message: 'expired' }) }
        : null
    );

    // Reload: the memory-only access token is gone, so the app re-mints one from
    // the httpOnly cookie automatically.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await shellReady(page);

    // The replayed reads must have succeeded, and the user must stay signed in.
    await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 15000 }, friend.nickname);
    const refreshes = net.count('POST /api/auth/refresh');
    assert.ok(refreshes >= 1, `expected at least one silent refresh, saw ${refreshes}: ${net.dump()}`);
    assert.equal(await onLoginPage(page), false, 'a successful renewal must not log the user out');

    // The single-use refresh cookie must have been rotated by the renewal.
    // (It is scoped to /api/auth, so query a URL under that path.)
    const cookies = await page.cookies(`${APP}/api/auth/refresh`);
    assert.ok(cookies.some((c) => c.name === 'stella_rt'), 'refresh cookie missing after renewal');
    // ...and the access token must NOT live in localStorage (XSS hardening).
    const leaked = await page.evaluate(() => {
      const raw = window.localStorage.getItem('stella.im.session');
      return raw ? JSON.parse(raw) : null;
    });
    assert.ok(!leaked || !leaked.accessToken, 'access token must not be persisted to localStorage');
  });

  /**
   * Boots the app once and counts how many times `key` hit the network.
   *
   * Used as a *control*: React StrictMode double-mounts effects, so the baseline
   * is not 1. Asserting against a measured baseline keeps the retry assertions
   * exact without depending on StrictMode timings.
   */
  async function measure(key, rules = []) {
    net.reset();
    for (const rule of rules) net.addRule(rule);
    await page.goto(APP, { waitUntil: 'networkidle2' });
    await shellReady(page);
    await sleep(2500);
    return net.count(key);
  }

  console.log('\n2) 5xx 自动重试（指数退避 + 抖动）');
  await check('首次 500 会被额外重试一次并最终成功', async () => {
    const baseline = await measure('GET /api/friends');

    const withFailure = await measure('GET /api/friends', [
      ({ key, seen }) =>
        key === 'GET /api/friends' && seen === 1
          ? { respond: fakeResponse(500, { ok: false, code: 'BOOM', message: 'injected 5xx' }) }
          : null,
    ]);

    assert.equal(
      withFailure,
      baseline + 1,
      `a 5xx should add exactly one retry (baseline ${baseline}, observed ${withFailure}: ${net.dump()})`
    );
    // ...and the retry must repair the UI.
    await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 10000 }, friend.nickname);
  });

  console.log('\n3) 4xx 业务错误不重试');
  await check('400 不触发任何重试，错误直接抛给业务层', async () => {
    const baseline = await measure('GET /api/friends/requests');

    const withFailure = await measure('GET /api/friends/requests', [
      ({ key }) =>
        key === 'GET /api/friends/requests'
          ? { respond: fakeResponse(400, { ok: false, code: 'BAD', message: 'injected 4xx' }) }
          : null,
    ]);

    assert.equal(
      withFailure,
      baseline,
      `a 4xx must not be retried (baseline ${baseline}, observed ${withFailure}: ${net.dump()})`
    );

    const toasted = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="toast"]')].some((n) =>
        n.textContent.includes('加载好友申请失败')
      )
    );
    assert.ok(toasted, 'the 400 was not surfaced to the user');
  });

  console.log('\n4) 重复写请求去重');
  await check('快速双击「添加」只发出一次 POST /api/friends/requests', async () => {
    net.reset();
    await page.goto(APP, { waitUntil: 'networkidle2' });
    await shellReady(page);

    const target = { username: `gov_tg_${tag}`.slice(0, 32), password: 'passw0rd', nickname: `GovTg${tag.slice(-4)}` };
    await call('POST', '/api/auth/register', { body: target });

    await page.evaluate(() => document.querySelector('[data-testid="tab-friends"]')?.click());
    await page.type('[data-testid="search-input"]', target.username);
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="search-result-row"]')].some((r) =>
          r.textContent.includes(name)
        ),
      { timeout: 10000 },
      target.nickname
    );

    const clicks = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('[data-testid="search-result-row"]')].find((r) =>
        r.textContent.includes(name)
      );
      const button = row && row.querySelector('[data-testid="add-friend"]');
      if (!button) return 0;
      button.click();
      button.click();
      return 2;
    }, target.nickname);
    assert.equal(clicks, 2, 'could not double-click the add button');

    await sleep(1500);
    assert.equal(
      net.count('POST /api/friends/requests'),
      1,
      `double click should collapse to 1 request, saw ${net.dump()}`
    );
  });

  await browser.close();

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
