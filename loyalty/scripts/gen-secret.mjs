#!/usr/bin/env node
/** מדפיס APP_SECRET אקראי להדבקה בקובץ .env */
import crypto from 'node:crypto';

const secret = crypto.randomBytes(48).toString('base64url');

console.log('\nהדביקו את השורה הזו בקובץ .env:\n');
console.log(`APP_SECRET=${secret}\n`);
console.log('⚠️  אם משנים את המפתח אחרי שהונפקו כרטיסיות — כל קודי ה-QR הקיימים יפסיקו להיסרק.');
console.log('   (הלקוחות יצטרכו לפתוח מחדש את הכרטיסייה כדי לקבל קוד חדש.)\n');
