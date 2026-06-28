/**
 * Message handler — entry point for every incoming WhatsApp message.
 *
 * Pipeline:
 *   1. Deduplicate
 *   2. Rate limit
 *   3. Registration state machine (non-blocking)
 *   4. Command dispatch
 *   5. AI agent
 *
 * KEY CHANGE: handleRegistration now always returns { handled, user, regContext }.
 * Even when handled=false the regContext is passed to the AI agent so Ava can
 * answer questions naturally AND gently nudge registration forward in the same reply.
 */

const { handleUserMessage }  = require('../ai/agent');
const { dispatch }           = require('../commands/registry');
const { resolveUser }        = require('../api/roleResolver');
const { handleRegistration } = require('./registration');
const logger                 = require('../config/logger');

// ── Deduplication ─────────────────────────────────────────────────────────────
const MAX_SEEN = 500;
const seenMessageIds = new Set();

function markSeen(id) {
  if (seenMessageIds.size >= MAX_SEEN) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  seenMessageIds.add(id);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 15;
const rateLimitWindows     = new Map();

function isRateLimited(sessionKey) {
  const now = Date.now();
  const w   = rateLimitWindows.get(sessionKey);
  if (!w || now - w.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(sessionKey, { count: 1, windowStart: now });
    return false;
  }
  w.count++;
  return w.count > RATE_LIMIT_MAX;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function logLabel(jid, user) {
  if (user && user.phone) return user.phone;
  if (jid.endsWith('@lid')) return `${jid} (linked-device id)`;
  return jid;
}

async function safeSendText(sock, jid, text) {
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise(r => setTimeout(r, Math.min(text.length * 12, 2500)));
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('[messageHandler] safeSendText failed:', err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleMessage(sock, msg) {
  let jid;
  try {
    jid              = msg.key.remoteJid;
    const messageId  = msg.key.id;
    const fromMe     = msg.key.fromMe;

    if (fromMe || jid === 'status@broadcast') return;

    const content =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.imageMessage?.caption ??
      null;

    if (!content || !content.trim()) return;

    // Deduplicate
    if (seenMessageIds.has(messageId)) {
      logger.debug('[messageHandler] Duplicate ignored:', messageId);
      return;
    }
    markSeen(messageId);

    const sessionKey = jid;
    const text       = content.trim();

    logger.info(`[messageHandler] Message from ${jid}: "${text.slice(0, 80)}"`);

    // Rate limit
    if (isRateLimited(sessionKey)) {
      logger.warn(`[messageHandler] Rate limit hit for ${jid}`);
      await safeSendText(sock, jid,
        `⚠️ You're sending messages too fast. Please wait a moment. 🙏`
      );
      return;
    }

    await sock.readMessages([msg.key]).catch(() => {});

    // ── Registration state machine ────────────────────────────────────────────
    // Never blocks. Returns { handled, user, regContext } always.
    const reg = await handleRegistration(sock, jid, sessionKey, text);

    if (reg.handled) {
      // Message was consumed by the registration flow (e.g. "is this your number?")
      return;
    }

    // reg.user may be null (not yet identified) or a provisional/full user object
    let user = reg.user;
    const regContext = reg.regContext;

    // If user is null, try the role resolver (checks session cache)
    if (!user) {
      user = await resolveUser(sessionKey);
    }

    logger.info(`[messageHandler] User for ${logLabel(jid, user)}: role=${user && user.role || 'unregistered'}`);

    // ── Command dispatch ──────────────────────────────────────────────────────
    const handled = await dispatch(sock, jid, sessionKey, text, user);
    if (handled) return;

    // ── AI agent ──────────────────────────────────────────────────────────────
    // Pass regContext so the AI knows the registration state and can weave
    // it naturally into conversation without trapping the user.
    const reply = await handleUserMessage(sessionKey, text, user, regContext);
    await safeSendText(sock, jid, reply);

  } catch (err) {
    logger.error('[messageHandler] Unhandled error:', err.message, err.stack);
    try {
      if (jid) {
        await sock.sendMessage(jid, {
          text: `Something went wrong on my end 🙏. Please try again in a moment.`,
        });
      }
    } catch {
      // last resort
    }
  }
}

module.exports = { handleMessage };
