import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * SQLite access layer.
 *
 * Prefers better-sqlite3 (prebuilt binaries, works everywhere) and falls back to
 * Node's built-in node:sqlite so the app still boots if the native module fails
 * to install. Only positional `?` parameters are used, because that is the one
 * binding style both drivers agree on.
 */
let Driver = null;
let driverName = '';

try {
  const mod = await import('better-sqlite3');
  Driver = mod.default;
  driverName = 'better-sqlite3';
} catch {
  try {
    const mod = await import('node:sqlite');
    Driver = mod.DatabaseSync;
    driverName = 'node:sqlite';
  } catch {
    console.error(
      '\n❌ לא נמצא מנוע SQLite.\n' +
        '   הרץ `npm install` בתיקיית loyalty, או הפעל עם Node 22.5+ ודגל --experimental-sqlite.\n'
    );
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Driver(config.dbPath);
export const sqliteDriver = driverName;

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT    NOT NULL UNIQUE,
  name           TEXT,
  phone          TEXT,
  email          TEXT,
  punches        INTEGER NOT NULL DEFAULT 0,
  total_punches  INTEGER NOT NULL DEFAULT 0,
  total_scans    INTEGER NOT NULL DEFAULT 0,
  total_rewards  INTEGER NOT NULL DEFAULT 0,
  auth_token     TEXT    NOT NULL,
  google_object_id TEXT,
  blocked        INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  last_scan_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL,
  delta         INTEGER NOT NULL DEFAULT 0,
  punches_after INTEGER NOT NULL DEFAULT 0,
  staff_id      INTEGER,
  staff_name    TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_created  ON events(created_at);

CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'staff',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apple_registrations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  device_library_id TEXT NOT NULL,
  pass_type_id      TEXT NOT NULL,
  serial            TEXT NOT NULL,
  push_token        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE(device_library_id, pass_type_id, serial)
);

CREATE INDEX IF NOT EXISTS idx_apple_reg_serial ON apple_registrations(serial);
CREATE INDEX IF NOT EXISTS idx_apple_reg_device ON apple_registrations(device_library_id, pass_type_id);
`);

/** Wraps `fn` in a transaction. Works on both drivers. */
export function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  };
}

export const nowIso = () => new Date().toISOString();

const q = {
  insertCustomer: db.prepare(`
    INSERT INTO customers (public_id, name, phone, email, auth_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  byPublicId: db.prepare('SELECT * FROM customers WHERE public_id = ?'),
  byId: db.prepare('SELECT * FROM customers WHERE id = ?'),
  byPhone: db.prepare('SELECT * FROM customers WHERE phone = ? ORDER BY id LIMIT 1'),
  touch: db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?'),
  setGoogleObject: db.prepare('UPDATE customers SET google_object_id = ?, updated_at = ? WHERE id = ?'),
  setProfile: db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?'),
  setBlocked: db.prepare('UPDATE customers SET blocked = ?, updated_at = ? WHERE id = ?'),
  setNotes: db.prepare('UPDATE customers SET notes = ?, updated_at = ? WHERE id = ?'),
  applyPunch: db.prepare(`
    UPDATE customers
       SET punches       = ?,
           total_punches = total_punches + ?,
           total_scans   = total_scans + ?,
           total_rewards = total_rewards + ?,
           last_scan_at  = CASE WHEN ? = 1 THEN ? ELSE last_scan_at END,
           updated_at    = ?
     WHERE id = ?`),
  insertEvent: db.prepare(`
    INSERT INTO events (customer_id, type, delta, punches_after, staff_id, staff_name, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  eventsFor: db.prepare('SELECT * FROM events WHERE customer_id = ? ORDER BY id DESC LIMIT ?'),
  updatedSince: db.prepare('SELECT public_id, updated_at FROM customers WHERE updated_at > ? ORDER BY updated_at'),
};

export const customers = {
  create({ publicId, name, phone, email, authToken }) {
    const ts = nowIso();
    const info = q.insertCustomer.run(publicId, name || null, phone || null, email || null, authToken, ts, ts);
    return this.byId(Number(info.lastInsertRowid));
  },
  byPublicId: (publicId) => q.byPublicId.get(publicId) || null,
  byId: (id) => q.byId.get(id) || null,
  byPhone: (phone) => q.byPhone.get(phone) || null,
  touch: (id) => q.touch.run(nowIso(), id),
  setGoogleObject: (id, objectId) => q.setGoogleObject.run(objectId, nowIso(), id),
  setProfile: (id, { name, phone, email }) => q.setProfile.run(name || null, phone || null, email || null, nowIso(), id),
  setBlocked: (id, blocked) => q.setBlocked.run(blocked ? 1 : 0, nowIso(), id),
  setNotes: (id, notes) => q.setNotes.run(notes || null, nowIso(), id),
  applyPunch: (id, { punches, deltaPunches = 0, rewards = 0, scanned = false }) => {
    const ts = nowIso();
    return q.applyPunch.run(punches, deltaPunches, scanned ? 1 : 0, rewards, scanned ? 1 : 0, ts, ts, id);
  },
  addEvent: (e) =>
    q.insertEvent.run(
      e.customerId,
      e.type,
      e.delta || 0,
      e.punchesAfter || 0,
      e.staffId ?? null,
      e.staffName ?? null,
      e.note ?? null,
      nowIso()
    ),
  events: (customerId, limit = 30) => q.eventsFor.all(customerId, limit),
  updatedSince: (iso) => q.updatedSince.all(iso),

  search({ term = '', limit = 50, offset = 0 } = {}) {
    const like = `%${term.trim()}%`;
    if (term.trim()) {
      return db
        .prepare(
          `SELECT * FROM customers
            WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR public_id LIKE ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(like, like, like, like, limit, offset);
    }
    return db.prepare('SELECT * FROM customers ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  },

  count: () => db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
  all: () => db.prepare('SELECT * FROM customers ORDER BY id').all(),
};

export const staff = {
  create({ username, displayName, passwordHash, role = 'staff' }) {
    const info = db
      .prepare('INSERT INTO staff (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, displayName || username, passwordHash, role, nowIso());
    return staff.byId(Number(info.lastInsertRowid));
  },
  byUsername: (username) => db.prepare('SELECT * FROM staff WHERE username = ?').get(username) || null,
  byId: (id) => db.prepare('SELECT * FROM staff WHERE id = ?').get(id) || null,
  all: () => db.prepare('SELECT id, username, display_name, role, active, created_at FROM staff ORDER BY id').all(),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1').get().n,
  setActive: (id, active) => db.prepare('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, id),
  setPassword: (id, hash) => db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hash, id),
};

export const sessions = {
  create(token, staffId, expiresAt) {
    db.prepare('INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token,
      staffId,
      nowIso(),
      expiresAt
    );
  },
  get: (token) => db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null,
  destroy: (token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(token),
  purgeExpired: () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()),
};

export const appleRegistrations = {
  upsert({ deviceLibraryId, passTypeId, serial, pushToken }) {
    const existing = db
      .prepare(
        'SELECT * FROM apple_registrations WHERE device_library_id = ? AND pass_type_id = ? AND serial = ?'
      )
      .get(deviceLibraryId, passTypeId, serial);
    if (existing) {
      if (existing.push_token !== pushToken) {
        db.prepare('UPDATE apple_registrations SET push_token = ? WHERE id = ?').run(pushToken, existing.id);
      }
      return { created: false };
    }
    db.prepare(
      `INSERT INTO apple_registrations (device_library_id, pass_type_id, serial, push_token, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(deviceLibraryId, passTypeId, serial, pushToken, nowIso());
    return { created: true };
  },
  remove: ({ deviceLibraryId, passTypeId, serial }) =>
    db
      .prepare('DELETE FROM apple_registrations WHERE device_library_id = ? AND pass_type_id = ? AND serial = ?')
      .run(deviceLibraryId, passTypeId, serial),
  removeByPushToken: (pushToken) =>
    db.prepare('DELETE FROM apple_registrations WHERE push_token = ?').run(pushToken),
  tokensForSerial: (serial) =>
    db.prepare('SELECT DISTINCT push_token FROM apple_registrations WHERE serial = ?').all(serial).map((r) => r.push_token),
  serialsForDevice: (deviceLibraryId, passTypeId) =>
    db
      .prepare('SELECT serial FROM apple_registrations WHERE device_library_id = ? AND pass_type_id = ?')
      .all(deviceLibraryId, passTypeId)
      .map((r) => r.serial),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM apple_registrations').get().n,
};

export const stats = {
  overview() {
    const totalCustomers = customers.count();
    const activeCards = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE total_punches > 0').get().n;
    const totalPunches = db.prepare('SELECT COALESCE(SUM(total_punches),0) AS n FROM customers').get().n;
    const totalRewards = db.prepare('SELECT COALESCE(SUM(total_rewards),0) AS n FROM customers').get().n;
    const dayAgo = new Date(Date.now() - 86400e3).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();
    const countEvents = (type, since) =>
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ?').get(type, since).n;
    return {
      totalCustomers,
      activeCards,
      totalPunches,
      totalRewards,
      punchesToday: countEvents('punch', dayAgo),
      punchesWeek: countEvents('punch', weekAgo),
      rewardsMonth: countEvents('reward', monthAgo),
      newCustomersWeek: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE created_at >= ?').get(weekAgo).n,
      appleRegistrations: appleRegistrations.count(),
      readyForReward: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE punches >= ?').get(config.loyalty.goal).n,
    };
  },

  /** Punches per day for the last `days` days, oldest first. */
  daily(days = 30) {
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    return db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(CASE WHEN type = 'punch'  THEN 1 ELSE 0 END) AS punches,
                SUM(CASE WHEN type = 'reward' THEN 1 ELSE 0 END) AS rewards
           FROM events
          WHERE created_at >= ?
          GROUP BY day
          ORDER BY day`
      )
      .all(since);
  },

  top(limit = 10) {
    return db
      .prepare(
        `SELECT public_id, name, phone, punches, total_punches, total_rewards
           FROM customers WHERE total_punches > 0
          ORDER BY total_punches DESC, total_rewards DESC LIMIT ?`
      )
      .all(limit);
  },

  recentEvents(limit = 40) {
    return db
      .prepare(
        `SELECT e.*, c.name AS customer_name, c.public_id
           FROM events e JOIN customers c ON c.id = e.customer_id
          ORDER BY e.id DESC LIMIT ?`
      )
      .all(limit);
  },
};
