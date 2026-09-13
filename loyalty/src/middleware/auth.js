import { config } from '../config.js';
import { sessions, staff } from '../db.js';
import { randomToken, verifyPassword } from '../util/crypto.js';

export function createSession(res, staffRow) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.session.hours * 3600e3);
  sessions.create(token, staffRow.id, expiresAt.toISOString());
  res.cookie(config.session.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: config.session.hours * 3600e3,
    path: '/',
  });
  return token;
}

export function destroySession(req, res) {
  const token = req.cookies?.[config.session.cookieName];
  if (token) sessions.destroy(token);
  res.clearCookie(config.session.cookieName, { path: '/' });
}

/** Attaches req.staff when a valid session cookie is present. */
export function loadStaff(req, _res, next) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token) return next();

  const session = sessions.get(token);
  if (!session) return next();
  if (Date.parse(session.expires_at) < Date.now()) {
    sessions.destroy(token);
    return next();
  }

  const row = staff.byId(session.staff_id);
  if (row && row.active) req.staff = row;
  return next();
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.get('accept')?.includes('application/json') || req.method !== 'GET';
}

export function requireStaff(req, res, next) {
  if (req.staff) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'נדרשת התחברות', code: 'unauthorized' });
  const back = encodeURIComponent(req.originalUrl);
  return res.redirect(`/staff/login?next=${back}`);
}

export function requireAdmin(req, res, next) {
  if (req.staff?.role === 'admin') return next();
  if (!req.staff) return requireStaff(req, res, next);
  if (wantsJson(req)) return res.status(403).json({ error: 'נדרשות הרשאות מנהל', code: 'forbidden' });
  return res.status(403).send('נדרשות הרשאות מנהל');
}

/** Simple in-memory throttle — enough for a single-cafe deployment. */
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 20, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const k = `${req.path}:${key(req)}`;
    const now = Date.now();
    const bucket = buckets.get(k);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count++;
    if (bucket.count > max) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `יותר מדי בקשות. נסו שוב בעוד ${retry} שניות.`, code: 'rate_limited' });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  sessions.purgeExpired();
}, 10 * 60_000).unref();

export function authenticate(username, password) {
  const row = staff.byUsername(String(username || '').trim().toLowerCase());
  if (!row || !row.active) return null;
  if (!verifyPassword(String(password || ''), row.password_hash)) return null;
  return row;
}
