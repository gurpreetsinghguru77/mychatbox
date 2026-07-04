import { Database } from './database.js';
import { generateReply } from './gemini.js';

/**
 * Gets notes details for a specific contact
 * @param {string} userId
 * @param {string} contactId 
 */
export async function getContactNotes(userId, contactId) {
  const note = await Database.getNotes(userId, contactId);
  if (!note) {
    return {
      aiSummary: 'No summary generated yet. Click "Refresh" to generate.',
      manualNotes: '',
      lastUpdatedCount: 0
    };
  }
  return note;
}

/**
 * Saves manual notes written by the owner
 * @param {string} userId
 * @param {string} contactId 
 * @param {string} manualNotes 
 */
export async function saveContactManualNotes(userId, contactId, manualNotes) {
  await Database.saveManualNotes(userId, contactId, manualNotes);
}

/**
 * Generates an AI summary/notes from the conversation history using Gemini/OpenRouter
 * @param {string} userId
 * @param {string} contactId 
 * @param {Array} chatHistory 
 * @param {string} openrouterApiKey 
 * @param {string} openrouterModel 
 * @param {Object} aiClient - Gemini AI Client 
 * @param {string} geminiModel 
 */
export async function generateContactAiSummary(
  contactId, 
  chatHistory, 
  openrouterApiKey, 
  openrouterModel, 
  aiClient, 
  geminiModel
) {
  if (!chatHistory || chatHistory.length === 0) {
    return 'No chat history to summarize.';
  }

  // Compile simplified chat logs for the summarizer
  const formattedLogs = chatHistory.map(msg => {
    const senderName = msg.sender === 'user' ? 'Client/User' : 'Gurpreet/Assistant';
    return `${senderName} [${msg.timestamp}]: ${msg.text || '[Media file]'}`;
  }).join('\n');

  const systemInstruction = `You are an expert executive secretary and customer insights analyst.
Analyze the provided WhatsApp chat history between the Assistant and a Client. 
Write a short, highly professional, bulleted summary in Roman Hindi / Hinglish.

Your summary MUST cover these three sections:
1. **Kya Chahta Hai (Core Request/Intent)**: Summarize what the client wants or asked.
2. **Main Points Discussed**: Summarize the key information exchanged or generated (e.g. if they asked for images/videos).
3. **Future Follow-up Advice**: Advice for Gurpreet on how to talk to this client in the future or what action is pending.

Keep the summary brief, concise, and structured. Do not use academic jargon. Use Roman Hindi/Hinglish.`;

  let aiSummary = '';

  // Try OpenRouter first
  if (openrouterApiKey && openrouterApiKey !== 'YOUR_OPENROUTER_API_KEY_HERE') {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/gurpreetsinghguru77/whatsab-bot',
          'X-Title': 'WhatsApp AI Assistant Summarizer'
        },
        body: JSON.stringify({
          model: openrouterModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Here is the chat history:\n\n${formattedLogs}` }
          ],
          temperature: 0.2,
          max_tokens: 300
        })
      });

      if (response.ok) {
        const data = await response.json();
        aiSummary = data.choices[0].message.content || '';
      }
    } catch (err) {
      console.error('[NOTES AI OpenRouter Error]:', err.message);
    }
  }

  // Fallback to Gemini if configured
  if (!aiSummary && aiClient) {
    try {
      const response = await aiClient.models.generateContent({
        model: geminiModel,
        contents: `Here is the chat history:\n\n${formattedLogs}`,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2
        }
      });
      aiSummary = response.text || '';
    } catch (err) {
      console.error('[NOTES AI Gemini Error]:', err.message);
    }
  }

  // Fallback to free Pollinations API
  if (!aiSummary) {
    try {
      const response = await fetch('https://text.pollinations.ai/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Here is the chat history:\n\n${formattedLogs}` }
          ],
          model: 'openai-fast',
          private: true
        })
      });

      if (response.ok) {
        aiSummary = await response.text();
      }
    } catch (err) {
      console.error('[NOTES AI Pollinations Fallback Error]:', err.message);
    }
  }

  if (aiSummary) {
    await Database.saveAiSummary('AI-000001', contactId, aiSummary);
    return aiSummary;
  }

  return 'Failed to generate AI summary.';
}
