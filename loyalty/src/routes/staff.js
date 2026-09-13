import path from 'node:path';
import express from 'express';
import { config, ROOT } from '../config.js';
import { customers } from '../db.js';
import { cardState, punch, redeem, LoyaltyError, GOAL } from '../services/loyalty.js';
import { syncWallets } from '../services/sync.js';
import { parseScanInput } from '../util/crypto.js';
import { authenticate, createSession, destroySession, rateLimit, requireStaff } from '../middleware/auth.js';

export const staffRouter = express.Router();
const PUBLIC_DIR = path.join(ROOT, 'public');

staffRouter.get('/', (_req, res) => res.redirect('/staff/scan'));

staffRouter.get('/login', (req, res) => {
  if (req.staff) return res.redirect(req.query.next || '/staff/scan');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

staffRouter.post('/login', rateLimit({ windowMs: 5 * 60_000, max: 25 }), (req, res) => {
  const row = authenticate(req.body?.username, req.body?.password);
  if (!row) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים', code: 'bad_credentials' });

  createSession(res, row);
  res.json({
    ok: true,
    staff: { id: row.id, name: row.display_name, role: row.role },
    redirect: row.role === 'admin' ? '/admin' : '/staff/scan',
  });
});

staffRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

staffRouter.get('/scan', requireStaff, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'scan.html')));

staffRouter.get('/api/me', requireStaff, (req, res) => {
  res.json({
    staff: { id: req.staff.id, name: req.staff.display_name, role: req.staff.role },
    goal: GOAL,
    cooldownSeconds: config.loyalty.cooldownSeconds,
    maxPunchesPerScan: config.loyalty.maxPunchesPerScan,
    business: config.business,
  });
});

/** Resolves a scan/typed code to a customer, or sends the right error. */
function resolve(req, res) {
  const publicId = parseScanInput(req.body?.code);
  if (!publicId) {
    res.status(400).json({ error: 'קוד לא תקין — נסו לסרוק שוב', code: 'bad_code' });
    return null;
  }
  const customer = customers.byPublicId(publicId);
  if (!customer) {
    res.status(404).json({ error: 'הכרטיסייה לא נמצאה במערכת', code: 'not_found' });
    return null;
  }
  return customer;
}

/** Read-only preview of a card — what the barista sees right after scanning. */
staffRouter.post('/api/lookup', requireStaff, (req, res) => {
  const customer = resolve(req, res);
  if (!customer) return;
  res.json({
    state: cardState(customer),
    history: customers.events(customer.id, 8),
    suggested: customer.punches >= GOAL ? 'redeem' : 'punch',
  });
});

staffRouter.post('/api/punch', requireStaff, rateLimit({ windowMs: 60_000, max: 120 }), (req, res, next) => {
  const customer = resolve(req, res);
  if (!customer) return;

  try {
    const result = punch(customer, {
      count: req.body?.count,
      staff: req.staff,
      force: Boolean(req.body?.force),
    });

    if (result.status === 'cooldown') {
      return res.status(409).json({
        code: 'cooldown',
        error: `הכרטיסייה נוקבה לפני ${result.secondsAgo} שניות. לנקב שוב?`,
        secondsAgo: result.secondsAgo,
        state: result.state,
      });
    }

    syncWallets(result.customer);
    res.json({
      ok: true,
      added: result.added,
      state: result.state,
      message: result.state.rewardReady
        ? 'הכרטיסייה מלאה! הקפה הבא חינם 🍀'
        : `נוקב! נשארו ${result.state.remaining} עד הקפה החינם`,
    });
  } catch (err) {
    if (err instanceof LoyaltyError) {
      return res.status(409).json({ error: err.message, code: err.code, ...err.extra });
    }
    next(err);
  }
});

staffRouter.post('/api/redeem', requireStaff, rateLimit({ windowMs: 60_000, max: 60 }), (req, res, next) => {
  const customer = resolve(req, res);
  if (!customer) return;

  try {
    const result = redeem(customer, { staff: req.staff });
    syncWallets(result.customer);
    res.json({ ok: true, state: result.state, message: 'קפה חינם מומש ☕ הכרטיסייה התאפסה' });
  } catch (err) {
    if (err instanceof LoyaltyError) {
      return res.status(409).json({ error: err.message, code: err.code, ...err.extra });
    }
    next(err);
  }
});

/** Fallback when a phone is dead or the QR will not scan: find by name/phone. */
staffRouter.get('/api/search', requireStaff, (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ results: [] });

  const results = customers.search({ term, limit: 12 }).map((c) => ({
    publicId: c.public_id,
    name: c.name,
    phone: c.phone,
    punches: Math.min(GOAL, c.punches),
    goal: GOAL,
    rewardReady: c.punches >= GOAL,
  }));
  res.json({ results });
});
