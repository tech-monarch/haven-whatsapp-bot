require('dotenv').config();

const required = (name, fallback = undefined) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
};

const config = {
  port: parseInt(required('PORT', '3000'), 10),
  logLevel: required('LOG_LEVEL', 'info'),

  gemini: {
    apiKey: required('GEMINI_API_KEY', ''),
    model: required('GEMINI_MODEL', 'gemini-1.5-flash'),
  },

  database: {
    url: required('DATABASE_URL', ''),
    // true => real PostgreSQL backend is available, false => use mock data
    enabled: Boolean(required('DATABASE_URL', '')),
  },

  whatsapp: {
    authDir: required('WA_AUTH_DIR', 'auth_sessions'),
    ignoreGroups: true,
  },

  admins: (required('ADMIN_NUMBERS', '') || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
};

if (!config.gemini.apiKey) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] WARNING: GEMINI_API_KEY is not set. The AI agent will not be able to call Gemini until you set it in .env'
  );
}

module.exports = config;
