/**
 * Backend API client for the WhatsApp bot.
 * All calls go through the /api/v1/internal/* routes, authenticated
 * with the shared INTERNAL_API_KEY (X-Internal-Key header).
 */

const logger = require('../config/logger');

const BASE_URL   = process.env.BACKEND_BASE_URL ?? 'http://localhost:3001';
const API_KEY    = process.env.INTERNAL_API_KEY ?? '';
const TIMEOUT_MS = 10_000;

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Key': API_KEY,
  };
}

async function request(method, path, body) {
  const url = `${BASE_URL}/api/v1/internal${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json = await res.json();

    if (!res.ok) {
      const err = new Error(json?.message ?? `Backend returned ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }

    return json.data ?? json;
  } catch (err) {
    if (err.statusCode) throw err; // re-throw known errors
    logger.error(`[backendClient] ${method} ${path} failed:`, err.message);
    throw new Error('Could not reach the Haven platform. Please try again shortly.');
  }
}

const get  = (path)        => request('GET',  path, null);
const post = (path, body)  => request('POST', path, body);

// ─── User resolution ──────────────────────────────────────────────────────────
const resolveUser = (phone) => post('/resolve-user', { phone });

// ─── Customer ─────────────────────────────────────────────────────────────────
const getCustomerProfile  = (id)             => get(`/customer/${id}/profile`);
const getCustomerRequests = (id)             => get(`/customer/${id}/requests`);
const getCustomerBookings = (id, status)     => get(`/customer/${id}/bookings${status ? `?status=${status}` : ''}`);
const createServiceRequest = (body)          => post('/service-requests', body);
const getQuotes           = (requestId)      => get(`/service-requests/${requestId}/quotes`);
const createBooking       = (body)           => post('/bookings', body);
const cancelBooking       = (bookingId, body) => post(`/bookings/${bookingId}/cancel`, body);
const getBooking          = (bookingId)      => get(`/bookings/${bookingId}`);

// ─── Provider ─────────────────────────────────────────────────────────────────
const getProviderProfile  = (id)             => get(`/provider/${id}/profile`);
const getProviderJobs     = (id, status)     => get(`/provider/${id}/jobs${status ? `?status=${status}` : ''}`);
const completeJob         = (id, bookingId)  => post(`/provider/${id}/jobs/${bookingId}/complete`, {});
const startJob            = (id, bookingId)  => post(`/provider/${id}/jobs/${bookingId}/start`, {});
const getProviderInquiries = (id)            => get(`/provider/${id}/inquiries`);

// ─── Search ───────────────────────────────────────────────────────────────────
const searchProviders = (category, location) => {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (location)  params.set('location', location);
  return get(`/providers?${params.toString()}`);
};

module.exports = {
  resolveUser,
  getCustomerProfile, getCustomerRequests, getCustomerBookings,
  createServiceRequest, getQuotes, createBooking, cancelBooking, getBooking,
  getProviderProfile, getProviderJobs, completeJob, startJob, getProviderInquiries,
  searchProviders,
};
