// Solenne Heat: every tuning number and colour in one place. The world is a real place with
// pixel coordinates (not a fixed playfield): a grid of city blocks separated by two-lane roads,
// drawn through a camera that follows the player. Nothing below depends on the window size.

/** The simulation's fixed step, in seconds: 60 updates a second whatever the display's rate. */
export const STEP = 1 / 60;

/** City geometry: square blocks of BLOCK px, roads of ROAD px between them, PITCH apart. */
export const CITY = {
  cols: 6,
  rows: 5,
  block: 256,
  road: 96,
};
CITY.pitch = CITY.block + CITY.road;
CITY.width = CITY.cols * CITY.pitch + CITY.road;
CITY.height = CITY.rows * CITY.pitch + CITY.road;

/** Sidewalk margin inside each block: buildings keep this far from the block's edge. */
export const SIDEWALK = 16;

export const PLAYER = {
  radius: 11,
  walkSpeed: 155,
  runSpeed: 255,
  maxHp: 100,
  meleeRange: 30,
  meleeDamage: 34,
  meleeCooldown: 0.38,
  shotCooldown: 0.26,
  shotDamage: 40,
  bustTime: 2.2,
};

export const CAR = {
  length: 46,
  width: 22,
  radius: 18,
  accel: 260,
  brake: 420,
  reverseMax: 90,
  drag: 0.6,
  grip: 3.4,
  hitDamage: 26,
};

/** Per-kind driving stats: top speed (px/s), acceleration scale, toughness. */
export const CAR_KINDS = {
  sedan: { topSpeed: 330, accelScale: 1.0, hp: 120, label: 'Sedan' },
  hatch: { topSpeed: 300, accelScale: 0.95, hp: 100, label: 'Hatchback' },
  sport: { topSpeed: 470, accelScale: 1.35, hp: 110, label: 'Sports coupe' },
  van: { topSpeed: 265, accelScale: 0.8, hp: 260, label: 'Armoured van' },
  taxi: { topSpeed: 320, accelScale: 1.0, hp: 120, label: 'Cab' },
  police: { topSpeed: 430, accelScale: 1.25, hp: 200, label: 'Interceptor' },
};

export const TRAFFIC = {
  cars: 14,
  peds: 26,
  cruiseSpeed: 128,
  junctionSlowdown: 62,
};

export const WANTED = {
  /** Heat at which each star lights: level = number of thresholds passed. */
  thresholds: [1, 45, 95, 155, 225],
  theft: 26,
  carjackMoving: 40,
  hitPed: 38,
  killPed: 55,
  shotFired: 9,
  hitPolice: 30,
  decayPerSecond: 7,
  hideSeconds: 3.5,
  /** Police cars the city fields at each star level. */
  policeCount: [0, 1, 2, 3, 4, 6],
};

export const PED = {
  radius: 10,
  walkSpeed: 62,
  fleeSpeed: 175,
  hp: 70,
  thugHp: 90,
  bossHp: 220,
  meleeDamage: 9,
  shotDamage: 8,
};

export const COLORS = {
  backdrop: '#0d0f14',
  asphalt: '#33363e',
  asphaltDark: '#2c2f36',
  laneMark: '#c8b45a',
  kerb: '#7d8189',
  harbor: {
    walk: '#5f6259',
    ground: '#49523f',
    buildings: ['#7a4a3a', '#5d6e7a', '#746a58', '#4f5e52', '#83604a', '#66505e'],
    roofs: ['#59392d', '#46545e', '#574e3e', '#3c4a41', '#644832', '#4c3c46'],
  },
  neon: {
    walk: '#55536e',
    ground: '#3b3f55',
    buildings: ['#4a3a6e', '#2e5e6e', '#6e2e4e', '#33507a', '#59386e', '#274b4f'],
    roofs: ['#382c54', '#224654', '#54223c', '#263e60', '#452a54', '#1d383c'],
  },
  player: '#f2c94c',
  playerShirt: '#2e6fb7',
  police: '#e8ecf2',
  policeTrim: '#2456a6',
  cash: '#57d977',
  ammo: '#f2994a',
  health: '#eb5757',
  marker: '#ffd23e',
  text: '#eef1f5',
  muted: '#9aa3b2',
  panel: 'rgba(16, 19, 26, 0.88)',
  danger: '#e5534b',
};

export const CAR_COLORS = ['#b03a2e', '#2e6fb7', '#27ae60', '#7d3c98', '#ca6f1e', '#aab7b8', '#5d6d7e', '#f39c12', '#16a085', '#884ea0'];

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** localStorage keys for the saved game and the mute preference. */
export const SAVE_KEY = 'solenne-heat.save';
export const MUTE_KEY = 'solenne-heat.muted';

export const GAME_TITLE = 'SOLENNE HEAT';
export const CITY_NAME = 'Port Solenne';
