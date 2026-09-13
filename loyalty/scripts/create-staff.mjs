#!/usr/bin/env node
/**
 * יצירת משתמש צוות.
 *
 *   node scripts/create-staff.mjs                       — אינטראקטיבי
 *   node scripts/create-staff.mjs dana "דנה" admin       — ישיר (הסיסמה תיווצר אוטומטית)
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { staff } from '../src/db.js';
import { hashPassword } from '../src/util/crypto.js';

const [, , argUser, argName, argRole] = process.argv;

function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  let username = argUser;
  let displayName = argName;
  let role = argRole;
  let password = null;

  if (!username) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    username = (await rl.question('שם משתמש (אנגלית, ללא רווחים): ')).trim().toLowerCase();
    displayName = (await rl.question('שם לתצוגה (עברית): ')).trim();
    role = (await rl.question('תפקיד — staff / admin [staff]: ')).trim() || 'staff';
    password = (await rl.question('סיסמה (Enter ליצירה אוטומטית): ')).trim() || null;
    rl.close();
  }

  role = role === 'admin' ? 'admin' : 'staff';
  displayName = displayName || username;
  password ||= randomPassword();

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    console.error('❌ שם משתמש לא תקין — 3 עד 32 תווים: a-z, 0-9, . _ -');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('❌ הסיסמה חייבת להיות לפחות 8 תווים.');
    process.exit(1);
  }
  if (staff.byUsername(username)) {
    console.error(`❌ המשתמש "${username}" כבר קיים.`);
    process.exit(1);
  }

  staff.create({ username, displayName, passwordHash: hashPassword(password), role });

  console.log('\n✅ המשתמש נוצר:');
  console.log(`   שם משתמש: ${username}`);
  console.log(`   שם תצוגה: ${displayName}`);
  console.log(`   תפקיד:    ${role === 'admin' ? 'מנהל/ת (גישה מלאה)' : 'ברמן/ית (סריקה בלבד)'}`);
  console.log(`   סיסמה:    ${password}`);
  console.log('\n   ⚠️  העתיקו את הסיסמה עכשיו — היא לא תוצג שוב.\n');
}

main();
