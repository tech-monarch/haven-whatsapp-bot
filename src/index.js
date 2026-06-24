const http = require('http');
const config = require('./config');
const logger = require('./config/logger');
const artisanService = require('./artisans/artisanService');
const { startWhatsApp } = require('./whatsapp/client');
const { handleIncomingMessage } = require('./whatsapp/messageHandler');

let isReady = false;

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: isReady ? 'ok' : 'starting',
          databaseMode: artisanService.isUsingDatabase() ? 'postgres' : 'mock',
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.port, () => {
    logger.info(`[index] Health check server listening on port ${config.port} (GET /health)`);
    startSelfPing();
  });
}

// ---------------------------------------------------------------------------
// Self-ping — hits our own /health endpoint every 10 s to prevent the server
// from hibernating on platforms like Render's free tier.
// ---------------------------------------------------------------------------
function startSelfPing() {
  const PING_INTERVAL_MS = 10_000; // 10 seconds

  // Determine where we're running so the ping goes to the right URL.
  // On Render, RENDER_EXTERNAL_URL is set automatically.
  // Fallback to localhost on dev machines.
  const baseUrl =
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${config.port}`;

  const pingUrl = `${baseUrl}/health`;

  setInterval(() => {
    http.get(pingUrl, (res) => {
      // Consume the response body so Node doesn't hold the socket open
      res.resume();
    }).on('error', (err) => {
      logger.warn(`[index] Self-ping failed: ${err.message}`);
    });
  }, PING_INTERVAL_MS);

  logger.info(`[index] Self-ping started — hitting ${pingUrl} every ${PING_INTERVAL_MS / 1000}s`);
}

async function main() {
  logger.info('[index] Booting WhatsApp Artisan Bot...');

  await artisanService.init();
  startHealthServer();

  await startWhatsApp(
    (sock) => {
      isReady = true;
      logger.info('[index] WhatsApp client is ready to receive messages.');
    },
    handleIncomingMessage
  );

  process.on('unhandledRejection', (err) => {
    logger.error('[index] Unhandled rejection:', err);
  });
  process.on('uncaughtException', (err) => {
    logger.error('[index] Uncaught exception:', err);
  });
}

main().catch((err) => {
  logger.error('[index] Fatal error during startup:', err);
  process.exit(1);
});
