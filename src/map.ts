/**
 * A simple Among Us / Skeld-inspired map: rectangular rooms joined by corridors.
 *
 * Walkability is modelled as a UNION of axis-aligned rectangles (rooms +
 * corridors). Collision keeps the player's body (a circle of `radius`) fully
 * inside that union. Corridors deliberately overlap the rooms they connect by
 * more than one body diameter, so the inset walkable regions stay linked and
 * the player can pass through every doorway.
 *
 * Coordinates are authored at a readable base scale and multiplied by SCALE, so
 * the whole map can be grown (making players smaller in comparison) from one
 * knob without re-authoring the layout.
 */

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present on rooms (drawn as a floor label); absent on corridors. */
  name?: string;
}

/** Global map scale. Player/crewmate size stays fixed, so a bigger map makes
 *  players appear smaller in comparison. */
export const SCALE = 2.6;

function scaleArea(a: Area): Area {
  return { ...a, x: a.x * SCALE, y: a.y * SCALE, w: a.w * SCALE, h: a.h * SCALE };
}

// ---- authored (base-scale) layout ----

const ROOMS_BASE: Area[] = [
  { name: "Cafeteria", x: 620, y: 120, w: 360, h: 260 },
  { name: "MedBay", x: 180, y: 200, w: 260, h: 200 },
  { name: "Electrical", x: 180, y: 560, w: 260, h: 240 },
  { name: "Storage", x: 640, y: 600, w: 320, h: 260 },
  { name: "Admin", x: 1040, y: 560, w: 220, h: 200 },
  { name: "Navigation", x: 1300, y: 220, w: 220, h: 220 },
];

const CORRIDORS_BASE: Area[] = [
  { x: 380, y: 245, w: 300, h: 90 }, // MedBay <-> Cafeteria
  { x: 920, y: 255, w: 440, h: 90 }, // Cafeteria <-> Navigation
  { x: 745, y: 320, w: 90, h: 340 }, // Cafeteria <-> Storage
  { x: 245, y: 340, w: 90, h: 280 }, // MedBay <-> Electrical
  { x: 380, y: 655, w: 320, h: 90 }, // Electrical <-> Storage
  { x: 900, y: 635, w: 200, h: 90 }, // Storage <-> Admin
  { x: 1105, y: 285, w: 90, h: 335 }, // Admin <-> Cafe/Nav corridor
];

const SPAWNS_BASE: { x: number; y: number }[] = [
  { x: 800, y: 250 }, { x: 760, y: 240 }, { x: 840, y: 240 },
  { x: 720, y: 260 }, { x: 880, y: 260 }, { x: 800, y: 300 },
  { x: 740, y: 300 }, { x: 860, y: 300 }, { x: 700, y: 230 },
  { x: 900, y: 230 }, { x: 680, y: 270 }, { x: 920, y: 270 },
  { x: 770, y: 340 }, { x: 830, y: 340 }, { x: 800, y: 200 },
];

// ---- scaled, exported layout ----

/** World size in pixels. */
export const WORLD = { width: 1700 * SCALE, height: 1000 * SCALE };

/** Named rooms (also rendered with a label). */
export const ROOMS: Area[] = ROOMS_BASE.map(scaleArea);

/** Corridors connecting the rooms. */
export const CORRIDORS: Area[] = CORRIDORS_BASE.map(scaleArea);

/** Everything the player may stand on. */
export const WALKABLE: Area[] = [...ROOMS, ...CORRIDORS];

/** Spawn points, clustered in the Cafeteria (the classic meeting room). */
export const SPAWNS: { x: number; y: number }[] = SPAWNS_BASE.map((p) => ({
  x: p.x * SCALE,
  y: p.y * SCALE,
}));

/** Back-compat handle used by main.ts (spawns) and the camera (bounds). */
export const MAP = { width: WORLD.width, height: WORLD.height, spawns: SPAWNS };

/** The emergency-meeting button, at the center of the Cafeteria (ROOMS[0]).
 *  Emergency meetings can only be called while standing next to it. */
export const EMERGENCY_BUTTON = {
  x: ROOMS[0].x + ROOMS[0].w / 2,
  y: ROOMS[0].y + ROOMS[0].h / 2,
};

// ---- doors ----

/** A door blocks the corridor it sits on when locked. */
export interface Door extends Area {
  id: string;
}

/** Where along each corridor its door sits (0 = start, 1 = end). Defaults to
 *  the middle; overridden per corridor to keep doors out of junctions. */
