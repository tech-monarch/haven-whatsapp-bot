const config = require('../config');
const logger = require('../config/logger');
const db = require('../database/postgres');
const queries = require('../database/queries');
const { mockArtisans, AREAS } = require('./mockData');
const { rankArtisans } = require('./ranking');

let usingDatabase = config.database.enabled;

async function init() {
  if (!config.database.enabled) {
    logger.info('[artisanService] No DATABASE_URL — running in MOCK DATA mode.');
    usingDatabase = false;
    return;
  }
  try {
    await db.ensureSchema();
    const ok = await db.testConnection();
    usingDatabase = ok;
    logger.info(
      ok
        ? '[artisanService] Connected to PostgreSQL — DATABASE mode.'
        : '[artisanService] PostgreSQL unreachable — falling back to MOCK DATA mode.'
    );
  } catch (err) {
    logger.error('[artisanService] DB init failed:', err.message);
    usingDatabase = false;
  }
}

function isUsingDatabase() {
  return usingDatabase;
}

// ---------------------------------------------------------------------------
// Location aliasing — maps common user spellings to canonical AREAS keys
// ---------------------------------------------------------------------------

const LOCATION_ALIASES = {
  // Port Harcourt variants
  'ph':                    'GRA Port Harcourt',
  'port harcourt':         'GRA Port Harcourt',
  'portharcourt':          'GRA Port Harcourt',
  'port-harcourt':         'GRA Port Harcourt',
  'gra ph':                'GRA Port Harcourt',
  'gra port harcourt':     'GRA Port Harcourt',
  'rumuola':               'Rumuola',
  'trans amadi':           'Trans-Amadi',
  'transamadi':            'Trans-Amadi',
  'd line':                'D-Line',
  'dline':                 'D-Line',
  'rumuokoro':             'Rumuokoro',
  'rumuodara':             'Rumuodara',

  // Lagos variants
  'vi':                    'Victoria Island',
  'v.i':                   'Victoria Island',
  'v.i.':                  'Victoria Island',
  'victoria island':       'Victoria Island',

  // Abuja variants
  'abuja':                 'Wuse 2',
  'fct':                   'Wuse 2',
  'wuse':                  'Wuse',
  'wuse 2':                'Wuse 2',
  'wuse ii':               'Wuse 2',
  'gwarinpa':              'Gwarinpa',
  'maitama':               'Maitama',
  'asokoro':               'Asokoro',
  'garki':                 'Garki',
  'jabi':                  'Jabi',
};

/**
 * Resolve a free-text location to a canonical AREAS key, then return its coords.
 * Returns null if we can't resolve.
 */
function geocodeLocation(locationText) {
  if (!locationText) return null;

  const normalized = locationText.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '');

  // 1. Alias lookup (exact)
  if (LOCATION_ALIASES[normalized]) {
    return AREAS[LOCATION_ALIASES[normalized]] || null;
  }

  // 2. Direct AREAS key match (case-insensitive)
  const directKey = Object.keys(AREAS).find(
    (k) => k.toLowerCase() === normalized
  );
  if (directKey) return AREAS[directKey];

  // 3. Partial alias match
  const aliasPartial = Object.keys(LOCATION_ALIASES).find(
    (alias) => normalized.includes(alias) || alias.includes(normalized)
  );
  if (aliasPartial) return AREAS[LOCATION_ALIASES[aliasPartial]] || null;

  // 4. Partial AREAS key match
  const areaPartial = Object.keys(AREAS).find(
    (k) => normalized.includes(k.toLowerCase()) || k.toLowerCase().includes(normalized)
  );
  return areaPartial ? AREAS[areaPartial] : null;
}

/**
 * Resolve a user's location text to a canonical location string that matches
 * the `location` field in artisans. Used for mock-mode text filtering.
 */
function resolveLocationLabel(locationText) {
  if (!locationText) return null;

  const normalized = locationText.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '');

  // Check alias
  if (LOCATION_ALIASES[normalized]) return LOCATION_ALIASES[normalized];

  // Check partial alias
  const aliasKey = Object.keys(LOCATION_ALIASES).find(
    (alias) => normalized.includes(alias) || alias.includes(normalized)
  );
  if (aliasKey) return LOCATION_ALIASES[aliasKey];

  // Check AREAS key
  const areaKey = Object.keys(AREAS).find(
    (k) => k.toLowerCase() === normalized ||
           normalized.includes(k.toLowerCase()) ||
           k.toLowerCase().includes(normalized)
  );
  return areaKey || locationText; // fall back to original if nothing matches
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

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
      logger.error('[artisanService] DB query failed, falling back to mock data:', err.message);
      candidates = searchMock({ service, location });
    }
  } else {
    candidates = searchMock({ service, location });
  }

  const userCoords = geocodeLocation(location);
  return rankArtisans(candidates, { userCoords, urgency, budget });
}

function searchMock({ service, location }) {
  const resolvedLocation = resolveLocationLabel(location);

  return mockArtisans.filter((a) => {
    const matchesService = service
      ? a.category.toLowerCase() === service.toLowerCase()
      : true;

    const matchesLocation = resolvedLocation
      ? a.location.toLowerCase().includes(resolvedLocation.toLowerCase()) ||
        resolvedLocation.toLowerCase().includes(a.location.toLowerCase())
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
  return [...new Set(mockArtisans.map((a) => a.category))].sort();
}

module.exports = {
  init,
  isUsingDatabase,
  searchArtisans,
  listCategories,
  geocodeLocation,
};
