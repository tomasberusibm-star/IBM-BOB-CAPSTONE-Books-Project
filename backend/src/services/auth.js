import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../errors.js';
import { withTransaction } from '../db.js';

const ISSUER = 'bookstore-api';
const AUDIENCE = 'bookstore-clients';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (value) => createHash('sha256').update(value).digest();

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid e-mail or password.');

const toUser = (r) => ({
  id: r.public_id,
  email: r.email,
  first_name: r.first_name,
  last_name: r.last_name,
  status: r.status,
  created_at: r.created_at,
});

/**
 * Authentication and session handling.
 *
 * Login creates a row in user_sessions and returns a short-lived JWT (HS256) that
 * carries the session id (`sid`) and a random secret (`jti`). Only SHA-256(jti) is
 * stored, and every request is checked against the session row, so logout, suspension
 * and expiry take effect immediately instead of when the JWT happens to expire.
 */
export function createAuthService({ pool, config, logger }) {
  const secret = new TextEncoder().encode(config.jwtSecret);
  let dummyHash;
  // Hash verified for unknown e-mails so timing does not reveal which accounts exist.
  const getDummyHash = () => (dummyHash ??= argon2.hash(randomBytes(16).toString('hex')));

  async function recordAttempt(userId, email, succeeded, ip) {
    try {
      await pool.query(
        'INSERT INTO login_attempts (user_id, email, succeeded, ip_address) VALUES ($1, $2, $3, $4)',
        [userId, email, succeeded, ip ?? null],
      );
    } catch (err) {
      logger.error({ err }, 'could not record login attempt'); // never block login on audit failure
    }
  }

  async function registerFailure(userId) {
    // Atomic: counts the failure, restarts the count after an expired lock, locks at the limit.
    await pool.query(
      `UPDATE user_credentials c
          SET failed_login_count = n.cnt,
              locked_until = CASE WHEN n.cnt >= $2 THEN now() + make_interval(mins => $3::int) END
         FROM (SELECT user_id,
                      CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                           ELSE failed_login_count + 1 END AS cnt
                 FROM user_credentials WHERE user_id = $1 FOR UPDATE) n
        WHERE c.user_id = n.user_id`,
      [userId, config.loginMaxFailures, config.loginLockMinutes],
    );
  }

  return {
    async register({ email, password, first_name, last_name, phone }) {
      const hash = await argon2.hash(password); // argon2id with library defaults
      const active = !config.requireEmailVerification;
      try {
        return await withTransaction(pool, async (db) => {
          const { rows } = await db.query(
            `INSERT INTO users (email, first_name, last_name, phone, status, email_verified_at)
             VALUES ($1, $2, $3, $4, $5::user_status, CASE WHEN $5 = 'active' THEN now() END)
             RETURNING id, public_id, email, first_name, last_name, status, created_at`,
            [email, first_name, last_name, phone ?? null, active ? 'active' : 'pending_verification'],
          );
          await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [rows[0].id, hash]);
          return toUser(rows[0]);
        });
      } catch (err) {
        if (err?.code === '23505') {
          throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this e-mail address already exists.');
        }
        throw err;
      }
    },

    async login({ email, password }, { ip, userAgent }) {
      const { rows } = await pool.query(
        `SELECT u.id, u.public_id, u.email, u.first_name, u.last_name, u.status, u.created_at,
                c.password_hash,
                (c.locked_until IS NOT NULL AND c.locked_until > now()) AS locked
           FROM users u JOIN user_credentials c ON c.user_id = u.id
          WHERE u.email = $1 AND u.deleted_at IS NULL`,
        [email],
      );
      const u = rows[0];

      if (!u) {
        await argon2.verify(await getDummyHash(), password).catch(() => false);
        await recordAttempt(null, email, false, ip);
        throw invalidCredentials();
      }
      if (u.locked) {
        await recordAttempt(u.id, email, false, ip);
        throw invalidCredentials();
      }
      const ok = await argon2.verify(u.password_hash, password).catch(() => false);
      if (!ok) {
        await registerFailure(u.id);
        await recordAttempt(u.id, email, false, ip);
        throw invalidCredentials();
      }
      if (u.status !== 'active') {
        // Correct password but not allowed in (unverified, suspended, closed): same generic answer.
        await recordAttempt(u.id, email, false, ip);
        throw invalidCredentials();
      }

      const expiresAt = Math.floor(Date.now() / 1000) + config.accessTokenTtlSeconds;
      const jti = randomBytes(32).toString('base64url');
      const sessionId = await withTransaction(pool, async (db) => {
        await db.query(
          'UPDATE user_credentials SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
          [u.id],
        );
        await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
        const { rows: s } = await db.query(
          `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5)) RETURNING id`,
          [u.id, sha256(jti), ip ?? null, (userAgent ?? '').slice(0, 255) || null, expiresAt],
        );
        return s[0].id;
      });
      await recordAttempt(u.id, email, true, ip);

      const accessToken = await new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(u.public_id)
        .setJti(jti)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(secret);

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        user: toUser(u),
      };
    },

    /** Returns { userId, publicId, sessionId } for a valid, live session, otherwise null. */
    async authenticate(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE }));
      } catch {
        return null;
      }
      if (typeof payload.sid !== 'string' || !UUID.test(payload.sid) || typeof payload.jti !== 'string') return null;

      const { rows } = await pool.query(
        `SELECT u.id, u.public_id
           FROM user_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.token_hash = $2
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.status = 'active' AND u.deleted_at IS NULL AND u.public_id = $3`,
        [payload.sid, sha256(payload.jti), payload.sub],
      );
      if (rows.length === 0) return null;
      await pool.query(
        `UPDATE user_sessions SET last_seen_at = now()
          WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
        [payload.sid],
      );
      return { userId: rows[0].id, publicId: rows[0].public_id, sessionId: payload.sid };
    },

    async logout(sessionId) {
      await pool.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
    },
  };
}
