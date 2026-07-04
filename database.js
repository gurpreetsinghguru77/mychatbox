import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

// Initialize Postgres connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err, client) => {
  console.error('[DATABASE] Unexpected error on idle client', err);
  // Do NOT exit process. pg-pool will automatically remove the bad client and reconnect on next query.
});

// Initialize database tables
async function initDb() {
  const client = await pool.connect();
  try {
    console.log('[DATABASE] Connected to PostgreSQL storage');

    await client.query('BEGIN');

    // Users Table
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      internalId TEXT PRIMARY KEY,
      googleId TEXT UNIQUE,
      name TEXT,
      email TEXT UNIQUE,
      profilePic TEXT,
      createdAt BIGINT,
      lastLogin BIGINT,
      timeZone TEXT,
      language TEXT
    )`);

    // Connected Accounts
    await client.query(`CREATE TABLE IF NOT EXISTS connected_accounts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      provider TEXT NOT NULL,
      providerId TEXT,
      status TEXT,
      createdAt BIGINT
    )`);

    // User Preferences
    await client.query(`CREATE TABLE IF NOT EXISTS user_preferences (
      userId TEXT PRIMARY KEY,
      theme TEXT,
      notificationsEnabled INTEGER,
      autoAiReply INTEGER
    )`);

    // Auth Logs
    await client.query(`CREATE TABLE IF NOT EXISTS auth_logs (
      id TEXT PRIMARY KEY,
      userId TEXT,
      action TEXT,
      ipAddress TEXT,
      timestamp BIGINT
    )`);

    // Contacts / Chats
    await client.query(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      contactId TEXT NOT NULL,
      name TEXT,
      profilePic TEXT
    )`);

    // Messages Table (Persistent Chat Logs)
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      contactId TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT,
      mediaUrl TEXT,
      mimetype TEXT,
      filename TEXT,
      timestamp TEXT NOT NULL,
      createdAt BIGINT NOT NULL
    )`);

    // Notes Table
    await client.query(`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      contactId TEXT NOT NULL,
      aiSummary TEXT,
      manualNotes TEXT,
      updatedAt BIGINT NOT NULL
    )`);

    // App State Table (For Personal AI State, etc.)
    await client.query(`CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    // WhatsApp RemoteAuth Sessions Table
    await client.query(`CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_id TEXT PRIMARY KEY,
      session_data BYTEA NOT NULL,
      updated_at BIGINT
    )`);

    // Index
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_contactId ON messages(contactId)`);

    await client.query('COMMIT');
    this._initialized = true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DATABASE] Initialization error:', e);
  } finally {
    client.release();
  }
}

// Exportable Database functions
export const Database = {
  // Pass the pool for custom stores
  pool: pool,

  async initDb() {
    if (!this._initialized) {
      await initDb.call(this);
    }
  },

  // App State Methods (Replaces state.json)
  async getAppState(key) {
    const res = await pool.query(`SELECT value FROM app_state WHERE key = $1`, [key]);
    return res.rows.length ? res.rows[0].value : null;
  },
  
  async setAppState(key, value) {
    await pool.query(
      `INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  },

  // User Methods
  async getUser(internalId) {
    const res = await pool.query(`SELECT * FROM users WHERE internalId = $1`, [internalId]);
    return res.rows[0];
  },

  async getUserByGoogleId(googleId) {
    const res = await pool.query(`SELECT * FROM users WHERE googleId = $1`, [googleId]);
    return res.rows[0];
  },

  async createUser(googleProfile) {
    const countRes = await pool.query(`SELECT COUNT(*) as count FROM users`);
    const count = parseInt(countRes.rows[0].count, 10) + 1;
    const internalId = `AI-${String(count).padStart(6, '0')}`;

    const { id: googleId, displayName: name, emails, photos } = googleProfile;
    const email = emails?.[0]?.value || null;
    const profilePic = photos?.[0]?.value || null;
    const createdAt = Date.now();

    await pool.query(
      `INSERT INTO users (internalId, googleId, name, email, profilePic, createdAt, lastLogin) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [internalId, googleId, name, email, profilePic, createdAt, createdAt]
    );

    return await this.getUser(internalId);
  },

  async updateLastLogin(internalId) {
    await pool.query(`UPDATE users SET lastLogin = $1 WHERE internalId = $2`, [Date.now(), internalId]);
  },

  // Contact Methods
  async saveContact(userId, contactId, name, profilePic) {
    const id = `${userId}_${contactId}`;
    await pool.query(
      `INSERT INTO contacts (id, userId, contactId, name, profilePic) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, profilePic=EXCLUDED.profilePic`,
      [id, userId, contactId, name, profilePic]
    );
  },

  async getAllContacts(userId) {
    const res = await pool.query(`SELECT * FROM contacts WHERE userId = $1`, [userId]);
    return res.rows;
  },

  async saveMessage(userId, contactId, msg) {
    const id = `${userId}_${msg.id}`;
    await pool.query(
      `INSERT INTO messages (id, userId, contactId, sender, text, mediaUrl, mimetype, filename, timestamp, createdAt) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [id, userId, contactId, msg.sender, msg.text || '', msg.mediaUrl || null, msg.mimetype || null, msg.filename || null, msg.timestamp, Date.now()]
    );
  },

  async getChatHistory(userId, contactId, limit = 50) {
    const res = await pool.query(
      `SELECT * FROM messages WHERE userId = $1 AND contactId = $2 ORDER BY createdAt ASC LIMIT $3`,
      [userId, contactId, limit]
    );
    return res.rows;
  },

  async deleteMessage(messageId) {
    await pool.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
  },

  async updateMessageText(messageId, newText) {
    await pool.query(`UPDATE messages SET text = $1 WHERE id = $2`, [newText, messageId]);
  },

  async getNotes(userId, contactId) {
    const id = `${userId}_${contactId}`;
    const res = await pool.query(`SELECT * FROM notes WHERE id = $1`, [id]);
    return res.rows[0];
  },

  async saveManualNotes(userId, contactId, manualNotes) {
    const id = `${userId}_${contactId}`;
    await pool.query(
      `INSERT INTO notes (id, userId, contactId, manualNotes, updatedAt) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET manualNotes=EXCLUDED.manualNotes, updatedAt=EXCLUDED.updatedAt`,
      [id, userId, contactId, manualNotes, Date.now()]
    );
  },

  async saveAiSummary(userId, contactId, aiSummary) {
    const id = `${userId}_${contactId}`;
    await pool.query(
      `INSERT INTO notes (id, userId, contactId, aiSummary, updatedAt) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET aiSummary=EXCLUDED.aiSummary, updatedAt=EXCLUDED.updatedAt`,
      [id, userId, contactId, aiSummary, Date.now()]
    );
  }
};
