const config = require('../config');
const logger = require('../config/logger');
const db = require('../database/postgres');
const queries = require('../database/queries');
const { mockArtisans, AREAS } = require('./mockData');
const { rankArtisans } = require('./ranking');

let usingDatabase = config.database.enabled;

/**
 * Called once on boot. If DATABASE_URL is set, verify we can actually connect;
 * if the connection fails, log a warning and fall back to mock data anyway,
 * so the bot still works instead of crashing.
 */
async function init() {
  if (!config.database.enabled) {
    logger.info('[artisanService] No DATABASE_URL set — running in MOCK DATA mode.');
    usingDatabase = false;
    return;
  }

  try {
    await db.ensureSchema();
    const ok = await db.testConnection();
    usingDatabase = ok;
    logger.info(
      ok
        ? '[artisanService] Connected to PostgreSQL — running in DATABASE mode.'
        : '[artisanService] Could not verify PostgreSQL connection — falling back to MOCK DATA mode.'
    );
  } catch (err) {
    logger.error('[artisanService] Failed to initialize database:', err.message);
    usingDatabase = false;
  }
}

function isUsingDatabase() {
  return usingDatabase;
}

/**
 * Best-effort geocode for a free-text location string, used for distance scoring.
 * In mock mode we match against the known AREAS table. In DB mode you'd normally
 * call a real geocoding service or look up the location in your own table —
 * left as a TODO hook for the real backend.
 */
function geocodeLocation(locationText) {
  if (!locationText) return null;
  const normalized = locationText.trim().toLowerCase();
  const match = Object.keys(AREAS).find((key) => key.toLowerCase() === normalized);
  if (match) return AREAS[match];

  // fuzzy partial match, e.g. "ikeja gra" -> "Ikeja"
  const partial = Object.keys(AREAS).find(
    (key) => normalized.includes(key.toLowerCase()) || key.toLowerCase().includes(normalized)
  );
  return partial ? AREAS[partial] : null;
}

/**
 * Main search entry point used by the AI agent.
 *
 * @param {object} filters - { service, location, urgency, budget }
 * @returns {Promise<Array>} ranked artisan list (best match first)
 */
async function searchArtisans(filters = {}) {
  const { service, location, urgency, budget } = filters;

  let candidates = [];

  if (usingDatabase) {
    try {
      candidates =
        urgency === 'high' && service
          ? await queries.findUrgentAvailable(service)
          : await queries.search({ category: service, location });
    } catch (err) {
      logger.error('[artisanService] DB query failed, falling back to mock data for this request:', err.message);
      candidates = searchMock({ service, location });
    }
  } else {
    candidates = searchMock({ service, location });
  }

  const userCoords = geocodeLocation(location);
  const ranked = rankArtisans(candidates, { userCoords, urgency, budget });

  return ranked;
}

function searchMock({ service, location }) {
  return mockArtisans.filter((a) => {
    const matchesService = service ? a.category.toLowerCase() === service.toLowerCase() : true;
    const matchesLocation = location
      ? a.location.toLowerCase().includes(location.toLowerCase()) ||
        location.toLowerCase().includes(a.location.toLowerCase())
      : true;
    return matchesService && matchesLocation;
  });
}

async function listCategories() {
  if (usingDatabase) {
    try {
      const { rows } = await db.query('SELECT DISTINCT category FROM artisans ORDER BY category');
      return rows.map((r) => r.category);
    } catch (err) {
      logger.error('[artisanService] Failed to list categories from DB:', err.message);
    }
  }
  return [...new Set(mockArtisans.map((a) => a.category))];
}

module.exports = {
  init,
  isUsingDatabase,
  searchArtisans,
  listCategories,
  geocodeLocation,
};
