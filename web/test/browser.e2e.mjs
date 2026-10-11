/**
 * Browser end-to-end test (real Chrome/Edge via puppeteer-core).
 *
 * Verifies the behaviours that only exist in a browser:
 *
 *   1. an unauthenticated visitor opens NO WebSocket connection at all
 *   2. after login exactly ONE connection exists for the whole browser
 *   3. opening a second tab does NOT open a second connection (SharedWorker)
 *   4. preemptive single-active-tab: exactly one tab is interactive, the other
 *      is frozen, and leadership can be taken over explicitly
 *   5. a message sent by one user surfaces as a toast (and unread badge) in the
 *      recipient's window when that conversation is not open
 *   6. logging out in one tab logs every tab out and closes the connection
 *
 * Run: node test/browser.e2e.mjs   (or: pnpm test:browser)
 * Requires: backend on :3001 and the built frontend served on :4173
 *           (pnpm build:web && pnpm preview:web)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

// `localhost` (not 127.0.0.1): Vite binds the loopback name, which resolves to
// ::1 on this platform, so the IPv4 literal would be refused.
const APP = process.env.E2E_APP || 'http://localhost:4173';
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

async function health() {
  const res = await fetch(`${API}/api/health`);
  return (await res.json()).data;
}

async function waitForConnections(expected, timeoutMs = 10000, label = '') {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const data = await health();
    last = data.connections;
    if (last === expected) return data;
    await sleep(150);
  }
  throw new Error(`expected ${expected} connection(s) ${label} but saw ${last}`);
}

async function clickByText(page, selector, text) {
  const clicked = await page.evaluate(
    (sel, needle) => {
      const element = [...document.querySelectorAll(sel)].find((node) =>
        (node.textContent || '').includes(needle)
      );
      if (!element) return false;
      element.click();
      return true;
    },
    selector,
    text
  );
  assert.ok(clicked, `could not find ${selector} containing "${text}"`);
}

/** Clicks a `data-testid` element. Text-independent, so copy edits can't break it. */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return false;
    element.click();
    return true;
  }, testId);
  assert.ok(clicked, `could not click [data-testid="${testId}"]`);
}

/** Reads a `data-*` attribute off a `data-testid` element (null when absent). */
const testIdAttr = (page, testId, attribute) =>
  page.evaluate(
    (id, attr) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute(attr) ?? null,
    testId,
    attribute
  );

const shellReady = (page) => page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });

async function registerThroughUi(page, username, nickname) {
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await clickByText(page, '.login-tabs button', '注册');
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[type="password"]', 'passw0rd');
  const nicknameInput = await page.$('[data-testid="nickname-input"]');
  if (nicknameInput) await nicknameInput.type(nickname);
  await clickByText(page, 'button[type="submit"]', '注册');
  await shellReady(page);
}

/** Presence of the freeze dialog, independent of its copy. */
const hasFrozenOverlay = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="frozen-overlay"]') !== null);

/** Reads the session the app persisted (now a user HINT only — no tokens). */
const readSession = (page) =>
  page.evaluate(() => {
    const raw = window.localStorage.getItem('stella.im.session');
    return raw ? JSON.parse(raw) : null;
  });

/**
 * Mints a fresh access token for a user by logging in directly against the API.
 * The browser only keeps the access token in memory (`readSession().user` is a
 * non-sensitive hint), so tests that need to call the raw API authenticate here.
 */
async function loginToken(username, password = 'passw0rd') {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await res.json();
  assert.ok(payload?.data?.accessToken, `login failed for ${username}: ${JSON.stringify(payload)}`);
  return { accessToken: payload.data.accessToken, user: payload.data.user };
}

