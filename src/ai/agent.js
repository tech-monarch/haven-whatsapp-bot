const gemini = require('./gemini');
const { buildExtractionPrompt, buildResponsePrompt } = require('./prompt');
const artisanService = require('../artisans/artisanService');
const session = require('../whatsapp/session');
const logger = require('../config/logger');

const FALLBACK_NO_AI_REPLY =
  "Sorry, I'm having trouble understanding right now 🙏. Could you tell me again — what service do you need, and what area are you in?";

function normalizeIntent(raw, previousPrefs = {}) {
  const safe = raw || {};
  return {
    service:                safe.service                || previousPrefs.lastService  || null,
    location:               safe.location               || previousPrefs.lastLocation || null,
    urgency:                ['low', 'normal', 'high'].includes(safe.urgency) ? safe.urgency : 'normal',
    budget:                 typeof safe.budget === 'number' ? safe.budget : previousPrefs.lastBudget || null,
    requirements:           safe.requirements           || null,
    intent:                 safe.intent                 || 'other',
    missing_info:           Array.isArray(safe.missing_info) ? safe.missing_info : [],
    selected_artisan_index: typeof safe.selected_artisan_index === 'number' ? safe.selected_artisan_index : null,
    user_name:              safe.user_name              || null,
  };
}

// ---------------------------------------------------------------------------
// Connect reply — no AI call, deterministic
// ---------------------------------------------------------------------------

function buildConnectReply(artisan, userName) {
  const greeting  = userName ? `${userName}, g` : 'G';
  const avail     = artisan.available ? '✅ Available now' : '🕒 Currently unavailable';
  const phone     = artisan.phone || 'not listed';
  return (
    `${greeting}reat choice! Here are *${artisan.name}*'s details:\n\n` +
    `📞 *${phone}*\n` +
    `📍 ${artisan.location}\n` +
    `⭐ ${artisan.rating} rating | ${artisan.completed_jobs} jobs\n` +
    `${avail}\n\n` +
    `You can call or WhatsApp them directly. Let me know if you'd like to see other options! 🙏`
  );
}

// ---------------------------------------------------------------------------
// Deterministic greeting — no AI call needed
// ---------------------------------------------------------------------------

