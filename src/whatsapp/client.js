/**
 * WhatsApp client — Baileys socket with exponential backoff reconnect.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');
const pino         = require('pino');
const path         = require('path');
const { handleMessage } = require('./messageHandler');
const logger       = require('../config/logger');

const SESSION_DIR = path.resolve(process.cwd(), 'whatsapp-session');

// ─── Reconnect backoff state ───────────────────────────────────────────────────
const BACKOFF_MIN_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
let reconnectAttempts = 0;

function backoffMs() {
  const ms = Math.min(BACKOFF_MIN_MS * 2 ** reconnectAttempts, BACKOFF_MAX_MS);
  // Add ±20% jitter
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

// ─── Global socket reference (exported for /send endpoint) ────────────────────
let activeSock = null;

function getSock() { return activeSock; }

// ─── Connection ───────────────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Haven Bot', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    getMessage: async () => undefined, // disable store
    shouldIgnoreJid: jid => isJidBroadcast(jid),
  });

  activeSock = sock;

  // Pairing code for phone-based auth
  if (!sock.authState.creds.registered) {
    const phone = process.env.BOT_PHONE_NUMBER;
    if (phone) {
      await sock.waitForConnectionUpdate(u => !!u.qr);
      const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
      logger.info(`[client] Pairing code: ${code}`);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('[client] QR code ready — scan with WhatsApp or use pairing code');
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      logger.info('[client] ✅ Connected to WhatsApp');
    }

    if (connection === 'close') {
      const reason  = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      logger.warn(`[client] Connection closed — reason: ${reason}`);

      if (shouldReconnect) {
        reconnectAttempts++;
        const delay = backoffMs();
        logger.info(`[client] Reconnecting in ${delay}ms (attempt #${reconnectAttempts})…`);
        setTimeout(connectToWhatsApp, delay);
      } else {
        logger.error('[client] Logged out — manual re-auth required. Delete whatsapp-session/ and restart.');
        process.exit(1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Process each message in isolation — one error must not crash the loop
      handleMessage(sock, msg).catch(err =>
        logger.error('[client] handleMessage threw:', err.message)
      );
    }
  });

  return sock;
}

module.exports = { connectToWhatsApp, getSock };