// ---------------------------------------------------------------------------
async function run() {
  const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  assert.ok(executablePath, `no Chrome/Edge found in: ${CHROME_CANDIDATES.join(', ')}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    // Desktop viewport: the app is a two-pane layout and the tests assert on the
    // chat pane, which the phone breakpoint stacks differently.
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const tag = uniq();
  const userA = { username: `ui_a_${tag}`.slice(0, 32), nickname: `UIAlice${tag.slice(-4)}` };
  const userB = { username: `ui_b_${tag}`.slice(0, 32), nickname: `UIBob${tag.slice(-4)}` };
  const messageText = `hello-from-a-${tag}`;

  /**
   * `/api/health` reports a GLOBAL socket total, so any other client (for
   * example the developer's own open tab) is included. Every assertion therefore
   * samples the counter immediately BEFORE the action it is measuring and
   * compares against that, instead of against a fixed baseline captured at
   * startup — a baseline drifts as soon as somebody else connects.
   */
  const connectionCount = async () => (await health()).connections;

  const contextA = await browser.createBrowserContext();
  const page1 = await contextA.newPage();
  page1.on('pageerror', (error) => console.error('[page1 error]', error.message));

  console.log(`\nStella browser end-to-end test  (${APP})\n`);
  console.log('Unauthenticated visitor');

  await check('未登录访问被导向登录页，且不建立任何长连接', async () => {
    const before = await connectionCount();
    await page1.goto(APP, { waitUntil: 'networkidle2' });
    await page1.waitForSelector('.login-card', { timeout: 15000 });
    assert.ok(page1.url().includes('/login'), `expected /login, got ${page1.url()}`);
    await sleep(700);
    assert.equal(await connectionCount(), before, 'unauthenticated client opened a connection');
  });

  console.log('\nLogin + single connection');
  await check('登录后全局仅建立一条长连接（connections === 1）', async () => {
    const before = await connectionCount();
    await clickByText(page1, '.login-tabs button', '注册');
    await page1.type('input[autocomplete="username"]', userA.username);
    await page1.type('input[type="password"]', 'passw0rd');
    const nicknameInput = await page1.$('[data-testid="nickname-input"]');
    if (nicknameInput) await nicknameInput.type(userA.nickname);
    await clickByText(page1, 'button[type="submit"]', '注册');
    await shellReady(page1);
    await waitForConnections(before + 1, 10000, 'after login');
  });

  await check('会话仅持久化用户提示，令牌不落 localStorage；侧边栏显示传输信息', async () => {
    const stored = await readSession(page1);
    assert.ok(stored?.user, 'user hint not persisted in localStorage');
    assert.equal(stored.user.username, userA.username, 'unexpected persisted user');
    // XSS hardening: the access token must be memory-only, the refresh token
    // must live in an HttpOnly cookie.
    assert.equal(stored.accessToken, undefined, 'access token must not be persisted');
    assert.equal(stored.refreshToken, undefined, 'refresh token must not be persisted');

    assert.equal(
      await testIdAttr(page1, 'status-pill', 'data-transport'),
      'shared-worker',
      'transport is not reported as shared-worker'
    );
    assert.equal(await testIdAttr(page1, 'status-role', 'data-role'), 'leader', 'this tab should be the active window');

    // Real-time network status (bottom-left): online + connected while linked.
    assert.equal(await testIdAttr(page1, 'status-pill', 'data-network'), 'online', 'network should read online');
    const statusText = await page1.$eval('[data-testid="status-text"]', (el) => el.textContent || '');
    assert.ok(statusText.includes('已连接'), `status text should read 已连接, got "${statusText}"`);
  });

  await check('页面重复加载不会泄漏额外连接（StrictMode 双挂载 + 快速重载）', async () => {
    // Reproduces the race where a still-CONNECTING link gets superseded by a
    // second one, which would leave an orphaned socket per reload.
    const before = await connectionCount();
    for (let round = 1; round <= 3; round += 1) {
      await page1.goto(APP, { waitUntil: 'networkidle2' });
      await page1.waitForSelector('[data-testid="status-dot"][data-state="open"]', { timeout: 15000 });
      await sleep(1200);
      assert.equal(
        await connectionCount(),
        before,
        `第 ${round} 次重载后连接数发生了变化（重载泄漏了一条连接）`
      );
    }
  });

  console.log('\nMulti-tab singleton');
  const page2 = await contextA.newPage();
  page2.on('pageerror', (error) => console.error('[page2 error]', error.message));

  await check('新标签打开应用：依旧只有 1 条连接（SharedWorker 复用）', async () => {
    const before = await connectionCount();
    await page2.goto(APP, { waitUntil: 'networkidle2' });
    await shellReady(page2);
    await sleep(1200);
    assert.equal(await connectionCount(), before, 'the second tab opened an extra connection');
  });

  await check('抢占式单例：有且仅有一个标签可操作，另一个被冻结', async () => {
    await sleep(900);
    const [frozen1, frozen2] = [await hasFrozenOverlay(page1), await hasFrozenOverlay(page2)];
    assert.notEqual(frozen1, frozen2, `expected exactly one frozen tab, got frozen1=${frozen1} frozen2=${frozen2}`);
    // The newest window preempts.
    assert.equal(frozen2, false, 'the newly opened tab should be the active one');
  });

  await check('显式接管：点击“在此窗口继续操作”后活跃权转移', async () => {
    await clickTestId(page1, 'claim-leadership');
    await sleep(900);
    assert.equal(await hasFrozenOverlay(page1), false, 'page1 did not regain control');
    assert.equal(await hasFrozenOverlay(page2), true, 'page2 was not frozen after takeover');
  });

  console.log('\nCross-user realtime delivery');
  const contextB = await browser.createBrowserContext();
  const pageB = await contextB.newPage();
  pageB.on('pageerror', (error) => console.error('[pageB error]', error.message));

  await check('第二个用户登录后产生独立的第二条连接', async () => {
    const before = await connectionCount();
    await registerThroughUi(pageB, userB.username, userB.nickname);
    await waitForConnections(before + 1, 10000, 'after second user login');
  });

  await check('建立双向好友关系（HTTP 请求 + WS 推送同步到双方）', async () => {
    const sessionA = await loginToken(userA.username);
    const sessionB = await loginToken(userB.username);

    const search = await fetch(`${API}/api/friends/search?q=${encodeURIComponent(userB.username)}`, {
      headers: { authorization: `Bearer ${sessionA.accessToken}` },
    });
    const found = (await search.json()).data.users;
    assert.ok(found.some((u) => u.username === userB.username), 'user B not searchable');

    const request = await fetch(`${API}/api/friends/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionA.accessToken}` },
      body: JSON.stringify({ toUserId: found[0].id, message: 'ui test' }),
    });
    assert.equal(request.status, 201, 'friend request failed');
    const requestId = (await request.json()).data.request.id;

    const accept = await fetch(`${API}/api/friends/requests/${requestId}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionB.accessToken}` },
    });
    assert.equal(accept.status, 200, 'friend accept failed');

    // pageA must learn about the new friend purely from the WS push.
    await page1.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 8000 }, userB.nickname);
  });

  await check('会话外消息触发 Toast 弹窗 + 未读角标（无漏消息、无乱弹窗）', async () => {
    // page1 is the active window; open the conversation with B and send.
    await page1.evaluate((name) => {
      const item = [...document.querySelectorAll('[data-testid="conversation-item"]')].find((node) =>
        (node.textContent || '').includes(name)
      );
      if (item) item.click();
    }, userB.nickname);
    await page1.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });
    await page1.type('[data-testid="composer-input"]', messageText);
    await clickTestId(page1, 'composer-send');

    // B has no conversation open -> must receive a toast.
    await pageB.bringToFront();
    await pageB.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 10000 }, messageText);
    const toastVisible = await pageB.evaluate(() =>
      [...document.querySelectorAll('[data-testid="toast"]')].some((node) => node.textContent.includes('新消息'))
    );
    assert.ok(toastVisible, 'recipient did not receive a "新消息" toast');

    // B has the conversation closed -> its list item must badge the unread.
    const unreadBadge = await pageB.evaluate((name) => {
      const item = [...document.querySelectorAll('[data-testid="conversation-item"]')].find((node) =>
        (node.textContent || '').includes(name)
      );
      return item?.querySelector('.badge-unread')?.textContent ?? null;
    }, userA.nickname);
    assert.ok(unreadBadge, 'recipient conversation item should show an unread badge');
  });

  await check('会话内消息静默更新，不产生重复弹窗', async () => {
    // The previous check opened this conversation on page1, so the incoming
    // frame must render in the thread WITHOUT raising a toast.
    await page1.bringToFront();
    await page1.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

    const sessionB = await loginToken(userB.username);
    const sessionA = await loginToken(userA.username);
    const content = `reply-${tag}`;

    await fetch(`${API}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionB.accessToken}` },
      body: JSON.stringify({ toUserId: sessionA.user.id, content, clientMsgId: `ui-${uniq()}` }),
    });

    // Rendered into the open thread...
    await page1.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 8000 }, content);

    // ...and no toast carries that content (i.e. it was NOT surfaced noisily).
    const toasted = await page1.evaluate(
      (text) =>
        [...document.querySelectorAll('[data-testid="toast"]')].some((node) => node.textContent.includes(text)),
      content
    );
    assert.equal(toasted, false, 'in-conversation message raised a duplicate toast');

    // The conversation row now shows the last-message time (WeChat-style).
    const shownTime = await page1.evaluate((name) => {
      const item = [...document.querySelectorAll('[data-testid="conversation-item"]')].find((node) =>
        (node.textContent || '').includes(name)
      );
      return item?.querySelector('.conversation-time')?.textContent ?? null;
    }, userB.nickname);
    assert.ok(shownTime, `conversation item should show a timestamp, got "${shownTime}"`);

    // Composer height is adjustable by dragging its top edge (ref-based).
    const composerHeight = () =>
      page1.evaluate(
        () => document.querySelector('[data-testid="composer-input"]').closest('form').getBoundingClientRect().height
      );
    const beforeComposer = await composerHeight();
    const handle = await page1.$eval('[data-testid="composer-resizer"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page1.mouse.move(handle.x, handle.y);
    await page1.mouse.down();
    await page1.mouse.move(handle.x, handle.y - 80, { steps: 8 });
    await page1.mouse.up();
    const afterComposer = await composerHeight();
    assert.ok(afterComposer > beforeComposer + 40, `composer not resizable (${beforeComposer} -> ${afterComposer})`);
    const storedComposer = await page1.evaluate(() => window.localStorage.getItem('stella.im.composer-h'));
    assert.ok(storedComposer && /^\d+px$/.test(storedComposer), `composer height not persisted: ${storedComposer}`);
  });

  console.log('\nProfile editing');
  await check('修改昵称与头像：本地立即生效，并通过 WS 同步给好友', async () => {
    await page1.bringToFront();
    await clickTestId(page1, 'profile-open');
    await page1.waitForSelector('[data-testid="profile-dialog"]', { timeout: 8000 });

    const newNickname = `UIAlice2${tag.slice(-4)}`;
    await page1.evaluate(() => {
      document.querySelector('[data-testid="avatar-option"][data-avatar-id="p04"]')?.click();
    });
    await page1.click('[data-testid="nickname-input"]', { clickCount: 3 });
    await page1.type('[data-testid="nickname-input"]', newNickname);
    await clickTestId(page1, 'profile-save');

    // My own UI updates immediately.
    await page1.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 8000 }, newNickname);
    const myAvatar = await page1.evaluate(
      () => document.querySelector('[data-testid="profile-open"] .avatar')?.getAttribute('data-avatar') ?? null
    );
    assert.equal(myAvatar, 'p04', `sidebar avatar did not switch to the preset (got ${myAvatar})`);

    // ...and the peer learns about it over the socket, not a reload.
    await pageB.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 8000 }, newNickname);
  });

  await check('切换主题：令牌即时生效并在刷新后保持', async () => {
    await page1.bringToFront();
    // Theme lives in Settings (separate from the personal profile).
    await clickTestId(page1, 'settings-open');
    await page1.waitForSelector('[data-testid="settings-dialog"]', { timeout: 8000 });

    const before = await page1.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // Pick the light "paper" theme: its backdrop is unmistakably different.
    const clicked = await page1.evaluate(() => {
      const option = document.querySelector('[data-testid="theme-option"][data-theme-id="paper"]');
      if (!option) return false;
      option.click();
      return true;
    });
    assert.ok(clicked, 'theme option not found');

    await page1.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'paper', {
      timeout: 5000,
    });
    const after = await page1.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(after, before, 'the theme did not change any token');
    assert.equal(after, 'rgb(242, 240, 233)', `unexpected paper background: ${after}`);

    const stored = await page1.evaluate(() => window.localStorage.getItem('stella.im.theme'));
    assert.equal(stored, 'paper', 'the choice was not persisted');

    // Survives a reload (and must not flash the default theme first).
    await page1.reload({ waitUntil: 'networkidle2' });
    await page1.waitForSelector('[data-testid="shell"]', { timeout: 20000 });
    assert.equal(
      await page1.evaluate(() => document.documentElement.getAttribute('data-theme')),
      'paper',
      'the theme was lost on reload'
    );

    // Reset so later checks run on the default palette.
    await page1.evaluate(() => {
      window.localStorage.setItem('stella.im.theme', 'acid');
      document.documentElement.setAttribute('data-theme', 'acid');
    });
  });

  console.log('\nOne-way friend removal');
  await check('从我的列表移除好友：仅我这侧消失，对方仍保留我且仍可发消息', async () => {
    await page1.evaluate(() => document.querySelector('[data-testid="tab-friends"]')?.click());
    await page1.waitForSelector('[data-testid="friend-row"]', { timeout: 8000 });

    const friendId = await page1.evaluate((name) => {
      const row = [...document.querySelectorAll('[data-testid="friend-row"]')].find((node) =>
        (node.textContent || '').includes(name)
      );
      if (!row) return null;
      row.querySelector('[data-testid="friend-row-remove"]')?.click();
      return row.getAttribute('data-friend-id');
    }, userB.nickname);
    assert.ok(friendId, 'friend row not found');

    await page1.waitForSelector('[data-testid="friend-remove-confirm"]', { timeout: 5000 });
    await clickTestId(page1, 'friend-remove-confirm');

    // Gone from MY friend list...
    await page1.waitForFunction(
      (id) => !document.querySelector(`[data-testid="friend-row"][data-friend-id="${id}"]`),
      { timeout: 8000 },
      friendId
    );

    // ...and from MY conversation list.
    await page1.evaluate(() => document.querySelector('[data-testid="tab-chats"]')?.click());
    await sleep(300);
    const stillListed = await page1.evaluate(
      (id) => document.querySelector(`[data-testid="conversation-item"][data-friend-id="${id}"]`) !== null,
      friendId
    );
    assert.equal(stillListed, false, 'removed friend is still in my conversation list');

    // The peer keeps their side (one-way), so they can still reach me.
    const sessionA = await loginToken(userA.username);
    const sessionB = await loginToken(userB.username);
    const theirs = await fetch(`${API}/api/friends`, {
      headers: { authorization: `Bearer ${sessionB.accessToken}` },
    }).then((r) => r.json());
    assert.ok(
      theirs.data.friends.some((f) => f.id === sessionA.user.id),
      'peer lost me — removal was not one-way'
    );

    const send = await fetch(`${API}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionB.accessToken}` },
      body: JSON.stringify({
        toUserId: sessionA.user.id,
        content: 'still reachable after your removal',
        clientMsgId: `ui-rm-${uniq()}`,
      }),
    });
    assert.equal(send.status, 201, 'peer could not send after my one-way removal');
  });

  console.log('\nSystem announcement');
  await check('后端定时系统公告在任意页面强制弹窗（携带服务端时间）', async () => {
    const waitMs = Number(process.env.E2E_NOTICE_WAIT_MS || 15000);
    const sawNotice = await page1
      .waitForFunction(
        () => [...document.querySelectorAll('[data-testid="toast"]')].some((n) => n.textContent.includes('系统公告')),
        { timeout: waitMs }
      )
      .then(() => true)
      .catch(() => false);

    if (!sawNotice) {
      console.log(
        `      (skipped: no announcement within ${waitMs}ms — start the backend with SYSTEM_NOTICE_MS=5000 to assert this)`
      );
      return;
    }

    const noticeText = await page1.evaluate(() => {
      const node = [...document.querySelectorAll('[data-testid="toast"]')].find((n) =>
        n.textContent.includes('系统公告')
      );
      return node ? node.textContent : '';
    });
    assert.ok(noticeText.includes('服务端时间'), `announcement toast missing server time: ${noticeText}`);
    const sidebarNotice = await page1.evaluate(
      () => document.querySelector('[data-testid="notice-line"]') !== null
    );
    assert.ok(sidebarNotice, 'announcement was not pinned to the sidebar');
  });

  console.log('\nCross-tab logout');
  await check('任意窗口退出 → 所有窗口同步下线，连接归零', async () => {
    const before = await connectionCount();
    // Sign-out lives in Settings now.
    await clickTestId(page1, 'settings-open');
    await page1.waitForSelector('[data-testid="settings-dialog"]', { timeout: 8000 });
    await clickTestId(page1, 'signout');

    const settle = async (page) => {
      await page
        .waitForFunction(() => window.location.pathname.startsWith('/login'), { timeout: 10000 })
        .catch(() => {});
      return page.url();
    };

    const url1 = await settle(page1);
    const url2 = await settle(page2);
    const state2 = await page2.evaluate(() => ({
      session: window.localStorage.getItem('stella.im.session') ? 'present' : 'cleared',
      hasOverlay: document.querySelector('[data-testid="frozen-overlay"]') !== null,
      body: document.body.innerText.slice(0, 120).replace(/\n+/g, ' | '),
    }));

    assert.ok(url1.includes('/login'), `page1 did not return to login (got ${url1})`);
    assert.ok(
      url2.includes('/login'),
      `page2 did not return to login (got ${url2}; session=${state2.session}, overlay=${state2.hasOverlay}, body="${state2.body}")`
    );
    assert.equal(state2.session, 'cleared', 'page2 kept a stale session in localStorage');

    await waitForConnections(before - 1, 10000, 'after page1 logout (pageB still online)');
  });

  await check('未登录状态不再重连（登出后不产生新连接）', async () => {
    const before = await connectionCount();
    await sleep(1500);
    assert.equal(await connectionCount(), before, 'a connection was re-established after logout');
  });

  console.log('\nTransport host switch');
  await check('传输模式可切换为「页内单例抢占」并立即生效', async () => {
    // Isolated context so this cannot disturb the singleton/connection assertions
    // above (switching hosts briefly rebuilds the client).
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (error) => console.error('[host page error]', error.message));
    const hostTag = uniq();
    await registerThroughUi(page, `ui_host_${hostTag}`.slice(0, 32), `UIHost${hostTag.slice(-4)}`);

    // Default resolves to SharedWorker on a capable browser.
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="status-pill"]')?.getAttribute('data-transport') === 'shared-worker',
      { timeout: 12000 }
    );

    await clickTestId(page, 'settings-open');
    await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 8000 });
    await clickTestId(page, 'host-in-tab');

    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="status-pill"]')?.getAttribute('data-transport') === 'in-tab-fallback',
      { timeout: 12000 }
    );
    const stored = await page.evaluate(() => window.localStorage.getItem('stella.im.transport-host'));
    assert.equal(stored, 'in-tab', 'host preference was not persisted');

    await ctx.close();
  });

  await check('侧栏分割线可拖动且宽度被保存', async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (error) => console.error('[splitter page error]', error.message));
    const splitTag = uniq();
    await registerThroughUi(page, `ui_split_${splitTag}`.slice(0, 32), `UISplit${splitTag.slice(-4)}`);

    const sidebarWidth = () =>
      page.evaluate(() => document.querySelector('[data-testid="shell"]').firstElementChild.getBoundingClientRect().width);

    const before = await sidebarWidth();
    const box = await page.$eval('[data-testid="splitter"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y, { steps: 10 });
    await page.mouse.up();

    const after = await sidebarWidth();
    assert.ok(after > before + 40, `sidebar did not resize (${before} -> ${after})`);
    const stored = await page.evaluate(() => window.localStorage.getItem('stella.im.sidebar-w'));
    assert.ok(stored && /^\d+px$/.test(stored), `width not persisted: ${stored}`);

    await ctx.close();
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
