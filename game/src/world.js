// Solenne Heat — the city module: Port Solenne as a grid of blocks and roads.
//
// Pure data and geometry, no drawing, no browser, no network. Everything is
// built once in createWorld(rand) from the seeded rand() so a given seed
// always produces the same city (reproducible screenshot scenes included).
//
// Layout (see config.js):
//   - vertical roads are the x-bands   [i*pitch, i*pitch+road]  for i in 0..cols
//   - horizontal roads are the y-bands [j*pitch, j*pitch+road]  for j in 0..rows
//   - block (i, j) starts at (i*pitch+road, j*pitch+road) and is block x block
//   - blocks with i < cols/2 are the 'harbor' district, the rest are 'neon'

import { CITY, SIDEWALK, COLORS } from './config.js';

/** Gap left between neighbouring buildings inside a block, in px. */
const BUILDING_GAP = 10;

/** Fraction of blocks left as open lots (no buildings, maybe parking). */
const OPEN_LOT_CHANCE = 1 / 7;

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** In-place Fisher–Yates shuffle driven only by rand(), so it stays seeded. */
function shuffle(rand, list) {
  for (let k = list.length - 1; k > 0; k -= 1) {
    const swap = Math.floor(rand() * (k + 1));
    const tmp = list[k];
    list[k] = list[swap];
    list[swap] = tmp;
  }
  return list;
}

