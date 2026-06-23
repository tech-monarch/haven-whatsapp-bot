const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../config/logger');

let client = null;
let model  = null;

function getModel() {
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }
  if (!client) {
    client = new GoogleGenerativeAI(config.gemini.apiKey);
  }
  if (!model) {
    model = client.getGenerativeModel({ model: config.gemini.model });
  }
  return model;
}

// ---------------------------------------------------------------------------
// Retry helper
// Handles transient Gemini errors (rate limits, 503s) with exponential backoff.
// Permanent errors (bad API key, invalid prompt) are re-thrown immediately.
// ---------------------------------------------------------------------------
const RETRYABLE_CODES   = new Set([429, 500, 503]);
const RETRYABLE_PHRASES = ['quota', 'rate limit', 'resource exhausted', 'service unavailable', 'internal error'];

function isRetryable(err) {
  const status  = err?.status ?? err?.response?.status;
  const message = (err?.message ?? '').toLowerCase();
  if (status && RETRYABLE_CODES.has(status)) return true;
  return RETRYABLE_PHRASES.some((p) => message.includes(p));
}

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const delayMs = 800 * 2 ** (attempt - 1); // 800ms, 1600ms
      logger.warn(`[gemini] Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs}ms…`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate plain text from a prompt.
 * Retries up to 3 times on transient errors.
 */
async function generateText(prompt, { temperature = 0.4 } = {}) {
  return withRetry(async () => {
    const m = getModel();
    const result = await m.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    });
    const text = result?.response?.text?.();
    if (!text) throw new Error('Empty response from Gemini.');
    return text.trim();
  });
}

/**
 * Generate text and parse it as JSON.
 * Strips markdown code fences if Gemini adds them despite instructions.
 * Returns null on parse failure — callers should fall back gracefully.
 */
async function generateJSON(prompt, options = {}) {
  let raw;
  try {
    raw = await generateText(prompt, options);
  } catch (err) {
    logger.error('[gemini] generateJSON — text generation failed:', err.message);
    throw err;
  }

  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('[gemini] Failed to parse JSON response:', err.message, '| raw:', cleaned.slice(0, 300));
    return null;
  }
}

module.exports = { generateText, generateJSON };
