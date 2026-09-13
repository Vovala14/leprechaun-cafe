#!/usr/bin/env node
/**
 * ממלא את המערכת בנתוני דמו כדי שאפשר יהיה להתנסות לפני שעולים לאוויר.
 *
 *   node scripts/seed-demo.mjs            — יוצר 35 לקוחות והיסטוריה של 30 יום
 *   node scripts/seed-demo.mjs --clear    — מוחק רק את נתוני הדמו
 *
 * כל לקוחות הדמו מסומנים בהערה "DEMO" ובטלפונים בטווח 05X-000-XXXX,
 * כך שאפשר למחוק אותם בלי לגעת בלקוחות אמיתיים.
 */
import crypto from 'node:crypto';
import { db, customers, nowIso } from '../src/db.js';
import { config } from '../src/config.js';
import { randomId, randomToken } from '../src/util/crypto.js';

const GOAL = config.loyalty.goal;
const MARK = 'DEMO';

if (process.argv.includes('--clear')) {
  const { changes } = db.prepare("DELETE FROM customers WHERE notes = ?").run(MARK);
  console.log(`🗑  נמחקו ${changes} לקוחות דמו (האירועים שלהם נמחקו יחד איתם).`);
  process.exit(0);
}

const FIRST = ['דנה', 'אורי', 'נועה', 'יואב', 'שירה', 'איתי', 'מאיה', 'עומר', 'תמר', 'ניר',
               'הילה', 'רון', 'ליאור', 'גל', 'אלון', 'יעל', 'עדי', 'טל', 'רותם', 'שחר'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'שפירא', 'אזולאי', 'דהן'];

const pick = (arr) => arr[crypto.randomInt(arr.length)];
const daysAgo = (n, hour = 9) => {
  const d = new Date(Date.now() - n * 86400e3);
  d.setHours(hour, crypto.randomInt(60), crypto.randomInt(60), 0);
  return d.toISOString();
};

const insertCustomer = db.prepare(`
  INSERT INTO customers (public_id, name, phone, email, punches, total_punches, total_scans,
                         total_rewards, auth_token, notes, created_at, updated_at, last_scan_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const insertEvent = db.prepare(`
  INSERT INTO events (customer_id, type, delta, punches_after, staff_name, note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

const COUNT = 35;
let totalEvents = 0;

db.exec('BEGIN');
try {
  for (let i = 0; i < COUNT; i++) {
    const joinedDaysAgo = crypto.randomInt(1, 30);
    const createdAt = daysAgo(joinedDaysAgo, 10);

    // כמה קפה הלקוח/ה קנה/תה מאז ההצטרפות — רוב הלקוחות מזדמנים, מעטים קבועים
    const intensity = Math.random() < 0.25 ? 1.2 : Math.random() < 0.6 ? 0.45 : 0.15;
    let purchases = Math.min(40, Math.round(joinedDaysAgo * intensity));
    // כשליש מהלקוחות משאירים כרטיסייה מלאה ולא ממשים מיד
    const leavesCardFull = Math.random() < 0.3;

    const info = insertCustomer.run(
      randomId(12),
      `${pick(FIRST)} ${pick(LAST)}`,
      `05${crypto.randomInt(10)}000${String(1000 + i).slice(-4)}`,
      null,
      0, 0, 0, 0,
      randomToken(24),
      MARK,
      createdAt,
      createdAt,
      null
    );
    const id = Number(info.lastInsertRowid);
    insertEvent.run(id, 'join', 0, 0, null, 'הצטרפות למועדון', createdAt);

    let punches = 0;
    let rewards = 0;
    let lastScan = null;

    for (let p = 0; p < purchases; p++) {
      // פורסים את הרכישות על פני התקופה, מהישן לחדש
      const when = daysAgo(
        Math.max(0, Math.round(joinedDaysAgo - (joinedDaysAgo * p) / Math.max(1, purchases))),
        7 + crypto.randomInt(11)
      );
      punches++;
      lastScan = when;

      insertEvent.run(id, 'punch', 1, punches, pick(['מנהל', 'דנה', 'יואב']), null, when);
      totalEvents++;

      if (punches >= GOAL) {
        // רוב הלקוחות מממשים מיד. חלק מסתובבים עם כרטיסייה מלאה —
        // וזה בדיוק המצב שכדאי לראות בסורק ובדשבורד.
        if (leavesCardFull) {
          purchases = p + 1;
          break;
        }
        insertEvent.run(id, 'reward', -GOAL, 0, pick(['מנהל', 'דנה', 'יואב']), 'קפה חינם מומש', when);
        punches = 0;
        rewards++;
        totalEvents++;
      }
    }

    db.prepare(
      `UPDATE customers SET punches = ?, total_punches = ?, total_scans = ?, total_rewards = ?,
                            last_scan_at = ?, updated_at = ? WHERE id = ?`
    ).run(punches, purchases, purchases, rewards, lastScan, lastScan || createdAt, id);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const ready = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE punches >= ? AND notes = ?').get(GOAL, MARK).n;

console.log(`\n✅ נוצרו ${COUNT} לקוחות דמו ו-${totalEvents} אירועים לאורך 30 יום.`);
console.log(`   ${ready} מהם עם כרטיסייה מלאה שמחכה למימוש.`);
console.log(`   סה״כ לקוחות במערכת: ${customers.count()}`);
console.log(`\n   למחיקה: node scripts/seed-demo.mjs --clear\n`);
console.log(`   עודכן לאחרונה: ${nowIso().slice(0, 10)}`);
