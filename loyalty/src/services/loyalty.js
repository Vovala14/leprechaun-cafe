import { config } from '../config.js';
import { customers, transaction } from '../db.js';
import { cardToken } from '../util/crypto.js';

export const GOAL = config.loyalty.goal;

export class LoyaltyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/**
 * The single source of truth for how a card reads, shared by the wallet passes,
 * the web card and the staff scanner — so all three can never disagree.
 */
export function cardState(customer) {
  const punches = Math.max(0, Math.min(GOAL, customer.punches));
  const rewardReady = punches >= GOAL;
  const remaining = Math.max(0, GOAL - punches);

  return {
    publicId: customer.public_id,
    name: customer.name || '',
    phone: customer.phone || '',
    punches,
    goal: GOAL,
    remaining,
    rewardReady,
    blocked: Boolean(customer.blocked),
    totalPunches: customer.total_punches,
    totalScans: customer.total_scans,
    totalRewards: customer.total_rewards,
    createdAt: customer.created_at,
    updatedAt: customer.updated_at,
    lastScanAt: customer.last_scan_at,
    token: cardToken(customer.public_id),
    cardUrl: `${config.baseUrl}/c/${customer.public_id}`,

    // Ready-to-render Hebrew strings.
    text: {
      counter: `${punches} / ${GOAL}`,
      headline: rewardReady ? 'הקפה הבא עלינו! 🍀' : `עוד ${remaining} ${remaining === 1 ? 'קפה' : 'קפה'} לקפה חינם`,
      short: rewardReady ? 'קפה חינם מחכה' : `עוד ${remaining}`,
      progressLabel: rewardReady ? 'הכרטיסייה מלאה' : `${punches} מתוך ${GOAL} ניקובים`,
      rule: `קונים ${GOAL} קפה — ה־${GOAL + 1} עלינו`,
    },
  };
}

function secondsSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 1000;
}

/**
 * Adds punches to a card.
 *
 * Returns `{ status: 'cooldown' }` instead of writing when the same card was
 * scanned moments ago — the staff app then asks for confirmation, which guards
 * against the double-scan that happens when a phone is held too long.
 */
export const punch = transaction(function punch(customer, { count = 1, staff = null, force = false } = {}) {
  if (customer.blocked) {
    throw new LoyaltyError('blocked', 'הכרטיסייה חסומה. פנה למנהל.');
  }
  const n = Math.max(1, Math.min(config.loyalty.maxPunchesPerScan, Number(count) || 1));

  if (customer.punches >= GOAL) {
    throw new LoyaltyError('reward_pending', 'הכרטיסייה מלאה — יש לממש קפה חינם לפני ניקוב חדש.', {
      state: cardState(customer),
    });
  }

  const waited = secondsSince(customer.last_scan_at);
  if (!force && waited < config.loyalty.cooldownSeconds) {
    return {
      status: 'cooldown',
      secondsAgo: Math.round(waited),
      cooldownSeconds: config.loyalty.cooldownSeconds,
      state: cardState(customer),
    };
  }

  const newPunches = Math.min(GOAL, customer.punches + n);
  const delta = newPunches - customer.punches;

  customers.applyPunch(customer.id, { punches: newPunches, deltaPunches: delta, rewards: 0, scanned: true });
  customers.addEvent({
    customerId: customer.id,
    type: 'punch',
    delta,
    punchesAfter: newPunches,
    staffId: staff?.id ?? null,
    staffName: staff?.display_name ?? null,
    note: delta < n ? 'נוקב חלקית — הכרטיסייה התמלאה' : null,
  });

  const updated = customers.byId(customer.id);
  return {
    status: 'ok',
    added: delta,
    requested: n,
    state: cardState(updated),
    customer: updated,
  };
});

/** Redeems the free coffee and starts a fresh card. */
export const redeem = transaction(function redeem(customer, { staff = null } = {}) {
  if (customer.blocked) {
    throw new LoyaltyError('blocked', 'הכרטיסייה חסומה. פנה למנהל.');
  }
  if (customer.punches < GOAL) {
    throw new LoyaltyError('not_ready', `עוד ${GOAL - customer.punches} ניקובים עד הקפה החינם.`, {
      state: cardState(customer),
    });
  }

  customers.applyPunch(customer.id, { punches: 0, deltaPunches: 0, rewards: 1, scanned: true });
  customers.addEvent({
    customerId: customer.id,
    type: 'reward',
    delta: -GOAL,
    punchesAfter: 0,
    staffId: staff?.id ?? null,
    staffName: staff?.display_name ?? null,
    note: 'קפה חינם מומש',
  });

  const updated = customers.byId(customer.id);
  return { status: 'ok', state: cardState(updated), customer: updated };
});

/** Manual correction by a manager (positive or negative). */
export const adjust = transaction(function adjust(customer, { delta, staff = null, note = null } = {}) {
  const d = Math.trunc(Number(delta) || 0);
  if (!d) throw new LoyaltyError('bad_delta', 'יש לציין מספר ניקובים לשינוי.');

  const newPunches = Math.max(0, Math.min(GOAL, customer.punches + d));
  const applied = newPunches - customer.punches;

  customers.applyPunch(customer.id, {
    punches: newPunches,
    deltaPunches: Math.max(0, applied),
    rewards: 0,
    scanned: false,
  });
  customers.addEvent({
    customerId: customer.id,
    type: 'adjust',
    delta: applied,
    punchesAfter: newPunches,
    staffId: staff?.id ?? null,
    staffName: staff?.display_name ?? null,
    note,
  });

  const updated = customers.byId(customer.id);
  return { status: 'ok', applied, state: cardState(updated), customer: updated };
});
