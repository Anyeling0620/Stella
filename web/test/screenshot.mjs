/**
 * Visual check: renders the app at desktop / tablet / phone widths and writes
 * PNGs to test/screenshots so the layout can be reviewed by eye.
 *
 * Run: node test/screenshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP = process.env.E2E_APP || 'http://localhost:5173';
const API = process.env.E2E_API || 'http://127.0.0.1:3001';
const OUT = path.join(import.meta.dirname, 'screenshots');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, urlPath, { token, body } = {}) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, data: payload?.data };
}

/** demo_alice / demo_bob: already friends with history from the demo script. */
async function seed() {
  const uniq = Date.now().toString(36).slice(-5);
  const names = [`shot_a_${uniq}`, `shot_b_${uniq}`];
  const sessions = [];
  for (const [index, username] of names.entries()) {
    const reg = await api('POST', '/api/auth/register', {
      body: { username, password: 'passw0rd', nickname: index === 0 ? '小爱' : '小博' },
    });
    sessions.push(reg.data);
  }
  const [a, b] = sessions;

  // A preset avatar so the artwork is visible in the shots.
  await api('PATCH', '/api/auth/me', { token: a.accessToken, body: { avatar: 'p06' } });
  await api('PATCH', '/api/auth/me', { token: b.accessToken, body: { avatar: 'p03' } });

  const req = await api('POST', '/api/friends/requests', {
    token: a.accessToken,
    body: { toUserId: b.user.id, message: '加个好友' },
  });
  if (req.status === 201) {
    await api('POST', `/api/friends/requests/${req.data.request.id}/accept`, { token: b.accessToken });
  }

  const history = await api('GET', `/api/messages/history?friendId=${b.user.id}&limit=5`, { token: a.accessToken });
  if ((history.data?.messages ?? []).length === 0) {
    const lines = [
      [b, a, '这是推送过来的实时消息'],
      [a, b, '收到，多标签也只会占用一条长连接'],
      [b, a, '试试改昵称和头像'],
      [a, b, '已经改好了'],
    ];
    for (const [from, to, content] of lines) {
      await api('POST', '/api/messages', {
        token: from.accessToken,
        body: { toUserId: to.user.id, content, clientMsgId: `shot-${uniq}-${Math.random().toString(36).slice(2, 7)}` },
      });
    }
  }
  // Re-login so the persisted nickname/avatar are current.
  const fresh = await api('POST', '/api/auth/login', { body: { username: names[0], password: 'passw0rd' } });
  return { alice: fresh.data, bob: b };
}

async function newPage(browser, width, height, session) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('stella.im.session', JSON.stringify(value));
  }, {
    user: session.user,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: Date.now() + session.expiresIn * 1000,
  });
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });
  await sleep(1200);
  return page;
}

const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  wrote ${path.basename(file)}`);
};

const openConversation = async (page) => {
  await page.evaluate(() => {
    const item = document.querySelector('[data-testid="conversation-item"]');
    if (item) item.click();
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });
  await sleep(500);
};

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const { alice } = await seed();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  console.log('desktop 1440x900');
  // Login page: a page with no session at all.
  const loginContext = await browser.createBrowserContext();
  const loginPage = await loginContext.newPage();
  await loginPage.setViewport({ width: 1440, height: 900 });
  await loginPage.goto(APP, { waitUntil: 'networkidle2' });
  await loginPage.waitForSelector('.login-card', { timeout: 15000 });
  await sleep(400);
  await shot(loginPage, '01-login-desktop');

  const desktop = await newPage(browser, 1440, 900, alice);
  await openConversation(desktop);
  await shot(desktop, '02-chat-desktop');

  await desktop.evaluate(() => document.querySelector('[data-testid="profile-open"]')?.click());
  await desktop.waitForSelector('[data-testid="profile-dialog"]', { timeout: 8000 });
  await sleep(400);
  await shot(desktop, '03-profile-dialog');
  await desktop.evaluate(() => document.querySelector('[data-testid="profile-cancel"]')?.click());
  await sleep(300);

  await desktop.evaluate(() => document.querySelector('[data-testid="tab-friends"]')?.click());
  await sleep(400);
  await desktop.evaluate(() => document.querySelector('[data-testid="friend-row-remove"]')?.click());
  await sleep(300);
  await shot(desktop, '04-friends-remove-confirm');

  // Settings dialog (theme picker) + two alternate palettes.
  await desktop.evaluate(() => document.querySelector('[data-testid="settings-open"]')?.click());
  await desktop.waitForSelector('[data-testid="settings-dialog"]', { timeout: 8000 });
  await sleep(400);
  await shot(desktop, '10-theme-picker');
  for (const theme of ['paper', 'cyan', 'magenta']) {
    await desktop.evaluate((id) => {
      document.querySelector(`[data-testid="theme-option"][data-theme-id="${id}"]`)?.click();
    }, theme);
    await sleep(400);
    await desktop.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await sleep(300);
    await shot(desktop, `11-theme-${theme}`);
    await desktop.evaluate(() => document.querySelector('[data-testid="settings-open"]')?.click());
    await desktop.waitForSelector('[data-testid="settings-dialog"]', { timeout: 8000 });
    await sleep(200);
  }
  await desktop.evaluate(() => {
    document.querySelector('[data-testid="settings-close"]')?.click();
    window.localStorage.setItem('stella.im.theme', 'wechat');
    document.documentElement.setAttribute('data-theme', 'wechat');
  });
  await sleep(300);

  // Contacts (通讯录): shortcut rows + letter-grouped list + alphabet index.
  await desktop.evaluate(() => document.querySelector('[data-testid="tab-chats"]')?.click());
  await sleep(300);
  await desktop.evaluate(() => document.querySelector('[data-testid="tab-friends"]')?.click());
  await sleep(500);
  await shot(desktop, '12-contacts-desktop');

  console.log('tablet 768x900');
  const tablet = await newPage(browser, 768, 900, alice);
  await openConversation(tablet);
  await shot(tablet, '06-chat-tablet');

  console.log('phone 375x812');
  const phone = await newPage(browser, 375, 812, alice);
  await shot(phone, '07-list-phone');
  await openConversation(phone);
  await shot(phone, '08-chat-phone');

  // The sidebar is hidden while a conversation is open on mobile, so go back
  // to the list first.

  await phone.evaluate(() => document.querySelector('[data-testid="chat-back"]')?.click());
  await sleep(400);
  await phone.evaluate(() => document.querySelector('[data-testid="tab-friends"]')?.click());
  await sleep(400);
  await shot(phone, '09-friends-phone');

  await browser.close();
  console.log(`\nscreenshots in ${OUT}`);
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exit(1);
});
