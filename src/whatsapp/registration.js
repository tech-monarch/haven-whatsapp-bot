/**
 * Registration & authentication state machine.
 *
 * ROOT CAUSES FIXED:
 *   1. Previous code called /api/v1/internal/login and /api/v1/internal/register-user
 *      — neither endpoint exists. Now calls the correct public auth endpoints.
 *   2. Sent { name } but backend requires { fullName }.
 *   3. Treated registration as a hard gate — trapped users in a loop.
 *   4. Tried to "log in" via phone+password — backend only supports email+password.
 *
 * CORRECT AUTHENTICATION FLOW (traced against backend):
 *   Phone received
 *     → POST /api/v1/internal/resolve-user { phone }
 *       200: existing user identified → state 'authenticated' (no password needed)
 *       404: new user → collect name, email, password
 *         → POST /api/v1/auth/register/customer { fullName, email, phone, password }
 *           201: success → store tokens → state 'authenticated'
 *           error: queue for retry → state 'retry_pending'
 *
 * STATE MACHINE:
 *   new               → brand new conversation, no state
 *   awaiting_phone    → asked for phone, waiting
 *   awaiting_confirm  → showed phone back, waiting YES/NO
 *   authenticating    → resolving phone with backend
 *   collecting_name   → new user: collecting full name
 *   collecting_email  → new user: collecting email
 *   collecting_password → new user: collecting password
 *   retry_pending     → backend offline; saved locally, daemon will retry
 *   authenticated     → fully onboarded (existing user or new registration)
 *
 * KEY DESIGN: registration is NEVER a hard gate.
 * The user can ask questions at any point. handleRegistration returns
 * { handled: false } whenever a message should fall through to the AI,
 * and the AI prompt includes the current registration context so Ava
 * can answer naturally and gently nudge registration forward.
 */

const backend      = require('../api/backendClient');
const session      = require('./session');
const localProfile = require('../sync/localProfile');
const syncQueue    = require('../sync/syncQueue');
const logger       = require('../config/logger');
const { normalizePhone, formatPhone, isValidEmail, isValidPassword } = require('./phoneUtils');

const MAX_BACKEND_RETRIES   = 10;
const MIN_RETRY_INTERVAL_MS = 30_000;

// ── Sync processors (registered once at module load) ──────────────────────────
//
// These run in the background daemon.
// 'register' operation: replays a failed registerCustomer call.
// On success it upgrades the session to 'authenticated'.

