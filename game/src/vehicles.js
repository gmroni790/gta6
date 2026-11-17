// Vehicles for Sunset Bay: low-poly procedural cars, road traffic, and arcade
// player driving. Every car is built from shared box/cylinder geometries and
// cached materials, so a full street of traffic stays cheap to draw.
//
// HEADING CONVENTION: heading is in radians, 0 = facing +z (south on the grid
// as three.js sees it). The forward vector is (sin(heading), 0, cos(heading))
// and the mesh is always kept at mesh.rotation.y = heading. Increasing the
// heading turns the car to its LEFT (toward +x when facing +z); pressing D
// (steer right) therefore decreases the heading. Car models are built with
// their front (headlights, windshield) at the +z end, so rotation.y = heading
// is consistent everywhere: traffic steering, player driving, moveVehicle.

import * as THREE from 'three';
import { CITY_HALF, ROAD_SPACING, ROAD_WIDTH, AVENUES, STREETS, COLORS, TUNING } from './config.js';
import { createRandom } from './random.js';

// Right-hand lane offset: a quarter of the road width (3m) from the centre line.
const LANE_OFFSET = ROAD_WIDTH / 4;
// Traffic target count, and the distance from the player at which a traffic
// car is recycled for a fresh one nearer the player.
const TRAFFIC_COUNT = 18;
const DESPAWN_DIST = 130;
// Collision radius used against building AABBs (car half-width plus margin).
const COLLIDE_R = 1.5;
// Fastest reverse speed (m/s).
const REVERSE_MAX = 10;
// Grid edge: the outermost avenues/streets sit at +/-240.
const GRID_EDGE = 240;

// Per-type handling numbers. Sports cars use the global fastest-car cap.
const SPECS = {
  sedan: { maxSpeed: 36, accel: TUNING.carAccel, health: 100 },
  taxi: { maxSpeed: 36, accel: TUNING.carAccel, health: 100 },
  van: { maxSpeed: 30, accel: 10, health: 130 },
  sports: { maxSpeed: TUNING.carMaxSpeed, accel: 18, health: 90 },
  muscle: { maxSpeed: 40, accel: 16, health: 110 },
  police: { maxSpeed: 40, accel: 16, health: 120 },
  truck: { maxSpeed: 28, accel: 8, health: 160 },
};

// Per-type body dimensions (metres). w/l are the body footprint, cabinZ is how
// far back from the body centre the cabin sits (trucks put the cab at front).
const DIMS = {
  sedan: { w: 1.8, l: 4.4, bodyH: 0.62, cabinW: 1.6, cabinL: 2.2, cabinH: 0.55, wheelR: 0.34, cabinZ: -0.25 },
  taxi: { w: 1.8, l: 4.4, bodyH: 0.62, cabinW: 1.6, cabinL: 2.2, cabinH: 0.55, wheelR: 0.34, cabinZ: -0.25 },
  van: { w: 2.0, l: 5.0, bodyH: 0.95, cabinW: 1.85, cabinL: 3.6, cabinH: 0.75, wheelR: 0.38, cabinZ: -0.3 },
  sports: { w: 1.9, l: 4.3, bodyH: 0.5, cabinW: 1.6, cabinL: 1.9, cabinH: 0.45, wheelR: 0.33, cabinZ: -0.2 },
  muscle: { w: 1.9, l: 4.6, bodyH: 0.65, cabinW: 1.6, cabinL: 2.0, cabinH: 0.5, wheelR: 0.36, cabinZ: -0.3 },
  police: { w: 1.8, l: 4.4, bodyH: 0.62, cabinW: 1.6, cabinL: 2.2, cabinH: 0.55, wheelR: 0.34, cabinZ: -0.25 },
  truck: { w: 2.2, l: 6.2, bodyH: 0.8, cabinW: 2.0, cabinL: 1.8, cabinH: 1.0, wheelR: 0.45, cabinZ: 1.9 },
};

const DEFAULT_COLORS = {
  sedan: 0xc83232,
  taxi: 0xf2c200,
  van: 0xd8d8d8,
  sports: 0xc83232,
  muscle: 0x3268c8,
  police: COLORS.police,
  truck: 0xe8e8e8,
};

function defaultColor(type) {
  return DEFAULT_COLORS[type] !== undefined ? DEFAULT_COLORS[type] : 0x8899aa;
}

// ---- shared geometry / material caches (one per size or colour) ----

const boxGeoCache = new Map();
function boxGeo(w, h, d) {
  const key = w + ',' + h + ',' + d;
  let g = boxGeoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    boxGeoCache.set(key, g);
  }
  return g;
}

const wheelGeoCache = new Map();
function wheelGeo(r, w) {
  const key = r + ',' + w;
  let g = wheelGeoCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(r, r, w, 12);
    wheelGeoCache.set(key, g);
  }
  return g;
}

