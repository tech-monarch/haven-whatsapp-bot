const SYSTEM_PROMPT = `You are an AI assistant for an artisan marketplace on WhatsApp.
Your goal is to help users find reliable artisans (electricians, plumbers, mechanics, cleaners, technicians, carpenters, painters, etc).

Rules you must always follow:
- Never invent artisan data. Only use artisans returned by the search tool/results given to you.
- If no artisans are found, say so clearly and suggest the user try a different location or service.
- Ask clarifying questions if the service type or location is missing or ambiguous.
- Prioritize safety, ratings, availability and distance when recommending artisans.
- Keep replies concise, friendly, and easy to read on WhatsApp (short lines, emojis where helpful, no heavy markdown).
- Never claim to have booked or contacted an artisan on the user's behalf — only offer to connect them.`;

/**
 * Prompt used to extract structured intent (service, location, urgency, budget, requirements)
 * from a raw user message. Gemini is instructed to respond with strict JSON only.
 */
function buildExtractionPrompt(userMessage, conversationContext = []) {
  const historyBlock = conversationContext.length
    ? `Recent conversation (oldest to newest):\n${conversationContext
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n')}\n`
    : '';

  return `You extract structured intent from messages sent to an artisan marketplace WhatsApp bot.

${historyBlock}
New user message: "${userMessage}"

Extract the following fields and respond with ONLY valid JSON, no markdown fences, no commentary:

{
  "service": string|null,       // normalized artisan category, e.g. "electrician", "plumber", "mechanic", "cleaner", "technician", "carpenter", "painter". null if not mentioned or unclear.
  "location": string|null,      // area/neighborhood mentioned by the user, e.g. "Ikeja". null if not mentioned.
  "urgency": "low"|"normal"|"high", // "high" if words like "urgent", "now", "emergency", "asap" appear. Default "normal".
  "budget": number|null,        // numeric budget in Naira if mentioned, else null.
  "requirements": string|null,  // any extra detail about the job (e.g. "fixing a tripped breaker"), else null.
  "intent": "search_artisan"|"follow_up"|"greeting"|"connect_request"|"other",
  "missing_info": string[]      // list of fields still needed before a search can run well, e.g. ["service"] or ["location"]. Empty array if enough info is present.
}

Only output the JSON object.`;
}

/**
 * Prompt used to turn ranked search results into a natural WhatsApp reply.
 */
function buildResponsePrompt({ userMessage, intent, artisans, usingDatabase }) {
  const artisanBlock = artisans.length
    ? artisans
        .slice(0, 5)
        .map((a, i) => {
          const availability = a.available ? 'Available now' : 'Currently unavailable';
          return `${i + 1}. ${a.name} | category: ${a.category} | rating: ${a.rating} | location: ${a.location} | ${availability} | avg response: ${a.average_response_time} mins | completed jobs: ${a.completed_jobs} | price range: ${a.price_range || 'not specified'}`;
        })
        .join('\n')
    : 'No matching artisans were found.';

  return `${SYSTEM_PROMPT}

Data source note (do not mention this to the user directly): ${usingDatabase ? 'live database' : 'demo/mock dataset, since the production backend is still being finished'}.

User's extracted intent: ${JSON.stringify(intent)}
User's latest message: "${userMessage}"

Ranked artisan candidates (best match first, already sorted for the user — do not re-rank, do not invent any artisan not listed here):
${artisanBlock}

Write a short, friendly WhatsApp reply to the user that:
- If intent.missing_info is non-empty, ask ONE clear follow-up question for the most important missing field instead of showing results.
- Otherwise, present up to the top 3 artisans from the list above using a clean format with name, rating, location, and availability.
- End by asking if they'd like to be connected to one of them.
- Do not use markdown headers or backticks. WhatsApp supports *bold* and _italic_ and emojis.
- Keep it under 120 words.`;
}

module.exports = {
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  buildResponsePrompt,
};
