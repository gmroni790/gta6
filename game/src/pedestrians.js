// Pedestrians for Sunset Bay: low-poly people strolling the sidewalks, who
// flee from gunshots, explosions and the player's car. Also exports
// createPersonMesh, the shared person builder missions.js uses for enemies.

import * as THREE from 'three';
import { AVENUES, STREETS, CITY_HALF, ROAD_WIDTH, SIDEWALK, TUNING } from './config.js';

const PED_COUNT = 40;
const PED_MAX = 48; // spawnFleeingPed may add a few beyond the base crowd
const SIDEWALK_OFFSET = ROAD_WIDTH / 2 + SIDEWALK / 2; // 7.5: centre of a sidewalk
const FLEE_SPEED = 5;
const RESPAWN_DIST = 130;
const DOWN_TIME = 6; // seconds a downed ped lies before being recycled

const SHIRTS = [0xc83232, 0x3268c8, 0xe8e8e8, 0x38a868, 0xe8a832,
  0x8832a8, 0x2a9a9a, 0xd870ad, 0x5a5a5a, 0x2e6b34, 0xd8d85a];
const PANTS = [0x2a3a5a, 0x3a3a3a, 0x5a4a3a, 0x223322, 0x6a6a7a, 0x4a3a5a];
const SKINS = [0xf0c8a0, 0xd8a070, 0xa07048, 0x8a5a30, 0xc89868, 0xe8b088];
const HAIR = [0x1a1a1a, 0x4a2a1a, 0x8a6a3a, 0xd8d8d8, 0x6a4a2a, 0x3a3a3a];

// Shared geometries: every person reuses the same boxes and sphere.
const torsoGeo = new THREE.BoxGeometry(0.44, 0.62, 0.26);
const headGeo = new THREE.SphereGeometry(0.15, 12, 10);
const hairGeo = new THREE.BoxGeometry(0.32, 0.1, 0.32);
const armGeo = new THREE.BoxGeometry(0.12, 0.62, 0.14);
const legGeo = new THREE.BoxGeometry(0.14, 0.8, 0.16);

/**
 * Build a ~1.8 m low-poly person: box torso/limbs, sphere head, hair cap.
 * `opts` may carry { shirt, pants, skin, hair } colours; anything missing is
 * picked from the palettes with `rng`. The returned Group has
 * userData.limbs = { armL, armR, legL, legR } (pivot groups for walk
 * animation) and every mesh is tagged userData.type = 'ped' so combat
 * raycasts can recognise it.
 */
export function createPersonMesh(rng, opts = {}) {
  const shirt = opts.shirt !== undefined ? opts.shirt : rng.pick(SHIRTS);
  const pants = opts.pants !== undefined ? opts.pants : rng.pick(PANTS);
  const skin = opts.skin !== undefined ? opts.skin : rng.pick(SKINS);
  const hairColor = opts.hair !== undefined ? opts.hair : rng.pick(HAIR);

  const shirtMat = new THREE.MeshLambertMaterial({ color: shirt });
  const pantsMat = new THREE.MeshLambertMaterial({ color: pants });
  const skinMat = new THREE.MeshLambertMaterial({ color: skin });
  const hairMat = new THREE.MeshLambertMaterial({ color: hairColor });

  const group = new THREE.Group();

  const torso = new THREE.Mesh(torsoGeo, shirtMat);
  torso.position.y = 1.13;
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 1.6;
  const hair = new THREE.Mesh(hairGeo, hairMat);
  hair.position.y = 1.71;

  // A limb is a pivot group at the joint with the box hanging below it, so
  // rotating the pivot swings the limb from the shoulder/hip.
  function limb(geo, mat, x, y, drop) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -drop;
    pivot.add(mesh);
    return pivot;
  }
  const armL = limb(armGeo, shirtMat, -0.29, 1.38, 0.28);
  const armR = limb(armGeo, shirtMat, 0.29, 1.38, 0.28);
  const legL = limb(legGeo, pantsMat, -0.11, 0.82, 0.4);
  const legR = limb(legGeo, pantsMat, 0.11, 0.82, 0.4);

  group.add(torso, head, hair, armL, armR, legL, legR);
  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.userData.type = 'ped';
    }
  });
  group.userData.limbs = { armL, armR, legL, legR };
  group.userData.type = 'ped';
  return group;
}

