import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Database } from './database.js';

export function setupAuth(app) {
  // Validate presence of OAuth credentials
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn('[AUTH] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env. Google Login will not work.');
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID || 'dummy-client-id',
        clientSecret: GOOGLE_CLIENT_SECRET || 'dummy-client-secret',
        callbackURL: '/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // Check if user exists
          let user = await Database.getUserByGoogleId(profile.id);

          if (user) {
            // Update last login
            await Database.updateLastLogin(user.internalId);
          } else {
            // Create new user with AI-00000X format
            user = await Database.createUser(profile);
            console.log(`[AUTH] New user created: ${user.internalId} (${user.email})`);
          }

          return done(null, user);
        } catch (err) {
          console.error('[AUTH ERROR]:', err);
          return done(err, null);
        }
      }
    )
  );

  // Serialize user into the session (store only the internal ID)
  passport.serializeUser((user, done) => {
    done(null, user.internalId);
  });

  // Deserialize user from the session (fetch user data using the internal ID)
  passport.deserializeUser(async (internalId, done) => {
    try {
      const user = await Database.getUser(internalId);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());
}

// Middleware to protect routes
export function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
