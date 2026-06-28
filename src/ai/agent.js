/**
 * AI Agent — context-aware, offline-resilient, registration-aware.
 *
 * KEY CHANGE: handleUserMessage now accepts an optional `regContext` parameter
 * (passed from messageHandler). This is woven into every prompt so Ava can
 * answer questions naturally AND gently continue registration in the same reply,
 * without ever trapping the user in a registration loop.
 */

const ai      = require('./aiClient');
const { buildExtractionPrompt, buildResponsePrompt } = require('./prompt');
const backend  = require('../api/backendClient');
const session  = require('../whatsapp/session');
const logger   = require('../config/logger');

const FALLBACK = "Sorry, I'm having a bit of trouble right now 🙏. Please try again in a moment!";

// ── Backend availability detection ─────────────────────────────────────────────

function isNetworkError(err) {
  if (err.statusCode) return false;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('could not reach') ||
    msg.includes('econnrefused')    ||
    msg.includes('timeout')         ||
    msg.includes('enotfound')       ||
    msg.includes('fetch')           ||
    msg.includes('network')
  );
}

// ── Intent normalization ───────────────────────────────────────────────────────

function normalizeIntent(raw, prev = {}) {
  const s = raw || {};
  return {
    service:        s.service        || prev.lastService  || null,
    location:       s.location       || prev.lastLocation || null,
    urgency:        ['low','normal','high'].includes(s.urgency) ? s.urgency : 'normal',
    budget:         typeof s.budget === 'number' ? s.budget : prev.lastBudget || null,
    intent:         s.intent         || 'other',
    missing_info:   Array.isArray(s.missing_info) ? s.missing_info : [],
    selected_index: typeof s.selected_index === 'number' ? s.selected_index : null,
    user_name:      s.user_name      || null,
    action:         s.action         || null,
    action_params:  s.action_params  || {},
    is_followup:    !!s.is_followup,
    topic_changed:  !!s.topic_changed,
  };
}

// ── Backend action executor ────────────────────────────────────────────────────

async function executeAction(intent, user) {
  const { action, action_params } = intent;
  if (!action || !user) return null;

  try {
    switch (action) {
      case 'search_providers': {
        const providers = await backend.searchProviders(intent.service, intent.location);
        return { type: 'providers', data: providers };
      }
      case 'get_my_requests': {
        const data = await backend.getCustomerRequests(user.profileId);
        return { type: 'requests', data };
      }
      case 'get_my_bookings': {
        const data = await backend.getCustomerBookings(user.profileId, action_params.status);
        return { type: 'bookings', data };
      }
      case 'get_booking_detail': {
        const id = action_params.bookingId;
        if (!id) return null;
        const data = await backend.getBooking(id);
        return { type: 'booking', data };
      }
      case 'get_quotes': {
        const id = action_params.requestId;
        if (!id) return null;
        const data = await backend.getQuotes(id);
        return { type: 'quotes', data };
      }
      case 'cancel_booking': {
        const id = action_params.bookingId;
        if (!id) return null;
        await backend.cancelBooking(id, { requesterId: user.profileId, requesterRole: 'CUSTOMER' });
        return { type: 'cancelled', data: { bookingId: id } };
      }
      case 'get_my_jobs': {
        const data = await backend.getProviderJobs(user.profileId, action_params.status);
        return { type: 'jobs', data };
      }
      case 'complete_job': {
        const id = action_params.bookingId;
        if (!id) return null;
        await backend.completeJob(user.profileId, id);
        return { type: 'completed', data: { bookingId: id } };
      }
      case 'start_job': {
        const id = action_params.bookingId;
        if (!id) return null;
        await backend.startJob(user.profileId, id);
        return { type: 'started', data: { bookingId: id } };
      }
      default:
        return null;
    }
  } catch (err) {
    logger.error('[agent] Action failed:', action, err.message);
    if (isNetworkError(err)) {
      return { type: 'error', message: 'Haven server is temporarily unavailable.', offline: true };
    }
    return { type: 'error', message: err.message };
  }
}

// ── Local provider search fallback ────────────────────────────────────────────

