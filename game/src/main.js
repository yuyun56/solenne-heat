// Solenne Heat: boot and the one loop. The world advances in fixed 1/60 s steps (several in a
// slow frame, none in a fast one); input, missions, wanted and rendering hang off the step.
// Screens: title, play, paused, busted, wasted, failed (mission), win (story complete).
//
// ?seed=N fixes the city's random layout. ?shot=start|chase|mission|roam (with &seed=N) stages
// that scene instead of running the loop, paints it twice and sets window.__shotReady.
import { MUTE_KEY, PLAYER, SAVE_KEY, STEP } from './config.js';
import { createRandom } from './random.js';
import { createWorld } from './world.js';
import { createAudio } from './audio.js';
import { ACTION_CONFIRM, ACTION_CONTINUE, ACTION_ENTER, ACTION_MUTE, ACTION_PAUSE, createInput } from './input.js';
import {
  spawnWorld, updateBullets, updateCars, updateFx, updatePeds, updatePickups, updatePlayer, updateWanted,
} from './entities.js';
import { createMissions } from './missions.js';
import {
  createRenderer, SCREEN_BUSTED, SCREEN_FAILED, SCREEN_PAUSED, SCREEN_PLAY, SCREEN_TITLE, SCREEN_WASTED, SCREEN_WIN,
} from './render.js';
import { driveShot, stageShot } from './shots.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped, not replayed. */
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');

/** Read the saved game, if any: { money, index, weapon, ammo, freeRoam } written on mission completion. */
function readSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.index !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // Storage can be off (private windows): progress then lasts this visit only.
  }
}

