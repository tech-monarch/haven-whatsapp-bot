/**
 * Background Sync Queue
 *
 * Persists failed backend requests (login / register) in the database so they
 * are never lost across bot restarts, server restarts, or WhatsApp reconnects.
 *
 * Retry schedule (exponential backoff):
 *   attempt 1  → +30 s
 *   attempt 2  → +60 s
 *   attempt 3  → +120 s
 *   attempt 4  → +300 s  (5 min)
 *   attempt 5+ → +600 s  (10 min)
 *
 * The daemon (startDaemon) polls every POLL_INTERVAL_MS for due items and
 * processes them one at a time so the backend is never flooded.
 */

const logger = require('../config/logger');

// Retry schedule
const RETRY_DELAYS_MS = [
  30_000,   // 30 s
  60_000,   // 1 min
  120_000,  // 2 min
  300_000,  // 5 min
  600_000,  // 10 min
];

const POLL_INTERVAL_MS   = 15_000;
const DEFAULT_MAX_ATTEMPTS = 10;

// In-memory fallback queue (used when DB is unavailable)
const memQueue = [];

// DB layer (lazy-loaded)
let db          = null;
let dbAvailable = false;

async function getDb() {
  if (db) return db;
  try {
    db = require('../database/postgres');
    if (db.isEnabled()) dbAvailable = true;
  } catch (err) {
    logger.warn('[syncQueue] DB not available — using in-memory queue:', err.message);
  }
  return db;
}

function delayMs(attempts) {
  const idx = Math.min(attempts, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

function nextRetryAt(attempts) {
  return new Date(Date.now() + delayMs(attempts));
}

// ── Public: enqueue ────────────────────────────────────────────────────────────

async function enqueue(sessionKey, operation, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const d = await getDb();

  if (dbAvailable && d && d.isEnabled()) {
    try {
      const { rows } = await d.query(
        `INSERT INTO sync_queue
           (session_key, operation, payload, attempts, max_attempts, next_retry_at, status)
         VALUES ($1,$2,$3,0,$4,NOW(),'pending')
         RETURNING id`,
        [sessionKey, operation, JSON.stringify(payload), maxAttempts]
      );
      const id = rows[0] && rows[0].id;
      logger.info(`[syncQueue] Enqueued ${operation} for ${sessionKey} (id=${id})`);
      return id;
    } catch (err) {
      logger.warn('[syncQueue] DB enqueue failed — falling back to memory:', err.message);
    }
  }

  const item = { sessionKey, operation, payload, attempts: 0, maxAttempts, nextRetryAt: new Date() };
  memQueue.push(item);
  logger.info(`[syncQueue] Enqueued ${operation} for ${sessionKey} (in-memory)`);
  return null;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function fetchDueItems() {
  const d = await getDb();

  if (dbAvailable && d && d.isEnabled()) {
    try {
      const { rows } = await d.query(
        `SELECT * FROM sync_queue
          WHERE status = 'pending'
            AND attempts < max_attempts
            AND next_retry_at <= NOW()
          ORDER BY next_retry_at ASC
          LIMIT 10`
      );
      return rows;
    } catch (err) {
      logger.warn('[syncQueue] fetchDueItems DB error:', err.message);
    }
  }

  const now = new Date();
  return memQueue.filter(i => i.attempts < i.maxAttempts && i.nextRetryAt <= now);
}

async function markSuccess(item) {
  const d = await getDb();

  if (item.id != null && dbAvailable && d && d.isEnabled()) {
    try {
      await d.query(
        `UPDATE sync_queue SET status='done', updated_at=NOW() WHERE id=$1`,
        [item.id]
      );
      return;
    } catch (err) {
      logger.warn('[syncQueue] markSuccess DB error:', err.message);
    }
  }

  const idx = memQueue.indexOf(item);
  if (idx !== -1) memQueue.splice(idx, 1);
}

async function markFailed(item, errMsg) {
  const newAttempts = ((item.attempts) || 0) + 1;
  const maxAttempts = item.max_attempts || item.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const gaveUp      = newAttempts >= maxAttempts;
  const d           = await getDb();

  if (item.id != null && dbAvailable && d && d.isEnabled()) {
    try {
      await d.query(
        `UPDATE sync_queue
            SET attempts=$1, next_retry_at=$2, last_error=$3,
                status=$4, updated_at=NOW()
          WHERE id=$5`,
        [newAttempts, nextRetryAt(newAttempts), errMsg,
         gaveUp ? 'failed' : 'pending', item.id]
      );
    } catch (dbErr) {
      logger.warn('[syncQueue] markFailed DB error:', dbErr.message);
    }
  } else {
    item.attempts     = newAttempts;
    item.nextRetryAt  = nextRetryAt(newAttempts);
    if (gaveUp) {
      const idx = memQueue.indexOf(item);
      if (idx !== -1) memQueue.splice(idx, 1);
    }
  }

  const key = item.session_key || item.sessionKey;
  if (gaveUp) {
    logger.warn(`[syncQueue] Gave up on ${item.operation} for ${key} after ${newAttempts} attempts`);
  }
}

// ── Processor registry ─────────────────────────────────────────────────────────

const processors = {};

function registerProcessor(operation, fn) {
  processors[operation] = fn;
}

async function processItem(item) {
  const operation  = item.operation;
  const sessionKey = item.session_key || item.sessionKey;
  const payload    = typeof item.payload === 'string'
    ? JSON.parse(item.payload)
    : item.payload;

  logger.info(`[syncQueue] Processing ${operation} for ${sessionKey} (attempt ${(item.attempts || 0) + 1})`);

  const processor = processors[operation];
  if (!processor) {
    logger.warn(`[syncQueue] No processor for "${operation}" — marking done`);
    await markSuccess(item);
    return;
  }

  try {
    await processor(payload, sessionKey);
    await markSuccess(item);
    logger.info(`[syncQueue] ${operation} succeeded for ${sessionKey}`);
  } catch (err) {
    logger.warn(`[syncQueue] ${operation} failed for ${sessionKey}: ${err.message}`);
    await markFailed(item, err.message);
  }
}

// ── Daemon ─────────────────────────────────────────────────────────────────────

let daemonTimer = null;

async function runOnce() {
  const due = await fetchDueItems();
  for (const item of due) {
    await processItem(item);
  }
}

function startDaemon() {
  if (daemonTimer) return;
  logger.info(`[syncQueue] Daemon started (poll every ${POLL_INTERVAL_MS / 1000}s)`);

  async function tick() {
    try {
      await runOnce();
    } catch (err) {
      logger.error('[syncQueue] Daemon tick error:', err.message);
    } finally {
      daemonTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }

  daemonTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

function stopDaemon() {
  if (daemonTimer) {
    clearTimeout(daemonTimer);
    daemonTimer = null;
    logger.info('[syncQueue] Daemon stopped');
  }
}

async function getPendingCount() {
  const d = await getDb();
  if (dbAvailable && d && d.isEnabled()) {
    try {
      const { rows } = await d.query(
        `SELECT COUNT(*) AS cnt FROM sync_queue WHERE status='pending'`
      );
      return parseInt((rows[0] && rows[0].cnt) || '0', 10);
    } catch (_) { /* fall through */ }
  }
  return memQueue.length;
}

module.exports = {
  enqueue,
  registerProcessor,
  startDaemon,
  stopDaemon,
  runOnce,
  getPendingCount,
  _delayMs: delayMs,
};
