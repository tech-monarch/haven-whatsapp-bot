/**
 * AI Provider Manager — intelligent API key rotation with health tracking.
 *
 * Supports up to N Gemini API keys. Uses the first healthy key.
 * On failure, marks the key degraded and retries with the next.
 * After MAX_FAILURES consecutive failures, enters a cooldown period.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../config/logger');

const MAX_FAILURES   = 3;
const COOLDOWN_MS    = 5 * 60 * 1000; // 5 minutes
const AI_TIMEOUT_MS  = 15_000;        // 15 seconds per call

// Errors that warrant trying the next key
const RETRYABLE_CODES   = new Set([429, 500, 503]);
const RETRYABLE_PHRASES = [
  'quota', 'rate limit', 'resource exhausted',
  'service unavailable', 'internal error', 'overloaded',
];

function isRetryable(err) {
  const status  = err?.status ?? err?.response?.status;
  const message = (err?.message ?? '').toLowerCase();
  if (status && RETRYABLE_CODES.has(status)) return true;
  return RETRYABLE_PHRASES.some(p => message.includes(p));
}

// ─── Build key list from env ──────────────────────────────────────────────────
function buildKeyList() {
  const keys = [];
  // Support GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... and also legacy GEMINI_API_KEY
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // Fallback to legacy single key
  if (keys.length === 0 && config.gemini?.apiKey) {
    keys.push(config.gemini.apiKey);
  }
  return keys;
}

// ─── Health state per key ─────────────────────────────────────────────────────
class KeyState {
  constructor(apiKey, index) {
    this.apiKey       = apiKey;
    this.index        = index;
    this.failCount    = 0;
    this.cooldownUntil = 0;
    this._client      = null;
    this._model       = null;
  }

  isHealthy() {
    if (Date.now() < this.cooldownUntil) return false;
    if (this.failCount >= MAX_FAILURES) {
      // Check if cooldown has expired
      if (Date.now() >= this.cooldownUntil) {
        // Reset for retry
        this.failCount = 0;
        logger.info(`[providerManager] Key #${this.index + 1} cooldown expired — retrying`);
        return true;
      }
      return false;
    }
    return true;
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
      logger.warn(
        `[providerManager] Key #${this.index + 1} failure ${this.failCount}/${MAX_FAILURES}: ${err?.message}`
      );
    }
  }

  recordSuccess() {
    if (this.failCount > 0) {
      logger.info(`[providerManager] Key #${this.index + 1} recovered`);
    }
    this.failCount    = 0;
    this.cooldownUntil = 0;
  }

  getModel(modelName) {
    if (!this._client) {
      this._client = new GoogleGenerativeAI(this.apiKey);
    }
    if (!this._model) {
      this._model = this._client.getGenerativeModel({ model: modelName });
    }
    return this._model;
  }
}

// ─── Manager ─────────────────────────────────────────────────────────────────
let keys = null;

function getKeys() {
  if (!keys) {
    const keyList = buildKeyList();
    if (keyList.length === 0) {
      throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY_1 (and optionally GEMINI_API_KEY_2) in .env');
    }
    keys = keyList.map((k, i) => new KeyState(k, i));
    logger.info(`[providerManager] Initialized with ${keys.length} API key(s)`);
  }
  return keys;
}

/**
 * Execute a Gemini call with automatic key failover.
 * fn(model) → Promise<result>
 */
async function withFailover(fn) {
  const ks = getKeys();
  const modelName = config.gemini?.model ?? 'gemini-1.5-flash';

  let lastErr;
  const tried = new Set();

  // Try each key once per call, prioritising healthy ones
  for (let pass = 0; pass < 2; pass++) {
    for (const keyState of ks) {
      if (tried.has(keyState.index)) continue;
      if (!keyState.isHealthy()) continue;

      tried.add(keyState.index);
      if (ks.length > 1) {
        logger.debug(`[providerManager] Using key #${keyState.index + 1}`);
      }

      try {
        const model = keyState.getModel(modelName);

        // Wrap in a timeout
        const result = await Promise.race([
          fn(model),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI call timed out after 15s')), AI_TIMEOUT_MS)
          ),
        ]);

        keyState.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (isRetryable(err)) {
          keyState.recordFailure(err);
          if (ks.length > 1) {
            logger.info(`[providerManager] Failing over from key #${keyState.index + 1} to next key`);
          }
          continue; // try next key
        }
        // Non-retryable error (bad prompt, etc.) — throw immediately
        throw err;
      }
    }
  }

  // All keys failed or in cooldown
  logger.error(`[providerManager] All ${ks.length} key(s) failed. Last error: ${lastErr?.message}`);
  throw lastErr ?? new Error('All AI API keys failed');
}

// ─── Health status (for logging/monitoring) ───────────────────────────────────
function getHealthStatus() {
  if (!keys) return [];
  return keys.map(k => ({
    keyIndex: k.index + 1,
    healthy: k.isHealthy(),
    failCount: k.failCount,
    cooldownRemaining: Math.max(0, k.cooldownUntil - Date.now()),
  }));
}

module.exports = { withFailover, getHealthStatus };
