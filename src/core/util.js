// Small math / formatting helpers shared by every module.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (a, b, c, d, v) => lerp(c, d, clamp(invLerp(a, b, v), 0, 1));
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const len = (x, y) => Math.hypot(x, y);

/** Normalize a 2D vector; returns {x:0,y:0} for zero vectors. */
export function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

/** Move value toward target by at most maxDelta. */
export function approach(v, target, maxDelta) {
  if (v < target) return Math.min(v + maxDelta, target);
  return Math.max(v - maxDelta, target);
}

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 125 -> "2:05" */
export function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Money in thousands -> "$1.25M" / "$750K". Amounts in the game are stored in $K. */
export function fmtMoney(k) {
  if (Math.abs(k) >= 1000) return `$${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '')}M`;
  return `$${Math.round(k)}K`;
}

let uidCounter = 0;
/** Unique-enough id for runtime objects; persistent ids should come from save.nextId. */
export function uid(prefix = 'id') {
  uidCounter += 1;
  return `${prefix}${uidCounter.toString(36)}`;
}

export const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** Yard line label from offense perspective: 0..100 from own goal -> "OWN 25", "50", "OPP 30" */
export function yardLabel(fromOwnGoal) {
  const y = Math.round(fromOwnGoal);
  if (y === 50) return '50';
  return y < 50 ? `OWN ${y}` : `OPP ${100 - y}`;
}
