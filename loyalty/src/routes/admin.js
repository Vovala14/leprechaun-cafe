import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config, appleReady, googleReady, googleClassId, ROOT } from '../config.js';
import { db, customers, staff, stats, sqliteDriver } from '../db.js';
import { cardState, adjust, LoyaltyError, GOAL } from '../services/loyalty.js';
import { syncWallets } from '../services/sync.js';
import { verifyAppleSetup } from '../services/applePass.js';
import { hashPassword } from '../util/crypto.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizePhone } from './public.js';

export const adminRouter = express.Router();
const PUBLIC_DIR = path.join(ROOT, 'public');

adminRouter.use(requireAdmin);

adminRouter.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

adminRouter.get('/api/stats', (_req, res) => {
  res.json({
    overview: stats.overview(),
    daily: stats.daily(30),
    top: stats.top(10),
    recent: stats.recentEvents(30),
    goal: GOAL,
  });
});

adminRouter.get('/api/customers', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const term = String(req.query.q || '');

  const rows = customers.search({ term, limit, offset }).map((c) => ({
    ...cardState(c),
    email: c.email || '',
    notes: c.notes || '',
  }));
  res.json({ customers: rows, total: customers.count(), limit, offset });
});

function findOr404(req, res) {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) {
    res.status(404).json({ error: 'לקוח לא נמצא', code: 'not_found' });
    return null;
  }
  return customer;
}

adminRouter.get('/api/customers/:publicId', (req, res) => {
  const customer = findOr404(req, res);
  if (!customer) return;
  res.json({
    ...cardState(customer),
    email: customer.email || '',
    notes: customer.notes || '',
    history: customers.events(customer.id, 60),
  });
});

adminRouter.post('/api/customers/:publicId/adjust', (req, res, next) => {
  const customer = findOr404(req, res);
  if (!customer) return;
  try {
    const result = adjust(customer, {
      delta: req.body?.delta,
      staff: req.staff,
      note: req.body?.note ? String(req.body.note).slice(0, 200) : 'תיקון ידני',
    });
    syncWallets(result.customer);
    res.json({ ok: true, applied: result.applied, state: result.state });
  } catch (err) {
    if (err instanceof LoyaltyError) return res.status(400).json({ error: err.message, code: err.code });
    next(err);
  }
});

adminRouter.post('/api/customers/:publicId/block', (req, res) => {
  const customer = findOr404(req, res);
  if (!customer) return;
  const blocked = Boolean(req.body?.blocked);

  customers.setBlocked(customer.id, blocked);
  customers.addEvent({
    customerId: customer.id,
    type: blocked ? 'block' : 'unblock',
    punchesAfter: customer.punches,
    staffId: req.staff.id,
    staffName: req.staff.display_name,
    note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
  });

  syncWallets(customers.byId(customer.id));
  res.json({ ok: true, blocked });
});

adminRouter.post('/api/customers/:publicId/profile', (req, res) => {
  const customer = findOr404(req, res);
  if (!customer) return;

  const name = String(req.body?.name ?? customer.name ?? '').trim().slice(0, 60);
  const phone = req.body?.phone === undefined ? customer.phone : normalizePhone(req.body.phone);
  const email = String(req.body?.email ?? customer.email ?? '').trim().toLowerCase().slice(0, 120);

  if (req.body?.phone !== undefined && !phone) {
    return res.status(400).json({ error: 'מספר טלפון לא תקין', code: 'bad_phone' });
  }
  const clash = phone && customers.byPhone(phone);
  if (clash && clash.id !== customer.id) {
    return res.status(409).json({ error: 'המספר כבר משויך ללקוח אחר', code: 'phone_taken' });
  }

  customers.setProfile(customer.id, { name, phone, email });
  if (req.body?.notes !== undefined) customers.setNotes(customer.id, String(req.body.notes).slice(0, 500));

  syncWallets(customers.byId(customer.id));
  res.json({ ok: true, ...cardState(customers.byId(customer.id)) });
});

adminRouter.post('/api/customers/:publicId/resync', async (req, res) => {
  const customer = findOr404(req, res);
  if (!customer) return;
  const results = await syncWallets(customer, { await: true });
  res.json({ ok: true, results: results?.map((r) => ({ status: r.status, value: r.value ?? null })) ?? [] });
});

