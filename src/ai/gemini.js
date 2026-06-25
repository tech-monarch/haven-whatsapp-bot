/**
 * Gemini wrapper — now delegates all key selection and failover
 * to providerManager. Drop-in replacement for the original gemini.js.
 */

const { withFailover } = require('./providerManager');
const logger = require('../config/logger');

/**
 * Generate plain text from a prompt.
 */
async function generateText(prompt, { temperature = 0.4 } = {}) {
  return withFailover(async (model) => {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    });
    const text = result?.response?.text?.();
    if (!text) throw new Error('Empty response from Gemini.');
    return text.trim();
  });
}

/**
 * Generate text and parse as JSON.
 * Returns null on parse failure — callers fall back gracefully.
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
    logger.error('[gemini] Failed to parse JSON:', err.message, '| raw:', cleaned.slice(0, 300));
    return null;
  }
}

module.exports = { generateText, generateJSON };
