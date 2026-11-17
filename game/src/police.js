// Police response for Sunset Bay: the 0-5 wanted level, foot cops that chase
// and bust the player, pursuing police cars with flashing light bars, and a
// circling helicopter at 5 stars. Wanted decays when no unit is near the
// player, and the Spray & Go paint shop clears it for $100.

import * as THREE from 'three';
import { CITY_HALF, TUNING } from './config.js';
import { createPersonMesh } from './pedestrians.js';

// Desired response by wanted level (index = wanted).
const FOOT_COPS = [0, 2, 2, 4, 5, 6];
const POLICE_CARS = [0, 0, 1, 2, 3, 4];
const DECAY_DISTANCE = 40; // no unit this close -> the heat starts fading
const DECAY_TIME = 8; // seconds unseen before wanted drops one star
const SPAWN_MIN_DIST = 30; // spawn units off-screen-ish, but not too far
const SPAWN_MAX_DIST = 60;
const BUST_DISTANCE = 1.5;
const BUST_MAX_PLAYER_SPEED = 2.5;
const FLASH_INTERVAL = 0.28; // seconds between red/blue swaps

// ---------------------------------------------------------------------------
// Fallback cop body, used only if createPersonMesh is unavailable or throws.
// Same low-poly person shape (~1.8 m) in a dark blue uniform.
// ---------------------------------------------------------------------------

const LEG_GEO = new THREE.BoxGeometry(0.16, 0.8, 0.18);
const ARM_GEO = new THREE.BoxGeometry(0.13, 0.62, 0.15);
const TORSO_GEO = new THREE.BoxGeometry(0.46, 0.6, 0.24);
const HEAD_GEO = new THREE.SphereGeometry(0.17, 12, 10);
const CAP_GEO = new THREE.CylinderGeometry(0.18, 0.19, 0.08, 12);

function buildCopMeshFallback() {
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89666, roughness: 0.8 });
  const uniform = new THREE.MeshStandardMaterial({ color: 0x1e2f6e, roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x141428, roughness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x141428, roughness: 0.8 });

  const group = new THREE.Group();
  const torso = new THREE.Mesh(TORSO_GEO, uniform);
  torso.position.y = 1.12;
  group.add(torso);
  const head = new THREE.Mesh(HEAD_GEO, skin);
  head.position.y = 1.62;
  group.add(head);
  const capMesh = new THREE.Mesh(CAP_GEO, capMat);
  capMesh.position.y = 1.76;
  group.add(capMesh);

  function limb(geo, mat, x, pivotY, dropY) {
    const pivot = new THREE.Group();
    pivot.position.set(x, pivotY, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = dropY;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  }

  return {
    group,
    parts: {
      legL: limb(LEG_GEO, pants, -0.11, 0.82, -0.41),
      legR: limb(LEG_GEO, pants, 0.11, 0.82, -0.41),
      armL: limb(ARM_GEO, uniform, -0.3, 1.38, -0.28),
      armR: limb(ARM_GEO, uniform, 0.3, 1.38, -0.28),
    },
  };
}

function turnToward(current, target, maxStep) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

function approach(value, target, maxStep) {
  if (value < target) return Math.min(target, value + maxStep);
  return Math.max(target, value - maxStep);
}

function fadeMesh(mesh, opacity) {
  mesh.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      m.transparent = true;
      m.opacity = opacity;
    }
  });
}

