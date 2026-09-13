import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import JSZip from 'jszip';
import { config, appleReady, ROOT } from '../config.js';
import { cardState, GOAL } from './loyalty.js';

const ASSET_DIR = path.join(ROOT, 'assets', 'pass');

/** Images Apple looks for inside a .pkpass, in the order we prefer them. */
const PASS_IMAGES = [
  'icon.png', 'icon@2x.png', 'icon@3x.png',
  'logo.png', 'logo@2x.png', 'logo@3x.png',
  'strip.png', 'strip@2x.png', 'strip@3x.png',
  'thumbnail.png', 'thumbnail@2x.png',
  'background.png', 'background@2x.png',
];

let credentials = null;

function certificateFrom(buffer) {
  const text = buffer.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    return forge.pki.certificateFromPem(text);
  }
  // Apple ships the WWDR intermediate as a DER-encoded .cer file.
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary')));
  return forge.pki.certificateFromAsn1(asn1);
}

/** Reads a PEM/DER certificate + private key pair. */
function fromPemPair() {
  const signerCert = certificateFrom(config.apple.certPem);
  const keyText = config.apple.keyPem.toString('utf8');

  const privateKey = config.apple.keyPassphrase
    ? forge.pki.decryptRsaPrivateKey(keyText, config.apple.keyPassphrase)
    : forge.pki.privateKeyFromPem(keyText);

  if (!privateKey) {
    throw new Error('לא הצלחתי לקרוא את המפתח הפרטי — בדקו את APPLE_KEY_PASSPHRASE');
  }
  return { privateKey, signerCert };
}

/** Unpacks a .p12 bundle as exported from Keychain Access. */
function fromP12() {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(config.apple.p12.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, config.apple.p12Password);
  } catch (err) {
    // OpenSSL 3 מצפין p12 ב-AES כברירת מחדל, ו-node-forge תומך רק ב-3DES.
    throw new Error(
      `לא הצלחתי לפתוח את קובץ ה-p12 (${err.message}). ` +
        'ודאו שהסיסמה נכונה; אם יצרתם אותו ב-OpenSSL 3, הוסיפו ' +
        '-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1, ' +
        'או השתמשו ב-APPLE_CERT_PEM_PATH + APPLE_KEY_PEM_PATH במקום.'
    );
  }

  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  if (!keyBag?.key) throw new Error('לא נמצא מפתח פרטי בקובץ ה-p12 (אולי הסיסמה שגויה)');

  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])
    .map((b) => b.cert)
    .filter(Boolean);
  if (!certs.length) throw new Error('לא נמצאה תעודה בקובץ ה-p12');

  const privateKey = keyBag.key;
  // p12 עשוי להכיל גם תעודות ביניים — בוחרים את זו ששייכת למפתח.
  const signerCert =
    certs.find((c) => c.publicKey?.n && privateKey.n && c.publicKey.n.equals(privateKey.n)) || certs[0];

  return { privateKey, signerCert };
}

/** Parses the Pass Type ID credentials once and keeps them in memory. */
export function getCredentials() {
  if (credentials) return credentials;
  if (!appleReady) throw new Error('Apple Wallet is not configured');

  const { privateKey, signerCert } = config.apple.certPem && config.apple.keyPem ? fromPemPair() : fromP12();

  credentials = {
    privateKey,
    signerCert,
    wwdrCert: certificateFrom(config.apple.wwdr),
    keyPem: forge.pki.privateKeyToPem(privateKey),
    certPem: forge.pki.certificateToPem(signerCert),
  };
  return credentials;
}

