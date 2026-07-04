import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getHistory, addMessage } from './history.js';
import { generateContactAiSummary, getContactNotes } from './notes.js';
import { scheduleMessage } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const geminiApiKey = process.env.GEMINI_API_KEY;
const openrouterApiKey = process.env.OPENROUTER_API_KEY;
const openrouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

let ai = null;

if (openrouterApiKey && openrouterApiKey !== 'YOUR_OPENROUTER_API_KEY_HERE') {
  console.log('[AI] Configured to use OpenRouter API with model:', openrouterModel);
} else if (geminiApiKey && geminiApiKey !== 'YOUR_GEMINI_API_KEY_HERE') {
  console.log('[AI] Configured to use Gemini API.');
  ai = new GoogleGenAI({ apiKey: geminiApiKey });
} else {
  console.warn('\n[WARNING] Neither GEMINI_API_KEY nor OPENROUTER_API_KEY is configured in .env.');
  console.warn('AI responses will not function correctly.\n');
}

/**
 * Classifies the incoming message's intent to auto-switch to image/video generator if requested.
 */
async function classifyIntent(messageText, isPersonalMode = false) {
  if (!messageText || messageText.trim().length === 0) return { type: 'chat' };

  const systemInstruction = `You are a strict intent classifier and translation helper.
Analyze the user's message. Determine if the user is asking to create, draw, make, or generate a new image/photo/artwork/painting, OR if they are asking to generate/create a video.

- If they are asking for an image/photo (even in Hindi/Hinglish/Urdu like "ek photo bana do", "draw karo", "iski photo bna do"): Translate their request into a highly descriptive, high-quality English image generation prompt (add quality terms like "photorealistic", "detailed", "digital art" where appropriate). Reply exactly in this format:
IMAGE: <English prompt>

- If they are asking for a video: Translate their request into a detailed, high-quality English video prompt. Reply exactly in this format:
VIDEO: <English prompt>

${isPersonalMode ? `- If they are asking you to send a message or give a task to send a message to a specific person or contact (e.g. "Rahul ko message bhej do ki...", "Send a message to Mom saying...", "Tell John I am late"): Extract the contact name/number and draft the message content in a professional, polite, and well-formatted way. Translate to the appropriate language if needed (e.g. if they say "use bolo main late hu", draft "I am running a bit late"). Reply exactly in this format:
SEND_MESSAGE: <Contact Name or Number>||<Refined Message Content to Send>` : ''}

- Otherwise (regular chat, normal conversation, questions, writing coding files/code, chatting about an existing photo they sent, etc.): Reply exactly with:
CHAT

Examples:
User: "Make an image of a red car" -> IMAGE: A photorealistic red sports car parked on a wet city street at night, neon lights, 8k resolution
User: "Mere liye ek cute billi ki picture banao" -> IMAGE: A cute fluffy kitten playing with a ball of yarn, soft lighting, detailed fur, digital painting
User: "A boy playing football in garden. Iski bna do" -> IMAGE: A young boy playing football in a lush green garden, cinematic lighting, realistic, high detail
User: "create a python calculator" -> CHAT
User: "calculator ka code likho" -> CHAT
User: "ek running car ki video banao" -> VIDEO: A sleek sports car driving fast on a scenic highway, cinematic motion, 4k
${isPersonalMode ? 'User: "Rahul ko bolo main 10 min mein aa raha hu" -> SEND_MESSAGE: Rahul||Main 10 min mein aa raha hu\nUser: "Send message to 9876543210 saying Hi" -> SEND_MESSAGE: 9876543210||Hi' : ''}
`;

  // Try OpenRouter first
  if (openrouterApiKey && openrouterApiKey !== 'YOUR_OPENROUTER_API_KEY_HERE') {
    try {
      const isGroq = openrouterApiKey.startsWith('gsk_');
      const isOfficialOpenAI = openrouterApiKey.startsWith('sk-proj-') || openrouterApiKey.startsWith('sk-') && !openrouterApiKey.startsWith('sk-or-');
      const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : (isOfficialOpenAI ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
      const actualModel = isOfficialOpenAI && openrouterModel.startsWith('openai/') ? openrouterModel.replace('openai/', '') : openrouterModel;
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/gurpreetsinghguru77/whatsab-bot',
          'X-Title': 'WhatsApp AI Assistant'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: messageText }
          ],
          temperature: 0.1,
          max_tokens: 150
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = (data.choices[0].message.content || '').trim();
        if (reply.startsWith('IMAGE:')) {
          return { type: 'image', prompt: reply.substring(6).trim() };
        }
        if (reply.startsWith('VIDEO:')) {
          return { type: 'video', prompt: reply.substring(6).trim() };
        }
        if (reply.startsWith('SEND_MESSAGE:')) {
          const parts = reply.substring(13).split('||');
          return { type: 'send_message', contact: parts[0].trim(), message: parts[1] ? parts[1].trim() : '' };
        }
      }
    } catch (err) {
      console.error('[Classifier OpenRouter Error]:', err.message);
    }
  }

  // Fallback to Gemini for classification
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: config.ai.model,
        contents: messageText,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.1,
        }
      });
      const reply = (response.text || '').trim();
      if (reply.startsWith('IMAGE:')) {
        return { type: 'image', prompt: reply.substring(6).trim() };
      }
      if (reply.startsWith('VIDEO:')) {
        return { type: 'video', prompt: reply.substring(6).trim() };
      }
    } catch (err) {
      console.error('[Classifier Gemini Error]:', err.message);
    }
  }

  // Final fallback to free Pollinations text API for classification
  try {
    const response = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: messageText }
        ],
        model: 'openai-fast',
        private: true
      })
    });

    if (response.ok) {
      const reply = (await response.text()).trim();
      if (reply.startsWith('IMAGE:')) {
        return { type: 'image', prompt: reply.substring(6).trim() };
      }
      if (reply.startsWith('VIDEO:')) {
        return { type: 'video', prompt: reply.substring(6).trim() };
      }
    }
  } catch (error) {
    console.error('[Classifier Pollinations Error]:', error.message);
  }

  return { type: 'chat' };
}

