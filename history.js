/**
 * Memory manager to store conversational history for each WhatsApp contact.
 * This keeps the last N messages to maintain context for Gemini.
 */

import path from 'path';

const historyMap = new Map();
const MAX_HISTORY_LENGTH = 12; // Keeps last 6 exchanges (12 messages)

/**
 * Get chat history for a specific contact in Gemini content format.
 * @param {string} contactId - The WhatsApp contact ID (e.g. '1234567890@c.us')
 * @returns {Array} Array of message objects matching Gemini API Content schema
 */
export function getHistory(contactId) {
  if (!historyMap.has(contactId)) {
    historyMap.set(contactId, []);
  }
  return historyMap.get(contactId);
}

/**
 * Add a new message to the chat history.
 * @param {string} contactId - The WhatsApp contact ID
 * @param {'user' | 'model'} role - The sender's role
 * @param {string} text - The message content
 * @param {Object} [mediaData] - Optional media attachments
 */
export function addMessage(contactId, role, text, mediaData = null) {
  const history = getHistory(contactId);
  
  const parts = [{ text: text || '' }];

  if (mediaData && mediaData.mediaUrl) {
    const filename = path.basename(mediaData.mediaUrl);
    const filePath = path.join('./media_cache', filename);
    parts.push({
      inlineData: {
        mimeType: mediaData.mimetype,
        filePath: filePath,
        filename: mediaData.filename || filename
      }
    });
  }

  history.push({
    role: role,
    parts: parts
  });

  // If history exceeds max length, remove the oldest messages
  if (history.length > MAX_HISTORY_LENGTH) {
    history.splice(0, history.length - MAX_HISTORY_LENGTH);
  }
}

/**
 * Clear chat history for a specific contact.
 * @param {string} contactId - The WhatsApp contact ID
 */
export function clearHistory(contactId) {
  historyMap.delete(contactId);
}