export function createWorld(rand) {
  const { cols, rows, block, road, pitch, width, height } = CITY;

  const roadX = (i) => i * pitch;
  const roadY = (j) => j * pitch;
  const blockX = (i) => i * pitch + road;
  const blockY = (j) => j * pitch + road;
  const districtForCol = (i) => (i < cols / 2 ? 'harbor' : 'neon');

  // -- Road band origins -----------------------------------------------------
  const vRoads = [];
  for (let i = 0; i <= cols; i += 1) vRoads.push(roadX(i));
  const hRoads = [];
  for (let j = 0; j <= rows; j += 1) hRoads.push(roadY(j));

  // -- Buildings -------------------------------------------------------------
  // Per block: inset by SIDEWALK, then fill the inner square with one layout
  // chosen at random — a single big building, two side by side, two stacked,
  // or a 2x2 group — with BUILDING_GAP px between neighbours. Roughly one
  // block in seven is skipped entirely and remembered as an open lot.
  const buildings = [];
  const openLots = []; // { i, j, x, y } — block origins with no buildings

  function addBuilding(x, y, w, h, district) {
    const palette = COLORS[district];
    const pick = Math.floor(rand() * palette.buildings.length);
    buildings.push({
      x,
      y,
      w,
      h,
      color: palette.buildings[pick],
      roof: palette.roofs[pick], // roof matched to the wall colour by index
      district,
      floors: 2 + Math.floor(rand() * 6), // 2..7 storeys, flavour for rendering
    });
  }

  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const bx = blockX(i);
      const by = blockY(j);
      const district = districtForCol(i);

      if (rand() < OPEN_LOT_CHANCE) {
        openLots.push({ i, j, x: bx, y: by });
        continue;
      }

      const ix = bx + SIDEWALK;
      const iy = by + SIDEWALK;
      const iw = block - SIDEWALK * 2;
      const ih = block - SIDEWALK * 2;
      const halfW = (iw - BUILDING_GAP) / 2;
      const halfH = (ih - BUILDING_GAP) / 2;
      const layout = Math.floor(rand() * 4);

      if (layout === 0) {
        // Single big building filling the inner square.
        addBuilding(ix, iy, iw, ih, district);
      } else if (layout === 1) {
        // Two side by side.
        addBuilding(ix, iy, halfW, ih, district);
        addBuilding(ix + halfW + BUILDING_GAP, iy, halfW, ih, district);
      } else if (layout === 2) {
        // Two stacked.
        addBuilding(ix, iy, iw, halfH, district);
        addBuilding(ix, iy + halfH + BUILDING_GAP, iw, halfH, district);
      } else {
        // 2x2 group.
        addBuilding(ix, iy, halfW, halfH, district);
        addBuilding(ix + halfW + BUILDING_GAP, iy, halfW, halfH, district);
        addBuilding(ix, iy + halfH + BUILDING_GAP, halfW, halfH, district);
        addBuilding(ix + halfW + BUILDING_GAP, iy + halfH + BUILDING_GAP, halfW, halfH, district);
      }
    }
  }

  // -- Props -----------------------------------------------------------------
  const props = [];

  // Lamps: one at (almost) every intersection, on a sidewalk corner just
  // outside the road bands. A corner offset of 8 px lands on the sidewalk
  // strip of the neighbouring block (buildings start SIDEWALK px in), so a
  // lamp never ends up inside a building. (cols+1)*(rows+1) = 42 lamps.
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const rx = roadX(i);
      const ry = roadY(j);
      const corners = [];
      if (i < cols && j < rows) corners.push({ x: rx + road + 8, y: ry + road + 8 }); // SE block's NW corner
      if (i > 0 && j > 0) corners.push({ x: rx - 8, y: ry - 8 }); // NW block's SE corner
      if (i < cols && j > 0) corners.push({ x: rx + road + 8, y: ry - 8 }); // NE block's SW corner
      if (i > 0 && j < rows) corners.push({ x: rx - 8, y: ry + road + 8 }); // SW block's NE corner
      const corner = corners[Math.floor(rand() * corners.length)];
      props.push({ x: corner.x, y: corner.y, kind: 'lamp' });
    }
  }

  // A point on a block's sidewalk edge: `edge` 0..3 = north, south, west,
  // east; 8 px in from the block edge, at a seeded position along the edge.
  function sidewalkPoint(bx, by, edge) {
    const along = SIDEWALK + rand() * (block - SIDEWALK * 2);
    if (edge === 0) return { x: bx + along, y: by + 8 };
    if (edge === 1) return { x: bx + along, y: by + block - 8 };
    if (edge === 2) return { x: bx + 8, y: by + along };
    return { x: bx + block - 8, y: by + along };
  }

  // Trees: build one candidate per block edge, shuffle, keep 50.
  const treeCandidates = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      for (let edge = 0; edge < 4; edge += 1) {
        const p = sidewalkPoint(blockX(i), blockY(j), edge);
        treeCandidates.push({ x: p.x, y: p.y, kind: 'tree' });
      }
    }
  }
  shuffle(rand, treeCandidates);
  for (let k = 0; k < 50 && k < treeCandidates.length; k += 1) props.push(treeCandidates[k]);

  // Benches: two candidates per block, shuffle, keep 20.
  const benchCandidates = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      for (let n = 0; n < 2; n += 1) {
        const p = sidewalkPoint(blockX(i), blockY(j), Math.floor(rand() * 4));
        benchCandidates.push({ x: p.x, y: p.y, kind: 'bench' });
      }
    }
  }
  shuffle(rand, benchCandidates);
  for (let k = 0; k < 20 && k < benchCandidates.length; k += 1) props.push(benchCandidates[k]);

  // Hydrants: one candidate per block at a block corner, shuffle, keep a sparse 8.
  const hydrantCandidates = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const corner = Math.floor(rand() * 4);
      hydrantCandidates.push({
        x: blockX(i) + (corner % 2 === 0 ? 8 : block - 8),
        y: blockY(j) + (corner < 2 ? 8 : block - 8),
        kind: 'hydrant',
      });
    }
  }
  shuffle(rand, hydrantCandidates);
  for (let k = 0; k < 8 && k < hydrantCandidates.length; k += 1) props.push(hydrantCandidates[k]);

  // -- Parking ---------------------------------------------------------------
  // Roadside slots sit at the road edge, aligned with the road: vertical
  // slots hug the right-hand kerb of a vertical road (angle PI/2, pointing
  // south), horizontal slots hug the top kerb of a horizontal road (angle
  // 0, pointing east). Candidates are split by district and filled evenly
  // so the ~26 slots spread across harbor and neon. Open lots contribute a
  // few slots first, counted toward their own district's share.
  const roadParkingWest = [];
  const roadParkingEast = [];
  for (let i = 0; i <= cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const slot = {
        x: roadX(i) + road - 14,
        y: blockY(j) + block / 2 + (rand() - 0.5) * 40,
        angle: Math.PI / 2,
      };
      (slot.x < width / 2 ? roadParkingWest : roadParkingEast).push(slot);
    }
  }
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const slot = {
        x: blockX(i) + block / 2 + (rand() - 0.5) * 40,
        y: roadY(j) + 14,
        angle: 0,
      };
      (slot.x < width / 2 ? roadParkingWest : roadParkingEast).push(slot);
    }
  }
  shuffle(rand, roadParkingWest);
  shuffle(rand, roadParkingEast);

  const lotParkingWest = [];
  const lotParkingEast = [];
  for (const lot of openLots) {
    const slot = { x: lot.x + block / 2, y: lot.y + block / 2, angle: 0 };
    (lot.i < cols / 2 ? lotParkingWest : lotParkingEast).push(slot);
  }
  shuffle(rand, lotParkingWest);
  shuffle(rand, lotParkingEast);

  const parking = [];
  function fillParking(lotPool, roadPool, target) {
    let added = 0;
    for (const slot of lotPool) {
      if (added >= Math.min(3, target)) break;
      parking.push(slot);
      added += 1;
    }
    for (const slot of roadPool) {
      if (added >= target) break;
      parking.push(slot);
      added += 1;
    }
  }
  fillParking(lotParkingWest, roadParkingWest, 13); // harbor half
  fillParking(lotParkingEast, roadParkingEast, 13); // neon half

  // -- Geometry helpers --------------------------------------------------------

  /** Centre of the intersection of vertical road i and horizontal road j. */
  function junction(i, j) {
    return { x: roadX(i) + road / 2, y: roadY(j) + road / 2 };
  }

  /** Block column a point belongs to; road points take the column to their east, clamped at the far edge. */
  function blockColAt(x) {
    return clamp(Math.floor(x / pitch), 0, cols - 1);
  }

  function districtAt(x, y) {
    // District is decided by column alone; y is part of the API for symmetry.
    void y;
    return districtForCol(blockColAt(x));
  }

  function isOnRoad(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return x % pitch < road || y % pitch < road;
  }

  function roadInfo(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const i = Math.floor(x / pitch);
    const j = Math.floor(y / pitch);
    const inV = x - i * pitch < road;
    const inH = y - j * pitch < road;
    if (inV && inH) return { axis: 'x', i, j };
    if (inV) return { axis: 'v', index: i };
    if (inH) return { axis: 'h', index: j };
    return null;
  }

  /**
   * Centre of the driving lane for a direction of travel, right-hand traffic.
   * For axis 'v' this returns an x coordinate, for axis 'h' a y coordinate.
   * dir is -1 or +1: on a vertical road +1 travels south, -1 north; on a
   * horizontal road +1 travels east, -1 west.
   */
  function laneCoord(axis, index, dir) {
    if (axis === 'v') {
      return roadX(index) + road * (dir > 0 ? 0.28 : 0.72);
    }
    return roadY(index) + road * (dir > 0 ? 0.72 : 0.28);
  }

  /**
   * Push a circle (centre x, y, radius r) out of every building and back
   * inside the world. Each building rect is expanded by r; if the centre
   * falls inside, it is pushed out along the smallest penetration axis.
   * Returns the corrected position as [nx, ny].
   */
  function collideCircle(x, y, r) {
    let nx = x;
    let ny = y;
    for (const b of buildings) {
      const ex0 = b.x - r;
      const ex1 = b.x + b.w + r;
      const ey0 = b.y - r;
      const ey1 = b.y + b.h + r;
      if (nx <= ex0 || nx >= ex1 || ny <= ey0 || ny >= ey1) continue;
      const pushLeft = nx - ex0;
      const pushRight = ex1 - nx;
      const pushUp = ny - ey0;
      const pushDown = ey1 - ny;
      const smallest = Math.min(pushLeft, pushRight, pushUp, pushDown);
      if (smallest === pushLeft) nx = ex0;
      else if (smallest === pushRight) nx = ex1;
      else if (smallest === pushUp) ny = ey0;
      else ny = ey1;
    }
    nx = clamp(nx, r, width - r);
    ny = clamp(ny, r, height - r);
    return [nx, ny];
  }

  /** True if the circle at (x, y) overlaps any building or leaves the world. */
  function pointBlocked(x, y, r) {
    if (x < r || x > width - r || y < r || y > height - r) return true;
    for (const b of buildings) {
      // Closest point on the rect to the centre; overlap if within r.
      const cx = clamp(x, b.x, b.x + b.w);
      const cy = clamp(y, b.y, b.y + b.h);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  // -- Named story locations ---------------------------------------------------
  // Every spot sits on a road or on a sidewalk, never inside a building:
  // drive-to spots use intersection / mid-road centres, on-foot spots use
  // sidewalk points at block corners (8 px in — buildings start at 16 px).
  const spots = {
    // Player start: sidewalk at the NW corner of the harbor block at col 0, row 2.
    playerStart: { x: blockX(0) + 8, y: blockY(2) + 8, label: 'Player start' },
    // Garage: NW intersection of the harbor block at col 1, row 3.
    garage: { ...junction(1, 3), label: 'Garage' },
    // Diner: NW intersection of the harbor block at col 2, row 1.
    diner: { ...junction(2, 1), label: 'Diner' },
    // Dock: middle of the far-west road, beside the block at col 0, row 4, near the bottom.
    dock: { x: roadX(0) + road / 2, y: blockY(4) + block / 2, label: 'Dock' },
    // Precinct: NW intersection of the harbor block at col 2, row 2.
    precinct: { ...junction(2, 2), label: 'Precinct' },
    // Hospital: NW intersection of the neon block at col 3, row 2.
    hospital: { ...junction(3, 2), label: 'Hospital' },
    // Hideout: sidewalk at the NW corner of the neon block at col 4, row 0, up at the top.
    hideout: { x: blockX(4) + 8, y: blockY(0) + 8, label: 'Hideout' },
    // Warehouse: sidewalk at the NW corner of the harbor block at col 0, row 4 — by the dock, but its own spot.
    warehouse: { x: blockX(0) + 8, y: blockY(4) + 8, label: 'Warehouse' },
    // Neon Plaza: NW intersection of the neon block at col 5, row 2.
    neonPlaza: { ...junction(5, 2), label: 'Neon Plaza' },
    // Van yard: NW intersection of the neon block at col 4, row 4.
    vanYard: { ...junction(4, 4), label: 'Van Yard' },
  };

  return {
    width,
    height,
    buildings,
    props,
    parking,
    spots,
    vRoads,
    hRoads,
    districtAt,
    isOnRoad,
    roadInfo,
    junction,
    laneCoord,
    collideCircle,
    pointBlocked,
  };
}
