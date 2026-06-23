/**
 * In-memory conversation memory, keyed by phone number.
 *
 * Structure:
 * {
 *   [phoneNumber]: {
 *     messages: [{ role: 'user'|'assistant', text: string, at: ISOString }],
 *     userPreferences: { lastService, lastLocation, ... }
 *   }
 * }
 *
 * This module exposes a small interface (get/append/setPreferences/clear) so that
 * swapping the backing store for PostgreSQL/MongoDB later only requires
 * reimplementing this file — no changes needed in messageHandler.js or agent.js.
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
  const session = getSession(phoneNumber);
  return session.messages.slice(-count);
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

module.exports = {
  getSession,
  appendMessage,
  getRecentMessages,
  setPreferences,
  getPreferences,
  clearSession,
};
