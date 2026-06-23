const db = require('./postgres');

/**
 * All queries return plain rows shaped like the mock artisan objects
 * (artisans/mockData.js) so the ranking/service layer doesn't need to care
 * which backend served the data.
 */

async function findByService(category) {
  const { rows } = await db.query(
    `SELECT * FROM artisans WHERE LOWER(category) = LOWER($1)`,
    [category]
  );
  return rows;
}

async function findByLocation(location) {
  const { rows } = await db.query(
    `SELECT * FROM artisans WHERE LOWER(location) = LOWER($1)`,
    [location]
  );
  return rows;
}

async function findByMinRating(minRating) {
  const { rows } = await db.query(
    `SELECT * FROM artisans WHERE rating >= $1 ORDER BY rating DESC`,
    [minRating]
  );
  return rows;
}

async function findAvailable() {
  const { rows } = await db.query(`SELECT * FROM artisans WHERE available = true`);
  return rows;
}

/**
 * Urgent + available: same service category, currently available,
 * sorted by fastest average response time first.
 */
async function findUrgentAvailable(category) {
  const { rows } = await db.query(
    `SELECT * FROM artisans
     WHERE available = true AND LOWER(category) = LOWER($1)
     ORDER BY average_response_time ASC NULLS LAST, rating DESC
     LIMIT 20`,
    [category]
  );
  return rows;
}

/**
 * Flexible search combining category + optional location, used by artisanService.js
 * as the main entry point. Filters are applied only when provided.
 */
async function search({ category, location } = {}) {
  const conditions = [];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`LOWER(category) = LOWER($${params.length})`);
  }
  if (location) {
    params.push(location);
    conditions.push(`LOWER(location) = LOWER($${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(`SELECT * FROM artisans ${where} ORDER BY rating DESC LIMIT 50`, params);
  return rows;
}

async function insertArtisan(artisan) {
  const { rows } = await db.query(
    `INSERT INTO artisans
      (name, phone, category, description, rating, completed_jobs, location, latitude, longitude, available, average_response_time, price_range)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      artisan.name,
      artisan.phone,
      artisan.category,
      artisan.description,
      artisan.rating,
      artisan.completed_jobs,
      artisan.location,
      artisan.latitude,
      artisan.longitude,
      artisan.available,
      artisan.average_response_time,
      artisan.price_range,
    ]
  );
  return rows[0];
}

module.exports = {
  findByService,
  findByLocation,
  findByMinRating,
  findAvailable,
  findUrgentAvailable,
  search,
  insertArtisan,
};
