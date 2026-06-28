/**
 * AI Provider Manager — provider-agnostic key rotation with health tracking.
 *
 * The rest of the application calls generateText()/generateJSON() in
 * src/ai/aiClient.js, which delegates here. This module:
 *   - Loads all configured Groq API keys.
 *   - Picks the first healthy key for each call.
 *   - On a retryable failure (429 / 5xx / quota / rate-limit), marks the key
 *     degraded and fails over to the next key, within the same call.
 *   - After MAX_FAILURES consecutive failures, a key enters cooldown and is
 *     skipped until the cooldown expires.
 *
 * To add a second provider in the future, drop in another `xProvider.js`
 * with a `complete(apiKey, opts)` function and add a branch below — nothing
 * outside this file needs to change.
 */

const groqProvider = require('./groqProvider');
const config = require('../config');
const logger = require('../config/logger');

const MAX_FAILURES  = 3;
const COOLDOWN_MS   = 5 * 60 * 1000; // 5 minutes
const AI_TIMEOUT_MS = 15_000;        // 15 seconds per call

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_PHRASES = [
  'quota', 'rate limit', 'rate_limit', 'resource exhausted',
  'service unavailable', 'internal error', 'overloaded', 'timed out',
];

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  const message = (err?.message ?? '').toLowerCase();
  if (status && RETRYABLE_CODES.has(status)) return true;
  return RETRYABLE_PHRASES.some(p => message.includes(p));
}

// ─── Active provider (Groq today; structured so others can be added) ─────────
const PROVIDERS = {
  groq: { complete: groqProvider.complete, defaultModel: groqProvider.DEFAULT_MODEL },
};

function activeProviderName() {
  return config.ai?.provider ?? 'groq';
}

function activeProvider() {
  const name = activeProviderName();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown AI provider configured: "${name}"`);
  return provider;
}

// ─── Key list from env ────────────────────────────────────────────────────────
function buildKeyList() {
  const keys = [];
  // GROQ_API_KEY_1, GROQ_API_KEY_2, ... for multi-key rotation
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // Single-key fallback (the common case)
  if (keys.length === 0 && config.ai?.groqApiKey) {
    keys.push(config.ai.groqApiKey);
  }
  return keys;
}

// ─── Per-key health state ─────────────────────────────────────────────────────
class KeyState {
  constructor(apiKey, index) {
    this.apiKey = apiKey;
    this.index = index;
    this.failCount = 0;
    this.cooldownUntil = 0;
  }

  isHealthy() {
    if (this.failCount < MAX_FAILURES) return true;
    if (Date.now() >= this.cooldownUntil) {
      this.failCount = 0;
      logger.info(`[providerManager] Key #${this.index + 1} cooldown expired — retrying`);
      return true;
    }
    return false;
  }

  recordFailure(err) {
    this.failCount++;
    if (this.failCount >= MAX_FAILURES) {
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
      logger.warn(
        `[providerManager] Key #${this.index + 1} entered cooldown for ${COOLDOWN_MS / 1000}s ` +
        `after ${this.failCount} failures. Last error: ${err?.message}`
      );
    } else {
      logger.warn(`[providerManager] Key #${this.index + 1} failure ${this.failCount}/${MAX_FAILURES}: ${err?.message}`);
    }
  }

  recordSuccess() {
    if (this.failCount > 0) logger.info(`[providerManager] Key #${this.index + 1} recovered`);
    this.failCount = 0;
    this.cooldownUntil = 0;
  }
}

let keys = null;
let activeKeyIndex = null;

function getKeys() {
  if (!keys) {
    const keyList = buildKeyList();
    if (keyList.length === 0) {
      throw new Error(
        'No Groq API keys configured. Set GROQ_API_KEY (or GROQ_API_KEY_1 / GROQ_API_KEY_2 / ...) in .env'
      );
    }
    keys = keyList.map((k, i) => new KeyState(k, i));
    logger.info(`[providerManager] Initialized with ${keys.length} Groq API key(s)`);
  }
  return keys;
}

/**
 * Run a single completion with automatic key failover.
 * @param {string} prompt
 * @param {{ temperature?: number, maxTokens?: number, model?: string, system?: string }} opts
 */
async function withFailover(prompt, opts = {}) {
  const ks = getKeys();
  const provider = activeProvider();
  const model = opts.model || config.ai?.groqModel || provider.defaultModel;

  let lastErr;
  const tried = new Set();

  for (let pass = 0; pass < 2; pass++) {
    for (const keyState of ks) {
      if (tried.has(keyState.index)) continue;
      if (!keyState.isHealthy()) continue;

      tried.add(keyState.index);
      activeKeyIndex = keyState.index;
      if (ks.length > 1) logger.debug(`[providerManager] Using key #${keyState.index + 1} (model=${model})`);

      try {
        const result = await Promise.race([
          provider.complete(keyState.apiKey, { ...opts, prompt, model }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`AI call timed out after ${AI_TIMEOUT_MS / 1000}s`)), AI_TIMEOUT_MS)
          ),
        ]);
        keyState.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (isRetryable(err)) {
          keyState.recordFailure(err);
          if (ks.length > 1) logger.info(`[providerManager] Failing over from key #${keyState.index + 1} to next key`);
          continue;
        }
        throw err; // non-retryable (bad prompt, auth, etc.) — surface immediately
      }
    }
  }

  logger.error(`[providerManager] All ${ks.length} key(s) failed. Last error: ${lastErr?.message}`);
  throw lastErr ?? new Error('All AI API keys failed');
}

function getHealthStatus() {
  if (!keys) return [];
  return keys.map(k => ({
    provider: activeProviderName(),
    keyIndex: k.index + 1,
    active: k.index === activeKeyIndex,
    healthy: k.isHealthy(),
    failCount: k.failCount,
    cooldownRemaining: Math.max(0, k.cooldownUntil - Date.now()),
  }));
}

module.exports = { withFailover, getHealthStatus };
