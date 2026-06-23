/**
 * In-memory conversation memory, keyed by phone number.
 *
 * Structure:
 * {
 *   [phoneNumber]: {
 *     messages: [{ role: 'user'|'assistant', text: string, at: ISOString }],
 *     userPreferences: {
 *       lastService, lastLocation, lastBudget,
 *       lastShownArtisans,   // artisans shown in the previous search result
 *       userName,            // captured from conversation
 *     }
 *   }
 * }
 *
 * Deliberately behind a small interface so swapping to a persistent store
 * (Postgres/Redis) only requires rewriting this file.
 */

const MAX_MESSAGES_PER_USER = 20;

const store = new Map();

function getSession(phoneNumber) {
  if (!store.has(phoneNumber)) {
    store.set(phoneNumber, { messages: [], userPreferences: {} });
  }
  return store.get(phoneNumber);
}

function appendMessage(phoneNumber, role, text) {
  const session = getSession(phoneNumber);
  session.messages.push({ role, text, at: new Date().toISOString() });
  if (session.messages.length > MAX_MESSAGES_PER_USER) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_USER);
  }
  return session;
}

function getRecentMessages(phoneNumber, count = 6) {
  return getSession(phoneNumber).messages.slice(-count);
}

function setPreferences(phoneNumber, partialPrefs) {
  const session = getSession(phoneNumber);
  session.userPreferences = { ...session.userPreferences, ...partialPrefs };
  return session.userPreferences;
}

function getPreferences(phoneNumber) {
  return getSession(phoneNumber).userPreferences;
}

function clearSession(phoneNumber) {
  store.delete(phoneNumber);
}

/**
 * Store the artisans shown in the last search result so that a follow-up
 * "connect me to #2" can resolve the selection without another search.
 *
 * @param {string} phoneNumber
 * @param {object[]} artisans - the ranked list that was presented to the user
 */
function setLastShownArtisans(phoneNumber, artisans) {
  setPreferences(phoneNumber, { lastShownArtisans: artisans.slice(0, 5) });
}

function getLastShownArtisans(phoneNumber) {
  return getPreferences(phoneNumber).lastShownArtisans || [];
}

module.exports = {
  getSession,
  appendMessage,
  getRecentMessages,
  setPreferences,
  getPreferences,
  clearSession,
  setLastShownArtisans,
  getLastShownArtisans,
};
