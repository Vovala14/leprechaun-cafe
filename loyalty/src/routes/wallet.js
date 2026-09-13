import express from 'express';
import { config, appleReady } from '../config.js';
import { appleRegistrations, customers } from '../db.js';
import { generatePkpass } from '../services/applePass.js';
import { safeEqual } from '../util/crypto.js';

/**
 * Apple Wallet Web Service (PassKit).
 *
 * Mounted at /wallet, so pass.json points webServiceURL at <baseUrl>/wallet and
 * iOS calls <baseUrl>/wallet/v1/... exactly as the spec describes.
 * Reference: developer.apple.com/documentation/walletpasses
 */
export const walletRouter = express.Router();

/** Authenticates a device using `Authorization: ApplePass <authenticationToken>`. */
function authorizePass(req, res, serialNumber) {
  const header = req.get('authorization') || '';
  const match = header.match(/^ApplePass\s+(.+)$/i);
  if (!match) {
    res.status(401).end();
    return null;
  }
  const customer = customers.byPublicId(serialNumber);
  if (!customer || !safeEqual(match[1].trim(), customer.auth_token)) {
    res.status(401).end();
    return null;
  }
  return customer;
}

function checkPassType(req, res) {
  if (req.params.passTypeIdentifier !== config.apple.passTypeId) {
    res.status(404).end();
    return false;
  }
  return true;
}

// 1. Register a device to receive push notifications for a pass.
walletRouter.post(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  (req, res) => {
    if (!checkPassType(req, res)) return;
    const customer = authorizePass(req, res, req.params.serialNumber);
    if (!customer) return;

    const pushToken = req.body?.pushToken;
    if (!pushToken || typeof pushToken !== 'string') return res.status(400).end();

    const { created } = appleRegistrations.upsert({
      deviceLibraryId: req.params.deviceLibraryIdentifier,
      passTypeId: req.params.passTypeIdentifier,
      serial: req.params.serialNumber,
      pushToken,
    });
    res.status(created ? 201 : 200).end();
  }
);

// 2. Unregister a device.
walletRouter.delete(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  (req, res) => {
    if (!checkPassType(req, res)) return;
    const customer = authorizePass(req, res, req.params.serialNumber);
    if (!customer) return;

    appleRegistrations.remove({
      deviceLibraryId: req.params.deviceLibraryIdentifier,
      passTypeId: req.params.passTypeIdentifier,
      serial: req.params.serialNumber,
    });
    res.status(200).end();
  }
);

// 3. List the serial numbers of passes that changed since the device last asked.
walletRouter.get('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', (req, res) => {
  if (!checkPassType(req, res)) return;

  const registered = new Set(
    appleRegistrations.serialsForDevice(req.params.deviceLibraryIdentifier, req.params.passTypeIdentifier)
  );
  if (!registered.size) return res.status(404).end();

  const since = req.query.passesUpdatedSince ? String(req.query.passesUpdatedSince) : '1970-01-01T00:00:00.000Z';
  const changed = customers
    .updatedSince(since)
    .filter((row) => registered.has(row.public_id));

  if (!changed.length) return res.status(204).end();

  const lastUpdated = changed.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), since);
  res.json({ lastUpdated, serialNumbers: changed.map((row) => row.public_id) });
});

// 4. Deliver the latest version of a pass.
walletRouter.get('/v1/passes/:passTypeIdentifier/:serialNumber', async (req, res, next) => {
  if (!checkPassType(req, res)) return;
  const customer = authorizePass(req, res, req.params.serialNumber);
  if (!customer) return;
  if (!appleReady) return res.status(503).end();

  // Skip the work when the device already has this version.
  const modified = new Date(customer.updated_at);
  const ifModifiedSince = req.get('if-modified-since');
  if (ifModifiedSince && Date.parse(ifModifiedSince) >= Math.floor(modified.getTime() / 1000) * 1000) {
    return res.status(304).end();
  }

  try {
    const buffer = await generatePkpass(customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Last-Modified', modified.toUTCString());
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// 5. Device-side error log. Apple posts here when something goes wrong.
walletRouter.post('/v1/log', (req, res) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs : [];
  for (const line of logs.slice(0, 20)) console.warn('[wallet-log]', String(line).slice(0, 500));
  res.status(200).end();
});
