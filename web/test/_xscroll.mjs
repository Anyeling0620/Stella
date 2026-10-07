import fs from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

const APP = 'http://localhost:5173';
const API = 'http://127.0.0.1:3001';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      API + p,
      {
        method,
        agent: false,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw)?.data);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const LONG_TOKEN = 'https://example.com/' + 'A'.repeat(220);
const uniq = Date.now().toString(36).slice(-5);
const longNick = '这是一个没有空格而且特别特别长的好友昵称'.repeat(3);
const a = await api('POST', '/api/auth/register', { body: { username: `xs_a_${uniq}`, password: 'passw0rd', nickname: '小爱' } });
const b = await api('POST', '/api/auth/register', { body: { username: `xs_b_${uniq}`, password: 'passw0rd', nickname: longNick.slice(0, 60) } });
const r = await api('POST', '/api/friends/requests', { token: a.accessToken, body: { toUserId: b.user.id, message: 'hi' } });
if (r?.request) await api('POST', `/api/friends/requests/${r.request.id}/accept`, { token: b.accessToken });
await api('POST', '/api/messages', { token: b.accessToken, body: { toUserId: a.user.id, content: LONG_TOKEN, clientMsgId: `xs-${uniq}` } });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 900, height: 700 });
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (v) => {
    window.localStorage.setItem('stella.im.session', v);
    window.localStorage.setItem('stella.im.theme', 'wechat');
  },
  JSON.stringify({ user: a.user, accessToken: a.accessToken, refreshToken: a.refreshToken, accessExpiresAt: Date.now() + a.expiresIn * 1000 })
);
await page.goto(APP, { waitUntil: 'networkidle2' });
await page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });
await sleep(1800);

const probe = () =>
  page.evaluate(() => {
    const sels = ['.sidebar-body', '.conversation-list', '.conversation-item', '.conversation-sub', '.chat-scroll', '.bubble'];
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) out[s] = { sw: el.scrollWidth, cw: el.clientWidth, overflow: el.scrollWidth > el.clientWidth + 1 };
    }
    return out;
  });

console.log('--- list view ---');
console.log(JSON.stringify(await probe(), null, 1));
await page.screenshot({ path: 'test/screenshots/X0-list-longtext.png' });

await page.evaluate(() => document.querySelector('[data-testid="conversation-item"]')?.click());
await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });
await sleep(800);
console.log('--- chat view ---');
console.log(JSON.stringify(await probe(), null, 1));
await page.screenshot({ path: 'test/screenshots/X1-chat-longtext.png' });
await browser.close();