const DOOR_FRAC: Record<number, number> = {
  1: 0.82, // Cafeteria <-> Navigation: push the door toward Navigation, clear of
           // the Admin corridor junction instead of sitting mid-hallway.
};

/** One door across each corridor (locking it cuts the passage). */
const DOORS_BASE: Door[] = CORRIDORS_BASE.map((c, i) => {
  const T = 18; // door thickness along the corridor axis
  const horizontal = c.w >= c.h;
  const f = DOOR_FRAC[i] ?? 0.5;
  return horizontal
    ? { id: "d" + i, x: c.x + c.w * f - T / 2, y: c.y, w: T, h: c.h }
    : { id: "d" + i, x: c.x, y: c.y + c.h * f - T / 2, w: c.w, h: T };
});

export const DOORS: Door[] = DOORS_BASE.map((d) => ({
  id: d.id,
  x: d.x * SCALE,
  y: d.y * SCALE,
  w: d.w * SCALE,
  h: d.h * SCALE,
}));

/**
 * True if a body of `radius` centered at (x, y) fits inside walkable space and
 * is clear of every blocker (e.g. locked doors), which act as solid walls.
 */
export function inWalkable(
  x: number,
  y: number,
  radius: number,
  blockers: Area[] = [],
): boolean {
  let inside = false;
  for (const a of WALKABLE) {
    if (x >= a.x + radius && x <= a.x + a.w - radius && y >= a.y + radius && y <= a.y + a.h - radius) {
      inside = true;
      break;
    }
  }
  if (!inside) return false;
  for (const b of blockers) {
    if (x >= b.x - radius && x <= b.x + b.w + radius && y >= b.y - radius && y <= b.y + b.h + radius) {
      return false;
    }
  }
  return true;
}

/**
 * Move from (fromX, fromY) toward (toX, toY), resolving per-axis so the player
 * slides along walls instead of stopping dead. Returns the accepted position.
 */
export function moveWithCollision(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  blockers: Area[] = [],
): { x: number; y: number } {
  let x = fromX;
  let y = fromY;
  if (inWalkable(toX, y, radius, blockers)) x = toX; // try horizontal
  if (inWalkable(x, toY, radius, blockers)) y = toY; // then vertical from new x
  return { x, y };
}

// ---- vision (analytic raycast) ----

const RAY_MAX = Math.hypot(WORLD.width, WORLD.height);

/** t-interval [tin, tout] where the ray P+tD is inside rect `a`, or null. */
function raySlab(px: number, py: number, dx: number, dy: number, a: Area): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (px < a.x || px > a.x + a.w) return null;
  } else {
    let t1 = (a.x - px) / dx;
    let t2 = (a.x + a.w - px) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-9) {
    if (py < a.y || py > a.y + a.h) return null;
  } else {
    let t1 = (a.y - py) / dy;
    let t2 = (a.y + a.h - py) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < tmin) return null;
  return [tmin, tmax];
}

/**
 * Distance a beam from (px, py) in unit direction (dx, dy) travels before it
 * leaves walkable space or meets a blocker. Computed analytically (no stepping)
 * by merging the ray's inside-intervals across all walkable rects from t=0
 * until the first gap — giving smooth, jitter-free, effectively unbounded sight
 * that stops exactly at walls.
 */
export function rayDistance(
  px: number,
  py: number,
  dx: number,
  dy: number,
  blockers: Area[] = [],
): number {
  // Allocation-free fixpoint: repeatedly extend `reach` by any walkable rect
  // whose inside-interval touches the current reach, until nothing grows. No
  // arrays, no sort, no closures — keeps this cheap enough to run every frame
  // for a couple hundred beams (smooth, high-FPS vision).
  const EPS = 1e-2;
  let reach = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of WALKABLE) {
      const iv = raySlab(px, py, dx, dy, a);
      if (!iv) continue;
      const tin = iv[0] < 0 ? 0 : iv[0];
      if (iv[1] > reach && tin <= reach + EPS) {
        reach = iv[1];
        grew = true;
      }
    }
  }
  if (reach > RAY_MAX) reach = RAY_MAX;

  // A locked door stops the beam at its near face.
  for (const b of blockers) {
    const iv = raySlab(px, py, dx, dy, b);
    if (iv && iv[0] > 1e-4 && iv[0] < reach) reach = iv[0];
  }
  return reach;
}
