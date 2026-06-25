/**
 * AI Agent — role-aware conversational assistant.
 *
 * Flow:
 * 1. Role is determined from session (resolved by roleResolver.js at message handler)
 * 2. Intent is extracted via Gemini (JSON, structured)
 * 3. If intent maps to a backend action, the action is executed
 * 4. Gemini generates a natural-language reply with the result
 */

const gemini  = require('./gemini');
const { buildExtractionPrompt, buildResponsePrompt } = require('./prompt');
const backend  = require('../api/backendClient');
const session  = require('../whatsapp/session');
const logger   = require('../config/logger');

const FALLBACK = "Sorry, I'm having trouble right now 🙏. Please try again in a moment.";

// ─── Intent normalization ─────────────────────────────────────────────────────

function normalizeIntent(raw, prev = {}) {
  const s = raw || {};
  return {
    service:                s.service   || prev.lastService  || null,
    location:               s.location  || prev.lastLocation || null,
    urgency:                ['low','normal','high'].includes(s.urgency) ? s.urgency : 'normal',
    budget:                 typeof s.budget === 'number' ? s.budget : prev.lastBudget || null,
    intent:                 s.intent || 'other',
    missing_info:           Array.isArray(s.missing_info) ? s.missing_info : [],
    selected_index:         typeof s.selected_index === 'number' ? s.selected_index : null,
    user_name:              s.user_name || null,
    action:                 s.action    || null,  // backend action to execute
    action_params:          s.action_params || {}, // params for the action
  };
}

// ─── Backend action executor ──────────────────────────────────────────────────

