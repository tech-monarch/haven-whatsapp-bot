/**
 * Prompt builder — context-aware, human-like AI conversation prompts.
 *
 * KEY IMPROVEMENT: The system prompt now receives a `regContext` block that
 * tells Ava exactly where the user is in the registration flow. This lets her:
 *   - Answer any question naturally regardless of registration state
 *   - Gently nudge the user back to registration when appropriate
 *   - Never trap the user in a registration loop
 *   - Sound human throughout
 *
 * Example behaviour:
 *   State: awaiting_phone
 *   User: "What services do you offer?"
 *   Ava: "We help connect you to vetted plumbers, electricians, cleaners... 
 *         [answers fully] ...By the way, whenever you're ready, just share 
 *         your phone number so I can pull up your account! 😊"
 */

// ── System prompts ─────────────────────────────────────────────────────────────

const CUSTOMER_SYSTEM = `You are Ava, Haven's friendly WhatsApp assistant.
Haven is a Nigerian marketplace connecting customers to vetted service providers — plumbers, electricians, cleaners, painters, mechanics, carpenters, and more.

Your personality:
- Warm, patient, conversational — like a helpful neighbour, never a call-centre bot.
- WhatsApp format: *bold*, _italic_, emojis, newlines. No markdown headers or bullet walls.
- You remember the full conversation and refer back naturally ("as I mentioned…", "like you said earlier…").
- Handle small talk, jokes, and casual questions with ease.
- Never sound scripted. Vary phrasing. Never repeat yourself.
- Keep replies short (1–3 sentences) for simple exchanges; be detailed only when listing results or giving instructions.
- Never invent provider data, prices, or booking status. Only use results given to you.
- Never claim to have booked or paid on the user's behalf without explicit confirmation.
- Max 180 words per reply unless listing search results.`;

const PROVIDER_SYSTEM = `You are Ava, Haven's WhatsApp assistant for service providers.

Your personality:
- Professional but warm — a business partner helping providers succeed.
- WhatsApp format: *bold*, emojis, line breaks. Concise by default.
- You remember the full conversation and refer back naturally.
- Never invent job, customer, or payment data.
- Max 180 words unless listing jobs.`;

const UNKNOWN_SYSTEM = `You are Ava, Haven's WhatsApp assistant.
Haven is a Nigerian marketplace connecting customers to trusted service providers.

Your personality:
- Friendly, helpful, conversational.
- Answer any question about Haven naturally — services, how it works, pricing ranges, areas covered.
- The user hasn't verified their account yet, but you can still have a full conversation.
- Max 180 words.`;

function systemFor(role) {
  if (role === 'CUSTOMER') return CUSTOMER_SYSTEM;
  if (role === 'PROVIDER') return PROVIDER_SYSTEM;
  return UNKNOWN_SYSTEM;
}

// ── Registration context block ─────────────────────────────────────────────────

/**
 * Builds the registration guidance block injected into every system prompt.
 * This is the core of "registration is not a hard gate".
 *
 * @param {object} regContext - from registration.js
 */
function buildRegBlock(regContext) {
  if (!regContext) return '';

  const { state, confirmedPhone, userName, userEmail, isAuthenticated, isPending } = regContext;

  if (isAuthenticated) {
    return `\n[REGISTRATION: Complete. User is fully authenticated.]\n`;
  }

  if (isPending) {
    return (
      `\n[REGISTRATION STATUS: Account saved locally, syncing to server in background.` +
      `User is ${userName || 'using a provisional session'}. ` +
      `They can do everything except account-specific backend actions until sync completes.` +
      ` Do NOT mention this to the user unless they ask about their account.]\n`
    );
  }

  const stateGuidance = {
    new: `You haven't asked for their phone number yet. After answering their question, gently invite them to share their phone number to get started.`,
    awaiting_phone: `You've asked for their phone number. After answering their question, gently remind them to share it (e.g. "Whenever you're ready, just send me your number!").`,
    awaiting_confirm: `They provided a number${confirmedPhone ? ` (${confirmedPhone})` : ''} and you asked them to confirm. After answering, remind them to reply YES or NO.`,
    authenticating: `You're looking up their account. Just answer their question normally.`,
    collecting_name: `You're collecting their full name for registration. After answering, ask for their name again naturally.`,
    collecting_email: `You have their name${userName ? ` (${userName})` : ''}. You're waiting for their email. After answering, gently ask for it.`,
    collecting_password: `You have their name${userName ? ` (${userName})` : ''}${userEmail ? ` and email (${userEmail})` : ''}. You're waiting for a password (min 6 chars). After answering, remind them.`,
  };

  const guidance = stateGuidance[state] || `Registration in progress (state: ${state}). Answer normally and continue when appropriate.`;

  return (
    `\n[REGISTRATION STATUS: In progress (step: ${state}). ` +
    `IMPORTANT: Do NOT ignore or trap the user — answer their question fully first. ` +
    `Then, naturally and briefly, continue the registration: ${guidance}]\n`
  );
}

