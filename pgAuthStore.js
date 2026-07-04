import fs from 'fs';
import path from 'path';

/**
 * Custom Postgres Store for whatsapp-web.js RemoteAuth
 */
export class PgStore {
    constructor({ pool }) {
        if (!pool) throw new Error('A valid pg Pool instance is required.');
        this.pool = pool;
    }

    async sessionExists(options) {
        try {
            const result = await this.pool.query(
                `SELECT 1 FROM whatsapp_sessions WHERE session_id = $1 LIMIT 1`,
                [options.session]
            );
            return result.rowCount > 0;
        } catch (error) {
            console.error('[PgStore] Error checking session:', error);
            return false;
        }
    }

    async save(options) {
        try {
            // RemoteAuth creates the zip file at: .wwebjs_auth/{session}.zip
            // If dataPath was customized in RemoteAuth options, we would need to pass it here,
            // but we'll use the default '.wwebjs_auth' since we know that's what app.js uses.
            const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `${options.session}.zip`);
            
            if (!fs.existsSync(sessionPath)) {
                throw new Error(`Session file not found at ${sessionPath}`);
            }

            const buffer = fs.readFileSync(sessionPath);
            
            await this.pool.query(
                `INSERT INTO whatsapp_sessions (session_id, session_data, updated_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (session_id) DO UPDATE 
                 SET session_data = EXCLUDED.session_data, updated_at = EXCLUDED.updated_at`,
                [options.session, buffer, Date.now()]
            );
            console.log(`[PgStore] Successfully saved session '${options.session}' to Postgres.`);
        } catch (error) {
            console.error('[PgStore] Error saving session:', error);
        }
    }

    async extract(options) {
        try {
            const result = await this.pool.query(
                `SELECT session_data FROM whatsapp_sessions WHERE session_id = $1`,
                [options.session]
            );

            if (result.rowCount === 0) {
                throw new Error(`No session data found for '${options.session}'`);
            }

            // RemoteAuth passes the exact path it wants the zip extracted to
            const buffer = result.rows[0].session_data;
            fs.writeFileSync(options.path, buffer);
            console.log(`[PgStore] Successfully extracted session '${options.session}' from Postgres.`);
        } catch (error) {
            console.error('[PgStore] Error extracting session:', error);
        }
    }

    async delete(options) {
        try {
            await this.pool.query(
                `DELETE FROM whatsapp_sessions WHERE session_id = $1`,
                [options.session]
            );
            console.log(`[PgStore] Successfully deleted session '${options.session}' from Postgres.`);
        } catch (error) {
            console.error('[PgStore] Error deleting session:', error);
        }
    }
}
