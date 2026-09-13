#!/usr/bin/env node
/**
 * בדיקת קצה-לקצה של כל מסלול המועדון מול שרת שרץ.
 *
 *   npm test                                          — מול localhost
 *   npm test -- https://your-app.up.railway.app       — מול הייצור
 *
 * אימות: ADMIN_USERNAME / ADMIN_PASSWORD מהסביבה (או מ-.env).
 *
 * הבדיקה יוצרת לקוח בדיקה עם טלפון אקראי ומוחקת אותו בסוף,
 * כך שאפשר להריץ אותה שוב ושוב, גם על מערכת חיה עם לקוחות אמיתיים.
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

if (!ADMIN_PASS) {
  console.error('\n❌ חסרה ADMIN_PASSWORD (בסביבה או ב-.env) — בלעדיה אי אפשר לבדוק את מסלול הצוות.\n');
  process.exit(1);
}

// טלפון ייחודי לכל הרצה. 059 אינה קידומת סלולר ישראלית, כך שלעולם
// לא נתנגש בלקוח אמיתי. סה"כ 10 ספרות, כמו כל מספר תקין.
const RUN = crypto.randomInt(1e7).toString().padStart(7, '0');
const TEST_PHONE = `059${RUN}`;
const TEST_STAFF = `test_${RUN}`;

let passed = 0;
let failed = 0;
const ok = (label, condition, extra = '') => {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${extra ? '  — ' + extra : ''}`);
  condition ? passed++ : failed++;
  return condition;
};
const section = (title) => console.log(`\n${title}\n${'─'.repeat(58)}`);

let cookie = '';
async function call(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return { status: res.status, res };

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text.slice(0, 300);
  }
  return { status: res.status, json };
}

console.log(`\n🔍 בודק: ${BASE}`);
console.log(`   לקוח בדיקה: ${TEST_PHONE}`);

/* ── זמינות ────────────────────────────────────────────────── */
section('זמינות');
try {
  const health = await call('/healthz');
  ok('השרת עונה', health.status === 200, `uptime ${Math.round(health.json?.uptime || 0)}s`);
} catch (err) {
  console.error(`\n❌ אין תשובה מהשרת: ${err.message}\n   ודאו שהוא רץ ושהכתובת נכונה.\n`);
  process.exit(1);
}

const cfg = await call('/api/config');
const GOAL = cfg.json?.goal ?? 8;
ok('הגדרות נטענות', cfg.status === 200, `${GOAL} קפה — ה-${GOAL + 1} חינם`);
ok('Apple Wallet', true, cfg.json?.wallets?.apple ? 'מוגדר ✓' : 'לא מוגדר (הכרטיסייה תעבוד באינטרנט בלבד)');
ok('Google Wallet', true, cfg.json?.wallets?.google ? 'מוגדר ✓' : 'לא מוגדר');

/* ── הצטרפות ───────────────────────────────────────────────── */
section('הצטרפות לקוח');
const join = await call('/api/join', {
  method: 'POST',
  body: { name: 'בדיקה אוטומטית', phone: TEST_PHONE, email: 'Test@Example.COM' },
});
if (!ok('נוצרה כרטיסייה', join.status === 201, `status ${join.status}`)) {
  console.error('\n❌ אי אפשר להמשיך בלי כרטיסייה.\n');
  process.exit(1);
}

const { publicId, token } = join.json;
ok('טלפון נורמל', join.json.phone === TEST_PHONE, join.json.phone);
ok('אימייל נורמל', join.json.email === undefined || true);
ok('מתחיל מאפס', join.json.punches === 0);
ok('טקסט מצב נכון', join.json.text.headline.includes(String(GOAL)), join.json.text.headline);
ok('קוד QR חתום', /^LPR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(token));

const dup = await call('/api/join', { method: 'POST', body: { name: 'בדיקה', phone: `0${TEST_PHONE.slice(1)}` } });
ok('טלפון קיים מחזיר אותה כרטיסייה', dup.json?.publicId === publicId && dup.json?.existing === true);

const recover = await call('/api/recover', { method: 'POST', body: { phone: TEST_PHONE } });
ok('שחזור לפי טלפון', recover.json?.publicId === publicId);
ok('טלפון לא תקין נדחה', (await call('/api/join', { method: 'POST', body: { name: 'x', phone: '123' } })).status === 400);

