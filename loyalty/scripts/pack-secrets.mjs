#!/usr/bin/env node
/**
 * הופך את הקבצים שבתיקיית certs/ למשתני סביבה מוכנים להדבקה ב-Railway.
 *
 *   npm run pack
 *   npm run pack -- --out railway-env.txt     (שמירה לקובץ במקום הדפסה)
 *
 * למה base64: תעודות ומפתחות הם קבצים בינאריים או רב-שורתיים, ושבירת שורה
 * אחת בהדבקה לממשק שוברת אותם בלי הודעת שגיאה ברורה. base64 הוא שורה אחת.
 *
 * ⚠️ הפלט מכיל מפתחות פרטיים. אל תשלחו אותו בצ'אט, במייל או ב-git.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERTS = path.join(ROOT, 'certs');

const outArg = process.argv.indexOf('--out');
const outFile = outArg > -1 ? process.argv[outArg + 1] : null;

const lines = [];
const notes = [];
const missing = [];

const read = (name) => {
  const p = path.join(CERTS, name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

const emit = (key, buffer) => lines.push(`${key}=${buffer.toString('base64')}`);

/* ── Apple ─────────────────────────────────────────────────── */
const p12 = read('pass.p12');
const certPem = read('pass.pem');
const keyPem = read('pass.key');
const wwdr = read('wwdr.pem') || read('wwdr.cer') || read('AppleWWDRCAG4.cer');

if (p12) {
  emit('APPLE_P12_BASE64', p12);
  notes.push('נמצא pass.p12 — אל תשכחו להגדיר גם APPLE_P12_PASSWORD');
} else if (certPem && keyPem) {
  emit('APPLE_CERT_PEM_BASE64', certPem);
  emit('APPLE_KEY_PEM_BASE64', keyPem);
  notes.push('נמצאו pass.pem + pass.key');
} else {
  missing.push('תעודת Apple — צריך certs/pass.p12, או certs/pass.pem יחד עם certs/pass.key');
}

if (wwdr) emit('APPLE_WWDR_BASE64', wwdr);
else missing.push('תעודת הביניים של Apple — certs/wwdr.pem');

/* ── Google ────────────────────────────────────────────────── */
const saName = fs
  .readdirSync(CERTS)
  .find((f) => f.endsWith('.json') && f.includes('service-account'));

if (saName) {
  const sa = read(saName);
  emit('GOOGLE_SA_JSON_BASE64', sa);
  try {
    const parsed = JSON.parse(sa.toString('utf8'));
    notes.push(`נמצא ${saName} — חשבון שירות: ${parsed.client_email}`);
  } catch {
    notes.push(`נמצא ${saName} (לא הצלחתי לפענח אותו כ-JSON — בדקו שהוא תקין)`);
  }
} else {
  missing.push('חשבון שירות של Google — certs/google-service-account.json');
}

/* ── פלט ───────────────────────────────────────────────────── */
if (!lines.length) {
  console.error('\n❌ לא נמצא אף קובץ בתיקיית certs/.\n   ראו DEPLOY.md לשלבי יצירת התעודות.\n');
  process.exit(1);
}

const body = lines.join('\n') + '\n';

if (outFile) {
  const target = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
  fs.writeFileSync(target, body, { mode: 0o600 });
  console.log(`\n✅ נשמר: ${target}`);
  console.log('   ⚠️  הקובץ מכיל מפתחות פרטיים — מחקו אותו אחרי ההדבקה ל-Railway.');
} else {
  console.log('\n' + '═'.repeat(60));
  console.log('  להדבקה ב-Railway: Variables → Raw Editor → הדביקו הכול');
  console.log('═'.repeat(60) + '\n');
  console.log(body);
}

if (notes.length) {
  console.log('ℹ️  ' + notes.join('\n   '));
}
if (missing.length) {
  console.log('\n⚠️  חסר:');
  missing.forEach((m) => console.log('   • ' + m));
}
console.log('');