/** Detached PKCS#7 signature over manifest.json, as Apple requires. */
function signManifest(manifestBuffer) {
  const { privateKey, signerCert, wwdrCert } = getCredentials();
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuffer.toString('binary'));
  p7.addCertificate(signerCert);
  p7.addCertificate(wwdrCert);
  p7.addSigner({
    key: privateKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/** Renders the punch strip as filled/empty dots, RTL-safe. */
function punchStrip(punches, goal) {
  return '●'.repeat(punches) + '○'.repeat(Math.max(0, goal - punches));
}

export function buildPassJson(customer) {
  const s = cardState(customer);
  const { business } = config;

  const pass = {
    formatVersion: 1,
    passTypeIdentifier: config.apple.passTypeId,
    teamIdentifier: config.apple.teamId,
    serialNumber: s.publicId,
    organizationName: business.name,
    description: `כרטיסיית קפה — ${business.name}`,
    logoText: business.name,

    backgroundColor: 'rgb(26, 107, 60)',
    foregroundColor: 'rgb(250, 243, 224)',
    labelColor: 'rgb(200, 162, 78)',

    sharingProhibited: true,

    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: s.token,
        messageEncoding: 'iso-8859-1',
        altText: s.publicId,
      },
    ],

    locations: [
      {
        latitude: business.lat,
        longitude: business.lng,
        relevantText: s.rewardReady ? 'הקפה הבא עלינו ☘️' : `${s.text.counter} ניקובים — ${business.name}`,
      },
    ],
    maxDistance: 300,

    storeCard: {
      headerFields: [
        {
          key: 'count',
          label: 'ניקובים',
          value: s.text.counter,
          changeMessage: 'הכרטיסייה עודכנה: %@ ניקובים ☕',
        },
      ],
      primaryFields: [
        {
          key: 'progress',
          label: '',
          value: punchStrip(s.punches, GOAL),
          textAlignment: 'PKTextAlignmentCenter',
        },
      ],
      secondaryFields: [
        {
          key: 'status',
          label: 'סטטוס',
          value: s.text.headline,
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      auxiliaryFields: [
        {
          key: 'member',
          label: 'חבר/ת מועדון',
          value: s.name || 'אורח/ת',
          textAlignment: 'PKTextAlignmentRight',
        },
        {
          key: 'rewards',
          label: 'קפה חינם שקיבלת',
          value: String(s.totalRewards),
          textAlignment: 'PKTextAlignmentLeft',
        },
      ],
      backFields: [
        { key: 'rule', label: 'איך זה עובד', value: `${s.text.rule}.\nמציגים את הכרטיסייה בקופה — הברמן/ית סורק/ת, והניקוב נוסף אוטומטית.` },
        { key: 'totalPunches', label: 'סה״כ קפה שקנית', value: String(s.totalPunches) },
        { key: 'totalScans', label: 'סה״כ סריקות', value: String(s.totalScans) },
        { key: 'cardId', label: 'מספר כרטיסייה', value: s.publicId },
        { key: 'address', label: 'כתובת', value: business.address },
        { key: 'phone', label: 'טלפון', value: business.phone },
        { key: 'web', label: 'הכרטיסייה באינטרנט', value: s.cardUrl },
        {
          key: 'terms',
          label: 'תקנון',
          value:
            `• הכרטיסייה אישית ואינה ניתנת להעברה.\n` +
            `• ניקוב אחד לכל משקה קפה שנרכש.\n` +
            `• לאחר ${GOAL} ניקובים מקבלים קפה אחד חינם (בגודל ובסוג שנרכשו בדרך כלל).\n` +
            `• אין כפל מבצעים.\n` +
            `• ${business.name} רשאי לשנות את תנאי המועדון בהודעה מראש.`,
        },
      ],
    },
  };

  // Apple only accepts an HTTPS web service; skip it in local development so the
  // pass still installs (it just will not auto-update).
  if (config.baseUrl.startsWith('https://')) {
    pass.webServiceURL = `${config.baseUrl}/wallet`;
    pass.authenticationToken = customer.auth_token;
  }

  return pass;
}

function loadImages() {
  const files = new Map();
  for (const name of PASS_IMAGES) {
    const p = path.join(ASSET_DIR, name);
    if (fs.existsSync(p)) files.set(name, fs.readFileSync(p));
  }
  if (!files.has('icon.png')) {
    throw new Error('חסר assets/pass/icon.png — הרץ `npm run assets` כדי לייצר תמונות בסיס');
  }
  return files;
}

/** Builds and signs a .pkpass for a customer. */
export async function generatePkpass(customer) {
  if (!appleReady) throw new Error('Apple Wallet is not configured');

  const files = loadImages();
  files.set('pass.json', Buffer.from(JSON.stringify(buildPassJson(customer), null, 2), 'utf8'));

  const manifest = {};
  for (const [name, buf] of files) {
    manifest[name] = crypto.createHash('sha1').update(buf).digest('hex');
  }
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');

  const zip = new JSZip();
  for (const [name, buf] of files) zip.file(name, buf);
  zip.file('manifest.json', manifestBuffer);
  zip.file('signature', signManifest(manifestBuffer));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** One-time sanity check at boot so certificate problems surface early. */
export function verifyAppleSetup() {
  const { signerCert } = getCredentials();
  const uid = signerCert.subject.getField('UID')?.value;
  const ou = signerCert.subject.getField('OU')?.value;
  const notAfter = signerCert.validity.notAfter;
  const daysLeft = Math.round((notAfter - Date.now()) / 86400e3);
  const warnings = [];

  if (uid && uid !== config.apple.passTypeId) {
    warnings.push(`APPLE_PASS_TYPE_ID (${config.apple.passTypeId}) לא תואם לתעודה (${uid})`);
  }
  if (ou && ou !== config.apple.teamId) {
    warnings.push(`APPLE_TEAM_ID (${config.apple.teamId}) לא תואם לתעודה (${ou})`);
  }
  if (daysLeft < 0) warnings.push(`התעודה פגה ב-${notAfter.toISOString().slice(0, 10)}`);
  else if (daysLeft < 30) warnings.push(`התעודה תפוג בעוד ${daysLeft} ימים (${notAfter.toISOString().slice(0, 10)})`);

  return { passTypeId: uid || config.apple.passTypeId, teamId: ou || config.apple.teamId, notAfter, daysLeft, warnings };
}
