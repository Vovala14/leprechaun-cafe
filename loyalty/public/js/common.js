/* עזרים משותפים לכל הדפים */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** fetch שמחזיר JSON וזורק שגיאה עם ההודעה מהשרת. */
export async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = new Error(data?.error || `שגיאה ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = null;
export function toast(message, kind = '', ms = 3200) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);

  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);

  toastTimer = setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/**
 * בוחר מספר עמודות שמתחלק בדיוק במספר העיגולים, כדי שלא תישאר
 * שורה אחרונה חלקית. ל-9 עיגולים (8 ניקובים + קפה חינם) יוצא 3×3.
 */
function columnsFor(total) {
  for (const c of [5, 4, 3]) if (total % c === 0) return c;
  return Math.min(5, total);
}

/**
 * מצייר את שורת הניקובים. העיגול האחרון הוא הקפה החינם.
 * animateTo — אינדקס הניקוב החדש, לאנימציית "פופ".
 */
export function renderDots(container, punches, goal, animateTo = -1) {
  container.style.gridTemplateColumns = `repeat(${columnsFor(goal + 1)}, 1fr)`;
  container.innerHTML = '';
  for (let i = 0; i < goal + 1; i++) {
    const dot = document.createElement('div');
    const isReward = i === goal;
    dot.className = 'dot';
    if (isReward) dot.classList.add('reward');
    if (i < punches || (isReward && punches >= goal)) dot.classList.add('filled');
    if (i === animateTo) dot.classList.add('pop');
    dot.textContent = isReward ? '☕' : i < punches ? '☘' : '';
    dot.setAttribute('aria-label', isReward ? 'קפה חינם' : `ניקוב ${i + 1}`);
    container.appendChild(dot);
  }
}

export function setBusy(button, busy, busyLabel = '') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${busyLabel ? ' ' + escapeHtml(busyLabel) : ''}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => /Android/i.test(navigator.userAgent);

/** רטט קצר במכשירים שתומכים — משוב מיידי לברמן/ית. */
export function buzz(pattern = 40) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* לא נתמך */
  }
}