// ── Intent extraction ──────────────────────────────────────────────────────────

function buildExtractionPrompt(userMessage, history = [], prevPrefs = {}, lastShownProviders = [], role = null) {
  const roleHint = role ? `User role: ${role}\n` : '';

  const histBlock = history.length
    ? `Conversation so far:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Ava'}: ${m.text}`).join('\n')}\n`
    : '';

  const prevContext = [];
  if (prevPrefs.lastService)  prevContext.push(`Last service: ${prevPrefs.lastService}`);
  if (prevPrefs.lastLocation) prevContext.push(`Last location: ${prevPrefs.lastLocation}`);
  if (prevPrefs.userName)     prevContext.push(`User name: ${prevPrefs.userName}`);
  const contextBlock = prevContext.length ? `Known context:\n${prevContext.join('\n')}\n` : '';

  const shownBlock = lastShownProviders.length
    ? `Providers shown in last reply:\n${lastShownProviders.map((p, i) => `${i + 1}. ${p.businessName || p.name} | ${p.category} | ${p.location}`).join('\n')}\n`
    : '';

  const actions = role === 'PROVIDER'
    ? `"get_my_jobs","complete_job","start_job"`
    : `"search_providers","get_my_requests","get_my_bookings","get_booking_detail","get_quotes","cancel_booking"`;

  return `${roleHint}${histBlock}${contextBlock}${shownBlock}
New message: "${userMessage}"

Extract intent. Respond ONLY with valid JSON (no markdown, no commentary):

{
  "service": string|null,
  "location": string|null,
  "urgency": "low"|"normal"|"high",
  "budget": number|null,
  "intent": "search_provider"|"check_status"|"connect_request"|"take_action"|"greeting"|"small_talk"|"question"|"other",
  "missing_info": string[],
  "selected_index": number|null,
  "user_name": string|null,
  "action": ${actions}|null,
  "action_params": {},
  "is_followup": boolean,
  "topic_changed": boolean
}

