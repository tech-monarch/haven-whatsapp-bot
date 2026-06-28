/**
 * Backend API client for the WhatsApp bot.
 *
 * ROOT CAUSE AUDIT (traced against backend source):
 *
 * The backend exposes TWO separate API surfaces:
 *
 *   A) PUBLIC AUTH  →  /api/v1/auth/*           (no special header required)
 *      POST /api/v1/auth/register/customer       body: { fullName, email, phone, password }
 *      POST /api/v1/auth/login                   body: { email, password }
 *      POST /api/v1/auth/refresh                 body: { refreshToken }
 *
 *   B) INTERNAL BOT →  /api/v1/internal/*        header: X-Internal-Key
 *      POST /api/v1/internal/resolve-user         body: { phone }
 *      GET  /api/v1/internal/customer/:id/*
 *      GET  /api/v1/internal/provider/:id/*
 *      GET  /api/v1/internal/providers
 *      POST /api/v1/internal/service-requests
 *      POST /api/v1/internal/bookings
 *      POST /api/v1/internal/bookings/:id/cancel
 *      GET  /api/v1/internal/bookings/:id
 *
 * PREVIOUS BUGS (causing "Unauthorized" on every registration/login):
 *   1. Bot called /api/v1/internal/login     — this endpoint does NOT exist
 *   2. Bot called /api/v1/internal/register-user — this endpoint does NOT exist
 *   3. Bot sent { name } but backend expects { fullName }
 *   4. Bot called "login" with phone+password; backend login requires email+password
 *
 * CORRECT FLOW:
 *   1. Phone received → resolveUser(phone) on internal API
 *      - 200: existing user identified, no password needed for bot sessions
 *      - 404: new user → collect fullName, email, password → registerCustomer()
 *   2. Registration → POST /api/v1/auth/register/customer (public, not internal)
 *   3. Store { accessToken, refreshToken } from registration/login for authenticated calls
 *   4. On token expiry → refreshAccessToken() to get a new one silently
 *
 * Error classification:
 *   err.statusCode set  → backend replied with HTTP error (4xx/5xx)
 *   err.statusCode null → network/timeout (backend unreachable)
 */

const logger = require('../config/logger');

const BASE_URL      = process.env.BACKEND_BASE_URL   || 'http://localhost:3001';
const API_KEY       = process.env.INTERNAL_API_KEY   || '';
const TIMEOUT_MS    = 10_000;
const API           = '/api/v1';

// ── Request helpers ────────────────────────────────────────────────────────────

function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Key': API_KEY,
  };
}

function authHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function request(method, url, body, headers) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(json.message || `Backend returned ${res.status}`);
      err.statusCode = res.status;
      err.body = json;
      throw err;
    }

    // All backend responses are { success: true, data: ... }
    return json.data !== undefined ? json.data : json;
  } catch (err) {
    if (err.statusCode) throw err; // re-throw classified HTTP errors

    // Network / timeout — statusCode stays null so callers can detect offline
    logger.error(`[backendClient] ${method} ${url} network error:`, err.message);
    const netErr = new Error('Could not reach the Haven platform. Please try again shortly.');
    netErr.statusCode = null;
    netErr.cause = err;
    throw netErr;
  }
}

// ── Internal API (requires X-Internal-Key) ─────────────────────────────────────

function internal(method, path, body) {
  return request(method, `${BASE_URL}${API}/internal${path}`, body, internalHeaders());
}

// ── Public Auth API (no special header, but rate-limited) ─────────────────────

function auth(method, path, body, accessToken) {
  return request(method, `${BASE_URL}${API}/auth${path}`, body, authHeaders(accessToken));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL ROUTES — bot identity & data
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Identify an existing user by phone number.
 * Returns { role, userId, profileId, name, email, phone, ... } or throws 404.
 * Does NOT require a password — this is a bot-side lookup only.
 */
const resolveUser = (phone) => internal('POST', '/resolve-user', { phone });

// Customer
const getCustomerProfile  = (id)          => internal('GET',  `/customer/${id}/profile`);
const getCustomerRequests = (id)          => internal('GET',  `/customer/${id}/requests`);
const getCustomerBookings = (id, status)  => internal('GET',  `/customer/${id}/bookings${status ? `?status=${status}` : ''}`);

// Service requests & bookings
const createServiceRequest = (body)            => internal('POST', '/service-requests', body);
const getQuotes            = (requestId)       => internal('GET',  `/service-requests/${requestId}/quotes`);
const createBooking        = (body)            => internal('POST', '/bookings', body);
const cancelBooking        = (bookingId, body) => internal('POST', `/bookings/${bookingId}/cancel`, body);
const getBooking           = (bookingId)       => internal('GET',  `/bookings/${bookingId}`);

// Provider
const getProviderProfile   = (id)             => internal('GET',  `/provider/${id}/profile`);
const getProviderJobs      = (id, status)     => internal('GET',  `/provider/${id}/jobs${status ? `?status=${status}` : ''}`);
const completeJob          = (id, bookingId)  => internal('POST', `/provider/${id}/jobs/${bookingId}/complete`, {});
const startJob             = (id, bookingId)  => internal('POST', `/provider/${id}/jobs/${bookingId}/start`, {});
const getProviderInquiries = (id)             => internal('GET',  `/provider/${id}/inquiries`);

// Search
const searchProviders = (category, location) => {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (location) params.set('location', location);
  return internal('GET', `/providers?${params.toString()}`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC AUTH ROUTES — registration & token management
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a new customer.
 * Endpoint: POST /api/v1/auth/register/customer
 * Body: { fullName, email, phone, password }
 * Response: { user, customer, accessToken, refreshToken }
 *
 * NOTE: field is `fullName` not `name` — this was the previous bug.
 */
const registerCustomer = (fullName, email, phone, password) =>
  auth('POST', '/register/customer', { fullName, email, phone, password });

/**
 * Login with email + password.
 * Endpoint: POST /api/v1/auth/login
 * Body: { email, password }
 * Response: { user, profile, role, accessToken, refreshToken }
 *
 * NOTE: login requires EMAIL, not phone. The bot must have collected the email
 * during registration to be able to log the user back in.
 */
const loginWithEmail = (email, password) =>
  auth('POST', '/login', { email, password });

/**
 * Refresh an expired access token silently.
 * Endpoint: POST /api/v1/auth/refresh
 * Body: { refreshToken }
 * Response: { accessToken, refreshToken }
 */
const refreshAccessToken = (refreshToken) =>
  auth('POST', '/refresh', { refreshToken });

module.exports = {
  // Internal
  resolveUser,
  getCustomerProfile, getCustomerRequests, getCustomerBookings,
  createServiceRequest, getQuotes, createBooking, cancelBooking, getBooking,
  getProviderProfile, getProviderJobs, completeJob, startJob, getProviderInquiries,
  searchProviders,
  // Public auth
  registerCustomer,
  loginWithEmail,
  refreshAccessToken,
};