adminRouter.get('/api/export.csv', (_req, res) => {
  const header = [
    'מספר כרטיסייה', 'שם', 'טלפון', 'אימייל', 'ניקובים נוכחיים',
    'סה״כ קפה', 'סה״כ סריקות', 'קפה חינם שמומש', 'חסום', 'הצטרף', 'סריקה אחרונה',
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = [header.map(esc).join(',')];
  for (const c of customers.all()) {
    lines.push(
      [
        c.public_id, c.name, c.phone, c.email,
        Math.min(GOAL, c.punches), c.total_punches, c.total_scans, c.total_rewards,
        c.blocked ? 'כן' : 'לא',
        (c.created_at || '').slice(0, 19).replace('T', ' '),
        (c.last_scan_at || '').slice(0, 19).replace('T', ' '),
      ]
        .map(esc)
        .join(',')
    );
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="leprechaun-club-${new Date().toISOString().slice(0, 10)}.csv"`);
  // UTF-8 BOM so Excel renders Hebrew correctly.
  res.send('﻿' + lines.join('\r\n'));
});

/**
 * Downloads a consistent snapshot of the database.
 *
 * VACUUM INTO produces a clean copy even while the server is serving requests,
 * which makes this the simplest reliable backup for a cloud deployment: the
 * owner clicks a button and gets a file they can actually keep.
 */
adminRouter.get('/api/backup.db', (_req, res, next) => {
  const target = path.join(os.tmpdir(), `leprechaun-backup-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/vnd.sqlite3');
    res.set('Content-Disposition', `attachment; filename="leprechaun-${stamp}.db"`);
    res.set('Content-Length', String(fs.statSync(target).size));

    const stream = fs.createReadStream(target);
    stream.pipe(res);
    stream.on('close', () => fs.rm(target, { force: true }, () => {}));
    stream.on('error', (err) => {
      fs.rm(target, { force: true }, () => {});
      next(err);
    });
  } catch (err) {
    fs.rm(target, { force: true }, () => {});
    next(err);
  }
});

adminRouter.get('/api/staff', (_req, res) => res.json({ staff: staff.all() }));

adminRouter.post('/api/staff', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim() || username;
  const role = req.body?.role === 'admin' ? 'admin' : 'staff';

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'שם משתמש: 3-32 תווים באנגלית/ספרות', code: 'bad_username' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'הסיסמה חייבת להיות לפחות 8 תווים', code: 'weak_password' });
  }
  if (staff.byUsername(username)) {
    return res.status(409).json({ error: 'שם המשתמש כבר קיים', code: 'username_taken' });
  }

  const row = staff.create({ username, displayName, passwordHash: hashPassword(password), role });
  res.status(201).json({ ok: true, staff: { id: row.id, username, displayName, role } });
});

adminRouter.post('/api/staff/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body?.password || '');
  if (password.length < 8) {
    return res.status(400).json({ error: 'הסיסמה חייבת להיות לפחות 8 תווים', code: 'weak_password' });
  }
  if (!staff.byId(id)) return res.status(404).json({ error: 'לא נמצא', code: 'not_found' });

  staff.setPassword(id, hashPassword(password));
  res.json({ ok: true });
});

adminRouter.post('/api/staff/:id/active', (req, res) => {
  const id = Number(req.params.id);
  const active = Boolean(req.body?.active);
  const row = staff.byId(id);
  if (!row) return res.status(404).json({ error: 'לא נמצא', code: 'not_found' });
  if (id === req.staff.id && !active) {
    return res.status(400).json({ error: 'אי אפשר להשבית את המשתמש שלך', code: 'self_disable' });
  }
  if (row.role === 'admin' && !active && staff.all().filter((s) => s.role === 'admin' && s.active).length <= 1) {
    return res.status(400).json({ error: 'חייב להישאר לפחות מנהל אחד פעיל', code: 'last_admin' });
  }

  staff.setActive(id, active);
  res.json({ ok: true, active });
});

/** Configuration health — shows exactly what still needs setting up. */
adminRouter.get('/api/health', (_req, res) => {
  const health = {
    baseUrl: config.baseUrl,
    https: config.baseUrl.startsWith('https://'),
    driver: sqliteDriver,
    goal: GOAL,
    apple: { configured: appleReady, passTypeId: config.apple.passTypeId || null, certificate: null, warnings: [] },
    google: { configured: googleReady, issuerId: config.google.issuerId || null, classId: googleClassId || null },
  };

  if (appleReady) {
    try {
      const info = verifyAppleSetup();
      health.apple.certificate = {
        passTypeId: info.passTypeId,
        teamId: info.teamId,
        expiresAt: info.notAfter.toISOString(),
        daysLeft: info.daysLeft,
      };
      health.apple.warnings = info.warnings;
    } catch (err) {
      health.apple.warnings = [err.message];
    }
  }
  if (!health.https) {
    health.apple.warnings.push('BASE_URL אינו https — הכרטיסייה באייפון לא תתעדכן אוטומטית.');
  }

  res.json(health);
});
