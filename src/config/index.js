require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT ?? '3000', 10),

  logLevel: process.env.LOG_LEVEL ?? 'info',

  ai: {
    provider:   process.env.AI_PROVIDER ?? 'groq',
    groqApiKey: process.env.GROQ_API_KEY ?? process.env.GROQ_API_KEY_1 ?? '',
    groqModel:  process.env.GROQ_MODEL ?? 'compound-beta-mini',
  },

  database: {
    url:     process.env.DATABASE_URL ?? '',
    enabled: !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim()),
  },

  whatsapp: {
    phoneNumber: (process.env.WA_PHONE_NUMBER ?? process.env.BOT_PHONE_NUMBER ?? '').replace(/\D/g, ''),
    adminNumbers: (process.env.ADMIN_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },

  backend: {
    baseUrl:        process.env.BACKEND_BASE_URL ?? 'http://localhost:3001',
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  },

  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
};
