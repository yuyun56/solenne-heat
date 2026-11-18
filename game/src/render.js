// Solenne Heat renderer: drawing only. The shared game state G and the current screen go in,
// pixels come out. The world pass draws the city through the camera (ground, roads, buildings,
// props, pickups, peds, cars, bullets, fx, the player); the HUD pass draws in screen space
// (minimap, money, wanted stars, health, weapon, mission panel, prompts, toasts, dialogue,
// the off-screen marker arrow) and finally any full-screen overlay for the current screen.
// No images, no dependencies; the canvas is sized here with devicePixelRatio and everything
// is drawn in CSS pixel coordinates.
import { CITY, COLORS, CAR, PLAYER, PED, FONT, GAME_TITLE, CITY_NAME, SIDEWALK } from './config.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_BUSTED = 'busted';
export const SCREEN_WASTED = 'wasted';
export const SCREEN_FAILED = 'failed';
export const SCREEN_WIN = 'win';

const TAU = Math.PI * 2;
const SKIN_TONES = ['#e8b08a', '#c98a5e', '#8a5a3b', '#f0c8a0', '#6e4530'];

/** Small deterministic hash of two coordinates, so window patterns never flicker. */
function hash2(a, b) {
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let viewW = 0; // CSS pixels
  let viewH = 0;
  let vignette = null; // cached radial gradient, rebuilt when the size changes
  let vignetteKey = '';

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- text helpers -------------------------------------------------------

  const fontCache = new Map();
  function setFont(size, weight) {
    const key = weight + ':' + size;
    let f = fontCache.get(key);
    if (!f) {
      f = `${weight} ${size}px ${FONT}`;
      fontCache.set(key, f);
    }
    ctx.font = f;
  }

  function text(str, x, y, size, color, align, weight) {
    setFont(size, weight || 400);
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }

  /** Word-wrap `str` to at most maxWidth px at the given font size; returns the lines. */
  function wrap(str, maxWidth, size, weight) {
    setFont(size, weight || 400);
    const words = String(str).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const trial = line ? line + ' ' + word : word;
      if (line && ctx.measureText(trial).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /** Rounded-rect path; uses the native method when present, falls back to arcs. */
  function rr(x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rad);
      return;
    }
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  }

  function panel(x, y, w, h) {
    rr(x, y, w, h, 10);
    ctx.fillStyle = COLORS.panel;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Money label, rebuilt only when the amount changes.
  let moneyCacheValue = null;
  let moneyCacheText = '';
  function moneyLabel(money) {
    if (money !== moneyCacheValue) {
      moneyCacheValue = money;
      moneyCacheText = '$' + Math.round(money || 0).toLocaleString('en-US');
    }
    return moneyCacheText;
  }

  // ---- world pass ---------------------------------------------------------

  function drawGround(G, vx, vy, vw, vh) {
    const world = G.world;
    const road = CITY.road;
    const pitch = CITY.pitch;
    const block = CITY.block;

    // Asphalt everywhere first; blocks and markings go on top.
    ctx.fillStyle = COLORS.asphalt;
    ctx.fillRect(vx, vy, vw, vh);

    // Intersections are the darker asphalt.
    ctx.fillStyle = COLORS.asphaltDark;
    for (const rx of world.vRoads) {
      for (const ry of world.hRoads) {
        ctx.fillRect(rx, ry, road, road);
      }
    }

    // Blocks: sidewalk rim in the district walk colour, ground inset by SIDEWALK.
    const i0 = clamp(Math.floor((vx - road) / pitch), 0, CITY.cols - 1);
    const i1 = clamp(Math.floor((vx + vw - road) / pitch), 0, CITY.cols - 1);
    const j0 = clamp(Math.floor((vy - road) / pitch), 0, CITY.rows - 1);
    const j1 = clamp(Math.floor((vy + vh - road) / pitch), 0, CITY.rows - 1);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        const bx = i * pitch + road;
        const by = j * pitch + road;
        const pal = COLORS[world.districtAt(bx + block / 2, by + block / 2)] || COLORS.harbor;
        ctx.fillStyle = pal.walk;
        ctx.fillRect(bx, by, block, block);
        ctx.fillStyle = pal.ground;
        ctx.fillRect(bx + SIDEWALK, by + SIDEWALK, block - SIDEWALK * 2, block - SIDEWALK * 2);
      }
    }

    // Kerb lines along every road edge.
    ctx.strokeStyle = COLORS.kerb;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const rx of world.vRoads) {
      ctx.moveTo(rx, Math.max(0, vy));
      ctx.lineTo(rx, Math.min(world.height, vy + vh));
      ctx.moveTo(rx + road, Math.max(0, vy));
      ctx.lineTo(rx + road, Math.min(world.height, vy + vh));
    }
    for (const ry of world.hRoads) {
      ctx.moveTo(Math.max(0, vx), ry);
      ctx.lineTo(Math.min(world.width, vx + vw), ry);
      ctx.moveTo(Math.max(0, vx), ry + road);
      ctx.lineTo(Math.min(world.width, vx + vw), ry + road);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Dashed centre lines, skipped inside intersections.
    ctx.strokeStyle = COLORS.laneMark;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 18]);
    ctx.beginPath();
    for (const rx of world.vRoads) {
      const cx = rx + road / 2;
      let y = Math.max(0, Math.floor(vy / pitch) * pitch);
      const yEnd = Math.min(world.height, vy + vh);
      while (y < yEnd) {
        const segEnd = Math.min(y + pitch, yEnd);
        const inCrossing = world.hRoads.some((ry) => y < ry + road && segEnd > ry);
        if (!inCrossing) {
          ctx.moveTo(cx, y);
          ctx.lineTo(cx, segEnd);
        }
        y += pitch;
      }
    }
    for (const ry of world.hRoads) {
      const cy = ry + road / 2;
      let x = Math.max(0, Math.floor(vx / pitch) * pitch);
      const xEnd = Math.min(world.width, vx + vw);
      while (x < xEnd) {
        const segEnd = Math.min(x + pitch, xEnd);
        const inCrossing = world.vRoads.some((rx) => x < rx + road && segEnd > rx);
        if (!inCrossing) {
          ctx.moveTo(x, cy);
          ctx.lineTo(segEnd, cy);
        }
        x += pitch;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawBuildings(G, vx, vy, vw, vh) {
    for (const b of G.world.buildings) {
      const lift = (b.floors || 1) * 3;
      if (b.x + b.w + 10 < vx || b.x - 10 > vx + vw || b.y + b.h + 12 < vy || b.y - lift - 4 > vy + vh) continue;
      // Shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(b.x + 6, b.y + 8, b.w, b.h);
      // Body.
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      // Roof, shifted up by the building's height.
      ctx.fillStyle = b.roof;
      ctx.fillRect(b.x, b.y - lift, b.w, b.h);
      // Thin lighter top edge.
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(b.x, b.y - lift, b.w, 2);
      ctx.fillRect(b.x, b.y - lift, 2, b.h);
      // Window dots on the roof, from a coordinate hash so the pattern is stable.
      ctx.fillStyle = 'rgba(255, 226, 150, 0.5)';
      const cols = Math.floor(b.w / 20);
      const rows = Math.floor(b.h / 20);
      for (let cx = 0; cx < cols; cx += 1) {
        for (let cy = 0; cy < rows; cy += 1) {
          if (hash2(b.x + cx * 31, b.y + cy * 57) < 0.45) {
            ctx.fillRect(b.x + 8 + cx * 20, b.y - lift + 8 + cy * 20, 5, 5);
          }
        }
      }
    }
  }

  function drawProps(G, vx, vy, vw, vh) {
    for (const p of G.world.props) {
      if (p.x < vx - 30 || p.x > vx + vw + 30 || p.y < vy - 30 || p.y > vy + vh + 30) continue;
      if (p.kind === 'lamp') {
        const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 30);
        glow.addColorStop(0, 'rgba(255, 205, 110, 0.35)');
        glow.addColorStop(1, 'rgba(255, 205, 110, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 30, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#2b2e35';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ffd98a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'tree') {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.arc(p.x + 3, p.y + 4, 11, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#274d2a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, TAU);
        ctx.arc(p.x - 7, p.y + 4, 8, 0, TAU);
        ctx.arc(p.x + 7, p.y + 4, 8, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#356b38';
        ctx.beginPath();
        ctx.arc(p.x - 2, p.y - 3, 6, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'bench') {
        ctx.fillStyle = '#6e4f2e';
        ctx.fillRect(p.x - 9, p.y - 3, 18, 6);
        ctx.fillStyle = '#54391f';
        ctx.fillRect(p.x - 9, p.y - 5, 18, 2);
      } else if (p.kind === 'hydrant') {
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, TAU);
        ctx.fill();
      }
    }
  }

  const PICKUP_STYLE = {
    cash: { color: COLORS.cash, glyph: '$' },
    ammo: { color: COLORS.ammo, glyph: 'A' },
    health: { color: COLORS.health, glyph: '+' },
    package: { color: COLORS.marker, glyph: 'P' },
  };

  function drawPickups(G) {
    for (const pk of G.pickups) {
      const st = PICKUP_STYLE[pk.kind] || PICKUP_STYLE.cash;
      const pulse = 0.5 + 0.5 * Math.sin(G.time * 4 + (pk.t || 0) + pk.x * 0.05);
      // Pulsing outer ring.
      ctx.strokeStyle = st.color;
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, 13 + 5 * pulse, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (pk.kind === 'package') {
        ctx.fillStyle = st.color;
        ctx.fillRect(pk.x - 9, pk.y - 9, 18, 18);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(pk.x - 9, pk.y - 9, 18, 18);
        ctx.beginPath();
        ctx.moveTo(pk.x - 9, pk.y);
        ctx.lineTo(pk.x + 9, pk.y);
        ctx.stroke();
      } else {
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.arc(pk.x, pk.y, 10, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      text(st.glyph, pk.x, pk.y + 5, 13, 'rgba(10,12,16,0.9)', 'center', 700);
    }
  }

  function drawMarkerBeacon(G, mission) {
    if (!mission || !mission.marker) return;
    const m = mission.marker;
    // Translucent vertical beam.
    const grad = ctx.createLinearGradient(0, m.y - 280, 0, m.y);
    grad.addColorStop(0, 'rgba(255, 210, 62, 0)');
    grad.addColorStop(1, 'rgba(255, 210, 62, 0.30)');
    ctx.fillStyle = grad;
    ctx.fillRect(m.x - 13, m.y - 280, 26, 280);
    // Ground ring.
    ctx.strokeStyle = COLORS.marker;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 16 + 3 * Math.sin(G.time * 4), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Bouncing diamond above the point.
    const dy = m.y - 44 + Math.sin(G.time * 3.2) * 6;
    ctx.fillStyle = COLORS.marker;
    ctx.beginPath();
    ctx.moveTo(m.x, dy - 11);
    ctx.lineTo(m.x + 9, dy);
    ctx.lineTo(m.x, dy + 11);
    ctx.lineTo(m.x - 9, dy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawPedBody(x, y, angle, shirt, skin, hostile) {
    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 3, PED.radius, PED.radius * 0.7, 0, 0, TAU);
    ctx.fill();
    if (hostile) {
      ctx.strokeStyle = 'rgba(229, 83, 75, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, PED.radius + 3, 0, TAU);
      ctx.stroke();
    }
    // Body (shirt), head (skin).
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.arc(x, y, PED.radius, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(x, y, PED.radius * 0.52, 0, TAU);
    ctx.fill();
    // Facing tick.
    ctx.strokeStyle = 'rgba(10,12,16,0.65)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * (PED.radius + 3), y + Math.sin(angle) * (PED.radius + 3));
    ctx.stroke();
  }

  function drawPeds(G) {
    for (const ped of G.peds) {
      if (ped.state === 'down') {
        // Lying body: rotated darker ellipse with a small dark pool.
        ctx.fillStyle = 'rgba(90, 12, 12, 0.55)';
        ctx.beginPath();
        ctx.ellipse(ped.x + 4, ped.y + 3, 13, 8, ped.angle, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.translate(ped.x, ped.y);
        ctx.rotate(ped.angle);
        ctx.fillStyle = ped.shirt;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.ellipse(0, 0, 13, 6.5, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = ped.color;
        ctx.beginPath();
        ctx.arc(11, 0, 4.5, 0, TAU);
        ctx.fill();
        ctx.restore();
        continue;
      }
      const hostile = ped.state === 'hostile' || ped.state === 'shooter';
      drawPedBody(ped.x, ped.y, ped.angle, ped.shirt, ped.color, hostile);
    }
  }

  function drawCars(G) {
    const L = CAR.length;
    const W = CAR.width;
    for (const car of G.cars) {
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.angle);
      // Shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      rr(-L / 2 + 3, -W / 2 + 4, L, W, 6);
      ctx.fill();
      const isPolice = car.role === 'police';
      // Body.
      ctx.fillStyle = isPolice ? COLORS.police : car.color;
      rr(-L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (isPolice) {
        // Blue trim stripe along the side.
        ctx.fillStyle = COLORS.policeTrim;
        ctx.fillRect(-L / 2 + 3, -3, L - 6, 6);
        // Light bar: two halves flashing red/blue, alternating with the siren phase.
        const phase = Math.floor((car.siren || 0) * 4) % 2;
        ctx.fillStyle = phase === 0 ? '#ff3b30' : 'rgba(255,59,48,0.25)';
        ctx.fillRect(-5, -W / 2 + 3, 10, 5);
        ctx.fillStyle = phase === 1 ? '#2f7bff' : 'rgba(47,123,255,0.25)';
        ctx.fillRect(-5, W / 2 - 8, 10, 5);
      }
      // Cabin and windshield.
      ctx.fillStyle = 'rgba(16, 22, 32, 0.85)';
      rr(-9, -W / 2 + 4, 17, W - 8, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(140, 190, 235, 0.55)';
      ctx.fillRect(6, -W / 2 + 5, 3.5, W - 10);
      ctx.fillRect(-11, -W / 2 + 5, 3, W - 10);
      // Damage scorch marks once the car is badly beaten.
      if (car.maxHp && car.hp < car.maxHp * 0.4) {
        ctx.fillStyle = 'rgba(8, 8, 10, 0.45)';
        ctx.fillRect(-L / 2 + 4, -W / 2 + 3, 13, 7);
        ctx.fillRect(L / 2 - 16, 2, 11, 6);
      }
      // Headlights.
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.arc(L / 2 - 1, -W / 2 + 4, 2.2, 0, TAU);
      ctx.arc(L / 2 - 1, W / 2 - 4, 2.2, 0, TAU);
      ctx.fill();
      // Role / occupancy outlines.
      if (car.role === 'mission') {
        ctx.strokeStyle = COLORS.marker;
        ctx.lineWidth = 2;
        rr(-L / 2 - 2.5, -W / 2 - 2.5, L + 5, W + 5, 8);
        ctx.stroke();
      }
      if (G.player.inCar && G.player.inCar === car) {
        ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.35 * Math.sin(G.time * 5)})`;
        ctx.lineWidth = 2;
        rr(-L / 2 - 2.5, -W / 2 - 2.5, L + 5, W + 5, 8);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawBullets(G) {
    ctx.strokeStyle = '#ffe98a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const b of G.bullets) {
      const vx = b.vx || 0;
      const vy = b.vy || 0;
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - vx * 0.022, b.y - vy * 0.022);
    }
    ctx.stroke();
  }

  function drawFx(G) {
    for (const f of G.fx) {
      const life = f.dur ? clamp(1 - f.t / f.dur, 0, 1) : 1;
      ctx.globalAlpha = life;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.size || 3, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer(G) {
    const p = G.player;
    if (p.inCar) return;
    // Gold ring under the feet.
    ctx.strokeStyle = COLORS.player;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER.radius + 4, 0, TAU);
    ctx.stroke();
    drawPedBody(p.x, p.y, p.angle, COLORS.playerShirt, SKIN_TONES[0], false);
    // Longer facing tick for the player.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(p.angle) * (PLAYER.radius + 8), p.y + Math.sin(p.angle) * (PLAYER.radius + 8));
    ctx.stroke();
    // Bust progress ring.
    if (p.bust > 0) {
      const frac = clamp(p.bust / PLAYER.bustTime, 0, 1);
      ctx.strokeStyle = COLORS.danger;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER.radius + 9, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      ctx.stroke();
    }
  }

  function drawWorldPass(G, mission, shakeX, shakeY) {
    const vx = G.cam.x - 40;
    const vy = G.cam.y - 40;
    const vw = viewW + 80;
    const vh = viewH + 80;
    ctx.save();
    ctx.translate(-G.cam.x + shakeX, -G.cam.y + shakeY);
    drawGround(G, vx, vy, vw, vh);
    drawBuildings(G, vx, vy, vw, vh);
    drawProps(G, vx, vy, vw, vh);
    drawPickups(G);
    drawMarkerBeacon(G, mission);
    drawPeds(G);
    drawCars(G);
    drawBullets(G);
    drawFx(G);
    drawPlayer(G);
    ctx.restore();
  }

  function drawScreenFx(G) {
    // Vignette (cached per size).
    const key = viewW + 'x' + viewH;
    if (vignetteKey !== key) {
      vignetteKey = key;
      const r = Math.hypot(viewW, viewH) / 2;
      vignette = ctx.createRadialGradient(viewW / 2, viewH / 2, r * 0.55, viewW / 2, viewH / 2, r);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.38)');
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, viewW, viewH);
    if (G.crimeFlash > 0) {
      ctx.fillStyle = `rgba(255, 220, 90, ${0.10 * clamp(G.crimeFlash, 0, 1)})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
    if (G.hurtFlash > 0) {
      ctx.fillStyle = `rgba(214, 40, 32, ${0.42 * clamp(G.hurtFlash, 0, 1)})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
  }

  // ---- HUD pass -----------------------------------------------------------

  function drawMinimap(G, mission) {
    const x = 16;
    const y = 16;
    const w = 196;
    const h = 168;
    panel(x, y, w, h);
    const innerX = x + 8;
    const innerY = y + 8;
    const innerW = w - 16;
    const innerH = h - 30;
    const scale = Math.min(innerW / G.world.width, innerH / G.world.height);
    const ox = innerX + (innerW - G.world.width * scale) / 2;
    const oy = innerY + (innerH - G.world.height * scale) / 2;
    const mx = (wx) => ox + wx * scale;
    const my = (wy) => oy + wy * scale;

    ctx.save();
    rr(innerX, innerY, innerW, innerH, 4);
    ctx.clip();
    ctx.fillStyle = '#14171e';
    ctx.fillRect(innerX, innerY, innerW, innerH);
    // District tints per block.
    for (let i = 0; i < CITY.cols; i += 1) {
      for (let j = 0; j < CITY.rows; j += 1) {
        const bx = i * CITY.pitch + CITY.road;
        const by = j * CITY.pitch + CITY.road;
        const pal = COLORS[G.world.districtAt(bx + CITY.block / 2, by + CITY.block / 2)] || COLORS.harbor;
        ctx.fillStyle = pal.ground;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(mx(bx), my(by), CITY.block * scale, CITY.block * scale);
      }
    }
    ctx.globalAlpha = 1;
    // Roads as light lines.
    ctx.strokeStyle = 'rgba(230, 235, 245, 0.5)';
    ctx.lineWidth = Math.max(1.5, CITY.road * scale * 0.55);
    ctx.beginPath();
    for (const rx of G.world.vRoads) {
      ctx.moveTo(mx(rx + CITY.road / 2), my(0));
      ctx.lineTo(mx(rx + CITY.road / 2), my(G.world.height));
    }
    for (const ry of G.world.hRoads) {
      ctx.moveTo(mx(0), my(ry + CITY.road / 2));
      ctx.lineTo(mx(G.world.width), my(ry + CITY.road / 2));
    }
    ctx.stroke();
    // Police as blue dots.
    ctx.fillStyle = '#4d9fff';
    for (const car of G.cars) {
      if (car.role !== 'police') continue;
      ctx.beginPath();
      ctx.arc(mx(car.x), my(car.y), 2.6, 0, TAU);
      ctx.fill();
    }
    // Mission marker: pulsing gold dot.
    if (mission && mission.marker) {
      const pulse = 3 + 1.4 * Math.sin(G.time * 5);
      ctx.fillStyle = COLORS.marker;
      ctx.beginPath();
      ctx.arc(mx(mission.marker.x), my(mission.marker.y), pulse, 0, TAU);
      ctx.fill();
    }
    // Player arrow.
    const p = G.player;
    const facing = p.inCar && typeof p.inCar === 'object' ? p.inCar.angle : p.angle;
    ctx.save();
    ctx.translate(mx(p.x), my(p.y));
    ctx.rotate(facing);
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    text(CITY_NAME.toUpperCase(), x + w / 2, y + h - 8, 10, COLORS.muted, 'center', 700);
  }

  function drawTopRight(G) {
    text(moneyLabel(G.money), viewW - 18, 42, 28, '#7be495', 'right', 700);
    // Wanted stars.
    const level = G.wanted.level || 0;
    setFont(24, 400);
    const starW = ctx.measureText('★').width + 4;
    let sx = viewW - 18 - starW * 5;
    for (let i = 0; i < 5; i += 1) {
      text('★', sx + i * starW, 72, 24, i < level ? COLORS.marker : 'rgba(154, 163, 178, 0.4)', 'left');
    }
    // Heat-cooling bar while the player stays hidden.
    if (level > 0 && G.wanted.hide > 0) {
      const bw = starW * 5 - 4;
      const frac = clamp(G.wanted.hide / 3.5, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(sx, 82, bw, 4);
      ctx.fillStyle = '#7cc7ff';
      ctx.fillRect(sx, 82, bw * frac, 4);
    }
  }

  function drawBottomLeft(G) {
    const p = G.player;
    const x = 16;
    const y = viewH - 58;
    const frac = clamp(p.hp / (p.maxHp || PLAYER.maxHp), 0, 1);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.65)';
    rr(x, y, 124, 16, 4);
    ctx.fill();
    ctx.fillStyle = `hsl(${Math.round(120 * frac)}, 68%, 42%)`;
    if (frac > 0) {
      rr(x + 2, y + 2, 120 * frac, 12, 3);
      ctx.fill();
    }
    const weapon = String(p.weapon || 'fists').toUpperCase();
    const ammo = weapon === 'FISTS' ? '—' : 'x ' + (p.ammo || 0);
    text(`${weapon}  ${ammo}`, x, viewH - 18, 15, COLORS.text, 'left', 700);
  }

  /**
   * The bottom-centre stack: dialogue (bottom), mission panel, prompt, toasts.
   * Returns nothing; each element is laid out from the bottom edge upward.
   */
  function drawBottomStack(G, mission) {
    let cursor = viewH - 14; // bottom edge available to the next element

    // Dialogue box.
    if (G.dialogue && G.dialogue.length) {
      const entry = G.dialogue[0];
      const speaker = entry.speaker || entry.name || '';
      const lines = wrap(entry.text || '', 560, 16);
      const w = Math.min(620, viewW - 32);
      const h = 34 + lines.length * 21 + 10;
      const x = (viewW - w) / 2;
      const y = cursor - h;
      panel(x, y, w, h);
      if (speaker) text(String(speaker).toUpperCase(), x + 16, y + 24, 13, COLORS.marker, 'left', 700);
      ctx.fillStyle = COLORS.text;
      for (let i = 0; i < lines.length; i += 1) {
        text(lines[i], x + 16, y + 48 + i * 21, 16, COLORS.text, 'left');
      }
      cursor = y - 8;
    }

    // Mission panel.
    let panelTop = cursor;
    if (mission) {
      const lines = wrap(mission.objective || '', 520, 15);
      const w = Math.min(560, viewW - 32);
      const h = 30 + lines.length * 20 + 10;
      const x = (viewW - w) / 2;
      const y = cursor - h;
      panel(x, y, w, h);
      text(String(mission.title || '').toUpperCase(), x + w / 2, y + 24, 13, COLORS.marker, 'center', 700);
      for (let i = 0; i < lines.length; i += 1) {
        text(lines[i], x + w / 2, y + 48 + i * 20, 15, COLORS.text, 'center');
      }
      panelTop = y;
      cursor = y - 8;
    }

    // Prompt, key-cap style, centred above the mission panel.
    if (G.prompt) {
      setFont(15, 600);
      const tw = ctx.measureText(G.prompt).width;
      const w = tw + 28;
      const h = 28;
      const x = (viewW - w) / 2;
      const y = cursor - h;
      rr(x, y, w, h, 7);
      ctx.fillStyle = 'rgba(240, 244, 250, 0.92)';
      ctx.fill();
      text(G.prompt, viewW / 2, y + 19, 15, '#14171e', 'center', 600);
      cursor = y - 8;
    }

    // Toasts, stacked upward, newest nearest the panel, fading with age.
    if (G.toasts && G.toasts.length) {
      for (let i = G.toasts.length - 1; i >= 0; i -= 1) {
        const toast = G.toasts[i];
        const alpha = toast.dur ? clamp(1 - toast.t / toast.dur, 0, 1) : 1;
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        text(toast.text, viewW / 2, cursor - 4, 15, '#ffe9a8', 'center', 600);
        ctx.globalAlpha = 1;
        cursor -= 22;
      }
    }
    return panelTop;
  }

  function drawMarkerArrow(G, mission) {
    if (!mission || !mission.marker) return;
    const m = mission.marker;
    const sx = m.x - G.cam.x;
    const sy = m.y - G.cam.y;
    const margin = 34;
    if (sx >= -10 && sx <= viewW + 10 && sy >= -10 && sy <= viewH + 10) return; // beacon is on screen
    const cx = viewW / 2;
    const cy = viewH / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    const ex = clamp(sx, margin, viewW - margin);
    const ey = clamp(sy, margin, viewH - margin);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.fillStyle = COLORS.marker;
    ctx.beginPath();
    ctx.moveTo(13, 0);
    ctx.lineTo(-8, -8);
    ctx.lineTo(-8, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const dist = Math.round(Math.hypot(m.x - G.player.x, m.y - G.player.y) / 10);
    text(dist + 'm', ex, ey + 26, 12, COLORS.marker, 'center', 700);
  }

  function drawHud(G, mission) {
    drawMinimap(G, mission);
    drawTopRight(G);
    drawBottomLeft(G);
    drawBottomStack(G, mission);
    drawMarkerArrow(G, mission);
  }

  // ---- screen overlays ----------------------------------------------------

  function darken(alpha) {
    ctx.fillStyle = `rgba(5, 6, 10, ${alpha})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  function centerPanel(w, h) {
    const x = (viewW - w) / 2;
    const y = (viewH - h) / 2;
    panel(x, y, w, h);
    return { x, y, w, h };
  }

  function drawTitle(G) {
    darken(0.55);
    const cx = viewW / 2;
    // Big gradient title with a dark outline.
    const grad = ctx.createLinearGradient(0, viewH * 0.16, 0, viewH * 0.16 + 84);
    grad.addColorStop(0, '#ffe98a');
    grad.addColorStop(0.55, '#ffd23e');
    grad.addColorStop(1, '#e07b2a');
    setFont(68, 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(10, 10, 14, 0.85)';
    ctx.strokeText(GAME_TITLE, cx, viewH * 0.16 + 68);
    ctx.fillStyle = grad;
    ctx.fillText(GAME_TITLE, cx, viewH * 0.16 + 68);
    text('A Port Solenne story', cx, viewH * 0.16 + 104, 19, COLORS.muted, 'center');

    const intro = [
      'Rafe came home to Port Solenne with empty pockets and a long memory.',
      'Mara runs the docks now, and she does not forgive old debts.',
      'Run her jobs, dodge the precinct, and take the city back — one block at a time.',
    ];
    for (let i = 0; i < intro.length; i += 1) {
      text(intro[i], cx, viewH * 0.42 + i * 24, 16, COLORS.text, 'center');
    }

    let my = viewH * 0.58;
    text('ENTER — New game', cx, my, 21, COLORS.marker, 'center', 700);
    my += 32;
    if (G.hasSave) {
      text('C — Continue', cx, my, 21, COLORS.text, 'center', 700);
      my += 24;
      if (G.saveSummary) text(G.saveSummary, cx, my, 13, COLORS.muted, 'center');
    }

    const controls = [
      'WASD / arrows — move & drive      E — enter / exit car      Mouse — aim',
      'Click / J — attack      Shift — run      P — pause      M — mute',
    ];
    for (let i = 0; i < controls.length; i += 1) {
      text(controls[i], cx, viewH - 52 + i * 20, 13, COLORS.muted, 'center');
    }
  }

  function drawPaused() {
    darken(0.45);
    const box = centerPanel(340, 150);
    text('Paused', viewW / 2, box.y + 62, 34, COLORS.text, 'center', 700);
    text('Press P to resume.', viewW / 2, box.y + 102, 15, COLORS.muted, 'center');
  }

  function drawBusted() {
    ctx.fillStyle = 'rgba(140, 16, 16, 0.30)';
    ctx.fillRect(0, 0, viewW, viewH);
    const box = centerPanel(460, 170);
    text('BUSTED', viewW / 2, box.y + 68, 40, COLORS.danger, 'center', 800);
    text('The precinct takes its cut. Press Enter.', viewW / 2, box.y + 112, 16, COLORS.text, 'center');
  }

  function drawWasted() {
    ctx.fillStyle = 'rgba(60, 4, 4, 0.45)';
    ctx.fillRect(0, 0, viewW, viewH);
    const box = centerPanel(460, 170);
    text('WASTED', viewW / 2, box.y + 68, 40, '#ff6b5e', 'center', 800);
    text('The hospital patches you up. Press Enter.', viewW / 2, box.y + 112, 16, COLORS.text, 'center');
  }

  function drawFailed(G) {
    darken(0.5);
    const box = centerPanel(480, 180);
    text('Mission failed', viewW / 2, box.y + 62, 32, COLORS.danger, 'center', 800);
    const reason = G.failReason || 'The job fell apart.';
    const lines = wrap(reason, 420, 16);
    for (let i = 0; i < lines.length; i += 1) {
      text(lines[i], viewW / 2, box.y + 98 + i * 21, 16, COLORS.text, 'center');
    }
    text('Press Enter to retry.', viewW / 2, box.y + box.h - 22, 15, COLORS.muted, 'center');
  }

  function drawWin(G) {
    darken(0.5);
    const box = centerPanel(540, 190);
    text('PORT SOLENNE IS YOURS', viewW / 2, box.y + 66, 32, COLORS.marker, 'center', 800);
    text('Cash on hand: ' + moneyLabel(G.money), viewW / 2, box.y + 106, 17, COLORS.text, 'center');
    text('Free roam — press Enter to keep cruising.', viewW / 2, box.y + 140, 15, COLORS.muted, 'center');
  }

  // ---- frame --------------------------------------------------------------

  function draw(G, screen, mission) {
    G.canvasW = viewW;
    G.canvasH = viewH;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.backdrop;
    ctx.fillRect(0, 0, viewW, viewH);

    const shake = G.shake || 0;
    const shakeX = shake ? (Math.random() * 2 - 1) * shake : 0;
    const shakeY = shake ? (Math.random() * 2 - 1) * shake : 0;

    drawWorldPass(G, mission, shakeX, shakeY);
    drawScreenFx(G);

    if (screen === SCREEN_TITLE) {
      drawTitle(G);
      return;
    }
    drawHud(G, mission);
    if (screen === SCREEN_PAUSED) drawPaused();
    else if (screen === SCREEN_BUSTED) drawBusted();
    else if (screen === SCREEN_WASTED) drawWasted();
    else if (screen === SCREEN_FAILED) drawFailed(G);
    else if (screen === SCREEN_WIN) drawWin(G);
  }

  return { draw };
}
