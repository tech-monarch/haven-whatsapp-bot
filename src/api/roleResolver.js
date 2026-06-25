/**
 * Role resolver — determines who is messaging the bot by their phone number.
 * Results are cached in the BotSession (via session.js).
 */

const backend = require('./backendClient');
const session  = require('../whatsapp/session');
const logger   = require('../config/logger');

/**
 * Returns the resolved user context for a phone number.
 * Checks the session cache first; falls back to the backend API.
 *
 * Returns: { role, userId, profileId, name, phone, ... } | null
 */
async function resolveUser(phoneNumber) {
  // Check session cache
  const prefs = await session.getPreferences(phoneNumber);
  if (prefs.resolvedRole && prefs.profileId) {
    return {
      role:      prefs.resolvedRole,
      userId:    prefs.userId,
      profileId: prefs.profileId,
      name:      prefs.userName,
      phone:     phoneNumber,
    };
  }

  // Call backend
  try {
    const user = await backend.resolveUser(phoneNumber);
    // Cache into session so we don't hit the backend on every message
    await session.setPreferences(phoneNumber, {
      resolvedRole: user.role,
      profileId:    user.profileId,
      userId:       user.userId,
      userName:     user.name,
    });
    return { ...user, phone: phoneNumber };
  } catch (err) {
    if (err.statusCode === 404) return null; // not registered
    logger.error('[roleResolver] Failed to resolve user:', err.message);
    return null;
  }
}

module.exports = { resolveUser };
