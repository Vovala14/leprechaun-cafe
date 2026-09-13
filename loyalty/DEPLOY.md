# 🚀 העלאה לאוויר — Railway

מדריך מלא מהמחשב שלכם עד כרטיסייה שנכנסת לאייפון של לקוח אמיתי.

**זמן:** כשעה־שעתיים, רובן המתנה לאפל ולגוגל.
**עלות:** ~5$ לחודש ל‑Railway. (Apple Developer — 99$ לשנה, כבר יש לכם.)

הסדר חשוב: **קודם קוד → אחר כך תעודות → אחר כך Railway → ולבסוף הדומיין חוזר להגדרות.**

---

## שלב 0 — למה Railway ולא Vercel

לא סתם הערה: אם תנסו את Vercel זה ייכשל בצורה מבלבלת.

| מה המערכת צריכה | Vercel |
|---|---|
| דיסק קבוע ל‑SQLite | ❌ הקבצים נמחקים בכל בקשה |
| תהליך שרץ ברציפות | ❌ פונקציות שמתות אחרי כמה שניות |
| חיבור HTTP/2 עם תעודת לקוח ל‑APNs | ❌ לא נתמך |

Railway מריץ קונטיינר רגיל עם דיסק — בדיוק מה שצריך.

---

## שלב 1 — דחיפת הקוד ל‑GitHub

הריפו `Vovala14/leprechaun-cafe` **ציבורי**. זה בסדר: אין בקוד שום סוד.
כל הסודות יושבים ב‑`.env` וב‑`certs/`, ושניהם ב‑`.gitignore` וב‑`.dockerignore`.

מהתיקייה הראשית של הפרויקט:

```bash
git add loyalty && git commit -m "Add digital loyalty card system" && git push
```

לפני שדוחפים, ודאו בעיניים שאין סודות:

```bash
git status --short loyalty && git ls-files loyalty | grep -E '\.env$|certs/|\.p12$|\.key$' || echo "נקי — אין סודות במעקב"
```

---

## שלב 2 — תעודות Apple

יש לכם כבר חשבון מפתחים, אז זה רק יצירת התעודה.

### 2.1 רישום סוג הכרטיסייה

[developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **Pass Type IDs**:

* Description: `Leprechaun Coffee Card`
* Identifier: `pass.co.il.leprechaun.loyalty`

רשמו לעצמכם את ה‑**Team ID** (10 תווים, תחת *Membership details*).

### 2.2 יצירת מפתח ובקשת חתימה

ב‑**Git Bash** (מגיע עם Git ל‑Windows וכולל OpenSSL):

```bash
cd "/c/Users/vlavrik/Desktop/Apps/Leprechaun Cafe/loyalty/certs" && openssl genrsa -out pass.key 2048
```

```bash
openssl req -new -key pass.key -out pass.csr -subj "//CN=Leprechaun Cafe\O=Leprechaun Cafe\C=IL"
```

> ה‑`//` הכפול והקווים ההפוכים הם לא טעות — Git Bash ב‑Windows הופך `/CN=...` לנתיב קבצים ושובר את הפקודה.

### 2.3 הורדת התעודה

חזרו לפורטל → לחצו על ה‑Pass Type ID שיצרתם → **Create Certificate** → העלו את `pass.csr` → **Download**.
קיבלתם `pass.cer`. שימו אותו ב‑`certs/` והמירו:

```bash
openssl x509 -inform DER -in pass.cer -out pass.pem
```

### 2.4 תעודת הביניים של אפל

הורידו **Worldwide Developer Relations — G4** מ‑[apple.com/certificateauthority](https://www.apple.com/certificateauthority/), שימו ב‑`certs/` והמירו:

```bash
openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
```

### 2.5 בדיקה מקומית לפני שממשיכים

הוסיפו ל‑`.env` המקומי:

```
APPLE_PASS_TYPE_ID=pass.co.il.leprechaun.loyalty
APPLE_TEAM_ID=ה-Team-ID-שלכם
APPLE_CERT_PEM_PATH=certs/pass.pem
APPLE_KEY_PEM_PATH=certs/pass.key
APPLE_WWDR_PATH=certs/wwdr.pem
```

```bash
npm run verify
```

זה בונה כרטיסייה, מאמת את החתימה הדיגיטלית מול המפתח הציבורי, ושומר `tmp/sample.pkpass`.
**שלחו את הקובץ לאייפון שלכם במייל ופתחו אותו.** אם הוא נפתח ב‑Wallet — התעודות תקינות ושאר הדרך בטוחה.
אם לא — אין טעם להמשיך ל‑Railway, התקלה כאן.

---

## שלב 3 — Google Wallet (חינם)

1. [pay.google.com/business/console](https://pay.google.com/business/console) → **Google Wallet API** → הירשמו כמנפיק.
   העתיקו את ה‑**Issuer ID** (19 ספרות).
2. [console.cloud.google.com](https://console.cloud.google.com) → פרויקט חדש → **APIs & Services → Library** → *Google Wallet API* → **Enable**.
3. **IAM & Admin → Service Accounts** → צרו חשבון בשם `wallet` → לשונית **Keys** → **Add Key → JSON**.
   שמרו את הקובץ בתור `certs/google-service-account.json`.
4. חזרה לקונסולת Wallet → **Users** → הזמינו את כתובת המייל של חשבון השירות (מסתיימת ב‑`.iam.gserviceaccount.com`) בתפקיד **Developer**.

עדיין לא מריצים `npm run google:class` — צריך קודם כתובת אמיתית באוויר. נחזור לזה בשלב 6.

---

## שלב 4 — אריזת הסודות

Railway לא מקבל קבצים, רק משתני סביבה. הפקודה הזו הופכת את כל מה שב‑`certs/` לשורות מוכנות להדבקה:

```bash
npm run pack
```

תקבלו משהו כזה (שורה אחת לכל קובץ):

```
APPLE_CERT_PEM_BASE64=LS0tLS1CRUdJTi...
APPLE_KEY_PEM_BASE64=LS0tLS1CRUdJTi...
APPLE_WWDR_BASE64=LS0tLS1CRUdJTi...
GOOGLE_SA_JSON_BASE64=ewogICJ0eXBl...
```

> **למה base64:** מפתח פרטי הוא רב‑שורתי. הדבקה ישירה לממשק של Railway שוברת את השורות, והתוצאה היא שגיאת חתימה מבלבלת בלי רמז למקור. base64 הוא שורה אחת שלא ניתן לשבור.
>
> ⚠️ הפלט מכיל מפתחות פרטיים. אל תשלחו אותו בצ'אט או במייל.

---

## שלב 5 — הקמת השירות ב‑Railway

### 5.1 יצירת הפרויקט

[railway.app](https://railway.app) → התחברו עם GitHub → **New Project** → **Deploy from GitHub repo** → בחרו `Vovala14/leprechaun-cafe`.

### 5.2 ⚠️ Root Directory — הדבר הכי חשוב כאן

בהגדרות השירות, קבעו **Root Directory** ל‑`loyalty`.

בלי זה Railway ינסה לבנות את אתר השיווק שבשורש הריפו, והבנייה תיכשל בלי הסבר ברור.
אחרי שתקבעו את זה, Railway יזהה לבד את `railway.json` ואת ה‑`Dockerfile`.

### 5.3 ⚠️ Volume — בלי זה תאבדו את כל הלקוחות

הוסיפו לשירות **Volume** עם נתיב עגינה:

```
/app/data
```

זה המקום שבו יושב מסד הנתונים. **בלי Volume, כל פריסה מחדש מוחקת את כל הלקוחות והניקובים.**
זו הטעות שהכי קל לעשות ושהכי כואב לגלות חודש אחרי.

### 5.4 משתני סביבה

בלשונית **Variables** → **Raw Editor** → הדביקו:

```
NODE_ENV=production
APP_SECRET=
ADMIN_USERNAME=admin
ADMIN_NAME=מנהל
ADMIN_PASSWORD=

BUSINESS_NAME=קפה לפריקון
BUSINESS_NAME_EN=Leprechaun Cafe
BUSINESS_ADDRESS=דרך ארץ 58, חריש
BUSINESS_PHONE=+97246070067
BUSINESS_INSTAGRAM=https://instagram.com/cafeleprechaun
BUSINESS_LAT=32.4647
BUSINESS_LNG=35.0447

LOYALTY_GOAL=8
PUNCH_COOLDOWN_SECONDS=90
MAX_PUNCHES_PER_SCAN=3

APPLE_PASS_TYPE_ID=pass.co.il.leprechaun.loyalty
APPLE_TEAM_ID=
GOOGLE_ISSUER_ID=
GOOGLE_CLASS_SUFFIX=leprechaun_coffee_card
```

מלאו את הריקים:

* **`APP_SECRET`** — הריצו `npm run secret` והדביקו. ⚠️ **אל תשנו אותו לעולם אחרי שיצאתם לאוויר** — הוא חותם את קודי ה‑QR, ושינוי שלו מבטל את כל הכרטיסיות הקיימות.
* **`ADMIN_PASSWORD`** — סיסמה חזקה שתבחרו. חייבת להיות מוגדרת **לפני** ההפעלה הראשונה.
* **`APPLE_TEAM_ID`** — מהשלב הקודם.
* **`GOOGLE_ISSUER_ID`** — 19 הספרות.

ואז הדביקו גם את ארבע השורות מ‑`npm run pack`.

**אל תגדירו `PORT`** — Railway מזריק אותו לבד, והאפליקציה קוראת אותו.
**אל תגדירו `BASE_URL` עדיין** — אין עוד כתובת. השלב הבא.

### 5.5 יצירת כתובת

בהגדרות השירות → אזור ה‑Networking → **Generate Domain**.
תקבלו משהו כמו `leprechaun-cafe-production.up.railway.app`, עם HTTPS תקף — וזה מספיק ל‑Apple Wallet.

### 5.6 סגירת המעגל

הוסיפו עכשיו למשתנים:

```
BASE_URL=https://הכתובת-שקיבלתם
```

שמרו — Railway יפרוס מחדש לבד. **זה השלב שמפעיל את העדכון האוטומטי של הכרטיסיות.** בלעדיו הכרטיסייה תיפתח בטלפון אבל תישאר תקועה על המספר שהיה בזמן השמירה.

### 5.7 בדיקה שהכול עלה

פתחו את הלוג של הפריסה. אתם אמורים לראות:

```
Apple Wallet           פעיל · pass.co.il.leprechaun.loyalty · תוקף עוד 364 ימים
Google Wallet          פעיל · 3388...הספרות....leprechaun_coffee_card
```

אם כתוב "לא מוגדר" — משתנה חסר או שגוי. היכנסו ל‑`/admin` → לשונית **מערכת**, שם כתוב בדיוק מה חסר.

---

## שלב 6 — עיצוב הכרטיסייה בגוגל

עכשיו כשיש כתובת חיה, גוגל יכולה למשוך ממנה את הלוגו. מהמחשב שלכם, עם `BASE_URL` של הייצור:

```bash
BASE_URL=https://הכתובת-שקיבלתם npm run google:class
```

הריצו את זה שוב אחרי כל שינוי בלוגו, בשם או בכתובת בית הקפה.

בהתחלה הכרטיסייה עובדת רק לחשבונות בדיקה שתגדירו בקונסולה. כשהכול נראה טוב — **Request publishing**. האישור לוקח בדרך כלל כמה ימי עסקים; עד אז אפשר לעבוד עם אפל ועם הכרטיסייה באינטרנט.

---

## שלב 7 — בדיקה

### 7.1 בדיקה אוטומטית מול הייצור

מהמחשב שלכם, עם סיסמת המנהל שהגדרתם ב‑Railway:

```bash
ADMIN_PASSWORD=הסיסמה-שלכם npm test -- https://הכתובת-שקיבלתם
```

הבדיקה עוברת 47 נקודות על השרת החי — הרשמה, חתימת QR, ניקוב, חסימת ניקוב כפול,
מימוש, הרשאות, ייצור pkpass, קישור שמירה לגוגל, וגיבוי. אפשר להריץ אותה שוב מתי שתרצו:
היא יוצרת לקוח בדיקה עם קידומת `059` (לא קיימת בישראל), חוסמת אותו בסוף, ולא נוגעת בלקוחות אמיתיים.

אם משהו נופל — ההודעה אומרת בדיוק מה. כשהבדיקה ירוקה, עברו לטלפון.

### 7.2 בדיקה על טלפון אמיתי

1. פתחו `https://הכתובת-שלכם/join` בטלפון והירשמו כלקוח.
2. לחצו **הוספה ל‑Apple Wallet** — הכרטיסייה נכנסת ל‑Wallet.
3. מטלפון אחר, היכנסו ל‑`/staff/scan`, התחברו כ‑`admin`, וסרקו את ה‑QR מהמסך הראשון.
4. לחצו **ניקוב** — והסתכלו על הטלפון הראשון. הכרטיסייה מתעדכנת תוך שניות, גם כשהמסך נעול.

אם השלב האחרון לא עובד: `/admin` → **סקירה** → אם "מכשירי Apple רשומים" מראה `0`, אף מכשיר לא נרשם לעדכונים — כמעט תמיד `BASE_URL` שגוי או לא https.

---

## שלב 8 — פתיחה ללקוחות

1. **שנו את סיסמת המנהל** אם השתמשתם בסיסמה זמנית.
2. `/admin` → **צוות** → פתחו משתמש לכל ברמן/ית. תפקיד *ברמן/ית* נותן גישה לסורק בלבד.
3. בטלפון של הקופה: פתחו `/staff/scan` → תפריט שיתוף → **הוספה למסך הבית**. זה ייפתח כמו אפליקציה.
4. `/admin` → **מערכת** → העתיקו את קישור ההצטרפות והדפיסו אותו כ‑QR לשולחנות ולקופה.
5. מחקו את נתוני הדמו אם הם עוד שם:

```bash
node scripts/seed-demo.mjs --clear
```

> הפקודה הזו מוחקת **רק** לקוחות שנוצרו על ידי הסיד (מסומנים `DEMO`). לקוחות אמיתיים לא נוגעים.
> אם הרצתם את הסיד רק מקומית — אין מה למחוק בייצור.

---

## תחזוקה שוטפת

### עדכוני קוד

```bash
git add loyalty && git commit -m "תיאור השינוי" && git push
```

Railway מזהה את הדחיפה ופורס לבד. הנתונים ב‑Volume שורדים.

### גיבויים

`/admin` → **מערכת** → **הורדת גיבוי**. מוריד עותק מלא ותקין של מסד הנתונים גם בזמן שהשרת עובד.
**עשו את זה פעם בשבוע ושמרו את הקובץ אצלכם.** Volume הוא לא גיבוי — הוא נמחק אם מוחקים את השירות.

לשחזור: עצרו את השירות, החליפו את `/app/data/loyalty.db` בקובץ הגיבוי, הפעילו מחדש.

### תוקף תעודת אפל

התעודה פגה אחרי שנה. `/admin` → **מערכת** מציג את התאריך, והשרת מתריע בלוג חודש מראש.
כשיגיע הזמן: חזרו על שלב 2, הריצו `npm run pack`, ועדכנו את המשתנים ב‑Railway.

### עלויות

| מה | כמה |
|---|---|
| Railway | ~5$ לחודש |
| Apple Developer | 99$ לשנה |
| Google Wallet | חינם |
| דומיין (אופציונלי) | ~50 ₪ לשנה |

---

## תקלות נפוצות

**הבנייה נכשלת ב‑Railway**
Root Directory לא מוגדר ל‑`loyalty` (שלב 5.2).

**כל הלקוחות נעלמו אחרי פריסה**
אין Volume על `/app/data` (שלב 5.3). הוסיפו אותו עכשיו — מכאן והלאה הנתונים יישמרו.

**הכרטיסייה נכנסת ל‑Wallet אבל לא מתעדכנת**
`BASE_URL` לא מוגדר, או מוגדר עם `http` במקום `https`, או לא תואם לכתובת בפועל. חייב להיות מדויק.

**"Apple Wallet — לא מוגדר" בלוג, למרות שהדבקתם הכול**
אחד ממשתני ה‑base64 נחתך בהדבקה. הריצו `npm run pack` שוב והדביקו מחדש דרך ה‑Raw Editor, לא שורה־שורה.

**האייפון מסרב לפתוח את הכרטיסייה**
כמעט תמיד `APPLE_TEAM_ID` לא תואם לתעודה. `npm run verify` מקומית יגיד לכם את זה במפורש.

**גוגל מחזירה שגיאת הרשאה**
חשבון השירות לא הוזמן ל‑Issuer בקונסולת Wallet (שלב 3.4), או שה‑API לא הופעל בפרויקט.

**המצלמה לא נפתחת בסורק**
דפדפנים מאפשרים מצלמה רק ב‑https. דרך כתובת ה‑Railway זה יעבוד. תמיד יש גם חיפוש ידני לפי שם או טלפון.

---

## מעבר לדומיין משלכם — כשתרצו

אפשר בכל שלב, בלי לשבור כרטיסיות קיימות (הן ימשיכו לעבוד מול הכתובת הישנה כל עוד היא פעילה):

1. קנו דומיין והוסיפו רשומת CNAME לפי מה ש‑Railway מציג ב‑**Custom Domain**.
2. עדכנו את `BASE_URL` לכתובת החדשה.
3. הריצו שוב `npm run google:class` עם ה‑`BASE_URL` החדש.
4. כרטיסיות אפל קיימות יעברו לכתובת החדשה בעדכון הבא שלהן.

כדי שכרטיסיות ותיקות לא יישארו תלויות באוויר, השאירו את כתובת ה‑Railway פעילה לפחות עוד כמה שבועות אחרי המעבר.
