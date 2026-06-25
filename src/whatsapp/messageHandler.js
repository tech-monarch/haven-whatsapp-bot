/**
 * Message handler — entry point for every incoming WhatsApp message.
 *
 * Pipeline:
 * 1. Deduplicate (ignore already-processed message IDs)
 * 2. Rate limit (per phone number)
 * 3. Resolve user role (from session cache → backend API)
 * 4. Try command dispatch (zero AI cost)
 * 5. Fall through to AI agent
 */

const { handleUserMessage } = require('../ai/agent');
const { dispatch }          = require('../commands/registry');
const { resolveUser }       = require('../api/roleResolver');
const session               = require('./session');
const logger                = require('../config/logger');

// ─── Deduplication ───────────────────────────────────────────────────────────
// Keep the last 500 processed message IDs in a bounded Set to prevent
// duplicate processing when WhatsApp re-delivers messages.
const MAX_SEEN = 500;
const seenMessageIds = new Set();

function markSeen(id) {
  if (seenMessageIds.size >= MAX_SEEN) {
    // Remove the oldest entry
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  seenMessageIds.add(id);
}

// ─── Per-phone rate limiting ──────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX       = 15;     // messages per window

const rateLimitWindows = new Map(); // phone → { count, windowStart }

function isRateLimited(phone) {
  const now = Date.now();
  const w   = rateLimitWindows.get(phone);
  if (!w || now - w.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(phone, { count: 1, windowStart: now });
    return false;
  }
  w.count++;
  if (w.count > RATE_LIMIT_MAX) return true;
  return false;
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function extractPhone(jid) {
  // JID format: 2348012345678@s.whatsapp.net
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

async function safeSendText(sock, jid, text) {
  try {
    // Typing indicator
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    // Small realistic delay
    await new Promise(r => setTimeout(r, Math.min(text.length * 12, 2500)));
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('[messageHandler] safeSendText failed:', err.message);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleMessage(sock, msg) {
  try {
    // 1. Basic extraction
    const jid         = msg.key.remoteJid;
    const messageId   = msg.key.id;
    const fromMe      = msg.key.fromMe;

    // Ignore outbound messages and status updates
    if (fromMe || jid === 'status@broadcast') return;

    const content = msg.message?.conversation
      ?? msg.message?.extendedTextMessage?.text
      ?? msg.message?.imageMessage?.caption
      ?? null;

    if (!content || !content.trim()) return;

    // 2. Deduplicate
    if (seenMessageIds.has(messageId)) {
      logger.debug('[messageHandler] Duplicate message ignored:', messageId);
      return;
    }
    markSeen(messageId);

    const phoneNumber = extractPhone(jid);
    const text        = content.trim();

    logger.info(`[messageHandler] Message from ${phoneNumber}: "${text.slice(0, 80)}"`);

    // 3. Rate limit
    if (isRateLimited(phoneNumber)) {
      logger.warn(`[messageHandler] Rate limit hit for ${phoneNumber}`);
      await safeSendText(sock, jid,
        `⚠️ You're sending messages too fast.\nPlease wait a moment before trying again. 🙏`
      );
      return;
    }

    // 4. Mark as read
    await sock.readMessages([msg.key]).catch(() => {});

    // 5. Resolve user role
    const user = await resolveUser(phoneNumber);

    // 6. Try command dispatch (no AI cost for known commands)
    const handled = await dispatch(sock, jid, phoneNumber, text, user);
    if (handled) return;

    // 7. AI agent
    const reply = await handleUserMessage(phoneNumber, text, user);
    await safeSendText(sock, jid, reply);

  } catch (err) {
    logger.error('[messageHandler] Unhandled error:', err.message, err.stack);
    try {
      const jid = msg?.key?.remoteJid;
      if (jid) {
        await sock.sendMessage(jid, {
          text: `Something went wrong on my end 🙏. Please try again in a moment.`,
        });
      }
    } catch {
      // last resort — swallow
    }
  }
}

module.exports = { handleMessage };
