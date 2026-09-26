/**
 * Double-account live demo launcher.
 *
 * Seeds two demo accounts that are already friends (and have a little history),
 * then opens TWO independent browser windows — one per account — so both can be
 * used side by side for real-time chat.
 *
 * Two separate browser *processes* are used on purpose: they get independent
 * localStorage and independent SharedWorkers, which is exactly what two real
 * users look like. (Two tabs in one profile would share the session.)
 *
 * Run: node test/demo-browser.mjs
 * Stop: Ctrl+C (closes both windows)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP = process.env.DEMO_APP || 'http://localhost:5173';
const API = process.env.DEMO_API || 'http://127.0.0.1:3001';
const PASSWORD = '123456';

const ACCOUNTS = [
  { username: 'demo_alice', nickname: '演示·小爱', side: 'left', position: '60,60' },
  { username: 'demo_bob', nickname: '演示·小博', side: 'right', position: '740,60' },
];

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, urlPath, { token, body } = {}) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Registers (or logs in) a demo account. */
async function ensureAccount(account) {
  const registered = await call('POST', '/api/auth/register', {
    body: { username: account.username, password: PASSWORD, nickname: account.nickname },
  });
  if (registered.status === 201) return registered.body.data;
  if (registered.status === 409) {
    const login = await call('POST', '/api/auth/login', {
      body: { username: account.username, password: PASSWORD },
    });
    if (login.status !== 200) throw new Error(`login failed for ${account.username}`);
    return login.body.data;
  }
  throw new Error(`register failed for ${account.username}: ${JSON.stringify(registered.body)}`);
}

/** Makes sure the two accounts are friends (idempotent). */
async function ensureFriendship(a, b) {
  const friends = await call('GET', '/api/friends', { token: a.accessToken });
  if (friends.body.data.friends.some((f) => f.username === ACCOUNTS[1].username)) return true;

  const request = await call('POST', '/api/friends/requests', {
    token: a.accessToken,
    body: { toUserId: b.user.id, message: '演示账号，自动建立好友关系' },
  });

  // 201 => fresh request; 409 => they are already friends / request exists.
  if (request.status === 201) {
    const accepted = await call('POST', `/api/friends/requests/${request.body.data.request.id}/accept`, {
      token: b.accessToken,
    });
    return accepted.status === 200;
  }
  return request.status === 409;
}

/** Seeds a couple of messages so the thread is not empty on first open. */
async function ensureHistory(a, b) {
  const history = await call('GET', `/api/messages/history?friendId=${b.user.id}&limit=5`, {
    token: a.accessToken,
  });
  if ((history.body?.data?.messages ?? []).length > 0) return;

  const lines = [
    [b, a, '嗨！我是小博，这是从后端推送到你窗口的实时消息。'],
    [a, b, '收到，我这边是共享长连接推过来的，多标签也只会占用一条连接。'],
    [b, a, '试试断网重连、降级轮询和多窗口冻结吧。'],
  ];
  for (const [from, to, content] of lines) {
    await call('POST', '/api/messages', {
      token: from.accessToken,
      body: { toUserId: to.user.id, content, clientMsgId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
  }
}

function buildStoredSession(payload) {
  return {
    user: payload.user,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessExpiresAt: Date.now() + payload.expiresIn * 1000,
  };
}

async function openWindow(executablePath, session, position) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stella-demo-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir,
    defaultViewport: null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      `--window-position=${position}`,
      '--window-size=640,940',
    ],
  });

  const page = await browser.newPage();

  // Visibility: if a logout ever happens without a click, this records who sent it.
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/auth/logout')) {
      console.log(`  [${session.user.username}] POST /api/auth/logout  (${new Date().toLocaleTimeString()})`);
    }
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });

  // Seed the persisted session, then reload so the app boots already logged in.
  await page.evaluate((stored) => {
    window.localStorage.setItem('stella.im.session', JSON.stringify(stored));
  }, buildStoredSession(session));

  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.bringToFront();

  return { browser, page, userDataDir, username: session.user.username };
}

async function main() {
  const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('找不到 Chrome / Edge 可执行文件');

  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`后端未就绪：${API}`);

  console.log('准备演示账号…');
  const [alice, bob] = [await ensureAccount(ACCOUNTS[0]), await ensureAccount(ACCOUNTS[1])];
  await ensureFriendship(alice, bob);
  await ensureHistory(alice, bob);
  console.log(`账号就绪：${ACCOUNTS[0].username} / ${ACCOUNTS[1].username}（密码 ${PASSWORD}）`);

  console.log('打开两个浏览器窗口…');
  const left = await openWindow(executablePath, alice, ACCOUNTS[0].position);
  await sleep(800);
  const right = await openWindow(executablePath, bob, ACCOUNTS[1].position);

  await sleep(2500);
  for (const [label, win] of [
    [ACCOUNTS[0].username, left],
    [ACCOUNTS[1].username, right],
  ]) {
    const url = win.page.url();
    const body = (await win.page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 90);
    console.log(`  ${label}: ${url}  →  ${body}`);
  }

  const online = await fetch(`${API}/api/health`).then((r) => r.json());
  console.log(`\n后端长连接数 = ${online.data.connections}（两个独立窗口应分别为 1 条，合计 2）`);
  console.log('两个窗口已就绪，直接开始聊天即可。按 Ctrl+C 结束演示并关闭窗口。\n');

  // Standalone single-connection monitor: makes any leak immediately visible.
  const monitor = setInterval(async () => {
    try {
      const data = await fetch(`${API}/api/health`).then((r) => r.json());
      const stamp = new Date().toLocaleTimeString();
      const warn = data.data.connections > 2 ? '  <-- 连接泄漏！' : '';
      console.log(`  [${stamp}] 长连接数=${data.data.connections} 在线用户=${data.data.onlineUsers}${warn}`);
    } catch {
      console.log('  (监控失败：后端不可用)');
    }
  }, 10_000);

  const shutdown = async () => {
    console.log('\n关闭演示窗口…');
    clearInterval(monitor);
    await left.browser.close().catch(() => {});
    await right.browser.close().catch(() => {});
    for (const dir of [left.userDataDir, right.userDataDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the windows (and this process) alive.
  setInterval(() => {}, 60_000);
}

main().catch((error) => {
  console.error('演示启动失败:', error.message);
  process.exit(1);
});
