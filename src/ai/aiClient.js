/**
 * AI client — the only module agent.js talks to.
 * Delegates key selection, rotation, and failover to providers/providerManager.js.
 *
 * generateText() now accepts an optional `system` param so the system prompt
 * goes into the dedicated system role instead of being prepended to the user
 * prompt. compound-beta-mini handles this correctly and gives better results.
 */

const { withFailover } = require('../providers/providerManager');
const logger = require('../config/logger');

/**
 * Generate plain text from a prompt.
 *
 * @param {string} prompt
 * @param {{ temperature?, maxTokens?, model?, system? }} opts
 */
async function generateText(prompt, { temperature = 0.4, maxTokens = 1024, model, system } = {}) {
  return withFailover(prompt, { temperature, maxTokens, model, system });
}

/**
 * Generate text and parse it as JSON.
 * Returns null on parse failure — callers fall back gracefully.
 */
async function generateJSON(prompt, options = {}) {
  let raw;
  try {
    raw = await generateText(prompt, options);
  } catch (err) {
    logger.error('[aiClient] generateJSON — text generation failed:', err.message);
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
    logger.error('[aiClient] Failed to parse JSON:', err.message, '| raw:', cleaned.slice(0, 300));
    return null;
  }
}

module.exports = { generateText, generateJSON };
