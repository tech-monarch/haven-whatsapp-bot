/**
 * Local User Profile Store
 *
 * ROOT CAUSE OF NOT NULL VIOLATION:
 *   The upsert passed NULL for conversation_history when fields.conversationHistory
 *   was undefined. PostgreSQL: an explicit NULL in INSERT overrides the column DEFAULT.
 *   The column is defined NOT NULL DEFAULT '[]', so NULL → constraint violation.
 *
 * FIX: always pass '[]' (or the stringified array) — never pass null for JSONB
 * NOT NULL columns. Same fix applied to `preferences`.
 */

const logger = require('../config/logger');

const memProfiles = new Map();

let db          = null;
let dbAvailable = false;

async function getDb() {
  if (db) return db;
  try {
    db = require('../database/postgres');
    if (db.isEnabled()) dbAvailable = true;
  } catch (err) {
    logger.warn('[localProfile] DB not available — using in-memory profiles:', err.message);
  }
  return db;
}

async function upsert(sessionKey, fields) {
  const d = await getDb();

  // Safely stringify JSON columns — never pass null for NOT NULL JSONB columns
  const conversationHistory = fields.conversationHistory
    ? JSON.stringify(fields.conversationHistory)
    : '[]';                                          // ← was: null (caused violation)
  const preferences = fields.preferences
    ? JSON.stringify(fields.preferences)
    : '{}';

  if (dbAvailable && d && d.isEnabled()) {
    try {
      await d.query(
        `INSERT INTO local_user_profiles
           (session_key, whatsapp_id, phone, name, email,
            auth_status, reg_status, sync_status,
            backend_user_id, backend_profile_id, role,
            conversation_history, preferences, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (session_key) DO UPDATE SET
           whatsapp_id        = COALESCE(EXCLUDED.whatsapp_id,        local_user_profiles.whatsapp_id),
           phone              = COALESCE(EXCLUDED.phone,              local_user_profiles.phone),
           name               = COALESCE(EXCLUDED.name,               local_user_profiles.name),
           email              = COALESCE(EXCLUDED.email,              local_user_profiles.email),
           auth_status        = COALESCE(EXCLUDED.auth_status,        local_user_profiles.auth_status),
           reg_status         = COALESCE(EXCLUDED.reg_status,         local_user_profiles.reg_status),
           sync_status        = COALESCE(EXCLUDED.sync_status,        local_user_profiles.sync_status),
           backend_user_id    = COALESCE(EXCLUDED.backend_user_id,    local_user_profiles.backend_user_id),
           backend_profile_id = COALESCE(EXCLUDED.backend_profile_id, local_user_profiles.backend_profile_id),
           role               = COALESCE(EXCLUDED.role,               local_user_profiles.role),
           conversation_history = EXCLUDED.conversation_history,
           preferences          = EXCLUDED.preferences,
           updated_at           = NOW()`,
        [
          sessionKey,
          fields.whatsappId       || sessionKey,
          fields.phone            || null,
          fields.name             || null,
          fields.email            || null,
          fields.authStatus       || 'pending',
          fields.regStatus        || 'pending',
          fields.syncStatus       || 'pending',
          fields.backendUserId    || null,
          fields.backendProfileId || null,
          fields.role             || 'CUSTOMER',
          conversationHistory,   // always a valid JSON string, never null
          preferences,           // always a valid JSON string, never null
        ]
      );
      return;
    } catch (err) {
      logger.warn('[localProfile] DB upsert failed — using memory:', err.message);
    }
  }

  // Memory fallback
  const existing = memProfiles.get(sessionKey) || {
    sessionKey,
    whatsappId:          sessionKey,
    authStatus:          'pending',
    regStatus:           'pending',
    syncStatus:          'pending',
    role:                'CUSTOMER',
    conversationHistory: [],
    preferences:         {},
    createdAt:           new Date(),
  };
  memProfiles.set(sessionKey, { ...existing, ...fields, updatedAt: new Date() });
}

async function get(sessionKey) {
  const d = await getDb();

  if (dbAvailable && d && d.isEnabled()) {
    try {
      const { rows } = await d.query(
        `SELECT * FROM local_user_profiles WHERE session_key=$1`,
        [sessionKey]
      );
      if (rows.length) {
        const r = rows[0];
        return {
          sessionKey:          r.session_key,
          whatsappId:          r.whatsapp_id,
          phone:               r.phone,
          name:                r.name,
          email:               r.email,
          authStatus:          r.auth_status,
          regStatus:           r.reg_status,
          syncStatus:          r.sync_status,
          backendUserId:       r.backend_user_id,
          backendProfileId:    r.backend_profile_id,
          role:                r.role,
          conversationHistory: Array.isArray(r.conversation_history) ? r.conversation_history : [],
          preferences:         r.preferences || {},
          createdAt:           r.created_at,
          updatedAt:           r.updated_at,
        };
      }
    } catch (err) {
      logger.warn('[localProfile] DB get failed — checking memory:', err.message);
    }
  }

  return memProfiles.get(sessionKey) || null;
}

async function markSynced(sessionKey, backendData) {
  await upsert(sessionKey, {
    syncStatus:         'synced',
    authStatus:         'authenticated',
    regStatus:          'registered',
    backendUserId:      backendData.userId    || backendData.id || null,
    backendProfileId:   backendData.profileId || backendData.id || null,
    role:               backendData.role      || 'CUSTOMER',
  });
  logger.info(`[localProfile] Profile synced for ${sessionKey}`);
}

async function mergeConversationHistory(sessionKey, newMessages) {
  const profile = await get(sessionKey);
  if (!profile) return;
  const merged = [...(profile.conversationHistory || []), ...newMessages];
  await upsert(sessionKey, { conversationHistory: merged });
}

async function getPendingProfiles() {
  const d = await getDb();
  if (dbAvailable && d && d.isEnabled()) {
    try {
      const { rows } = await d.query(
        `SELECT * FROM local_user_profiles WHERE sync_status='pending'`
      );
      return rows.map(r => ({
        sessionKey:       r.session_key,
        whatsappId:       r.whatsapp_id,
        phone:            r.phone,
        name:             r.name,
        email:            r.email,
        syncStatus:       r.sync_status,
        backendProfileId: r.backend_profile_id,
      }));
    } catch (err) {
      logger.warn('[localProfile] getPendingProfiles DB error:', err.message);
    }
  }
  return Array.from(memProfiles.values()).filter(p => p.syncStatus === 'pending');
}

module.exports = { upsert, get, markSynced, mergeConversationHistory, getPendingProfiles };
