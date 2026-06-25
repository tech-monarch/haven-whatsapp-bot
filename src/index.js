/**
 * Haven WhatsApp Bot — entry point.
 *
 * Starts:
 * 1. HTTP server on PORT (health check + /send endpoint for backend notifications)
 * 2. WhatsApp connection
 */

require('dotenv').config();

const http       = require('http');
const { connectToWhatsApp, getSock } = require('./whatsapp/client');
const logger     = require('./config/logger');
const { getHealthStatus } = require('./ai/providerManager');

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── Health ──────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    const aiHealth = getHealthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'haven-bot',
      aiKeys: aiHealth,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── Send WhatsApp message (backend → bot) ────────────────────────────────
  if (method === 'POST' && url === '/send') {
    // Authenticate
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

        // Normalize JID
        const phone = String(to).replace(/[\s\-()]/g, '').replace(/^\+/, '');
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

  // ── 404 ──────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: 'Not found' }));
});

server.listen(PORT, () => {
  logger.info(`[index] HTTP server listening on port ${PORT}`);
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

connectToWhatsApp().catch(err => {
  logger.error('[index] Failed to connect to WhatsApp:', err.message);
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`[index] Received ${signal} — shutting down gracefully…`);
  server.close(() => {
    logger.info('[index] HTTP server closed');
    process.exit(0);
  });
  // Give in-flight messages 5s to complete
  setTimeout(() => process.exit(0), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('[index] Uncaught exception:', err.message, err.stack);
  // Don't exit — the bot must stay alive
});
process.on('unhandledRejection', (reason) => {
  logger.error('[index] Unhandled rejection:', reason);
});
