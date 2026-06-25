/**
 * Session store — PostgreSQL-backed via the BotSession Prisma model.
 * Falls back to in-memory if DB is unavailable (e.g. dev without DB).
 *
 * The interface is async throughout so the caller never needs to know
 * whether it's hitting the DB or an in-memory Map.
 */

const logger = require('../config/logger');

// ─── In-memory fallback ───────────────────────────────────────────────────────
const MAX_IN_MEMORY = 20;
const memoryStore = new Map();

function getMemory(phoneNumber) {
  if (!memoryStore.has(phoneNumber)) {
    memoryStore.set(phoneNumber, { messages: [], preferences: {} });
  }
  return memoryStore.get(phoneNumber);
}

// ─── DB layer (lazy-loaded to avoid circular imports) ─────────────────────────
let db = null;
let dbAvailable = false;

async function getDb() {
  if (db) return db;
  try {
    db = require('../database/postgres');
    await db.ensureBotSchema();
    dbAvailable = true;
    logger.info('[session] Using PostgreSQL-backed sessions');
  } catch (err) {
    logger.warn('[session] DB unavailable — using in-memory sessions:', err.message);
    db = null;
    dbAvailable = false;
  }
  return db;
}

// ─── Internal DB helpers ──────────────────────────────────────────────────────

async function dbGet(phoneNumber) {
  const d = await getDb();
  if (!dbAvailable || !d) return null;
  try {
    const { rows } = await d.query(
      'SELECT messages, preferences FROM bot_sessions WHERE phone_number = $1',
      [phoneNumber]
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn('[session] dbGet failed:', err.message);
    return null;
  }
}

async function dbSave(phoneNumber, messages, preferences) {
  const d = await getDb();
  if (!dbAvailable || !d) return;
  try {
    await d.query(
      `INSERT INTO bot_sessions (phone_number, messages, preferences, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone_number)
       DO UPDATE SET messages = $2, preferences = $3, updated_at = NOW()`,
      [phoneNumber, JSON.stringify(messages), JSON.stringify(preferences)]
    );
  } catch (err) {
    logger.warn('[session] dbSave failed:', err.message);
  }
}

async function dbDelete(phoneNumber) {
  const d = await getDb();
  if (!dbAvailable || !d) return;
  try {
    await d.query('DELETE FROM bot_sessions WHERE phone_number = $1', [phoneNumber]);
  } catch (err) {
    logger.warn('[session] dbDelete failed:', err.message);
  }
}

// ─── Public interface ─────────────────────────────────────────────────────────

async function getSession(phoneNumber) {
  const row = await dbGet(phoneNumber);
  if (row) {
    return {
      messages:    Array.isArray(row.messages)    ? row.messages    : [],
      preferences: typeof row.preferences === 'object' ? row.preferences : {},
    };
  }
  return getMemory(phoneNumber);
}

async function appendMessage(phoneNumber, role, text) {
  const sess = await getSession(phoneNumber);
  sess.messages.push({ role, text, at: new Date().toISOString() });
  if (sess.messages.length > MAX_IN_MEMORY) {
    sess.messages.splice(0, sess.messages.length - MAX_IN_MEMORY);
  }

  if (dbAvailable) {
    await dbSave(phoneNumber, sess.messages, sess.preferences);
  } else {
    const mem = getMemory(phoneNumber);
    mem.messages = sess.messages;
  }
  return sess;
}

async function getRecentMessages(phoneNumber, count = 6) {
  const sess = await getSession(phoneNumber);
  return sess.messages.slice(-count);
}

async function setPreferences(phoneNumber, partialPrefs) {
  const sess = await getSession(phoneNumber);
  const merged = { ...sess.preferences, ...partialPrefs };

  if (dbAvailable) {
    await dbSave(phoneNumber, sess.messages, merged);
  } else {
    const mem = getMemory(phoneNumber);
    mem.preferences = merged;
  }
  return merged;
}

async function getPreferences(phoneNumber) {
  const sess = await getSession(phoneNumber);
  return sess.preferences ?? {};
}

async function clearSession(phoneNumber) {
  memoryStore.delete(phoneNumber);
  await dbDelete(phoneNumber);
}

async function setLastShownProviders(phoneNumber, providers) {
  await setPreferences(phoneNumber, { lastShownProviders: providers.slice(0, 5) });
}

async function getLastShownProviders(phoneNumber) {
  const prefs = await getPreferences(phoneNumber);
  return prefs.lastShownProviders ?? [];
}

// Legacy alias for old artisan code still in use
async function setLastShownArtisans(phoneNumber, artisans) {
  return setLastShownProviders(phoneNumber, artisans);
}
async function getLastShownArtisans(phoneNumber) {
  return getLastShownProviders(phoneNumber);
}

module.exports = {
  getSession,
  appendMessage,
  getRecentMessages,
  setPreferences,
  getPreferences,
  clearSession,
  setLastShownProviders,
  getLastShownProviders,
  // Legacy
  setLastShownArtisans,
  getLastShownArtisans,
};
