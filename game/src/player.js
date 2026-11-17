// Player controller for Sunset Bay: Milo Reyes on foot and behind the wheel.
// On foot: WASD/arrows relative to the camera heading, Shift to sprint, Space to
// jump, E to enter/exit the nearest car. Health, money, death ("wasted") and the
// hospital respawn live here too.

import * as THREE from 'three';
import { CITY_HALF, TUNING } from './config.js';

// ---------------------------------------------------------------------------
// Low-poly person mesh (~1.8 m): box torso/limbs + sphere head, limb pivots
// at the hips/shoulders so the walk cycle can swing them.
// ---------------------------------------------------------------------------

const LEG_GEO = new THREE.BoxGeometry(0.16, 0.8, 0.18);
const ARM_GEO = new THREE.BoxGeometry(0.13, 0.62, 0.15);
const TORSO_GEO = new THREE.BoxGeometry(0.46, 0.6, 0.24);
const HEAD_GEO = new THREE.SphereGeometry(0.17, 12, 10);
const CAP_GEO = new THREE.CylinderGeometry(0.18, 0.19, 0.08, 12);

function buildPlayerMesh() {
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89666, roughness: 0.8 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x2e8f86, roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.9 });
  const cap = new THREE.MeshStandardMaterial({ color: 0xe8a832, roughness: 0.8 });

  const group = new THREE.Group();

  const torso = new THREE.Mesh(TORSO_GEO, shirt);
  torso.position.y = 1.12;
  group.add(torso);

  const head = new THREE.Mesh(HEAD_GEO, skin);
  head.position.y = 1.62;
  group.add(head);

  const capMesh = new THREE.Mesh(CAP_GEO, cap);
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

  const legL = limb(LEG_GEO, pants, -0.11, 0.82, -0.41);
  const legR = limb(LEG_GEO, pants, 0.11, 0.82, -0.41);
  const armL = limb(ARM_GEO, shirt, -0.3, 1.38, -0.28);
  const armR = limb(ARM_GEO, shirt, 0.3, 1.38, -0.28);

  return { group, legL, legR, armL, armR };
}

