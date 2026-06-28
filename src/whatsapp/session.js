/**
 * Session store — PostgreSQL-backed with in-memory fallback.
 *
 * Changes from the previous version:
 *  - MAX_MESSAGES raised to 50 (supports richer AI context window)
 *  - appendMessage now returns the session snapshot
 *  - getRecentMessages supports arbitrary count (default 20 for AI)
 *  - All public methods are unchanged so callers need no updates
 */

const logger = require('../config/logger');

// Messages kept in memory / per-session (raised from 20 to 50)
const MAX_MESSAGES = 50;

const memoryStore = new Map();

function getMemory(phoneNumber) {
  if (!memoryStore.has(phoneNumber)) {
    memoryStore.set(phoneNumber, { messages: [], preferences: {} });
  }
  return memoryStore.get(phoneNumber);
}

// DB layer (lazy-loaded to avoid circular imports)
let db          = null;
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
    db          = null;
    dbAvailable = false;
  }
  return db;
}

async function dbGet(phoneNumber) {
  const d = await getDb();
  if (!dbAvailable || !d) return null;
  try {
    const { rows } = await d.query(
      'SELECT messages, preferences FROM bot_sessions WHERE phone_number = $1',
      [phoneNumber]
    );
    return rows[0] || null;
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

// ── Public interface ───────────────────────────────────────────────────────────

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

  // Trim to MAX_MESSAGES, keeping the most recent
  if (sess.messages.length > MAX_MESSAGES) {
    sess.messages.splice(0, sess.messages.length - MAX_MESSAGES);
  }

  if (dbAvailable) {
    await dbSave(phoneNumber, sess.messages, sess.preferences);
  } else {
    const mem = getMemory(phoneNumber);
    mem.messages = sess.messages;
  }
  return sess;
}

async function getRecentMessages(phoneNumber, count = 20) {
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
  return sess.preferences || {};
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
  return prefs.lastShownProviders || [];
}

// Legacy aliases
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
  setLastShownArtisans,
  getLastShownArtisans,
};
