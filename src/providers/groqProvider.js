/**
 * Groq provider — wraps the Groq SDK.
 *
 * ROOT CAUSE OF "tools[0].type must be one of [function,mcp]":
 *   The previous code sent: tools: [{ type: 'web_search' }]
 *   Groq's API only accepts type "function" or "mcp" for the `tools` array.
 *   compound-beta-mini's web search is NOT a declarable tool — it runs
 *   automatically when the model decides to use it. You do NOT pass it in tools[].
 *
 * FIX: Remove the tools array entirely. compound-beta-mini automatically uses
 * web search when it needs current information. No tools[] declaration needed.
 *
 * SYSTEM PROMPT: compound-beta-mini correctly handles a separate system role.
 * We pass it as messages[0] with role:"system" for best instruction-following.
 */

const Groq = require('groq-sdk');
const logger = require('../config/logger');

const DEFAULT_MODEL = 'compound-beta-mini';

const clientCache = new Map();

function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new Groq({ apiKey }));
  }
  return clientCache.get(apiKey);
}

/**
 * Run a single chat completion.
 *
 * @param {string} apiKey
 * @param {object} opts
 * @param {string} opts.prompt       - user-role message text
 * @param {string} [opts.system]     - system prompt (sent as role:"system")
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.model]
 * @returns {Promise<string>}
 */
async function complete(apiKey, { prompt, system, temperature = 0.4, maxTokens = 1024, model } = {}) {
  const client    = getClient(apiKey);
  const modelName = model || DEFAULT_MODEL;

  const messages = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: prompt });

  // DO NOT pass `tools` — compound-beta-mini uses web search automatically.
  // Groq only accepts type "function" or "mcp" in tools[], not "web_search".
  const requestBody = {
    model: modelName,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const start      = Date.now();
  const completion = await client.chat.completions.create(requestBody);
  const latencyMs  = Date.now() - start;

  const choice  = completion?.choices?.[0];
  const message = choice?.message;

  // compound-beta-mini may return structured content blocks or plain string
  let text = '';
  if (Array.isArray(message?.content)) {
    text = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
      .trim();
  } else if (typeof message?.content === 'string') {
    text = message.content.trim();
  }

  const usage = completion?.usage;
  logger.debug(
    `[groqProvider] model=${modelName} latency=${latencyMs}ms ` +
    `tokens(in=${usage?.prompt_tokens ?? '?'} out=${usage?.completion_tokens ?? '?'})`
  );

  if (!text) throw new Error('Empty response from Groq.');
  return text;
}

module.exports = { complete, DEFAULT_MODEL };
