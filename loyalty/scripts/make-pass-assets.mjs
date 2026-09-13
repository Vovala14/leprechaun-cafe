#!/usr/bin/env node
/**
 * מייצר תמונות בסיס לכרטיסייה (Apple Wallet + Google Wallet).
 *
 * אלו תמונות ממלאות מקום כדי שהמערכת תעבוד מיד. מומלץ להחליף את
 * assets/pass/logo*.png ו-icon*.png בלוגו האמיתי של בית הקפה.
 *
 * כותב PNG בלי שום תלות חיצונית — zlib מובנה ב-Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'pass');

const GREEN = [26, 107, 60, 255];
const GREEN_DEEP = [13, 58, 32, 255];
const GOLD = [200, 162, 78, 255];
const CREAM = [250, 243, 224, 255];
const CLEAR = [0, 0, 0, 0];

/* ===== ציור ===== */
class Canvas {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.data = new Uint8Array(width * height * 4);
  }

  set(x, y, [r, g, b, a], coverage = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || coverage <= 0) return;
    const i = (y * this.w + x) * 4;
    const alpha = (a / 255) * coverage;
    const inv = 1 - alpha;
    this.data[i] = r * alpha + this.data[i] * inv;
    this.data[i + 1] = g * alpha + this.data[i + 1] * inv;
    this.data[i + 2] = b * alpha + this.data[i + 2] * inv;
    this.data[i + 3] = Math.min(255, a * alpha + this.data[i + 3] * inv);
  }

  fill(color) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, color);
  }

  /** מילוי לפי פונקציית מרחק מסומן — נותן קצוות חלקים (anti-aliasing). */
  shape(sdf, color) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        if (d < 1) this.set(x, y, color, Math.min(1, Math.max(0, 1 - d)));
      }
    }
  }

  circle(cx, cy, r, color) {
    this.shape((x, y) => Math.hypot(x - cx, y - cy) - r, color);
  }

  ring(cx, cy, r, thickness, color) {
    this.shape((x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - thickness / 2, color);
  }

  roundRect(x0, y0, w, h, radius, color) {
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    this.shape((x, y) => {
      const dx = Math.abs(x - cx) - (w / 2 - radius);
      const dy = Math.abs(y - cy) - (h / 2 - radius);
      const ox = Math.max(dx, 0);
      const oy = Math.max(dy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
    }, color);
  }

  verticalGradient(top, bottom) {
    for (let y = 0; y < this.h; y++) {
      const t = y / Math.max(1, this.h - 1);
      const color = [0, 1, 2].map((i) => top[i] + (bottom[i] - top[i]) * t).concat(255);
      for (let x = 0; x < this.w; x++) this.set(x, y, color);
    }
  }

  /** תלתן: שלושה עלים + גבעול. */
  shamrock(cx, cy, size, color) {
    const leaf = size * 0.3;
    const offset = size * 0.27;
    for (const angle of [-Math.PI / 2, (-Math.PI / 2) + (2 * Math.PI) / 3, (-Math.PI / 2) - (2 * Math.PI) / 3]) {
      this.circle(cx + Math.cos(angle) * offset, cy + Math.sin(angle) * offset, leaf, color);
    }
    this.shape((x, y) => {
      const dx = Math.abs(x - cx) - size * 0.045;
      const dy = Math.abs(y - (cy + size * 0.4)) - size * 0.32;
      return Math.max(dx, dy);
    }, color);
  }

  /** ספל קפה פשוט — גוף, ידית, צלוחית. */
  cup(cx, cy, size, color) {
    const bodyW = size * 0.72;
    const bodyH = size * 0.6;
    this.shape((x, y) => {
      const ny = (y - (cy - bodyH / 2)) / bodyH;
      if (ny < 0 || ny > 1) return 1;
      const halfWidth = (bodyW / 2) * (1 - ny * 0.22);
      return Math.abs(x - cx) - halfWidth;
    }, color);
    this.ring(cx + bodyW * 0.56, cy - bodyH * 0.08, size * 0.17, size * 0.09, color);
    this.roundRect(cx - size * 0.52, cy + bodyH / 2, size * 1.04, size * 0.11, size * 0.055, color);
  }
}

/* ===== קידוד PNG ===== */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.w, 0);
  ihdr.writeUInt32BE(canvas.h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // כל שורה מקבלת בית מסנן בערך 0 (None).
  const stride = canvas.w * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.h);
  for (let y = 0; y < canvas.h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(canvas.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ===== התמונות ===== */

/** אייקון עגול: רקע שמנת, טבעת ירוקה, ספל וכתם זהב. */
function makeIcon(size) {
  const c = new Canvas(size, size);
  const r = size / 2;
  c.circle(r, r, r - size * 0.02, CREAM);
  c.ring(r, r, r - size * 0.09, size * 0.075, GREEN);
  c.cup(r, r * 1.08, size * 0.44, GREEN);
  c.shamrock(r * 1.34, r * 0.64, size * 0.16, GOLD);
  return c;
}

/** לוגו מרובע: תלתן זהב על ירוק, לשימוש לצד logoText. */
function makeLogo(size) {
  const c = new Canvas(size, size);
  c.roundRect(0, 0, size, size, size * 0.22, GREEN);
  c.shamrock(size / 2, size * 0.46, size * 0.62, CREAM);
  c.roundRect(size * 0.2, size * 0.82, size * 0.6, size * 0.07, size * 0.035, GOLD);
  return c;
}

/** תמונת רקע רחבה ל-Google Wallet. */
function makeHero(width, height) {
  const c = new Canvas(width, height);
  c.verticalGradient(GREEN, GREEN_DEEP);
  for (let i = 0; i < 7; i++) {
    c.shamrock(width * (0.08 + i * 0.14), height * (i % 2 ? 0.32 : 0.68), height * 0.3, [
      250, 243, 224, 22,
    ]);
  }
  c.cup(width * 0.5, height * 0.52, height * 0.62, [250, 243, 224, 235]);
  return c;
}

/* ===== כתיבה ===== */
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon.png', makeIcon(29)],
  ['icon@2x.png', makeIcon(58)],
  ['icon@3x.png', makeIcon(87)],
  ['logo.png', makeLogo(50)],
  ['logo@2x.png', makeLogo(100)],
  ['logo@3x.png', makeLogo(150)],
  ['hero.png', makeHero(1032, 336)],
];

const force = process.argv.includes('--force');
let written = 0;
let skipped = 0;

for (const [name, canvas] of jobs) {
  const file = path.join(OUT, name);
  if (fs.existsSync(file) && !force) {
    console.log(`  ⏭  ${name} — כבר קיים (הריצו עם --force כדי לדרוס)`);
    skipped++;
    continue;
  }
  fs.writeFileSync(file, encodePng(canvas));
  console.log(`  ✅ ${name}  (${canvas.w}×${canvas.h})`);
  written++;
}

console.log(`\nנכתבו ${written} תמונות אל ${OUT}${skipped ? `, ${skipped} דולגו` : ''}.`);
console.log('💡 להחלפה בלוגו האמיתי: שמרו PNG שקוף בשמות icon.png / icon@2x.png / icon@3x.png ו-logo*.png.\n');
