const SYSTEM_PROMPT = `You are Haven's community assistant on WhatsApp — a warm, trustworthy helper for church and faith communities.

Haven is a faith-driven platform that helps church communities care for one another by connecting people's skills, needs, and opportunities — creating a stronger, self-supporting community.

Your personality:
- Warm, kind, and respectful — like a trusted church elder or deacon
- Encouraging and uplifting without being preachy
- Practical and clear — you get things done for people
- You treat every community member with dignity

What you help with:
- Connecting members to skilled people within the church community (artisans, professionals, volunteers)
- Finding help for urgent needs (repairs, errands, care)
- Surfacing opportunities to serve others in the community
- Helping members support and be supported by their local church family

Rules you must always follow:
- Never invent or fabricate member/service provider data. Only use results from the data given to you.
- If no match is found, say so graciously and offer to help further.
- Ask gentle, focused questions if the service or area is unclear.
- Prioritise trustworthiness, ratings, and availability when recommending helpers.
- Keep replies concise, warm, and easy to read on WhatsApp (short lines, tasteful emojis, no heavy markdown).
- Never claim to have booked or contacted someone on the user's behalf — only share contact details.
- If the user mentions their name, use it naturally and warmly.
- Occasionally affirm the value of community and mutual support — but keep it natural, not forced.`;

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

/**
 * Build the prompt that extracts structured intent from a raw user message.
 * Includes conversation history and the helpers shown in the last search
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
    ? `Community helpers shown in the previous reply (for resolving "connect me to #N"):\n${lastArtisans
        .map((a, i) => `${i + 1}. ${a.name} | ${a.category} | ${a.location}`)
        .join('\n')}\n`
    : '';

  return `You extract structured intent from messages sent to Haven, a faith-community WhatsApp bot that connects church members to skilled helpers and services within their community.

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
- "urgency": "high" if the user says urgent/now/emergency/asap/please help, else "normal"
- "budget": numeric value in Naira if mentioned, else null
- "intent": use "connect_request" when the user wants to be connected to or contact a helper
- "selected_artisan_index": 1-based index if they say "number 1", "#2", "the first one", "option 3", etc. null otherwise
- "user_name": their first name if they introduce themselves, e.g. "I'm Emeka" → "Emeka". null if not mentioned.
- "missing_info": fields still needed before a search can run well, e.g. ["service"] or ["location"]. Empty if enough info is present.

Only output the JSON object.`;
}

// ---------------------------------------------------------------------------
// Response generation
// ---------------------------------------------------------------------------

/**
 * Build the prompt that turns ranked results into a natural WhatsApp reply.
 */
function buildResponsePrompt({ userMessage, intent, artisans, usingDatabase, userName }) {
  const greeting = userName ? `, ${userName}` : '';

  const artisanBlock = artisans.length
    ? artisans
        .slice(0, 5)
        .map((a, i) => {
          const avail = a.available ? 'Available now' : 'Currently unavailable';
          return `${i + 1}. ${a.name} | skill: ${a.category} | rating: ${a.rating} | area: ${a.location} | ${avail} | avg response: ${a.average_response_time} mins | completed jobs: ${a.completed_jobs} | price range: ${a.price_range || 'flexible'}`;
        })
        .join('\n')
    : 'No matching community helpers were found.';

  return `${SYSTEM_PROMPT}

Data source note (do not mention this to the user): ${usingDatabase ? 'live database' : 'demo/mock dataset'}.
User name if known: ${userName || 'unknown'}

User's extracted intent: ${JSON.stringify(intent)}
User's latest message: "${userMessage}"

Ranked community helpers (best match first — do NOT re-rank or invent anyone not listed here):
${artisanBlock}

Write a short, warm WhatsApp reply to the user${greeting ? ` (address them warmly as ${userName})` : ''} that:
- If intent.missing_info is non-empty, ask ONE gentle, clear follow-up question for the most important missing field.
- Otherwise, present up to the top 3 helpers using a clean format: name, skill, rating, area, availability.
- End by asking if they'd like to be connected to one of them.
- Keep the tone warm and community-spirited — like a helpful church notice board, not a cold marketplace.
- Do not use markdown headers or backticks. WhatsApp supports *bold* and _italic_ and emojis.
- Keep it under 130 words.`;
}


module.exports = {
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  buildResponsePrompt,
};
