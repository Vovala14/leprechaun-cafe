import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** Read a secret that may arrive either as a file path or as base64 in the env. */
function readSecret(pathVar, b64Var) {
  const b64 = process.env[b64Var];
  if (b64 && b64.trim()) return Buffer.from(b64.trim(), 'base64');
  const p = process.env[pathVar];
  if (!p || !p.trim()) return null;
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),

  /** Public HTTPS origin, e.g. https://club.leprechaun.co.il — no trailing slash. */
  baseUrl: (process.env.BASE_URL || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/+$/, ''),

  /** Signs QR tokens and staff session cookies. Must be stable across restarts. */
  secret: process.env.APP_SECRET || '',

  dbPath: process.env.DB_PATH
    ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.join(ROOT, process.env.DB_PATH))
    : path.join(ROOT, 'data', 'loyalty.db'),

  business: {
    name: process.env.BUSINESS_NAME || 'קפה לפריקון',
    nameEn: process.env.BUSINESS_NAME_EN || 'Leprechaun Cafe',
    address: process.env.BUSINESS_ADDRESS || 'דרך ארץ 58, חריש',
    phone: process.env.BUSINESS_PHONE || '+97246070067',
    instagram: process.env.BUSINESS_INSTAGRAM || 'https://instagram.com/cafeleprechaun',
    lat: num(process.env.BUSINESS_LAT, 32.4647),
    lng: num(process.env.BUSINESS_LNG, 35.0447),
  },

  loyalty: {
    /** Punches needed before the reward. 8 => the 9th coffee is free. */
    goal: num(process.env.LOYALTY_GOAL, 8),
    /** Seconds during which a repeat punch on the same card needs confirmation. */
    cooldownSeconds: num(process.env.PUNCH_COOLDOWN_SECONDS, 90),
    /** Max punches a single staff member may add in one scan action. */
    maxPunchesPerScan: num(process.env.MAX_PUNCHES_PER_SCAN, 3),
  },

  brand: {
    green: '#1a6b3c',
    greenDark: '#145530',
    gold: '#c8a24e',
    cream: '#faf3e0',
  },

  apple: {
    enabled: bool(process.env.APPLE_WALLET_ENABLED, true),
    passTypeId: process.env.APPLE_PASS_TYPE_ID || '',
    teamId: process.env.APPLE_TEAM_ID || '',

    // שתי דרכים לספק את התעודה — p12 (כמו שאפל מייצאת מ-Keychain),
    // או זוג קבצי PEM. ה-PEM עדיף כשמייצרים ב-OpenSSL 3, שמצפין p12
    // בשיטה ש-node-forge לא יודע לפתוח.
    p12: readSecret('APPLE_P12_PATH', 'APPLE_P12_BASE64'),
    p12Password: process.env.APPLE_P12_PASSWORD || '',
    certPem: readSecret('APPLE_CERT_PEM_PATH', 'APPLE_CERT_PEM_BASE64'),
    keyPem: readSecret('APPLE_KEY_PEM_PATH', 'APPLE_KEY_PEM_BASE64'),
    keyPassphrase: process.env.APPLE_KEY_PASSPHRASE || '',

    wwdr: readSecret('APPLE_WWDR_PATH', 'APPLE_WWDR_BASE64'),
    apnsHost: process.env.APNS_HOST || 'https://api.push.apple.com',
  },

  google: {
    enabled: bool(process.env.GOOGLE_WALLET_ENABLED, true),
    issuerId: process.env.GOOGLE_ISSUER_ID || '',
    classSuffix: process.env.GOOGLE_CLASS_SUFFIX || 'leprechaun_coffee_card',
    serviceAccountEmail: process.env.GOOGLE_SA_EMAIL || '',
    serviceAccountKey: (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    serviceAccountFile: process.env.GOOGLE_SA_FILE || '',
    // כל קובץ ה-JSON כ-base64 — הדרך הבטוחה להדביק מפתח רב-שורתי
    // לממשק של Railway בלי שהשורות יישברו.
    serviceAccountJsonB64: process.env.GOOGLE_SA_JSON_BASE64 || '',
  },

  session: {
    /** Staff session lifetime in hours. */
    hours: num(process.env.SESSION_HOURS, 24 * 14),
    cookieName: 'lpr_staff',
  },
};

/** Pulls client_email + private_key out of a service-account JSON blob. */
function applyServiceAccount(json, source) {
  try {
    const sa = JSON.parse(json);
    config.google.serviceAccountEmail ||= sa.client_email || '';
    config.google.serviceAccountKey ||= sa.private_key || '';
  } catch (err) {
    console.warn(`[config] לא הצלחתי לקרוא את חשבון השירות של גוגל (${source}): ${err.message}`);
  }
}

// base64 קודם — כך שבייצור אפשר להגדיר הכול במשתני סביבה בלי קבצים.
if (config.google.serviceAccountJsonB64) {
  applyServiceAccount(Buffer.from(config.google.serviceAccountJsonB64, 'base64').toString('utf8'), 'base64');
}

if (config.google.serviceAccountFile) {
  const abs = path.isAbsolute(config.google.serviceAccountFile)
    ? config.google.serviceAccountFile
    : path.join(ROOT, config.google.serviceAccountFile);
  if (fs.existsSync(abs)) applyServiceAccount(fs.readFileSync(abs, 'utf8'), abs);
}

const appleKeyMaterial = Boolean(config.apple.p12 || (config.apple.certPem && config.apple.keyPem));

export const appleReady = Boolean(
  config.apple.enabled && config.apple.passTypeId && config.apple.teamId && appleKeyMaterial && config.apple.wwdr
);

export const googleReady = Boolean(
  config.google.enabled && config.google.issuerId && config.google.serviceAccountEmail && config.google.serviceAccountKey
);

export const googleClassId = googleReady ? `${config.google.issuerId}.${config.google.classSuffix}` : '';

/** Fails fast on misconfiguration that would silently break security. */
export function assertConfig() {
  const problems = [];
  if (!config.secret || config.secret.length < 24) {
    problems.push('APP_SECRET חסר או קצר מדי (נדרשים לפחות 24 תווים). הרץ: node scripts/gen-secret.mjs');
  }
  if (config.env === 'production' && !config.baseUrl.startsWith('https://')) {
    problems.push('BASE_URL חייב להיות https בסביבת production — Apple Wallet לא יעבוד בלי זה.');
  }
  if (problems.length) {
    console.error('\n❌ בעיות בהגדרות:\n' + problems.map((p) => '   • ' + p).join('\n') + '\n');
    process.exit(1);
  }
}
