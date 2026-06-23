const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const config = require('../config');
const logger = require('../config/logger');

const AUTH_DIR = path.join(process.cwd(), config.whatsapp.authDir);

// ---------------------------------------------------------------------------
// Phone-number validation
// Baileys expects digits only, no '+', no spaces, no dashes.
// Example valid value: "2349067296455"
// ---------------------------------------------------------------------------
function validatePhoneNumber(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      '[whatsapp] WA_PHONE_NUMBER is not set. ' +
      'Add it to your .env as digits only (e.g. WA_PHONE_NUMBER=2349067296455).'
    );
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error(
      `[whatsapp] WA_PHONE_NUMBER "${raw}" looks invalid. ` +
      'Use international format without +, e.g. 2349067296455.'
    );
  }
  return digits;
}

// ---------------------------------------------------------------------------
// Main connection factory
// ---------------------------------------------------------------------------

/**
 * Starts (or restarts, on disconnect) the WhatsApp socket.
 *
 * Flow:
 *  1. Load multi-file auth state from AUTH_DIR.
 *  2. Create the socket.
 *  3. If NOT already registered (first run / cleared session):
 *       → request a pairing code and print it to the terminal.
 *     If already registered:
 *       → connect normally — no pairing code needed.
 *  4. On successful connection, call onReady(sock).
 *  5. On close (non-logout), auto-reconnect after 3 s.
 *
 * @param {(sock: object) => void}              onReady   - called once connected
 * @param {(sock: object, msg: object) => void} onMessage - called for every inbound message
 */
async function startWhatsApp(onReady, onMessage) {
  // -- 1. Auth state --------------------------------------------------------
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // -- 2. Socket ------------------------------------------------------------
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // we do NOT use QR — pairing code only
    logger: silentBaileysLogger(),
  });

  sock.ev.on('creds.update', saveCreds);

  // -- 3. Pairing code (first login only) -----------------------------------
  //
  // state.creds.registered is true once Baileys has completed registration
  // (i.e. credentials already exist from a previous successful login).
  // We only request a pairing code when it is falsy.
  //
  if (!state.creds.registered) {
    // Small delay so the socket can finish its internal handshake
    // before we call requestPairingCode.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const phoneNumber = validatePhoneNumber(config.whatsapp.phoneNumber);
      logger.info(
        `[whatsapp] No existing session found. Requesting pairing code for +${phoneNumber}…`
      );

      const code = await sock.requestPairingCode(phoneNumber);

      // Print the code prominently so it's easy to spot in the terminal
      const formatted = code.match(/.{1,4}/g)?.join('-') ?? code; // e.g. ABCD-EFGH
      logger.info('');
      logger.info('╔══════════════════════════════════════╗');
      logger.info('║   WhatsApp Pairing Code               ║');
      logger.info(`║                                       ║`);
      logger.info(`║        ${formatted.padEnd(29)}║`);
      logger.info('║                                       ║');
      logger.info('║  Steps:                               ║');
      logger.info('║  1. Open WhatsApp on your phone       ║');
      logger.info('║  2. Settings → Linked Devices         ║');
      logger.info('║  3. Link a Device → "Link with phone  ║');
      logger.info('║     number instead"                   ║');
      logger.info('║  4. Enter the code above              ║');
      logger.info('╚══════════════════════════════════════╝');
      logger.info('');
    } catch (err) {
      logger.error('[whatsapp] Failed to request pairing code:', err.message);
      logger.error(
        '[whatsapp] Common causes: invalid phone number, number already linked, ' +
        'or WhatsApp rate-limited this request. ' +
        'Wait a few minutes and try again.'
      );
      // Don't crash — the socket is still alive; the user can restart.
    }
  } else {
    logger.info('[whatsapp] Existing session found — connecting without pairing code.');
  }

  // -- 4 & 5. Connection lifecycle ------------------------------------------
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      logger.info('[whatsapp] Connected successfully ✅');
      onReady?.(sock);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;

      logger.warn(
        `[whatsapp] Connection closed (status: ${statusCode}). ` +
        (loggedOut
          ? 'Logged out — delete auth_sessions/ and restart to authenticate with a new pairing code.'
          : 'Reconnecting in 3 s…')
      );

      if (!loggedOut) {
        setTimeout(() => startWhatsApp(onReady, onMessage), 3000);
      }
    }
  });

  // -- Message handler -------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue; // protocol / reaction messages
        if (msg.key.fromMe) continue; // ignore our own outgoing messages

        const remoteJid = msg.key.remoteJid || '';
        const isGroup   = remoteJid.endsWith('@g.us');
        if (isGroup && config.whatsapp.ignoreGroups) continue;

        await onMessage?.(sock, msg);
      } catch (err) {
        logger.error('[whatsapp] Error handling incoming message:', err.message);
      }
    }
  });

  return sock;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Baileys is very chatty by default; this no-op logger keeps our console clean
 * while still satisfying Baileys' expected logger interface.
 */
function silentBaileysLogger() {
  const noop = () => {};
  const self = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn:  noop,
    info:  noop,
    debug: noop,
    trace: noop,
    child: () => self,
  };
  return self;
}

/**
 * Extracts the plain-text body from any supported message type.
 */
function extractTextFromMessage(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation                  ||
    m.extendedTextMessage?.text     ||
    m.imageMessage?.caption         ||
    m.videoMessage?.caption         ||
    ''
  ).trim();
}

module.exports = {
  startWhatsApp,
  extractTextFromMessage,
};