export function createPolice(G) {
  let unseenTimer = 0;
  let spawnTimer = 0;
  let spawnCounter = 0;
  let flashTimer = 0;
  let flashOn = true;
  let bustedShown = false;
  let sirenOn = false;
  let heli = null;
  let heliRotor = null;
  let heliAngle = 0;

  // --- spawning ------------------------------------------------------------

  // A road point 30-60 m from the player, so units arrive from off-screen.
  function spawnPointNearPlayer() {
    const pp = G.player.position;
    if (G.city && typeof G.city.randomRoadPoint === 'function') {
      for (let i = 0; i < 12; i++) {
        let pt = null;
        try {
          pt = G.city.randomRoadPoint(G.rng);
        } catch (err) {
          pt = null;
        }
        if (pt && typeof pt.x === 'number' && typeof pt.z === 'number') {
          const d = Math.hypot(pt.x - pp.x, pt.z - pp.z);
          if (d >= SPAWN_MIN_DIST && d <= SPAWN_MAX_DIST) return { x: pt.x, z: pt.z };
        }
      }
    }
    // Fallback: a point on a ring around the player, snapped to the nearest
    // road when the city can do it. The golden-angle step keeps successive
    // spawns spread around the ring even without the rng.
    spawnCounter += 1;
    const angle = G.rng ? G.rng.range(0, Math.PI * 2) : spawnCounter * 2.39996;
    const dist = G.rng ? G.rng.range(SPAWN_MIN_DIST, SPAWN_MAX_DIST) : 45;
    let x = THREE.MathUtils.clamp(pp.x + Math.cos(angle) * dist, -CITY_HALF + 5, CITY_HALF - 5);
    let z = THREE.MathUtils.clamp(pp.z + Math.sin(angle) * dist, -CITY_HALF + 5, CITY_HALF - 5);
    if (G.city && typeof G.city.nearestRoadPoint === 'function') {
      try {
        const np = G.city.nearestRoadPoint(x, z);
        if (np && typeof np.x === 'number' && typeof np.z === 'number') {
          x = np.x;
          z = np.z;
        }
      } catch (err) {
        // Keep the ring point.
      }
    }
    return { x, z };
  }

  function makeCopMesh() {
    try {
      const raw = createPersonMesh(G.rng, {
        shirt: 0x1e2f6e,
        pants: 0x141428,
        skin: 0xc89666,
        cap: 0x141428,
      });
      const group = raw && raw.isObject3D ? raw : raw && (raw.group || raw.mesh);
      if (group && group.isObject3D) {
        // createPersonMesh keeps its limb pivots in userData.limbs.
        const parts =
          (raw && raw.parts) || (group.userData && group.userData.limbs) || null;
        return { group, parts };
      }
    } catch (err) {
      // Fall through to the local builder.
    }
    return buildCopMeshFallback();
  }

  function spawnCop() {
    if (!G.scene) return;
    const p = spawnPointNearPlayer();
    const built = makeCopMesh();
    const group = built.group;
    group.position.set(p.x, 0, p.z);
    const cop = {
      mesh: group,
      pos: group.position,
      heading: 0,
      speed: TUNING.copSpeed,
      health: 100,
      state: 'chase',
      downTime: 0,
      phase: 0,
      parts: built.parts || null,
    };
    // Tag the group and every child so combat raycasts can identify the cop.
    group.traverse((obj) => {
      obj.userData.type = 'cop';
      obj.userData.ref = cop;
    });
    G.scene.add(group);
    api.cops.push(cop);
  }

  function spawnPoliceCar() {
    if (!G.vehicles || typeof G.vehicles.spawnVehicle !== 'function') return;
    const p = spawnPointNearPlayer();
    const pp = G.player.position;
    const heading = Math.atan2(pp.x - p.x, pp.z - p.z);
    let car = null;
    try {
      car = G.vehicles.spawnVehicle('police', p.x, p.z, heading, { driver: 'police' });
    } catch (err) {
      car = null;
    }
    if (!car || !car.mesh) return;
    if (!car.mesh.userData.type) {
      car.mesh.userData.type = 'car';
      car.mesh.userData.ref = car;
    }
    // Roof light bar: two small boxes whose emissive swaps red/blue.
    const lightGeo = new THREE.BoxGeometry(0.34, 0.16, 0.22);
    const matL = new THREE.MeshStandardMaterial({
      color: 0x330000,
      emissive: 0xff2222,
      emissiveIntensity: 2,
    });
    const matR = new THREE.MeshStandardMaterial({
      color: 0x000033,
      emissive: 0x2244ff,
      emissiveIntensity: 0.15,
    });
    const lightL = new THREE.Mesh(lightGeo, matL);
    lightL.position.set(-0.42, 1.32, -0.1);
    const lightR = new THREE.Mesh(lightGeo, matR);
    lightR.position.set(0.42, 1.32, -0.1);
    car.mesh.add(lightL, lightR);
    api.policeCars.push({
      vehicle: car,
      mesh: car.mesh,
      pos: car.mesh.position,
      matL,
      matR,
      ramCooldown: 0,
    });
  }

  // --- helicopter (visual only, wanted 5) ----------------------------------

  function ensureHeli() {
    if (heli || !G.scene) return;
    heli = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x2a3a48, roughness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 3.4), bodyMat);
    heli.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.8), glassMat);
    nose.position.set(0, -0.1, 1.9);
    heli.add(nose);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 3.2), bodyMat);
    tail.position.set(0, 0.2, -3.0);
    heli.add(tail);
    heliRotor = new THREE.Mesh(
      new THREE.BoxGeometry(7.5, 0.06, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
    );
    heliRotor.position.y = 0.9;
    heli.add(heliRotor);
    // Spotlight cone, apex at the helicopter, widening toward the ground.
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(7, 32, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff6c0,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    cone.position.y = -16;
    heli.add(cone);
    G.scene.add(heli);
  }

  function removeHeli() {
    if (!heli) return;
    if (G.scene) G.scene.remove(heli);
    heli = null;
    heliRotor = null;
  }

  function updateHeli(dt) {
    if (!heli || !G.player) return;
    heliAngle += dt * 0.35;
    const pp = G.player.position;
    heli.position.set(pp.x + Math.cos(heliAngle) * 26, 34, pp.z + Math.sin(heliAngle) * 26);
    heli.lookAt(pp.x, 0, pp.z);
    if (heliRotor) heliRotor.rotation.y += dt * 30;
  }

  // --- despawn ---------------------------------------------------------------

  function despawnAll() {
    if (G.scene) {
      for (const cop of api.cops) G.scene.remove(cop.mesh);
      for (const w of api.policeCars) {
        G.scene.remove(w.mesh);
        if (G.vehicles && Array.isArray(G.vehicles.all)) {
          const i = G.vehicles.all.indexOf(w.vehicle);
          if (i >= 0) G.vehicles.all.splice(i, 1);
        }
      }
    }
    api.cops.length = 0;
    api.policeCars.length = 0;
    removeHeli();
    setSiren(false);
  }

  function setSiren(on) {
    if (on === sirenOn) return;
    sirenOn = on;
    if (G.audio && typeof G.audio.siren === 'function') {
      try {
        G.audio.siren(on);
      } catch (err) {
        // Audio must never break the police update.
      }
    }
  }

  // --- per-unit updates ------------------------------------------------------

  function updateCop(cop, dt) {
    if (cop.state === 'down') {
      cop.downTime += dt;
      if (cop.downTime > 3) {
        const f = Math.max(0, 1 - (cop.downTime - 3) / 2);
        fadeMesh(cop.mesh, f);
        if (f <= 0) {
          if (G.scene) G.scene.remove(cop.mesh);
          cop.state = 'gone';
        }
      }
      return;
    }
    const pp = G.player.position;
    const dx = pp.x - cop.pos.x;
    const dz = pp.z - cop.pos.z;
    const dist = Math.hypot(dx, dz);
    cop.heading = turnToward(cop.heading, Math.atan2(dx, dz), 6 * dt);
    cop.mesh.rotation.y = cop.heading;
    const step = cop.speed * dt;
    const nx = cop.pos.x + Math.sin(cop.heading) * step;
    const nz = cop.pos.z + Math.cos(cop.heading) * step;
    const collides = G.city && G.city.collides;
    if (!collides || !collides.call(G.city, nx, cop.pos.z, 0.5)) cop.pos.x = nx;
    if (!collides || !collides.call(G.city, cop.pos.x, nz, 0.5)) cop.pos.z = nz;
    // Run cycle: swing limbs when we own them, otherwise bob the body.
    cop.phase += dt * cop.speed * 1.6;
    if (cop.parts && cop.parts.legL) {
      const s = Math.sin(cop.phase) * 0.85;
      cop.parts.legL.rotation.x = s;
      cop.parts.legR.rotation.x = -s;
      cop.parts.armL.rotation.x = -s * 0.8;
      cop.parts.armR.rotation.x = s * 0.8;
    } else {
      cop.mesh.position.y = Math.abs(Math.sin(cop.phase)) * 0.06;
    }
    // Busted: a cop touches a slow, on-foot player while wanted.
    if (
      dist < BUST_DISTANCE &&
      api.wanted > 0 &&
      G.player.mode === 'foot' &&
      !G.player.isDead &&
      !bustedShown
    ) {
      const playerSpeed = G.player.velocity ? G.player.velocity.length() : 0;
      if (playerSpeed < BUST_MAX_PLAYER_SPEED) {
        bustedShown = true;
        if (G.menus && typeof G.menus.showBusted === 'function') G.menus.showBusted();
      }
    }
  }

  function manualMove(car, dt) {
    const h = car.heading || 0;
    car.mesh.position.x += Math.sin(h) * (car.speed || 0) * dt;
    car.mesh.position.z += Math.cos(h) * (car.speed || 0) * dt;
  }

  function updatePoliceCar(w, dt) {
    const car = w.vehicle;
    if (!car || !car.mesh) return;
    if (typeof car.health === 'number' && car.health <= 0) {
      // Wrecked: vehicles.js handles the explosion; this unit stops chasing.
      car.speed = 0;
      return;
    }
    const pp = G.player.position;
    const dx = pp.x - w.pos.x;
    const dz = pp.z - w.pos.z;
    const dist = Math.hypot(dx, dz);
    car.heading = turnToward(car.heading || 0, Math.atan2(dx, dz), 2.4 * dt);
    const maxSpeed = Math.min(car.maxSpeed || TUNING.carMaxSpeed, TUNING.carMaxSpeed) * 0.9;
    const targetSpeed = dist > 6 ? maxSpeed : maxSpeed * 0.5;
    car.speed = approach(car.speed || 0, targetSpeed, 20 * dt);
    if (G.vehicles && typeof G.vehicles.moveVehicle === 'function') {
      try {
        G.vehicles.moveVehicle(car, dt);
      } catch (err) {
        manualMove(car, dt);
      }
    } else {
      manualMove(car, dt);
    }
    car.mesh.rotation.y = car.heading;
    // A hard ram hurts: the player's car takes damage, or the player on foot.
    w.ramCooldown = Math.max(0, w.ramCooldown - dt);
    if (dist < 3.2 && w.ramCooldown <= 0 && (car.speed || 0) > 6) {
      w.ramCooldown = 1;
      if (G.player.mode === 'car' && G.vehicles && G.vehicles.playerVehicle) {
        const pv = G.vehicles.playerVehicle;
        if (typeof pv.health === 'number') pv.health = Math.max(0, pv.health - 6);
        if (G.effects && typeof G.effects.sparks === 'function') G.effects.sparks(w.pos);
        if (G.effects && typeof G.effects.screenShake === 'function') {
          G.effects.screenShake(0.25);
        }
      } else if (G.player.mode === 'foot' && !G.player.isDead) {
        G.player.takeDamage(10);
      }
    }
  }

  // --- wanted level ----------------------------------------------------------

  function showWantedMessage() {
    if (!G.hud || typeof G.hud.showMessage !== 'function') return;
    if (api.wanted >= 5) G.hud.showMessage('Wanted level 5 — full force incoming!');
    else if (api.wanted > 0) G.hud.showMessage(`Wanted level ${api.wanted}`);
    else G.hud.showMessage('You lost the cops');
  }

  function addWanted(n) {
    if (!n || n <= 0) return;
    const before = api.wanted;
    api.wanted = Math.min(5, api.wanted + n);
    unseenTimer = 0;
    if (api.wanted !== before) showWantedMessage();
  }

  function setWanted(n) {
    const next = THREE.MathUtils.clamp(n || 0, 0, 5);
    if (next === api.wanted) return;
    api.wanted = next;
    unseenTimer = 0;
    if (api.wanted === 0) despawnAll();
    else showWantedMessage();
  }

  function clearWanted() {
    api.wanted = 0;
    unseenTimer = 0;
    bustedShown = false;
    despawnAll();
  }

  // --- main update -----------------------------------------------------------

  function update(dt) {
    if (!G.player || !G.player.position) return;
    const pp = G.player.position;

    // Spray & Go paint shop: drive into the garage with $100 to clear wanted.
    const garage = G.city && G.city.spawnPoints && G.city.spawnPoints.garage;
    if (garage && api.wanted > 0 && G.player.mode === 'car') {
      const d = Math.hypot(pp.x - garage.x, pp.z - garage.z);
      if (d < 12 && G.player.money >= TUNING.paintCost) {
        G.player.money -= TUNING.paintCost;
        clearWanted();
        if (G.hud && typeof G.hud.showMessage === 'function') {
          G.hud.showMessage('Spray & Go: fresh paint, clean slate');
        }
      }
    }

    // Nearest active unit, for decay and heat.
    let nearest = Infinity;
    for (const cop of api.cops) {
      if (cop.state !== 'chase') continue;
      nearest = Math.min(nearest, Math.hypot(cop.pos.x - pp.x, cop.pos.z - pp.z));
    }
    for (const w of api.policeCars) {
      if (!w.vehicle || !w.mesh) continue;
      if (typeof w.vehicle.health === 'number' && w.vehicle.health <= 0) continue;
      nearest = Math.min(nearest, Math.hypot(w.pos.x - pp.x, w.pos.z - pp.z));
    }

    // Decay: 8 continuous seconds with no unit within 40 m drops a star.
    if (api.wanted > 0) {
      if (nearest > DECAY_DISTANCE) {
        unseenTimer += dt;
        if (unseenTimer >= DECAY_TIME) {
          unseenTimer = 0;
          api.wanted -= 1;
          showWantedMessage();
          if (api.wanted <= 0) despawnAll();
        }
      } else {
        unseenTimer = 0;
      }
    }

    // Spawn toward the desired response, at most one unit per 0.4 s.
    if (api.wanted > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        const wantCops = FOOT_COPS[api.wanted];
        const wantCars = POLICE_CARS[api.wanted];
        const liveCops = api.cops.filter((c) => c.state === 'chase').length;
        if (api.policeCars.length < wantCars) {
          spawnPoliceCar();
          spawnTimer = 0.4;
        } else if (liveCops < wantCops) {
          spawnCop();
          spawnTimer = 0.4;
        }
      }
    }

    // Helicopter at 5 stars, visual only.
    if (api.wanted >= 5) {
      ensureHeli();
      updateHeli(dt);
    } else {
      removeHeli();
    }

    // Flashing light bars.
    flashTimer += dt;
    if (flashTimer >= FLASH_INTERVAL) {
      flashTimer = 0;
      flashOn = !flashOn;
      for (const w of api.policeCars) {
        w.matL.emissiveIntensity = flashOn ? 2 : 0.15;
        w.matR.emissiveIntensity = flashOn ? 0.15 : 2;
      }
    }

    for (let i = api.cops.length - 1; i >= 0; i--) {
      const cop = api.cops[i];
      updateCop(cop, dt);
      if (cop.state === 'gone') api.cops.splice(i, 1);
    }
    for (const w of api.policeCars) updatePoliceCar(w, dt);

    // Siren while any police car is on the road.
    setSiren(api.wanted > 0 && api.policeCars.length > 0);

    // Heat 0..1: wanted share, scaled up as the nearest unit closes in.
    const base = api.wanted / 5;
    if (nearest === Infinity) {
      api.heat = base * 0.3;
    } else {
      const proximity = THREE.MathUtils.clamp(1.2 - nearest / 100, 0, 1);
      api.heat = base * (0.25 + 0.75 * proximity);
    }
  }

  const api = {
    update,
    wanted: 0,
    addWanted,
    setWanted,
    clearWanted,
    cops: [],
    policeCars: [],
    heat: 0,
  };
  return api;
}
