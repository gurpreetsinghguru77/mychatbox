import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
  // Do not exit, keep the bot alive
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Do not exit, keep the bot alive
});
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { generateReply, summarizeContact, generateOwnerReply, transcribeAudio } from './gemini.js';
import { setWhatsAppClient, scheduledJobs, cancelJob } from './scheduler.js';
import { clearHistory, addMessage } from './history.js';
import { getContactNotes, saveContactManualNotes } from './notes.js';
import { activeQuizzes, generateQuizQuestion, evaluateAnswer } from './quizEngine.js';
import { config } from './config.js';
import { Database } from './database.js';
import { getSmartDelay } from './timingEngine.js';
import { EdgeTTS } from '@andresaya/edge-tts';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { exec } from 'child_process';
import util from 'util';

import session from 'express-session';
import ConnectSqlite3 from 'connect-sqlite3';
import passport from 'passport';
import { setupAuth, requireAuth } from './auth.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SQLiteStore = ConnectSqlite3(session);

const { Client, RemoteAuth, MessageMedia } = pkg;
import { PgStore } from './pgAuthStore.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3007;

app.use(express.json()); // Parse JSON bodies

// Serve static media files from local cache
app.use('/media', express.static('./media_cache'));

let whatsappStatus = 'initializing';
let latestQrCode = '';

// Top-level await to load state from Postgres
try {
  await Database.initDb();
  const aiStateStr = await Database.getAppState('personalAiActive');
  global.personalAiActive = aiStateStr === 'true';

  const customerStateStr = await Database.getAppState('customerAiActive');
  global.customerAiActive = customerStateStr === null ? true : (customerStateStr === 'true');
} catch (e) {
  console.error('[ERROR] Failed to load states from DB:', e);
  global.personalAiActive = false;
  global.customerAiActive = true;
}

// In-memory store for chat logs grouped by contactId
const chatLogsByContact = new Map();

// In-memory cache for contact names mapped by contactId
const contactNames = new Map();

// In-memory cache for contact profile picture URLs
const contactProfilePics = new Map();

// Default User ID for current single-tenant bot until fully integrated
const DEFAULT_USER_ID = 'AI-000001';

// Tracks pending delayed timeouts (chatId -> timeoutId)
const pendingReplies = new Map();

const execPromise = util.promisify(exec);

async function convertToOggOpus(inputPath, outputPath) {
  try {
    const ffmpegPath = ffmpegInstaller.path;
    const cmd = `"${ffmpegPath}" -y -i "${inputPath}" -c:a libopus -ac 1 -ar 48000 -b:a 64k "${outputPath}"`;
    console.log(`[AUDIO-CONVERTER] Converting audio using: ${cmd}`);
    await execPromise(cmd);
    console.log(`[AUDIO-CONVERTER] Audio successfully converted to OGG/Opus.`);
  } catch (err) {
    console.error(`[AUDIO-CONVERTER ERROR] Failed to convert audio:`, err.message);
    throw err;
  }
}

// Helper to load history from DB on startup
async function loadDatabaseToMemory() {
  try {
    const contacts = await Database.getAllContacts(DEFAULT_USER_ID);
    for (const c of contacts) {
      contactNames.set(c.contactId, c.name);
      contactProfilePics.set(c.contactId, c.profilePic);
      const history = await Database.getChatHistory(DEFAULT_USER_ID, c.contactId, 100);
      chatLogsByContact.set(c.contactId, history);
    }
    console.log(`[DATABASE] Loaded ${contacts.length} contacts and their histories into memory.`);
  } catch (err) {
    console.error('[ERROR] Failed to load DB to memory:', err.message);
  }
}
loadDatabaseToMemory();

// Helper to ensure media directory exists
try {
  await fs.mkdir('./media_cache', { recursive: true });
} catch (e) {}

// Helper to download and save message media
async function saveMessageMedia(msg) {
  if (!msg.hasMedia) return null;
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    // Determine extension
    let ext = 'bin';
    if (media.mimetype) {
      const mimeClean = media.mimetype.split(';')[0];
      const parts = mimeClean.split('/');
      if (parts.length > 1) {
        ext = parts[1];
        if (ext === 'ogg') ext = 'ogg';
      }
    }

    const uniqueId = msg.id.id || Math.random().toString(36).substring(2, 9);
    const filename = `${uniqueId}_${Date.now()}.${ext}`;
    const filePath = path.join('./media_cache', filename);
    const buffer = Buffer.from(media.data, 'base64');
    await fs.writeFile(filePath, buffer);

    return {
      mediaUrl: `/media/${filename}`,
      mimetype: media.mimetype,
      filename: media.filename || filename
    };
  } catch (err) {
    console.error('[ERROR] Failed to save media:', err.message);
    return null;
  }
}

