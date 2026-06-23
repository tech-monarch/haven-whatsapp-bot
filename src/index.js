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
  });
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
