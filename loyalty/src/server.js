import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, appleReady, googleReady, googleClassId, ROOT, assertConfig } from './config.js';
import { staff, sqliteDriver } from './db.js';
import { loadStaff } from './middleware/auth.js';
import { publicRouter } from './routes/public.js';
import { walletRouter } from './routes/wallet.js';
import { staffRouter } from './routes/staff.js';
import { adminRouter } from './routes/admin.js';
import { verifyAppleSetup } from './services/applePass.js';
import { closePush } from './services/applePush.js';
import { hashPassword, randomToken } from './util/crypto.js';
import { GOAL } from './services/loyalty.js';

assertConfig();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(loadStaff);

app.use('/assets', express.static(path.join(ROOT, 'assets'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: config.env === 'production' ? '1h' : 0 }));

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/wallet', walletRouter);
app.use('/staff', staffRouter);
app.use('/admin', adminRouter);
app.use('/', publicRouter);

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.includes('/api/')) {
    return res.status(404).json({ error: 'לא נמצא', code: 'not_found' });
  }
  res.status(404).sendFile(path.join(ROOT, 'public', '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.originalUrl, '-', err.stack || err.message);
  if (res.headersSent) return;
  const isApi = req.path.includes('/api/') || req.get('accept')?.includes('application/json');
  if (isApi) return res.status(500).json({ error: 'שגיאת שרת. נסו שוב.', code: 'server_error' });
  res.status(500).send('שגיאת שרת');
});

/** Creates a first admin on an empty install and prints the credentials once. */
function bootstrapAdmin() {
  if (staff.count() > 0) return null;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || randomToken(9).replace(/[-_]/g, 'x').slice(0, 12);
  staff.create({
    username,
    displayName: process.env.ADMIN_NAME || 'מנהל',
    passwordHash: hashPassword(password),
    role: 'admin',
  });
  return { username, password, generated: !process.env.ADMIN_PASSWORD };
}

const created = bootstrapAdmin();

const server = app.listen(config.port, () => {
  const line = (label, value) => console.log(`   ${label.padEnd(22)} ${value}`);

  console.log('\n☘️  מועדון הלקוחות של ' + config.business.name);
  console.log('─'.repeat(64));
  line('כתובת', config.baseUrl);
  line('פורט', config.port);
  line('סביבה', config.env);
  line('מסד נתונים', `${sqliteDriver} · ${config.dbPath}`);
  line('חוק המועדון', `${GOAL} קפה — ה־${GOAL + 1} חינם`);
  console.log('─'.repeat(64));
  line('הצטרפות ללקוחות', `${config.baseUrl}/join`);
  line('סורק לצוות', `${config.baseUrl}/staff/scan`);
  line('ניהול', `${config.baseUrl}/admin`);
  console.log('─'.repeat(64));

  if (appleReady) {
    try {
      const info = verifyAppleSetup();
      line('Apple Wallet', `פעיל · ${info.passTypeId} · תוקף עוד ${info.daysLeft} ימים`);
      info.warnings.forEach((w) => console.log(`   ⚠️  ${w}`));
    } catch (err) {
      line('Apple Wallet', `❌ שגיאת תעודה: ${err.message}`);
    }
  } else {
    line('Apple Wallet', 'לא מוגדר (ראו README → Apple)');
  }

  line('Google Wallet', googleReady ? `פעיל · ${googleClassId}` : 'לא מוגדר (ראו README → Google)');

  if (!config.baseUrl.startsWith('https://')) {
    console.log('\n   ⚠️  ללא HTTPS הכרטיסיות לא יתעדכנו אוטומטית בטלפונים.');
  }

  if (created) {
    console.log('\n   ✅ נוצר משתמש מנהל ראשוני:');
    console.log(`      שם משתמש: ${created.username}`);
    console.log(`      סיסמה:    ${created.password}`);
    if (created.generated) console.log('      ⚠️  שמרו את הסיסמה — היא מוצגת פעם אחת בלבד.');
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[${signal}] מכבה...`);
  closePush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
