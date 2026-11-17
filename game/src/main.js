// Boot and the one loop for Sunset Bay: the renderer, the shared context G, every
// system's factory in wiring order, and the fixed-step simulation.
//
// The sim runs in fixed 1/60 s steps (several in a slow frame, none in a fast
// one); the camera, HUD, menus and audio update once per frame. Edge-triggered
// actions (E, R, weapon keys) only fire on the first step of a frame, and the
// input edges clear after a frame that ran the sim — or every frame while the
// sim is paused, so a key pressed in a menu never leaks into the game.
//
// ?seed=N fixes the world. ?shot=cover|street|chase|mission (with &seed=N)
// stages that scene instead of running the loop, paints it twice and sets
// window.__shotReady for a screenshot.
import * as THREE from 'three';
import { CONFIG, TUNING } from './config.js';
import { createRandom } from './random.js';
import { createTextures } from './textures.js';
import { createCity } from './city.js';
import { createInput } from './input.js';
import { createVehicles } from './vehicles.js';
import { createPedestrians } from './pedestrians.js';
import { createPlayer } from './player.js';
import { createPolice } from './police.js';
import { createCombat } from './combat.js';
import { createMissions } from './missions.js';
import { createAudio } from './audio.js';
import { createEffects } from './effects.js';
import { createHUD } from './hud.js';
import { createMenus } from './menus.js';
import { saveGame, loadGame, hasSave, clearSave } from './save.js';
import { createCamera } from './camera.js';
import { stageShot } from './shots.js';

const STEP = CONFIG.STEP;
const MAX_FRAME = CONFIG.MAX_FRAME;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
// A run without ?seed= picks one at random (the starter did the same); a
// screenshot run always passes an explicit seed, so shots reproduce exactly.
const seed = Number.isInteger(seedParam) ? seedParam : (Math.random() * 4294967296) >>> 0;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1200,
);
camera.position.set(0, 12, 24);

const G = {
  scene,
  camera,
  renderer,
  rng: createRandom(seed),
  config: CONFIG,
  time: 0,
  stepInFrame: 0,
};

// Wiring order matters: the city first (everything stands on it), then input,
// then the systems that read the city, then the HUD and menus.
G.textures = createTextures(G.rng);
G.city = createCity(G);
G.input = createInput();
G.vehicles = createVehicles(G);
G.peds = createPedestrians(G);
G.player = createPlayer(G);
G.police = createPolice(G);
G.combat = createCombat(G);
G.missions = createMissions(G);
G.audio = createAudio(G);
G.effects = createEffects(G);
G.hud = createHUD(G);
G.save = { saveGame, loadGame, hasSave, clearSave };
G.menus = createMenus(G);
const cameraApi = createCamera(G);
G.cameraApi = cameraApi;
// player.js and combat.js read the camera heading as G.camera.yaw.
Object.defineProperty(camera, 'yaw', {
  get() {
    return cameraApi.yaw;
  },
  set(value) {
    cameraApi.yaw = value;
  },
  configurable: true,
});
// For debugging and play-testing from the console.
window.__game = G;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function startNewGame() {
  try {
    G.save.clearSave();
  } catch (err) {
    // A missing save slot must never block starting.
  }
  if (G.missions) {
    G.missions.setCurrent(null);
    G.missions.setCompleted([]);
    G.missions.setFoundTokens([]);
  }
  if (G.police) G.police.clearWanted();
  if (G.player.mode === 'car') G.player.exitVehicle();
  const start = G.city.spawnPoints.playerStart;
  G.player.position.set(start.x, 0, start.z);
  G.player.health = G.player.maxHealth;
  G.player.money = TUNING.startMoney;
  G.player.isDead = false;
  G.player.mesh.visible = true;
  cameraApi.yaw = 0; // behind Milo, looking north into Downtown
  G.menus.hideAll();
  G.hud.showObjective('Solmar City');
  G.hud.showHelp('WASD move · Shift sprint · E enter car · Esc pause');
  if (G.audio) G.audio.start();
}

function continueGame() {
  let ok = false;
  try {
    ok = G.save.loadGame(G);
  } catch (err) {
    ok = false;
  }
  if (!ok) {
    G.hud.showMessage('No save to load');
    return;
  }
  // A save made in a car has no car to come back to: start on foot.
  if (G.player.mode === 'car' && !G.vehicles.playerVehicle) {
    G.player.mode = 'foot';
    G.player.mesh.visible = true;
  }
  G.menus.hideAll();
  G.hud.showMessage('Save loaded');
  if (G.audio) G.audio.start();
}

G.menus.onStart = startNewGame;
G.menus.onContinue = continueGame;

function stepWorld(dt) {
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

// The title screen's living city: traffic, pedestrians, clouds — no player,
// no police, no missions.
function stepAmbient(dt) {
  G.time += dt;
  G.vehicles.update(dt);
  G.peds.update(dt);
  G.effects.update(dt);
  G.city.update(dt);
}

function runShot(name) {
  stageShot(name, G);
  G.hud.update(STEP);
  let painted = 0;
  function paint() {
    renderer.render(scene, camera);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

function runGame() {
  let last = performance.now();
  let accumulator = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const frameDt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    const state = G.menus.state;
    let stepsRan = 0;
    if (state === 'play') {
      accumulator += frameDt;
      let guard = 0;
      while (accumulator >= STEP && guard < 5) {
        G.stepInFrame = guard;
        stepWorld(STEP);
        accumulator -= STEP;
        guard += 1;
        stepsRan += 1;
      }
      if (guard >= 5) accumulator = 0; // a long stall is dropped, not replayed
    } else if (state === 'title') {
      accumulator = 0;
      G.stepInFrame = 0;
      stepAmbient(Math.min(frameDt, STEP * 2));
      cameraApi.yaw += frameDt * 0.03; // slow orbit around the spawn
      stepsRan = 1;
    } else {
      accumulator = 0;
      if (G.audio) G.audio.engine(0, false);
    }
    G.audio.update(frameDt);
    cameraApi.update(frameDt);
    G.hud.update(frameDt);
    G.menus.update(frameDt);
    renderer.render(scene, camera);
    // Edges clear once every reader has seen them: after a frame that ran
    // the sim, or every frame while the sim is paused (menus consume theirs).
    if (stepsRan > 0 || state !== 'play') G.input.update();
  }

  // Leaving the tab pauses a running game rather than letting it run unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.menus.state === 'play') G.menus.showPause();
  });

  G.menus.showTitle();
  G.hud.showHelp('WASD move · Shift sprint · E enter car · Esc pause');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
