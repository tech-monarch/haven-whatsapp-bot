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
    service: safe.service || previousPrefs.lastService || null,
    location: safe.location || previousPrefs.lastLocation || null,
    urgency: ['low', 'normal', 'high'].includes(safe.urgency) ? safe.urgency : 'normal',
    budget: typeof safe.budget === 'number' ? safe.budget : previousPrefs.lastBudget || null,
    requirements: safe.requirements || null,
    intent: safe.intent || 'other',
    missing_info: Array.isArray(safe.missing_info) ? safe.missing_info : [],
  };
}

/**
 * Main entry point: process one inbound WhatsApp message and return the reply text.
 *
 * @param {string} phoneNumber
 * @param {string} userMessage
 */
async function handleUserMessage(phoneNumber, userMessage) {
  session.appendMessage(phoneNumber, 'user', userMessage);
  const history = session.getRecentMessages(phoneNumber, 6);
  const prevPrefs = session.getPreferences(phoneNumber);

  // Step 1: extract structured intent via Gemini
  let intent;
  try {
    const extractionPrompt = buildExtractionPrompt(userMessage, history.slice(0, -1));
    const rawIntent = await gemini.generateJSON(extractionPrompt, { temperature: 0.1 });
    intent = normalizeIntent(rawIntent, prevPrefs);
  } catch (err) {
    logger.error('[agent] Intent extraction failed:', err.message);
    session.appendMessage(phoneNumber, 'assistant', FALLBACK_NO_AI_REPLY);
    return FALLBACK_NO_AI_REPLY;
  }

  // Persist useful preferences for future turns in this conversation
  session.setPreferences(phoneNumber, {
    lastService: intent.service,
    lastLocation: intent.location,
    lastBudget: intent.budget,
  });

  // Greetings / non-search intents: skip artisan search entirely
  if (intent.intent === 'greeting' && !intent.service && !intent.location) {
    const reply =
      "Hi there! 👋 I can help you find trusted artisans nearby — electricians, plumbers, mechanics, cleaners, and more.\n\nWhat service do you need, and which area are you in?";
    session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  }

  // Step 2: if critical info is missing, ask Gemini to phrase a follow-up question
  // (search is skipped — we don't want to show irrelevant results)
  let artisans = [];
  const hasEnoughInfoToSearch = Boolean(intent.service);

  if (hasEnoughInfoToSearch) {
    try {
      artisans = await artisanService.searchArtisans({
        service: intent.service,
        location: intent.location,
        urgency: intent.urgency,
        budget: intent.budget,
      });
    } catch (err) {
      logger.error('[agent] Artisan search failed:', err.message);
      artisans = [];
    }
  }

  // Step 3: generate the natural-language reply
  try {
    const responsePrompt = buildResponsePrompt({
      userMessage,
      intent,
      artisans,
      usingDatabase: artisanService.isUsingDatabase(),
    });
    const reply = await gemini.generateText(responsePrompt, { temperature: 0.5 });
    session.appendMessage(phoneNumber, 'assistant', reply);
    return reply;
  } catch (err) {
    logger.error('[agent] Response generation failed:', err.message);
    const fallback = buildDeterministicFallback(intent, artisans);
    session.appendMessage(phoneNumber, 'assistant', fallback);
    return fallback;
  }
}

/**
 * If Gemini is down, still give the user something useful built from raw data,
 * so a single AI outage never fully breaks the bot.
 */
function buildDeterministicFallback(intent, artisans) {
  if (!intent.service) {
    return "What service do you need help with (e.g. electrician, plumber, mechanic, cleaner), and what area are you in?";
  }
  if (!intent.location) {
    return `Got it, you need a ${intent.service}. What area/location are you in so I can find someone nearby?`;
  }
  if (!artisans.length) {
    return `Sorry, I couldn't find any ${intent.service}s near ${intent.location} right now. Want me to check a nearby area?`;
  }

  const lines = artisans.slice(0, 3).map((a, i) => {
    const availability = a.available ? '⚡ Available now' : '🕒 Currently unavailable';
    return `${i + 1}. ${a.name}\n⭐ ${a.rating} rating\n📍 ${a.location}\n${availability}\nEst. response: ${a.average_response_time} mins`;
  });

  return `Here are the best ${intent.service}s near ${intent.location}:\n\n${lines.join('\n\n')}\n\nWould you like me to connect you?`;
}

module.exports = {
  handleUserMessage,
};
