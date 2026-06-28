/**
 * WhatsApp client — Baileys v7, phone-number pairing only.
 *
 * KEY TIMING FIX:
 *   requestPairingCode() must NOT be called on the first connection.update
 *   (which fires at 'connecting' — WebSocket opened but not yet authenticated).
 *   It must be called after Baileys' internal WebSocket is fully open at the
 *   protocol level.  The correct signal in v7 is waiting for the socket's
 *   internal 'open' event on sock.ws, or a short debounced delay after
 *   the first connection.update with connection === 'connecting'.
 *
 *   Calling it too early → "Connection Closed" / 401 immediately.
 *
 * BAILEYS v7 ev.once FIX:
 *   sock.ev.once does not exist. Use evOnce() helper (ev.on + ev.off).
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

const pino   = require('pino');
const path   = require('path');
const fs     = require('fs');

const { handleMessage } = require('./messageHandler');
const logger            = require('../config/logger');

// ─── Session directory ────────────────────────────────────────────────────────
const SESSION_DIR = path.resolve(
  process.cwd(),
  (process.env.SESSION_PATH || 'whatsapp-session').replace(/^\.\//, ''),
);

// ─── Reconnect state ──────────────────────────────────────────────────────────
const BACKOFF_MIN_MS  = 3_000;
const BACKOFF_MAX_MS  = 60_000;
const MAX_RECONNECTS  = 20;

let reconnectAttempts = 0;
let isConnected       = false;

function backoffMs() {
  const ms = Math.min(BACKOFF_MIN_MS * 2 ** reconnectAttempts, BACKOFF_MAX_MS);
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

// ─── Global socket reference ──────────────────────────────────────────────────
let activeSock = null;
const getSock  = () => activeSock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Baileys v7 dropped ev.once — implement it via ev.on + ev.off. */
function evOnce(ev, eventName, handler) {
  function wrapper(...args) {
    ev.off(eventName, wrapper);
    handler(...args);
  }
  ev.on(eventName, wrapper);
  return wrapper;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      logger.info('[client] Stale session folder cleared.');
    }
  } catch (e) {
    logger.warn(`[client] Could not clear session: ${e.message}`);
  }
}

function getPhone() {
  return (
    process.env.WA_PHONE_NUMBER         ||
    process.env.BOT_PHONE_NUMBER        ||
    process.env.WHATSAPP_PHONE_NUMBER   || ''
  ).replace(/\D/g, '');
}

// ─── Pairing code ─────────────────────────────────────────────────────────────

/**
 * Request a pairing code with up to maxAttempts retries.
 * Each attempt waits progressively longer before retrying.
 *
 * CRITICAL: caller must ensure the WebSocket is fully open before calling this.
 */
async function requestPairingCode(sock, phone, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAYS = [0, 5_000, 8_000, 12_000, 20_000]; // ms before each attempt

  if (attempt > MAX_ATTEMPTS) {
    console.error('\n❌  Could not obtain a pairing code after', MAX_ATTEMPTS, 'attempts.');
    console.error(`    Phone: +${phone}`);
    console.error('    Make sure the number is registered on WhatsApp.');
    console.error('    Delete the whatsapp-session/ folder and run npm start again.\n');
    return;
  }

  const delay = RETRY_DELAYS[attempt - 1] ?? 10_000;
  if (delay > 0) {
    logger.info(`[client] Waiting ${delay / 1000}s before pairing attempt ${attempt}…`);
    await new Promise(r => setTimeout(r, delay));
  }

  try {
    logger.info(`[client] Requesting pairing code for +${phone} (attempt ${attempt}/${MAX_ATTEMPTS})…`);
    const code = await sock.requestPairingCode(phone);
    printPairingCode(code);
    logger.info(`[client] Pairing code issued: ${code}`);
  } catch (err) {
    logger.error(`[client] requestPairingCode failed (attempt ${attempt}): ${err.message}`);

    // Don't retry if the socket itself closed — connection.update will handle reconnect
    if (err.message?.includes('Connection Closed') || err.message?.includes('socket')) {
      logger.warn('[client] Socket closed during pairing — waiting for reconnect…');
      return;
    }

    await requestPairingCode(sock, phone, attempt + 1);
  }
}

function printPairingCode(code) {
  const bar   = '═'.repeat(40);
  const inner = (s) => '║  ' + s.padEnd(38) + '║';
  console.log('');
  console.log('╔' + bar + '╗');
  console.log('║' + '   🔐  HAVEN BOT — PAIRING CODE   '.padEnd(40) + '║');
  console.log('╠' + bar + '╣');
  console.log('║' + ('        ' + code + '        ').padEnd(40) + '║');
  console.log('╠' + bar + '╣');
  console.log(inner('Steps:'));
  console.log(inner('1. Open WhatsApp on your phone'));
  console.log(inner('2. Settings → Linked Devices'));
  console.log(inner('3. "Link a Device"'));
  console.log(inner('4. "Link with phone number instead"'));
  console.log(inner('5. Enter the code above'));
  console.log('╚' + bar + '╝');
  console.log('');
}

