// The screenshot scenes behind ?shot=start|chase|mission|roam. Each one stages the real game
// state — the same world, cars, crowds and missions a player gets — and main.js then runs the
// simulation forward for five seconds, so the frame is a moment the game itself produced and
// the same seed always gives the same frame.
import { SCREEN_PLAY, SCREEN_TITLE } from './render.js';
import { spawnCar } from './entities.js';

/** Put the player into a fresh car of `kind` at (x, y) facing `angle`, ready to be driven. */
function putPlayerInCar(G, x, y, angle, kind) {
  const car = spawnCar(G, x, y, angle, kind, 'mission');
  G.player.inCar = car;
  G.player.x = x;
  G.player.y = y;
  G.player.angle = angle;
  return car;
}

/**
 * Stage the named scene on a fresh game and return the screen to draw over it.
 * `ctx` is { G, missions } as built by main.js.
 */
export function stageShot(name, ctx) {
  const { G, missions } = ctx;
  const world = G.world;

  if (name === 'chase') {
    // Mid-pursuit on a harbour avenue: Rafe in a stolen sports coupe, three stars up.
    const roadIndex = 2;
    const y = world.laneCoord('h', roadIndex, 1);
    const x = world.vRoads[1] + 40;
    const car = putPlayerInCar(G, x, y, 0, 'sport');
    car.speed = 320;
    // Two interceptors already on the tail; updateWanted fields the third.
    const copA = spawnCar(G, x - 175, y, 0, 'police', 'police');
    copA.speed = 315;
    const copB = spawnCar(G, x - 330, y, 0, 'police', 'police');
    copB.speed = 305;
    G.wanted.heat = 120;
    G.wanted.level = 3;
    G.money = 640;
    G.toasts.push({ text: 'Lose the heat, then reach the hideout', t: 0, dur: 99 });
    return SCREEN_PLAY;
  }

  if (name === 'mission') {
    // The second job: Mara's package waits at the diner, the dock is waiting on it.
    missions.index = 1;
    missions.start(G);
    const diner = world.spots.diner;
    G.player.x = diner.x + 26;
    G.player.y = diner.y + 30;
    G.player.angle = Math.PI / 4;
    G.money = 150;
    return SCREEN_PLAY;
  }

  if (name === 'roam') {
    // Free roam in the Neon Mile after the story: a clean car, a full tank, no heat.
    const roadIndex = 1;
    const y = world.laneCoord('h', roadIndex, 1);
    const x = world.vRoads[3] + 30;
    const car = putPlayerInCar(G, x, y, 0, 'sedan');
    car.speed = 210;
    G.money = 2750;
    G.freeRoam = true;
    return SCREEN_PLAY;
  }

  // 'start' (and anything else): the title over the harbour streets at playerStart.
  return SCREEN_TITLE;
}

/**
 * Scripted driving for the staged scenes, called once per simulation step by main.js before
 * the entity updates: the player's car holds its lane and speed like a player mid-chase.
 * Other scenes stand still and need no driving.
 */
export function driveShot(name, G, dt) {
  if (name !== 'chase' && name !== 'roam') return;
  const car = G.player.inCar;
  if (!car) return;
  // Patrol the avenue end to end: turn around near the city limits so the staged
  // moment stays mid-city, where the camera can keep the car in frame.
  if (car.shotDir === undefined) car.shotDir = 1;
  if (car.shotDir > 0 && car.x > G.world.width - 300) {
    car.shotDir = -1;
    car.angle = Math.PI;
  } else if (car.shotDir < 0 && car.x < 300) {
    car.shotDir = 1;
    car.angle = 0;
  }
  const targetSpeed = name === 'chase' ? 330 : 215;
  car.speed += (targetSpeed - car.speed) * Math.min(1, dt * 2);
  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  // Keep the car on its road: settle back into the lane centre of the road it is on.
  const info = G.world.roadInfo(car.x, car.y);
  if (info && info.axis !== 'v') {
    const lane = G.world.laneCoord('h', info.axis === 'x' ? info.j : info.index, car.shotDir);
    car.y += (lane - car.y) * Math.min(1, dt * 3);
  }
  const [nx, ny] = G.world.collideCircle(car.x, car.y, 18);
  car.x = nx;
  car.y = ny;
  // The staged scenes skip updatePlayer, so nothing else resolves car-to-car overlap:
  // keep traffic from parking itself on top of the player's car.
  for (const other of G.cars) {
    if (other === car) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 37 * 37 && d2 > 0.01) {
      const d = Math.sqrt(d2);
      other.x = car.x + (dx / d) * 37;
      other.y = car.y + (dy / d) * 37;
    }
  }
  G.player.x = car.x;
  G.player.y = car.y;
  G.player.angle = car.angle;
}
