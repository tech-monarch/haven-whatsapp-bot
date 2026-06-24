const { extractTextFromMessage } = require('./client');
const agent = require('../ai/agent');
const session = require('./session');
const artisanService = require('../artisans/artisanService');
const logger = require('../config/logger');

const TYPING_DELAY_MS   = 600;
const MAX_MESSAGE_LENGTH = 2000;

// --------------------------------------------------------------------------
// Rate limiting — sliding window per user
// Max 12 messages per 60 seconds. Warn the user at 10.
// ---------------------------------------------------------------------------
const rateLimitWindows = new Map(); // phoneNumber -> timestamp[]
const RATE_LIMIT_MAX     = 12;
const RATE_LIMIT_WARN_AT = 10;
const RATE_LIMIT_WINDOW  = 60_000; // 1 minute

/**
 * Returns 'ok' | 'warn' | 'block'
 */
function checkRateLimit(phoneNumber) {
  const now = Date.now();
  const prev = (rateLimitWindows.get(phoneNumber) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  prev.push(now);
  rateLimitWindows.set(phoneNumber, prev);

  if (prev.length > RATE_LIMIT_MAX)  return 'block';
  if (prev.length >= RATE_LIMIT_WARN_AT) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Commands — handled before the AI pipeline (no Gemini call)
// ---------------------------------------------------------------------------

const COMMANDS = {
  '/help': async (sock, jid) => {
    await safeSend(sock, jid,
      `*Haven Bot — Help* 🛠️\n\n` +
      `Just tell me what you need and where:\n` +
      `_"I need a plumber in Lekki"_\n` +
      `_"Find an electrician near Wuse 2 urgently"_\n\n` +
      `*Other commands:*\n` +
      `/services — see all available categories\n` +
      `/reset — start the conversation over\n` +
      `/help — show this message`
    );
  },

  '/services': async (sock, jid) => {
    try {
      const categories = await artisanService.listCategories();
      const list = categories.map(c => `• ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n');
      await safeSend(sock, jid,
        `*Available services* 🔧\n\n${list}\n\n` +
        `Just tell me which one you need and your area!`
      );
    } catch (err) {
      await safeSend(sock, jid, 'Sorry, I couldn\'t load the service list right now. Try again in a moment.');
    }
  },

  '/reset': async (sock, jid, phoneNumber) => {
    session.clearSession(phoneNumber);
    await safeSend(sock, jid,
      `Conversation reset ✅\n\nFresh start! What service do you need, and which area are you in?`
    );
  },

  'start over': async (sock, jid, phoneNumber) => {
    session.clearSession(phoneNumber);
    await safeSend(sock, jid,
      `No problem — let's start over! What service do you need, and which area are you in?`
    );
  },
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleIncomingMessage(sock, msg) {
  const remoteJid   = msg.key.remoteJid;
  const phoneNumber = remoteJid?.split('@')[0];

  if (!phoneNumber) {
    logger.warn('[messageHandler] Could not determine sender phone number, skipping.');
    return;
  }

  // Mark as read so the user sees the double blue tick
  try {
    await sock.readMessages([msg.key]);
  } catch (_) {
    // Non-critical — don't crash if this fails
  }

  const text = extractTextFromMessage(msg);

  if (!text) {
    await safeSend(
      sock, remoteJid,
      "I can only read text messages for now 🙏 — please describe what service you need in words.\n\n_Type /help to see what I can do._"
    );
    return;
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    await safeSend(sock, remoteJid, 'That message is a bit long — could you summarize what you need?');
    return;
  }

  // -- Rate limiting --------------------------------------------------------
  const rateStatus = checkRateLimit(phoneNumber);
  if (rateStatus === 'block') {
    await safeSend(
      sock, remoteJid,
      "You're sending messages very quickly 😅. Please wait a minute and try again."
    );
    return;
  }
  if (rateStatus === 'warn') {
    // Don't block — just slip a note into the reply later; handled below
    logger.warn(`[messageHandler] User ${phoneNumber} approaching rate limit`);
  }

  // -- Command detection ----------------------------------------------------
  const normalizedText = text.trim().toLowerCase();
  for (const [trigger, handler] of Object.entries(COMMANDS)) {
    if (normalizedText === trigger || normalizedText.startsWith(trigger + ' ')) {
      await handler(sock, remoteJid, phoneNumber);
      return;
    }
  }

  // -- AI pipeline ----------------------------------------------------------
  try {
    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    const reply = await agent.handleUserMessage(phoneNumber, text);

    await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));

    // Append rate-limit warning if approaching limit
    const finalReply = rateStatus === 'warn'
      ? reply + '\n\n_Note: you\'re sending messages quite fast — please slow down a little._'
      : reply;

    await safeSend(sock, remoteJid, finalReply);
  } catch (err) {
    logger.error(`[messageHandler] Failed to process message from ${phoneNumber}:`, err.message);
    await safeSend(
      sock, remoteJid,
      'Something went wrong on my end 😕. Please try again in a moment.'
    );
  }
}

async function safeSend(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error(`[messageHandler] Failed to send message to ${jid}:`, err.message);
  }
}

module.exports = { handleIncomingMessage };
