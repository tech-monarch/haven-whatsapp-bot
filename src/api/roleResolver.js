/**
 * Role resolver — determines who is messaging the bot.
 *
 * Checks the session cache first. Falls back to backend /resolve-user only
 * if the user has a confirmed phone number but no profileId yet.
 *
 * Also surfaces the accessToken so the agent can make authenticated requests
 * (though currently all agent calls go through the internal API which uses
 * X-Internal-Key, not Bearer tokens).
 */

const backend = require('./backendClient');
const session  = require('../whatsapp/session');
const logger   = require('../config/logger');

async function resolveUser(sessionKey) {
  const prefs = await session.getPreferences(sessionKey);

  // Already resolved: return cached session data
  if (prefs.resolvedRole && prefs.profileId) {
    return {
      role:         prefs.resolvedRole,
      userId:       prefs.userId       || null,
      profileId:    prefs.profileId    || null,
      name:         prefs.userName     || null,
      email:        prefs.userEmail    || null,
      phone:        prefs.confirmedPhone || null,
      accessToken:  prefs.accessToken  || null,
      refreshToken: prefs.refreshToken || null,
      provisional:  false,
    };
  }

  // retry_pending / provisional: return what we have without a backend call
  if (prefs.regState === 'retry_pending' && prefs.confirmedPhone) {
    return {
      role:        prefs.resolvedRole || 'CUSTOMER',
      userId:      prefs.userId       || null,
      profileId:   prefs.profileId    || null,
      name:        prefs.userName     || null,
      email:       prefs.userEmail    || null,
      phone:       prefs.confirmedPhone,
      provisional: true,
    };
  }

  // We don't have a phone yet — can't identify the user
  const phone = prefs.confirmedPhone;
  if (!phone) return null;

  try {
    const user = await backend.resolveUser(phone);
    await session.setPreferences(sessionKey, {
      resolvedRole: user.role,
      profileId:    user.profileId,
      userId:       user.userId,
      userName:     user.name,
      userEmail:    user.email,
      regState:     'authenticated',
    });
    return { ...user, phone, provisional: false };
  } catch (err) {
    if (err.statusCode === 404) return null;
    logger.error('[roleResolver] resolveUser failed:', err.message);
    // Network error — return provisional if we have a phone
    return {
      role:        'CUSTOMER',
      userId:      null,
      profileId:   null,
      name:        prefs.userName || null,
      phone,
      provisional: true,
    };
  }
}

module.exports = { resolveUser };
