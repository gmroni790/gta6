// The screenshot scenes behind ?shot=cover|street|chase|mission. Each one plays
// the real rules forward from a fresh seeded world for a fixed number of steps,
// steered by scripted inputs (held keys, a wanted level, a mission started), then
// holds a fixed cinematic camera — so the frame is what the game really looks
// like, and the same seed always gives the same frame.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const STEP = CONFIG.STEP;

function stepWorld(G, dt) {
  G.time += dt;
  G.missions.update(dt);
  G.player.update(dt);
  G.vehicles.update(dt);
  G.peds.update(dt);
  G.police.update(dt);
  G.combat.update(dt);
  G.effects.update(dt);
  G.city.update(dt);
}

function runSteps(G, seconds) {
  const count = Math.round(seconds / STEP);
  for (let i = 0; i < count; i += 1) {
    G.stepInFrame = 0;
    stepWorld(G, STEP);
    G.hud.update(STEP);
  }
}

function holdKeys(G, codes, on) {
  for (const code of codes) {
    if (on) G.input.keys.add(code);
    else G.input.keys.delete(code);
  }
}

function putPlayerInCar(G, type, x, z, heading, color) {
  const car = G.vehicles.spawnVehicle(type, x, z, heading, { driver: 'player', color });
  G.vehicles.setPlayerVehicle(car);
  G.player.mode = 'car';
  G.player.mesh.visible = false;
  G.player.mesh.position.copy(car.mesh.position);
  return car;
}

// A camera ahead of the car, looking back past it: the car drives toward the
// lens with its pursuers behind it. `ahead`/`side` place the camera relative
// to the car's heading; `behind` pulls the look target past the car so the
// chase reads in the frame.
function frontCam(G, car, ahead, side, up, behind) {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const rx = -Math.cos(car.heading);
  const rz = Math.sin(car.heading);
  const p = car.mesh.position;
  G.cameraApi.setFixed(
    new THREE.Vector3(p.x + fx * ahead + rx * side, up, p.z + fz * ahead + rz * side),
    new THREE.Vector3(p.x - fx * behind, 1.5, p.z - fz * behind),
  );
}

// A camera behind and to the side of the car, looking forward past it: the
// car prominent, anything chasing it visible behind, the city ahead.
function rearCam(G, car, back, side, up, ahead) {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const rx = -Math.cos(car.heading);
  const rz = Math.sin(car.heading);
  const p = car.mesh.position;
  G.cameraApi.setFixed(
    new THREE.Vector3(p.x - fx * back + rx * side, up, p.z - fz * back + rz * side),
    new THREE.Vector3(p.x + fx * ahead, 1.5, p.z + fz * ahead),
  );
}

// The cover: Milo driving a sports car north through Downtown, two stars on
// the board, a police car closing in behind, and Lena's first mission on the
// HUD. Six seconds in, the car is at speed and the briefing has faded.
function stageCover(G) {
  G.missions.startMission('mission-1');
  const car = putPlayerInCar(G, 'sports', 3, 80, Math.PI, 0xc83232);
  G.police.setWanted(2);
  holdKeys(G, ['KeyW'], true);
  runSteps(G, 6);
  holdKeys(G, ['KeyW'], false);
  rearCam(G, car, 15, 3, 5.5, 12);
}

// On foot on a Downtown sidewalk, pistol aimed down the avenue, one star,
// the pedestrians scattering.
function stageStreet(G) {
  G.player.position.set(8, 0, 2);
  G.player.mesh.position.set(8, 0, 2);
  G.player.mesh.rotation.y = Math.PI;
  G.police.setWanted(1);
  G.peds.scatterAt(G.player.position, 18);
  G.input.mouse.right = true; // aim: crosshair on, combat aiming
  runSteps(G, 3);
  const p = G.player.position;
  G.cameraApi.setFixed(
    new THREE.Vector3(p.x - 3, 2.8, p.z + 5),
    new THREE.Vector3(p.x - 1, 1.5, p.z - 10),
  );
}

// A three-star chase down an avenue: Milo flat out, police cars closing in,
// a handbrake slide leaving a skid. The wanted level goes up once the car is
// moving, so the police spawn near the chase instead of far behind it.
function stageChase(G) {
  const car = putPlayerInCar(G, 'sports', 63, 120, Math.PI, 0x3268c8);
  holdKeys(G, ['KeyW'], true);
  runSteps(G, 1.5);
  G.police.setWanted(3);
  holdKeys(G, ['Space'], true); // handbrake slide
  runSteps(G, 0.5);
  holdKeys(G, ['Space'], false);
  runSteps(G, 2.5);
  holdKeys(G, ['KeyW'], false);
  frontCam(G, car, 16, 4, 4.5, 8);
}

// A mission in progress: Rosa's Dockside job, driving east toward the docks
// beacon with the objective on the HUD and the harbor ahead.
function stageMission(G) {
  G.missions.setCompleted(['mission-1', 'mission-2', 'mission-3', 'mission-4']);
  G.missions.startMission('mission-5');
  const car = putPlayerInCar(G, 'muscle', 180, 3, Math.PI / 2, 0xe8a832);
  holdKeys(G, ['KeyW'], true);
  runSteps(G, 3);
  holdKeys(G, ['KeyW'], false);
  const p = car.mesh.position;
  G.cameraApi.setFixed(
    new THREE.Vector3(p.x - 20, 13, p.z + 18),
    new THREE.Vector3(p.x + 25, 1, p.z),
  );
}

/** Stage the named shot (cover, street, chase or mission; any other name is cover). */
export function stageShot(name, G) {
  G.menus.hideAll();
  if (name === 'street') stageStreet(G);
  else if (name === 'chase') stageChase(G);
  else if (name === 'mission') stageMission(G);
  else stageCover(G);
}