// --- MEDIA CACHE CLEANUP (Prevents Storage Leak) ---
setInterval(async () => {
  try {
    const cacheDir = path.join(__dirname, 'media_cache');
    if (!fs.existsSync(cacheDir)) return;
    const files = await fs.promises.readdir(cacheDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      const stats = await fs.promises.stat(filePath);
      // Delete files older than 24 hours (86400000 ms)
      if (now - stats.mtimeMs > 86400000) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }
    console.log('[SYSTEM] Cleared old media cache files.');
  } catch (e) {
    console.error('[ERROR] Media cleanup failed:', e.message);
  }
}, 3600000); // Run every 1 hour

// Initialize Express status dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp Bot Status</title>
        ${whatsappStatus !== 'ready' ? '<meta http-equiv="refresh" content="3">' : ''}
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; color: #333; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; box-sizing: border-box; text-align: center; }
          .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); max-width: 500px; width: 100%; }
          h1 { color: #075e54; margin: 0 0 10px 0; font-size: 24px; }
          .status-badge { display: inline-block; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 20px; }
          .initializing { background-color: #ffeeba; color: #856404; }
          .qr-ready { background-color: #cce5ff; color: #004085; }
          .ready { background-color: #d4edda; color: #155724; }
          .disconnected { background-color: #f8d7da; color: #721c24; }
          #qrcode { margin: 20px auto; display: flex; justify-content: center; }
          .instructions { color: #666; font-size: 14px; line-height: 1.5; margin-top: 20px; }
        </style>
        
        <script type="module">
          import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
          import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
          
          const firebaseConfig = {
            apiKey: "AIzaSyDQJn5rKJgUH5jIRYQPYhsn-7lLq_dMmvE",
            authDomain: "wharsabapp-manger-ai.firebaseapp.com",
            projectId: "wharsabapp-manger-ai",
            storageBucket: "wharsabapp-manger-ai.firebasestorage.app",
            messagingSenderId: "1006425696139",
            appId: "1:1006425696139:web:53cb7e56d52e03ff14f18e",
            measurementId: "G-VVJ048C8S8"
          };
          
          const app = initializeApp(firebaseConfig);
          const analytics = getAnalytics(app);
        </script>
      </head>
      <body>
        <div class="card">
          <h1>WhatsApp AI Bot</h1>
          <div class="status-badge ${whatsappStatus}">${whatsappStatus}</div>
          
          ${whatsappStatus === 'qr-ready' && latestQrCode ? `
            <h2>Scan QR Code</h2>
            <div id="qrcode"></div>
            <p class="instructions">Open WhatsApp on your phone > Tap Menu (3 dots) or Settings > Linked Devices > Link a Device.<br><br>Scan this QR code to start the bot.</p>
          ` : ''}

          ${whatsappStatus === 'ready' ? `
            <h2>Bot is Online! ✅</h2>
            <p class="instructions">Your bot is connected to WhatsApp and actively listening for messages.</p>
          ` : ''}

          ${whatsappStatus === 'initializing' ? `
            <h2>Starting up... ⏳</h2>
            <p class="instructions">Please wait while the bot initializes WhatsApp Web in the background. This may take a few seconds.</p>
          ` : ''}
          
        </div>

        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <script>
          const qrText = "${latestQrCode}";
          if (qrText && document.getElementById("qrcode")) {
            new QRCode(document.getElementById("qrcode"), {
              text: qrText,
              width: 256,
              height: 256,
              colorDark : "#000000",
              colorLight : "#ffffff",
              correctLevel : QRCode.CorrectLevel.H
            });
          }
        </script>
      </body>
    </html>
  `);
});



        // Start Express Server
app.listen(PORT, () => {
  console.log(`[EXPRESS] Status server running on http://localhost:${PORT}`);
});

// Initialize WhatsApp Web Client
console.log('[WHATSAPP] Initializing client with RemoteAuth (Postgres)...');
const store = new PgStore({ pool: Database.pool });

const client = new Client({
  authStrategy: new RemoteAuth({
    clientId: 'MainSession',
    store: store,
    backupSyncIntervalMs: 60000 // Backup session to Postgres every 1 minute
  }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable'),
    headless: true, // Runs in the background
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('remote_session_saved', () => {
  console.log('[WHATSAPP] Remote session successfully backed up to Postgres.');
});

// Pass client to scheduler for executing delayed tasks
setWhatsAppClient(client);

// Event: QR Code received (required for authentication)
client.on('qr', (qr) => {
  whatsappStatus = 'qr-ready';
  latestQrCode = qr;
  console.log('\n[WHATSAPP] QR Code generated! Please open http://localhost:3007 in your web browser to scan it.');
});

// Preload active chats and messages from WhatsApp history to populate the dashboard instantly
async function preloadRecentChats() {
  console.log('[WHATSAPP] Preloading recent chats in 5 seconds...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  try {
    const fetchPromise = client.getChats();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('getChats timeout')), 20000));
    const chats = await Promise.race([fetchPromise, timeoutPromise]);
    
    // Filter to active personal chats, limit to top 50
    const personalChats = chats.filter(c => !c.isGroup && !c.isReadOnly && (c.id.server === 'c.us' || c.id.server === 'lid')).slice(0, 50);
    
    for (const chat of personalChats) {
      const contactId = chat.id._serialized;
      const contact = await chat.getContact();
      
      // Normalize LID contacts to canonical phone-based JID (@c.us)
      const canonicalId = contact.number ? `${contact.number}@c.us` : contactId;
      
      const displayName = contact.name || contact.pushname || contact.number || canonicalId.split('@')[0];
      let profilePic = null;
      try {
        profilePic = await client.getProfilePicUrl(contactId);
      } catch (_) {}
      
      contactNames.set(canonicalId, displayName);
      contactProfilePics.set(canonicalId, profilePic || '');

      const messages = await chat.fetchMessages({ limit: 15 });
      const localHistory = [];
      
      for (const msg of messages) {
        let sender = 'user';
        if (msg.fromMe) {
          sender = (msg.body && msg.body.includes("🤖 _Gurpreet's AI Assistant_")) ? 'bot' : 'owner';
        }

        let mediaData = null;
        if (msg.hasMedia) {
          mediaData = {
            mediaUrl: null,
            mimetype: msg.type === 'image' ? 'image/jpeg' : (msg.type === 'video' ? 'video/mp4' : 'application/octet-stream'),
            filename: msg.filename || 'attachment'
          };
        }

        const msgData = {
          id: msg.id._serialized,
          timestamp: new Date(msg.timestamp * 1000).toISOString(),
          sender,
          text: msg.body || '',
          mediaUrl: mediaData ? mediaData.mediaUrl : null,
          mimetype: mediaData ? mediaData.mimetype : null,
          filename: mediaData ? mediaData.filename : null
        };

        localHistory.push(msgData);
        Database.saveMessage(DEFAULT_USER_ID, canonicalId, msgData);
      }
      
      chatLogsByContact.set(canonicalId, localHistory);
      Database.saveContact(DEFAULT_USER_ID, canonicalId, displayName, profilePic || '');
    }
    console.log(`[WHATSAPP] Successfully preloaded ${personalChats.length} chats!`);
  } catch (err) {
    console.error('[ERROR] Failed to preload chats:', err.message);
  }
}

// Event: Client successfully authenticated and ready
client.on('ready', () => {
  whatsappStatus = 'ready';
  latestQrCode = '';
  console.log('\n=============================================');
  console.log('  [SUCCESS] WhatsApp AI Assistant is READY!  ');
  console.log('=============================================\n');
  preloadRecentChats().catch(console.error);
});

// Helper to process and deliver AI replies (handles auto-switcher commands)
async function handleAiReply(msg, reply, messageText) {
  const contact = await msg.getContact();
  const canonicalId = contact.number ? `${contact.number}@c.us` : msg.from;

  if (reply.startsWith('__IMAGE__:')) {
    const prompt = reply.substring(10).trim();
    console.log(`[AUTO-SWITCHER] Detected IMAGE generation request. Prompt: "${prompt}"`);
    try {
      await msg.reply('🎨 *Generating your image... Please wait.*');
      const imageUrl = `https://image.pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error('Failed to fetch generated image');
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const media = new MessageMedia('image/jpeg', base64, 'imagine.jpg');
      
      const captionText = `🎨 *"${prompt}"*\n\nGenerated automatically via Pollinations AI.`;
      const sentMsg = await client.sendMessage(canonicalId, media, { caption: captionText });

      // Save to dashboard logs
      const history = chatLogsByContact.get(canonicalId) || [];
      const msgData = {
        id: sentMsg.id._serialized,
        timestamp: new Date().toLocaleTimeString(),
        sender: 'bot',
        text: captionText,
        mediaUrl: `/media/generated_${Date.now()}.jpg`, // placeholder representation for dashboard
        mimetype: 'image/jpeg',
        filename: 'generated_image.jpg'
      };
      history.push(msgData);
      if (history.length > 50) history.shift();
      chatLogsByContact.set(canonicalId, history);
      Database.saveMessage(DEFAULT_USER_ID, canonicalId, msgData);
      console.log(`[OUTGOING] Delivered generated image to ${canonicalId}`);
    } catch (err) {
      console.error('[AUTO-SWITCHER IMAGE ERROR]:', err.message);
      await msg.reply('❌ *Failed to generate image automatically. Please try again.*');
    }
    return;
  }

  if (reply.startsWith('__VIDEO__:')) {
    const prompt = reply.substring(10).trim();
    console.log(`[AUTO-SWITCHER] Detected VIDEO generation request. Prompt: "${prompt}"`);
    try {
      await msg.reply('🎥 *Video generation ke liye base frame/image generate kar raha hoon...*');
      const imageUrl = `https://image.pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error('Failed to fetch generated image');
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const media = new MessageMedia('image/jpeg', base64, 'video_frame.jpg');

      const videoHelp = `🎥 *AI Video Assistant (Base Frame Generated)* 🎬\n\n` +
        `Maine aapki video request ke liye ye base image/frame generate kar di hai.\n\n` +
        `👉 *Prompt*: "${prompt}"\n\n` +
        `Aap is photo ko download karke niche di gayi free websites par upload karein (Image-to-Video feature) aur use video animation me convert kar lein:\n\n` +
        `1️⃣ *PixVerse* — [app.pixverse.ai](https://app.pixverse.ai) (50-60 free daily videos)\n` +
        `2️⃣ *Leonardo AI* — [leonardo.ai](https://leonardo.ai) (150 free tokens)\n` +
        `3️⃣ *Runway ML* — [runwayml.com](https://runwayml.com/)\n\n` +
        `🤖 _Gurpreet's AI Assistant_`;

      const sentMsg = await client.sendMessage(canonicalId, media, { caption: videoHelp });

      // Save to dashboard logs
      const history = chatLogsByContact.get(canonicalId) || [];
      const msgData = {
        id: sentMsg.id._serialized,
        timestamp: new Date().toLocaleTimeString(),
        sender: 'bot',
        text: videoHelp,
        mediaUrl: `/media/generated_${Date.now()}.jpg`,
        mimetype: 'image/jpeg',
        filename: 'video_frame.jpg'
      };
      history.push(msgData);
      if (history.length > 50) history.shift();
      chatLogsByContact.set(canonicalId, history);
      Database.saveMessage(DEFAULT_USER_ID, canonicalId, msgData);
      console.log(`[OUTGOING] Delivered video base frame to ${canonicalId}`);
    } catch (err) {
      console.error('[AUTO-SWITCHER VIDEO ERROR]:', err.message);
      await msg.reply('❌ *Failed to process video prompt. Please try again.*');
    }
    return;
  }

  if (reply.startsWith('__SEND_MSG__:')) {
    const parts = reply.substring(13).split('||');
    const targetContactQuery = parts[0].trim();
    const msgToSend = parts[1] ? parts[1].trim() : '';

    console.log(`[AUTO-SWITCHER] Detected SEND_MSG task. Target: "${targetContactQuery}", Message: "${msgToSend}"`);

    if (!targetContactQuery || (!msgToSend && !msg.hasMedia)) {
      await msg.reply('❌ Please specify the contact name and the message. Example: "Send message to Rahul saying Hi"');
      return;
    }

    try {
      await msg.reply(`🔍 *Task Accepted!* Finding contact "${targetContactQuery}" and sending message...`);
      const contacts = await client.getContacts();
      const target = contacts.find(c => 
        c.isMyContact && (
          (c.name && c.name.toLowerCase().includes(targetContactQuery.toLowerCase())) ||
          (c.pushname && c.pushname.toLowerCase().includes(targetContactQuery.toLowerCase())) ||
          (c.number && c.number.includes(targetContactQuery))
        )
      );

      if (!target) {
        await msg.reply(`❌ Could not find any saved contact matching "${targetContactQuery}". Please check the name or provide the exact number.`);
        return;
      }

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        await client.sendMessage(target.id._serialized, media, { caption: msgToSend });
        await msg.reply(`✅ *Task Completed!* Successfully sent photo/media to *${target.name || target.pushname || target.number}* with message:\n\n"${msgToSend}"`);
      } else {
        await client.sendMessage(target.id._serialized, msgToSend);
        await msg.reply(`✅ *Task Completed!* Successfully sent message to *${target.name || target.pushname || target.number}*:\n\n"${msgToSend}"`);
      }
      
      console.log(`[TASK EXECUTION] Owner sent message to ${target.id._serialized} via AI Task`);
    } catch (err) {
      console.error('[TASK EXECUTION ERROR]:', err.message);
      await msg.reply('❌ *Failed to execute task. Please try again.*');
    }
    return;
  }

  // Regular chat text reply or voice reply
  const isIncomingVoice = msg.type === 'audio' || msg.type === 'ptt';
  
  if (isIncomingVoice) {
    try {
      console.log(`[TTS] Converting reply to speech for ${canonicalId} (Using Edge Neural Voice)...`);
      // Clean reply from formatting symbols
      const cleanReply = reply.replace(/[\*#_]/g, '').substring(0, 200);
      
      const tts = new EdgeTTS();
      await tts.synthesize(cleanReply, 'hi-IN-MadhurNeural');
      
      const tempMp3Prefix = path.join('./media_cache', `temp_${Date.now()}`);
      const savedMp3Path = await tts.toFile(tempMp3Prefix);

      const filename = `voice_reply_${Date.now()}.ogg`;
      const filePath = path.join('./media_cache', filename);
      
      // Convert MP3 to OGG Opus container for WhatsApp compatibility
      await convertToOggOpus(savedMp3Path, filePath);

      const oggBase64 = await fs.readFile(filePath).then(b => b.toString('base64'));
      const media = new MessageMedia('audio/ogg; codecs=opus', oggBase64, 'reply.ogg');
      const sentMsg = await client.sendMessage(canonicalId, media, { sendAudioAsVoice: true });

      // Clean up temporary MP3
      await fs.unlink(savedMp3Path).catch(() => {});
      
      const history = chatLogsByContact.get(canonicalId) || [];
      const msgData = {
        id: sentMsg.id._serialized,
        timestamp: new Date().toLocaleTimeString(),
        sender: 'bot',
        text: `🎤 [Voice Note]: "${reply}"`,
        mediaUrl: `/media/${filename}`,
        mimetype: 'audio/ogg',
        filename: 'reply.ogg'
      };
      history.push(msgData);
      if (history.length > 50) history.shift();
      chatLogsByContact.set(canonicalId, history);
      Database.saveMessage(DEFAULT_USER_ID, canonicalId, msgData);
      console.log(`[OUTGOING] Delivered voice note reply to ${canonicalId}`);
      return;
    } catch (err) {
      console.error('[TTS ERROR] Failed to send voice note, falling back to text:', err.message);
    }
  }

  const finalReply = reply + "\n\n🤖 _Gurpreet's AI Assistant_";
  const sentMsg = await msg.reply(finalReply);
  
  // Log bot's reply to dashboard logs
  const history = chatLogsByContact.get(canonicalId) || [];
  const msgData = {
    id: sentMsg.id._serialized,
    timestamp: new Date().toLocaleTimeString(),
    sender: 'bot',
    text: finalReply,
    mediaUrl: null,
    mimetype: null,
    filename: null
  };
  history.push(msgData);
  if (history.length > 50) history.shift();
  chatLogsByContact.set(canonicalId, history);
  Database.saveMessage(DEFAULT_USER_ID, canonicalId, msgData);
  console.log(`[OUTGOING] To: ${canonicalId} | Reply: "${finalReply.replace(/\n/g, ' ')}"`);
}

// Event: Message received (incoming messages from other users)
client.on('message', async (msg) => {
  try {
    // 1. Ignore group chats, newsletters, and broadcast channels
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || msg.from.endsWith('@broadcast') || msg.isStatus) {
      return;
    }

    const messageText = msg.body ? msg.body.trim() : '';
    // If there is no message text and no media, ignore it
    if (!messageText && !msg.hasMedia) return;

    // Resolve contact details name & profile pic and JID normalization
    let displayName = msg.from.split('@')[0];
    let profilePic = null;
    let canonicalId = msg.from;
    try {
      const contact = await msg.getContact();
      
      // [FILTER] Ignore messages from Business bots / Enterprise accounts
      if (contact.isBusiness || contact.isEnterprise) {
        console.log(`[IGNORED] Ignoring message from Business/Bot account: ${msg.from}`);
        return;
      }

      canonicalId = contact.number ? `${contact.number}@c.us` : msg.from;
      displayName = contact.name || contact.pushname || contact.number || displayName;
      profilePic = await client.getProfilePicUrl(msg.from);
    } catch (e) {
      console.error('[ERROR] Failed to get contact details:', e.message);
    }
    contactNames.set(canonicalId, displayName);
    contactProfilePics.set(canonicalId, profilePic || '');

    // 2. Admin command to clear chat memory (responds immediately)
    if (messageText.toLowerCase() === '!reset') {
      // Clear any pending timeouts for this user
      if (pendingReplies.has(canonicalId)) {
        clearTimeout(pendingReplies.get(canonicalId));
        pendingReplies.delete(canonicalId);
      }
      clearHistory(canonicalId);
      chatLogsByContact.delete(canonicalId);
      await msg.reply('✨ *Your chat history has been reset.* How can I help you today?');
      console.log(`[SYSTEM] Reset chat history for ${canonicalId}`);
      return;
    }

    // 3. Imagine Command to generate AI images (runs immediately)
    if (messageText.toLowerCase().startsWith('!imagine ')) {
      const prompt = messageText.substring(9).trim();
      if (!prompt) {
        await msg.reply('❌ Please provide a prompt! Example: `!imagine a futuristic city`');
        return;
      }

      await msg.reply('🎨 *Generating your image using Pollinations AI... Please wait.*');
      try {
        const imageUrl = `https://image.pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error('Failed to fetch generated image');
        const buffer = await res.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const media = new MessageMedia('image/jpeg', base64, 'imagine.jpg');
        await client.sendMessage(msg.from, media, { caption: `🎨 *"${prompt}"* generated by AI` });
        console.log(`[SYSTEM] Image generated successfully for ${msg.from} with prompt: "${prompt}"`);
      } catch (err) {
        console.error('[IMAGINE ERROR]:', err.message);
        await msg.reply('❌ *Failed to generate image. Please try again.*');
      }
      return;
    }

    // 4. Video Command to list and guide on free video generation (runs immediately)
    if (messageText.toLowerCase().startsWith('!video')) {
      const videoHelp = `🎥 *Free AI Video Generation Guide & Tools* 🎬\n\n` +
        `WhatsApp me real-time video generation directly limit aur latency ki wajah se slow hoti hai. Par aap niche diye gaye *properly working free platforms* par high-quality videos generate kar sakte hain:\n\n` +
        `1️⃣ *PixVerse* — [app.pixverse.ai](https://app.pixverse.ai)\n` +
        `👉 *Benefits*: Daily 50-60 video generations bilkul free (Text-to-Video & Image-to-Video).\n\n` +
        `2️⃣ *Leonardo AI* — [leonardo.ai](https://leonardo.ai)\n` +
        `👉 *Benefits*: Daily 150 free tokens. Motion effects aur cinematic movement animations ke liye best hai.\n\n` +
        `3️⃣ *Runway ML* — [runwayml.com](https://runwayml.com/)\n` +
        `👉 *Benefits*: Industry standard high quality Gen-2/Gen-3 models (lifetime trial credits).\n\n` +
        `💡 *Pro Tip*: Aap pehle is bot me *!imagine <prompt>* use karke image generate karein, fir use download karke *PixVerse* ya *Leonardo* par upload karke 3D animation video me convert kar lein!`;
      
      await msg.reply(videoHelp);
      return;
    }

    // 5. Quiz Command to generate a question
    if (messageText.toLowerCase().startsWith('!quiz ')) {
      const topic = messageText.substring(6).trim();
      if (!topic) {
        await msg.reply('❌ Please provide a topic! Example: `!quiz Javascript`');
        return;
      }
      await msg.reply(`🧠 *Generating a quiz on "${topic}"... Please wait.*`);
      try {
        const quizData = await generateQuizQuestion(topic);
        activeQuizzes.set(canonicalId, quizData);
        
        let quizMessage = `📝 *Quiz: ${topic}*\n\n*${quizData.task}*\n\n`;
        quizData.options.forEach((opt, idx) => {
          quizMessage += `${idx + 1}️⃣ ${opt}\n`;
        });
        quizMessage += `\n👉 *Reply with the option number (1-4) to check your answer!*`;
        
        await client.sendMessage(msg.from, quizMessage);
      } catch (err) {
        console.error('[QUIZ ERROR]', err);
        await msg.reply('❌ Failed to generate quiz. Please check AI API limits.');
      }
      return;
    }

    // 6. Handle active quiz answers
    if (activeQuizzes.has(canonicalId)) {
      const match = messageText.trim().match(/^[1-4]$/);
      if (match) {
        const userAnswerNum = parseInt(match[0], 10);
        const userAnswerIndex = userAnswerNum - 1;
        const quizData = activeQuizzes.get(canonicalId);
        activeQuizzes.delete(canonicalId); // End quiz
        
        await msg.reply('⏳ *Grading your answer via RapidAPI...*');
        try {
          const gradingResult = await evaluateAnswer(quizData, userAnswerIndex);
          if (gradingResult.correct) {
            await msg.reply(`✅ *Correct!* 🎉\n\n📖 *Explanation:* ${gradingResult.explanation}`);
          } else {
            const correctOpt = quizData.options[quizData.correctIndex];
            await msg.reply(`❌ *Incorrect!* 😔\nThe right answer was: *${quizData.correctIndex + 1}️⃣ ${correctOpt}*\n\n📖 *Explanation:* ${gradingResult.explanation}`);
          }
        } catch (err) {
          console.error('[QUIZ EVAL ERROR]', err);
          await msg.reply('❌ Error evaluating answer via RapidAPI.');
        }
        return; // Don't send this to normal AI chat
      }
    }

    console.log(`[INCOMING] From: ${displayName} (${msg.from}) | Msg: "${messageText}" | HasMedia: ${msg.hasMedia}`);

    let finalMessageText = messageText;

    // Download and save media if present
    let mediaData = null;
    if (msg.hasMedia) {
      mediaData = await saveMessageMedia(msg);
      
      // If it is a voice message, transcribe it using Gemini
      if (msg.type === 'audio' || msg.type === 'ptt') {
        try {
          console.log(`[WHATSAPP] Transcribing voice note from ${displayName}...`);
          const base64Audio = await msg.downloadMedia().then(m => m.data);
          const transcription = await transcribeAudio(base64Audio, msg.mime || 'audio/ogg');
          if (transcription) {
            console.log(`[WHATSAPP] Transcription result: "${transcription}"`);
            finalMessageText = `🎤 [Voice Message]: "${transcription}"`;
          } else {
            finalMessageText = `🎤 [Voice Message] (Transcription empty)`;
          }
        } catch (transcribeErr) {
          console.error('[WHATSAPP] Transcription failed:', transcribeErr.message);
          finalMessageText = `🎤 [Voice Message]`;
        }
      }
    }

    // Log incoming message to dashboard UI and Database
    const chatHistory = chatLogsByContact.get(canonicalId) || [];
    const incomingMsgData = {
      id: msg.id._serialized,
      timestamp: new Date().toLocaleTimeString(),
      sender: 'user',
      text: finalMessageText,
      mediaUrl: mediaData ? mediaData.mediaUrl : null,
      mimetype: mediaData ? mediaData.mimetype : null,
      filename: mediaData ? mediaData.filename : null
    };
    chatHistory.push(incomingMsgData);
    if (chatHistory.length > 50) chatHistory.shift();
    chatLogsByContact.set(canonicalId, chatHistory);
    Database.saveMessage(DEFAULT_USER_ID, canonicalId, incomingMsgData);
    Database.saveContact(DEFAULT_USER_ID, canonicalId, displayName, profilePic || '');

    // Add to AI history immediately to preserve media context!
    addMessage(canonicalId, 'user', finalMessageText, mediaData);

    // 5. Clear any existing pending reply timer for this sender
    if (pendingReplies.has(canonicalId)) {
      clearTimeout(pendingReplies.get(canonicalId));
      pendingReplies.delete(canonicalId);
    }

    // 6. Send AI reply using Smart Timing Engine
    if (messageText || msg.hasMedia) {
      const isPersonalMode = (canonicalId === (client.info ? client.info.wid._serialized : msg.to));
      
      if (!global.customerAiActive && !isPersonalMode) {
        console.log(`[IGNORED] Global Customer AI is OFF. Not replying to ${displayName}`);
        return;
      }

      const timing = getSmartDelay(messageText, new Date(), isPersonalMode);
      console.log(`[TIMING-ENGINE] Decision for ${displayName} (${canonicalId}): Delay ${Math.round(timing.delayMs / 1000)}s | Reason: "${timing.reason}"`);
      
      const timeoutId = setTimeout(async () => {
        try {
          pendingReplies.delete(canonicalId);
          
          // Perform one final check before sending (Is the user active or did they manually reply?)
          // Since we delete from pendingReplies when manual reply happens, 
          // we just need to verify that we are still supposed to reply.
          const chat = await msg.getChat();
          // If unreadCount is 0, it means the owner opened the chat on their phone and read it.
          // We cancel the AI reply so we don't interfere with the owner's manual chatting.
          if (chat.unreadCount === 0 && !isPersonalMode) {
            console.log(`[CANCELLED] Cancelled AI reply for ${canonicalId} because the owner read the message on their phone.`);
            return;
          }

          console.log(`[TIMING-ENGINE] Final check passed for ${canonicalId}. Delivering AI reply...`);
          const reply = await generateReply(canonicalId, messageText, mediaData, isPersonalMode);
          await handleAiReply(msg, reply, messageText);
        } catch (error) {
          console.error('[ERROR] Error sending smart timed AI reply:', error);
        }
      }, timing.delayMs);

      pendingReplies.set(canonicalId, timeoutId);
    }

  } catch (error) {
    console.error('[ERROR] Error processing message:', error);
  }
});

// Event: Message created (covers both sent and received messages)
// Used to detect when the bot owner (you) manually replies from your phone
client.on('message_create', async (msg) => {
  console.log(`[DEBUG] Message Event: from="${msg.from}" | to="${msg.to}" | body="${msg.body || ''}"`);
  
  // Track messages sent manually by the owner from their phone
  if (msg.fromMe && (msg.to.endsWith('@c.us') || msg.to.endsWith('@lid'))) {
    const rawTo = msg.to;
    let canonicalId = rawTo;
    
    // Resolve contact details name & profile pic for outgoing chat list display
    let displayName = rawTo.split('@')[0];
    let profilePic = null;
    let isMeChat = false;
    try {
      const contact = await client.getContactById(rawTo);
      isMeChat = contact.isMe || (msg.to === msg.from) || rawTo === client.info.wid._serialized;
      canonicalId = contact.number ? `${contact.number}@c.us` : rawTo;
      displayName = contact.name || contact.pushname || contact.number || displayName;
      profilePic = await client.getProfilePicUrl(rawTo);
    } catch (e) {
      console.error('[ERROR] Failed to get contact details in message_create:', e.message);
    }
    contactNames.set(canonicalId, displayName);
    contactProfilePics.set(canonicalId, profilePic || '');

    // [PERSONAL AI MODE]
    // The user must type 'hi ai' to activate the personal assistant in the "Message Yourself" chat.
    if (msg.fromMe && isMeChat && !msg.body.includes("Gurpreet's AI Assistant")) {
      const text = msg.body.trim().toLowerCase();
      
      if (text === 'hi ai') {
        global.personalAiActive = true;
        await Database.setAppState('personalAiActive', 'true');
        client.sendMessage(msg.to, "🤖 *Personal AI Assistant Activated!*\n\nMain ab yahan aapke har message ka turant reply karunga. Deactivate karne ke liye type karein: *bye ai*");
        return;
      }
      
      if (text.startsWith('bye ai') || text.startsWith('stop ai')) {
        global.personalAiActive = false;
        await Database.setAppState('personalAiActive', 'false');
        client.sendMessage(msg.to, "🤖 *Personal AI Assistant Deactivated!*\n\nMain ab yahan automatically reply nahi karunga.");
        return;
      }

      if (text.startsWith('bot off') || text.startsWith('bot of')) {
        global.customerAiActive = false;
        await Database.setAppState('customerAiActive', 'false');
        client.sendMessage(msg.to, "🤖 *Global Auto-Reply OFF!*\n\nMain ab dusre logon (customers) ko automatically reply nahi karunga.\n(Aapka Personal AI 'hi ai' command se kaam karta rahega).");
        return;
      }

      if (text.startsWith('bot on')) {
        global.customerAiActive = true;
        await Database.setAppState('customerAiActive', 'true');
        client.sendMessage(msg.to, "🤖 *Global Auto-Reply ON!*\n\nMain ab baaki sab logon ko wapas automatically reply karunga.");
        return;
      }

      if (global.personalAiActive) {
        console.log(`[PERSONAL AI MODE] Owner sent message to themselves. Generating AI reply...`);
        client.emit('message', msg);
      }
      return; 
    }

    // Clear any pending AI replies (if you reply manually to someone else)
    if (pendingReplies.has(canonicalId)) {
      clearTimeout(pendingReplies.get(canonicalId));
      pendingReplies.delete(canonicalId);
      console.log(`[CANCELLED] Cancelled AI reply for ${canonicalId} because you replied manually.`);
    }

    // Download and save media if present
    let mediaData = null;
    if (msg.hasMedia) {
      mediaData = await saveMessageMedia(msg);
    }

    // Add manually sent message to dashboard chat history (preventing duplicates)
    const chatHistory = chatLogsByContact.get(canonicalId) || [];
    const isDuplicate = chatHistory.length > 0 && 
                        chatHistory[chatHistory.length - 1].sender === 'owner' && 
                        chatHistory[chatHistory.length - 1].text === msg.body &&
                        chatHistory[chatHistory.length - 1].mediaUrl === (mediaData ? mediaData.mediaUrl : null);
                        
    if (!isDuplicate && (msg.body || msg.hasMedia)) {
      chatHistory.push({
        id: msg.id._serialized,
        timestamp: new Date().toLocaleTimeString(),
        sender: 'owner',
        text: msg.body || '',
        mediaUrl: mediaData ? mediaData.mediaUrl : null,
        mimetype: mediaData ? mediaData.mimetype : null,
        filename: mediaData ? mediaData.filename : null
      });
      if (chatHistory.length > 50) chatHistory.shift();
      chatLogsByContact.set(canonicalId, chatHistory);
    }
  }
});

// Event: Message ack (when a message read receipt is updated)
// If the owner reads an incoming message on their phone, its ack becomes 3 (READ)
client.on('message_ack', async (msg, ack) => {
  // ack 3 means READ (Blue ticks)
  if (ack === 3 && !msg.fromMe) {
    const rawFrom = msg.from;
    const canonicalId = rawFrom.includes('@lid') ? rawFrom : (rawFrom.includes('@') ? rawFrom : `${rawFrom}@c.us`);
    
    // Don't cancel if it's the "Message Yourself" chat and AI is active!
    if (global.personalAiActive && canonicalId === client.info.wid._serialized) {
      return;
    }

    if (pendingReplies.has(canonicalId)) {
      clearTimeout(pendingReplies.get(canonicalId));
      pendingReplies.delete(canonicalId);
      console.log(`[CANCELLED] Cancelled AI reply for ${canonicalId} because the owner read the message (Blue Ticks).`);
    }
  }
});

// Event: Chat read (when owner reads a chat on their phone)
client.on('chat_read', async (chat) => {
  try {
    const contact = await chat.getContact();
    const canonicalId = contact.number ? `${contact.number}@c.us` : chat.id._serialized;
    
    // Do not cancel if it's the "Message Yourself" chat and AI is active!
    if (global.personalAiActive && canonicalId === client.info.wid._serialized) {
      return;
    }

    if (pendingReplies.has(canonicalId)) {
      clearTimeout(pendingReplies.get(canonicalId));
      pendingReplies.delete(canonicalId);
      console.log(`[CANCELLED] Cancelled AI reply for ${canonicalId} because the chat was marked as read (Owner Active).`);
    }
  } catch (e) {
    console.error('[ERROR] Failed to get contact details in chat_read:', e.message);
  }
});

// Event: Call received
client.on('incoming_call', async (call) => {
  try {
    const ownerStatus = (config.assistant.status || '').toLowerCase();
    const busyKeywords = ['busy', 'offline', 'meeting', 'dnd', 'sleep', 'unavailable', 'working'];
    const isBusy = busyKeywords.some(keyword => ownerStatus.includes(keyword));

    if (isBusy) {
      console.log(`[CALL] Incoming call from ${call.from} rejected because owner is BUSY ("${config.assistant.status}").`);
      await call.reject();
      
      const alertMsg = `📞 *Missed Call Alert*\n\nHello! I am Gurpreet's AI Assistant. Gurpreet is currently: *"${config.assistant.status}"*.\n\nHe cannot pick up voice/video calls right now. Please drop a text message or send a voice note, and I will assist you!`;
      await client.sendMessage(call.from, alertMsg);
    } else {
      console.log(`[CALL] Incoming call from ${call.from} allowed to ring (Owner is not busy).`);
    }
  } catch (err) {
    console.error('[ERROR] Error handling incoming call:', err.message);
  }
});

// Event: Authentication failure
client.on('auth_failure', (msg) => {
  whatsappStatus = 'disconnected';
  console.error('[WHATSAPP] Authentication failure:', msg);
});

// Event: Client disconnected
client.on('disconnected', (reason) => {
  whatsappStatus = 'disconnected';
  console.log('[WHATSAPP] Client was disconnected:', reason);
});

client.initialize();

// No fallback route needed for simple bot
