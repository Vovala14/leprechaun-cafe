#!/usr/bin/env node
/**
 * יוצר (או מעדכן) את מחלקת הכרטיסייה ב-Google Wallet.
 * מריצים פעם אחת אחרי הגדרת חשבון השירות, ושוב אחרי כל שינוי במיתוג.
 */
import { config, googleReady, googleClassId } from '../src/config.js';
import { ensureClass } from '../src/services/googleWallet.js';

if (!googleReady) {
  console.error('\n❌ Google Wallet לא מוגדר. חסרים בקובץ .env:\n');
  if (!config.google.issuerId) console.error('   • GOOGLE_ISSUER_ID');
  if (!config.google.serviceAccountEmail) console.error('   • GOOGLE_SA_EMAIL (או GOOGLE_SA_FILE)');
  if (!config.google.serviceAccountKey) console.error('   • GOOGLE_SA_PRIVATE_KEY (או GOOGLE_SA_FILE)');
  console.error('\n   ראו את חלק "Google Wallet" ב-README.\n');
  process.exit(1);
}

if (!config.baseUrl.startsWith('https://')) {
  console.warn('\n⚠️  BASE_URL אינו https — גוגל לא תצליח לטעון את הלוגו והתמונות.');
  console.warn('   אפשר להמשיך לבדיקות, אבל הריצו שוב אחרי העלייה לאוויר.\n');
}

try {
  const result = await ensureClass();
  console.log(`\n✅ המחלקה ${result.created ? 'נוצרה' : 'עודכנה'}: ${googleClassId}`);
  console.log(`   סטטוס בדיקה: ${result.class?.reviewStatus || 'UNDER_REVIEW'}`);
  console.log('\n   הכרטיסיות עובדות כבר עכשיו עבור חשבונות הבדיקה שהוגדרו ב-Google Pay & Wallet Console.');
  console.log('   לפרסום לכלל הלקוחות — לחצו "Request publishing" בקונסולה.\n');
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}