Notes:
- "is_followup": true if message only makes sense with earlier context ("the second one", "what about Lagos?")
- "topic_changed": true if user shifts to a completely different subject
- "selected_index": 1-based if user picks from a list
- "urgency": "high" if they say urgent/emergency/ASAP
- Resolve pronouns from history ("them" → last mentioned provider)
Only output the JSON object.`;
}

// ── Response generation ────────────────────────────────────────────────────────

/**
 * Returns { system, user } for the system/user role split.
 */
function buildResponsePrompt({
  userMessage,
  intent,
  providers,
  actionResult,
  userName,
  role,
  history        = [],
  backendOffline = false,
  regContext     = null,
}) {
  const baseSystem = systemFor(role);
  const regBlock   = buildRegBlock(regContext);
  const system     = baseSystem + regBlock;
  const nameStr    = userName ? `, ${userName}` : '';

  // Data block
  let dataBlock = '';
  if (backendOffline && !providers.length) {
    dataBlock = `[Haven server temporarily unavailable. Answer general questions. Do not attempt account-specific actions.]`;
  } else if (actionResult) {
    if (actionResult.type === 'error') {
      dataBlock = `Action failed: ${actionResult.message}\nExplain naturally and suggest retrying.`;
    } else if (actionResult.type === 'requests')  dataBlock = `Service requests:\n${formatRequests(actionResult.data)}`;
    else if (actionResult.type === 'bookings')     dataBlock = `Bookings:\n${formatBookings(actionResult.data)}`;
    else if (actionResult.type === 'jobs')         dataBlock = `Provider jobs:\n${formatJobs(actionResult.data)}`;
    else if (actionResult.type === 'providers' || actionResult.type === 'quotes')
                                                   dataBlock = `Matching providers:\n${formatProviders(actionResult.data)}`;
    else if (actionResult.type === 'cancelled')    dataBlock = `Booking cancelled successfully.`;
    else if (actionResult.type === 'completed')    dataBlock = `Job marked complete.`;
    else if (actionResult.type === 'started')      dataBlock = `Job marked in progress.`;
  } else if (providers && providers.length) {
    dataBlock = `Matching providers:\n${formatProviders(providers)}`;
  } else if (intent.service) {
    dataBlock = `No providers found for "${intent.service}" in "${intent.location || 'the area'}".`;
  }

  const histBlock = history.length
    ? `Recent conversation:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Ava'}: ${m.text}`).join('\n')}\n`
    : '';

  const followupNote = intent.is_followup ? `This is a follow-up — refer back naturally.\n` : '';
  const topicNote    = intent.topic_changed ? `User changed topic — transition smoothly.\n` : '';

  const userPrompt =
    `${histBlock}\nUser message: "${userMessage}"\nIntent: ${JSON.stringify(intent)}\nData: ${dataBlock || 'none'}\n\n` +
    `${followupNote}${topicNote}` +
    `Write Ava's WhatsApp reply${nameStr ? ` to ${userName}` : ''}:\n` +
    `- Answer the user's actual question or request fully.\n` +
    `- If registration is in progress (see system prompt), weave the next step in naturally at the end — never before answering.\n` +
    `- If data provided, present it clearly.\n` +
    `- Follow-ups: reference context naturally without repeating full lists.\n` +
    `- Clarifying questions: ask ONE at a time.\n` +
    `- Provider lists: top 3 with name, rating, location, phone. Offer to connect.\n` +
    `- Small talk/greetings: warm and brief, steer gently toward helping.\n` +
    `- If backend unavailable for a specific feature, say so naturally and offer alternatives.\n` +
    `- End with a clear helpful next step.\n` +
    `- *Bold* key info, emojis sparingly, WhatsApp line-break style.\n` +
    `- Concise for simple exchanges; thorough when presenting results.`;

  return { system, user: userPrompt };
}

// ── Format helpers ─────────────────────────────────────────────────────────────

function fmt(n)  { return Number(n).toLocaleString('en-NG'); }
function date(d) { return d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : '—'; }

function formatProviders(providers = []) {
  return providers.slice(0, 5).map((p, i) =>
    `${i + 1}. *${p.businessName || p.name}* | ⭐${Number(p.avgRating || p.rating || 0).toFixed(1)} | 📍${p.location} | 📞${p.phone}`
  ).join('\n');
}

function formatRequests(reqs = []) {
  return reqs.slice(0, 5).map((r, i) =>
    `${i + 1}. ${r.category} | ${r.status} | ${date(r.preferredDate)} | ${r.address}`
  ).join('\n');
}

function formatBookings(bookings = []) {
  return bookings.slice(0, 5).map((b, i) =>
    `${i + 1}. ${b.provider && b.provider.businessName} | ${b.status} | ₦${fmt(b.amount)} | ${date(b.scheduledAt)}`
  ).join('\n');
}

function formatJobs(jobs = []) {
  return jobs.slice(0, 8).map((b, i) =>
    `${i + 1}. ${b.customer && b.customer.fullName} | ${b.serviceRequest && b.serviceRequest.category} | ${b.status} | ₦${fmt(b.amount)} | ID:${b.id ? b.id.slice(0, 8) : '—'}`
  ).join('\n');
}

module.exports = {
  buildExtractionPrompt,
  buildResponsePrompt,
  systemFor,
  buildRegBlock,
  CUSTOMER_SYSTEM,
  PROVIDER_SYSTEM,
};
