// entities.js — everything that moves and everything that can hurt you in Port Solenne:
// the player (on foot and behind the wheel), traffic AI, pedestrians, police and the wanted
// system, bullets, particles and pickups. Pure simulation: no drawing, no DOM. The renderer
// reads the same objects this module writes.
//
// Shared conventions:
//   - Angles are radians, 0 = +x (east), positive clockwise (screen y grows downward).
//   - Speeds are px/s, distances px, times seconds. dt is the fixed STEP from config.js.
//   - world geometry comes from G.world (see world.js): junction(i, j) is the centre of the
//     crossing between vertical road i and horizontal road j; laneCoord(axis, index, dir)
//     gives the lane centre coordinate for travelling `dir` along that road.

import { PLAYER, CAR, CAR_KINDS, TRAFFIC, WANTED, PED, COLORS, CAR_COLORS, CITY } from './config.js';

// ---------------------------------------------------------------------------
// Small local helpers (kept unexported on purpose; the public surface is below)
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

function angleTo(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); }

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/** Turn `angle` toward `target` by at most maxStep radians. */
function turnToward(angle, target, maxStep) {
  const diff = wrapAngle(target - angle);
  if (diff > maxStep) return angle + maxStep;
  if (diff < -maxStep) return angle - maxStep;
  return target;
}

function randRange(G, lo, hi) { return lo + G.rand() * (hi - lo); }

function pick(G, arr) { return arr[Math.floor(G.rand() * arr.length) % arr.length]; }

// --- world geometry fallbacks ------------------------------------------------
// world.js provides junction/laneCoord; these wrappers tolerate either return
// shape ({x,y} or [x,y] or a bare number) and fall back to the CITY grid maths,
// which is exact for the layout config.js describes (road, block, road, ...).

function roadCentre(index) { return index * CITY.pitch + CITY.road / 2; }

function junctionAt(G, i, j) {
  const w = G.world;
  if (w && typeof w.junction === 'function') {
    const p = w.junction(i, j);
    if (Array.isArray(p)) return { x: p[0], y: p[1] };
    if (p && typeof p.x === 'number') return p;
  }
  return { x: roadCentre(i), y: roadCentre(j) };
}

/** Lane centre x for travelling dir (+1 south / -1 north) on vertical road i. */
function laneX(G, i, dir) {
  const w = G.world;
  if (w && typeof w.laneCoord === 'function') {
    const v = w.laneCoord('v', i, dir);
    if (typeof v === 'number') return v;
    if (v && typeof v.x === 'number') return v.x;
    if (Array.isArray(v)) return v[0];
  }
  // Right-hand traffic: southbound keeps west, northbound keeps east.
  return roadCentre(i) - dir * (CITY.road / 4);
}

/** Lane centre y for travelling dir (+1 east / -1 west) on horizontal road j. */
function laneY(G, j, dir) {
  const w = G.world;
  if (w && typeof w.laneCoord === 'function') {
    const v = w.laneCoord('h', j, dir);
    if (typeof v === 'number') return v;
    if (v && typeof v.y === 'number') return v.y;
    if (Array.isArray(v)) return v[1];
  }
  // Right-hand traffic: eastbound keeps south, westbound keeps north.
  return roadCentre(j) + dir * (CITY.road / 4);
}

function collide(G, x, y, r) {
  const w = G.world;
  if (w && typeof w.collideCircle === 'function') {
    const p = w.collideCircle(x, y, r);
    if (Array.isArray(p)) return p;
    if (p && typeof p.x === 'number') return [p.x, p.y];
  }
  return [x, y];
}

function blocked(G, x, y, r) {
  const w = G.world;
  if (w && typeof w.pointBlocked === 'function') return !!w.pointBlocked(x, y, r);
  return false;
}

// --- fx ----------------------------------------------------------------------

function spawnFx(G, x, y, vx, vy, dur, color, size, drag) {
  G.fx.push({ x, y, vx, vy, t: 0, dur, color, size, drag });
}

/** A little puff burst: n particles flying out at random angles. */
function burst(G, x, y, n, color, speed, size, dur) {
  for (let k = 0; k < n; k++) {
    const a = G.rand() * TAU;
    const s = speed * (0.3 + G.rand() * 0.7);
    spawnFx(G, x, y, Math.cos(a) * s, Math.sin(a) * s,
      dur * (0.6 + G.rand() * 0.7), color, size * (0.7 + G.rand() * 0.6), 3.2);
  }
}

function smokePuff(G, x, y) {
  spawnFx(G, x + randRange(G, -6, 6), y - 6, randRange(G, -8, 8), randRange(G, -34, -18),
    randRange(G, 0.7, 1.3), '#5a5f6a', randRange(G, 4, 8), 1.1);
}

// ---------------------------------------------------------------------------
// Wanted level
// ---------------------------------------------------------------------------

function levelForHeat(heat) {
  let level = 0;
  for (let i = 0; i < WANTED.thresholds.length; i++) {
    if (heat >= WANTED.thresholds[i]) level = i + 1;
  }
  return level;
}

/**
 * Register a crime at (x, y). Heat always counts; being *seen* is what stops the
 * wanted level decaying: if any standing ped or any police car is within 260 px,
 * the hide timer resets and the crime is remembered for nearby peds to flee from.
 */
