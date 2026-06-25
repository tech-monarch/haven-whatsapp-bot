const CUSTOMER_SYSTEM = `You are Haven's WhatsApp assistant — a warm, efficient helper for service requests.
Haven connects customers to trusted service providers (plumbers, electricians, cleaners, mechanics, etc.).
Your job: understand what the customer needs, help them find providers, check their requests/bookings, and take actions.
Rules:
- Never invent data. Only use results given to you.
- Keep replies short and clear — WhatsApp format (*bold*, _italic_, emojis, newlines).
- Max 150 words per reply unless listing results.
- Never claim to have booked or paid on the customer's behalf without confirmation.`;

const PROVIDER_SYSTEM = `You are Haven's WhatsApp assistant for service providers (artisans).
Haven connects providers to customers needing their services.
Your job: help providers view jobs, update job status, and manage their bookings.
Rules:
- Keep replies short and clear — WhatsApp format.
- Never invent job or customer data. Only use results given to you.
- Max 150 words unless listing jobs.`;

const UNKNOWN_SYSTEM = `You are Haven's WhatsApp assistant.
Haven is a service marketplace connecting customers to trusted providers in Nigeria.
If the person is not registered, explain how to sign up and direct them to the Haven app.`;

function systemFor(role) {
  if (role === 'CUSTOMER') return CUSTOMER_SYSTEM;
  if (role === 'PROVIDER') return PROVIDER_SYSTEM;
  return UNKNOWN_SYSTEM;
}

// ─── Intent extraction ────────────────────────────────────────────────────────

function buildExtractionPrompt(userMessage, history = [], prevPrefs = {}, lastShownProviders = [], role = null) {
  const histBlock = history.length
    ? `Conversation history:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.text}`).join('\n')}\n`
    : '';

  const shownBlock = lastShownProviders.length
    ? `Providers shown in last reply:\n${lastShownProviders.map((p,i) => `${i+1}. ${p.businessName ?? p.name} | ${p.category} | ${p.location}`).join('\n')}\n`
    : '';

  const roleHint = role ? `User role: ${role}\n` : '';

  // Available actions depend on role
  const actions = role === 'PROVIDER'
    ? `"get_my_jobs","complete_job","start_job"`
    : `"search_providers","get_my_requests","get_my_bookings","get_booking_detail","get_quotes","cancel_booking"`;

  return `${roleHint}${histBlock}${shownBlock}
New message: "${userMessage}"

Extract intent and respond ONLY with valid JSON (no markdown, no commentary):

{
  "service": string|null,
  "location": string|null,
  "urgency": "low"|"normal"|"high",
  "budget": number|null,
  "intent": "search_provider"|"check_status"|"connect_request"|"take_action"|"greeting"|"other",
  "missing_info": string[],
  "selected_index": number|null,
  "user_name": string|null,
  "action": ${actions}|null,
  "action_params": {}
}

Notes:
- "action": set if user wants to perform a platform action (e.g. "show my orders" → "get_my_bookings"; "complete job 12345" → "complete_job")
- "action_params": include relevant IDs extracted from message (e.g. { "bookingId": "12345678" })
- "selected_index": 1-based if user picks from a list ("the first one", "#2", etc.)
- "urgency": "high" if user says urgent/emergency/asap
- "missing_info": fields still needed (e.g. ["location"] if service known but location missing)
Only output the JSON object.`;
}

// ─── Response generation ──────────────────────────────────────────────────────

function buildResponsePrompt({ userMessage, intent, providers, actionResult, userName, role }) {
  const system = systemFor(role);
  const greeting = userName ? `, ${userName}` : '';

  let dataBlock = '';

  if (actionResult) {
    if (actionResult.type === 'error') {
      dataBlock = `Action failed: ${actionResult.message}`;
    } else if (actionResult.type === 'requests') {
      dataBlock = `Active service requests:\n${formatRequests(actionResult.data)}`;
    } else if (actionResult.type === 'bookings') {
      dataBlock = `Bookings:\n${formatBookings(actionResult.data)}`;
    } else if (actionResult.type === 'jobs') {
      dataBlock = `Provider jobs:\n${formatJobs(actionResult.data)}`;
    } else if (actionResult.type === 'providers' || actionResult.type === 'quotes') {
      dataBlock = `Available providers:\n${formatProviders(actionResult.data)}`;
    } else if (actionResult.type === 'cancelled') {
      dataBlock = `Booking successfully cancelled.`;
    } else if (actionResult.type === 'completed') {
      dataBlock = `Job successfully marked as completed.`;
    } else if (actionResult.type === 'started') {
      dataBlock = `Job successfully marked as in progress.`;
    }
  } else if (providers.length) {
    dataBlock = `Matching providers:\n${formatProviders(providers)}`;
  } else if (intent.service) {
    dataBlock = `No providers found for "${intent.service}" in "${intent.location ?? 'the area'}"`;
  }

  return `${system}

User message: "${userMessage}"
Intent: ${JSON.stringify(intent)}
Data: ${dataBlock || 'none'}

Write a short WhatsApp reply${greeting ? ` to ${userName}` : ''}:
- Present data clearly if provided.
- If missing_info is non-empty, ask for ONE missing field.
- If providers are listed, show top 3 with name, rating, location, phone.
- End with a clear next step.
- Use *bold*, emojis, line breaks. Max 150 words.`;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmt(n) { return Number(n).toLocaleString('en-NG'); }
function date(d) { return d ? new Date(d).toLocaleDateString('en-NG', { day:'numeric', month:'short' }) : '—'; }

function formatProviders(providers = []) {
  return providers.slice(0, 5).map((p, i) =>
    `${i+1}. ${p.businessName} | ⭐${Number(p.avgRating ?? p.rating ?? 0).toFixed(1)} | 📍${p.location} | 📞${p.phone}`
  ).join('\n');
}

function formatRequests(reqs = []) {
  return reqs.slice(0, 5).map((r, i) =>
    `${i+1}. ${r.category} | ${r.status} | ${date(r.preferredDate)} | ${r.address}`
  ).join('\n');
}

function formatBookings(bookings = []) {
  return bookings.slice(0, 5).map((b, i) =>
    `${i+1}. ${b.provider?.businessName} | ${b.status} | ₦${fmt(b.amount)} | ${date(b.scheduledAt)}`
  ).join('\n');
}

function formatJobs(jobs = []) {
  return jobs.slice(0, 8).map((b, i) =>
    `${i+1}. ${b.customer?.fullName} | ${b.serviceRequest?.category} | ${b.status} | ₦${fmt(b.amount)} | ID:${b.id?.slice(0,8)}`
  ).join('\n');
}

module.exports = {
  buildExtractionPrompt,
  buildResponsePrompt,
  CUSTOMER_SYSTEM,
  PROVIDER_SYSTEM,
};
