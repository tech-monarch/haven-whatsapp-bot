/**
 * Haven WhatsApp Bot — entry point.
 *
 * FIXED STARTUP ORDER (root cause of missing sync_queue table):
 *   Previous code used setTimeout(2000) to start the daemon, which was a race.
 *   If the DB was slow to connect, ensureSchema() might not have run before the
 *   daemon's first tick tried to INSERT into sync_queue → table-not-found error.
 *
 * CORRECT ORDER (now sequential, no races):
 *   1. validateEnv()           — fail fast on missing config
 *   2. testConnection()        — verify DB is reachable
 *   3. ensureSchema()          — ALL tables created before anything else runs
 *   4. require('./whatsapp/registration') — registers sync processors
 *   5. syncQueue.startDaemon() — safe: sync_queue exists
 *   6. connectToWhatsApp()     — safe: bot_sessions exists
 *   7. HTTP server             — always available (started first for health checks)
 */

require('dotenv').config();

const http    = require('http');
const logger  = require('./config/logger');
const { validateEnv } = require('./config/validateEnv');

validateEnv(logger);

const { connectToWhatsApp, getSock } = require('./whatsapp/client');
const { getHealthStatus }            = require('./providers/providerManager');
const syncQueue                      = require('./sync/syncQueue');
const db                             = require('./database/postgres');

const PORT             = parseInt(process.env.PORT ?? '3000', 10);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';
const RENDER_URL       = process.env.RENDER_EXTERNAL_URL ?? '';

// ── HTTP server ────────────────────────────────────────────────────────────────
// Start immediately so Render / Railway health checks pass even while the bot
// is still connecting to WhatsApp.

const server = http.createServer(async (req, res) => {
  const url    = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/health') {
    const sock        = getSock();
    const aiHealth    = getHealthStatus();
    const pendingSync = await syncQueue.getPendingCount().catch(() => -1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:      'ok',
      service:     'haven-bot',
      connected:   sock != null,
      aiKeys:      aiHealth,
      pendingSync,
      timestamp:   new Date().toISOString(),
    }));
    return;
  }

  if (method === 'POST' && url === '/send') {
    const key = req.headers['x-internal-key'];
    if (INTERNAL_API_KEY && key !== INTERNAL_API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { to, text } = JSON.parse(body);
        if (!to || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'to and text are required' }));
          return;
        }

        const sock = getSock();
        if (!sock) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'WhatsApp not connected' }));
          return;
        }

        const phone = String(to).replace(/[\s\-()+]/g, '');
        const jid   = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        logger.error('[/send] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: 'Not found' }));
});

server.listen(PORT, () => {
  logger.info(`[index] HTTP server listening on port ${PORT}`);
});

// ── Self-ping keep-alive (Render free tier) ────────────────────────────────────
if (RENDER_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(`${RENDER_URL.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      logger.debug(`[index] Self-ping → ${res.status}`);
    } catch (err) {
      logger.warn('[index] Self-ping failed:', err.message);
    }
  }, 14 * 60 * 1000);
  logger.info(`[index] Self-ping enabled → ${RENDER_URL}/health every 14m`);
}

// ── Sequential startup ────────────────────────────────────────────────────────

async function start() {
  logger.info(`[index] Starting Haven WhatsApp Bot (Node ${process.version})…`);

  // Step 1: Verify DB is reachable
  if (db.isEnabled()) {
    const connected = await db.testConnection();
    if (!connected) {
      logger.warn('[index] Database unreachable — running in in-memory mode (sessions will not persist)');
    } else {
      logger.info('[index] Database connected');

      // Step 2: Create all tables BEFORE the daemon or WhatsApp client starts
      await db.ensureSchema();
    }
  } else {
    logger.warn('[index] DATABASE_URL not set — running in in-memory mode');
  }

  // Step 3: Register sync processors (must happen before daemon starts)
  require('./whatsapp/registration');
  logger.info('[index] Sync processors registered');

  // Step 4: Start background sync daemon (sync_queue table is guaranteed to exist now)
  syncQueue.startDaemon();
  logger.info('[index] Background sync daemon started');

  // Step 5: Connect to WhatsApp (bot_sessions table is guaranteed to exist now)
  try {
    await connectToWhatsApp();
  } catch (err) {
    logger.error('[index] Failed to connect to WhatsApp:', err.message);
    process.exit(1);
  }
}

start().catch(err => {
  logger.error('[index] Fatal startup error:', err.message, err.stack);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`[index] Received ${signal} — shutting down…`);
  syncQueue.stopDaemon();
  server.close(() => logger.info('[index] HTTP server closed'));
  await db.close().catch(() => {});
  setTimeout(() => { logger.info('[index] Exit'); process.exit(0); }, 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('[index] Uncaught exception:', err.message);
  logger.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[index] Unhandled rejection:', reason);
});
