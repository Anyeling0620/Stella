/**
 * TEMP UI probe — seeds a long conversation list + a long thread and captures
 * screenshots so layout/alignment can be reviewed. Delete after use.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP = process.env.E2E_APP || 'http://127.0.0.1:4173';
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
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, data: payload && payload.data };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const uniq = Date.now().toString(36).slice(-5);
  const me = (await api('POST', '/api/auth/register', { body: { username: `probe_a_${uniq}`, password: 'passw0rd', nickname: '我' } })).data;
  await api('PATCH', '/api/auth/me', { token: me.accessToken, body: { avatar: 'p06' } });

  const names = ['小博', '阿强', '晓雯', '老王', '大熊', '小林', '阿杰', '婷婷', '老李', '小雨', '阿May', '大壮', '小方', '老赵'];
  const friends = [];
  for (let i = 0; i < names.length; i += 1) {
    const u = await api('POST', '/api/auth/register', { body: { username: `probe_${uniq}_${i}`, password: 'passw0rd', nickname: names[i] } });
    const f = u.data;
    if (!f) continue;
    await api('PATCH', '/api/auth/me', { token: f.accessToken, body: { avatar: `p0${(i % 9) + 1}` } });
    const req = await api('POST', '/api/friends/requests', { token: me.accessToken, body: { toUserId: f.user.id } });
    if (req.status === 201) await api('POST', `/api/friends/requests/${req.data.request.id}/accept`, { token: f.accessToken });
    await api('POST', '/api/messages', {
      token: f.accessToken,
      body: { toUserId: me.user.id, content: `${names[i]}：这是预览文字，测试一下截断效果……`, clientMsgId: `p-${uniq}-${i}` },
    });
    friends.push(f);
  }

  // Long thread with the first friend.
  const first = friends[0];
  if (first) {
    for (let n = 0; n < 30; n += 1) {
      const from = n % 2 === 0 ? first : me;
      const to = n % 2 === 0 ? me : first;
      await api('POST', '/api/messages', {
        token: from.accessToken,
        body: { toUserId: to.user.id, content: `第 ${n + 1} 条：这是一条用来测试长列表滚动的消息内容。`, clientMsgId: `t-${uniq}-${n}` },
      });
    }
    await api('POST', `/api/messages/read`, { token: me.accessToken, body: { ids: [] } });
  }

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => window.localStorage.setItem('stella.im.session', JSON.stringify(value)), {
    user: me.user, accessToken: me.accessToken, refreshToken: me.refreshToken, accessExpiresAt: Date.now() + me.expiresIn * 1000,
  });
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'probe-01-list.png') });

  // Long thread.
  await page.evaluate(() => document.querySelector('[data-testid="conversation-item"]')?.click());
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'probe-02-thread.png') });

  // Page-level scroll check.
  const scrollInfo = await page.evaluate(() => ({
    bodyScroll: document.body.scrollHeight - window.innerHeight,
    shellScroll: (() => { const s = document.querySelector('[data-testid="shell"]'); return s ? s.scrollHeight - s.clientHeight : null; })(),
    sidebarBodyScroll: (() => { const b = document.querySelector('.sidebar-body'); return b ? b.scrollHeight - b.clientHeight : null; })(),
    chatScroll: (() => { const c = document.querySelector('.chat-scroll'); return c ? c.scrollHeight - c.clientHeight : null; })(),
  }));
  console.log('scroll info:', JSON.stringify(scrollInfo));

  await browser.close();
  console.log('probe screenshots written');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
