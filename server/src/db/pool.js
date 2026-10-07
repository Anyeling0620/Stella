'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('db:pool');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: config.db.queueLimit,
  // Drop idle connections so a burst does not keep the whole pool parked.
  maxIdle: config.db.connectionLimit,
  idleTimeout: 60_000,
  charset: 'utf8mb4_general_ci',
  // Everything is handled in UTC end-to-end: the session time zone is pinned
  // below and DATETIME values are parsed/serialised as UTC ('Z').
  timezone: 'Z',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: false,
});

pool.on('connection', (conn) => {
  // Keep timestamps unambiguous across the whole app.
  conn.query("SET time_zone = '+00:00'");
});

/** Runs a query and returns the rows. */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Runs `fn` inside a transaction, rolling back on any thrown error.
 * `fn` receives a connection whose `.execute` already returns rows.
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  const scoped = {
    raw: conn,
    async query(sql, params = []) {
      const [rows] = await conn.execute(sql, params);
      return rows;
    },
  };
  try {
    await conn.beginTransaction();
    const result = await fn(scoped);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      log.error('rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, transaction };
