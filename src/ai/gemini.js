const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../config/logger');

let client = null;
let model = null;

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

/**
 * Generate plain text from a prompt. Throws a normalized error on failure
 * so callers (agent.js) can decide how to degrade gracefully.
 */
async function generateText(prompt, { temperature = 0.4 } = {}) {
  try {
    const m = getModel();
    const result = await m.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    });
    const text = result?.response?.text?.();
    if (!text) throw new Error('Empty response from Gemini.');
    return text.trim();
  } catch (err) {
    logger.error('[gemini] generateText failed:', err.message);
    throw new Error(`Gemini request failed: ${err.message}`);
  }
}

/**
 * Generate text and parse it as JSON. Strips markdown code fences if Gemini
 * adds them despite instructions. Returns null on parse failure (caller should
 * fall back gracefully rather than crash).
 */
async function generateJSON(prompt, options = {}) {
  const raw = await generateText(prompt, options);
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

module.exports = {
  generateText,
  generateJSON,
};