// ─── Main connection ──────────────────────────────────────────────────────────

async function connectToWhatsApp() {
  logger.info(`[client] Session directory: ${SESSION_DIR}`);

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    logger.info(`[client] Baileys version: ${version.join('.')}`);
  } catch {
    version = [2, 3000, 1013273];
    logger.warn('[client] Could not fetch latest version — using fallback.');
  }

  const needsPairing = !state.creds.registered;
  const phone        = getPhone();

  if (needsPairing) {
    if (!phone) {
      logger.error('[client] FATAL: WA_PHONE_NUMBER is not set in .env');
      logger.error('[client] Add WA_PHONE_NUMBER=234XXXXXXXXXX and restart.');
      process.exit(1);
    }
    logger.info('[client] No existing session — pairing code will be requested.');
  } else {
    logger.info('[client] Existing session found — skipping pairing.');
  }

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger:                         pino({ level: 'silent' }),
    printQRInTerminal:              false,
    generateHighQualityLinkPreview: false,
    syncFullHistory:                false,
    browser:                        ['Ubuntu', 'Chrome', '120.0.0.0'],
    getMessage:                     async () => undefined,
    shouldIgnoreJid:                jid => isJidBroadcast(jid),
    connectTimeoutMs:               60_000,
    keepAliveIntervalMs:            25_000,
    retryRequestDelayMs:            500,
    maxMsgRetryCount:               3,
  });

  activeSock = sock;

  // ── Persist credentials ───────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Pairing flow ──────────────────────────────────────────────────────────
  // The pairing code must be requested AFTER the WebSocket fully completes
  // its initial protocol handshake with WhatsApp servers.  
  //
  // In Baileys v7 the correct signal is sock.ws emitting 'open', which fires
  // after the TCP + TLS + WebSocket upgrade is done — BEFORE connection.update
  // fires 'connecting'.  We add a further 500 ms safety buffer.
  //
  // Do NOT call requestPairingCode on connection.update === 'connecting':
  // the handshake is still in flight at that point, causing "Connection Closed".

  if (needsPairing && phone) {
    let pairingScheduled = false;

    // sock.ws is the underlying WebSocket — wait for its native 'open' event
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.once('open', () => {
        if (pairingScheduled) return;
        pairingScheduled = true;
        // 500 ms buffer: let Baileys finish its internal post-open setup
        setTimeout(() => requestPairingCode(sock, phone), 500);
      });
    } else {
      // Fallback: use connection.update 'connecting' + a longer delay
      evOnce(sock.ev, 'connection.update', ({ connection }) => {
        if (connection !== 'connecting') return;
        if (pairingScheduled) return;
        pairingScheduled = true;
        // 3 s gives Baileys time to complete the WebSocket protocol exchange
        logger.info('[client] Scheduling pairing code request in 3s…');
        setTimeout(() => requestPairingCode(sock, phone), 3_000);
      });
    }
  }

  // ── Connection state machine ──────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Should never happen in pairing-code mode — log and ignore
      logger.warn('[client] QR code appeared — ignored (pairing-code mode is active).');
      return;
    }

    if (connection === 'connecting') {
      logger.info('[client] Connecting to WhatsApp…');
    }

    if (connection === 'open') {
      isConnected       = true;
      reconnectAttempts = 0;
      logger.info('[client] ✅  Connected to WhatsApp successfully.');
    }

    if (connection === 'close') {
      isConnected = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason     = lastDisconnect?.error?.message ?? 'unknown';
      logger.warn(`[client] Connection closed — status: ${statusCode ?? 'none'}, reason: ${reason}`);

      // ── Fatal: session is permanently invalid ────────────────────────
      const fatal = [
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.connectionReplaced,
        DisconnectReason.multideviceMismatch,
        401,
      ];

      if (fatal.includes(statusCode)) {
        logger.error('[client] Session invalidated — clearing and exiting.');
        logger.error('[client] Restart the process to generate a new pairing code.');
        clearSession();
        process.exit(1);
      }

      // ── Transient: reconnect with exponential back-off ───────────────
      reconnectAttempts++;
      if (reconnectAttempts > MAX_RECONNECTS) {
        logger.error(`[client] ${MAX_RECONNECTS} consecutive reconnect failures — exiting.`);
        process.exit(1);
      }

      const delay = backoffMs();
      logger.info(`[client] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECTS})…`);
      setTimeout(connectToWhatsApp, delay);
    }
  });

  // ── Incoming messages ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleMessage(sock, msg).catch(err =>
        logger.error('[client] handleMessage error:', err.message),
      );
    }
  });

  return sock;
}

module.exports = { connectToWhatsApp, getSock };
