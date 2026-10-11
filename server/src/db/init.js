'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { STATEMENTS, MIGRATIONS, INDEX_MIGRATIONS, ALTERS } = require('./schema');
const { createLogger } = require('../utils/logger');

const log = createLogger('db');

/**
 * Adds a column only when it is actually missing.
 * MySQL has no `ADD COLUMN IF NOT EXISTS`, so existence is checked against
 * `information_schema` first — this keeps the boot path idempotent and lets a
 * database created before group chat be upgraded in place.
 */
async function addColumnIfMissing(conn, { table, column, ddl }) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [config.db.database, table, column]
  );
  if (rows.length > 0) return false;
  await conn.query(ddl);
  log.info(`migrated: added ${table}.${column}`);
  return true;
}

/** Same idea for secondary indexes. */
async function addIndexIfMissing(conn, { table, index, ddl }) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
    [config.db.database, table, index]
  );
  if (rows.length > 0) return false;
  await conn.query(ddl);
  log.info(`migrated: added index ${index} on ${table}`);
  return true;
}

/** Applies a column *type* change only when the current definition lacks `contains`. */
async function alterIfNeeded(conn, { table, column, contains, ddl }) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [config.db.database, table, column]
  );
  if (rows.length === 0) return false; // table/column not created yet
  if (String(rows[0].t).includes(contains)) return false;
  await conn.query(ddl);
  log.info(`migrated: altered ${table}.${column}`);
  return true;
}

/**
 * Creates the database (if missing) and every table (if missing).
 * Safe to run repeatedly and on every process boot.
 */
async function initDatabase({ silent = false } = {}) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: false,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
    await conn.changeUser({ database: config.db.database });

    for (const sql of STATEMENTS) {
      await conn.query(sql);
    }
    for (const migration of MIGRATIONS) {
      await addColumnIfMissing(conn, migration);
    }
    for (const index of INDEX_MIGRATIONS) {
      await addIndexIfMissing(conn, index);
    }
    for (const alter of ALTERS) {
      await alterIfNeeded(conn, alter);
    }

    if (!silent) {
      log.info(`schema ready on ${config.db.host}:${config.db.port}/${config.db.database}`);
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('schema init failed:', err.message);
      process.exit(1);
    });
}

module.exports = { initDatabase };
