#!/usr/bin/env node
/**
 * בדיקת תקינות של ייצור הכרטיסייה ל-Apple Wallet.
 *
 *   npm run verify
 *
 * אם הוגדרו תעודות אמיתיות — בודק אותן.
 * אם לא — מייצר תעודות בדיקה זמניות כדי לוודא שהקוד עצמו תקין,
 * וכותב דוגמת pkpass לתיקייה tmp/ כדי שאפשר יהיה לפתוח אותה באייפון/מק.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import JSZip from 'jszip';

// src/config.js קורא את התעודות ברגע הייבוא, ולכן הוא נטען רק אחרי
// שהוחלט באילו תעודות להשתמש. עד אז מסתדרים בלעדיו.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (label, condition, extra = '') => {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${extra ? '  — ' + extra : ''}`);
  if (!condition) failures++;
};
const section = (title) => console.log(`\n${title}\n${'─'.repeat(58)}`);

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID || 'pass.co.il.leprechaun.loyalty';
const TEAM_ID = process.env.APPLE_TEAM_ID || 'ABCDE12345';

/* ── תעודות ─────────────────────────────────────────────────── */
let usingTestCerts = false;
const tmpDir = path.join(ROOT, 'tmp');

function makeCert({ subject, issuerAttrs, issuerKey, isCa }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 200 * 86400e3);
  cert.setSubject(subject);
  cert.setIssuer(issuerAttrs || subject);
  if (isCa) cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(issuerKey || keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function installTestCerts() {
  fs.mkdirSync(tmpDir, { recursive: true });
  const password = 'verify';

  const caAttrs = [
    { name: 'commonName', value: 'Test Apple Worldwide Developer Relations CA' },
    { name: 'organizationName', value: 'Apple Inc. (TEST ONLY)' },
  ];
  const ca = makeCert({ subject: caAttrs, isCa: true });
  const signer = makeCert({
    subject: [
      { name: 'commonName', value: `Pass Type ID: ${PASS_TYPE_ID}` },
      { name: 'organizationName', value: 'Leprechaun Cafe' },
      { shortName: 'OU', value: TEAM_ID },
      { type: '0.9.2342.19200300.100.1.1', value: PASS_TYPE_ID },
    ],
    issuerAttrs: caAttrs,
    issuerKey: ca.key,
  });

  const p12Path = path.join(tmpDir, 'verify-pass.p12');
  const wwdrPath = path.join(tmpDir, 'verify-wwdr.pem');
  const p12 = forge.pkcs12.toPkcs12Asn1(signer.key, [signer.cert], password, { generateLocalKeyId: true });
  fs.writeFileSync(p12Path, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  fs.writeFileSync(wwdrPath, forge.pki.certificateToPem(ca.cert));

  process.env.APPLE_PASS_TYPE_ID = PASS_TYPE_ID;
  process.env.APPLE_TEAM_ID = TEAM_ID;
  process.env.APPLE_P12_PATH = p12Path;
  process.env.APPLE_P12_PASSWORD = password;
  process.env.APPLE_WWDR_PATH = wwdrPath;
  if (!(process.env.BASE_URL || '').startsWith('https://')) process.env.BASE_URL = 'https://verify.example.com';
  usingTestCerts = true;
}

/** האם יש תעודות אמיתיות זמינות — נבדק ישירות מול הסביבה, לפני טעינת config. */
function realCertsPresent() {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  const has = (pathVar, b64Var) =>
    Boolean(process.env[b64Var]?.trim()) ||
    Boolean(process.env[pathVar]?.trim() && fs.existsSync(resolve(process.env[pathVar])));

  const keyMaterial =
    has('APPLE_P12_PATH', 'APPLE_P12_BASE64') ||
    (has('APPLE_CERT_PEM_PATH', 'APPLE_CERT_PEM_BASE64') && has('APPLE_KEY_PEM_PATH', 'APPLE_KEY_PEM_BASE64'));

  return Boolean(
    process.env.APPLE_PASS_TYPE_ID?.trim() &&
      process.env.APPLE_TEAM_ID?.trim() &&
      keyMaterial &&
      has('APPLE_WWDR_PATH', 'APPLE_WWDR_BASE64')
  );
}

if (!realCertsPresent()) {
  console.log('\nℹ️  לא נמצאו תעודות Apple מוגדרות — מריץ בדיקה עם תעודות זמניות.');
  console.log('   (הקוד ייבדק במלואו; רק אפל לא תכיר בחתימה.)');
  installTestCerts();
}

const { config, appleReady } = await import('../src/config.js');
const { generatePkpass, buildPassJson, verifyAppleSetup } = await import('../src/services/applePass.js');

if (!appleReady) {
  console.error('\n❌ לא הצלחתי לטעון תעודות כלל. בדקו את ההגדרות ב-.env.\n');
  process.exit(1);
}

/* ── 1. התעודה ──────────────────────────────────────────────── */
section(usingTestCerts ? '1. תעודות (בדיקה זמנית)' : '1. התעודות שלכם');
const setup = verifyAppleSetup();
ok(
  config.apple.certPem && config.apple.keyPem
    ? 'קבצי ה-PEM נקראו (תעודה + מפתח)'
    : 'קובץ ה-p12 נפתח (הסיסמה נכונה)',
  true
);
ok('Pass Type ID', Boolean(setup.passTypeId), setup.passTypeId);
ok('Team ID', Boolean(setup.teamId), setup.teamId);
ok('התעודה בתוקף', setup.daysLeft > 0, `עוד ${setup.daysLeft} ימים (עד ${setup.notAfter.toISOString().slice(0, 10)})`);
setup.warnings.forEach((w) => ok(w, false));
if (!setup.warnings.length) ok('אין אזהרות', true);

/* ── 2. תוכן pass.json ──────────────────────────────────────── */
section('2. תוכן הכרטיסייה');
const customer = {
  id: 1,
  public_id: 'DEMOCARD0001',
  name: 'דנה כהן',
  phone: '0541112233',
  punches: 5,
  total_punches: 13,
  total_scans: 14,
  total_rewards: 1,
  auth_token: 'demo-auth-token',
  blocked: 0,
  created_at: '2026-01-15T10:00:00.000Z',
  updated_at: new Date().toISOString(),
  last_scan_at: new Date().toISOString(),
};

const pj = buildPassJson(customer);
ok('formatVersion = 1', pj.formatVersion === 1);
ok('passTypeIdentifier תואם להגדרות', pj.passTypeIdentifier === config.apple.passTypeId, pj.passTypeIdentifier);
ok('teamIdentifier מוגדר', Boolean(pj.teamIdentifier), pj.teamIdentifier);
ok('serialNumber = מספר הכרטיסייה', pj.serialNumber === customer.public_id);
ok('סוג הכרטיסייה: storeCard', Boolean(pj.storeCard));
ok('ברקוד QR', pj.barcodes?.[0]?.format === 'PKBarcodeFormatQR');
ok('הברקוד חתום ב-HMAC', /^LPR1\.DEMOCARD0001\.[A-Za-z0-9_-]{22}$/.test(pj.barcodes[0].message), pj.barcodes[0].message);
ok('מונה ניקובים', pj.storeCard.headerFields[0].value === '5 / 8', pj.storeCard.headerFields[0].value);
ok('שורת ניקובים ויזואלית', pj.storeCard.primaryFields[0].value === '●●●●●○○○', pj.storeCard.primaryFields[0].value);
ok('הודעת עדכון למסך הנעילה', String(pj.storeCard.headerFields[0].changeMessage).includes('%@'));
ok('טקסט מצב בעברית', pj.storeCard.secondaryFields[0].value.includes('עוד 3'), pj.storeCard.secondaryFields[0].value);
ok('מיקום בית הקפה מוגדר', Number.isFinite(pj.locations?.[0]?.latitude), `${pj.locations[0].latitude}, ${pj.locations[0].longitude}`);
ok('תקנון בגב הכרטיס', pj.storeCard.backFields.some((f) => f.key === 'terms'));

const httpsBase = config.baseUrl.startsWith('https://');
ok(
  httpsBase ? 'webServiceURL להתעדכנות אוטומטית' : 'webServiceURL הושמט (BASE_URL אינו https)',
  httpsBase ? pj.webServiceURL === `${config.baseUrl}/wallet` : pj.webServiceURL === undefined,
  httpsBase ? pj.webServiceURL : 'הכרטיסייה תיפתח אבל לא תתעדכן לבד'
);

/* ── 3. החבילה ──────────────────────────────────────────────── */
section('3. קובץ ה-.pkpass');
const buffer = await generatePkpass(customer);
ok('נבנה בהצלחה', Buffer.isBuffer(buffer) && buffer.length > 2000, `${(buffer.length / 1024).toFixed(1)} KB`);

const zip = await JSZip.loadAsync(buffer);
const names = Object.keys(zip.files).sort();
ok('pass.json קיים', names.includes('pass.json'));
ok('manifest.json קיים', names.includes('manifest.json'));
ok('signature קיים', names.includes('signature'));
ok('icon.png + icon@2x.png קיימים', names.includes('icon.png') && names.includes('icon@2x.png'));
ok('logo.png קיים', names.includes('logo.png'));
console.log(`     קבצים: ${names.join(', ')}`);

/* ── 4. manifest ────────────────────────────────────────────── */
section('4. אימות ה-manifest');
const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
let hashesOk = true;
for (const [name, expected] of Object.entries(manifest)) {
  const bytes = await zip.file(name).async('nodebuffer');
  if (crypto.createHash('sha1').update(bytes).digest('hex') !== expected) {
    hashesOk = false;
    console.log(`     ❌ ${name}`);
  }
}
ok('כל ערכי ה-SHA1 נכונים', hashesOk, `${Object.keys(manifest).length} קבצים`);
ok('manifest ו-signature אינם מופיעים בתוכו', !('manifest.json' in manifest) && !('signature' in manifest));

/* ── 5. חתימה ───────────────────────────────────────────────── */
section('5. אימות החתימה הדיגיטלית');
const sigBytes = await zip.file('signature').async('nodebuffer');
const manifestBytes = await zip.file('manifest.json').async('nodebuffer');
const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(sigBytes.toString('binary'))));

