/**
 * PostgreSQL pool + schema bootstrap.
 *
 * ROOT CAUSE OF MISSING sync_queue TABLE:
 *   The ensureSchema() call happens asynchronously on session.js's first getDb()
 *   call, but syncQueue.js may try to INSERT into sync_queue before that has run.
 *   FIX: ensureSchema() is now called explicitly from index.js at startup, before
 *   the sync daemon and WhatsApp client start. The schema function is idempotent
 *   (CREATE TABLE IF NOT EXISTS) so calling it multiple times is safe.
 *
 * STARTUP ORDER (enforced by index.js):
 *   1. ensureSchema()          ← tables guaranteed to exist
 *   2. syncQueue.startDaemon() ← safe to use sync_queue
 *   3. connectToWhatsApp()     ← safe to use bot_sessions
 */

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../config/logger');

let pool = null;

function isEnabled() {
  return !!config.database.enabled;
}

function getPool() {
  if (!isEnabled()) {
    throw new Error('Database is not configured. DATABASE_URL is missing.');
  }
  if (!pool) {
    const url = config.database.url;
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: (
        url.includes('sslmode=require') ||
        url.includes('railway.app') ||
        url.includes('render.com') ||
        url.includes('supabase')
      ) ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err) => {
      logger.error('[postgres] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    logger.debug(`[postgres] ${Date.now() - start}ms: ${text.slice(0, 80)}`);
    return result;
  } catch (err) {
    logger.error('[postgres] Query failed:', err.message, '\nSQL:', text.slice(0, 200));
    throw err;
  }
}

async function testConnection() {
  if (!isEnabled()) return false;
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    logger.error('[postgres] Connection test failed:', err.message);
    return false;
  }
}

/**
 * Idempotent schema bootstrap.
 * MUST be called before any other DB operation (enforced by index.js startup order).
 */
async function ensureSchema() {
  if (!isEnabled()) {
    logger.warn('[postgres] DB not configured — skipping schema setup (in-memory mode)');
    return;
  }

  // ── Artisan search table ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS artisans (
      id                    SERIAL PRIMARY KEY,
      name                  VARCHAR(255) NOT NULL,
      phone                 VARCHAR(50)  NOT NULL,
      category              VARCHAR(100) NOT NULL,
      description           TEXT,
      rating                NUMERIC(2,1) DEFAULT 0,
      completed_jobs        INTEGER      DEFAULT 0,
      location              VARCHAR(255) NOT NULL,
      latitude              DOUBLE PRECISION,
      longitude             DOUBLE PRECISION,
      available             BOOLEAN      DEFAULT true,
      average_response_time INTEGER,
      price_range           VARCHAR(100),
      created_at            TIMESTAMP    DEFAULT NOW(),
      updated_at            TIMESTAMP    DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_category  ON artisans (category);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_location  ON artisans (location);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_available ON artisans (available);`);

  // ── Bot sessions ──────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      phone_number VARCHAR(30)  PRIMARY KEY,
      messages     JSONB        NOT NULL DEFAULT '[]',
      preferences  JSONB        NOT NULL DEFAULT '{}',
      created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated ON bot_sessions (updated_at);`);

  // ── Local user profiles (pre-sync) ────────────────────────────────────────
  // conversation_history and preferences are NOT NULL with defaults.
  // Never pass NULL for these columns — use '[]' and '{}' respectively.
  await query(`
    CREATE TABLE IF NOT EXISTS local_user_profiles (
      session_key          VARCHAR(100) PRIMARY KEY,
      whatsapp_id          VARCHAR(100) NOT NULL,
      phone                VARCHAR(30),
      name                 VARCHAR(255),
      email                VARCHAR(255),
      auth_status          VARCHAR(30)  NOT NULL DEFAULT 'pending',
      reg_status           VARCHAR(30)  NOT NULL DEFAULT 'pending',
      sync_status          VARCHAR(30)  NOT NULL DEFAULT 'pending',
      backend_user_id      VARCHAR(100),
      backend_profile_id   VARCHAR(100),
      role                 VARCHAR(30)           DEFAULT 'CUSTOMER',
      conversation_history JSONB        NOT NULL DEFAULT '[]',
      preferences          JSONB        NOT NULL DEFAULT '{}',
      created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMP    NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_local_profiles_phone ON local_user_profiles (phone);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_local_profiles_sync  ON local_user_profiles (sync_status);`);

  // ── Background sync queue ─────────────────────────────────────────────────
  // This table MUST exist before syncQueue.startDaemon() is called.
  await query(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id            SERIAL      PRIMARY KEY,
      session_key   VARCHAR(100) NOT NULL,
      operation     VARCHAR(30)  NOT NULL,
      payload       JSONB        NOT NULL DEFAULT '{}',
      attempts      INTEGER      NOT NULL DEFAULT 0,
      max_attempts  INTEGER      NOT NULL DEFAULT 10,
      next_retry_at TIMESTAMP    NOT NULL DEFAULT NOW(),
      last_error    TEXT,
      status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sync_queue_status     ON sync_queue (status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sync_queue_retry      ON sync_queue (next_retry_at) WHERE status = 'pending';`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sync_queue_session    ON sync_queue (session_key);`);

  logger.info('[postgres] Schema verified/created successfully.');
}

// Alias for legacy callers (session.js)
const ensureBotSchema = ensureSchema;

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('[postgres] Pool closed.');
  }
}

module.exports = {
  isEnabled,
  getPool,
  query,
  testConnection,
  ensureSchema,
  ensureBotSchema,
  close,
};
