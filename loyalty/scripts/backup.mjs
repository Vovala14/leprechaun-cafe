#!/usr/bin/env node
/**
 * גיבוי מסד הנתונים לתיקיית backups/ (שומר את 30 הגיבויים האחרונים).
 * מומלץ להריץ פעם ביום דרך משימה מתוזמנת / cron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

// הגיבויים נשמרים ליד מסד הנתונים — כך הם נופלים על אותו Volume קבוע
// בענן, ולא נמחקים עם כל פריסה מחדש.
const dir = process.env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `loyalty-${stamp}.db`);

// VACUUM INTO מייצר עותק עקבי גם בזמן שהשרת רץ.
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const size = (fs.statSync(target).size / 1024).toFixed(0);
console.log(`✅ גיבוי נשמר: ${target} (${size} KB)`);

const backups = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith('loyalty-') && f.endsWith('.db'))
  .sort()
  .reverse();

for (const old of backups.slice(30)) {
  fs.unlinkSync(path.join(dir, old));
  console.log(`   🗑  נמחק גיבוי ישן: ${old}`);
}

console.log(`   מקור: ${config.dbPath}`);
