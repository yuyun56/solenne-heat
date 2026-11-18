// Solenne Heat — the story mission chain.
//
// Six missions, run strictly in order, each a list of steps the engine below walks the
// player through. A mission only *starts* when main.js sees the player reach the start
// marker (see current()/startMarker()) and calls start(G); completing the last step pays
// the reward, plays the outro and hands control back to main.js, which starts the next
// mission the same way. Finishing the finale flips the game into free roam.
//
// Failures this module detects itself (timer expiry, a wrecked delivery car) are reported
// through G.missionFailed; main.js then calls fail(G, reason), which resets the mission
// to 'idle' at the same index so it can be retried from its start marker.

import { spawnCar, spawnThug, spawnPickup, addCrime } from './entities.js';

/** How long each dialogue line stays on screen, in seconds. */
const DIALOGUE_DUR = 3.6;

/** Default arrival radius for goto/deliver steps, in px. */
const DEFAULT_RADIUS = 42;

/** How close, in px, the player on foot must get to collect the package in mission 2. */
const PACKAGE_RADIUS = 30;

/** Push one toast message. Toasts are {text, t, dur} objects, aged by the main loop. */
function toast(G, text) {
  if (Array.isArray(G.toasts)) G.toasts.push({ text, t: 0, dur: 3.4 });
}

/** Push a block of dialogue lines, each stamped for the dialogue renderer. */
function say(G, lines) {
  if (!Array.isArray(G.dialogue) || !lines) return;
  for (const line of lines) {
    G.dialogue.push({ who: line.who, text: line.text, t: 0, dur: DIALOGUE_DUR });
  }
}

/** Play the success/failure sting, if the audio module is present. */
function jingle(G, ok) {
  if (G.audio && typeof G.audio.jingle === 'function') G.audio.jingle(ok);
}