// Turn `current` toward `target` by at most `maxStep` radians, wrapping.
function turnToward(current, target, maxStep) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

export function createPedestrians(G) {
  const rng = G.rng;
  const scene = G.scene;
  // The city is normally built before the peds, but fall back to the grid in
  // config so this module still works if creation order ever changes.
  const city = G.city || {
    roads: [
      ...AVENUES.map((at) => ({ axis: 'z', at })),
      ...STREETS.map((at) => ({ axis: 'x', at })),
    ],
    spawnPoints: { playerStart: { x: 0, z: 30 } },
  };
  const peds = [];

  function playerPos() {
    if (G.player && G.player.position) return G.player.position;
    return city.spawnPoints.playerStart;
  }

  // The road (axis, centre line, side) nearest a point, for rejoining the
  // sidewalk network after fleeing.
  function nearestRoad(x, z) {
    let bestA = AVENUES[0];
    let dA = Infinity;
    for (const a of AVENUES) {
      const d = Math.abs(x - a);
      if (d < dA) {
        dA = d;
        bestA = a;
      }
    }
    let bestS = STREETS[0];
    let dS = Infinity;
    for (const s of STREETS) {
      const d = Math.abs(z - s);
      if (d < dS) {
        dS = d;
        bestS = s;
      }
    }
    if (dA <= dS) return { axis: 'z', at: bestA, side: x >= bestA ? 1 : -1 };
    return { axis: 'x', at: bestS, side: z >= bestS ? 1 : -1 };
  }

  // A random point on a sidewalk, ideally minDist..maxDist from `near`.
  // Returns { x, z, road: { axis, at, side } }.
  function randomSidewalkPoint(near, minDist, maxDist) {
    let best = null;
    for (let i = 0; i < 10; i++) {
      const road = rng.pick(city.roads);
      const along = rng.range(-CITY_HALF + 15, CITY_HALF - 15);
      const side = rng.chance(0.5) ? 1 : -1;
      const point = road.axis === 'z'
        ? { x: road.at + side * SIDEWALK_OFFSET, z: along }
        : { x: along, z: road.at + side * SIDEWALK_OFFSET };
      const candidate = {
        x: point.x, z: point.z,
        road: { axis: road.axis, at: road.at, side },
      };
      if (!best) best = candidate;
      const d = Math.hypot(point.x - near.x, point.z - near.z);
      if (d >= minDist && d <= maxDist) return candidate;
    }
    return best;
  }

  // Next stroll target for a ped: usually further along its current road's
  // sidewalk, sometimes a turn onto a crossing road at an intersection.
  function pickWaypoint(ped) {
    if (ped.pendingRoad) {
      ped.road = ped.pendingRoad;
      ped.pendingRoad = null;
    }
    const road = ped.road;
    if (rng.chance(0.3)) {
      const crossAt = road.axis === 'z' ? rng.pick(STREETS) : rng.pick(AVENUES);
      const newSide = rng.chance(0.5) ? 1 : -1;
      ped.pendingRoad = {
        axis: road.axis === 'z' ? 'x' : 'z',
        at: crossAt,
        side: newSide,
      };
      // Walk along the current sidewalk to the intersection corner.
      if (road.axis === 'z') {
        return { x: road.at + road.side * SIDEWALK_OFFSET, z: crossAt + newSide * SIDEWALK_OFFSET };
      }
      return { x: crossAt + newSide * SIDEWALK_OFFSET, z: road.at + road.side * SIDEWALK_OFFSET };
    }
    let along = rng.range(-CITY_HALF + 15, CITY_HALF - 15);
    const currentAlong = road.axis === 'z' ? ped.pos.z : ped.pos.x;
    if (Math.abs(along - currentAlong) < 15) {
      along = currentAlong + (along >= currentAlong ? 20 : -20);
      along = Math.max(-CITY_HALF + 15, Math.min(CITY_HALF - 15, along));
    }
    return road.axis === 'z'
      ? { x: road.at + road.side * SIDEWALK_OFFSET, z: along }
      : { x: along, z: road.at + road.side * SIDEWALK_OFFSET };
  }

  function fleeFrom(ped, threat) {
    if (ped.state === 'down') return;
    const dx = ped.pos.x - threat.x;
    const dz = ped.pos.z - threat.z;
    const len = Math.hypot(dx, dz) || 1;
    let tx = ped.pos.x + (dx / len + rng.range(-0.4, 0.4)) * 22;
    let tz = ped.pos.z + (dz / len + rng.range(-0.4, 0.4)) * 22;
    tx = Math.max(-CITY_HALF + 5, Math.min(CITY_HALF - 5, tx));
    tz = Math.max(-CITY_HALF + 5, Math.min(CITY_HALF - 5, tz));
    ped.fleeTarget = { x: tx, z: tz };
    ped.fleeTimer = rng.range(2.5, 4.5);
    ped.state = 'flee';
  }

  function respawnPed(ped, near) {
    const spawn = randomSidewalkPoint(near, 35, 90);
    ped.pos.set(spawn.x, 0, spawn.z);
    ped.road = spawn.road;
    ped.pendingRoad = null;
    ped.state = 'walk';
    ped.health = 100;
    ped.downTimer = 0;
    ped.fell = false;
    ped.mesh.rotation.set(0, rng.range(0, Math.PI * 2), 0);
    ped.heading = ped.mesh.rotation.y;
    ped.waypoint = pickWaypoint(ped);
    ped.mesh.visible = true;
  }

  function makePed(spawn) {
    const mesh = createPersonMesh(rng);
    mesh.position.set(spawn.x, 0, spawn.z);
    const heading = rng.range(0, Math.PI * 2);
    mesh.rotation.y = heading;
    scene.add(mesh);
    const ped = {
      mesh,
      pos: mesh.position,
      heading,
      speed: TUNING.pedSpeed * rng.range(0.8, 1.3),
      state: 'walk',
      health: 100,
      road: spawn.road,
      waypoint: null,
      walkPhase: rng.range(0, Math.PI * 2),
      idleTimer: 0,
      fleeTimer: 0,
      downTimer: 0,
      fell: false,
      pendingRoad: null,
      fleeTarget: null,
    };
    // Combat raycasts hit child meshes, so every mesh in the group must carry
    // the ped reference — not just the group itself.
    mesh.traverse((child) => {
      child.userData.ref = ped;
    });
    ped.waypoint = pickWaypoint(ped);
    peds.push(ped);
    return ped;
  }

  // Walk toward `target` at `speed`; returns true once within arrival range.
  function moveToward(ped, target, speed, dt) {
    const dx = target.x - ped.pos.x;
    const dz = target.z - ped.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) return true;
    ped.heading = turnToward(ped.heading, Math.atan2(dx, dz), 8 * dt);
    const step = Math.min(speed * dt, dist);
    ped.pos.x += Math.sin(ped.heading) * step;
    ped.pos.z += Math.cos(ped.heading) * step;
    ped.mesh.rotation.y = ped.heading;
    return dist - step < 1.2;
  }

  function animateWalk(ped, limbs, dt, speed) {
    ped.walkPhase += dt * (2.2 + speed * 1.6);
    const swing = Math.min(0.7, 0.25 + speed * 0.09);
    const s = Math.sin(ped.walkPhase);
    limbs.legL.rotation.x = s * swing;
    limbs.legR.rotation.x = -s * swing;
    limbs.armL.rotation.x = -s * swing * 0.7;
    limbs.armR.rotation.x = s * swing * 0.7;
  }

  function relaxLimbs(limbs, dt) {
    const k = Math.min(1, dt * 6);
    limbs.legL.rotation.x *= (1 - k);
    limbs.legR.rotation.x *= (1 - k);
    limbs.armL.rotation.x *= (1 - k);
    limbs.armR.rotation.x *= (1 - k);
  }

  // ---- Public API -----------------------------------------------------------
  function scatterAt(pos, radius) {
    const r2 = radius * radius;
    for (const ped of peds) {
      if (ped.state === 'down') continue;
      const dx = ped.pos.x - pos.x;
      const dz = ped.pos.z - pos.z;
      if (dx * dx + dz * dz <= r2) fleeFrom(ped, pos);
    }
  }

  function spawnFleeingPed(pos) {
    let ped;
    if (peds.length < PED_MAX) {
      ped = makePed({ x: pos.x, z: pos.z, road: nearestRoad(pos.x, pos.z) });
    } else {
      // At the cap: recycle the ped farthest from the player.
      const pp = playerPos();
      ped = peds[0];
      let best = -1;
      for (const p of peds) {
        const d = (p.pos.x - pp.x) * (p.pos.x - pp.x) + (p.pos.z - pp.z) * (p.pos.z - pp.z);
        if (d > best) {
          best = d;
          ped = p;
        }
      }
      ped.pos.set(pos.x, 0, pos.z);
      ped.mesh.rotation.set(0, rng.range(0, Math.PI * 2), 0);
      ped.heading = ped.mesh.rotation.y;
      ped.state = 'walk';
      ped.health = 100;
      ped.fell = false;
      ped.downTimer = 0;
      ped.road = nearestRoad(pos.x, pos.z);
      ped.pendingRoad = null;
      ped.mesh.visible = true;
    }
    fleeFrom(ped, playerPos());
    return ped;
  }

  function update(dt) {
    const pp = playerPos();
    const pv = G.vehicles && G.vehicles.playerVehicle;
    const carPos = pv && pv.mesh ? pv.mesh.position : null;
    const carSpeed = pv ? Math.abs(pv.speed || 0) : 0;
    const inCar = G.player && G.player.mode === 'car';

    for (const ped of peds) {
      const limbs = ped.mesh.userData.limbs;

      if (ped.state === 'down') {
        ped.downTimer += dt;
        if (!ped.fell) {
          ped.mesh.rotation.x = -Math.PI / 2;
          ped.mesh.position.y = 0.15;
          ped.fell = true;
        }
        if (ped.downTimer > DOWN_TIME) respawnPed(ped, pp);
        continue;
      }

      // Keep the crowd near the player: recycle peds that wandered far off.
      const dxp = ped.pos.x - pp.x;
      const dzp = ped.pos.z - pp.z;
      if (dxp * dxp + dzp * dzp > RESPAWN_DIST * RESPAWN_DIST) {
        respawnPed(ped, pp);
        continue;
      }

      // A moving player car bearing down on a strolling ped sends it running.
      if (inCar && carPos && ped.state === 'walk') {
        const dxc = ped.pos.x - carPos.x;
        const dzc = ped.pos.z - carPos.z;
        if (dxc * dxc + dzc * dzc < 81 && carSpeed > 2) fleeFrom(ped, carPos);
      }

      if (ped.state === 'flee') {
        ped.fleeTimer -= dt;
        const arrived = moveToward(ped, ped.fleeTarget, FLEE_SPEED, dt);
        animateWalk(ped, limbs, dt, FLEE_SPEED);
        if (arrived || ped.fleeTimer <= 0) {
          ped.state = 'walk';
          ped.road = nearestRoad(ped.pos.x, ped.pos.z);
          ped.pendingRoad = null;
          ped.waypoint = pickWaypoint(ped);
        }
        continue;
      }

      if (ped.state === 'idle') {
        ped.idleTimer -= dt;
        relaxLimbs(limbs, dt);
        if (ped.idleTimer <= 0) {
          ped.state = 'walk';
          ped.waypoint = pickWaypoint(ped);
        }
        continue;
      }

      // 'walk': stroll to the waypoint, then pick a new one (or pause a while).
      const arrived = moveToward(ped, ped.waypoint, ped.speed, dt);
      animateWalk(ped, limbs, dt, ped.speed);
      if (arrived) {
        if (rng.chance(0.15)) {
          ped.state = 'idle';
          ped.idleTimer = rng.range(1, 3);
        } else {
          ped.waypoint = pickWaypoint(ped);
        }
      }
    }
  }

  // Initial crowd: spread along the sidewalks around the player's start.
  const start = city.spawnPoints.playerStart;
  for (let i = 0; i < PED_COUNT; i++) {
    makePed(randomSidewalkPoint(start, 5, 110));
  }

  return {
    update,
    peds,
    scatterAt,
    spawnFleeingPed,
    get count() {
      return peds.length;
    },
  };
}