syncQueue.registerProcessor('register', async (payload, sessionKey) => {
  const { fullName, email, phone, password } = payload;
  const result = await backend.registerCustomer(fullName, email, phone, password);

  // result.data from backend: { user, customer, accessToken, refreshToken }
  const customer = result.customer || result.data && result.data.customer;
  const user     = result.user     || result.data && result.data.user;
  const tokens   = {
    accessToken:  result.accessToken  || result.data && result.data.accessToken,
    refreshToken: result.refreshToken || result.data && result.data.refreshToken,
  };

  await session.setPreferences(sessionKey, {
    regState:          'authenticated',
    regPendingBackend: false,
    userId:            user && user.id      || null,
    profileId:         customer && customer.id || null,
    resolvedRole:      'CUSTOMER',
    accessToken:       tokens.accessToken  || null,
    refreshToken:      tokens.refreshToken || null,
  });
  await localProfile.markSynced(sessionKey, {
    userId:    user && user.id,
    profileId: customer && customer.id,
    role:      'CUSTOMER',
  });
  logger.info(`[registration] Background register synced for ${sessionKey}`);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function safeSend(sock, jid, text) {
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise(r => setTimeout(r, Math.min(text.length * 10, 2000)));
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('[registration] safeSend failed:', err.message);
  }
}

/**
 * Build the user object returned to the message pipeline.
 * `provisional: true` means the backend hasn't confirmed the account yet.
 */
function buildUser(prefs) {
  // We need at minimum a phone number to build a user
  const phone = prefs.confirmedPhone;
  if (!phone) return null;
  return {
    role:        prefs.resolvedRole  || 'CUSTOMER',
    userId:      prefs.userId        || null,
    profileId:   prefs.profileId     || null,
    name:        prefs.userName      || null,
    email:       prefs.userEmail     || null,
    phone,
    accessToken: prefs.accessToken   || null,
    refreshToken: prefs.refreshToken || null,
    provisional: !prefs.profileId,
  };
}

/**
 * Whether a message looks like it's trying to answer the current registration
 * prompt (yes/no, a phone number, a name, etc.) vs a free-form question.
 * Used to decide whether to pass the message to the AI or handle it in the SM.
 */
function looksLikeRegistrationInput(state, text) {
  const t = text.trim().toLowerCase();
  if (state === 'awaiting_phone')   return /^[\d\s\-+()]{7,}$/.test(text.trim());
  if (state === 'awaiting_confirm') return ['yes','y','no','n'].includes(t);
  if (state === 'collecting_name')  return text.trim().length >= 2 && !text.startsWith('/');
  if (state === 'collecting_email') return text.includes('@');
  if (state === 'collecting_password') return text.trim().length >= 1;
  return false;
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * @returns {{ handled: boolean, user: object|null, regContext: object }}
 *
 * handled    = true  → message consumed by registration SM; stop pipeline
 * handled    = false → message should go to AI agent
 * user                → resolved user (may be provisional) or null
 * regContext          → registration state info for the AI system prompt
 */
async function handleRegistration(sock, jid, sessionKey, text) {
  const prefs = await session.getPreferences(sessionKey);
  const state = prefs.regState || 'new';
  const norm  = text.trim();

  // Build the registration context the AI always receives (even when handled=false)
  function regCtx(extra = {}) {
    return {
      state,
      confirmedPhone: prefs.confirmedPhone || null,
      userName: prefs.userName || null,
      userEmail: prefs.userEmail || null,
      isAuthenticated: state === 'authenticated',
      isPending: state === 'retry_pending',
      ...extra,
    };
  }

  // ── Fully authenticated: pass everything through to AI ────────────────────
  if (state === 'authenticated') {
    return { handled: false, user: buildUser(prefs), regContext: regCtx() };
  }

  // ── retry_pending: backend was offline; daemon is retrying ───────────────
  // Allow ALL messages through to AI. On each message, quietly attempt a retry
  // if enough time has passed (throttled by MIN_RETRY_INTERVAL_MS).
  if (state === 'retry_pending') {
    const now         = Date.now();
    const lastAttempt = prefs.regLastAttempt || 0;
    const attempts    = prefs.regBackendAttempts || 0;

    if (attempts < MAX_BACKEND_RETRIES && now - lastAttempt >= MIN_RETRY_INTERVAL_MS) {
      // Silent retry — don't interrupt the user
      _attemptRegistration(sessionKey, prefs).catch(err =>
        logger.warn('[registration] Silent retry failed:', err.message)
      );
    }

    // Pass to AI with provisional user — they can keep chatting
    return { handled: false, user: buildUser(prefs), regContext: regCtx() };
  }

  // ── NOT in a registration-input state: pass to AI with context ───────────
  // This is the core of "registration is not a hard gate".
  // If the message doesn't look like a direct answer to the current registration
  // prompt, let the AI handle it. The AI will answer their question AND gently
  // continue registration based on the regContext in its system prompt.
  if (state !== 'new' && !looksLikeRegistrationInput(state, norm)) {
    // Still no user yet — return null user, AI handles it
    const provisionalUser = prefs.confirmedPhone ? buildUser(prefs) : null;
    return { handled: false, user: provisionalUser, regContext: regCtx() };
  }

  // ── State machine: handle registration-specific inputs ────────────────────

  // NEW conversation
  if (state === 'new') {
    await session.setPreferences(sessionKey, { regState: 'awaiting_phone' });
    await localProfile.upsert(sessionKey, { whatsappId: jid, syncStatus: 'pending' });
    await safeSend(sock, jid,
      `👋 Welcome to *Haven*!\n\n` +
      `I connect you to trusted service providers — plumbers, electricians, cleaners, and more.\n\n` +
      `To get started, what's your phone number? (include your country code, e.g. +2348012345678)\n\n` +
      `_Feel free to ask me anything while we set things up!_`
    );
    return { handled: true, user: null, regContext: regCtx({ state: 'awaiting_phone' }) };
  }

  // AWAITING PHONE
  if (state === 'awaiting_phone') {
    const candidate = normalizePhone(norm);
    if (!candidate) {
      // Doesn't look like a phone number — let AI handle it (they may be asking a question)
      return { handled: false, user: null, regContext: regCtx() };
    }
    await session.setPreferences(sessionKey, {
      regState: 'awaiting_confirm',
      candidatePhone: candidate,
    });
    await safeSend(sock, jid,
      `Is this your number?\n\n*${formatPhone(candidate)}*\n\nReply *YES* to confirm or *NO* to re-enter.`
    );
    return { handled: true, user: null, regContext: regCtx({ state: 'awaiting_confirm' }) };
  }

  // AWAITING CONFIRMATION
  if (state === 'awaiting_confirm') {
    const answer = norm.toLowerCase();

    if (['no', 'n'].includes(answer)) {
      await session.setPreferences(sessionKey, {
        regState: 'awaiting_phone',
        candidatePhone: null,
      });
      await safeSend(sock, jid,
        `No problem — please send your correct phone number including country code. 📱`
      );
      return { handled: true, user: null, regContext: regCtx({ state: 'awaiting_phone' }) };
    }

    if (!['yes', 'y'].includes(answer)) {
      // Not yes/no — might be a question. Let AI handle.
      return { handled: false, user: null, regContext: regCtx() };
    }

    // Confirmed → resolve phone on backend
    const phone = prefs.candidatePhone;
    await session.setPreferences(sessionKey, {
      confirmedPhone: phone,
      candidatePhone: null,
      regState: 'authenticating',
    });
    await localProfile.upsert(sessionKey, { phone, syncStatus: 'pending' });
    logger.info(`[registration] Phone confirmed: ${phone}`);

    try {
      const user = await backend.resolveUser(phone);
      // Existing user found — fully authenticated via resolve
      await session.setPreferences(sessionKey, {
        regState:     'authenticated',
        resolvedRole: user.role,
        profileId:    user.profileId,
        userId:       user.userId,
        userName:     user.name,
        userEmail:    user.email,
      });
      await localProfile.markSynced(sessionKey, {
        userId: user.userId, profileId: user.profileId, role: user.role,
      });
      logger.info(`[registration] Existing user found for ${phone}`);
      await safeSend(sock, jid,
        `👋 Welcome back, *${user.name}*! You're all set.\n\n` +
        `How can I help you today? Type *menu* to see options. 🙏`
      );
      const updated = await session.getPreferences(sessionKey);
      return { handled: true, user: buildUser(updated), regContext: regCtx({ state: 'authenticated' }) };

    } catch (err) {
      if (err.statusCode === 404) {
        // New user — start registration
        logger.info(`[registration] New user for ${phone} — starting registration`);
        await session.setPreferences(sessionKey, { regState: 'collecting_name' });
        await safeSend(sock, jid,
          `I don't see a Haven account for that number yet — let's create one! 🙏\n\n*What's your full name?*`
        );
        return { handled: true, user: null, regContext: regCtx({ state: 'collecting_name' }) };
      }

      if (!err.statusCode) {
        // Network error — enter pending state, let them keep chatting
        logger.warn(`[registration] Backend offline resolving ${phone}: ${err.message}`);
        await session.setPreferences(sessionKey, {
          regState:           'retry_pending',
          regPendingBackend:  true,
          regBackendAttempts: 0,
          regLastAttempt:     0,
          resolvedRole:       'CUSTOMER',
        });
        await syncQueue.enqueue(sessionKey, 'resolve', { phone });
        await safeSend(sock, jid,
          `I'm having a little trouble reaching the server right now, but you're all good! ` +
          `I'll verify your account automatically once connectivity is restored. ` +
          `You can keep chatting in the meantime. 🙏`
        );
        return {
          handled: true,
          user: { role: 'CUSTOMER', userId: null, profileId: null, name: null, phone, provisional: true },
          regContext: regCtx({ state: 'retry_pending' }),
        };
      }

      // Any other error (403 suspended, 500, etc.)
      logger.error(`[registration] resolveUser error for ${phone}:`, err.message);
      await session.setPreferences(sessionKey, { regState: 'awaiting_phone', confirmedPhone: null });
      await safeSend(sock, jid,
        `Something went wrong verifying that number. Could you try again? 🙏`
      );
      return { handled: true, user: null, regContext: regCtx({ state: 'awaiting_phone' }) };
    }
  }

  // COLLECTING NAME
  if (state === 'collecting_name') {
    if (norm.length < 2) {
      return { handled: false, user: null, regContext: regCtx() };
    }
    const displayName = norm
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    await session.setPreferences(sessionKey, {
      regState: 'collecting_email',
      userName: displayName,
    });
    await localProfile.upsert(sessionKey, { name: displayName });
    await safeSend(sock, jid, `Nice to meet you, *${displayName}*! 😊 What's your *email address*? 📧`);
    return { handled: true, user: null, regContext: regCtx({ state: 'collecting_email', userName: displayName }) };
  }

  // COLLECTING EMAIL
  if (state === 'collecting_email') {
    if (!isValidEmail(norm)) {
      return { handled: false, user: null, regContext: regCtx() };
    }
    await session.setPreferences(sessionKey, {
      regState:  'collecting_password',
      userEmail: norm.toLowerCase(),
    });
    await safeSend(sock, jid,
      `Got it! Now choose a *password* for your Haven account — at least 6 characters. 🔒`
    );
    return { handled: true, user: null, regContext: regCtx({ state: 'collecting_password' }) };
  }

  // COLLECTING PASSWORD (final step)
  if (state === 'collecting_password') {
    if (!isValidPassword(norm)) {
      await safeSend(sock, jid,
        `Password needs to be at least 6 characters. Try again — keep it something you'll remember! 🔒`
      );
      return { handled: true, user: null, regContext: regCtx() };
    }

    const { confirmedPhone: phone, userName: fullName, userEmail: email } = prefs;

    // Save locally first — user is never blocked
    await session.setPreferences(sessionKey, {
      regState:           'retry_pending',
      regPendingBackend:  true,
      regBackendAttempts: 0,
      regLastAttempt:     0,
      regPassword:        norm,  // kept only until backend confirms (then cleared)
      resolvedRole:       'CUSTOMER',
    });
    await localProfile.upsert(sessionKey, {
      phone, name: fullName, email,
      authStatus: 'pending',
      regStatus:  'pending',
      syncStatus: 'pending',
      role:       'CUSTOMER',
    });

    await safeSend(sock, jid, `⏳ Almost done, *${fullName}*! Creating your account…`);

    const result = await _attemptRegistration(sessionKey, {
      ...prefs,
      regBackendAttempts: 0,
      regLastAttempt:     0,
      regPassword:        norm,
    });

    if (result) {
      await safeSend(sock, jid,
        `🎉 Welcome to Haven, *${fullName}*!\n\n` +
        `📱 Phone: ${formatPhone(phone)}\n` +
        `📧 Email: ${email}\n\n` +
        `How can I help you? Tell me what service you need or type *menu* to explore. 🙏`
      );
      const updated = await session.getPreferences(sessionKey);
      return { handled: true, user: buildUser(updated), regContext: regCtx({ state: 'authenticated' }) };
    }

    // Backend offline — continue seamlessly
    await safeSend(sock, jid,
      `Welcome to Haven, *${fullName}*! 🎉\n\n` +
      `The server is a bit slow right now but your details are safely saved. ` +
      `I'll finish setting up your account automatically — you can keep chatting! 🙏\n\n` +
      `What can I help you with?`
    );
    return {
      handled: true,
      user: { role: 'CUSTOMER', userId: null, profileId: null, name: fullName, phone, email, provisional: true },
      regContext: regCtx({ state: 'retry_pending' }),
    };
  }

  // Fallthrough — should never happen, but let AI handle it
  return { handled: false, user: prefs.confirmedPhone ? buildUser(prefs) : null, regContext: regCtx() };
}

// ── Internal: attempt backend registration ────────────────────────────────────

/**
 * Called inline and by the daemon.
 * Returns the result object on success, null on failure.
 * On failure, queues for daemon retry if not already queued.
 */
async function _attemptRegistration(sessionKey, prefs) {
  const attempts = ((prefs.regBackendAttempts) || 0) + 1;
  const { confirmedPhone: phone, userName: fullName, userEmail: email, regPassword: password } = prefs;

  logger.info(`[registration] Register attempt ${attempts}/${MAX_BACKEND_RETRIES} for ${phone}`);

  try {
    // POST /api/v1/auth/register/customer { fullName, email, phone, password }
    const result = await backend.registerCustomer(fullName, email, phone, password);

    // Extract from backend response: { success, data: { user, customer, accessToken, refreshToken } }
    const customer = result.customer || null;
    const user     = result.user     || null;

    await session.setPreferences(sessionKey, {
      regState:           'authenticated',
      regPendingBackend:  false,
      regBackendAttempts: attempts,
      regLastAttempt:     Date.now(),
      regPassword:        undefined,  // clear stored password
      userId:             user     && user.id      || null,
      profileId:          customer && customer.id  || null,
      resolvedRole:       'CUSTOMER',
      accessToken:        result.accessToken  || null,
      refreshToken:       result.refreshToken || null,
    });
    await localProfile.markSynced(sessionKey, {
      userId:    user     && user.id,
      profileId: customer && customer.id,
      role:      'CUSTOMER',
    });

    logger.info(`[registration] Registration confirmed for ${phone} (attempt ${attempts})`);
    return result;
  } catch (err) {
    const gaveUp = attempts >= MAX_BACKEND_RETRIES;
    await session.setPreferences(sessionKey, {
      regPendingBackend:  !gaveUp,
      regBackendAttempts: attempts,
      regLastAttempt:     Date.now(),
    });

    if (!gaveUp) {
      // Queue for daemon retry (idempotent — daemon deduplicates by checking status)
      await syncQueue.enqueue(sessionKey, 'register', {
        fullName, email, phone, password,
      });
    }

    logger.warn(
      `[registration] Attempt ${attempts} failed for ${phone}: ${err.message}` +
      (gaveUp ? ' — gave up' : ' — queued for retry')
    );
    return null;
  }
}

// ── Also register a 'resolve' processor for the offline-login-attempt queue ──
syncQueue.registerProcessor('resolve', async (payload, sessionKey) => {
  const { phone } = payload;
  try {
    const user = await backend.resolveUser(phone);
    await session.setPreferences(sessionKey, {
      regState:     'authenticated',
      resolvedRole: user.role,
      profileId:    user.profileId,
      userId:       user.userId,
      userName:     user.name,
      userEmail:    user.email,
    });
    await localProfile.markSynced(sessionKey, {
      userId: user.userId, profileId: user.profileId, role: user.role,
    });
    logger.info(`[registration] Background resolve succeeded for ${phone}`);
  } catch (err) {
    if (err.statusCode === 404) {
      // Backend now says they're new — switch to registration
      await session.setPreferences(sessionKey, { regState: 'collecting_name' });
      logger.info(`[registration] Resolve found new user, switching to registration for ${phone}`);
      return; // don't throw — considered success (no more retries)
    }
    throw err; // re-throw so queue retries
  }
});

async function getStoredPassword(sessionKey) {
  const prefs = await session.getPreferences(sessionKey);
  return prefs.regPassword || null;
}

module.exports = {
  handleRegistration,
  getStoredPassword,
  _attemptRegistration,
};