async function executeAction(intent, user) {
  const { action, action_params, selected_index } = intent;
  if (!action || !user) return null;

  try {
    switch (action) {

      // Customer actions
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

      // Provider actions
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
    return { type: 'error', message: err.message };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function handleUserMessage(phoneNumber, userMessage, user) {
  await session.appendMessage(phoneNumber, 'user', userMessage);

  const history  = await session.getRecentMessages(phoneNumber, 6);
  const prevPrefs = await session.getPreferences(phoneNumber);
  const lastShown = await session.getLastShownProviders(phoneNumber);

  // ── Greeting shortcut ──────────────────────────────────────────────────────
  const norm = userMessage.trim().toLowerCase();
  if (['hi','hello','hey','good morning','good afternoon','good evening'].includes(norm)) {
    const reply = buildWelcome(user);
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // ── Step 1: Extract intent ─────────────────────────────────────────────────
  let intent;
  try {
    const extractPrompt = buildExtractionPrompt(userMessage, history.slice(0,-1), prevPrefs, lastShown, user?.role);
    const rawIntent = await gemini.generateJSON(extractPrompt, { temperature: 0.1 });
    intent = normalizeIntent(rawIntent, prevPrefs);
  } catch (err) {
    logger.error('[agent] Intent extraction failed:', err.message);
    await session.appendMessage(phoneNumber, 'assistant', FALLBACK);
    return FALLBACK;
  }

  // Persist preferences
  const updatedPrefs = {
    lastService:  intent.service  || prevPrefs.lastService,
    lastLocation: intent.location || prevPrefs.lastLocation,
    lastBudget:   intent.budget   || prevPrefs.lastBudget,
  };
  if (intent.user_name && !prevPrefs.userName) updatedPrefs.userName = intent.user_name;
  await session.setPreferences(phoneNumber, updatedPrefs);

  const userName = updatedPrefs.userName || prevPrefs.userName || user?.name || null;

  // ── Step 2: Connect request (resolve from last shown) ─────────────────────
  if ((intent.intent === 'connect_request' || intent.selected_index != null) && lastShown.length) {
    const idx    = (intent.selected_index ?? 1) - 1;
    const chosen = lastShown[Math.max(0, Math.min(lastShown.length - 1, idx))];
    const reply  = buildConnectReply(chosen, userName);
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // ── Step 3: Execute backend action if intent has one ──────────────────────
  let actionResult = null;
  if (intent.action) {
    actionResult = await executeAction(intent, user);
  }

  // ── Step 4: Search providers if service intent and no action result ────────
  let providers = [];
  if (!actionResult && intent.service) {
    try {
      providers = await backend.searchProviders(intent.service, intent.location);
      await session.setLastShownProviders(phoneNumber, providers);
    } catch (err) {
      logger.error('[agent] Provider search failed:', err.message);
    }
  }

  // ── Step 5: Generate reply ─────────────────────────────────────────────────
  try {
    const responsePrompt = buildResponsePrompt({
      userMessage, intent, providers, actionResult, userName, role: user?.role,
    });
    const reply = await gemini.generateText(responsePrompt, { temperature: 0.5 });
    await session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  } catch (err) {
    logger.error('[agent] Response generation failed:', err.message);
    const fallback = buildDeterministicFallback(intent, providers, actionResult, userName, user?.role);
    await session.appendMessage(phoneNumber, 'assistant', fallback);
    return fallback;
  }
}

// ─── Deterministic fallbacks (no AI) ─────────────────────────────────────────

function buildWelcome(user) {
  if (!user) {
    return (
      `👋 Hi! Welcome to *Haven*.\n\n` +
      `Haven connects you to trusted service providers in your community.\n\n` +
      `📱 It looks like your number isn't registered yet.\n` +
      `Visit the Haven app to create an account, then come back here!\n\n` +
      `_Type /help for more options._`
    );
  }
  const name = user.name ?? '';
  if (user.role === 'PROVIDER') {
    return (
      `👋 Hi *${name}*! You're logged in as a provider.\n\n` +
      `Type *menu* to see your provider dashboard, or *jobs* to view your bookings.`
    );
  }
  return (
    `👋 Hi *${name}*! Welcome to Haven.\n\n` +
    `Just tell me what service you need and your area — I'll find the right person! 🙏\n\n` +
    `Or type *menu* for options.`
  );
}

function buildConnectReply(provider, userName) {
  const hi = userName ? `${userName}, ` : '';
  return (
    `${hi}here are *${provider.businessName ?? provider.name}*'s contact details:\n\n` +
    `📞 *${provider.phone}*\n` +
    `📍 ${provider.location}\n` +
    `⭐ ${provider.avgRating ?? provider.rating} rating | ${provider.totalReviews ?? provider.completed_jobs} jobs\n\n` +
    `Reach them directly by call or WhatsApp. 🙏\n` +
    `Let me know if you'd like to see other options!`
  );
}

function buildDeterministicFallback(intent, providers, actionResult, userName, role) {
  const hi = userName ? `${userName}, ` : '';

  if (actionResult?.type === 'error') {
    return `Sorry ${hi}I ran into an issue: _${actionResult.message}_\n\nPlease try again or visit the Haven app. 🙏`;
  }
  if (actionResult?.type === 'cancelled') {
    return `✅ Your booking has been cancelled, ${hi}. Let me know if you need help finding another provider!`;
  }
  if (actionResult?.type === 'completed') {
    return `🎉 Job marked complete! Well done ${hi}. The customer has been notified.`;
  }

  if (!intent.service && role !== 'PROVIDER') {
    return `${hi}What service do you need help with (e.g. electrician, plumber, cleaner), and which area are you in?`;
  }
  if (!providers.length && intent.service) {
    return `Sorry ${hi}I couldn't find any *${intent.service}s* near ${intent.location || 'your area'} right now. Would you like me to check nearby?`;
  }
  if (providers.length) {
    const lines = providers.slice(0, 3).map((p, i) =>
      `${i + 1}. *${p.businessName}* | ⭐${Number(p.avgRating).toFixed(1)} | 📍${p.location}`
    );
    return `Here are the top *${intent.service}s* near ${intent.location}:\n\n${lines.join('\n')}\n\nWould you like to connect with one?`;
  }

  return `${hi}How can I help you today? Type *menu* to see what I can do. 🙏`;
}

module.exports = { handleUserMessage };
