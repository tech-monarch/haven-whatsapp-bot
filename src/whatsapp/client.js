const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const logger = require('../config/logger');

const AUTH_DIR = path.join(process.cwd(), config.whatsapp.authDir);

/**
 * Starts (or restarts, on disconnect) the WhatsApp socket.
 *
 * @param {(sock) => void} onReady - called once the socket is created, with the socket instance
 * @param {(sock, msg) => void} onMessage - called for every incoming non-group message
 */
async function startWhatsApp(onReady, onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // we handle QR manually for clearer logging
    logger: silentBaileysLogger(),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('[whatsapp] Scan this QR code with WhatsApp (Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('[whatsapp] Connected successfully ✅');
      onReady?.(sock);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn(
        `[whatsapp] Connection closed (status code: ${statusCode}). ${
          loggedOut ? 'Logged out — delete auth_sessions/ and re-scan QR.' : 'Reconnecting...'
        }`
      );

      if (!loggedOut) {
        // Auto-reconnect after a short delay
        setTimeout(() => startWhatsApp(onReady, onMessage), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue; // protocol messages, reactions, etc.
        if (msg.key.fromMe) continue; // ignore our own outgoing messages

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');
        if (isGroup && config.whatsapp.ignoreGroups) continue;

        await onMessage?.(sock, msg);
      } catch (err) {
        logger.error('[whatsapp] Error handling incoming message:', err.message);
      }
    }
  });

  return sock;
}

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
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => self,
  };
  return self;
}

function extractTextFromMessage(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

module.exports = {
  startWhatsApp,
  extractTextFromMessage,
};