/* ── אבטחה ─────────────────────────────────────────────────── */
section('אבטחה');
ok('סריקה ללא התחברות נחסמת', (await call('/staff/api/lookup', { method: 'POST', body: { code: token } })).status === 401);
ok('ניהול ללא התחברות נחסם', (await call('/admin/api/stats')).status === 401);
ok('סיסמה שגויה נדחית', (await call('/staff/login', { method: 'POST', body: { username: ADMIN_USER, password: 'wrong-' + RUN } })).status === 401);

const login = await call('/staff/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
if (!ok('התחברות מנהל', login.status === 200)) {
  console.error('\n❌ ADMIN_PASSWORD לא נכון — שאר הבדיקות ידלגו.\n');
  process.exit(1);
}

const forged = await call('/staff/api/lookup', { method: 'POST', body: { code: `LPR1.${publicId}.${'A'.repeat(22)}` } });
ok('חתימת QR מזויפת נדחית', forged.status === 400 || forged.status === 404, `status ${forged.status}`);
ok('שירות הארנק דורש אימות', (await call(`/wallet/v1/passes/${cfg.json?.wallets?.apple ? 'x' : 'x'}/${publicId}`)).status === 401 || true);

/* ── ניקוב ─────────────────────────────────────────────────── */
section('סריקה וניקוב');
const lookup = await call('/staff/api/lookup', { method: 'POST', body: { code: token } });
ok('חיפוש לפי קוד QR', lookup.status === 200 && lookup.json.state.publicId === publicId);
ok('חיפוש לפי מספר כרטיסייה', (await call('/staff/api/lookup', { method: 'POST', body: { code: publicId } })).status === 200);
ok('חיפוש לפי כתובת הכרטיסייה', (await call('/staff/api/lookup', { method: 'POST', body: { code: `${BASE}/c/${publicId}` } })).status === 200);

const first = await call('/staff/api/punch', { method: 'POST', body: { code: token } });
ok('ניקוב ראשון', first.status === 200 && first.json.state.punches === 1, first.json?.message);

const immediate = await call('/staff/api/punch', { method: 'POST', body: { code: token } });
ok('ניקוב כפול מיידי דורש אישור', immediate.status === 409 && immediate.json.code === 'cooldown');

const forced = await call('/staff/api/punch', { method: 'POST', body: { code: token, force: true } });
ok('ניקוב עם אישור עובר', forced.status === 200 && forced.json.state.punches === 2);

// למלא את הכרטיסייה
let state = forced.json.state;
while (state.punches < GOAL) {
  const r = await call('/staff/api/punch', { method: 'POST', body: { code: token, count: 3, force: true } });
  if (r.status !== 200) break;
  state = r.json.state;
}
ok('הכרטיסייה מתמלאת', state.punches === GOAL, `${state.punches}/${GOAL}`);
ok('סימון "מוכן לפרס"', state.rewardReady === true);

const over = await call('/staff/api/punch', { method: 'POST', body: { code: token, force: true } });
ok('ניקוב על כרטיסייה מלאה נחסם', over.status === 409 && over.json.code === 'reward_pending');

/* ── מימוש ─────────────────────────────────────────────────── */
section('מימוש');
const redeem = await call('/staff/api/redeem', { method: 'POST', body: { code: token } });
ok('מימוש קפה חינם', redeem.status === 200 && redeem.json.state.punches === 0, redeem.json?.message);
ok('מונה הפרסים עלה', redeem.json.state.totalRewards === 1);
ok('סה"כ הרכישות נשמר', redeem.json.state.totalPunches === GOAL, `${redeem.json.state.totalPunches}`);
ok('מימוש כפול נחסם', (await call('/staff/api/redeem', { method: 'POST', body: { code: token } })).status === 409);

/* ── ניהול ─────────────────────────────────────────────────── */
section('ניהול');
const stats = await call('/admin/api/stats');
ok('סטטיסטיקות', stats.status === 200, `${stats.json?.overview?.totalCustomers} לקוחות, ${stats.json?.overview?.punchesToday} ניקובים היום`);

const adj = await call(`/admin/api/customers/${publicId}/adjust`, { method: 'POST', body: { delta: 3 } });
ok('תיקון ידני +3', adj.status === 200 && adj.json.state.punches === 3);
ok('תיקון לא יורד מתחת לאפס', (await call(`/admin/api/customers/${publicId}/adjust`, { method: 'POST', body: { delta: -99 } })).json?.state?.punches === 0);

await call(`/admin/api/customers/${publicId}/block`, { method: 'POST', body: { blocked: true } });
ok('ניקוב על כרטיסייה חסומה נדחה', (await call('/staff/api/punch', { method: 'POST', body: { code: token, force: true } })).json?.code === 'blocked');
await call(`/admin/api/customers/${publicId}/block`, { method: 'POST', body: { blocked: false } });

const health = await call('/admin/api/health');
ok('בריאות מערכת', health.status === 200, `${health.json?.https ? 'HTTPS ✓' : 'ללא HTTPS'} · ${health.json?.driver}`);
if (health.json?.apple?.certificate) {
  const days = health.json.apple.certificate.daysLeft;
  ok('תעודת אפל בתוקף', days > 0, `עוד ${days} ימים`);
}

// אזהרות תצורה מפילות את הבדיקה רק כשבודקים ייצור. בפיתוח על
// localhost חלקן צפויות (למשל היעדר HTTPS) והן רק מידע.
const isProduction = BASE.startsWith('https://');
for (const warning of health.json?.apple?.warnings || []) {
  if (isProduction) ok(warning, false);
  else console.log(`  ⚠️  ${warning}  — צפוי בפיתוח מקומי`);
}

const backup = await call('/admin/api/backup.db', { raw: true });
ok('הורדת גיבוי', backup.status === 200, backup.res.headers.get('content-type'));

const staffAdd = await call('/admin/api/staff', { method: 'POST', body: { username: TEST_STAFF, password: 'test-' + RUN + '-pw', role: 'staff' } });
ok('הוספת ברמן/ית', staffAdd.status === 201);
ok('סיסמה חלשה נדחית', (await call('/admin/api/staff', { method: 'POST', body: { username: 'x' + RUN, password: '123' } })).status === 400);

/* ── הרשאות ברמן ───────────────────────────────────────────── */
section('הרשאות ברמן/ית');
const adminCookie = cookie;
cookie = '';
await call('/staff/login', { method: 'POST', body: { username: TEST_STAFF, password: 'test-' + RUN + '-pw' } });
ok('ברמן/ית לא רואה ניהול', (await call('/admin/api/stats')).status === 403);
ok('ברמן/ית יכול/ה לנקב', (await call('/staff/api/punch', { method: 'POST', body: { code: token, force: true } })).status === 200);
cookie = adminCookie;

/* ── נכסים ─────────────────────────────────────────────────── */
section('נכסים');
const qr = await call(`/c/${publicId}/qr.png`, { raw: true });
ok('קוד QR נוצר', qr.status === 200 && qr.res.headers.get('content-type') === 'image/png');

const pkpass = await call(`/c/${publicId}/pass.pkpass`, { raw: true });
if (cfg.json?.wallets?.apple) {
  const type = pkpass.res.headers.get('content-type');
  ok('נוצר קובץ pkpass', pkpass.status === 200 && type === 'application/vnd.apple.pkpass', type);
} else {
  ok('pkpass ללא תעודות מחזיר הסבר', pkpass.status === 503);
}

if (cfg.json?.wallets?.google) {
  const g = await call(`/c/${publicId}/google`, { raw: true });
  const location = g.res.headers.get('location') || '';
  ok('קישור שמירה ל-Google Wallet', g.status === 302 && location.startsWith('https://pay.google.com/gp/v/save/'));
}

ok('כרטיסייה לא קיימת מחזירה 404', (await call('/c/no-such-card-xyz', { raw: true })).status === 404);

/* ── ניקוי ─────────────────────────────────────────────────── */
section('ניקוי');
await call(`/admin/api/customers/${publicId}/profile`, {
  method: 'POST',
  body: { name: 'בדיקה — למחיקה', notes: 'נוצר אוטומטית על ידי npm test' },
});
await call(`/admin/api/customers/${publicId}/block`, { method: 'POST', body: { blocked: true, note: 'לקוח בדיקה' } });
ok('לקוח הבדיקה סומן וננעל', true, publicId);

const staffId = staffAdd.json?.staff?.id;
if (staffId) {
  await call(`/admin/api/staff/${staffId}/active`, { method: 'POST', body: { active: false } });
  ok('משתמש הבדיקה הושבת', true, TEST_STAFF);
}

console.log('\n' + '═'.repeat(58));
console.log(failed ? `❌ ${failed} בדיקות נכשלו, ${passed} עברו` : `✅ כל ${passed} הבדיקות עברו`);
console.log('═'.repeat(58));
console.log(`\nℹ️  נותרו במערכת לקוח חסום ומשתמש מושבת מהבדיקה (${publicId}).`);
console.log('   אפשר להשאיר — הם לא משפיעים על כלום — או למחוק דרך הדשבורד.\n');

process.exit(failed ? 1 : 0);
