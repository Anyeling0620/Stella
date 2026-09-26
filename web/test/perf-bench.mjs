/**
 * Render-performance benchmark.
 *
 * Reproduces the "janky while a conversation is busy" symptom and measures it:
 *   1. seeds a thread, paginates it to a long history
 *   2. opens that conversation
 *   3. fires a burst of messages from the peer
 *   4. reports, measured inside the page:
 *        - frame health (requestAnimationFrame gaps -> dropped frames)
 *        - long-task stats (main-thread blocking)
 *        - per-paint gaps (how evenly incoming messages reach the DOM)
 *
 * Run: node test/perf-bench.mjs
 * Env: E2E_APP (default http://localhost:4173 — the production build, so the
 *      numbers are not polluted by dev-server overhead), E2E_API,
 *      BENCH_HISTORY, BENCH_BURST, BENCH_SPACING
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const APP = process.env.E2E_APP || 'http://localhost:4173';
const API = process.env.E2E_API || 'http://127.0.0.1:3001';
const HISTORY = Number(process.env.BENCH_HISTORY || 200);
const BURST = Number(process.env.BENCH_BURST || 40);
const SPACING_MS = Number(process.env.BENCH_SPACING || 25);
const PAGES = Number(process.env.BENCH_PAGES || 6);
const SESSION_KEY = 'stella.im.session';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
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

async function seed() {
  const tag = uniq();
  const a = (await api('POST', '/api/auth/register', {
    body: { username: `perf_a_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'PerfA' },
  })).data;
  const b = (await api('POST', '/api/auth/register', {
    body: { username: `perf_b_${tag}`.slice(0, 32), password: 'passw0rd', nickname: 'PerfB' },
  })).data;

  const req = await api('POST', '/api/friends/requests', { token: a.accessToken, body: { toUserId: b.user.id } });
  await api('POST', `/api/friends/requests/${req.data.request.id}/accept`, { token: b.accessToken });

  process.stdout.write(`  seeding ${HISTORY} history messages… `);
  for (let i = 0; i < HISTORY; i += 1) {
    await api('POST', '/api/messages', {
      token: i % 2 === 0 ? a.accessToken : b.accessToken,
      body: {
        toUserId: i % 2 === 0 ? b.user.id : a.user.id,
        content: `历史消息 #${i} — 一些用于撑开列表的普通文本内容`,
        clientMsgId: `perf-h-${tag}-${i}`,
      },
    });
  }
  console.log('done');
  return { a, b };
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const { a, b } = await seed();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
  if (!appUp) throw new Error(`frontend not reachable at ${APP}`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (key, value) => window.localStorage.setItem(key, JSON.stringify(value)),
    SESSION_KEY,
    {
      user: a.user,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      accessExpiresAt: Date.now() + a.expiresIn * 1000,
    }
  );
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="shell"]', { timeout: 20000 });
  await sleep(1200);

  await page.evaluate(() => {
    const item = document.querySelector('[data-testid="conversation-item"]');
    if (item) item.click();
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });
  await sleep(1500);

  // The thread opens with one page (50); paginate up so the list is genuinely
  // long — that is the state in which jank shows up.
  for (let i = 0; i < PAGES; i += 1) {
    const clicked = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="load-older"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    if (!clicked) break;
    await sleep(700);
  }
  await sleep(800);

  const bubblesBefore = await page.evaluate(() => document.querySelectorAll('.bubble').length);
  console.log(`  rendered ${bubblesBefore} bubbles after pagination`);
  if (bubblesBefore < 100) throw new Error(`expected a long thread, only ${bubblesBefore} bubbles`);

  // --- instrumentation -----------------------------------------------------
  await page.evaluate(() => {
    window.__bench = { feed: [], longTasks: [], frames: [], started: false };

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__bench.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask unsupported — reported as zero */
    }

    let lastBubbles = document.querySelectorAll('.bubble').length;
    new MutationObserver(() => {
      const count = document.querySelectorAll('.bubble').length;
      if (count > lastBubbles) window.__bench.feed.push({ at: performance.now(), count });
      lastBubbles = count;
    }).observe(document.body, { childList: true, subtree: true });

    // Typing latency: keystroke -> the frame in which the value is committed.
    window.__type = [];
    const input = document.querySelector('[data-testid="composer-input"]');
    if (input) {
      let lastKey = 0;
      window.__typeLen = input.value.length;
      input.addEventListener('keydown', () => {
        lastKey = performance.now();
      });
      const poll = () => {
        if (lastKey && input.value.length > window.__typeLen) {
          window.__type.push(performance.now() - lastKey);
          window.__typeLen = input.value.length;
          lastKey = 0;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }

    // Frame sampler: records every rAF gap once recording starts.
    let previous = performance.now();
    const sample = (now) => {
      if (window.__bench.started) window.__bench.frames.push(now - previous);
      previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  // --- burst ---------------------------------------------------------------
  await page.evaluate(() => {
    window.__bench.started = true;
  });
  const sentAt = [];
  for (let i = 0; i < BURST; i += 1) {
    sentAt.push(Date.now());
    await api('POST', '/api/messages', {
      token: b.accessToken,
      body: { toUserId: a.user.id, content: `突发消息 #${i}`, clientMsgId: `perf-b-${uniq()}-${i}` },
    });
    await sleep(SPACING_MS);
  }
  await sleep(2500);
  await page.evaluate(() => {
    window.__bench.started = false;
  });

  // Typing responsiveness with the long thread still mounted — this is the
  // scenario where an unmemoized row list makes every keystroke expensive.
  const TYPED = 25;
  await page.evaluate(() => {
    window.__bench.started = true;
  });
  await page.click('[data-testid="composer-input"]');
  for (let i = 0; i < TYPED; i += 1) {
    await page.keyboard.type('x');
    await sleep(30);
  }
  await sleep(600);
  await page.evaluate(() => {
    window.__bench.started = false;
  });

  const result = await page.evaluate((burst) => {
    const bench = window.__bench;
    return {
      feed: bench.feed,
      frames: bench.frames,
      longTasks: bench.longTasks,
      bubbles: document.querySelectorAll('.bubble').length,
      hasLast: document.body.innerText.includes(`突发消息 #${burst - 1}`),
      typing: window.__type,
    };
  }, BURST);

  // Align the two clocks on the first message, then per-message lag is
  // (when it was painted) - (when it was sent, relative to the first send).
  const paint0 = result.feed[0]?.at ?? 0;
  const send0 = sentAt[0] ?? 0;
  const lag = result.feed.map((entry, index) => entry.at - paint0 - ((sentAt[index] ?? send0) - send0));
  const lagSorted = [...lag].sort((x, y) => x - y);

  const frames = [...result.frames].sort((x, y) => x - y);
  const dropped = result.frames.filter((gap) => gap > 33).length;
  const janky = result.frames.filter((gap) => gap > 50).length;
  const longTotal = result.longTasks.reduce((sum, t) => sum + t.duration, 0);
  const longMax = result.longTasks.reduce((max, t) => Math.max(max, t.duration), 0);
  const firstFeed = result.feed[0]?.at ?? 0;
  const lastFeed = result.feed[result.feed.length - 1]?.at ?? 0;

  const gaps = [];
  for (let i = 1; i < result.feed.length; i += 1) gaps.push(result.feed[i].at - result.feed[i - 1].at);
  gaps.sort((x, y) => x - y);

  console.log('\n=== render performance ===');
  console.log(`history bubbles        : ${bubblesBefore}`);
  console.log(`burst                  : ${BURST} msgs, ${SPACING_MS}ms apart (+ fetch time)`);
  console.log(`paint batches / bubbles: ${result.feed.length} / ${result.bubbles - bubblesBefore} new`);
  console.log(`all messages in DOM    : ${result.hasLast ? 'yes' : 'NO'}`);
  console.log(`send spread (node clock): ${((sentAt[sentAt.length - 1] ?? 0) - (sentAt[0] ?? 0)).toFixed(0)}ms`);
  console.log(`paint spread           : ${(lastFeed - firstFeed).toFixed(0)}ms`);
  console.log(
    `per-message lag p50/p95/max: ${percentile(lagSorted, 50).toFixed(0)} / ${percentile(lagSorted, 95).toFixed(0)} / ${(lagSorted[lagSorted.length - 1] ?? 0).toFixed(0)} ms`
  );
  console.log(
    `paint gap p50/p95/max  : ${percentile(gaps, 50).toFixed(0)} / ${percentile(gaps, 95).toFixed(0)} / ${(gaps[gaps.length - 1] ?? 0).toFixed(0)} ms`
  );
  console.log(`frames sampled         : ${result.frames.length}`);
  console.log(
    `frame gap p50/p95/max  : ${percentile(frames, 50).toFixed(1)} / ${percentile(frames, 95).toFixed(1)} / ${(frames[frames.length - 1] ?? 0).toFixed(1)} ms`
  );
  console.log(
    `dropped frames (>33ms) : ${dropped}  (${((dropped / Math.max(1, result.frames.length)) * 100).toFixed(1)}%)`
  );
  console.log(`janky frames (>50ms)   : ${janky}`);
  console.log(`long tasks (>50ms)     : ${result.longTasks.length}   total ${longTotal.toFixed(0)}ms, longest ${longMax.toFixed(0)}ms`);

  const typing = [...result.typing].sort((a, b) => a - b);
  console.log(
    `keystroke->paint p50/p95/max: ${percentile(typing, 50).toFixed(1)} / ${percentile(typing, 95).toFixed(1)} / ${(typing[typing.length - 1] ?? 0).toFixed(1)} ms  (${typing.length}/${TYPED} sampled)`
  );

  await browser.close();
  console.log('');
}

main().catch((error) => {
  console.error('fatal:', error.message);
  process.exit(1);
});
