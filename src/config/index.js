require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT ?? '3000', 10),

  gemini: {
    // Legacy single key — still supported as fallback.
    // Prefer GEMINI_API_KEY_1 / GEMINI_API_KEY_2 going forward.
    apiKey: process.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY_1 ?? '',
    model:  process.env.GEMINI_MODEL ?? 'gemini-1.5-flash',
  },

  database: {
    url: process.env.DATABASE_URL ?? '',
  },

  whatsapp: {
    phoneNumber: process.env.BOT_PHONE_NUMBER ?? '',
    adminNumbers: (process.env.ADMIN_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },

  backend: {
    baseUrl:       process.env.BACKEND_BASE_URL ?? 'http://localhost:3001',
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  },

  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
};
