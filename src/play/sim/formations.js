// Alignments for every play kind. Pure functions returning world positions (yards, offense frame).
//   scrimmage: 11 v 11 = QB, RB, WR1, WR2, TE1, TE2, OL1..OL5 (OL3 = centre) vs
//              DL1..DL4, LB1..LB3, DB1..DB4 (DB1/DB2 corners on WR1/WR2, DB3 strong safety, DB4 free safety)
//   fg / pat:  K, H (holder) + line vs an 11-man rush
//   kick_return: KR + 10 return blockers vs 10 coverage + K

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';

const W = FIELD.W;
const yIn = (y, pad = FIELD.INSET + 0.8) => clamp(y, pad, W - pad);
const xCap = (x) => Math.min(x, FIELD.END_LINE - 1.5);

/** Slot ids in a stable order. */
export const OFF_SLOTS = ['QB', 'RB', 'WR1', 'WR2', 'TE1', 'TE2', 'OL1', 'OL2', 'OL3', 'OL4', 'OL5'];
export const DEF_SLOTS = ['DL1', 'DL2', 'DL3', 'DL4', 'LB1', 'LB2', 'LB3', 'DB1', 'DB2', 'DB3', 'DB4'];

/**
 * Offensive alignment for a play's formation choices.
 * @param {{shotgun:boolean, mirror:number, wr1Split:number, wr2Split:number, wr2Slot:boolean, te2Block:boolean}} f
 * @param {number} losX
 * @param {number} by ball y
 */
export function alignOffense(f, losX, by) {
  const F = TUNING.formation;
  const m = f.mirror;
  const a = {};
  for (let i = 0; i < 5; i++) {
    a[`OL${i + 1}`] = { x: losX - F.olDepth - (i === 2 ? -0.1 : 0), y: by + (i - 2) * F.olSpacing };
  }
  a.QB = { x: losX - (f.shotgun ? F.qbDepthShotgun : F.qbDepthCenter), y: by };
  a.RB = f.shotgun
    ? { x: losX - F.rbDepthShotgun, y: by - m * F.rbOffsetShotgun }
    : { x: losX - F.rbDepthCenter, y: by };
  a.TE1 = { x: losX - 0.9, y: by + m * F.teInline };
  a.TE2 = f.te2Block ? { x: losX - 0.9, y: by - m * F.teInline } : { x: losX - 1.3, y: by - m * 7.6 };
  a.WR1 = { x: losX - 0.8, y: by - m * f.wr1Split };
  a.WR2 = f.wr2Slot ? { x: losX - 1.3, y: by + m * 8.6 } : { x: losX - 0.8, y: by + m * f.wr2Split };
  for (const k of Object.keys(a)) a[k].y = yIn(a[k].y);
  // keep receivers from stacking on top of each other near a sideline
  if (Math.abs(a.TE2.y - a.WR1.y) < 2.5) a.TE2.y = yIn(a.WR1.y + m * 3);
  if (Math.abs(a.WR2.y - a.TE1.y) < 2.5) a.WR2.y = yIn(a.TE1.y + m * 3);
  return a;
}

/**
 * Defensive alignment vs an offensive alignment.
 * @param {object} off alignOffense() result
 * @param {{press:boolean[], cushion:number[], mirror:number, te2Route:boolean}} call
 */
