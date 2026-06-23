/**
 * Scoring weights (must sum to 1.0):
 *   rating        -> 40%
 *   distance      -> 25%
 *   availability  -> 20%
 *   completedJobs -> 10%
 *   priceMatch    -> 5%
 */
const WEIGHTS = {
  rating: 0.4,
  distance: 0.25,
  availability: 0.2,
  experience: 0.1,
  priceMatch: 0.05,
};

const EARTH_RADIUS_KM = 6371;
const MAX_RELEVANT_DISTANCE_KM = 25; // beyond this, distance score floors at 0

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance in kilometers between two lat/lng points.
 */
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined || Number.isNaN(v))) {
    return null;
  }
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function ratingScore(artisan) {
  // rating is 0-5
  return Math.max(0, Math.min(1, (artisan.rating ?? 0) / 5));
}

function distanceScore(artisan, userCoords) {
  if (!userCoords) return 0.5; // unknown distance -> neutral score
  const distance = haversineDistanceKm(
    userCoords.lat,
    userCoords.lng,
    artisan.latitude,
    artisan.longitude
  );
  if (distance === null) return 0.5;
  const clamped = Math.max(0, Math.min(MAX_RELEVANT_DISTANCE_KM, distance));
  return 1 - clamped / MAX_RELEVANT_DISTANCE_KM;
}

function availabilityScore(artisan, { urgency } = {}) {
  if (artisan.available) return 1;
  // Not available right now: still give partial credit if urgency is low,
  // since the user may be fine waiting.
  if (urgency === 'low') return 0.4;
  return 0.1;
}

function experienceScore(artisan, allArtisans) {
  const maxJobs = Math.max(1, ...allArtisans.map((a) => a.completed_jobs ?? 0));
  return Math.max(0, Math.min(1, (artisan.completed_jobs ?? 0) / maxJobs));
}

function parsePriceRange(priceRange) {
  if (!priceRange || typeof priceRange !== 'string') return null;
  const numbers = priceRange.match(/[\d,]+/g);
  if (!numbers || numbers.length === 0) return null;
  const parsed = numbers.map((n) => parseInt(n.replace(/,/g, ''), 10)).filter((n) => !Number.isNaN(n));
  if (parsed.length === 0) return null;
  return { min: Math.min(...parsed), max: Math.max(...parsed) };
}

function priceMatchScore(artisan, { budget } = {}) {
  if (!budget) return 0.7; // no budget specified -> mild neutral score
  const range = parsePriceRange(artisan.price_range);
  if (!range) return 0.5;
  if (budget >= range.min && budget <= range.max) return 1;
  // Partial credit, decaying with how far the budget is outside the range
  const nearestBound = budget < range.min ? range.min : range.max;
  const diff = Math.abs(budget - nearestBound);
  const tolerance = Math.max(range.max - range.min, 5000);
  return Math.max(0, 1 - diff / tolerance);
}

/**
 * Compute a 0-1 composite score plus a breakdown, for one artisan.
 *
 * @param {object} artisan
 * @param {object} allArtisans - full candidate list, used to normalize completed_jobs
 * @param {object} context - { userCoords: {lat,lng}|null, urgency: 'low'|'normal'|'high', budget: number|null }
 */
function scoreArtisan(artisan, allArtisans, context = {}) {
  const breakdown = {
    rating: ratingScore(artisan),
    distance: distanceScore(artisan, context.userCoords),
    availability: availabilityScore(artisan, context),
    experience: experienceScore(artisan, allArtisans),
    priceMatch: priceMatchScore(artisan, context),
  };

  const score =
    breakdown.rating * WEIGHTS.rating +
    breakdown.distance * WEIGHTS.distance +
    breakdown.availability * WEIGHTS.availability +
    breakdown.experience * WEIGHTS.experience +
    breakdown.priceMatch * WEIGHTS.priceMatch;

  return { score, breakdown };
}

/**
 * Rank a list of artisans for a given search context.
 * Returns the artisans sorted best-first, each annotated with `_score` and `_scoreBreakdown`.
 */
function rankArtisans(artisans, context = {}) {
  return artisans
    .map((artisan) => {
      const { score, breakdown } = scoreArtisan(artisan, artisans, context);
      return { ...artisan, _score: score, _scoreBreakdown: breakdown };
    })
    .sort((a, b) => b._score - a._score);
}

module.exports = {
  WEIGHTS,
  haversineDistanceKm,
  scoreArtisan,
  rankArtisans,
};