// Shortest-arc turn toward a target heading, capped at maxStep radians.
function turnToward(current, target, maxStep) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export function createPlayer(G) {
  const start =
    (G.city && G.city.spawnPoints && G.city.spawnPoints.playerStart) || { x: 0, z: 0 };

  const parts = buildPlayerMesh();
  const mesh = parts.group;
  mesh.position.set(start.x, 0, start.z);
  mesh.rotation.y = Math.PI;
  if (G.scene) G.scene.add(mesh);

  let vy = 0;
  let grounded = true;
  let walkPhase = 0;
  let wastedShown = false;
  // Fallback edge detection, used only if G.input.pressed is unavailable.
  const prevKeys = new Set();

  function pressed(code) {
    const input = G.input;
    if (!input) return false;
    if (typeof input.pressed === 'function') return input.pressed(code);
    if (!input.keys) return false;
    const down = input.keys.has(code);
    const edge = down && !prevKeys.has(code);
    if (down) prevKeys.add(code);
    else prevKeys.delete(code);
    return edge;
  }

  function update(dt) {
    if (api.isDead) {
      api.velocity.set(0, 0, 0);
      return;
    }

    // Edge actions run only on the first step of a frame: a slow frame runs
    // several steps, and one E press must not toggle enter then exit.
    if ((G.stepInFrame || 0) === 0 && pressed('KeyE')) {
      if (api.mode === 'car') exitVehicle();
      else enterVehicle();
    }

    // Driving: the mesh hides and rides along with the car so that every other
    // system (police, combat, camera, hud) can keep reading player.position.
    if (api.mode === 'car') {
      const car = G.vehicles && G.vehicles.playerVehicle;
      if (car && car.mesh) {
        mesh.position.copy(car.mesh.position);
        const sp = car.speed || 0;
        const h = car.heading || 0;
        api.velocity.set(Math.sin(h) * sp, 0, Math.cos(h) * sp);
      } else {
        api.velocity.set(0, 0, 0);
      }
      return;
    }

    const keys = G.input && G.input.keys;
    let fwd = 0;
    let strafe = 0;
    if (keys) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
    }
    const sprint = !!(keys && (keys.has('ShiftLeft') || keys.has('ShiftRight')));
    const speed = sprint ? TUNING.runSpeed : TUNING.walkSpeed;

    // Camera looks along (-sin yaw, -cos yaw); right is (cos yaw, -sin yaw).
    const yaw = G.camera && typeof G.camera.yaw === 'number' ? G.camera.yaw : 0;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    let mx = -sinY * fwd + cosY * strafe;
    let mz = -cosY * fwd - sinY * strafe;
    const len = Math.hypot(mx, mz);
    const moving = len > 0.001;
    if (moving) {
      mx /= len;
      mz /= len;
    } else {
      mx = 0;
      mz = 0;
    }

    if (pressed('Space') && grounded) {
      vy = TUNING.jumpSpeed;
      grounded = false;
    }
    vy -= TUNING.gravity * dt;

    // Building collision, one axis at a time so the player slides along walls.
    const nx = mesh.position.x + mx * speed * dt;
    const nz = mesh.position.z + mz * speed * dt;
    const collides = G.city && G.city.collides;
    if (collides) {
      if (!collides.call(G.city, nx, mesh.position.z, 0.5)) mesh.position.x = nx;
      if (!collides.call(G.city, mesh.position.x, nz, 0.5)) mesh.position.z = nz;
    } else {
      mesh.position.x = nx;
      mesh.position.z = nz;
    }
    mesh.position.x = THREE.MathUtils.clamp(mesh.position.x, -CITY_HALF + 1, CITY_HALF - 1);
    mesh.position.z = THREE.MathUtils.clamp(mesh.position.z, -CITY_HALF + 1, CITY_HALF - 1);

    let ny = mesh.position.y + vy * dt;
    if (ny <= 0) {
      ny = 0;
      vy = 0;
      grounded = true;
    }
    mesh.position.y = ny;
    api.velocity.set(mx * speed, vy, mz * speed);

    if (moving) {
      mesh.rotation.y = turnToward(mesh.rotation.y, Math.atan2(mx, mz), 12 * dt);
    }

    // Limb-swing walk/run cycle; tucked legs mid-jump; ease back to idle.
    if (!grounded) {
      parts.legL.rotation.x = 0.5;
      parts.legR.rotation.x = -0.35;
      parts.armL.rotation.x = -0.5;
      parts.armR.rotation.x = -0.5;
    } else if (moving) {
      walkPhase += dt * speed * 1.4;
      const s = Math.sin(walkPhase) * (sprint ? 0.85 : 0.6);
      parts.legL.rotation.x = s;
      parts.legR.rotation.x = -s;
      parts.armL.rotation.x = -s * 0.8;
      parts.armR.rotation.x = s * 0.8;
    } else {
      const k = Math.max(0, 1 - dt * 10);
      parts.legL.rotation.x *= k;
      parts.legR.rotation.x *= k;
      parts.armL.rotation.x *= k;
      parts.armR.rotation.x *= k;
    }
  }

  function enterVehicle() {
    if (api.mode !== 'foot' || api.isDead) return false;
    const vehicles = G.vehicles;
    if (!vehicles || typeof vehicles.nearestDrivable !== 'function') return false;
    const car = vehicles.nearestDrivable(mesh.position, 3.5);
    if (!car) return false;
    if (car.driver === 'traffic' && G.peds && typeof G.peds.spawnFleeingPed === 'function') {
      try {
        G.peds.spawnFleeingPed(car.mesh ? car.mesh.position : mesh.position);
      } catch (err) {
        // A missing ped system must never block getting into the car.
      }
    }
    if (G.police && typeof G.police.addWanted === 'function') G.police.addWanted(1);
    if (typeof vehicles.setPlayerVehicle === 'function') vehicles.setPlayerVehicle(car);
    api.mode = 'car';
    mesh.visible = false;
    api.velocity.set(0, 0, 0);
    return true;
  }

  function exitVehicle() {
    if (api.mode !== 'car') return false;
    const car = G.vehicles && G.vehicles.playerVehicle;
    if (car && car.mesh) {
      // Step out on the car's right side; try the left if the right is blocked.
      const h = car.heading || 0;
      const rx = Math.cos(h);
      const rz = -Math.sin(h);
      let ex = car.mesh.position.x + rx * 2.6;
      let ez = car.mesh.position.z + rz * 2.6;
      const collides = G.city && G.city.collides;
      if (collides && collides.call(G.city, ex, ez, 0.5)) {
        ex = car.mesh.position.x - rx * 2.6;
        ez = car.mesh.position.z - rz * 2.6;
      }
      mesh.position.set(ex, 0, ez);
    }
    mesh.visible = true;
    api.mode = 'foot';
    if (G.vehicles && typeof G.vehicles.setPlayerVehicle === 'function') {
      try {
        G.vehicles.setPlayerVehicle(null);
      } catch (err) {
        // Fall through to the direct flag clearing below.
      }
    }
    if (car) {
      car.isPlayer = false;
      if (car.driver === 'player') car.driver = null;
    }
    api.velocity.set(0, 0, 0);
    return true;
  }

  function takeDamage(n) {
    if (api.isDead || !n || n <= 0) return;
    api.health = Math.max(0, api.health - n);
    if (api.health <= 0) {
      api.isDead = true;
      if (!wastedShown) {
        wastedShown = true;
        if (G.menus && typeof G.menus.showWasted === 'function') G.menus.showWasted();
      }
    }
  }

  function heal(n) {
    if (api.isDead || !n || n <= 0) return;
    api.health = Math.min(api.maxHealth, api.health + n);
  }

  function respawn() {
    const hospital =
      (G.city && G.city.spawnPoints && G.city.spawnPoints.hospital) || { x: 0, z: 0 };
    if (api.mode === 'car') {
      const car = G.vehicles && G.vehicles.playerVehicle;
      if (G.vehicles && typeof G.vehicles.setPlayerVehicle === 'function') {
        try {
          G.vehicles.setPlayerVehicle(null);
        } catch (err) {
          // Ignore; flags below still clear the driving state.
        }
      }
      if (car) {
        car.isPlayer = false;
        if (car.driver === 'player') car.driver = null;
      }
    }
    mesh.position.set(hospital.x, 0, hospital.z);
    mesh.position.y = 0;
    mesh.visible = true;
    api.mode = 'foot';
    api.health = api.maxHealth;
    api.money = Math.max(0, api.money - 100);
    api.isDead = false;
    wastedShown = false;
    vy = 0;
    grounded = true;
    api.velocity.set(0, 0, 0);
    if (G.police && typeof G.police.clearWanted === 'function') G.police.clearWanted();
  }

  const api = {
    update,
    mesh,
    position: mesh.position,
    mode: 'foot',
    health: TUNING.playerMaxHealth,
    maxHealth: TUNING.playerMaxHealth,
    money: TUNING.startMoney,
    velocity: new THREE.Vector3(),
    enterVehicle,
    exitVehicle,
    takeDamage,
    heal,
    isDead: false,
    respawn,
  };
  return api;
}
