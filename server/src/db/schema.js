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
  //
  // One table serves both 1:1 and group threads: `group_id` is NULL for direct
  // messages (routed by from/to) and set for group messages (routed by
  // membership), so group chat did not need a parallel messages table. `type`
  // marks in-thread system notices ("张三 加入了群聊"); `mention_user_ids` holds
  // comma-wrapped user ids for @-mention highlighting.
  `CREATE TABLE IF NOT EXISTS messages (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_msg_id    CHAR(36)        NULL,
      from_user_id     BIGINT UNSIGNED NOT NULL,
      to_user_id       BIGINT UNSIGNED NOT NULL,
      group_id         BIGINT UNSIGNED NULL,
      type             VARCHAR(16)     NOT NULL DEFAULT 'text',
      mention_user_ids VARCHAR(255)    NULL,
      attachment_id    BIGINT UNSIGNED NULL,
      content          TEXT            NOT NULL,
      status           TINYINT UNSIGNED NOT NULL DEFAULT 0,
      created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_message_client_id (client_msg_id),
      KEY idx_message_pair (from_user_id, to_user_id, id),
      KEY idx_message_recipient (to_user_id, id),
      KEY idx_message_group (group_id, id)
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

  // Group chat. `messages.group_id` (added by MIGRATIONS below) points back here
  // for group messages, so there is a single messages table shared by 1:1 and
  // group threads instead of a parallel `group_messages` table.
  // `group_no` is the shareable, searchable identifier (QQ-style 群号).
  `CREATE TABLE IF NOT EXISTS \`groups\` (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      group_no     BIGINT UNSIGNED NULL,
      name         VARCHAR(64)     NOT NULL,
      avatar       VARCHAR(255)    NULL,
      owner_id     BIGINT UNSIGNED NOT NULL,
      announcement VARCHAR(500)    NULL,
      created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_group_no (group_no),
      KEY idx_group_owner (owner_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Membership + read cursor. `last_read_message_id` backs the group unread
  // badge and "有人@你" hint without per-message read receipts (QQ/微信 style).
  `CREATE TABLE IF NOT EXISTS group_members (
      id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      group_id             BIGINT UNSIGNED NOT NULL,
      user_id              BIGINT UNSIGNED NOT NULL,
      role                 ENUM('owner','member') NOT NULL DEFAULT 'member',
      last_read_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      joined_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_group_member (group_id, user_id),
      KEY idx_group_member_user (user_id),
      KEY idx_group_member_group (group_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // QQ-style "apply to join". Upserted on (group_id, user_id) so a rejected
  // applicant can re-apply; the group owner approves or rejects.
  `CREATE TABLE IF NOT EXISTS group_join_requests (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      group_id   BIGINT UNSIGNED NOT NULL,
      user_id    BIGINT UNSIGNED NOT NULL,
      message    VARCHAR(255)    NULL,
      status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_group_join_pair (group_id, user_id),
      KEY idx_group_join_pending (group_id, status),
      KEY idx_group_join_user (user_id, status)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Uploaded chat media. Bytes live on disk (`config.uploads.dir`); this row is
  // the metadata. `stored_name` is a server-generated random id — the original
  // filename is never used for the path, so a hostile name cannot escape the
  // uploads directory.
  `CREATE TABLE IF NOT EXISTS attachments (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      uploader_id   BIGINT UNSIGNED NOT NULL,
      kind          ENUM('image','file') NOT NULL,
      original_name VARCHAR(255)    NOT NULL,
      stored_name   VARCHAR(128)    NOT NULL,
      mime          VARCHAR(128)    NOT NULL,
      size          BIGINT UNSIGNED NOT NULL,
      created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_attachment_stored (stored_name),
      KEY idx_attachment_uploader (uploader_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,
];

/**
 * Idempotent column/index additions for tables that predate them.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a database
 * created before group chat existed would be missing `messages.group_id`.
 * MySQL has no `ADD COLUMN IF NOT EXISTS`, so `initDatabase()` checks
 * `information_schema` and only runs the DDL that is actually missing.
 *
 * `mentions` is stored comma-wrapped (`,3,7,`) so membership tests can use
 * `FIND_IN_SET`, which is unambiguous (ids are never substrings of each other).
 */
const MIGRATIONS = [
  { table: 'messages', column: 'group_id', ddl: 'ALTER TABLE messages ADD COLUMN group_id BIGINT UNSIGNED NULL' },
  {
    table: 'messages',
    column: 'type',
    ddl: "ALTER TABLE messages ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT 'text'",
  },
  {
    table: 'messages',
    column: 'mention_user_ids',
    ddl: 'ALTER TABLE messages ADD COLUMN mention_user_ids VARCHAR(255) NULL',
  },
  { table: 'groups', column: 'group_no', ddl: 'ALTER TABLE `groups` ADD COLUMN group_no BIGINT UNSIGNED NULL' },
  {
    table: 'messages',
    column: 'attachment_id',
    ddl: 'ALTER TABLE messages ADD COLUMN attachment_id BIGINT UNSIGNED NULL',
  },
];

/** Indexes added alongside the columns above (checked by name). */
const INDEX_MIGRATIONS = [
  { table: 'messages', index: 'idx_message_group', ddl: 'ALTER TABLE messages ADD INDEX idx_message_group (group_id, id)' },
  {
    table: 'groups',
    index: 'uk_group_no',
    ddl: 'ALTER TABLE `groups` ADD UNIQUE INDEX uk_group_no (group_no)',
  },
];

module.exports = { STATEMENTS, MIGRATIONS, INDEX_MIGRATIONS, DATABASE_OPTIONS };
