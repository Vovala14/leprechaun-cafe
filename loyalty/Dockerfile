FROM node:22-slim

WORKDIR /app

# better-sqlite3 מגיע עם בינארי מוכן לרוב הפלטפורמות. כלי הבנייה מותקנים
# רק למקרה שאין בינארי מתאים, ומוסרים באותה שכבה כדי לא לנפח את ה-image.
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY . .

# תמונות הכרטיסייה מגיעות עם הריפו; זה רק רשת ביטחון אם מישהו מחק אותן.
RUN node scripts/make-pass-assets.mjs || true

# התיקיות שהאפליקציה כותבת אליהן. ב-Railway מחברים כאן Volume אל /app/data.
RUN mkdir -p data backups && chown -R node:node /app/data /app/backups

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