async function searchProvidersLocally(service, location) {
  try {
    const artisanService = require('../artisans/artisanService');
    return (await artisanService.search({ service, location })) || [];
  } catch (err) {
    logger.warn('[agent] Local provider search failed:', err.message);
    return [];
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * @param {string}      phoneNumber  - session key (WhatsApp JID)
 * @param {string}      userMessage  - raw message text
 * @param {object|null} user         - resolved user (may be null or provisional)
 * @param {object|null} regContext   - from registration.js (state, flags, etc.)
 */
async function handleUserMessage(phoneNumber, userMessage, user, regContext = null) {
  await session.appendMessage(phoneNumber, 'user', userMessage);

  const history   = await session.getRecentMessages(phoneNumber, 20);
  const prevPrefs = await session.getPreferences(phoneNumber);
  const lastShown = await session.getLastShownProviders(phoneNumber);

  // Exclude the message we just appended from the history passed to the AI
  const historyContext = history.slice(0, -1);

  const norm     = userMessage.trim().toLowerCase();
  const userName = prevPrefs.userName || (user && user.name) || null;

  // ── Greeting shortcut ──────────────────────────────────────────────────────
  // Still give the AI a chance to weave in registration nudge, so greetings
  // don't just get a canned reply when registration is in progress.
  const GREETINGS = ['hi','hello','hey','good morning','good afternoon','good evening','sup','howdy','yo'];
  if (GREETINGS.includes(norm) && (!regContext || regContext.isAuthenticated)) {
    const reply = buildWelcome(user, userName);
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // ── Step 1: Extract intent ───────────────────────────────────────────────
  let intent;
  try {
    const extractPrompt = buildExtractionPrompt(
      userMessage,
      historyContext,
      prevPrefs,
      lastShown,
      user && user.role
    );
    const rawIntent = await ai.generateJSON(extractPrompt, { temperature: 0.1 });
    intent = normalizeIntent(rawIntent, prevPrefs);
  } catch (err) {
    logger.error('[agent] Intent extraction failed:', err.message);
    await session.appendMessage(phoneNumber, 'assistant', FALLBACK);
    return FALLBACK;
  }

  // Persist useful context for follow-up resolution
  const updatedPrefs = {};
  if (intent.service)   updatedPrefs.lastService  = intent.service;
  if (intent.location)  updatedPrefs.lastLocation = intent.location;
  if (intent.budget)    updatedPrefs.lastBudget   = intent.budget;
  if (intent.user_name && !prevPrefs.userName) updatedPrefs.userName = intent.user_name;
  if (Object.keys(updatedPrefs).length) {
    await session.setPreferences(phoneNumber, updatedPrefs);
  }

  const effectiveName = updatedPrefs.userName || prevPrefs.userName || (user && user.name) || null;

  // ── Step 2: Handle "connect me to #N" ────────────────────────────────────
  if ((intent.intent === 'connect_request' || intent.selected_index != null) && lastShown.length) {
    const idx    = (intent.selected_index != null ? intent.selected_index : 1) - 1;
    const chosen = lastShown[Math.max(0, Math.min(lastShown.length - 1, idx))];
    const reply  = buildConnectReply(chosen, effectiveName);
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // ── Step 3: Execute backend action ────────────────────────────────────────
  let actionResult   = null;
  let backendOffline = false;

  if (intent.action && user && user.profileId) {
    actionResult = await executeAction(intent, user);
    if (actionResult && actionResult.offline) {
      backendOffline = true;
    }
  } else if (intent.action && (!user || !user.profileId)) {
    // Action requires auth but user isn't confirmed yet — inform the AI
    actionResult = {
      type: 'error',
      message: 'This action requires a verified Haven account.',
      needsAuth: true,
    };
  }

  // ── Step 4: Provider search ───────────────────────────────────────────────
  let providers = [];
  if (!actionResult && intent.service) {
    try {
      providers = await backend.searchProviders(intent.service, intent.location);
      if (providers.length) {
        await session.setLastShownProviders(phoneNumber, providers);
      }
    } catch (err) {
      if (isNetworkError(err)) {
        logger.warn('[agent] Backend offline — trying local provider search');
        backendOffline = true;
        providers = await searchProvidersLocally(intent.service, intent.location);
        if (providers.length) {
          await session.setLastShownProviders(phoneNumber, providers);
        }
      } else {
        logger.error('[agent] Provider search failed:', err.message);
      }
    }
  }

  // ── Step 5: Generate AI reply ─────────────────────────────────────────────
  try {
    const { system, user: userPrompt } = buildResponsePrompt({
      userMessage,
      intent,
      providers,
      actionResult,
      userName:      effectiveName,
      role:          user && user.role,
      history:       historyContext,
      backendOffline,
      regContext,      // ← passed through so Ava can weave registration naturally
    });
    const reply = await ai.generateText(userPrompt, { temperature: 0.55, system });
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  } catch (err) {
    logger.error('[agent] Response generation failed:', err.message);
    const fallback = buildDeterministicFallback(
      intent, providers, actionResult, effectiveName, user && user.role, backendOffline, regContext
    );
    await session.appendMessage(phoneNumber, 'assistant', fallback);
    return fallback;
  }
}

// ── Deterministic fallbacks ────────────────────────────────────────────────────

function buildWelcome(user, userName) {
  if (!user) {
    return (
      `👋 Welcome to *Haven*!\n\n` +
      `I'm Ava, your Haven assistant. I can help you find trusted service providers, ` +
      `answer questions, and get you started. What can I do for you?`
    );
  }
  const name = userName || user.name || '';
  const hi   = name ? `Hi *${name}*! ` : `Hi! `;
  if (user.role === 'PROVIDER') {
    return `👋 ${hi}Great to see you.\n\nType *menu* to see your dashboard, or *jobs* to view active bookings.`;
  }
  return (
    `👋 ${hi}Welcome back to Haven.\n\n` +
    `Tell me what service you need and your area — I'll find the right person! 🙏\n\n` +
    `Or type *menu* for options.`
  );
}

function buildConnectReply(provider, userName) {
  const hi = userName ? `${userName}, ` : '';
  return (
    `${hi}here are *${provider.businessName || provider.name}*'s contact details:\n\n` +
    `📞 *${provider.phone}*\n` +
    `📍 ${provider.location}\n` +
    `⭐ ${provider.avgRating || provider.rating} rating\n\n` +
    `You can reach them directly by call or WhatsApp. 🙏\n` +
    `Let me know if you'd like to see other options!`
  );
}

function buildDeterministicFallback(intent, providers, actionResult, userName, role, backendOffline, regContext) {
  const hi = userName ? `${userName}, ` : '';

  if (actionResult && actionResult.needsAuth) {
    const step = regContext && regContext.state;
    if (step === 'awaiting_phone' || step === 'new') {
      return `To do that I'll need your Haven account — just share your phone number to get started! 📱`;
    }
    return `I need your verified Haven account for that. Let's finish setting it up first! 🙏`;
  }
  if (backendOffline && !providers.length) {
    return `${hi}I'm having trouble reaching the Haven server right now. I can still answer general questions — what would you like to know? 🙏`;
  }
  if (actionResult && actionResult.type === 'error') {
    return `Sorry ${hi}I ran into an issue: _${actionResult.message}_\n\nPlease try again shortly. 🙏`;
  }
  if (actionResult && actionResult.type === 'cancelled') {
    return `✅ Done ${hi}— your booking has been cancelled. Let me know if you need help finding another provider!`;
  }
  if (actionResult && actionResult.type === 'completed') {
    return `🎉 Job marked complete! Well done ${hi}. The customer has been notified.`;
  }
  if (!intent.service && role !== 'PROVIDER') {
    return `${hi}what service do you need (e.g. electrician, plumber, cleaner), and which area are you in?`;
  }
  if (!providers.length && intent.service) {
    return `Sorry ${hi}I couldn't find *${intent.service}s* near ${intent.location || 'your area'} right now. Would you like me to check nearby areas?`;
  }
  if (providers.length) {
    const lines = providers.slice(0, 3).map((p, i) =>
      `${i + 1}. *${p.businessName || p.name}* | ⭐${Number(p.avgRating || p.rating || 0).toFixed(1)} | 📍${p.location}`
    );
    return `Here are the top *${intent.service}s* near ${intent.location}:\n\n${lines.join('\n')}\n\nWould you like to connect with one?`;
  }
  return `${hi}how can I help you today? Type *menu* to see what I can do. 🙏`;
}

module.exports = { handleUserMessage };