export function alignDefense(off, losX, by, call) {
  const F = TUNING.formation;
  const m = call.mirror;
  const d = {};
  const dx = (depth) => xCap(losX + depth);
  d.DL1 = { x: dx(F.dlDepth), y: by - 4.3 };
  d.DL2 = { x: dx(F.dlDepth), y: by - 1.2 };
  d.DL3 = { x: dx(F.dlDepth), y: by + 1.2 };
  d.DL4 = { x: dx(F.dlDepth), y: by + 4.3 };
  d.LB1 = { x: dx(F.lbDepth), y: by };
  d.LB2 = { x: dx(F.lbDepth - 0.3), y: by - 4.9 };
  d.LB3 = { x: dx(F.lbDepth - 0.3), y: by + 4.9 };
  const cb = (wr, i) => {
    const inside = Math.sign(by - wr.y) || 1;
    const depth = call.press[i] ? 1.5 : call.cushion[i];
    return { x: dx(depth), y: wr.y + inside * 0.6 };
  };
  d.DB1 = cb(off.WR1, 0);
  d.DB2 = cb(off.WR2, 1);
  d.DB3 = call.te2Route ? { x: dx(6.5), y: off.TE2.y + (Math.sign(by - off.TE2.y) || 1) * 0.8 } : { x: dx(F.ssDepth), y: by + m * 5 };
  d.DB4 = { x: dx(F.fsDepth), y: by - m * 1.5 };
  for (const k of Object.keys(d)) d[k].y = yIn(d[k].y);
  return d;
}

/** FG / PAT alignment. Kick spot = (losX - holdDepth, by). */
export function alignKick(losX, by) {
  const K = TUNING.kick;
  const sx = losX - K.holdDepth;
  const off = {
    H: { x: sx + 0.15, y: by - 0.9 },
    K: { x: sx - 2.4, y: by - 1.8 },
    OL1: { x: losX - 0.7, y: by - 3.0 }, OL2: { x: losX - 0.7, y: by - 1.5 }, OL3: { x: losX - 0.6, y: by },
    OL4: { x: losX - 0.7, y: by + 1.5 }, OL5: { x: losX - 0.7, y: by + 3.0 },
    TE1: { x: losX - 0.9, y: by + 4.5 }, TE2: { x: losX - 0.9, y: by - 4.5 },
    WR1: { x: losX - 1.7, y: by - 5.7 }, WR2: { x: losX - 1.7, y: by + 5.7 },
  };
  const def = {
    DL1: { x: losX + 0.9, y: by - 2.2 }, DL2: { x: losX + 0.9, y: by - 0.7 }, DL3: { x: losX + 0.9, y: by + 0.7 },
    DL4: { x: losX + 0.9, y: by + 2.2 },
    LB1: { x: losX + 1.0, y: by - 3.8 }, LB2: { x: losX + 1.0, y: by + 3.8 }, LB3: { x: losX + 2.5, y: by },
    DB1: { x: losX + 1.2, y: by - 6.2 }, DB2: { x: losX + 1.2, y: by + 6.2 },
    DB3: { x: xCap(losX + 8), y: by - 6 }, DB4: { x: xCap(losX + 8), y: by + 6 },
  };
  for (const g of [off, def]) for (const k of Object.keys(g)) g[k].y = yIn(g[k].y, 1);
  return { off, def, spot: { x: sx, y: by } };
}

/**
 * Kickoff (opponent kicks, user returns). Coverage lines up at the kick line (x=75) attacking -x.
 * Returner slot 'KR', blockers 'RB1'..'RB10' (return blockers), coverage 'CV1'..'CV10' + 'K'.
 */
export function alignKickoff() {
  const KO = TUNING.kickoff;
  const off = { KR: { x: KO.returnerX, y: W / 2 } };
  // front line of 5 near midfield, second wave of 3, two deep blockers
  const front = [-16, -8, 0, 8, 16];
  front.forEach((dy, i) => { off[`RB${i + 1}`] = { x: 58, y: W / 2 + dy }; });
  [-10, 0, 10].forEach((dy, i) => { off[`RB${i + 6}`] = { x: 42, y: W / 2 + dy }; });
  [-5, 5].forEach((dy, i) => { off[`RB${i + 9}`] = { x: 24, y: W / 2 + dy }; });
  const def = { K: { x: KO.kickX + 6, y: W / 2 } };
  for (let i = 0; i < 10; i++) {
    const lane = i < 5 ? i : i + 1; // leave the middle lane for the kicker
    def[`CV${i + 1}`] = { x: KO.kickX + 1, y: 3 + (lane * (W - 6)) / 10 };
  }
  return { off, def };
}
