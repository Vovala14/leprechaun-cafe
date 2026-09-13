import crypto from 'node:crypto';
import { config } from '../config.js';

const B64URL = 'base64url';

export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString(B64URL);
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString(B64URL);

function hmac(data) {
  return crypto.createHmac('sha256', config.secret).update(data).digest(B64URL);
}

/**
 * The string encoded in the customer's QR code.
 *
 * Format: LPR1.<publicId>.<signature>
 *
 * The token is stable for the life of the card — a wallet barcode can only change
 * when we push an update, so a rotating code would break offline scanning. The
 * signature stops anyone from inventing card numbers; the real protection against
 * a stolen screenshot is that /staff/api/* requires a signed-in staff session.
 */
export function cardToken(publicId) {
  return `LPR1.${publicId}.${hmac(publicId).slice(0, 22)}`;
}

/** Returns the publicId when the token is authentic, otherwise null. */
export function verifyCardToken(token) {
  if (typeof token !== 'string') return null;
  const raw = token.trim();

  // Staff may also scan or type the bare public id; accept both shapes.
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'LPR1') {
    return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
  }
  const [, publicId, sig] = parts;
  const expected = hmac(publicId).slice(0, 22);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return publicId;
}

/** Extracts a public id from a token, a bare id, or a full card URL. */
export function parseScanInput(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  const urlMatch = value.match(/\/c\/([A-Za-z0-9_-]{8,64})/);
  if (urlMatch) return urlMatch[1];
  return verifyCardToken(value);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const key = crypto.scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
