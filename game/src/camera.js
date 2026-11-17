// The third-person camera for Sunset Bay: it follows the player on foot and the car
// while driving, orbits on right-drag, zooms slightly while aiming, and holds a fixed
// cinematic frame for screenshot staging.
//
// Convention (player.js moves by this too): the camera sits at the target plus
// (sin(yaw), cos(yaw)) * distance on the ground plane, looking back at the target, so
// the view's forward on the ground is (-sin(yaw), -cos(yaw)) and its right is
// (cos(yaw), -sin(yaw)). yaw = 0 puts the camera south of the target, looking north.

import * as THREE from 'three';

const FOOT_DISTANCE = 6;
const FOOT_HEIGHT = 3;
const CAR_DISTANCE = 9.5;
const CAR_HEIGHT = 4;
const FOV_NORMAL = 60;
const FOV_AIM = 50;
const PITCH_MIN = 0.12;
const PITCH_MAX = 0.9;

export function createCamera(G) {
  const camera = G.camera;
  camera.fov = FOV_NORMAL;
  camera.near = 0.1;
  camera.far = 1200;
  camera.updateProjectionMatrix();

  let yaw = 0;
  let pitch = 0.35;
  let fixed = null; // { pos: Vector3, lookAt: Vector3 } when a shot stages a frame
  let currentDistance = FOOT_DISTANCE;
  let currentFov = FOV_NORMAL;
  const desired = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const shakeOffset = new THREE.Vector3();

  function targetOf() {
    if (G.player && G.player.mode === 'car' && G.vehicles && G.vehicles.playerVehicle) {
      return G.vehicles.playerVehicle.mesh.position;
    }
    if (G.player) return G.player.position;
    return null;
  }

  function update(dt) {
    if (fixed) {
      camera.position.copy(fixed.pos);
      camera.lookAt(fixed.lookAt);
      return;
    }
    const target = targetOf();
    if (!target) return;
    const driving = Boolean(G.player && G.player.mode === 'car');

    // Right-drag orbits the camera; otherwise, while driving fast, it swings behind the car.
    const input = G.input;
    if (input && input.mouse && input.mouse.right) {
      yaw -= input.mouse.dx * 0.005;
      pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch + input.mouse.dy * 0.004));
    } else if (driving && G.vehicles && G.vehicles.playerVehicle) {
      const car = G.vehicles.playerVehicle;
      if (car.speed > 5) {
        // Behind the car: the camera offset opposes the car's forward, so yaw = heading + PI.
        const wanted = car.heading + Math.PI;
        let diff = wanted - yaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        yaw += diff * Math.min(1, dt * 2.2);
      }
    }

    const aiming = Boolean(G.combat && G.combat.aiming);
    const distance = aiming ? 4.5 : driving ? CAR_DISTANCE : FOOT_DISTANCE;
    const height = driving ? CAR_HEIGHT : FOOT_HEIGHT;
    currentDistance += (distance - currentDistance) * Math.min(1, dt * 4);
    const wantedFov = aiming ? FOV_AIM : FOV_NORMAL;
    if (Math.abs(wantedFov - currentFov) > 0.05) {
      currentFov += (wantedFov - currentFov) * Math.min(1, dt * 8);
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }

    const horizontal = Math.cos(pitch) * currentDistance;
    desired.set(
      target.x + Math.sin(yaw) * horizontal,
      target.y + Math.sin(pitch) * currentDistance + height * 0.4,
      target.z + Math.cos(yaw) * horizontal,
    );
    // Keep the camera out of buildings: pull it toward the target in steps when blocked.
    if (G.city) {
      for (let scale = 1; scale >= 0.25; scale -= 0.25) {
        const x = target.x + (desired.x - target.x) * scale;
        const z = target.z + (desired.z - target.z) * scale;
        if (!G.city.collides(x, z, 0.5)) {
          desired.x = x;
          desired.z = z;
          break;
        }
      }
    }
    if (desired.y < 1.2) desired.y = 1.2;

    const ease = 1 - Math.exp(-dt * 7);
    camera.position.lerp(desired, ease);

    // Screen shake rides on top of the smoothed position.
    const shake = G.effects ? G.effects.shake : 0;
    if (shake > 0.001) {
      const t = (G.time || 0) * 61;
      shakeOffset.set(
        Math.sin(t * 1.3) * shake * 0.25,
        Math.sin(t * 1.7 + 2) * shake * 0.2,
        Math.cos(t * 1.1) * shake * 0.25,
      );
      camera.position.add(shakeOffset);
    }

    lookTarget.set(target.x, target.y + 1.6, target.z);
    camera.lookAt(lookTarget);
  }

  const api = {
    update,
    get yaw() {
      return yaw;
    },
    set yaw(value) {
      yaw = value;
    },
    get pitch() {
      return pitch;
    },
    /** Hold a fixed cinematic frame (screenshot staging). */
    setFixed(pos, lookAt) {
      fixed = { pos: pos.clone(), lookAt: lookAt.clone() };
      camera.position.copy(fixed.pos);
      camera.lookAt(fixed.lookAt);
    },
    clearFixed() {
      fixed = null;
    },
  };
  G.cameraApi = api;
  return api;
}
