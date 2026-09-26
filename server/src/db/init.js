'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { STATEMENTS } = require('./schema');
const { createLogger } = require('../utils/logger');

const log = createLogger('db');

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
