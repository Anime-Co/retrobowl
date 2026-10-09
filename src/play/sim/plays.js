// Assigned run/pass packages (MECHANICS 2.2): the game picks one play per down; the user can only
// re-roll it (changePlay). Each play = formation + WR/TE routes + RB run lane (which doubles as a
// checkdown/wheel route when passing). Also rolls the hidden defensive call (blitz, press).

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { alignOffense } from './formations.js';

const W = FIELD.W;
const Y_MIN = FIELD.INSET;
const Y_MAX = W - FIELD.INSET;
const X_MAX = FIELD.END_LINE - 1.5;

export const ROUTE_LABEL = {
  go: 'GO', fade: 'FADE', post: 'POST', corner: 'CORNER', curl: 'CURL', quick_in: 'Q-IN', quick_out: 'Q-OUT',
  deep_in: 'DIG', deep_out: 'OUT', slant: 'SLANT', flat: 'FLAT', out: 'OUT', seam: 'SEAM', drag: 'DRAG',
  checkdown: 'CHECK', wheel: 'WHEEL',
};
export const LANE_LABEL = { dive: 'DIVE', offtackle: 'OFF-TACKLE', sweep: 'SWEEP' };

function pickWeighted(rng, weights) {
  const keys = Object.keys(weights);
  return rng.weighted(keys, keys.map((k) => weights[k]));
}

function clampPt(p) {
  return { x: Math.min(p.x, X_MAX), y: clamp(p.y, Y_MIN, Y_MAX) };
}

/** Clamp to the field and drop near-duplicate consecutive points. */
export function cleanPath(points) {
  const out = [];
  for (const p of points) {
    const c = clampPt(p);
    const last = out[out.length - 1];
    if (!last || Math.hypot(c.x - last.x, c.y - last.y) > 0.5) out.push(c);
  }
  if (out.length === 1) out.push({ x: Math.min(out[0].x + 1, X_MAX + 0.01), y: out[0].y });
  return out;
}

/**
 * Build a route's waypoints (world coords, starting at the receiver's alignment).
 * @param {string} type route id (see ROUTE_LABEL)
 * @param {{x:number,y:number}} s alignment
 * @param {number} losX
 * @param {number} out +1/-1: the receiver's outside direction in world y
 * @param {import('../../core/rng.js').Rng} rng
 */
export function buildRoute(type, s, losX, out, rng) {
  const o = out;
  const i = -out;
  const d = (a, b) => losX + rng.float(a, b);
  let pts;
  switch (type) {
    case 'go':
      pts = [s, { x: losX + 6, y: s.y + o * 0.4 }, { x: losX + 48, y: s.y + o * 0.8 }];
      break;
    case 'fade':
      pts = [s, { x: losX + 3, y: s.y + o * 1.4 }, { x: losX + 48, y: s.y + o * 3 }];
      break;
    case 'post': {
      const cx = d(10, 12);
      pts = [s, { x: cx, y: s.y }, { x: cx + 17.3, y: s.y + i * 10 }, { x: cx + 34.6, y: s.y + i * 20 }];
      break;
    }
    case 'corner': {
      const cx = d(10, 12);
      pts = [s, { x: cx, y: s.y }, { x: cx + 17.3, y: s.y + o * 10 }, { x: cx + 30, y: s.y + o * 14 }];
      break;
    }
    case 'curl': {
      const cx = d(10, 12);
      pts = [s, { x: cx, y: s.y }, { x: cx - rng.float(3, 4), y: s.y + i * 1.0 }];
      break;
    }
    case 'quick_in': {
      const cx = d(5, 7);
      pts = [s, { x: cx, y: s.y }, { x: cx, y: s.y + i * 16 }];
      break;
    }
    case 'quick_out':
    case 'out': {
      const cx = type === 'out' ? d(5, 6) : d(5, 7);
      pts = [s, { x: cx, y: s.y }, { x: cx, y: s.y + o * 14 }];
      break;
    }
    case 'deep_in': {
      const cx = d(12, 15);
      pts = [s, { x: cx, y: s.y }, { x: cx, y: s.y + i * 18 }];
      break;
    }
    case 'deep_out': {
      const cx = d(12, 15);
      pts = [s, { x: cx, y: s.y }, { x: cx, y: s.y + o * 14 }];
      break;
    }
    case 'slant': {
      const cx = d(2, 3);
      pts = [s, { x: cx, y: s.y }, { x: cx + 14, y: s.y + i * 14 }];
      break;
    }
    case 'flat':
      pts = [s, { x: losX + 1.5, y: s.y + o * 4 }, { x: losX + 3, y: s.y + o * 8 }, { x: losX + 22, y: s.y + o * 9.5 }];
      break;
    case 'seam':
      pts = [s, { x: losX + 8, y: s.y + o * 0.6 }, { x: losX + 45, y: s.y + o * 1 }];
      break;
    case 'drag':
      pts = [s, { x: losX + 3, y: s.y + i * 2.5 }, { x: losX + 4.5, y: s.y + i * 22 }];
      break;
    case 'checkdown':
      pts = [s, { x: losX - 2.5, y: s.y + o * 3 }, { x: losX + 1.5, y: s.y + o * 8 }, { x: losX + 4.5, y: s.y + o * 10 }];
      break;
    case 'wheel':
      pts = [s, { x: losX - 1.5, y: s.y + o * 5 }, { x: losX + 1, y: s.y + o * 10 }, { x: losX + 8, y: s.y + o * 12.5 },
        { x: losX + 45, y: s.y + o * 13 }];
      break;
    default:
      pts = [s, { x: losX + 40, y: s.y }];
  }
  return cleanPath(pts);
}

