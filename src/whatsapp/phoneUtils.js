/**
 * Phone number validation & normalization for the onboarding flow.
 * Defaults to Nigerian local-format handling (0xxxxxxxxxx → 234xxxxxxxxxx)
 * but also accepts already-international numbers.
 */

/**
 * Normalize free-form user input into digits-only international format
 * (no leading +), e.g. "+234 801 234 5678" → "2348012345678",
 * "08012345678" → "2348012345678".
 * Returns null if the input doesn't look like a plausible phone number.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).trim().replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;

  // Nigerian local format: 0xxxxxxxxxx (11 digits) → 234xxxxxxxxxx
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = '234' + digits.slice(1);
  }

  // Plausible international length (most countries: 10-15 digits incl. country code)
  if (digits.length < 10 || digits.length > 15) return null;

  return digits;
}

/** Pretty-print a normalized number for display, e.g. "2348012345678" → "+234 801 234 5678". */
function formatPhone(normalized) {
  return `+${normalized}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidPassword(password) {
  return typeof password === 'string' && password.trim().length >= 6;
}

module.exports = { normalizePhone, formatPhone, isValidEmail, isValidPassword };