function readMuted() {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** A fresh game context: every system reads and writes this one object. */
function createGame(saved) {
  const rand = createRandom(seed);
  const world = createWorld(rand);
  const start = world.spots.playerStart;
  const G = {
    rand,
    world,
    audio: createAudio(),
    input: null, // set by runGame / runShot below
    time: 0,
    player: {
      x: start.x, y: start.y, angle: -Math.PI / 2, hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      inCar: null, weapon: 'fist', ammo: 0, attackCd: 0, bust: 0,
    },
    cars: [],
    peds: [],
    bullets: [],
    fx: [],
    pickups: [],
    missionFoes: [],
    wanted: { heat: 0, level: 0, hide: 0 },
    money: 0,
    cam: { x: 0, y: 0 },
    canvasW: 1280,
    canvasH: 720,
    shake: 0,
    dialogue: [],
    toasts: [],
    prompt: '',
    dead: '',
    crimeFlash: 0,
    hurtFlash: 0,
    freeRoam: false,
    missionCompleteFlag: false,
    missionFailed: '',
    failReason: '',
    lastShot: { x: 0, y: 0, t: -10 },
    sirenOn: false,
    enterPressed: false,
    hasSave: Boolean(saved),
    saveSummary: '',
  };
  spawnWorld(G);
  const missions = createMissions();
  if (saved) {
    G.money = Math.max(0, saved.money | 0);
    if (saved.weapon === 'pistol') G.player.weapon = 'pistol';
    G.player.ammo = Math.max(0, saved.ammo | 0);
    missions.restore(G, saved.index, Boolean(saved.freeRoam));
    G.saveSummary = saved.freeRoam
      ? 'Story complete — free roam'
      : `Mission ${Math.min(saved.index + 1, 6)} of 6 · $${G.money}`;
  }
  return { G, missions };
}

function runShot(name) {
  const { G, missions } = createGame(null);
  G.input = createInput(canvas);
  const renderer = createRenderer(canvas);
  const screen = stageShot(name, { G, missions });
  // Let the staged scene live for a few seconds of simulation so traffic rolls and the
  // police close in; driveShot applies the scene's scripted driving, if any.
  for (let index = 0; index < 300; index += 1) {
    G.time += STEP;
    driveShot(name, G, STEP);
    updateCars(G, STEP);
    updatePeds(G, STEP);
    updateBullets(G, STEP);
    updateFx(G, STEP);
    updateWanted(G, STEP);
    ageMessages(G, STEP);
  }
  // One warm-up paint so the renderer reports the true canvas size before the camera snaps.
  renderer.draw(G, screen, missions.current(G));
  snapCamera(G, missions, screen);
  const mission = missions.current(G);
  let painted = 0;
  function paint() {
    renderer.draw(G, screen, mission);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

/** Dialogue and toast ageing, shared by the live loop and the staged scenes. */
function ageMessages(G, dt) {
  if (G.dialogue.length > 0) {
    const line = G.dialogue[0];
    line.t += dt;
    if (line.t >= (line.dur ?? 3.6)) G.dialogue.shift();
  }
  for (let index = G.toasts.length - 1; index >= 0; index -= 1) {
    G.toasts[index].t += dt;
    if (G.toasts[index].t >= G.toasts[index].dur) G.toasts.splice(index, 1);
  }
  if (G.crimeFlash > 0) G.crimeFlash = Math.max(0, G.crimeFlash - dt * 2.4);
  if (G.hurtFlash > 0) G.hurtFlash = Math.max(0, G.hurtFlash - dt * 2.4);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 26);
}

/** Put the camera on the player (or their car), clamped so the city fills the view. */
function snapCamera(G, missions, screen) {
  const focus = G.player.inCar ?? G.player;
  if (screen === SCREEN_TITLE) {
    const start = G.world.spots.playerStart;
    G.cam.x = start.x - G.canvasW / 2;
    G.cam.y = start.y - G.canvasH / 2;
    return;
  }
  G.cam.x = focus.x - G.canvasW / 2;
  G.cam.y = focus.y - G.canvasH / 2;
  clampCamera(G);
}

function clampCamera(G) {
  const maxX = G.world.width - G.canvasW;
  const maxY = G.world.height - G.canvasH;
  G.cam.x = maxX <= 0 ? maxX / 2 : Math.min(maxX, Math.max(0, G.cam.x));
  G.cam.y = maxY <= 0 ? maxY / 2 : Math.min(maxY, Math.max(0, G.cam.y));
}

function runGame() {
  let saved = readSave();
  let { G, missions } = createGame(saved);
  let screen = SCREEN_TITLE;
  let winShown = false;
  let accumulator = 0;
  let last = performance.now();
  const input = createInput(canvas);
  G.input = input;
  const renderer = createRenderer(canvas);
  snapCamera(G, missions, screen);

  function announce(message) {
    status.textContent = message;
  }

  function toast(text, dur = 3.2) {
    G.toasts.push({ text, t: 0, dur });
  }

  function persist() {
    writeSave({
      money: G.money,
      index: missions.index,
      weapon: G.player.weapon,
      ammo: G.player.ammo,
      freeRoam: G.freeRoam,
    });
    saved = readSave();
    G.hasSave = true;
  }

  function startRun(continueSave) {
    const fresh = createGame(continueSave ? saved : null);
    const muted = G.audio.muted;
    G = fresh.G;
    missions = fresh.missions;
    G.input = input;
    G.audio.setMuted(muted);
    winShown = G.freeRoam;
    screen = SCREEN_PLAY;
    snapCamera(G, missions, screen);
    G.audio.start();
    G.audio.click();
    announce(continueSave ? 'Welcome back to Port Solenne.' : 'A new story in Port Solenne.');
    if (!continueSave) {
      toast('Find the gold marker to start: First Wheels');
    }
  }

  /** Busted or wasted: pay the price, wake up at the precinct or the hospital. */
  function respawn(kind) {
    const spot = kind === 'busted' ? G.world.spots.precinct : G.world.spots.hospital;
    const cut = kind === 'busted'
      ? Math.max(25, Math.floor(G.money * 0.15))
      : Math.max(15, Math.floor(G.money * 0.1));
    G.money = Math.max(0, G.money - cut);
    if (G.player.inCar) G.player.inCar = null;
    G.cars = G.cars.filter((car) => car.role !== 'police');
    G.player.x = spot.x;
    G.player.y = spot.y;
    G.player.hp = G.player.maxHp;
    G.player.bust = 0;
    G.wanted.heat = 0;
    G.wanted.level = 0;
    G.wanted.hide = 0;
    G.dead = '';
    snapCamera(G, missions, SCREEN_PLAY);
    return cut;
  }

  function handleActions() {
    const actions = input.takeActions();
    if (actions & ACTION_MUTE) {
      const muted = !G.audio.muted;
      G.audio.setMuted(muted);
      try {
        window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      } catch { /* preference lasts this visit only */ }
      toast(muted ? 'Sound off' : 'Sound on', 1.4);
    }
    if (screen === SCREEN_TITLE) {
      if ((actions & ACTION_CONTINUE) && G.hasSave) startRun(true);
      else if (actions & ACTION_CONFIRM) startRun(false);
      return;
    }
    if (screen === SCREEN_PLAY) {
      if (actions & ACTION_PAUSE) {
        screen = SCREEN_PAUSED;
        announce('Paused.');
      } else if (actions & ACTION_ENTER) {
        G.enterPressed = true;
      }
      return;
    }
    if (screen === SCREEN_PAUSED) {
      if (actions & (ACTION_PAUSE | ACTION_CONFIRM)) {
        screen = SCREEN_PLAY;
        announce('Playing.');
      }
      return;
    }
    if (screen === SCREEN_BUSTED || screen === SCREEN_WASTED) {
      if (actions & ACTION_CONFIRM) {
        const wasActive = missions.phase === 'active';
        respawn(screen);
        if (wasActive) {
          G.failReason = screen === SCREEN_BUSTED ? 'Busted mid-job. Mara is not pleased.' : 'Wasted mid-job. Mara is not pleased.';
          missions.fail(G, G.failReason);
          screen = SCREEN_FAILED;
        } else {
          screen = SCREEN_PLAY;
        }
        announce('Back on the street.');
      }
      return;
    }
    if (screen === SCREEN_FAILED) {
      if (actions & ACTION_CONFIRM) {
        screen = SCREEN_PLAY;
        toast('Find the gold marker to try the job again');
      }
      return;
    }
    if (screen === SCREEN_WIN) {
      if (actions & ACTION_CONFIRM) screen = SCREEN_PLAY;
    }
  }

  function stepPlay(dt) {
    G.time += dt;
    updatePlayer(G, dt);
    updateCars(G, dt);
    updatePeds(G, dt);
    updateBullets(G, dt);
    updateFx(G, dt);
    updatePickups(G, dt);
    updateWanted(G, dt);
    missions.update(G, dt);
    ageMessages(G, dt);

    // Mission auto-start: walk or drive into the gold marker while no job is running.
    if (missions.phase === 'idle') {
      const marker = missions.startMarker();
      if (marker) {
        const dx = G.player.x - marker.x;
        const dy = G.player.y - marker.y;
        if (dx * dx + dy * dy < 52 * 52) {
          missions.start(G);
          G.audio.click();
          announce(`Mission started: ${missions.current(G).title}.`);
        }
      }
    }
    if (G.missionCompleteFlag) {
      G.missionCompleteFlag = false;
      persist();
    }
    if (G.missionFailed) {
      G.failReason = G.missionFailed;
      G.missionFailed = '';
      missions.fail(G, G.failReason);
      screen = SCREEN_FAILED;
      announce('Mission failed.');
      return;
    }
    if (missions.phase === 'done' && !winShown) {
      winShown = true;
      persist();
      screen = SCREEN_WIN;
      announce('Story complete. Port Solenne is yours.');
      return;
    }
    if (G.dead === 'busted') {
      screen = SCREEN_BUSTED;
      G.audio.jingle(false);
      announce('Busted.');
    } else if (G.dead === 'wasted') {
      screen = SCREEN_WASTED;
      G.audio.jingle(false);
      announce('Wasted.');
    }

    // Camera follows the player (or their car) with a soft lead.
    const focus = G.player.inCar ?? G.player;
    const lead = 0.16;
    G.cam.x += (focus.x - G.canvasW / 2 - G.cam.x) * lead;
    G.cam.y += (focus.y - G.canvasH / 2 - G.cam.y) * lead;
    clampCamera(G);

    // Sound follows the action: engine from the player's car, sirens from nearby police.
    const car = G.player.inCar;
    G.audio.update(dt, {
      engineOn: Boolean(car),
      engineLoad: car ? Math.min(1, Math.abs(car.speed) / 430 + (input.axisY() !== 0 ? 0.25 : 0)) : 0,
      sirenOn: G.sirenOn,
    });
  }

  function stepAmbient(dt) {
    // The title screen's living backdrop: traffic and crowds move, nobody is hunted.
    G.time += dt;
    updateCars(G, dt);
    updatePeds(G, dt);
    updateFx(G, dt);
    ageMessages(G, dt);
    const start = G.world.spots.playerStart;
    const drift = 26;
    G.cam.x = start.x - G.canvasW / 2 + Math.sin(G.time * 0.05) * drift;
    G.cam.y = start.y - G.canvasH / 2 + Math.cos(G.time * 0.037) * drift;
    clampCamera(G);
    G.audio.update(dt, { engineOn: false, engineLoad: 0, sirenOn: false });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    accumulator += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    handleActions();
    if (screen === SCREEN_PLAY) {
      while (accumulator >= STEP && screen === SCREEN_PLAY) {
        stepPlay(STEP);
        accumulator -= STEP;
      }
    } else if (screen === SCREEN_TITLE) {
      while (accumulator >= STEP) {
        stepAmbient(STEP);
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    renderer.draw(G, screen, missions.current(G));
  }

  // Leaving the tab pauses a running game rather than letting the city run unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) screen = SCREEN_PAUSED;
  });

  if (readMuted()) G.audio.setMuted(true);
  announce('Solenne Heat. Press Enter for a new game.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
