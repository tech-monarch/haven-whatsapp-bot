/**
 * Startup environment validation.
 *
 * Run once, as early as possible (src/index.js). Throws on missing
 * *required* variables so the process fails fast with a clear message
 * instead of limping along and producing confusing runtime errors later
 * (e.g. "Unauthorized", "No Groq API keys configured", etc.).
 */

const REQUIRED = [
  // At least one of these is required — checked specially below.
];

const REQUIRED_GROUPS = [
  {
    label: 'at least one Groq API key (GROQ_API_KEY or GROQ_API_KEY_1)',
    check: () => !!(process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1),
  },
  {
    label: 'WA_PHONE_NUMBER (the bot account\'s WhatsApp number, digits only)',
    check: () => !!(process.env.WA_PHONE_NUMBER || process.env.BOT_PHONE_NUMBER),
  },
  {
    label: 'BACKEND_BASE_URL (the Haven backend base URL)',
    check: () => !!process.env.BACKEND_BASE_URL,
  },
  {
    label: 'INTERNAL_API_KEY (shared secret with the Haven backend)',
    check: () => !!process.env.INTERNAL_API_KEY,
  },
];

const RECOMMENDED = [
  { name: 'DATABASE_URL', why: 'sessions will fall back to in-memory and will NOT survive restarts' },
  { name: 'RENDER_EXTERNAL_URL', why: 'self-ping keep-alive is disabled (fine off Render)' },
];

function validateEnv(logger) {
  const missing = REQUIRED.filter(name => !process.env[name]?.trim());
  const failedGroups = REQUIRED_GROUPS.filter(g => !g.check());

  if (missing.length || failedGroups.length) {
    logger.error('[config] FATAL: missing required environment variables:');
    missing.forEach(name => logger.error(`  - ${name}`));
    failedGroups.forEach(g => logger.error(`  - ${g.label}`));
    logger.error('[config] Fix .env (see .env.example) and restart.');
    throw new Error('Missing required environment variables — see log above.');
  }

  RECOMMENDED.forEach(({ name, why }) => {
    if (!process.env[name]?.trim()) {
      logger.warn(`[config] Optional env var ${name} is not set — ${why}.`);
    }
  });
}

module.exports = { validateEnv };