const paintCache = new Map();
function paintMaterial(color) {
  let m = paintCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.35 });
    paintCache.set(color, m);
  }
  return m;
}

const glassMat = new THREE.MeshStandardMaterial({ color: 0x18242e, metalness: 0.9, roughness: 0.15 });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.0, roughness: 0.95 });
const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6cc, emissive: 0xfff2b0, emissiveIntensity: 1.2 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2211, emissiveIntensity: 1.0 });
const signMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, emissive: 0xaa8800, emissiveIntensity: 0.6 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x14141a, metalness: 0.4, roughness: 0.6 });

// A single box part of a car, pre-tagged for combat raycasts. `ref` is null
// here (createCarMesh is pure); spawnVehicle fills it in with the vehicle.
function part(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.userData = { type: 'car', ref: null };
  return m;
}

/**
 * Build a low-poly car model: body box + cabin box + dark window boxes +
 * 4 cylinder wheels in steering pivots + emissive headlight/taillight boxes.
 * Taxi gets a yellow roof sign; police gets a red/blue light bar. The front
 * of the car (headlights) is at the +z end, matching the heading convention.
 * Pure: no scene, no rng, no vehicle object. The returned group's userData
 * carries wheels, steerPivots (front pivots), wheelRadius and, for police
 * cars, policeLights { red, blue } so police.js can flash them.
 */
export function createCarMesh(type, color) {
  const dims = DIMS[type] || DIMS.sedan;
  const paint = paintMaterial(color !== undefined ? color : defaultColor(type));
  const group = new THREE.Group();

  const bodyBottom = 0.22;
  const bodyY = bodyBottom + dims.bodyH / 2;
  const cabinY = bodyBottom + dims.bodyH - 0.06 + dims.cabinH / 2;

  // Body and cabin.
  group.add(part(boxGeo(dims.w, dims.bodyH, dims.l), paint, 0, bodyY, 0));
  group.add(part(boxGeo(dims.cabinW, dims.cabinH, dims.cabinL), paint, 0, cabinY, dims.cabinZ));
  // Windows: a glass band through the cabin (reads as side windows on both
  // sides) plus a tilted windshield at the front of the cabin.
  group.add(part(
    boxGeo(dims.cabinW + 0.04, dims.cabinH * 0.55, dims.cabinL * 0.88),
    glassMat, 0, cabinY + dims.cabinH * 0.08, dims.cabinZ,
  ));
  const shield = part(
    boxGeo(dims.cabinW * 0.9, dims.cabinH * 0.62, 0.06),
    glassMat, 0, cabinY + 0.02, dims.cabinZ + dims.cabinL / 2 + 0.03,
  );
  shield.rotation.x = -0.35;
  group.add(shield);

  // Trucks carry a cargo box behind the cab.
  if (type === 'truck') {
    group.add(part(boxGeo(2.1, 1.7, 3.6), paint, 0, bodyBottom + dims.bodyH + 0.75, -1.15));
  }

  // Headlights (front, +z) and taillights (rear, -z), two small boxes each.
  const lx = dims.w / 2 - 0.28;
  group.add(part(boxGeo(0.36, 0.15, 0.08), headMat, -lx, bodyY + 0.05, dims.l / 2 + 0.02));
  group.add(part(boxGeo(0.36, 0.15, 0.08), headMat, lx, bodyY + 0.05, dims.l / 2 + 0.02));
  group.add(part(boxGeo(0.36, 0.15, 0.08), tailMat, -lx, bodyY + 0.05, -dims.l / 2 - 0.02));
  group.add(part(boxGeo(0.36, 0.15, 0.08), tailMat, lx, bodyY + 0.05, -dims.l / 2 - 0.02));

  // Roof furniture.
  const roofY = cabinY + dims.cabinH / 2;
  if (type === 'taxi') {
    group.add(part(boxGeo(0.55, 0.14, 0.26), signMat, 0, roofY + 0.07, dims.cabinZ));
  }
  let policeLights = null;
  if (type === 'police') {
    group.add(part(boxGeo(0.95, 0.07, 0.32), darkMat, 0, roofY + 0.04, dims.cabinZ));
    // Light-bar materials are per-car (not shared) so police.js can flash
    // each car's lights independently.
    const redMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2020, emissiveIntensity: 1.5 });
    const blueMat = new THREE.MeshStandardMaterial({ color: 0x000033, emissive: 0x2040ff, emissiveIntensity: 1.5 });
    const red = part(boxGeo(0.42, 0.13, 0.3), redMat, -0.24, roofY + 0.12, dims.cabinZ);
    const blue = part(boxGeo(0.42, 0.13, 0.3), blueMat, 0.24, roofY + 0.12, dims.cabinZ);
    group.add(red);
    group.add(blue);
    policeLights = { red, blue };
  }

  // Wheels: each wheel sits in a pivot group so the front pair can yaw for
  // steering. The cylinder's axis is Y, so rotation.z = PI/2 lays it across
  // the car (axle along X); spinning is then rotation.x (see updateWheels).
  const wheels = [];
  const steerPivots = [];
  const wgeo = wheelGeo(dims.wheelR, 0.28);
  const wx = dims.w / 2 - 0.02;
  const wz = dims.l * 0.32;
  const spots = [
    [-wx, wz, true], [wx, wz, true],
    [-wx, -wz, false], [wx, -wz, false],
  ];
  for (let i = 0; i < spots.length; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(spots[i][0], dims.wheelR, spots[i][1]);
    pivot.userData = { type: 'car', ref: null };
    const wheel = new THREE.Mesh(wgeo, tireMat);
    wheel.rotation.set(0, 0, Math.PI / 2);
    wheel.userData = { type: 'car', ref: null };
    pivot.add(wheel);
    group.add(pivot);
    wheels.push(wheel);
    if (spots[i][2]) steerPivots.push(pivot);
  }

  group.userData = {
    type: 'car',
    ref: null,
    wheels,
    steerPivots,
    wheelRadius: dims.wheelR,
  };
  if (policeLights) group.userData.policeLights = policeLights;
  return group;
}

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * The right-hand-lane point for a road. axis 'z' = avenue at x=at, travel
 * along z; axis 'x' = street at z=at, travel along x. `along` is the
 * coordinate in the direction of travel. Facing +z, right is -x; facing +x,
 * right is +z, which gives the offsets below.
 */