/**
 * Helper to build the Personal Assistant Profile context string for the AI prompt.
 */
function buildAssistantContext() {
  const { assistant } = config;
  return `
=== ASSISTANT PROFILE ===
- Owner Name: ${assistant.ownerName}
- AI Role: ${assistant.role}
- About Gurpreet: ${assistant.aboutOwner}
- Current Status: ${assistant.status}

RULES/GUIDELINES:
${assistant.customRules.map(rule => `* ${rule}`).join('\n')}
=========================
`;
}

/**
 * Maps standard history format to OpenRouter / OpenAI multimodal message schema.
 */
function mapHistoryForOpenRouter(chatHistory) {
  return chatHistory.map(msg => {
    if (msg.role === 'model') {
      const textPart = msg.parts.find(p => p.text !== undefined);
      return {
        role: 'assistant',
        content: textPart ? textPart.text : ''
      };
    }

    const contentParts = [];
    const textPart = msg.parts.find(p => p.text !== undefined);
    if (textPart && textPart.text) {
      contentParts.push({ type: 'text', text: textPart.text });
    }

    const mediaPart = msg.parts.find(p => p.inlineData !== undefined);
    if (mediaPart && mediaPart.inlineData) {
      const { mimeType, filePath, filename } = mediaPart.inlineData;
      if (mimeType.startsWith('image/')) {
        try {
          if (fs.existsSync(filePath)) {
            const base64Data = fs.readFileSync(filePath).toString('base64');
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`
              }
            });
          }
        } catch (err) {
          console.error('[OpenRouter Media Error]:', err.message);
        }
      } else {
        contentParts.push({
          type: 'text',
          text: `[User sent a ${mimeType.split('/')[0]} attachment: ${filename}]`
        });
      }
    }

    return {
      role: 'user',
      content: contentParts.length > 0 ? contentParts : [{ type: 'text', text: '' }]
    };
  });
}

/**
 * Maps standard history format to Gemini multimodal contents schema.
 */
function mapHistoryForGemini(chatHistory) {
  return chatHistory.map(msg => {
    const parts = msg.parts.map(part => {
      if (part.inlineData && part.inlineData.filePath) {
        try {
          if (fs.existsSync(part.inlineData.filePath)) {
            const base64Data = fs.readFileSync(part.inlineData.filePath).toString('base64');
            return {
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: base64Data
              }
            };
          }
        } catch (err) {
          console.error('[Gemini Media Error]:', err.message);
        }
        return { text: `[Attachment: ${part.inlineData.filename}]` };
      }
      return part;
    });
    return { role: msg.role, parts };
  });
}

/**
 * Generates an AI response for a contact based on their message and chat history.
 * @param {string} contactId - The WhatsApp contact ID
 * @param {string} messageText - The incoming message content
 * @param {Object} [mediaData] - Optional media attachment
 * @returns {Promise<string>} The generated reply message
 */
export async function generateReply(contactId, messageText, mediaData = null, isPersonalMode = false) {
  // 1. Auto-switch checks: classify request intent (skip if resetting)
  if (messageText && messageText.trim().toLowerCase() !== '!reset') {
    const intent = await classifyIntent(messageText, isPersonalMode);
    if (intent.type === 'image') {
      return `__IMAGE__:${intent.prompt}`;
    }
    if (intent.type === 'video') {
      return `__VIDEO__:${intent.prompt}`;
    }
    if (intent.type === 'send_message') {
      return `__SEND_MSG__:${intent.contact}||${intent.message}`;
    }
  }

  // 2. Fetch the conversation history for this contact (it has already been added to history in app.js)
  const chatHistory = getHistory(contactId);

  // 3. Compile the system instruction including rules and assistant facts
  const assistantContext = buildAssistantContext();
  
  // Load notes/summaries for this specific contact to customize AI behavior
  const contactNotes = getContactNotes(contactId);
  let contactContext = '';
  if (contactNotes) {
    contactContext = `
=== CONTACT SPECIFIC CONTEXT & CUSTOM RULES ===
* AI Summary of past discussions: ${contactNotes.aiSummary || 'None'}
* Owner's Manual Notes about this person: ${contactNotes.manualNotes || 'None'}
* Customization Rule: Use the notes above to adapt your tone, language style (respectful/casual), and recall past agreements/context when replying to this contact.
================================================
`;
  }

  const systemInstruction = `${config.ai.systemInstruction}\n\n${assistantContext}\n\n${contactContext}`;

  // Check if history has any audio/voice or video messages
  const hasAudioOrVideo = chatHistory.some(msg => 
    msg.parts.some(part => 
      part.inlineData && 
      (part.inlineData.mimeType.startsWith('audio/') || part.inlineData.mimeType.startsWith('video/'))
    )
  );

  // 4. Try OpenRouter if API key is provided (skip for audio/video since GPT-4o-mini doesn't process audio natively)
  if (openrouterApiKey && openrouterApiKey !== 'YOUR_OPENROUTER_API_KEY_HERE' && !hasAudioOrVideo) {
    try {
      const openAiMessages = mapHistoryForOpenRouter(chatHistory);
      const isGroq = openrouterApiKey.startsWith('gsk_');
      const isOfficialOpenAI = openrouterApiKey.startsWith('sk-proj-') || openrouterApiKey.startsWith('sk-') && !openrouterApiKey.startsWith('sk-or-');
      const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : (isOfficialOpenAI ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
      const actualModel = isOfficialOpenAI && openrouterModel.startsWith('openai/') ? openrouterModel.replace('openai/', '') : openrouterModel;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/gurpreetsinghguru77/whatsab-bot',
          'X-Title': 'WhatsApp AI Assistant'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: [
            { role: 'system', content: systemInstruction },
            ...openAiMessages
          ],
          temperature: 0.2,
          max_tokens: 200
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const replyText = data.choices[0].message.content || '';

      // Add response to history
      addMessage(contactId, 'model', replyText);
      return replyText;

    } catch (error) {
      console.error('[OpenRouter Error] Failed to generate response:', error.message);
    }
  }

  // 6. Fallback to Gemini if configured
  if (ai) {
    try {
      const geminiContents = mapHistoryForGemini(chatHistory);

      const response = await ai.models.generateContent({
        model: config.ai.model,
        contents: geminiContents,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2,
        }
      });

      const replyText = response.text || '';
      addMessage(contactId, 'model', replyText);
      return replyText;
    } catch (error) {
      console.error('[Gemini Error] Failed to generate response:', error.message);
    }
  }

  // 7. Zero-cost Fallback using Pollinations.ai (No key required!)
  try {
    console.log('[AI] Trying zero-cost Pollinations.ai API fallback...');
    const openAiMessages = mapHistoryForOpenRouter(chatHistory);

    const response = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemInstruction },
          ...openAiMessages
        ],
        model: 'openai-fast',
        private: true
      })
    });

    if (response.ok) {
      const replyText = await response.text();
      if (replyText && replyText.trim().length > 0) {
        addMessage(contactId, 'model', replyText);
        return replyText;
      }
    }
  } catch (error) {
    console.error('[Pollinations Fallback Error]:', error.message);
  }

  return "Let me get a team member to look into this for you. (System Note: AI API keys and Free Fallbacks failed)";
}

/**
 * Wrapper to trigger AI summary generation for a contact
 */
export async function summarizeContact(contactId, chatHistory) {
  return await generateContactAiSummary(
    contactId,
    chatHistory,
    openrouterApiKey,
    openrouterModel,
    ai,
    config.ai.model
  );
}

/**
 * Transcribes an audio file base64 data to text using Gemini.
 */
export async function transcribeAudio(base64Data, mimeType) {
  if (!ai) {
    console.log('[AI] Gemini is not configured, skipping transcription.');
    return '';
  }
  try {
    const response = await ai.models.generateContent({
      model: config.ai.model || 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        },
        {
          text: "Transcribe the spoken audio in this file. Provide ONLY the transcribed text in its original spoken language (Hindi, English, or Punjabi, written in its natural script). Do not add any greeting, explanation, translation, or notes."
        }
      ]
    });
    return response.text ? response.text.trim() : '';
  } catch (err) {
    console.error('[Gemini Transcription Error]:', err.message);
    return '';
  }
}

/**
 * Handles messages sent by the Owner (Gurpreet) from the Dashboard.
 * Has function calling enabled to schedule messages and update status.
 */
export async function generateOwnerReply(messageText) {
  const tools = [
    {
      type: "function",
      function: {
        name: "updateGlobalStatus",
        description: "Updates Gurpreet's global auto-reply status that everyone sees when they message him.",
        parameters: {
          type: "object",
          properties: {
            statusText: {
              type: "string",
              description: "The new status text (e.g., 'Busy in a meeting until 5 PM')"
            }
          },
          required: ["statusText"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "scheduleWhatsAppMessage",
        description: "Schedules a WhatsApp message to be sent to a specific contact at a specific future date and time.",
        parameters: {
          type: "object",
          properties: {
            contactId: {
              type: "string",
              description: "The WhatsApp contact ID to send to (e.g., '919876543210@c.us'). If the user just provides a name or number, guess the correct format."
            },
            message: {
              type: "string",
              description: "The text message to send."
            },
            dateString: {
              type: "string",
              description: "The exact ISO string of the date/time to send the message (e.g., '2026-06-29T14:30:00.000Z')"
            }
          },
          required: ["contactId", "message", "dateString"]
        }
      }
    }
  ];

  const systemInstruction = `You are the personal AI assistant for Gurpreet, and you are currently talking DIRECTLY to Gurpreet. 
You must obey his commands. You have the ability to run tools/functions to manage his WhatsApp bot.
If he asks you to update his status (e.g. "tell everyone I am busy today"), call the updateGlobalStatus function.
If he asks you to schedule a message (e.g. "send this message tomorrow"), call the scheduleWhatsAppMessage function.
Always confirm to him what you have done.`;

  try {
    if (openrouterApiKey && openrouterApiKey !== 'YOUR_OPENROUTER_API_KEY_HERE') {
      const isGroq = openrouterApiKey.startsWith('gsk_');
      const isOfficialOpenAI = openrouterApiKey.startsWith('sk-proj-') || openrouterApiKey.startsWith('sk-') && !openrouterApiKey.startsWith('sk-or-');
      const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : (isOfficialOpenAI ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
      const actualModel = isOfficialOpenAI && openrouterModel.startsWith('openai/') ? openrouterModel.replace('openai/', '') : openrouterModel;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: messageText }
          ],
          tools: tools,
          tool_choice: "auto"
        })
      });

      if (response.ok) {
        const data = await response.json();
        const responseMessage = data.choices[0].message;

        if (responseMessage.tool_calls) {
          let replyText = "I executed the following tasks:\n";
          for (const toolCall of responseMessage.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            
            if (toolCall.function.name === 'updateGlobalStatus') {
              config.assistant.status = args.statusText;
              // Persist to file
              const configPath = path.join(__dirname, 'config.js');
              const fileContent = fs.readFileSync(configPath, 'utf8');
              const updatedContent = fileContent.replace(/"status": ".*"/, '"status": "' + args.statusText + '"');
              fs.writeFileSync(configPath, updatedContent);
              
              replyText += '- Updated Global Status to: "' + args.statusText + '"\n';
            } 
            
            else if (toolCall.function.name === 'scheduleWhatsAppMessage') {
              const date = new Date(args.dateString);
              scheduleMessage(args.contactId, args.message, date);
              replyText += '- Scheduled message to ' + args.contactId + ' at ' + date.toLocaleString() + '\n';
            }
          }
          return replyText + "\nIs there anything else you need?";
        }
        
        return responseMessage.content;
      }
    }
  } catch (err) {
    console.error('[Owner Reply Error]:', err);
  }

  return "I received your message, but function calling might be disabled on this model or API.";
}
