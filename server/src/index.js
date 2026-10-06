'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const { createLogger } = require('./utils/logger');
const { initDatabase } = require('./db/init');
const { pool } = require('./db/pool');
const { attachWebSocket } = require('./ws/server');
const { startSystemNoticeJob, stopSystemNoticeJob } = require('./jobs/systemNotice');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { deleteExpired } = require('./repositories/tokenRepo');
const hub = require('./ws/hub');

const log = createLogger('server');

const app = express();
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / curl (no Origin header) is always allowed.
      if (!origin) return cb(null, true);
      if (config.cors.origins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    log.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    data: {
      status: 'up',
      serverTime: new Date().toISOString(),
      onlineUsers: hub.onlineCount(),
      connections: hub.connectionCount(),
    },
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/system', require('./routes/system'));

app.use(notFoundHandler);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function bootstrap() {
  await initDatabase();

  const server = http.createServer(app);
  attachWebSocket(server);

  await new Promise((resolve) => server.listen(config.http.port, config.http.host, resolve));
  startSystemNoticeJob();

  // Opportunistic cleanup of expired refresh tokens.
  const cleanup = setInterval(() => deleteExpired().catch(() => {}), 60 * 60 * 1000);
  if (typeof cleanup.unref === 'function') cleanup.unref();

  log.info(`HTTP listening on http://${config.http.host}:${config.http.port}`);
  log.info(`WebSocket endpoint ws://${config.http.host}:${config.http.port}${config.ws.path}`);

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down...`);
    stopSystemNoticeJob();
    clearInterval(cleanup);
    hub.broadcast({ type: 'session:invalid', reason: 'server shutting down' });
    for (const ws of hub.all) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await pool.end().catch(() => {});
    log.info('bye');
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  bootstrap().catch((err) => {
    log.error('bootstrap failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { app, bootstrap };
