'use strict';

/**
 * Idempotent schema. Executed on every boot (CREATE ... IF NOT EXISTS) so the
 * prototype is self-healing and never requires a manual migration step.
 */
const DATABASE_OPTIONS = 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username      VARCHAR(32)     NOT NULL,
      password_hash VARCHAR(100)    NOT NULL,
      nickname      VARCHAR(64)     NOT NULL,
      avatar        VARCHAR(255)    NULL,
      token_version INT UNSIGNED    NOT NULL DEFAULT 0,
      last_seen_at  DATETIME        NULL,
      created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_users_username (username)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Refresh tokens are stored server side so they can be rotated (single use)
  // and revoked on logout — the basis of the silent 401 renewal flow.
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      jti        CHAR(36)        NOT NULL,
      token_hash CHAR(64)        NOT NULL,
      expires_at DATETIME        NOT NULL,
      revoked    TINYINT(1)      NOT NULL DEFAULT 0,
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_refresh_jti (jti),
      KEY idx_refresh_user (user_id, revoked)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Friendship is stored as two directed rows so "my friends" is a single index
  // scan, while still guaranteeing a symmetric relation on write.
  `CREATE TABLE IF NOT EXISTS friendships (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      friend_id  BIGINT UNSIGNED NOT NULL,
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_friendship (user_id, friend_id),
      KEY idx_friendship_friend (friend_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS friend_requests (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      from_user_id BIGINT UNSIGNED NOT NULL,
      to_user_id   BIGINT UNSIGNED NOT NULL,
      message      VARCHAR(255)    NULL,
      status       ENUM('pending','accepted','rejected','cancelled') NOT NULL DEFAULT 'pending',
      created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_request_pair (from_user_id, to_user_id),
      KEY idx_request_to_status (to_user_id, status)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Monotonic auto-increment id doubles as the incremental sync cursor used by
  // both the WebSocket stream and the HTTP polling fallback.
  `CREATE TABLE IF NOT EXISTS messages (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_msg_id  CHAR(36)        NULL,
      from_user_id   BIGINT UNSIGNED NOT NULL,
      to_user_id     BIGINT UNSIGNED NOT NULL,
      content        TEXT            NOT NULL,
      status         TINYINT UNSIGNED NOT NULL DEFAULT 0,
      created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_message_client_id (client_msg_id),
      KEY idx_message_pair (from_user_id, to_user_id, id),
      KEY idx_message_recipient (to_user_id, id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // System broadcasts are persisted too, so a client that is stuck on the HTTP
  // polling fallback still receives the two-minute announcements.
  `CREATE TABLE IF NOT EXISTS system_notices (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      level      VARCHAR(16)     NOT NULL DEFAULT 'info',
      content    VARCHAR(500)    NOT NULL,
      created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,
];

module.exports = { STATEMENTS, DATABASE_OPTIONS };