export function addCrime(G, heat, x, y) {
  if (x === undefined) { x = G.player.x; y = G.player.y; }
  G.wanted.heat += heat;
  G.wanted.level = levelForHeat(G.wanted.heat);
  G.crimeFlash = 1;
  let seen = false;
  const R2 = 260 * 260;
  for (let i = 0; i < G.peds.length; i++) {
    const p = G.peds[i];
    if (p.state !== 'down' && dist2(x, y, p.x, p.y) < R2) { seen = true; break; }
  }
  if (!seen) {
    for (let i = 0; i < G.cars.length; i++) {
      const c = G.cars[i];
      if (c.role === 'police' && dist2(x, y, c.x, c.y) < R2) { seen = true; break; }
    }
  }
  if (seen) {
    G.wanted.hide = 0;
    if (!G.lastCrime) G.lastCrime = { x: 0, y: 0, t: -99 };
    G.lastCrime.x = x; G.lastCrime.y = y; G.lastCrime.t = G.time;
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const PARKED_KINDS = ['sedan', 'hatch', 'taxi', 'sport'];
const TRAFFIC_KINDS = ['sedan', 'hatch', 'taxi', 'sport', 'van'];
const PED_SHIRTS = ['#c0392b', '#2471a3', '#229954', '#b7950b', '#7d3c98', '#ba4a00', '#117a65', '#616a6b'];
const PED_SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];

export function spawnCar(G, x, y, angle, kind, role) {
  const stats = CAR_KINDS[kind] || CAR_KINDS.sedan;
  const car = {
    x, y, angle: angle || 0, speed: 0,
    kind: CAR_KINDS[kind] ? kind : 'sedan',
    color: role === 'police' ? COLORS.police : pick(G, CAR_COLORS),
    hp: stats.hp, maxHp: stats.hp,
    role: role || 'parked',
    route: null,
    siren: G.rand() * TAU,
    stuck: 0, honk: randRange(G, 1, 4),
    smokeT: 0, crimeCd: 0, hitCd: 0,
  };
  G.cars.push(car);
  return car;
}

export function spawnPickup(G, x, y, kind, amount) {
  const pickup = { x, y, kind, amount, t: G.rand() * TAU, fixed: null };
  G.pickups.push(pickup);
  return pickup;
}

export function spawnThug(G, x, y, kind) {
  const hp = kind === 'boss' ? PED.bossHp : (kind === 'shooter' ? PED.hp + 20 : PED.thugHp);
  const ped = {
    x, y, angle: randRange(G, 0, TAU), hp, maxHp: hp,
    state: 'hostile', kind,
    color: pick(G, PED_SKIN),
    shirt: kind === 'boss' ? '#641e16' : pick(G, PED_SHIRTS),
    target: null, fleeT: 0, attackCd: randRange(G, 0.2, 0.6),
    shootCd: randRange(G, 0.5, 1.2), wanderT: randRange(G, 1, 3),
    threatX: 0, threatY: 0, strafeDir: G.rand() < 0.5 ? -1 : 1, fadeT: 20,
  };
  G.peds.push(ped);
  return ped;
}

function spawnCivilian(G, x, y) {
  const ped = {
    x, y, angle: randRange(G, 0, TAU), hp: PED.hp, maxHp: PED.hp,
    state: 'walk', kind: 'civil',
    color: pick(G, PED_SKIN), shirt: pick(G, PED_SHIRTS),
    target: null, fleeT: 0, attackCd: 0, shootCd: 0,
    wanderT: randRange(G, 0.5, 2.5),
    threatX: 0, threatY: 0, strafeDir: 1, fadeT: 20,
  };
  G.peds.push(ped);
  return ped;
}

/** The nearest car to (x, y) within maxDist, or null. */
export function nearestCar(G, x, y, maxDist) {
  let best = null, bestD2 = maxDist * maxDist;
  for (let i = 0; i < G.cars.length; i++) {
    const c = G.cars[i];
    const d2 = dist2(x, y, c.x, c.y);
    if (d2 < bestD2) { bestD2 = d2; best = c; }
  }
  return best;
}

// --- traffic routes ----------------------------------------------------------
// A route is one leg of a journey: travel along road `index` on axis `axis` in
// direction `dir` until the junction with the crossing road (junctionJ on a
// vertical leg, junctionI on a horizontal one), steering for (targetX, targetY)
// — the junction centre pulled sideways into the correct lane.

function setLegTarget(G, car) {
  const r = car.route;
  if (r.axis === 'v') {
    const j = junctionAt(G, r.index, r.junctionJ);
    r.targetX = laneX(G, r.index, r.dir);
    r.targetY = j.y;
  } else {
    const j = junctionAt(G, r.junctionI, r.index);
    r.targetX = j.x;
    r.targetY = laneY(G, r.index, r.dir);
  }
}

function makeRoute(G, car) {
  // Snap the car to the nearest road and aim it at the next junction ahead.
  const vIdx = clamp(Math.round((car.x - CITY.road / 2) / CITY.pitch), 0, CITY.cols);
  const hIdx = clamp(Math.round((car.y - CITY.road / 2) / CITY.pitch), 0, CITY.rows);
  const onV = Math.abs(car.x - roadCentre(vIdx)) <= Math.abs(car.y - roadCentre(hIdx));
  const dir = G.rand() < 0.5 ? -1 : 1;
  if (onV) {
    let j = clamp(Math.round((car.y - CITY.road / 2) / CITY.pitch) + dir, 0, CITY.rows);
    car.route = { axis: 'v', index: vIdx, dir, junctionI: vIdx, junctionJ: j };
    car.x = laneX(G, vIdx, dir);
    car.angle = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    let i = clamp(Math.round((car.x - CITY.road / 2) / CITY.pitch) + dir, 0, CITY.cols);
    car.route = { axis: 'h', index: hIdx, dir, junctionI: i, junctionJ: hIdx };
    car.y = laneY(G, hIdx, dir);
    car.angle = dir > 0 ? 0 : Math.PI;
  }
  setLegTarget(G, car);
}

/** Choose the next leg at a junction: mostly straight, sometimes a turn, almost never a U-turn. */
function advanceRoute(G, car) {
  const r = car.route;
  const roll = G.rand();
  if (r.axis === 'v') {
    const atJ = r.junctionJ;
    const nextJ = atJ + r.dir;
    const canStraight = nextJ >= 0 && nextJ <= CITY.rows;
    if (roll < 0.62 && canStraight) {
      r.junctionJ = nextJ; // straight on
    } else if (roll < 0.97) {
      // Turn onto the horizontal road we just crossed.
      let nd = G.rand() < 0.5 ? -1 : 1;
      let nextI = r.index + nd;
      if (nextI < 0 || nextI > CITY.cols) { nd = -nd; nextI = r.index + nd; }
      r.axis = 'h'; r.junctionJ = r.index; r.index = atJ; r.dir = nd; r.junctionI = nextI;
    } else if (canStraight) {
      r.junctionJ = nextJ; // the rare "U-turn" degrades to straight at a junction
    } else {
      r.dir = -r.dir; r.junctionJ = atJ + r.dir; // dead end of the grid: turn back
    }
  } else {
    const atI = r.junctionI;
    const nextI = atI + r.dir;
    const canStraight = nextI >= 0 && nextI <= CITY.cols;
    if (roll < 0.62 && canStraight) {
      r.junctionI = nextI;
    } else if (roll < 0.97) {
      let nd = G.rand() < 0.5 ? -1 : 1;
      let nextJ = r.index + nd;
      if (nextJ < 0 || nextJ > CITY.rows) { nd = -nd; nextJ = r.index + nd; }
      r.axis = 'v'; r.junctionI = r.index; r.index = atI; r.dir = nd; r.junctionJ = nextJ;
    } else if (canStraight) {
      r.junctionI = nextI;
    } else {
      r.dir = -r.dir; r.junctionI = atI + r.dir;
    }
  }
  setLegTarget(G, car);
}

// --- fixed pickup spots --------------------------------------------------------

function spotPoint(G, name, fallbackBlock) {
  const w = G.world;
  const spots = w && w.spots;
  let p = null;
  if (spots) {
    if (Array.isArray(spots)) {
      for (let i = 0; i < spots.length; i++) {
        if (spots[i].name === name || spots[i].id === name || spots[i].kind === name) { p = spots[i]; break; }
      }
    } else {
      p = spots[name] || null;
      if (!p && name === 'neonPlaza') p = spots.neon || spots.plaza || null;
    }
  }
  if (p) {
    if (Array.isArray(p)) return { x: p[0], y: p[1] };
    if (typeof p.x === 'number') return { x: p.x, y: p.y };
  }
  // Fallback: the centre of a named-ish block, settled out of any building.
  const bx = CITY.road + fallbackBlock[0] * CITY.pitch + CITY.block / 2;
  const by = CITY.road + fallbackBlock[1] * CITY.pitch + CITY.block / 2;
  const s = collide(G, bx, by, 10);
  return { x: s[0], y: s[1] };
}

/** Populate the world: parked cars, moving traffic, pedestrians, fixed pickups. */
export function spawnWorld(G) {
  if (!G.fixedPickups) G.fixedPickups = [];
  if (!G.lastShot) G.lastShot = { x: 0, y: 0, t: -99 };
  if (!G.lastCrime) G.lastCrime = { x: 0, y: 0, t: -99 };

  const w = G.world;
  const parking = (w && Array.isArray(w.parking)) ? w.parking : [];

  if (parking.length > 0) {
    for (let i = 0; i < parking.length; i++) {
      const s = parking[i];
      const kind = s.kind && CAR_KINDS[s.kind] ? s.kind : pick(G, PARKED_KINDS);
      spawnCar(G, s.x, s.y, s.angle || s.rot || 0, kind, 'parked');
    }
  } else {
    // No parking layout supplied: line a dozen cars along random block edges.
    for (let i = 0; i < 12; i++) {
      const col = Math.floor(G.rand() * CITY.cols);
      const row = Math.floor(G.rand() * CITY.rows);
      const bx = CITY.road + col * CITY.pitch;
      const by = CITY.road + row * CITY.pitch;
      const along = randRange(G, 30, CITY.block - 30);
      const horiz = G.rand() < 0.5;
      const x = horiz ? bx + along : bx + 12;
      const y = horiz ? by + 12 : by + along;
      spawnCar(G, x, y, horiz ? 0 : Math.PI / 2, pick(G, PARKED_KINDS), 'parked');
    }
  }

  // Moving traffic on random roads, already routed.
  for (let i = 0; i < TRAFFIC.cars; i++) {
    let x, y;
    if (G.rand() < 0.5) {
      const idx = Math.floor(G.rand() * (CITY.cols + 1));
      x = roadCentre(idx);
      y = randRange(G, 40, CITY.height - 40);
    } else {
      const idx = Math.floor(G.rand() * (CITY.rows + 1));
      x = randRange(G, 40, CITY.width - 40);
      y = roadCentre(idx);
    }
    const car = spawnCar(G, x, y, 0, pick(G, TRAFFIC_KINDS), 'traffic');
    makeRoute(G, car);
    car.speed = TRAFFIC.cruiseSpeed * randRange(G, 0.7, 1);
  }

  // Pedestrians on sidewalks: points just inside random block edges.
  for (let i = 0; i < TRAFFIC.peds; i++) {
    let x = 0, y = 0;
    for (let tries = 0; tries < 8; tries++) {
      const col = Math.floor(G.rand() * CITY.cols);
      const row = Math.floor(G.rand() * CITY.rows);
      const bx = CITY.road + col * CITY.pitch;
      const by = CITY.road + row * CITY.pitch;
      const inset = randRange(G, 18, 30);
      const along = randRange(G, 16, CITY.block - 16);
      const edge = Math.floor(G.rand() * 4);
      if (edge === 0) { x = bx + along; y = by + inset; }
      else if (edge === 1) { x = bx + along; y = by + CITY.block - inset; }
      else if (edge === 2) { x = bx + inset; y = by + along; }
      else { x = bx + CITY.block - inset; y = by + along; }
      const s = collide(G, x, y, PED.radius);
      x = s[0]; y = s[1];
      if (!blocked(G, x, y, PED.radius)) break;
    }
    spawnCivilian(G, x, y);
  }

  // Fixed pickups: ammo at the precinct and Neon Plaza, health at the hospital and diner.
  const fixedDefs = [
    { spot: 'precinct', kind: 'ammo', amount: 24, block: [0, 0] },
    { spot: 'neonPlaza', kind: 'ammo', amount: 24, block: [CITY.cols - 1, 0] },
    { spot: 'hospital', kind: 'health', amount: 40, block: [0, CITY.rows - 1] },
    { spot: 'diner', kind: 'health', amount: 40, block: [CITY.cols - 1, CITY.rows - 1] },
  ];
  for (let i = 0; i < fixedDefs.length; i++) {
    const d = fixedDefs[i];
    const pt = spotPoint(G, d.spot, d.block);
    const entry = { spot: d.spot, x: pt.x, y: pt.y, kind: d.kind, amount: d.amount, timer: 0, pickup: null };
    entry.pickup = spawnPickup(G, pt.x, pt.y, d.kind, d.amount);
    entry.pickup.fixed = entry;
    G.fixedPickups.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Shared damage / collision helpers
// ---------------------------------------------------------------------------

function noteShot(G, x, y) {
  if (!G.lastShot) G.lastShot = { x: 0, y: 0, t: -99 };
  G.lastShot.x = x; G.lastShot.y = y; G.lastShot.t = G.time;
}

function fireBullet(G, x, y, angle, from, dmg, speed) {
  G.bullets.push({
    x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    from, dmg, life: 0.9,
  });
  noteShot(G, x, y);
}

/** Put a ped down for good: drop loot for criminal kinds, register the kill crime. */
function downPed(G, ped, byPlayer) {
  if (ped.state === 'down') return;
  ped.state = 'down';
  ped.fadeT = 20;
  ped.hp = 0;
  if (ped.kind === 'thug' || ped.kind === 'shooter' || ped.kind === 'boss') {
    const amount = ped.kind === 'boss' ? Math.floor(randRange(G, 60, 120)) : Math.floor(randRange(G, 10, 40));
    spawnPickup(G, ped.x + randRange(G, -8, 8), ped.y + randRange(G, -8, 8), 'cash', amount);
  }
  burst(G, ped.x, ped.y, 5, '#c0392b', 60, 2.5, 0.4);
  // The victim is already 'down', so addCrime's witness scan counts bystanders only.
  if (byPlayer) addCrime(G, WANTED.killPed, ped.x, ped.y);
}

function damagePed(G, ped, dmg, byPlayer, threatX, threatY) {
  if (ped.state === 'down') return;
  ped.hp -= dmg;
  if (ped.hp <= 0) { downPed(G, ped, byPlayer); return; }
  if (ped.kind === 'civil') {
    ped.state = 'flee';
    ped.fleeT = randRange(G, 1.6, 2.6);
    ped.threatX = threatX; ped.threatY = threatY;
  } else if (ped.state !== 'hostile' && ped.state !== 'shooter') {
    ped.state = 'hostile';
  }
}

/**
 * Circle-vs-circle between two cars: push them apart and, if they were closing,
 * trade damage for impact speed. Returns the impact speed (0 if not closing).
 */
function collideCarPair(G, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const minD = CAR.radius * 2;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD || d2 < 0.01) return 0;
  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const push = (minD - d) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  const avx = Math.cos(a.angle) * a.speed, avy = Math.sin(a.angle) * a.speed;
  const bvx = Math.cos(b.angle) * b.speed, bvy = Math.sin(b.angle) * b.speed;
  const closing = (avx - bvx) * nx + (avy - bvy) * ny; // > 0 means approaching
  if (closing <= 30) return 0;
  // Two ambient traffic cars brushing at a junction is a fender-bender, not a crash:
  // they separate and check their speed, but the city's traffic must not wreck itself.
  if (a.role === 'traffic' && b.role === 'traffic' && closing <= 260) {
    a.speed *= 0.8; b.speed *= 0.8;
    return closing;
  }
  // Damage lands once per contact, not every frame the circles stay overlapped:
  // without the cooldown, two cars grinding through a junction wreck in a second.
  if (a.hitCd > 0 || b.hitCd > 0) return 0;
  a.hitCd = 0.5; b.hitCd = 0.5;
  const dmg = closing * 0.14;
  a.hp -= dmg; b.hp -= dmg;
  a.speed *= 0.55; b.speed *= 0.55;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  burst(G, mx, my, 6, '#f5c542', 110, 2.5, 0.35);
  if (G.audio && G.audio.hit) G.audio.hit(clamp(closing / 320, 0.15, 1));
  const playerCar = G.player.inCar;
  if (playerCar && (a === playerCar || b === playerCar)) {
    G.shake = Math.min(14, G.shake + closing * 0.02);
    if (closing > 260) G.player.hp -= (closing - 260) * 0.05 + 4;
    const other = a === playerCar ? b : a;
    if (other.role === 'police' && other.crimeCd <= 0) {
      addCrime(G, WANTED.hitPolice, other.x, other.y);
      other.crimeCd = 1.2;
    }
  }
  return closing;
}

/** A moving car meets a pedestrian. Only fast hits connect (slow nudges just push). */
function carHitsPed(G, car, ped) {
  if (ped.state === 'down') return;
  const minD = CAR.radius + PED.radius - 4;
  if (dist2(car.x, car.y, ped.x, ped.y) >= minD * minD) return;
  const speed = Math.abs(car.speed);
  if (speed <= 60) {
    // Gentle shove out of the way, no harm done.
    const a = angleTo(car.x, car.y, ped.x, ped.y);
    ped.x = car.x + Math.cos(a) * minD;
    ped.y = car.y + Math.sin(a) * minD;
    return;
  }
  const wasAlive = ped.hp > 0;
  ped.hp -= CAR.hitDamage + speed * 0.06;
  burst(G, ped.x, ped.y, 5, '#c0392b', 70, 2.5, 0.4);
  if (G.audio && G.audio.hit) G.audio.hit(clamp(speed / 300, 0.2, 0.9));
  if (ped.hp <= 0) {
    downPed(G, ped, car === G.player.inCar);
    if (car === G.player.inCar && wasAlive) {
      // downPed already filed killPed; nothing more to add.
    }
  } else {
    ped.state = 'flee';
    ped.fleeT = 2.2;
    ped.threatX = car.x; ped.threatY = car.y;
    if (car === G.player.inCar) addCrime(G, WANTED.hitPed, ped.x, ped.y);
  }
  // The car barely notices, but loses a little speed.
  car.speed *= 0.92;
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

function enterCar(G, car) {
  const p = G.player;
  const wasRole = car.role;
  p.inCar = car;
  p.x = car.x; p.y = car.y; p.angle = car.angle;
  p.bust = 0;
  if (wasRole === 'parked') {
    addCrime(G, WANTED.theft, car.x, car.y);
  } else if (wasRole === 'traffic') {
    addCrime(G, WANTED.carjackMoving, car.x, car.y);
  } else if (wasRole === 'police') {
    addCrime(G, WANTED.theft, car.x, car.y);
  }
  if (G.audio && G.audio.pickup) G.audio.pickup();
}

function exitCar(G, car) {
  const p = G.player;
  const side = CAR.radius + PLAYER.radius + 6;
  const candidates = [
    [car.x + Math.cos(car.angle + Math.PI / 2) * side, car.y + Math.sin(car.angle + Math.PI / 2) * side],
    [car.x + Math.cos(car.angle - Math.PI / 2) * side, car.y + Math.sin(car.angle - Math.PI / 2) * side],
    [car.x + Math.cos(car.angle + Math.PI * 0.75) * side, car.y + Math.sin(car.angle + Math.PI * 0.75) * side],
    [car.x + Math.cos(car.angle - Math.PI * 0.75) * side, car.y + Math.sin(car.angle - Math.PI * 0.75) * side],
    [car.x - Math.cos(car.angle) * side, car.y - Math.sin(car.angle) * side],
  ];
  let placed = false;
  for (let i = 0; i < candidates.length; i++) {
    const cx = candidates[i][0], cy = candidates[i][1];
    if (blocked(G, cx, cy, PLAYER.radius)) continue;
    let inCarToo = false;
    for (let j = 0; j < G.cars.length; j++) {
      const o = G.cars[j];
      if (o !== car && dist2(cx, cy, o.x, o.y) < (CAR.radius + PLAYER.radius - 2) * (CAR.radius + PLAYER.radius - 2)) { inCarToo = true; break; }
    }
    if (inCarToo) continue;
    const s = collide(G, cx, cy, PLAYER.radius);
    p.x = s[0]; p.y = s[1];
    placed = true;
    break;
  }
  if (!placed) {
    const s = collide(G, car.x + side, car.y, PLAYER.radius);
    p.x = s[0]; p.y = s[1];
  }
  p.inCar = null;
  if (car.role === 'traffic') car.role = 'parked'; // driverless now: it stays where it was left
  if (car.role === 'traffic') car.route = null;
}

function playerCombat(G, dt) {
  const p = G.player;
  const input = G.input;
  if (p.attackCd > 0) p.attackCd -= dt;
  if (!input.attack() || p.attackCd > 0) return;

  const mouseWX = input.mouse.x + G.cam.x;
  const mouseWY = input.mouse.y + G.cam.y;

  if (p.weapon === 'pistol' && p.ammo > 0) {
    const a = Math.atan2(mouseWY - p.y, mouseWX - p.x) + randRange(G, -0.045, 0.045);
    fireBullet(G, p.x + Math.cos(a) * 14, p.y + Math.sin(a) * 14, a, 'player', PLAYER.shotDamage, 640);
    p.ammo -= 1;
    p.attackCd = PLAYER.shotCooldown;
    p.angle = a;
    if (G.audio && G.audio.shot) G.audio.shot();
    spawnFx(G, p.x + Math.cos(a) * 18, p.y + Math.sin(a) * 18, Math.cos(a) * 40, Math.sin(a) * 40, 0.07, '#ffd23e', 4, 2);
    addCrime(G, WANTED.shotFired, p.x, p.y); // heat always; hide resets only if witnessed (inside addCrime)
  } else {
    // Fist (or an empty pistol swung like one): nearest ped or car in the facing cone.
    p.attackCd = PLAYER.meleeCooldown;
    if (G.audio && G.audio.melee) G.audio.melee();
    let bestPed = null, bestD2 = (PLAYER.meleeRange + PED.radius) * (PLAYER.meleeRange + PED.radius);
    for (let i = 0; i < G.peds.length; i++) {
      const ped = G.peds[i];
      if (ped.state === 'down') continue;
      const d2 = dist2(p.x, p.y, ped.x, ped.y);
      if (d2 >= bestD2) continue;
      const diff = Math.abs(wrapAngle(angleTo(p.x, p.y, ped.x, ped.y) - p.angle));
      if (diff > 1.15) continue;
      bestD2 = d2; bestPed = ped;
    }
    if (bestPed) {
      damagePed(G, bestPed, PLAYER.meleeDamage, true, p.x, p.y);
      burst(G, bestPed.x, bestPed.y, 3, '#e8ecf2', 60, 2, 0.25);
      return;
    }
    // No ped in reach: thump the nearest car panel instead.
    const car = nearestCar(G, p.x, p.y, PLAYER.meleeRange + CAR.radius);
    if (car) {
      const diff = Math.abs(wrapAngle(angleTo(p.x, p.y, car.x, car.y) - p.angle));
      if (diff < 1.3) {
        car.hp -= 6;
        burst(G, car.x + (p.x - car.x) * 0.5, car.y + (p.y - car.y) * 0.5, 4, '#f5c542', 90, 2, 0.3);
        if (G.audio && G.audio.hit) G.audio.hit(0.25);
        if (car.role === 'police' && car.crimeCd <= 0) {
          addCrime(G, WANTED.hitPolice, car.x, car.y);
          car.crimeCd = 1.2;
        }
      }
    }
  }
}

function drivePlayerCar(G, dt) {
  const p = G.player;
  const car = p.inCar;
  const input = G.input;
  const stats = CAR_KINDS[car.kind] || CAR_KINDS.sedan;

  const throttle = -input.axisY(); // up (axisY -1) = forward
  const steering = input.axisX();

  if (throttle > 0) {
    car.speed += CAR.accel * stats.accelScale * throttle * dt;
  } else if (throttle < 0) {
    if (car.speed > 12) car.speed -= CAR.brake * dt; // braking
    else car.speed += CAR.accel * 0.6 * throttle * dt; // reversing
  }
  car.speed -= car.speed * CAR.drag * dt;
  if (throttle === 0) car.speed -= car.speed * 0.8 * dt; // engine braking / rolling resistance
  car.speed = clamp(car.speed, -CAR.reverseMax, stats.topSpeed);
  if (Math.abs(car.speed) < 2 && throttle === 0) car.speed = 0;

  // Steering authority grows with speed; reversing flips it, as in a real car.
  car.angle = wrapAngle(car.angle + steering * CAR.grip * dt * clamp(car.speed / stats.topSpeed, -1, 1));

  const prevX = car.x, prevY = car.y;
  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  car.x = clamp(car.x, CAR.radius, (G.world ? G.world.width : CITY.width) - CAR.radius);
  car.y = clamp(car.y, CAR.radius, (G.world ? G.world.height : CITY.height) - CAR.radius);

  // Buildings: collideCircle pushes the car out; the correction size is the impact.
  const s = collide(G, car.x, car.y, CAR.radius);
  const corrX = s[0] - car.x, corrY = s[1] - car.y;
  const corr = Math.hypot(corrX, corrY);
  car.x = s[0]; car.y = s[1];
  if (corr > 1.5 && Math.abs(car.speed) > 40) {
    const impact = Math.abs(car.speed);
    car.hp -= impact * 0.09;
    burst(G, car.x, car.y, 7, '#f5c542', 130, 2.5, 0.35);
    if (G.audio && G.audio.hit) G.audio.hit(clamp(impact / 320, 0.2, 1));
    G.shake = Math.min(14, G.shake + impact * 0.02);
    if (impact > 260) p.hp -= (impact - 260) * 0.05 + 4;
    car.speed *= -0.25; // bounce back
  } else if (corr > 1.5) {
    car.speed *= 0.4;
  }
  void prevX; void prevY;

  // Other cars, then pedestrians.
  for (let i = 0; i < G.cars.length; i++) {
    const other = G.cars[i];
    if (other !== car) collideCarPair(G, car, other);
  }
  for (let i = 0; i < G.peds.length; i++) carHitsPed(G, car, G.peds[i]);

  p.x = car.x; p.y = car.y; p.angle = car.angle;
  return Math.abs(car.speed);
}

export function updatePlayer(G, dt) {
  const p = G.player;
  const input = G.input;
  if (p.attackCd > 0 && p.inCar) p.attackCd -= dt; // on-foot decrement lives in playerCombat
  G.prompt = '';

  const enterPressed = !!G.enterPressed;
  G.enterPressed = false;

  let playerSpeed = 0;

  if (p.inCar) {
    const car = p.inCar;
    if (car.hp <= 0) {
      // A wreck will not drive: it just rolls to a stop, and then he can climb out.
      car.speed -= car.speed * 3 * dt;
      if (Math.abs(car.speed) < 4) car.speed = 0;
      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;
      p.x = car.x; p.y = car.y;
      playerSpeed = Math.abs(car.speed);
    } else {
      playerSpeed = drivePlayerCar(G, dt);
    }
    if (enterPressed && Math.abs(car.speed) < 30) {
      exitCar(G, car);
    } else if (Math.abs(car.speed) < 30) {
      G.prompt = 'Press E to exit';
    }
  } else {
    // --- on foot -------------------------------------------------------------
    const ax = input.axisX();
    const ay = input.axisY();
    const moving = ax !== 0 || ay !== 0;
    const speed = input.run() ? PLAYER.runSpeed : PLAYER.walkSpeed;
    let vx = 0, vy = 0;
    if (moving) {
      const inv = 1 / Math.hypot(ax, ay);
      vx = ax * inv; vy = ay * inv;
      p.x += vx * speed * dt;
      p.y += vy * speed * dt;
      playerSpeed = speed;
    }
    const s = collide(G, p.x, p.y, PLAYER.radius);
    p.x = clamp(s[0], PLAYER.radius, (G.world ? G.world.width : CITY.width) - PLAYER.radius);
    p.y = clamp(s[1], PLAYER.radius, (G.world ? G.world.height : CITY.height) - PLAYER.radius);

    // Cars are solid: push the player out of any overlap.
    for (let i = 0; i < G.cars.length; i++) {
      const c = G.cars[i];
      const minD = PLAYER.radius + CAR.radius;
      const d2 = dist2(p.x, p.y, c.x, c.y);
      if (d2 < minD * minD && d2 > 0.01) {
        const d = Math.sqrt(d2);
        p.x = c.x + (p.x - c.x) / d * minD;
        p.y = c.y + (p.y - c.y) / d * minD;
      }
    }

    // Facing: the mouse while attacking, otherwise the way we walk.
    if (input.attack()) {
      p.angle = Math.atan2(input.mouse.y + G.cam.y - p.y, input.mouse.x + G.cam.x - p.x);
    } else if (moving) {
      p.angle = Math.atan2(vy, vx);
    }

    playerCombat(G, dt);

    // Entering a car.
    const near = nearestCar(G, p.x, p.y, 46);
    if (near) {
      const label = (CAR_KINDS[near.kind] || CAR_KINDS.sedan).label;
      const enterable = near.role !== 'traffic' || Math.abs(near.speed) < 20;
      if (enterable) {
        G.prompt = 'Press E to enter the ' + label;
        if (enterPressed) enterCar(G, near);
      } else {
        G.prompt = 'Too fast to jack — block it first';
      }
    }
  }

  // --- bust ------------------------------------------------------------------
  let copNear = false;
  if (G.wanted.level > 0 || p.bust > 0) {
    for (let i = 0; i < G.cars.length; i++) {
      const c = G.cars[i];
      if (c.role === 'police' && c.hp > 0 && dist2(p.x, p.y, c.x, c.y) < 74 * 74) { copNear = true; break; }
    }
  }
  if (copNear && playerSpeed < 46) {
    p.bust += dt / PLAYER.bustTime;
  } else {
    p.bust = Math.max(0, p.bust - dt * 1.4);
  }
  if (p.bust >= 1) { p.bust = 1; if (!G.dead) G.dead = 'busted'; }
  if (p.hp <= 0) { p.hp = 0; if (!G.dead) G.dead = 'wasted'; }
}

// ---------------------------------------------------------------------------
// Cars: traffic AI and police
// ---------------------------------------------------------------------------

/** Speed a traffic car should hold back to because something is ahead of it. */
function obstacleSpeedAhead(G, car) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let limit = Infinity;
  for (let i = 0; i < G.cars.length; i++) {
    const o = G.cars[i];
    if (o === car) continue;
    // Parked cars sit at the kerb, half in the lane's edge: traffic streams past them
    // rather than queueing behind a car that will never move.
    if (o.role === 'parked') continue;
    const rx = o.x - car.x, ry = o.y - car.y;
    const ahead = rx * fx + ry * fy;
    if (ahead <= 0 || ahead >= 56) continue;
    const lateral = Math.abs(-rx * fy + ry * fx);
    if (lateral >= 22) continue;
    limit = Math.min(limit, ahead < 34 ? 0 : Math.abs(o.speed));
  }
  // The player on foot is an obstacle too; traffic would rather not run him down.
  const p = G.player;
  if (!p.inCar) {
    const rx = p.x - car.x, ry = p.y - car.y;
    const ahead = rx * fx + ry * fy;
    if (ahead > 0 && ahead < 56 && Math.abs(-rx * fy + ry * fx) < 22) {
      limit = Math.min(limit, ahead < 34 ? 0 : 40);
    }
  }
  for (let i = 0; i < G.peds.length; i++) {
    const ped = G.peds[i];
    if (ped.state === 'down') continue;
    const rx = ped.x - car.x, ry = ped.y - car.y;
    const ahead = rx * fx + ry * fy;
    if (ahead > 0 && ahead < 50 && Math.abs(-rx * fy + ry * fx) < 20) {
      limit = Math.min(limit, 0);
    }
  }
  return limit;
}

function updateTrafficCar(G, car, dt) {
  if (!car.route) makeRoute(G, car);
  const r = car.route;
  const stats = CAR_KINDS[car.kind] || CAR_KINDS.sedan;

  // Steer for the leg target, staying centred on the lane as we go.
  const desired = angleTo(car.x, car.y, r.targetX, r.targetY);
  car.angle = wrapAngle(turnToward(car.angle, desired, 2.8 * dt));
  if (r.axis === 'v') {
    const lx = laneX(G, r.index, r.dir);
    car.x += (lx - car.x) * Math.min(1, dt * 3);
  } else {
    const ly = laneY(G, r.index, r.dir);
    car.y += (ly - car.y) * Math.min(1, dt * 3);
  }

  const distToTarget = Math.hypot(r.targetX - car.x, r.targetY - car.y);
  let want = TRAFFIC.cruiseSpeed;
  if (distToTarget < 95) want = Math.min(want, TRAFFIC.junctionSlowdown + distToTarget * 0.5);
  const obstacle = obstacleSpeedAhead(G, car);
  if (obstacle < want) {
    want = obstacle;
    if (obstacle === 0 && car.honk <= 0 && Math.abs(car.speed) > 10) {
      if (G.audio && G.audio.honk) G.audio.honk();
      car.honk = randRange(G, 2.5, 5);
    }
  }

  // Accelerate / brake toward the wanted speed.
  const accel = CAR.accel * stats.accelScale * 0.55;
  if (car.speed < want) car.speed = Math.min(want, car.speed + accel * dt);
  else car.speed = Math.max(want, car.speed - CAR.brake * 0.7 * dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  const s = collide(G, car.x, car.y, CAR.radius);
  car.x = s[0]; car.y = s[1];

  // Stuck detection: wanting to move but not moving means the lane is hopeless — reroute.
  if (want > 30 && Math.abs(car.speed) < 6) {
    car.stuck += dt;
    if (car.stuck > 3) { car.stuck = 0; advanceRoute(G, car); }
  } else {
    car.stuck = Math.max(0, car.stuck - dt);
  }

  if (distToTarget < 30) advanceRoute(G, car);
}

function updatePoliceCar(G, car, dt) {
  const p = G.player;
  const stats = CAR_KINDS.police;
  car.siren += dt * 7;

  if (G.wanted.level === 0) {
    // Stand down: roll to the nearest junction and, once far away, leave the world.
    const i = clamp(Math.round((car.x - CITY.road / 2) / CITY.pitch), 0, CITY.cols);
    const j = clamp(Math.round((car.y - CITY.road / 2) / CITY.pitch), 0, CITY.rows);
    const home = junctionAt(G, i, j);
    const desired = angleTo(car.x, car.y, home.x, home.y);
    car.angle = wrapAngle(turnToward(car.angle, desired, 2.6 * dt));
    const d = Math.hypot(home.x - car.x, home.y - car.y);
    const want = d > 30 ? TRAFFIC.cruiseSpeed : 0;
    if (car.speed < want) car.speed = Math.min(want, car.speed + CAR.accel * dt);
    else car.speed = Math.max(want, car.speed - CAR.brake * dt);
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    const s = collide(G, car.x, car.y, CAR.radius);
    car.x = s[0]; car.y = s[1];
    return dist2(car.x, car.y, p.x, p.y) > 700 * 700; // true => despawn me
  }

  // Pursuit: aim a little ahead of wherever the player is heading.
  let tx = p.x, ty = p.y;
  if (p.inCar) {
    tx += Math.cos(p.inCar.angle) * p.inCar.speed * 0.35;
    ty += Math.sin(p.inCar.angle) * p.inCar.speed * 0.35;
  }
  const distToPlayer = Math.hypot(p.x - car.x, p.y - car.y);
  const desired = angleTo(car.x, car.y, tx, ty);
  car.angle = wrapAngle(turnToward(car.angle, desired, 3.1 * dt));

  let want = stats.topSpeed;
  if (!p.inCar) {
    // On foot the law stops beside the player and makes the arrest — it does not mow him down.
    if (distToPlayer < 54) want = 0;
    else if (distToPlayer < 110) want = 120;
  } else if (distToPlayer < 40) {
    want = Math.abs(p.inCar.speed); // sit on his bumper and shove
  }
  const accel = CAR.accel * stats.accelScale;
  if (car.speed < want) car.speed = Math.min(want, car.speed + accel * dt);
  else car.speed = Math.max(want, car.speed - CAR.brake * dt);
  car.speed = clamp(car.speed, -CAR.reverseMax, stats.topSpeed);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  const s = collide(G, car.x, car.y, CAR.radius);
  const corr = Math.hypot(s[0] - car.x, s[1] - car.y);
  car.x = s[0]; car.y = s[1];
  if (corr > 1.5 && Math.abs(car.speed) > 60) {
    car.hp -= Math.abs(car.speed) * 0.06;
    car.speed *= -0.2;
  }

  if (want > 40 && Math.abs(car.speed) < 8) {
    car.stuck += dt;
    if (car.stuck > 2.5) { car.stuck = 0; car.speed = -CAR.reverseMax * 0.7; } // back out and try again
  } else {
    car.stuck = Math.max(0, car.stuck - dt);
  }
  return false;
}

export function updateCars(G, dt) {
  const playerCar = G.player.inCar;
  for (let i = G.cars.length - 1; i >= 0; i--) {
    const car = G.cars[i];
    if (car.crimeCd > 0) car.crimeCd -= dt;
    if (car.honk > 0) car.honk -= dt;
    if (car.hitCd > 0) car.hitCd -= dt;

    // Wrecks smoke and go nowhere, whoever used to drive them.
    if (car.hp <= 0) {
      car.hp = 0;
      car.speed -= car.speed * 3 * dt;
      if (Math.abs(car.speed) < 4) car.speed = 0;
      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;
      car.smokeT -= dt;
      if (car.smokeT <= 0) { car.smokeT = randRange(G, 0.12, 0.3); smokePuff(G, car.x, car.y); }
      continue;
    }

    if (car === playerCar) {
      // Driven in updatePlayer; only the smoke check above applies here.
      continue;
    }

    if (car.role === 'police') {
      const despawn = updatePoliceCar(G, car, dt);
      if (despawn) { G.cars.splice(i, 1); continue; }
    } else if (car.role === 'traffic') {
      updateTrafficCar(G, car, dt);
    } else {
      // Parked / mission cars sit still; a nudge can still roll them a touch.
      car.speed -= car.speed * 4 * dt;
      if (Math.abs(car.speed) < 2) car.speed = 0;
      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;
    }
  }

  // Non-player car pairs: the player's own collisions ran in updatePlayer.
  for (let i = 0; i < G.cars.length; i++) {
    const a = G.cars[i];
    if (a === playerCar) continue;
    for (let j = i + 1; j < G.cars.length; j++) {
      const b = G.cars[j];
      if (b === playerCar) continue;
      collideCarPair(G, a, b);
    }
  }
  // Moving traffic and police can still hit pedestrians.
  for (let i = 0; i < G.cars.length; i++) {
    const car = G.cars[i];
    if (car === playerCar || Math.abs(car.speed) <= 60) continue;
    for (let j = 0; j < G.peds.length; j++) carHitsPed(G, car, G.peds[j]);
  }
}

// ---------------------------------------------------------------------------
// Pedestrians
// ---------------------------------------------------------------------------

/** A fresh sidewalk target: a point just inside a nearby block edge. */
function pickWalkTarget(G, ped) {
  for (let tries = 0; tries < 6; tries++) {
    const col = clamp(Math.floor(ped.x / CITY.pitch) + Math.floor(randRange(G, -1, 2)), 0, CITY.cols - 1);
    const row = clamp(Math.floor(ped.y / CITY.pitch) + Math.floor(randRange(G, -1, 2)), 0, CITY.rows - 1);
    const bx = CITY.road + col * CITY.pitch;
    const by = CITY.road + row * CITY.pitch;
    const inset = randRange(G, 18, 30);
    const along = randRange(G, 16, CITY.block - 16);
    const edge = Math.floor(G.rand() * 4);
    let x, y;
    if (edge === 0) { x = bx + along; y = by + inset; }
    else if (edge === 1) { x = bx + along; y = by + CITY.block - inset; }
    else if (edge === 2) { x = bx + inset; y = by + along; }
    else { x = bx + CITY.block - inset; y = by + along; }
    if (!blocked(G, x, y, PED.radius)) {
      if (!ped.target) ped.target = { x: 0, y: 0 };
      ped.target.x = x; ped.target.y = y;
      return;
    }
  }
}

function movePed(G, ped, tx, ty, speed, dt) {
  const dx = tx - ped.x, dy = ty - ped.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return d;
  ped.angle = Math.atan2(dy, dx);
  ped.x += (dx / d) * speed * dt;
  ped.y += (dy / d) * speed * dt;
  const s = collide(G, ped.x, ped.y, PED.radius);
  ped.x = s[0]; ped.y = s[1];
  return d;
}

function pedThreatened(G, ped) {
  // A gunshot in the last second, close by.
  if (G.lastShot && G.time - G.lastShot.t < 1 && dist2(ped.x, ped.y, G.lastShot.x, G.lastShot.y) < 300 * 300) {
    return [G.lastShot.x, G.lastShot.y];
  }
  // A witnessed crime right here.
  if (G.lastCrime && G.time - G.lastCrime.t < 1 && dist2(ped.x, ped.y, G.lastCrime.x, G.lastCrime.y) < 260 * 260) {
    return [G.lastCrime.x, G.lastCrime.y];
  }
  // A fast car bearing down.
  for (let i = 0; i < G.cars.length; i++) {
    const c = G.cars[i];
    if (Math.abs(c.speed) > 120 && dist2(ped.x, ped.y, c.x, c.y) < 70 * 70) return [c.x, c.y];
  }
  return null;
}

export function updatePeds(G, dt) {
  const p = G.player;
  for (let i = G.peds.length - 1; i >= 0; i--) {
    const ped = G.peds[i];
    if (ped.attackCd > 0) ped.attackCd -= dt;
    if (ped.shootCd > 0) ped.shootCd -= dt;
    if (ped.wanderT > 0) ped.wanderT -= dt;

    if (ped.state === 'down') {
      ped.fadeT -= dt;
      if (ped.fadeT <= 0) G.peds.splice(i, 1);
      continue;
    }
    if (ped.hp <= 0) { downPed(G, ped, false); continue; }

    if (ped.kind === 'civil' && ped.state === 'walk') {
      const threat = pedThreatened(G, ped);
      if (threat) {
        ped.state = 'flee';
        ped.fleeT = randRange(G, 1.8, 3);
        ped.threatX = threat[0]; ped.threatY = threat[1];
      }
    }

    if (ped.state === 'flee') {
      ped.fleeT -= dt;
      const away = angleTo(ped.threatX, ped.threatY, ped.x, ped.y);
      movePed(G, ped, ped.x + Math.cos(away) * 200, ped.y + Math.sin(away) * 200, PED.fleeSpeed, dt);
      if (ped.fleeT <= 0) {
        ped.state = ped.kind === 'civil' ? 'walk' : 'hostile';
        ped.target = null;
      }
    } else if (ped.state === 'walk') {
      if (!ped.target || ped.wanderT <= 0) {
        pickWalkTarget(G, ped);
        ped.wanderT = randRange(G, 4, 9);
      }
      if (ped.target) {
        const d = movePed(G, ped, ped.target.x, ped.target.y, PED.walkSpeed, dt);
        if (d < 9) { ped.target = null; ped.wanderT = randRange(G, 0.4, 1.6); }
      }
    } else if (ped.state === 'hostile' || ped.state === 'shooter') {
      const isShooter = ped.kind === 'shooter' || ped.kind === 'boss';
      const targetObj = p.inCar || p;
      const d = Math.hypot(targetObj.x - ped.x, targetObj.y - ped.y);

      if (isShooter) {
        // Keep the 130–170 px pocket, strafing slowly while the gun cycles.
        if (d > 170) {
          movePed(G, ped, p.x, p.y, PED.walkSpeed * 1.5, dt);
        } else if (d < 130) {
          const away = angleTo(p.x, p.y, ped.x, ped.y);
          movePed(G, ped, ped.x + Math.cos(away) * 60, ped.y + Math.sin(away) * 60, PED.walkSpeed * 1.3, dt);
        } else {
          if (ped.wanderT <= 0) { ped.strafeDir = -ped.strafeDir; ped.wanderT = randRange(G, 1, 2.4); }
          const perp = angleTo(ped.x, ped.y, p.x, p.y) + Math.PI / 2 * ped.strafeDir;
          movePed(G, ped, ped.x + Math.cos(perp) * 40, ped.y + Math.sin(perp) * 40, PED.walkSpeed * 0.55, dt);
          ped.angle = angleTo(ped.x, ped.y, p.x, p.y);
        }
        if (ped.shootCd <= 0 && d < 340 && !G.dead) {
          // Cheap line-of-sight: a blocked midpoint means a building is in the way.
          const midX = (ped.x + p.x) / 2, midY = (ped.y + p.y) / 2;
          if (!blocked(G, midX, midY, 4)) {
            const a = angleTo(ped.x, ped.y, p.x, p.y) + randRange(G, -0.09, 0.09);
            fireBullet(G, ped.x + Math.cos(a) * 13, ped.y + Math.sin(a) * 13, a, 'npc', PED.shotDamage, 560);
            if (G.audio && G.audio.shot) G.audio.shot();
            ped.shootCd = randRange(G, 1.1, 1.8);
          } else {
            ped.shootCd = 0.3;
          }
        }
      } else {
        // Melee thug: straight at the player (or at his car, which soaks the hits).
        if (p.inCar) {
          movePed(G, ped, p.inCar.x, p.inCar.y, PED.walkSpeed * 1.7, dt);
          if (d < CAR.radius + 16 && ped.attackCd <= 0) {
            ped.attackCd = 0.8;
            p.inCar.hp -= PED.meleeDamage * 0.5;
            burst(G, p.inCar.x + (ped.x - p.inCar.x) * 0.6, p.inCar.y + (ped.y - p.inCar.y) * 0.6, 3, '#f5c542', 70, 2, 0.25);
            if (G.audio && G.audio.hit) G.audio.hit(0.2);
          }
        } else {
          movePed(G, ped, p.x, p.y, PED.walkSpeed * 1.7, dt);
          if (d < 26 + PED.radius && ped.attackCd <= 0 && !G.dead) {
            ped.attackCd = 0.75;
            p.hp -= PED.meleeDamage;
            G.hurtFlash = 1;
            if (G.audio && G.audio.hurt) G.audio.hurt();
            burst(G, p.x, p.y, 3, '#e5534b', 60, 2, 0.25);
          }
        }
      }
    }

    // Light separation so crowds do not stack into one sprite.
    for (let j = 0; j < G.peds.length; j++) {
      if (j === i) continue;
      const o = G.peds[j];
      if (o.state === 'down') continue;
      const d2 = dist2(ped.x, ped.y, o.x, o.y);
      const minD = PED.radius * 2;
      if (d2 < minD * minD && d2 > 0.01) {
        const d = Math.sqrt(d2);
        ped.x += (ped.x - o.x) / d * (minD - d) * 0.5;
        ped.y += (ped.y - o.y) / d * (minD - d) * 0.5;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bullets, fx, pickups
// ---------------------------------------------------------------------------

export function updateBullets(G, dt) {
  const p = G.player;
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const b = G.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead && blocked(G, b.x, b.y, 2)) {
      burst(G, b.x, b.y, 3, '#f5c542', 80, 1.8, 0.25);
      dead = true;
    }
    if (!dead && (b.x < 0 || b.y < 0 || b.x > (G.world ? G.world.width : CITY.width) || b.y > (G.world ? G.world.height : CITY.height))) {
      dead = true;
    }

    if (!dead && b.from === 'player') {
      // Peds first, then cars.
      for (let j = 0; j < G.peds.length; j++) {
        const ped = G.peds[j];
        if (ped.state === 'down') continue;
        if (dist2(b.x, b.y, ped.x, ped.y) < (PED.radius + 3) * (PED.radius + 3)) {
          damagePed(G, ped, b.dmg, true, p.x, p.y);
          dead = true;
          break;
        }
      }
      if (!dead) {
        for (let j = 0; j < G.cars.length; j++) {
          const car = G.cars[j];
          if (dist2(b.x, b.y, car.x, car.y) < (CAR.radius + 3) * (CAR.radius + 3)) {
            car.hp -= b.dmg;
            burst(G, b.x, b.y, 4, '#f5c542', 100, 2, 0.3);
            if (car.role === 'police' && car.crimeCd <= 0) {
              addCrime(G, WANTED.hitPolice, car.x, car.y);
              car.crimeCd = 1.2;
            }
            dead = true;
            break;
          }
        }
      }
    } else if (!dead && b.from === 'npc') {
      if (p.inCar) {
        const car = p.inCar;
        if (dist2(b.x, b.y, car.x, car.y) < (CAR.radius + 3) * (CAR.radius + 3)) {
          car.hp -= b.dmg * 0.6; // the car soaks it; a wrecked car stops protecting (handled by exit pressure)
          if (car.hp <= 0 && G.rand() < 0.25) { p.hp -= b.dmg * 0.5; G.hurtFlash = 1; }
          burst(G, b.x, b.y, 3, '#f5c542', 90, 2, 0.25);
          dead = true;
        }
      } else if (dist2(b.x, b.y, p.x, p.y) < (PLAYER.radius + 3) * (PLAYER.radius + 3)) {
        p.hp -= b.dmg;
        G.hurtFlash = 1;
        if (G.audio && G.audio.hurt) G.audio.hurt();
        burst(G, p.x, p.y, 3, '#e5534b', 60, 2, 0.25);
        dead = true;
      }
    }

    if (dead) G.bullets.splice(i, 1);
  }
}

export function updateFx(G, dt) {
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    f.t += dt;
    if (f.t >= f.dur) { G.fx.splice(i, 1); continue; }
    const dragF = Math.max(0, 1 - f.drag * dt);
    f.vx *= dragF; f.vy *= dragF;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
  }
}

export function updatePickups(G, dt) {
  const p = G.player;
  for (let i = G.pickups.length - 1; i >= 0; i--) {
    const pk = G.pickups[i];
    pk.t += dt;
    if (p.inCar) continue;
    if (dist2(p.x, p.y, pk.x, pk.y) >= 20 * 20) continue;
    if (pk.kind === 'cash') {
      G.money += pk.amount;
      if (G.audio && G.audio.cash) G.audio.cash();
    } else if (pk.kind === 'ammo') {
      p.ammo += pk.amount;
      if (G.audio && G.audio.pickup) G.audio.pickup();
    } else if (pk.kind === 'health') {
      p.hp = Math.min(p.maxHp, p.hp + pk.amount);
      if (G.audio && G.audio.pickup) G.audio.pickup();
    }
    if (pk.fixed) { pk.fixed.pickup = null; pk.fixed.timer = 20; }
    G.pickups.splice(i, 1);
  }
  // Fixed spots restock 20 s after they are taken.
  if (G.fixedPickups) {
    for (let i = 0; i < G.fixedPickups.length; i++) {
      const entry = G.fixedPickups[i];
      if (entry.pickup) continue;
      entry.timer -= dt;
      if (entry.timer <= 0) {
        entry.pickup = spawnPickup(G, entry.x, entry.y, entry.kind, entry.amount);
        entry.pickup.fixed = entry;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The wanted system: decay while hidden, and keeping the police strength honest
// ---------------------------------------------------------------------------

export function updateWanted(G, dt) {
  const p = G.player;
  const w = G.wanted;

  if (w.level > 0) {
    let seen = false;
    for (let i = 0; i < G.cars.length; i++) {
      const c = G.cars[i];
      if (c.role === 'police' && c.hp > 0 && dist2(p.x, p.y, c.x, c.y) < 420 * 420) { seen = true; break; }
    }
    if (!seen) {
      for (let i = 0; i < G.peds.length; i++) {
        const ped = G.peds[i];
        if (ped.state !== 'down' && dist2(p.x, p.y, ped.x, ped.y) < 200 * 200) { seen = true; break; }
      }
    }
    if (seen) w.hide = 0;
    else {
      w.hide += dt;
      if (w.hide > WANTED.hideSeconds && w.heat > 0) {
        w.heat = Math.max(0, w.heat - WANTED.decayPerSecond * dt);
        w.level = levelForHeat(w.heat);
      }
    }
  } else {
    w.hide = 0;
    if (w.heat > 0) { w.heat = 0; }
  }

  // Field the right number of interceptors for the current level.
  const want = WANTED.policeCount[w.level] || 0;
  let have = 0;
  for (let i = 0; i < G.cars.length; i++) if (G.cars[i].role === 'police') have++;
  let guard = 0;
  while (have < want && guard < 4) {
    guard++;
    // Spawn on a junction lane 480–620 px out: close enough to matter, never on top of the player.
    let placed = false;
    for (let tries = 0; tries < 8 && !placed; tries++) {
      const a = G.rand() * TAU;
      const d = randRange(G, 480, 620);
      const sx = p.x + Math.cos(a) * d;
      const sy = p.y + Math.sin(a) * d;
      const ii = clamp(Math.round((sx - CITY.road / 2) / CITY.pitch), 0, CITY.cols);
      const jj = clamp(Math.round((sy - CITY.road / 2) / CITY.pitch), 0, CITY.rows);
      const home = junctionAt(G, ii, jj);
      const dd = Math.hypot(home.x - p.x, home.y - p.y);
      if (dd < 380 || dd > 760) continue;
      const dir = G.rand() < 0.5 ? -1 : 1;
      const car = spawnCar(G, laneX(G, ii, dir), home.y, dir > 0 ? Math.PI / 2 : -Math.PI / 2, 'police', 'police');
      car.speed = TRAFFIC.cruiseSpeed;
      have++;
      placed = true;
    }
    if (!placed) break;
  }

  // Siren audibility is main.js's call (it owns the audio loop); we just report it.
  G.sirenOn = false;
  for (let i = 0; i < G.cars.length; i++) {
    const c = G.cars[i];
    if (c.role === 'police' && c.hp > 0 && dist2(p.x, p.y, c.x, c.y) < 700 * 700) { G.sirenOn = true; break; }
  }
}
