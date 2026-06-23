const { Pool } = require('pg');
const config = require('../config');
const logger = require('../config/logger');

let pool = null;

function isEnabled() {
  return config.database.enabled;
}

function getPool() {
  if (!isEnabled()) {
    throw new Error('Database is not configured. DATABASE_URL is missing — using mock data instead.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: config.database.url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    });

    pool.on('error', (err) => {
      logger.error('[postgres] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

/**
 * Run a parameterized query. Throws if the DB is not enabled — callers
 * (artisanService.js) are responsible for falling back to mock data.
 */
async function query(text, params = []) {
  const client = getPool();
  const start = Date.now();
  try {
    const result = await client.query(text, params);
    logger.debug(`[postgres] query executed in ${Date.now() - start}ms: ${text.slice(0, 80)}...`);
    return result;
  } catch (err) {
    logger.error('[postgres] Query failed:', err.message);
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
 * Idempotent schema setup. Safe to call on every boot.
 */
async function ensureSchema() {
  if (!isEnabled()) return;
  await query(`
    CREATE TABLE IF NOT EXISTS artisans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      category VARCHAR(100) NOT NULL,
      description TEXT,
      rating NUMERIC(2,1) DEFAULT 0,
      completed_jobs INTEGER DEFAULT 0,
      location VARCHAR(255) NOT NULL,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      available BOOLEAN DEFAULT true,
      average_response_time INTEGER, -- minutes
      price_range VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_category ON artisans (category);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_location ON artisans (location);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artisans_available ON artisans (available);`);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  isEnabled,
  getPool,
  query,
  testConnection,
  ensureSchema,
  close,
};