/**
 * Designed RB run lane (handoff path). The first point is the mesh (handoff) point.
 * @param {'dive'|'offtackle'|'sweep'} type
 * @param {number} side +1/-1 world y direction of the run
 */
export function buildRunLane(type, side, losX, by, shotgun) {
  const R = TUNING.run;
  const md = shotgun ? R.meshDepthShotgun : R.meshDepthCenter;
  const s = side;
  let pts;
  if (type === 'dive') {
    pts = [{ x: losX - md, y: by + s * 0.6 }, { x: losX + 0.4, y: by + s * 0.8 }, { x: losX + 6, y: by + s * 1.2 },
      { x: losX + 30, y: by + s * 1.4 }];
  } else if (type === 'offtackle') {
    pts = [{ x: losX - md, y: by + s * 1.4 }, { x: losX + 0.4, y: by + s * 3.9 }, { x: losX + 6, y: by + s * 4.6 },
      { x: losX + 30, y: by + s * 5 }];
  } else {
    pts = [{ x: losX - md, y: by + s * 2.4 }, { x: losX - 2.6, y: by + s * 7.5 }, { x: losX + 0.8, y: by + s * 10.5 },
      { x: losX + 6, y: by + s * 11.5 }, { x: losX + 30, y: by + s * 12 }];
  }
  return cleanPath(pts);
}

/**
 * Roll the assigned play for this down.
 * @param {import('../../core/rng.js').Rng} rng
 * @param {number} losX
 * @param {number} by ball y
 */
export function rollPlay(rng, losX, by) {
  const F = TUNING.formation;
  const RT = TUNING.routes;
  const shotgun = rng.chance(F.shotgunChance);
  const mirror = rng.chance(0.5) ? 1 : -1;
  const form = {
    shotgun,
    mirror,
    wr1Split: rng.float(F.wrSplitMin, F.wrSplitMax),
    wr2Split: rng.float(F.wrSplitMin, F.wrSplitMax),
    wr2Slot: rng.chance(F.slotChance),
    te2Block: rng.chance(F.te2BlockChance),
  };
  const align = alignOffense(form, losX, by);
  const outOf = (p) => (p.y >= by ? 1 : -1);

  let r1 = pickWeighted(rng, RT.wrWeights);
  let r2 = pickWeighted(rng, RT.wrWeights);
  if (r1 === r2 && rng.chance(0.6)) r2 = pickWeighted(rng, RT.wrWeights);
  const routes = [
    { playerId: 'WR1', type: r1, points: buildRoute(r1, align.WR1, losX, outOf(align.WR1), rng) },
    { playerId: 'WR2', type: r2, points: buildRoute(r2, align.WR2, losX, outOf(align.WR2), rng) },
  ];
  let teRoute = null;
  if (!form.te2Block) {
    teRoute = pickWeighted(rng, RT.teWeights);
    routes.push({ playerId: 'TE2', type: teRoute, points: buildRoute(teRoute, align.TE2, losX, outOf(align.TE2), rng) });
  }

  // RB lane: dive / off-tackle / sweep, either side; pass route = checkdown or wheel to the lane side
  const laneType = rng.weighted(['dive', 'offtackle', 'sweep'], [4, 4, 3]);
  const laneSide = rng.chance(0.5) ? 1 : -1;
  const lanePts = buildRunLane(laneType, laneSide, losX, by, shotgun);
  const rbType = pickWeighted(rng, RT.rbWeights);
  const rbPts = buildRoute(rbType, align.RB, losX, laneSide, rng);
  routes.push({ playerId: 'RB', type: rbType, points: rbPts });

  const lr = laneType === 'dive' ? '' : laneSide > 0 ? ' R' : ' L';
  const name = `${shotgun ? 'GUN' : 'PRO'} ${LANE_LABEL[laneType]}${lr}: ${ROUTE_LABEL[r1]}/${ROUTE_LABEL[r2]}${teRoute ? `/${ROUTE_LABEL[teRoute]}` : ''}`;
  return {
    name,
    formation: shotgun ? 'shotgun' : 'center',
    qbDepth: shotgun ? F.qbDepthShotgun : F.qbDepthCenter,
    mirror,
    form,
    align,
    teBlocks: form.te2Block, // TE1 always blocks; true = TE2 blocks too
    routes,
    runLane: { type: laneType, side: laneSide, points: lanePts },
  };
}

/**
 * Hidden defensive call: press/off per corner, blitzers (MECHANICS 2.5: 1-3 LBs on ~35% of plays).
 * @param {import('../../core/rng.js').Rng} rng
 * @param {{down:number, toGo:number, losX:number}} ctx
 */
export function rollDefenseCall(rng, ctx, play) {
  const F = TUNING.formation;
  const R = TUNING.rush;
  let blitzP = R.blitzChance;
  if (ctx.down >= 3 && ctx.toGo >= 7) blitzP += 0.1;
  if (ctx.losX >= 100) blitzP += 0.05;
  const blitzers = [];
  if (rng.chance(blitzP)) {
    const n = 1 + rng.weightedIndex(R.blitzCountWeights);
    const pool = rng.shuffle(['LB1', 'LB2', 'LB3']);
    for (let i = 0; i < n; i++) blitzers.push(pool[i]);
  }
  return {
    mirror: play.mirror,
    te2Route: !play.teBlocks,
    press: [rng.chance(F.pressChance), rng.chance(F.pressChance)],
    cushion: [rng.float(F.cbCushionMin, F.cbCushionMax), rng.float(F.cbCushionMin, F.cbCushionMax)],
    blitzers,
  };
}
