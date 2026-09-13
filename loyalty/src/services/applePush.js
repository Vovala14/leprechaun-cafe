import http2 from 'node:http2';
import { config, appleReady } from '../config.js';
import { appleRegistrations } from '../db.js';
import { getCredentials } from './applePass.js';

/**
 * Wallet push notifications.
 *
 * APNs is told nothing but "this pass changed" (an empty payload). The device
 * then calls back into our web service to fetch the new .pkpass. Authentication
 * is the Pass Type ID certificate itself, used as a TLS client certificate.
 */
let session = null;
let connecting = null;

function connect() {
  if (session && !session.closed && !session.destroyed) return Promise.resolve(session);
  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const { keyPem, certPem } = getCredentials();
    const client = http2.connect(config.apple.apnsHost, { key: keyPem, cert: certPem });

    const onError = (err) => {
      connecting = null;
      session = null;
      reject(err);
    };
    client.once('error', onError);
    client.once('connect', () => {
      client.off('error', onError);
      client.on('error', (err) => {
        console.warn('[apns] שגיאת חיבור:', err.message);
        session = null;
      });
      client.once('close', () => {
        session = null;
      });
      session = client;
      connecting = null;
      resolve(client);
    });
  });

  return connecting;
}

function pushOne(client, deviceToken, topic) {
  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'apns-topic': topic,
      'apns-expiration': '0',
      'apns-priority': '10',
    });

    let status = 0;
    let body = '';

    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
    });
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('error', (err) => resolve({ deviceToken, ok: false, status: 0, reason: err.message }));
    req.on('end', () => {
      let reason = '';
      if (body) {
        try {
          reason = JSON.parse(body).reason || body;
        } catch {
          reason = body;
        }
      }
      resolve({ deviceToken, ok: status === 200, status, reason });
    });

    // Wallet expects an empty JSON payload.
    req.end('{}');
  });
}

/** Tokens APNs tells us are dead — the registration should be dropped. */
const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/**
 * Notifies every device holding this customer's pass that it changed.
 * Never throws: a push failure must not break a punch at the counter.
 */
export async function pushPassUpdate(publicId) {
  if (!appleReady) return { sent: 0, skipped: true };

  const tokens = appleRegistrations.tokensForSerial(publicId);
  if (!tokens.length) return { sent: 0, devices: 0 };

  try {
    const client = await connect();
    const results = await Promise.all(tokens.map((t) => pushOne(client, t, config.apple.passTypeId)));

    let sent = 0;
    for (const r of results) {
      if (r.ok) {
        sent++;
        continue;
      }
      if (r.status === 410 || DEAD_REASONS.has(r.reason)) {
        appleRegistrations.removeByPushToken(r.deviceToken);
        console.log(`[apns] הוסרה רשומת מכשיר לא פעילה (${r.reason || r.status})`);
      } else {
        console.warn(`[apns] דחיפה נכשלה: ${r.status} ${r.reason}`);
      }
    }
    return { sent, devices: tokens.length, results };
  } catch (err) {
    console.warn('[apns] לא הצלחתי לשלוח עדכון:', err.message);
    return { sent: 0, devices: tokens.length, error: err.message };
  }
}

export function closePush() {
  if (session && !session.destroyed) session.close();
  session = null;
}