function lanePoint(axis, at, dir, along) {
  if (axis === 'z') return { x: at + (dir > 0 ? -LANE_OFFSET : LANE_OFFSET), z: along };
  return { x: along, z: at + (dir > 0 ? LANE_OFFSET : -LANE_OFFSET) };
}

/** Create the vehicles module. G is the shared context (scene, rng, city...). */
export function createVehicles(G) {
  const all = [];
  const traffic = [];
  let currentPlayer = null;

  // Fallback rng (fixed seed) if G.rng is not wired yet; normally G.rng.
  const fallbackRng = createRandom(1337);
  function rng() {
    return G.rng || fallbackRng;
  }

  // Reused scratch vector for effect positions (no per-frame allocation).
  const scratch = new THREE.Vector3();

  // Where the player is, as {x, z}, or null if the player is not wired yet.
  function playerPos() {
    if (G.player && G.player.position) {
      return { x: G.player.position.x, z: G.player.position.z };
    }
    if (G.city && G.city.spawnPoints && G.city.spawnPoints.playerStart) {
      return G.city.spawnPoints.playerStart;
    }
    return null;
  }

  // ---- damage / destruction ----

  function removeVehicle(v) {
    if (G.scene) G.scene.remove(v.mesh);
    const ai = all.indexOf(v);
    if (ai !== -1) all.splice(ai, 1);
    const ti = traffic.indexOf(v);
    if (ti !== -1) traffic.splice(ti, 1);
    if (currentPlayer === v) currentPlayer = null;
  }

  function explodeVehicle(v) {
    if (v.dead) return;
    v.dead = true;
    const wasPlayer = v.isPlayer;
    const px = v.mesh.position.x;
    const pz = v.mesh.position.z;
    // Get the player out first, while the car still exists to step beside.
    if (wasPlayer) {
      if (G.player && typeof G.player.exitVehicle === 'function') {
        try {
          G.player.exitVehicle();
        } catch (err) {
          // exitVehicle must never block the explosion cleanup.
          v.isPlayer = false;
        }
      } else {
        // No exit hook: just clear the flag and let player.js handle it.
        v.isPlayer = false;
      }
      if (currentPlayer === v) currentPlayer = null;
      if (G.audio && typeof G.audio.engine === 'function') G.audio.engine(0, false);
    }
    if (G.effects && typeof G.effects.explosion === 'function') {
      scratch.set(px, 0.8, pz);
      G.effects.explosion(scratch);
    }
    if (G.audio && typeof G.audio.explosion === 'function') G.audio.explosion();
    if (G.peds && typeof G.peds.scatterAt === 'function') {
      scratch.set(px, 0, pz);
      G.peds.scatterAt(scratch, 25);
    }
    removeVehicle(v);
  }

  function damageVehicle(v, amount) {
    if (!v || v.dead) return;
    v.health -= amount;
    if (v.health <= 0) explodeVehicle(v);
  }

  // ---- movement ----

  function updateWheels(v, dt) {
    v.wheelAngle += (v.speed * dt) / v.wheelRadius;
    for (let i = 0; i < v.wheels.length; i++) {
      v.wheels[i].rotation.x = v.wheelAngle;
    }
    for (let i = 0; i < v.steerPivots.length; i++) {
      v.steerPivots[i].rotation.y = v.steerVisual;
    }
  }

  /**
   * Advance vehicle v by its heading and speed for dt seconds, spinning its
   * wheels. On a building hit it tries to slide along the wall; if fully
   * blocked it stops, takes a little damage, and returns true. Also clamps
   * to the city bounds. Returns true if the vehicle collided, false otherwise.
   */
  function moveVehicle(v, dt) {
    if (!v || v.dead) return false;
    const step = v.speed * dt;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const px = v.mesh.position.x;
    const pz = v.mesh.position.z;
    let nx = px + fx * step;
    let nz = pz + fz * step;
    let collided = false;
    const city = G.city;
    if (city && typeof city.collides === 'function' && step !== 0) {
      if (city.collides(nx, nz, COLLIDE_R)) {
        const slideX = !city.collides(nx, pz, COLLIDE_R);
        const slideZ = !city.collides(px, nz, COLLIDE_R);
        if (slideX && slideZ) {
          // Both axes free on their own: keep the bigger component (slide).
          if (Math.abs(nx - px) >= Math.abs(nz - pz)) nz = pz;
          else nx = px;
          collided = true;
        } else if (slideX) {
          nz = pz;
          collided = true;
        } else if (slideZ) {
          nx = px;
          collided = true;
        } else {
          // Fully blocked: stop, small damage, sparks on a hard hit.
          if (Math.abs(v.speed) > 2) {
            damageVehicle(v, Math.min(12, 3 + Math.abs(v.speed) * 0.3));
          }
          if (Math.abs(v.speed) > 4 && G.effects && typeof G.effects.sparks === 'function') {
            scratch.set(px + fx * 2, 0.6, pz + fz * 2);
            G.effects.sparks(scratch);
          }
          v.speed = 0;
          v.drift = 0;
          updateWheels(v, dt);
          return true;
        }
        // A glancing slide scrubs a little speed.
        v.speed *= 0.92;
      }
    }
    const lim = CITY_HALF - 2;
    if (nx > lim || nx < -lim || nz > lim || nz < -lim) {
      nx = clamp(nx, -lim, lim);
      nz = clamp(nz, -lim, lim);
      v.speed = 0;
      v.drift = 0;
      collided = true;
    }
    v.mesh.position.x = nx;
    v.mesh.position.z = nz;
    v.mesh.rotation.y = v.heading;
    updateWheels(v, dt);
    return collided;
  }

  // ---- traffic AI ----

  // The next intersection ahead of v on its current road, as a lane-offset
  // target point. Carries the grid coordinates (gx, gz) of that intersection
  // so chooseNextTarget knows where the car is turning from.
  function nextIntersectionTarget(v) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const axis = v.road.axis;
      const at = v.road.at;
      const dir = v.dir;
      const lines = axis === 'z' ? STREETS : AVENUES;
      const along = axis === 'z' ? v.mesh.position.z : v.mesh.position.x;
      let next = null;
      if (dir > 0) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] > along + 1) { next = lines[i]; break; }
        }
      } else {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] < along - 1) { next = lines[i]; break; }
        }
      }
      if (next !== null) {
        const p = lanePoint(axis, at, dir, next);
        return {
          x: p.x,
          z: p.z,
          gx: axis === 'z' ? at : next,
          gz: axis === 'z' ? next : at,
        };
      }
      // No intersection ahead (road end): reverse direction and try again.
      v.dir = -dir;
      v.heading = wrapAngle(v.heading + Math.PI);
      v.mesh.rotation.y = v.heading;
      const lane = lanePoint(axis, at, v.dir, along);
      v.mesh.position.x = lane.x;
      v.mesh.position.z = lane.z;
    }
    // Unreachable on this grid; head for the centre rather than stalling.
    return { x: 0, z: 0, gx: 0, gz: 0 };
  }

  // Work out which road v is on from its position/heading, snap it onto the
  // correct right-hand lane, and give it a cruise speed and first target.
  function initTrafficCar(v) {
    const city = G.city;
    if (!city) {
      v._trafficPending = true;
      return;
    }
    const x = v.mesh.position.x;
    const z = v.mesh.position.z;
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    let axis;
    let dir;
    if (Math.abs(s) >= Math.abs(c)) {
      axis = 'x';
      dir = s > 0 ? 1 : -1;
    } else {
      axis = 'z';
      dir = c > 0 ? 1 : -1;
    }
    const lines = axis === 'z' ? AVENUES : STREETS;
    const across = axis === 'z' ? x : z;
    let at = lines[0];
    let best = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const d = Math.abs(lines[i] - across);
      if (d < best) {
        best = d;
        at = lines[i];
      }
    }
    v.road = { axis, at };
    v.dir = dir;
    const along = axis === 'z' ? z : x;
    const lane = lanePoint(axis, at, dir, along);
    v.mesh.position.x = lane.x;
    v.mesh.position.z = lane.z;
    v.heading = axis === 'z' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    v.mesh.rotation.y = v.heading;
    v.cruise = rng().range(TUNING.trafficSpeed - 2, TUNING.trafficSpeed + 2);
    v.speed = v.cruise;
    v.target = nextIntersectionTarget(v);
    v._trafficPending = false;
  }

  // At an intersection, pick the next leg: mostly straight, otherwise a
  // left/right turn onto the cross road (only turns that stay on the grid).
  function chooseNextTarget(v) {
    const r = rng();
    const gx = v.target.gx;
    const gz = v.target.gz;
    const axis = v.road.axis;
    const at = v.road.at;
    const dir = v.dir;
    const alongCoord = axis === 'z' ? gz : gx;
    const nextAlong = alongCoord + dir * ROAD_SPACING;
    const straightOK = Math.abs(nextAlong) <= GRID_EDGE;
    if (straightOK && r.next() < 0.55) {
      const p = lanePoint(axis, at, dir, nextAlong);
      v.target = {
        x: p.x,
        z: p.z,
        gx: axis === 'z' ? at : nextAlong,
        gz: axis === 'z' ? nextAlong : at,
      };
      return;
    }
    const turns = [];
    // +1 = left (heading +90 degrees), -1 = right.
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      const newHeading = wrapAngle(v.heading + side * Math.PI / 2);
      const newAxis = axis === 'z' ? 'x' : 'z';
      const newAt = axis === 'z' ? gz : gx;
      let newDir;
      if (newAxis === 'x') newDir = Math.sin(newHeading) > 0 ? 1 : -1;
      else newDir = Math.cos(newHeading) > 0 ? 1 : -1;
      const crossAlong = newAxis === 'x' ? gx : gz;
      const next2 = crossAlong + newDir * ROAD_SPACING;
      if (Math.abs(next2) <= GRID_EDGE) {
        turns.push({ newAxis, newAt, newDir, next2 });
      }
    }
    if (turns.length > 0) {
      const t = r.pick(turns);
      v.road = { axis: t.newAxis, at: t.newAt };
      v.dir = t.newDir;
      const p = lanePoint(t.newAxis, t.newAt, t.newDir, t.next2);
      v.target = {
        x: p.x,
        z: p.z,
        gx: t.newAxis === 'z' ? t.newAt : t.next2,
        gz: t.newAxis === 'z' ? t.next2 : t.newAt,
      };
      return;
    }
    if (straightOK) {
      const p = lanePoint(axis, at, dir, nextAlong);
      v.target = {
        x: p.x,
        z: p.z,
        gx: axis === 'z' ? at : nextAlong,
        gz: axis === 'z' ? nextAlong : at,
      };
      return;
    }
    // No legal leg (cannot happen on this grid): U-turn and carry on.
    v.dir = -dir;
    v.heading = wrapAngle(v.heading + Math.PI);
    v.target = nextIntersectionTarget(v);
  }

  // Distance to the nearest vehicle ahead of `car` in its lane (bumper gap),
  // or null if the road ahead is clear.
  function carAheadDist(car) {
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const cx = car.mesh.position.x;
    const cz = car.mesh.position.z;
    let best = null;
    for (let i = 0; i < all.length; i++) {
      const other = all[i];
      if (other === car || other.dead) continue;
      const rx = other.mesh.position.x - cx;
      const rz = other.mesh.position.z - cz;
      const forward = rx * fx + rz * fz;
      if (forward <= 0 || forward >= 16) continue;
      const lateral = Math.abs(rx * fz - rz * fx);
      if (lateral > 2.4) continue;
      const gap = forward - 2;
      if (best === null || gap < best) best = gap;
    }
    return best;
  }

  function updateTraffic(dt) {
    const pp = playerPos();
    for (let i = traffic.length - 1; i >= 0; i--) {
      const car = traffic[i];
      if (car.dead) continue;
      // Recycle cars that have driven far from the player.
      if (pp) {
        const dx = car.mesh.position.x - pp.x;
        const dz = car.mesh.position.z - pp.z;
        if (dx * dx + dz * dz > DESPAWN_DIST * DESPAWN_DIST) {
          removeVehicle(car);
          continue;
        }
      }
      if (car._trafficPending) {
        if (G.city) initTrafficCar(car);
        else continue;
      }
      if (!car.target) {
        car.target = nextIntersectionTarget(car);
      }
      // Reached the target intersection: pick the next leg.
      const tdx = car.target.x - car.mesh.position.x;
      const tdz = car.target.z - car.mesh.position.z;
      if (tdx * tdx + tdz * tdz < 25) chooseNextTarget(car);
      // Steer toward the target, at a limited turn rate.
      const desired = Math.atan2(
        car.target.x - car.mesh.position.x,
        car.target.z - car.mesh.position.z,
      );
      const diff = wrapAngle(desired - car.heading);
      const maxTurn = 2.2 * dt;
      car.heading += clamp(diff, -maxTurn, maxTurn);
      car.steerVisual = clamp(wrapAngle(desired - car.heading) * 1.5, -0.45, 0.45);
      // Speed: cruise, slower in turns, slower/stopped for a car ahead.
      let targetSpeed = car.cruise;
      if (Math.abs(wrapAngle(desired - car.heading)) > 0.5) {
        targetSpeed = Math.min(targetSpeed, 7);
      }
      const ahead = carAheadDist(car);
      if (ahead !== null) {
        if (ahead < 6) targetSpeed = 0;
        else if (ahead < 14) targetSpeed = Math.min(targetSpeed, car.cruise * (ahead - 6) / 8);
      }
      if (car.speed < targetSpeed) car.speed = Math.min(targetSpeed, car.speed + 6 * dt);
      else car.speed = Math.max(targetSpeed, car.speed - 12 * dt);
      const hit = moveVehicle(car, dt);
      // Stuck against a building (e.g. clipped a corner mid-turn): put the
      // car back on the road instead of leaving it wedged.
      if (hit && Math.abs(car.speed) < 0.5 && G.city && typeof G.city.nearestRoadPoint === 'function') {
        const rp = G.city.nearestRoadPoint(car.mesh.position.x, car.mesh.position.z);
        car.mesh.position.x = rp.x;
        car.mesh.position.z = rp.z;
        initTrafficCar(car);
        car.speed = car.cruise * 0.5;
      }
    }
  }

  function spawnTrafficCar() {
    const r = rng();
    const near = playerPos() || { x: 0, z: 0 };
    let pt = null;
    // Prefer a road point 25-110m from the player so cars do not pop in
    // right next to them; fall back to whatever the last try gave.
    for (let attempt = 0; attempt < 10; attempt++) {
      const cand = G.city.randomRoadPoint(r);
      pt = cand;
      const dx = cand.x - near.x;
      const dz = cand.z - near.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 25 * 25 && d2 < 110 * 110) break;
    }
    const type = r.pick(['sedan', 'sedan', 'sedan', 'taxi', 'van', 'sports', 'muscle', 'truck']);
    const color = type === 'taxi' ? 0xf2c200 : r.pick(COLORS.car);
    spawnVehicle(type, pt.x, pt.z, pt.heading, { driver: 'traffic', color });
  }

  function ensureTraffic() {
    if (!G.city || typeof G.city.randomRoadPoint !== 'function') return;
    // Top up a few per frame so a burst of despawns never hitches one frame.
    let guard = 0;
    while (traffic.length < TRAFFIC_COUNT && guard < 4) {
      spawnTrafficCar();
      guard++;
    }
  }

  // ---- player driving ----

  function updatePlayerDriving(dt) {
    const pv = currentPlayer;
    if (!pv || pv.dead || !pv.isPlayer) return;
    if (!G.player || G.player.mode !== 'car') return;
    let steer = 0;
    let throttle = 0;
    if (G.input && typeof G.input.axis === 'function') {
      const a = G.input.axis();
      steer = a.x || 0;
      throttle = a.y || 0;
    }
    const handbrake = !!(G.input && G.input.keys && G.input.keys.has('Space'));
    const absSpeed = Math.abs(pv.speed);

    // Throttle / brake / reverse. (axis().y is +1 forward, -1 back.)
    if (throttle > 0) {
      if (pv.speed < pv.maxSpeed) pv.speed += pv.accel * throttle * dt;
    } else if (throttle < 0) {
      if (pv.speed > 0.5) pv.speed -= TUNING.carBrake * (-throttle) * dt;
      else pv.speed -= pv.accel * 0.55 * (-throttle) * dt;
      if (pv.speed < -REVERSE_MAX) pv.speed = -REVERSE_MAX;
    }
    // Drag plus coasting resistance when no pedal is pressed.
    pv.speed -= pv.speed * 0.22 * dt;
    if (throttle === 0) {
      const dec = 5 * dt;
      if (Math.abs(pv.speed) <= dec) pv.speed = 0;
      else pv.speed -= Math.sign(pv.speed) * dec;
    }
    if (pv.speed > pv.maxSpeed) pv.speed = pv.maxSpeed;

    // Steering: weaker at high speed, none when stationary, reversed when
    // reversing, sharper with the handbrake. D (steer +1) turns right, which
    // decreases the heading (see the convention note at the top).
    const speedFactor = 1 / (1 + absSpeed * 0.045);
    const lowSpeedFactor = Math.min(1, absSpeed / 5);
    const dirSign = pv.speed >= 0 ? 1 : -1;
    let turnRate = TUNING.carTurn * speedFactor * lowSpeedFactor;
    if (handbrake) turnRate *= 1.6;
    pv.heading -= steer * turnRate * dirSign * dt;
    pv.mesh.rotation.y = pv.heading;
    pv.steerVisual = -steer * 0.42 * speedFactor;

    // Handbrake drift: strong decel, the rear slides out away from the turn,
    // and skid marks are left behind.
    if (handbrake && absSpeed > 4) {
      pv.speed -= Math.sign(pv.speed) * 9 * dt;
      const driftTarget = -steer * absSpeed * 0.35;
      pv.drift += (driftTarget - pv.drift) * Math.min(1, 4 * dt);
      if (G.effects && typeof G.effects.skid === 'function') {
        G.effects.skid(pv.mesh.position, pv.heading);
      }
    } else {
      pv.drift *= Math.max(0, 1 - 4 * dt);
    }

    moveVehicle(pv, dt);
    if (pv.dead) return; // moveVehicle damage may have blown the car up.

    // Lateral drift slide (checked against buildings, like the main move).
    if (Math.abs(pv.drift) > 0.2) {
      const rx = -Math.cos(pv.heading);
      const rz = Math.sin(pv.heading);
      const nx = pv.mesh.position.x + rx * pv.drift * dt;
      const nz = pv.mesh.position.z + rz * pv.drift * dt;
      if (G.city && typeof G.city.collides === 'function' && G.city.collides(nx, nz, COLLIDE_R)) {
        pv.drift = 0;
      } else {
        const lim = CITY_HALF - 2;
        pv.mesh.position.x = clamp(nx, -lim, lim);
        pv.mesh.position.z = clamp(nz, -lim, lim);
      }
    }

    if (G.audio && typeof G.audio.engine === 'function') {
      G.audio.engine(Math.min(1, Math.abs(pv.speed) / pv.maxSpeed), true);
    }
  }

  // ---- car-vs-car collisions ----

  // Damage is applied after the pass (via this queue) so an exploding car
  // being spliced out of `all` cannot corrupt the pair loop.
  const pendingDamage = [];

  function resolveCarCollisions() {
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (a.dead) continue;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (b.dead) continue;
        const dx = b.mesh.position.x - a.mesh.position.x;
        const dz = b.mesh.position.z - a.mesh.position.z;
        const minD = 3.1;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const overlap = (minD - d) / 2;
        a.mesh.position.x -= nx * overlap;
        a.mesh.position.z -= nz * overlap;
        b.mesh.position.x += nx * overlap;
        b.mesh.position.z += nz * overlap;
        const relSpeed = Math.abs(a.speed - b.speed);
        const involvesPlayer = a.isPlayer || b.isPlayer;
        if (involvesPlayer && relSpeed > 2) {
          // The speed cut fires once per impact (the _hitT cooldown), not
          // every frame of an overlap: otherwise two touching cars grind
          // each other to a standstill and a chase dies on first contact.
          if (a._hitT <= 0 && b._hitT <= 0) {
            const dmg = Math.min(15, 2 + relSpeed * 0.4);
            pendingDamage.push([a, dmg]);
            pendingDamage.push([b, dmg]);
            a._hitT = 0.5;
            b._hitT = 0.5;
            a.speed *= 0.6;
            b.speed *= 0.6;
            if (G.effects && typeof G.effects.sparks === 'function') {
              scratch.set(
                (a.mesh.position.x + b.mesh.position.x) / 2,
                0.7,
                (a.mesh.position.z + b.mesh.position.z) / 2,
              );
              G.effects.sparks(scratch);
            }
          }
        } else {
          // A gentle touch nudges apart without damage. The slowdown fires
          // once per contact (the _hitT cooldown), not every frame of an
          // overlap: at x0.9 a frame, two cars resting against each other
          // grind to a standstill and a chase dies on first contact.
          if (a._hitT <= 0 && b._hitT <= 0) {
            a.speed *= 0.9;
            b.speed *= 0.9;
            a._hitT = 0.25;
            b._hitT = 0.25;
          }
        }
      }
    }
    while (pendingDamage.length > 0) {
      const entry = pendingDamage.pop();
      damageVehicle(entry[0], entry[1]);
    }
  }

  // ---- public API ----

  /**
   * Create a vehicle of `type` at (x, z) facing `heading`, add it to the
   * scene and the vehicle lists. opts: { color, driver ('traffic'|'player'|
   * 'police'|null), maxSpeed, accel, health }. Traffic cars get road AI.
   */
  function spawnVehicle(type, x, z, heading, opts) {
    const o = opts || {};
    const realType = SPECS[type] ? type : 'sedan';
    const spec = SPECS[realType];
    const color = o.color !== undefined ? o.color : defaultColor(realType);
    const mesh = createCarMesh(realType, color);
    mesh.position.set(x, 0, z);
    mesh.rotation.y = heading;
    const vehicle = {
      mesh,
      wheels: mesh.userData.wheels,
      steerPivots: mesh.userData.steerPivots,
      wheelRadius: mesh.userData.wheelRadius,
      type: realType,
      color,
      heading,
      speed: 0,
      get speedKmh() {
        return this.speed * 3.6;
      },
      health: o.health !== undefined ? o.health : spec.health,
      maxHealth: spec.health,
      maxSpeed: o.maxSpeed !== undefined ? o.maxSpeed : spec.maxSpeed,
      accel: o.accel !== undefined ? o.accel : spec.accel,
      isPlayer: false,
      driver: o.driver || null,
      // Internal state (not part of the contract shape).
      wheelAngle: 0,
      steerVisual: 0,
      drift: 0,
      cruise: TUNING.trafficSpeed,
      road: null,
      dir: 1,
      target: null,
      dead: false,
      _hitT: 0,
      _smokeT: 0,
      _trafficPending: false,
    };
    // Tag the group and every child mesh for combat raycasts.
    mesh.traverse((child) => {
      child.userData.type = 'car';
      child.userData.ref = vehicle;
    });
    if (G.scene) G.scene.add(mesh);
    all.push(vehicle);
    if (vehicle.driver === 'traffic') {
      traffic.push(vehicle);
      initTrafficCar(vehicle);
    }
    return vehicle;
  }

  function nearestDrivable(pos, maxDist) {
    let best = null;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < all.length; i++) {
      const v = all[i];
      if (v.dead) continue;
      const dx = v.mesh.position.x - pos.x;
      const dz = v.mesh.position.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = v;
      }
    }
    return best;
  }

  function setPlayerVehicle(v) {
    if (currentPlayer === v) return;
    if (currentPlayer) {
      currentPlayer.isPlayer = false;
      if (currentPlayer.driver === 'player') currentPlayer.driver = null;
    }
    currentPlayer = v || null;
    if (currentPlayer) {
      currentPlayer.isPlayer = true;
      currentPlayer.driver = 'player';
      const ti = traffic.indexOf(currentPlayer);
      if (ti !== -1) traffic.splice(ti, 1);
    } else if (G.audio && typeof G.audio.engine === 'function') {
      G.audio.engine(0, false);
    }
  }

  function update(dt) {
    const step = Math.min(dt, 0.05);
    ensureTraffic();
    updateTraffic(step);
    updatePlayerDriving(step);
    resolveCarCollisions();
    // Parked cars roll to a stop; smoke on battered cars; catch damage dealt
    // from outside this module (e.g. combat shooting a car).
    for (let i = all.length - 1; i >= 0; i--) {
      const v = all[i];
      if (v.dead) continue;
      v._hitT = Math.max(0, v._hitT - step);
      if (v.driver === null && !v.isPlayer && Math.abs(v.speed) > 0.05) {
        v.speed *= Math.max(0, 1 - 2.5 * step);
        if (Math.abs(v.speed) < 0.05) v.speed = 0;
        moveVehicle(v, step);
        if (v.dead) continue;
      }
      if (v.health <= 0) {
        explodeVehicle(v);
        continue;
      }
      if (v.health < 35) {
        v._smokeT -= step;
        if (v._smokeT <= 0) {
          v._smokeT = 0.3;
          if (G.effects && typeof G.effects.smoke === 'function') {
            scratch.set(v.mesh.position.x, 1.2, v.mesh.position.z);
            G.effects.smoke(scratch);
          }
        }
      }
    }
  }

  const api = {
    update,
    traffic,
    spawnVehicle,
    nearestDrivable,
    get playerVehicle() {
      return currentPlayer;
    },
    setPlayerVehicle,
    moveVehicle,
    all,
  };
  G.vehicles = api;

  // Seed the streets if the city is already wired; otherwise ensureTraffic
  // in update() fills them in once G.city appears.
  if (G.city && typeof G.city.randomRoadPoint === 'function') {
    for (let i = 0; i < TRAFFIC_COUNT; i++) spawnTrafficCar();
  }

  return api;
}
