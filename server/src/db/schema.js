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
      join_approval TINYINT(1)     NOT NULL DEFAULT 0,
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
      role                 ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
      nickname             VARCHAR(64)     NULL,
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
      kind          ENUM('image','file','voice') NOT NULL,
      original_name VARCHAR(255)    NOT NULL,
      stored_name   VARCHAR(128)    NOT NULL,
      mime          VARCHAR(128)    NOT NULL,
      size          BIGINT UNSIGNED NOT NULL,
      created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_attachment_stored (stored_name),
      KEY idx_attachment_uploader (uploader_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Active-session management (the Web replacement for native "device list").
  // One row per browser login lineage: a refresh rotation keeps the same
  // `session_id`, so revoking the row invalidates the whole device at once.
  // `token_version` on `users` stays the instant global kill switch; this table
  // adds per-device granularity and the metadata shown in the session list.
  `CREATE TABLE IF NOT EXISTS sessions (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id      BIGINT UNSIGNED NOT NULL,
      session_id   CHAR(36)        NOT NULL,
      current_jti  CHAR(36)        NULL,
      user_agent   VARCHAR(255)    NULL,
      ip           VARCHAR(45)     NULL,
      created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked      TINYINT(1)      NOT NULL DEFAULT 0,
      revoked_at   DATETIME        NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_session_id (session_id),
      KEY idx_session_user (user_id, revoked)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Directed block list: a row means `user_id` has blocked `blocked_id`. Blocked
  // parties keep the friendship but cannot send messages or re-add.
  `CREATE TABLE IF NOT EXISTS blocks (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      blocked_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_block_pair (user_id, blocked_id),
      KEY idx_block_blocked (blocked_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Per-user, time-limited friend invite links (the Web-friendly counterpart of
  // a QR code). Possessing the token is enough to send a friend request.
  `CREATE TABLE IF NOT EXISTS friend_invite_links (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      token      CHAR(32)        NOT NULL,
      user_id    BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME        NOT NULL,
      revoked    TINYINT(1)      NOT NULL DEFAULT 0,
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_invite_token (token),
      KEY idx_invite_user (user_id, revoked)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Privacy / notification switches. One row per user, created lazily with the
  // same defaults as the code, so behaviour is identical before and after the
  // first write.
  `CREATE TABLE IF NOT EXISTS user_settings (
      user_id              BIGINT UNSIGNED NOT NULL,
      add_by_username      TINYINT(1)      NOT NULL DEFAULT 1,
      add_by_invite        TINYINT(1)      NOT NULL DEFAULT 1,
      add_by_group         TINYINT(1)      NOT NULL DEFAULT 1,
      require_verification TINYINT(1)      NOT NULL DEFAULT 1,
      notify_desktop       TINYINT(1)      NOT NULL DEFAULT 1,
      notify_sound         TINYINT(1)      NOT NULL DEFAULT 1,
      notify_preview       TINYINT(1)      NOT NULL DEFAULT 1,
      updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // User-submitted abuse reports (no audit team in a personal build, but the
  // receipt and appeal path must exist).
  `CREATE TABLE IF NOT EXISTS reports (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      reporter_id BIGINT UNSIGNED NOT NULL,
      target_type ENUM('user','group','message') NOT NULL,
      target_id   BIGINT UNSIGNED NOT NULL,
      reason      VARCHAR(32)     NOT NULL,
      detail      VARCHAR(500)    NULL,
      status      ENUM('pending','handled','rejected') NOT NULL DEFAULT 'pending',
      created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_report_status (status, id),
      KEY idx_report_reporter (reporter_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Minimal sensitive-action trail. Kept deliberately small (least privilege);
  // the retention window is documented in the privacy policy.
  `CREATE TABLE IF NOT EXISTS audit_logs (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_id    BIGINT UNSIGNED NULL,
      action      VARCHAR(64)     NOT NULL,
      target_type VARCHAR(32)     NULL,
      target_id   BIGINT UNSIGNED NULL,
      ip          VARCHAR(45)     NULL,
      meta        JSON            NULL,
      created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audit_actor (actor_id, id),
      KEY idx_audit_action (action, id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Per-user, per-conversation state: pin (置顶), mute (免打扰), and the "clear
  // history" watermark. Grouped in one row so a conversation list read is simple.
  `CREATE TABLE IF NOT EXISTS conversation_settings (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id          BIGINT UNSIGNED NOT NULL,
      peer_kind        ENUM('direct','group') NOT NULL,
      peer_id          BIGINT UNSIGNED NOT NULL,
      pinned           TINYINT(1)      NOT NULL DEFAULT 0,
      muted            TINYINT(1)      NOT NULL DEFAULT 0,
      cleared_before_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_conversation (user_id, peer_kind, peer_id),
      KEY idx_conversation_user (user_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Messages a user deleted for themselves only ("删除" is local, like WeChat).
  `CREATE TABLE IF NOT EXISTS message_hidden (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      message_id BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_hidden (user_id, message_id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Saved messages (收藏). A SNAPSHOT is stored (not just a message id) so a
  // favourite survives the original being recalled or deleted.
  `CREATE TABLE IF NOT EXISTS favorites (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id          BIGINT UNSIGNED NOT NULL,
      message_id       BIGINT UNSIGNED NULL,
      type             VARCHAR(16)     NOT NULL DEFAULT 'text',
      content          TEXT            NOT NULL,
      attachment_id    BIGINT UNSIGNED NULL,
      from_user_id     BIGINT UNSIGNED NOT NULL,
      src_conversation VARCHAR(64)     NULL,
      created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_favorite_user (user_id, id)
  ) ENGINE=InnoDB ${DATABASE_OPTIONS}`,

  // Web Push subscriptions (chapter 10). One row per browser/device; endpoint is
  // unique so re-subscribing the same device updates rather than duplicates.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      endpoint   VARCHAR(512)    NOT NULL,
      p256dh     VARCHAR(255)    NOT NULL,
      auth       VARCHAR(255)    NOT NULL,
      user_agent VARCHAR(255)    NULL,
      created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_push_endpoint (endpoint),
      KEY idx_push_user (user_id)
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
  // --- P1: account / privacy / security -------------------------------------
  { table: 'users', column: 'bio', ddl: 'ALTER TABLE users ADD COLUMN bio VARCHAR(140) NULL' },
  { table: 'users', column: 'muted_until', ddl: 'ALTER TABLE users ADD COLUMN muted_until DATETIME NULL' },
  { table: 'users', column: 'banned', ddl: 'ALTER TABLE users ADD COLUMN banned TINYINT(1) NOT NULL DEFAULT 0' },
  { table: 'users', column: 'deleted_at', ddl: 'ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL' },
  { table: 'friendships', column: 'remark', ddl: 'ALTER TABLE friendships ADD COLUMN remark VARCHAR(64) NULL' },
  {
    table: 'refresh_tokens',
    column: 'session_id',
    ddl: 'ALTER TABLE refresh_tokens ADD COLUMN session_id CHAR(36) NULL',
  },
  {
    table: 'refresh_tokens',
    column: 'replaced_by_jti',
    ddl: 'ALTER TABLE refresh_tokens ADD COLUMN replaced_by_jti CHAR(36) NULL',
  },
  {
    table: 'refresh_tokens',
    column: 'rotated_at',
    ddl: 'ALTER TABLE refresh_tokens ADD COLUMN rotated_at DATETIME(3) NULL',
  },
  // --- P2: message actions ---------------------------------------------------
  { table: 'messages', column: 'recalled_at', ddl: 'ALTER TABLE messages ADD COLUMN recalled_at DATETIME(3) NULL' },
  { table: 'messages', column: 'quote_id', ddl: 'ALTER TABLE messages ADD COLUMN quote_id BIGINT UNSIGNED NULL' },
  // --- P3: group enhancements ------------------------------------------------
  { table: 'group_members', column: 'nickname', ddl: 'ALTER TABLE group_members ADD COLUMN nickname VARCHAR(64) NULL' },
  { table: 'groups', column: 'join_approval', ddl: 'ALTER TABLE `groups` ADD COLUMN join_approval TINYINT(1) NOT NULL DEFAULT 0' },
];

/** Indexes added alongside the columns above (checked by name). */
const INDEX_MIGRATIONS = [
  { table: 'messages', index: 'idx_message_group', ddl: 'ALTER TABLE messages ADD INDEX idx_message_group (group_id, id)' },
  {
    table: 'groups',
    index: 'uk_group_no',
    ddl: 'ALTER TABLE `groups` ADD UNIQUE INDEX uk_group_no (group_no)',
  },
  {
    table: 'refresh_tokens',
    index: 'idx_refresh_session',
    ddl: 'ALTER TABLE refresh_tokens ADD INDEX idx_refresh_session (session_id)',
  },
];

/**
 * Column *type* changes that `ADD COLUMN IF NOT EXISTS` cannot express (e.g.
 * widening an ENUM). Applied only when the current definition lacks the new
 * value, so the (relatively costly) ALTER MODIFY runs at most once.
 */
const ALTERS = [
  {
    table: 'attachments',
    column: 'kind',
    contains: 'voice',
    ddl: "ALTER TABLE attachments MODIFY kind ENUM('image','file','voice') NOT NULL",
  },
  {
    table: 'group_members',
    column: 'role',
    contains: 'admin',
    ddl: "ALTER TABLE group_members MODIFY role ENUM('owner','admin','member') NOT NULL DEFAULT 'member'",
  },
];

module.exports = { STATEMENTS, MIGRATIONS, INDEX_MIGRATIONS, ALTERS, DATABASE_OPTIONS };
