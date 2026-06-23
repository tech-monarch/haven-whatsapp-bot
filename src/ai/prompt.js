const SYSTEM_PROMPT = `You are an AI assistant for Haven, an artisan marketplace on WhatsApp.
Your goal is to help users find reliable artisans (electricians, plumbers, mechanics, cleaners, technicians, carpenters, painters, etc).

Rules you must always follow:
- Never invent artisan data. Only use artisans from the search results given to you.
- If no artisans are found, say so clearly and suggest the user try a different location or service.
- Ask clarifying questions if the service type or location is missing or ambiguous.
- Prioritize safety, ratings, availability and distance when recommending artisans.
- Keep replies concise, friendly, and easy to read on WhatsApp (short lines, emojis where helpful, no heavy markdown).
- Never claim to have booked or contacted an artisan on the user's behalf — only share contact details.
- If the user mentions their name, use it naturally in replies.`;

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

/**
 * Build the prompt that extracts structured intent from a raw user message.
 * Includes conversation history and the artisans shown in the last search
 * so the AI can resolve "connect me to number 2" accurately.
 */
function buildExtractionPrompt(userMessage, conversationContext = [], prevPrefs = {}) {
  const historyBlock = conversationContext.length
    ? `Recent conversation (oldest to newest):\n${conversationContext
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n')}\n`
    : '';

  const lastArtisans = prevPrefs.lastShownArtisans || [];
  const artisanBlock = lastArtisans.length
    ? `Artisans shown in the previous reply (for resolving "connect me to #N"):\n${lastArtisans
        .map((a, i) => `${i + 1}. ${a.name} | ${a.category} | ${a.location}`)
        .join('\n')}\n`
    : '';

  return `You extract structured intent from messages sent to an artisan marketplace WhatsApp bot.

${historyBlock}${artisanBlock}
New user message: "${userMessage}"

Extract the following fields and respond with ONLY valid JSON, no markdown fences, no commentary:

{
  "service": string|null,
  "location": string|null,
  "urgency": "low"|"normal"|"high",
  "budget": number|null,
  "requirements": string|null,
  "intent": "search_artisan"|"follow_up"|"greeting"|"connect_request"|"other",
  "missing_info": string[],
  "selected_artisan_index": number|null,
  "user_name": string|null
}

Field notes:
- "urgency": "high" if the user says urgent/now/emergency/asap, else "normal"
- "budget": numeric value in Naira if mentioned, else null
- "intent": use "connect_request" when the user wants to be connected to or contact an artisan
- "selected_artisan_index": 1-based index if they say "number 1", "#2", "the first one", "option 3", etc. null otherwise
- "user_name": their first name if they introduce themselves, e.g. "I'm Emeka" → "Emeka". null if not mentioned.
- "missing_info": fields still needed before a search can run well, e.g. ["service"] or ["location"]. Empty if enough info is present.

Only output the JSON object.`;
}

// ---------------------------------------------------------------------------
// Response generation
// ---------------------------------------------------------------------------

/**
 * Build the prompt that turns ranked artisan results into a natural WhatsApp reply.
 */
function buildResponsePrompt({ userMessage, intent, artisans, usingDatabase, userName }) {
  const greeting = userName ? `, ${userName}` : '';

  const artisanBlock = artisans.length
    ? artisans
        .slice(0, 5)
        .map((a, i) => {
          const avail = a.available ? 'Available now' : 'Currently unavailable';
          return `${i + 1}. ${a.name} | category: ${a.category} | rating: ${a.rating} | location: ${a.location} | ${avail} | avg response: ${a.average_response_time} mins | completed jobs: ${a.completed_jobs} | price range: ${a.price_range || 'not specified'}`;
        })
        .join('\n')
    : 'No matching artisans were found.';

  return `${SYSTEM_PROMPT}

Data source note (do not mention this to the user): ${usingDatabase ? 'live database' : 'demo/mock dataset'}.
User name if known: ${userName || 'unknown'}

User's extracted intent: ${JSON.stringify(intent)}
User's latest message: "${userMessage}"

Ranked artisan candidates (best match first — do NOT re-rank or invent any artisan not listed here):
${artisanBlock}

Write a short, friendly WhatsApp reply to the user${greeting ? ` (address them as ${userName})` : ''} that:
- If intent.missing_info is non-empty, ask ONE clear follow-up question for the most important missing field.
- Otherwise, present up to the top 3 artisans using a clean format: name, rating, location, availability.
- End by asking if they'd like to be connected to one of them.
- Do not use markdown headers or backticks. WhatsApp supports *bold* and _italic_ and emojis.
- Keep it under 120 words.`;
}

module.exports = {
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  buildResponsePrompt,
};
