const { extractTextFromMessage } = require('./client');
const agent = require('../ai/agent');
const logger = require('../config/logger');

const TYPING_DELAY_MS = 600;
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Handles one incoming message: validates it, runs the AI agent, sends the reply.
 * Wrapped in try/catch at every step so a single bad message never crashes the process.
 */
async function handleIncomingMessage(sock, msg) {
  const remoteJid = msg.key.remoteJid;
  const phoneNumber = remoteJid?.split('@')[0];

  if (!phoneNumber) {
    logger.warn('[messageHandler] Could not determine sender phone number, skipping message.');
    return;
  }

  const text = extractTextFromMessage(msg);
  if (!text) {
    // Non-text message (sticker, audio, document, etc.) — politely respond instead of ignoring silently
    await safeSend(
      sock,
      remoteJid,
      "I can only read text messages for now 🙏 — please describe what service you need in words."
    );
    return;
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    await safeSend(sock, remoteJid, 'That message is a bit long — could you summarize what you need?');
    return;
  }

  try {
    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    const reply = await agent.handleUserMessage(phoneNumber, text);

    await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));
    await safeSend(sock, remoteJid, reply);
  } catch (err) {
    logger.error(`[messageHandler] Failed to process message from ${phoneNumber}:`, err.message);
    await safeSend(
      sock,
      remoteJid,
      'Something went wrong on my end 😕. Please try again in a moment.'
    );
  }
}

async function safeSend(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error(`[messageHandler] Failed to send message to ${jid}:`, err.message);
  }
}

module.exports = {
  handleIncomingMessage,
};
