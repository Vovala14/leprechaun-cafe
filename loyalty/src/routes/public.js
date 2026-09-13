import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { config, appleReady, googleReady, ROOT } from '../config.js';
import { customers } from '../db.js';
import { cardState, GOAL } from '../services/loyalty.js';
import { generatePkpass } from '../services/applePass.js';
import { ensureObject, saveLink } from '../services/googleWallet.js';
import { randomId, randomToken } from '../util/crypto.js';
import { rateLimit } from '../middleware/auth.js';

export const publicRouter = express.Router();
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Accepts 054-1234567, +972 54 123 4567, 0541234567 … and returns 0541234567. */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  let d = digits;
  if (d.startsWith('00972')) d = d.slice(5);
  if (d.startsWith('972')) d = d.slice(3);
  if (!d.startsWith('0')) d = '0' + d;
  return /^0\d{8,9}$/.test(d) ? d : null;
}

/** Strips control characters, collapses whitespace, caps the length. */
const clean = (v, max = 80) =>
  String(v ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function findCustomer(req, res) {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) {
    res.status(404).json({ error: 'הכרטיסייה לא נמצאה', code: 'not_found' });
    return null;
  }
  return customer;
}

/** Everything the card page and the join flow need to render. */
function cardPayload(customer) {
  return {
    ...cardState(customer),
    wallets: {
      apple: appleReady,
      google: googleReady,
      appleUrl: appleReady ? `/c/${customer.public_id}/pass.pkpass` : null,
      googleUrl: googleReady ? `/c/${customer.public_id}/google` : null,
    },
    business: {
      name: config.business.name,
      address: config.business.address,
      phone: config.business.phone,
      instagram: config.business.instagram,
    },
  };
}

publicRouter.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')));
publicRouter.get('/join', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')));

publicRouter.get('/api/config', (_req, res) => {
  res.json({
    goal: GOAL,
    business: config.business,
    wallets: { apple: appleReady, google: googleReady },
  });
});

/**
 * Joins the club. Re-entering a phone number that already exists returns the
 * same card instead of creating a duplicate — that doubles as card recovery
 * for someone who lost their link or wiped their phone.
 */
publicRouter.post('/api/join', rateLimit({ windowMs: 60_000, max: 25 }), (req, res) => {
  const name = clean(req.body?.name, 60);
  const phone = normalizePhone(req.body?.phone);
  const email = clean(req.body?.email, 120).toLowerCase();

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'נא להזין שם', code: 'bad_name' });
  }
  if (!phone) {
    return res.status(400).json({ error: 'מספר טלפון לא תקין', code: 'bad_phone' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'כתובת אימייל לא תקינה', code: 'bad_email' });
  }

  const existing = customers.byPhone(phone);
  if (existing) {
    if (!existing.name && name) customers.setProfile(existing.id, { name, phone, email: existing.email });
    return res.json({ ...cardPayload(customers.byId(existing.id)), existing: true });
  }

  const customer = customers.create({
    publicId: randomId(12),
    name,
    phone,
    email: email || null,
    authToken: randomToken(24),
  });
  customers.addEvent({ customerId: customer.id, type: 'join', delta: 0, punchesAfter: 0, note: 'הצטרפות למועדון' });

  res.status(201).json({ ...cardPayload(customer), existing: false });
});

/** Card recovery by phone number. */
publicRouter.post('/api/recover', rateLimit({ windowMs: 60_000, max: 15 }), (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'מספר טלפון לא תקין', code: 'bad_phone' });

  const customer = customers.byPhone(phone);
  if (!customer) {
    return res.status(404).json({ error: 'לא נמצאה כרטיסייה למספר הזה', code: 'not_found' });
  }
  res.json(cardPayload(customer));
});

publicRouter.get('/c/:publicId', (req, res) => {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  res.sendFile(path.join(PUBLIC_DIR, 'card.html'));
});

publicRouter.get('/api/card/:publicId', (req, res) => {
  const customer = findCustomer(req, res);
  if (!customer) return;
  res.json(cardPayload(customer));
});

publicRouter.get('/c/:publicId/qr.png', async (req, res, next) => {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) return res.status(404).end();
  try {
    const png = await QRCode.toBuffer(cardState(customer).token, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: Math.min(1200, Math.max(200, Number(req.query.size) || 640)),
      margin: 1,
      color: { dark: '#145530ff', light: '#ffffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(png);
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/c/:publicId/pass.pkpass', async (req, res, next) => {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) return res.status(404).send('הכרטיסייה לא נמצאה');
  if (!appleReady) {
    return res.status(503).send('Apple Wallet עדיין לא מוגדר במערכת. ראו README להוראות התקנת התעודות.');
  }
  try {
    const buffer = await generatePkpass(customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename="leprechaun-${customer.public_id}.pkpass"`);
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/c/:publicId/google', async (req, res, next) => {
  const customer = customers.byPublicId(req.params.publicId);
  if (!customer) return res.status(404).send('הכרטיסייה לא נמצאה');
  if (!googleReady) {
    return res.status(503).send('Google Wallet עדיין לא מוגדר במערכת. ראו README להוראות.');
  }
  try {
    // Best effort: a pre-created object keeps later updates instant. The save
    // link embeds the full object anyway, so a failure here is not fatal.
    await ensureObject(customer).catch((err) => console.warn('[google] ensureObject:', err.message));
    res.redirect(saveLink(customer));
  } catch (err) {
    next(err);
  }
});
