import jwt from 'jsonwebtoken';
import { config, googleReady, googleClassId } from '../config.js';
import { customers } from '../db.js';
import { cardState, GOAL } from './loyalty.js';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: config.google.serviceAccountEmail,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    config.google.serviceAccountKey,
    { algorithm: 'RS256' }
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google OAuth נכשל (${res.status}): ${body.error_description || body.error || 'unknown'}`);
  }

  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function api(method, pathname, body) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

const localized = (value) => ({ defaultValue: { language: 'he', value } });

export function objectIdFor(publicId) {
  const suffix = `card_${String(publicId).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  return `${config.google.issuerId}.${suffix}`;
}

export function buildClass() {
  const { business } = config;
  const logoUri = `${config.baseUrl}/assets/pass/logo@2x.png`;
  const heroUri = `${config.baseUrl}/assets/pass/hero.png`;

  return {
    id: googleClassId,
    issuerName: business.name,
    programName: `מועדון הקפה של ${business.name}`,
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: config.brand.green,
    countryCode: 'IL',
    programLogo: { sourceUri: { uri: logoUri }, contentDescription: localized(`לוגו ${business.name}`) },
    heroImage: { sourceUri: { uri: heroUri }, contentDescription: localized('כרטיסיית קפה') },
    locations: [{ latitude: business.lat, longitude: business.lng }],
    textModulesData: [
      { id: 'how', header: 'איך זה עובד', body: `קונים ${GOAL} קפה — ה־${GOAL + 1} עלינו. מציגים את הכרטיסייה בקופה והברמן/ית סורק/ת.` },
      { id: 'where', header: 'איפה אנחנו', body: `${business.address} · ${business.phone}` },
    ],
    linksModuleData: {
      uris: [
        { uri: `tel:${business.phone}`, description: 'התקשרו אלינו', id: 'phone' },
        { uri: business.instagram, description: 'אינסטגרם', id: 'instagram' },
        {
          uri: `https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`,
          description: 'ניווט',
          id: 'map',
        },
      ],
    },
  };
}

export function buildObject(customer) {
  const s = cardState(customer);
  const { business } = config;

  return {
    id: objectIdFor(s.publicId),
    classId: googleClassId,
    state: s.blocked ? 'INACTIVE' : 'ACTIVE',
    accountId: s.publicId,
    accountName: s.name || 'חבר/ת מועדון',
    hexBackgroundColor: config.brand.green,
    loyaltyPoints: { label: 'ניקובים', balance: { string: s.text.counter } },
    secondaryLoyaltyPoints: {
      label: s.rewardReady ? 'סטטוס' : 'עד קפה חינם',
      balance: { string: s.rewardReady ? 'קפה חינם מחכה 🍀' : `עוד ${s.remaining}` },
    },
    barcode: { type: 'QR_CODE', value: s.token, alternateText: s.publicId },
    locations: [{ latitude: business.lat, longitude: business.lng }],
    textModulesData: [
      { id: 'status', header: 'סטטוס', body: s.text.headline },
      { id: 'totals', header: 'הסטוריה', body: `סה״כ קפה שקנית: ${s.totalPunches} · קפה חינם שקיבלת: ${s.totalRewards}` },
      { id: 'card', header: 'מספר כרטיסייה', body: s.publicId },
    ],
    linksModuleData: {
      uris: [{ uri: s.cardUrl, description: 'הכרטיסייה באינטרנט', id: 'web' }],
    },
  };
}

/** Creates the loyalty class, or updates it if it already exists. */
export async function ensureClass() {
  if (!googleReady) throw new Error('Google Wallet is not configured');
  const payload = buildClass();

  const existing = await api('GET', `/loyaltyClass/${encodeURIComponent(googleClassId)}`);
  if (existing.ok) {
    const updated = await api('PUT', `/loyaltyClass/${encodeURIComponent(googleClassId)}`, payload);
    if (!updated.ok) throw new Error(`עדכון המחלקה נכשל (${updated.status}): ${JSON.stringify(updated.body)}`);
    return { created: false, class: updated.body };
  }
  if (existing.status !== 404) {
    throw new Error(`בדיקת המחלקה נכשלה (${existing.status}): ${JSON.stringify(existing.body)}`);
  }

  const created = await api('POST', '/loyaltyClass', payload);
  if (!created.ok) throw new Error(`יצירת המחלקה נכשלה (${created.status}): ${JSON.stringify(created.body)}`);
  return { created: true, class: created.body };
}

/** Creates the customer's loyalty object if missing. Safe to call repeatedly. */
export async function ensureObject(customer) {
  if (!googleReady) throw new Error('Google Wallet is not configured');
  const objectId = objectIdFor(customer.public_id);

  const existing = await api('GET', `/loyaltyObject/${encodeURIComponent(objectId)}`);
  if (existing.ok) {
    if (!customer.google_object_id) customers.setGoogleObject(customer.id, objectId);
    return { created: false, objectId };
  }
  if (existing.status !== 404) {
    throw new Error(`בדיקת הכרטיס נכשלה (${existing.status}): ${JSON.stringify(existing.body)}`);
  }

  const created = await api('POST', '/loyaltyObject', buildObject(customer));
  if (!created.ok) throw new Error(`יצירת הכרטיס נכשלה (${created.status}): ${JSON.stringify(created.body)}`);
  customers.setGoogleObject(customer.id, objectId);
  return { created: true, objectId };
}

/**
 * Pushes the current punch count to Google. The updated card appears on the
 * phone within seconds. Never throws — a sync failure must not block the counter.
 */
export async function syncObject(customer) {
  if (!googleReady) return { skipped: true };
  const objectId = objectIdFor(customer.public_id);
  try {
    const res = await api('PATCH', `/loyaltyObject/${encodeURIComponent(objectId)}`, buildObject(customer));
    if (res.status === 404) {
      await ensureObject(customer);
      return { created: true };
    }
    if (!res.ok) {
      console.warn(`[google] עדכון הכרטיס נכשל (${res.status}):`, JSON.stringify(res.body).slice(0, 300));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[google] שגיאת סנכרון:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * The "Save to Google Wallet" link. The object is embedded in full so the very
 * first save works even if the object was not created through the API yet.
 */
export function saveLink(customer) {
  if (!googleReady) return null;
  const origin = new URL(config.baseUrl).origin;
  const claims = {
    iss: config.google.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [origin],
    payload: { loyaltyObjects: [buildObject(customer)] },
  };
  const token = jwt.sign(claims, config.google.serviceAccountKey, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}