function buildGreetingReply(userName) {
  const name = userName ? `, ${userName}` : '';
  return (
    `Hi${name}! 👋 I'm the *Haven* bot — I help you find trusted artisans nearby.\n\n` +
    `I can find you:\n` +
    `🔌 Electricians  🔧 Plumbers\n` +
    `🚗 Mechanics  🧹 Cleaners\n` +
    `❄️ Technicians  🪵 Carpenters  🎨 Painters\n\n` +
    `Just tell me *what service you need* and *your area*, and I'll find the best options for you!\n\n` +
    `_Type /help anytime for more options._`
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process one inbound WhatsApp message and return the reply text.
 *
 * @param {string} phoneNumber
 * @param {string} userMessage
 */
async function handleUserMessage(phoneNumber, userMessage) {
  session.appendMessage(phoneNumber, 'user', userMessage);

  const history   = session.getRecentMessages(phoneNumber, 6);
  const prevPrefs = session.getPreferences(phoneNumber);

  // ------------------------------------------------------------------
  // Step 1: extract structured intent via Gemini (low temperature)
  // ------------------------------------------------------------------
  let intent;
  try {
    const extractionPrompt = buildExtractionPrompt(
      userMessage,
      history.slice(0, -1), // everything except the message we just appended
      prevPrefs
    );
    const rawIntent = await gemini.generateJSON(extractionPrompt, { temperature: 0.1 });
    intent = normalizeIntent(rawIntent, prevPrefs);
  } catch (err) {
    logger.error('[agent] Intent extraction failed:', err.message);
    session.appendMessage(phoneNumber, 'assistant', FALLBACK_NO_AI_REPLY);
    return FALLBACK_NO_AI_REPLY;
  }

  // Persist useful signal for future turns
  const updatedPrefs = {
    lastService:  intent.service  || prevPrefs.lastService,
    lastLocation: intent.location || prevPrefs.lastLocation,
    lastBudget:   intent.budget   || prevPrefs.lastBudget,
  };
  // Capture user name once
  if (intent.user_name && !prevPrefs.userName) {
    updatedPrefs.userName = intent.user_name;
  }
  session.setPreferences(phoneNumber, updatedPrefs);

  const userName = updatedPrefs.userName || prevPrefs.userName || null;

  // ------------------------------------------------------------------
  // Step 2a: Greetings — no search, no second AI call
  // ------------------------------------------------------------------
  if (intent.intent === 'greeting' && !intent.service && !intent.location) {
    const reply = buildGreetingReply(userName);
    session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // ------------------------------------------------------------------
  // Step 2b: connect_request — resolve from last shown artisans, no search
  // ------------------------------------------------------------------
  if (intent.intent === 'connect_request' || intent.selected_artisan_index != null) {
    const lastShown = session.getLastShownArtisans(phoneNumber);

    if (lastShown.length > 0) {
      // selected_artisan_index is 1-based; default to first if unclear
      const idx     = (intent.selected_artisan_index ?? 1) - 1;
      const clamped = Math.max(0, Math.min(lastShown.length - 1, idx));
      const chosen  = lastShown[clamped];

      const reply = buildConnectReply(chosen, userName);
      session.appendMessage(phoneNumber, 'assistant', reply);
      return reply;
    }

    // User said "connect me" but we haven't shown results yet — ask what they need
    if (!intent.service) {
      const reply = "Sure, I can help you connect! What service do you need, and which area are you in?";
      session.appendMessage(phoneNumber, 'assistant', reply);
      return reply;
    }
    // Fall through to search if we have a service
  }

  // ------------------------------------------------------------------
  // Step 3: search artisans (only when we have enough info)
  // ------------------------------------------------------------------
  let artisans = [];

  if (intent.service) {
    try {
      artisans = await artisanService.searchArtisans({
        service:  intent.service,
        location: intent.location,
        urgency:  intent.urgency,
        budget:   intent.budget,
      });
      // Remember what we showed so connect_request can reference it
      session.setLastShownArtisans(phoneNumber, artisans);
    } catch (err) {
      logger.error('[agent] Artisan search failed:', err.message);
      artisans = [];
    }
  }

  // ------------------------------------------------------------------
  // Step 4: generate natural-language reply via Gemini
  // ------------------------------------------------------------------
  try {
    const responsePrompt = buildResponsePrompt({
      userMessage,
      intent,
      artisans,
      usingDatabase: artisanService.isUsingDatabase(),
      userName,
    });
    const reply = await gemini.generateText(responsePrompt, { temperature: 0.5 });
    session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  } catch (err) {
    logger.error('[agent] Response generation failed:', err.message);
    const fallback = buildDeterministicFallback(intent, artisans, userName);
    session.appendMessage(phoneNumber, 'assistant', fallback);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback — when Gemini is down, still give a useful response
// ---------------------------------------------------------------------------

function buildDeterministicFallback(intent, artisans, userName) {
  const hi = userName ? `${userName}, ` : '';

  if (!intent.service) {
    return `${hi}What service do you need help with (e.g. electrician, plumber, mechanic, cleaner), and what area are you in?`;
  }
  if (!intent.location) {
    return `${hi}Got it, you need a *${intent.service}*. What area are you in so I can find someone nearby?`;
  }
  if (!artisans.length) {
    return `Sorry${hi ? ` ${userName}` : ''}, I couldn't find any *${intent.service}s* near ${intent.location} right now. Want me to check a nearby area?`;
  }

  const lines = artisans.slice(0, 3).map((a, i) => {
    const avail = a.available ? '⚡ Available now' : '🕒 Unavailable';
    return `${i + 1}. *${a.name}*\n⭐ ${a.rating} | 📍 ${a.location}\n${avail} | Est. ${a.average_response_time} mins`;
  });

  return `Here are the best *${intent.service}s* near ${intent.location}:\n\n${lines.join('\n\n')}\n\nWould you like me to connect you to one of them?`;
}

module.exports = { handleUserMessage };