/** Resolve a step target: a spot name, a spot object, or a raw {x, y}. */
function resolveTarget(G, at) {
  if (!at) return null;
  if (typeof at === 'string') {
    const spot = G.world && G.world.spots ? G.world.spots[at] : null;
    return spot || null;
  }
  if (typeof at.x === 'number' && typeof at.y === 'number') return at;
  return null;
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/** A mission foe counts as remaining until it is down, dead, inactive or out of hp. */
function foeDown(foe) {
  if (!foe) return true;
  if (foe.down === true || foe.dead === true || foe.active === false) return true;
  if (foe.state === 'down' || foe.state === 'dead') return true;
  if (typeof foe.hp === 'number' && foe.hp <= 0) return true;
  return false;
}

function countFoesLeft(G) {
  const foes = Array.isArray(G.missionFoes) ? G.missionFoes : [];
  let left = 0;
  for (const foe of foes) if (!foeDown(foe)) left += 1;
  return left;
}

/** The helpers a mission's setup(G, api) gets, beyond the shared state itself. */
function makeApi(G) {
  return {
    spawnCar,
    spawnThug,
    spawnPickup,
    addCrime,
    spot: (name) => (G.world && G.world.spots ? G.world.spots[name] : null),
    /** Spawn a thug and register it as a mission foe for fight steps / cleanup. */
    foe: (x, y, kind) => {
      const ped = spawnThug(G, x, y, kind);
      if (ped) {
        if (!Array.isArray(G.missionFoes)) G.missionFoes = [];
        G.missionFoes.push(ped);
      }
      return ped;
    },
  };
}

// ---------------------------------------------------------------------------
// The chain. Each setup(G, api) spawns whatever the mission needs and returns
// its steps, so spawns and steps can never drift apart.
// ---------------------------------------------------------------------------

const MISSIONS = [
  {
    title: 'First Wheels',
    start: 'garage',
    reward: 150,
    intro: [
      { who: 'Mara Voss', text: 'Rafe. Good, you still breathe. I need wheels, not excuses.' },
      { who: 'Mara Voss', text: 'Lift any parked car you like and bring it round the back of my garage.' },
      { who: 'Rafe', text: 'Steal a car, park it, get paid. My kind of morning.' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'Clean lift, no dents worth crying over. You might be useful after all.' },
    ],
    setup(G, api) {
      return [
        { kind: 'anyCar', text: 'Get in any car' },
        { kind: 'goto', at: 'garage', inCar: true, text: "Bring the car back to Mara's garage" },
      ];
    },
  },
  {
    title: 'Package Run',
    start: 'diner',
    reward: 250,
    timeLimit: 150,
    intro: [
      { who: 'Mara Voss', text: "There's a package waiting at the diner on Harbor Row. No names, no questions." },
      { who: 'Mara Voss', text: 'Walk it to the dock before the tide — and my patience — goes out.' },
      { who: 'Rafe', text: 'A box, a dock, a clock. What could possibly go sideways?' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'Delivered, and still warm. Check your waistband — I left you something for the road.' },
    ],
    onComplete(G) {
      G.player.weapon = 'pistol';
      G.player.ammo = (G.player.ammo || 0) + 24;
      toast(G, 'Mara left you a pistol (+24 rounds)');
    },
    setup(G, api) {
      const spot = api.spot('diner');
      const pickup = spot ? spawnPickup(G, spot.x, spot.y, 'package', 0) : null;
      return [
        { kind: 'pickup', at: 'diner', pickup, text: 'Pick up the package at the diner' },
        { kind: 'goto', at: 'dock', text: 'Get the package to the dock — fast' },
      ];
    },
  },
  {
    title: 'Dockside Muscle',
    start: 'dock',
    reward: 300,
    intro: [
      { who: 'Mara Voss', text: "Dock crews have started 'taxing' my shipments. Three of them, down by the water." },
      { who: 'Mara Voss', text: 'Explain, with your fists or that pistol, that the tax is cancelled.' },
      { who: 'Rafe', text: 'Diplomacy, dockside style. On it.' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'Word travels fast on wet concrete. My shipments move free again.' },
    ],
    setup(G, api) {
      const spot = api.spot('dock');
      if (spot) {
        api.foe(spot.x + 52, spot.y - 30, 'thug');
        api.foe(spot.x - 46, spot.y + 26, 'thug');
        api.foe(spot.x + 14, spot.y + 62, 'thug');
      }
      return [
        { kind: 'fight', count: 3, text: 'Drop all three dock thugs' },
      ];
    },
  },
  {
    title: 'Hot Metal',
    start: 'neonPlaza',
    reward: 400,
    intro: [
      { who: 'Mara Voss', text: "A sports coupe is parked up by Neon Plaza, keys in, owner very rich and very careless." },
      { who: 'Mara Voss', text: "Take it. The city will notice — shake the heat, then tuck it away at the hideout." },
      { who: 'Rafe', text: 'Steal loud, vanish quiet. Noted.' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'Gone without a ghost. That coupe just bought us both a reputation.' },
    ],
    setup(G, api) {
      const spot = api.spot('neonPlaza');
      if (spot) spawnCar(G, spot.x + 60, spot.y + 40, 0, 'sport', 'mission');
      return [
        {
          kind: 'steal',
          carRole: 'mission',
          text: 'Steal the marked sports coupe',
          onComplete(G2) {
            // Grand theft of a marked car is never quiet: guarantee at least 2 stars.
            G2.wanted.heat = Math.max(G2.wanted.heat, 95);
          },
        },
        { kind: 'escape', text: 'Lose the heat — break line of sight and lay low' },
        { kind: 'goto', at: 'hideout', text: 'Park up at the hideout' },
      ];
    },
  },
  {
    title: 'Neon Takedown',
    start: 'neonPlaza',
    reward: 600,
    intro: [
      { who: 'Mara Voss', text: 'Viktor Senn runs the Neon Mile, and he has started running it over my people.' },
      { who: 'Mara Voss', text: "He's holding a block near the hideout with two shooters. End the management." },
      { who: 'Rafe', text: 'One boss, two guns, no negotiation. Clear.' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'Senn is finished, and the Mile knows it. One job left, Rafe. The big one.' },
    ],
    setup(G, api) {
      const spot = api.spot('hideout');
      if (spot) {
        api.foe(spot.x + 70, spot.y - 44, 'shooter');
        api.foe(spot.x - 64, spot.y - 20, 'shooter');
        api.foe(spot.x + 6, spot.y + 58, 'boss');
      }
      return [
        { kind: 'fight', count: 3, text: 'Take down Viktor Senn and his shooters' },
      ];
    },
  },
  {
    title: 'The Big Score',
    start: 'warehouse',
    reward: 1000,
    timeLimit: 240,
    completeToast: 'Port Solenne is yours — free roam unlocked',
    intro: [
      { who: 'Mara Voss', text: "An armoured van sits in the van yard, full of somebody else's retirement fund." },
      { who: 'Mara Voss', text: 'Steal it, survive the whole city wanting it back, and roll it into my warehouse.' },
      { who: 'Rafe', text: 'One van, three stars, four minutes. Let’s get rich or get arrested.' },
    ],
    outro: [
      { who: 'Mara Voss', text: 'That van just bought the whole waterfront. Port Solenne is ours now, Rafe.' },
      { who: 'Rafe', text: 'Then I am taking the rest of the day off. Forever, maybe.' },
    ],
    setup(G, api) {
      const spot = api.spot('vanYard');
      if (spot) spawnCar(G, spot.x, spot.y, 0, 'van', 'mission');
      return [
        {
          kind: 'steal',
          carRole: 'mission',
          text: 'Steal the armoured van from the van yard',
          onComplete(G2) {
            // Rolling out in an armoured van brings the whole precinct: 3 stars.
            G2.wanted.heat = Math.max(G2.wanted.heat, 155);
          },
        },
        { kind: 'deliver', at: 'warehouse', radius: 60, text: 'Drive the van back to the warehouse' },
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export function createMissions() {
  const M = {
    index: 0,
    phase: 'idle', // 'idle' | 'active' | 'done'
    stepIndex: 0,
    timeLeft: Infinity,
    foesLeft: 0,
    // Active-mission working state, rebuilt by start() and cleared on end/fail.
    steps: [],
    missionCar: null,
    _spots: null, // cached world.spots so startMarker() can work without a G
  };

  function def() {
    return MISSIONS[M.index] || null;
  }

  function cacheSpots(G) {
    if (G && G.world && G.world.spots) M._spots = G.world.spots;
  }

  function currentStep() {
    return M.steps[M.stepIndex] || null;
  }

  function findMissionCar(G) {
    if (M.missionCar) return M.missionCar;
    if (Array.isArray(G.cars)) {
      for (const car of G.cars) if (car && car.role === 'mission') return car;
    }
    return null;
  }

  /** Remove mission-spawned entities; the player's current car is left alone. */
  function cleanup(G) {
    const currentCar = G.player ? G.player.inCar : null;
    if (Array.isArray(G.cars)) {
      G.cars = G.cars.filter((car) => !(car && car.role === 'mission' && car !== currentCar));
    }
    if (Array.isArray(G.peds) && Array.isArray(G.missionFoes) && G.missionFoes.length) {
      const foes = new Set(G.missionFoes);
      G.peds = G.peds.filter((ped) => !foes.has(ped));
    }
    G.missionFoes = [];
    if (Array.isArray(G.pickups)) {
      G.pickups = G.pickups.filter((pickup) => !(pickup && pickup.kind === 'package'));
    }
    M.missionCar = null;
    M.steps = [];
    M.stepIndex = 0;
    M.timeLeft = Infinity;
    M.foesLeft = 0;
  }

  function complete(G) {
    const d = def();
    if (!d) return;
    G.money = (G.money || 0) + d.reward;
    jingle(G, true);
    if (typeof d.onComplete === 'function') d.onComplete(G, makeApi(G));
    say(G, d.outro);
    toast(G, `Mission complete: +$${d.reward}`);
    if (d.completeToast) toast(G, d.completeToast);
    // Save hook: main.js persists progress when it sees this flag, then clears it.
    G.missionCompleteFlag = true;
    cleanup(G);
    M.index += 1;
    if (M.index >= MISSIONS.length) {
      M.index = MISSIONS.length;
      M.phase = 'done';
      G.freeRoam = true;
    } else {
      M.phase = 'idle';
    }
  }

  // -- public API -----------------------------------------------------------

  M.start = function start(G) {
    cacheSpots(G);
    if (M.phase !== 'idle') return;
    const d = def();
    if (!d) {
      M.phase = 'done';
      G.freeRoam = true;
      return;
    }
    G.missionFoes = [];
    G.missionFailed = '';
    M.missionCar = null;
    M.steps = typeof d.setup === 'function' ? d.setup(G, makeApi(G)) || [] : [];
    M.stepIndex = 0;
    M.timeLeft = typeof d.timeLimit === 'number' ? d.timeLimit : Infinity;
    M.foesLeft = countFoesLeft(G);
    M.phase = 'active';
    say(G, d.intro);
    const first = currentStep();
    if (first && first.text) toast(G, first.text);
  };

  M.update = function update(G, dt) {
    cacheSpots(G);
    if (M.phase !== 'active') return;
    const d = def();
    if (!d) return;

    // Mission clock: expiry is reported through the missionFailed channel;
    // main.js answers it by calling fail(G, G.missionFailed).
    if (Number.isFinite(M.timeLeft)) {
      M.timeLeft -= dt;
      if (M.timeLeft <= 0) {
        M.timeLeft = 0;
        G.missionFailed = 'Time ran out';
        return;
      }
    }

    M.foesLeft = countFoesLeft(G);

    const step = currentStep();
    if (!step) {
      complete(G);
      return;
    }

    const player = G.player;
    let done = false;

    switch (step.kind) {
      case 'anyCar': {
        if (player.inCar) {
          M.missionCar = player.inCar;
          done = true;
        }
        break;
      }
      case 'steal': {
        const car = player.inCar;
        if (car && (car === M.missionCar || car.role === (step.carRole || 'mission'))) {
          M.missionCar = car;
          done = true;
        }
        break;
      }
      case 'goto': {
        if (step.inCar && !player.inCar) break;
        const target = resolveTarget(G, step.at);
        if (!target) break;
        const actor = step.inCar && player.inCar && typeof player.inCar.x === 'number'
          ? player.inCar
          : player;
        if (distance(actor.x, actor.y, target.x, target.y) <= (step.radius || DEFAULT_RADIUS)) {
          done = true;
        }
        break;
      }
      case 'deliver': {
        const car = M.missionCar || findMissionCar(G);
        if (car) M.missionCar = car;
        if (car && typeof car.hp === 'number' && car.hp <= 0) {
          G.missionFailed = 'The mission car was wrecked';
          return;
        }
        if (!car || player.inCar !== car) break;
        const target = resolveTarget(G, step.at);
        if (!target) break;
        if (distance(car.x, car.y, target.x, target.y) <= (step.radius || DEFAULT_RADIUS)) {
          done = true;
        }
        break;
      }
      case 'pickup': {
        if (player.inCar) break; // the package is collected on foot
        let pickup = null;
        if (Array.isArray(G.pickups)) {
          if (step.pickup && G.pickups.includes(step.pickup)) pickup = step.pickup;
          else pickup = G.pickups.find((p) => p && p.kind === 'package') || null;
        }
        const target = pickup || resolveTarget(G, step.at);
        if (!target) break;
        if (distance(player.x, player.y, target.x, target.y) <= PACKAGE_RADIUS) {
          if (pickup && Array.isArray(G.pickups)) {
            const at = G.pickups.indexOf(pickup);
            if (at >= 0) G.pickups.splice(at, 1);
          }
          done = true;
        }
        break;
      }
      case 'fight': {
        done = M.foesLeft <= 0;
        break;
      }
      case 'escape': {
        done = !G.wanted || (G.wanted.level || 0) <= 0;
        break;
      }
      default:
        break;
    }

    if (!done) return;

    if (typeof step.onComplete === 'function') step.onComplete(G, makeApi(G));
    M.stepIndex += 1;
    if (M.stepIndex >= M.steps.length) {
      complete(G);
      return;
    }
    const next = currentStep();
    if (next && next.text) toast(G, next.text);
  };

  M.current = function current(G) {
    cacheSpots(G);
    if (M.phase === 'done' || !def()) {
      return {
        title: 'Free roam',
        objective: 'Port Solenne is yours. Cause trouble or cruise.',
        marker: null,
      };
    }
    const d = def();
    if (M.phase === 'idle') {
      const spot = G.world && G.world.spots ? G.world.spots[d.start] : null;
      const label = spot && spot.label ? spot.label : d.start;
      return { title: d.title, objective: `Go to the ${label}`, marker: spot || null };
    }
    // Active: point at the current step's target, where it has one.
    const step = currentStep();
    let marker = null;
    if (step) {
      switch (step.kind) {
        case 'goto':
        case 'deliver':
        case 'pickup':
          marker = resolveTarget(G, step.at);
          break;
        case 'steal': {
          const car = findMissionCar(G);
          marker = car ? { x: car.x, y: car.y } : null;
          break;
        }
        case 'fight': {
          const foes = (Array.isArray(G.missionFoes) ? G.missionFoes : []).filter((f) => !foeDown(f));
          if (foes.length) {
            let x = 0;
            let y = 0;
            for (const foe of foes) { x += foe.x; y += foe.y; }
            marker = { x: x / foes.length, y: y / foes.length };
          }
          break;
        }
        case 'escape':
          marker = G.world && G.world.spots ? G.world.spots.hideout || null : null;
          break;
        default:
          marker = null;
      }
    }
    return { title: d.title, objective: step && step.text ? step.text : '', marker };
  };

  M.startMarker = function startMarker() {
    if (M.phase === 'done') return null;
    const d = def();
    if (!d || !M._spots) return null;
    const spot = M._spots[d.start];
    return spot ? { x: spot.x, y: spot.y } : null;
  };

  M.fail = function fail(G, reason) {
    cacheSpots(G);
    if (M.phase === 'done') return;
    cleanup(G);
    G.missionFailed = '';
    M.phase = 'idle';
    toast(G, `Mission failed: ${reason}`);
    jingle(G, false);
  };

  M.restore = function restore(G, index, freeRoam) {
    cacheSpots(G);
    const n = Number.isInteger(index) ? index : 0;
    M.steps = [];
    M.missionCar = null;
    M.stepIndex = 0;
    M.timeLeft = Infinity;
    M.foesLeft = 0;
    if (Array.isArray(G.missionFoes)) G.missionFoes = [];
    if (freeRoam || n >= MISSIONS.length) {
      M.index = Math.min(Math.max(n, 0), MISSIONS.length);
      M.phase = 'done';
      G.freeRoam = true;
    } else {
      M.index = Math.max(0, n);
      M.phase = 'idle';
      G.freeRoam = false;
    }
  };

  return M;
}