ok('חתימת PKCS#7 תקינה', Boolean(p7.rawCapture));
ok('חתימה מנותקת (detached) — כדרישת אפל', !p7.rawCapture.content);
ok('כוללת 2 תעודות (חותם + ביניים)', p7.certificates.length === 2, String(p7.certificates.length));

const signerCert = p7.certificates.find((c) => c.subject.getField('CN')?.value?.includes('Pass Type ID'));
ok('תעודת החותם כלולה', Boolean(signerCert), signerCert?.subject.getField('CN')?.value);
ok(
  'תעודת הביניים של אפל כלולה',
  p7.certificates.some((c) => c.subject.getField('CN')?.value?.includes('Worldwide Developer'))
);

const md = forge.md.sha256.create();
md.update(manifestBytes.toString('binary'));
const expectedDigest = md.digest().getBytes();

const attrs = p7.rawCapture.authenticatedAttributes;
let digestMatches = false;
for (const attr of attrs) {
  if (forge.asn1.derToOid(attr.value[0].value) === forge.pki.oids.messageDigest) {
    digestMatches = attr.value[1].value[0].value === expectedDigest;
  }
}
ok('ה-digest שבחתימה תואם את ה-manifest', digestMatches);

const attrSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
const verifyMd = forge.md.sha256.create();
verifyMd.update(forge.asn1.toDer(attrSet).getBytes());
ok('החתימה מאומתת מול המפתח הציבורי', signerCert.publicKey.verify(verifyMd.digest().bytes(), p7.rawCapture.signature));

/* ── 6. פלט ─────────────────────────────────────────────────── */
section('6. קובץ לדוגמה');
fs.mkdirSync(tmpDir, { recursive: true });
const sample = path.join(tmpDir, 'sample.pkpass');
fs.writeFileSync(sample, buffer);
ok('נשמר', true, sample);

if (usingTestCerts) {
  for (const f of ['verify-pass.p12', 'verify-wwdr.pem']) {
    const p = path.join(tmpDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/* ── סיכום ──────────────────────────────────────────────────── */
console.log(`\n${'═'.repeat(58)}`);
if (failures) {
  console.log(`❌ ${failures} בדיקות נכשלו.\n`);
  process.exit(1);
}
console.log('✅ כל הבדיקות עברו.');
if (usingTestCerts) {
  console.log('\n⚠️  הבדיקה רצה עם תעודות זמניות — הקוד תקין, אבל אייפון');
  console.log('   ידחה את הקובץ הזה. הוסיפו תעודות אמיתיות ב-.env והריצו שוב.');
} else {
  console.log(`\n📲 העבירו את ${path.relative(ROOT, sample)} לאייפון (AirDrop/מייל) כדי לראות את הכרטיסייה.`);
}
console.log('');
