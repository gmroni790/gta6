// missions.js — story missions, giver markers, hostile enemies and sunset tokens
// for Sunset Bay.
//
// Milo Reyes, a wheelman back in Solmar City after a job gone wrong, works his way
// up through three contacts — Lena Cruz (garage owner), Theo Adeyemi (fixer) and
// Rosa Delgado (dock smuggler) — across six missions that unlock in sequence.
// A mission starts when the player walks into its giver's floating letter marker
// (L / T / R). Each mission is a list of steps (goto, getInCar, driveTo,
// followTarget, loseWanted, pickup, eliminate, deliver, pickupAndDeliver); the
// active step shows a 3D beacon and a minimap blip. Finishing all steps pays the
// reward, autosaves, and unlocks the next mission. Dying, getting busted, being
// spotted on a tail, losing the tail, or running out of time fails the mission and
// makes it available again.
//
// Ten collectible "sunset tokens" (glowing golden discs) are hidden at seeded road
// intersections around the city; each is worth TUNING.tokenValue ($50).
//
// ---------------------------------------------------------------------------
// CONTRACT WITH combat.js — coordinator, please wire this up:
// ---------------------------------------------------------------------------
// Mission enemies are built with createPersonMesh from pedestrians.js. Every enemy
// mesh (the group and all of its children) carries:
//     userData = { type: 'ped', ref: enemy }
// where `enemy` is the enemy object ({ isEnemy: true, health, mesh, pos, ... }).
// The type is deliberately 'ped' so the existing combat.js raycast — which already
// resolves 'ped' hits — finds enemies without any change to its raycast targets.
// When combat.js resolves a hit on a 'ped' whose userData.ref.isEnemy is true, it
// MUST call G.missions.damageEnemy(ref, damage) instead of its normal ped-damage
// path. damageEnemy applies the damage, handles the fall-and-fade death, and the
// kill counts toward the active eliminate step. The live enemy list is
// G.missions.enemies. Enemies have 100 health; the pistol deals 34 damage, so
// three hits kill one.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TUNING, CITY_HALF, AVENUES, STREETS } from './config.js';
import { createRandom } from './random.js';
import { createPersonMesh } from './pedestrians.js';

const TOKEN_COUNT = 10;
const GIVER_RADIUS = 6;
const PICKUP_HOLD = 2; // seconds standing in a pickup marker
const ENEMY_HEALTH = 100;
const ENEMY_SHOOT_INTERVAL = 1.2;
const ENEMY_HIT_CHANCE = 0.35;
const ENEMY_DAMAGE = 8;
const ENEMY_RANGE = 30;
const ENEMY_FADE_DELAY = 3; // seconds lying on the ground before fading out
const ENEMY_FADE_TIME = 1;
const TAIL_MIN_DIST = 8; // closer than this and the tail is spotted
const TAIL_MAX_DIST = 80; // farther than this and the tail is lost
const TAIL_SPEED = 10; // m/s for the tailed sedan
const TAIL_WAIT = 5; // seconds the sedan idles before pulling away
const TAIL_WHEEL_RADIUS = 0.35;

const GIVER_LETTERS = { 'Lena Cruz': 'L', 'Theo Adeyemi': 'T', 'Rosa Delgado': 'R' };
const GIVER_COLORS = { 'Lena Cruz': 0xffd23f, 'Theo Adeyemi': 0x35c4ff, 'Rosa Delgado': 0xff5da2 };

// Fallback spawn points, used only if G.city.spawnPoints is not attached yet when
// this factory runs. The defs are rebuilt from the real spawn points on the first
// update if the city appears later (see ensureBuilt).
const FALLBACK_SPAWN = {
  playerStart: { x: 0, z: 0 },
  garage: { x: -60, z: 60 },
  hospital: { x: 60, z: -60 },
  policeStation: { x: 120, z: 0 },
  marina: { x: -120, z: 240 },
  docks: { x: 260, z: 60 },
  hills: { x: 0, z: -240 },
};

function dist2D(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Letter sprites for giver markers: a bold letter on a coloured disc. Cached so
// each letter/color pair builds its canvas texture and material once.
const letterTextureCache = new Map();
function letterTexture(letter, colorHex) {
  const key = letter + ':' + colorHex;
  let tex = letterTextureCache.get(key);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  const css = '#' + colorHex.toString(16).padStart(6, '0');
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fillStyle = css;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.fillStyle = '#1a1a22';
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 64, 68);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  letterTextureCache.set(key, tex);
  return tex;
}

const letterMaterialCache = new Map();
function letterMaterial(letter, colorHex) {
  const key = letter + ':' + colorHex;
  let mat = letterMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: letterTexture(letter, colorHex),
      transparent: true,
      depthWrite: false,
    });
    letterMaterialCache.set(key, mat);
  }
  return mat;
}

export function createMissions(G) {
  const fallbackRng = createRandom(20261118);
  function rng() {
    return G.rng || fallbackRng;
  }

  let defs = [];
  let built = false;
  let markersBuilt = false;
  let usedFallback = false;

  const completedIds = [];
  const foundTokenIds = [];
  const enemies = [];
  const tokenPositions = [];

  let currentRt = null; // { def, stepIndex, stepState, stepTimer, carrying, stealCar }
  let giverMarkers = []; // { group, sprite, ring, phase, def }
  let tokens = []; // { group, disc, index, phase, taken }
  let beacon = null; // { group, pillar, ring, pillarMat, ringMat }
  let time = 0;
  let lastObjective = '';

  // One shared marker object for the minimap blip: mutated in place so the HUD
  // can read it every frame without per-frame allocation.
  const markerObj = { x: 0, z: 0, label: '' };

  // Shared geometry/materials, created once per factory instance.
  const ringGeo = new THREE.RingGeometry(1.2, 1.9, 40);
  const beaconRingGeo = new THREE.RingGeometry(2.6, 3.6, 48);
  const pillarGeo = new THREE.CylinderGeometry(2.2, 2.2, 42, 20, 1, true);
  const tokenGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.09, 24);
  const bandanaGeo = new THREE.BoxGeometry(0.34, 0.1, 0.34);
  const tokenMat = new THREE.MeshStandardMaterial({
    color: 0xffc933,
    emissive: 0xff9d00,
    emissiveIntensity: 0.9,
    metalness: 0.7,
    roughness: 0.35,
  });
  const bandanaMat = new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.7 });
  const markerMats = new Map();
  function markerMaterial(color) {
    let m = markerMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      markerMats.set(color, m);
    }
    return m;
  }

  // --------------------------------------------------------------------------
  // Mission definitions
  // --------------------------------------------------------------------------

  function spawnPoint(name) {
    const sp = G.city && G.city.spawnPoints && G.city.spawnPoints[name];
    if (sp && typeof sp.x === 'number' && typeof sp.z === 'number') {
      return { x: sp.x, z: sp.z };
    }
    usedFallback = true;
    const fb = FALLBACK_SPAWN[name];
    return { x: fb.x, z: fb.z };
  }

  function buildDefs() {
    usedFallback = false;
    const garage = spawnPoint('garage');
    const marina = spawnPoint('marina');
    const docks = spawnPoint('docks');
    const hills = spawnPoint('hills');
    const theo = { x: 60, z: 60 }; // Downtown
    const oldTownPickup = { x: -180, z: 60 };
    const harborCar = { x: 180, z: 60 };
    const marinaCar = { x: -60, z: 240 };
    const tailDestination = { x: -60, z: 120 };
    const finalMarker = {
      x: clamp(docks.x + 12, -CITY_HALF + 10, CITY_HALF - 10),
      z: clamp(docks.z + 70, -CITY_HALF + 10, CITY_HALF - 10),
    };
    return [
      {
        id: 'mission-1',
        title: 'Back in Solmar',
        giver: 'Lena Cruz',
        giverPos: { x: garage.x, z: garage.z },
        briefing: [
          "Milo Reyes. Thought the mainland swallowed you whole. Welcome home.",
          "Grab any car off the street — Solmar doesn't mind sharing.",
          "Meet me at the Marina viewpoint. Let's see if you can still drive.",
        ],
        steps: [
          { type: 'goto', target: { x: garage.x, z: garage.z }, radius: 8, hold: 2, text: "Head to Lena's garage" },
          { type: 'getInCar', text: 'Get in a car' },
          { type: 'driveTo', target: { x: marina.x, z: marina.z }, radius: 12, text: 'Drive to the Marina viewpoint' },
        ],
        reward: 200,
      },
      {
        id: 'mission-2',
        title: 'The Pickup',
        giver: 'Lena Cruz',
        giverPos: { x: garage.x, z: garage.z },
        briefing: [
          'A friend in Old Town has a package for me. Go fetch it, no questions.',
          'Stand by the drop point until the handoff is done.',
          'Then get it to the Marina. Fast. Two minutes, or the buyer walks.',
        ],
        steps: [
          { type: 'driveTo', target: { x: oldTownPickup.x, z: oldTownPickup.z }, radius: 12, text: 'Drive to the pickup in Old Town' },
          { type: 'pickup', target: { x: oldTownPickup.x, z: oldTownPickup.z }, radius: 6, text: 'Pick up the package' },
          { type: 'driveTo', target: { x: marina.x, z: marina.z }, radius: 12, timeLimit: 120, text: 'Deliver the package to the Marina' },
        ],
        reward: 350,
      },
      {
        id: 'mission-3',
        title: 'Tail Job',
        giver: 'Theo Adeyemi',
        giverPos: { x: theo.x, z: theo.z },
        briefing: [
          "There's a sedan making rounds through Downtown. I need to know where it stops.",
          "You'll want wheels for this one. Stay close enough to see it, far enough that they don't see you.",
          "When it parks, deal with whoever's waiting. Quietly.",
        ],
        steps: [
          {
            type: 'followTarget',
            text: 'Tail the sedan',
            // A loop along road centrelines around Downtown, ending parked on
            // the street at z = 120. The car starts 60m from Theo's spot so
            // the player is inside tail range when the mission begins.
            waypoints: [
              { x: 60, z: 120 },
              { x: 60, z: -120 },
              { x: -120, z: -120 },
              { x: -120, z: 120 },
              { x: tailDestination.x, z: tailDestination.z },
            ],
            destination: { x: tailDestination.x, z: tailDestination.z },
          },
          { type: 'eliminate', target: { x: tailDestination.x, z: tailDestination.z }, count: 2, radius: 16, text: 'Take out the guards' },
        ],
        reward: 500,
      },
      {
        id: 'mission-4',
        title: 'Heat',
        giver: 'Theo Adeyemi',
        giverPos: { x: theo.x, z: theo.z },
        briefing: [
          'A sports car is parked over in the Harbor district. It needs a new home.',
          'Take it, and the cops will come. Lose them before you bring it in.',
          "Bring it to Lena's garage when the heat's off.",
        ],
        steps: [
          { type: 'goto', target: { x: harborCar.x, z: harborCar.z }, radius: 10, spawnCar: { type: 'sports', color: 0xc83232 }, text: 'Find the sports car in the Harbor' },
          { type: 'getInCar', steal: true, wantedOnEnter: 2, text: 'Take the sports car' },
          { type: 'loseWanted', text: 'Lose the cops' },
          { type: 'driveTo', target: { x: garage.x, z: garage.z }, radius: 10, text: "Deliver the car to Lena's garage" },
        ],
        reward: 600,
      },
      {
        id: 'mission-5',
        title: 'Dockside',
        giver: 'Rosa Delgado',
        giverPos: { x: docks.x, z: docks.z },
        briefing: [
          'My crew at the docks has a problem. Three of them, actually, with guns.',
          'Clear them out, then grab the crate they were sitting on.',
          "The buyer waits at the Hills villa. Don't keep her waiting.",
        ],
        steps: [
          { type: 'goto', target: { x: docks.x, z: docks.z }, radius: 12, hold: 2, text: 'Go to the docks' },
          { type: 'eliminate', target: { x: docks.x, z: docks.z }, count: 3, radius: 18, text: 'Clear out the dock crew' },
          {
            type: 'pickupAndDeliver',
            pickupTarget: { x: docks.x, z: docks.z },
            deliverTarget: { x: hills.x, z: hills.z },
            radius: 10,
            text: 'Collect the crate, then deliver it to the Hills villa',
          },
        ],
        reward: 800,
      },
      {
        id: 'mission-6',
        title: 'The Sunset Job',
        giver: 'Rosa Delgado',
        giverPos: { x: docks.x, z: docks.z },
        briefing: [
          "One last job, Milo. A gold sports car at the Marina — the buyer's dream.",
          'Take it, shake the cops, bring it to the docks.',
          "There's a welcoming party waiting. Handle them, then walk into the sunset.",
        ],
        steps: [
          { type: 'goto', target: { x: marinaCar.x, z: marinaCar.z }, radius: 10, spawnCar: { type: 'sports', color: 0xe8a832 }, text: 'Find the gold sports car at the Marina' },
          { type: 'getInCar', steal: true, wantedOnEnter: 3, text: 'Take the gold sports car' },
          { type: 'loseWanted', text: 'Lose the cops' },
          { type: 'driveTo', target: { x: docks.x, z: docks.z }, radius: 12, text: 'Drive the car to the docks' },
          { type: 'eliminate', target: { x: docks.x, z: docks.z }, count: 2, radius: 18, text: 'Deal with the welcoming party' },
          { type: 'goto', target: { x: finalMarker.x, z: finalMarker.z }, radius: 8, text: 'Walk to the meeting point' },
        ],
        reward: 1500,
      },
    ];
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function playerPos() {
    if (G.player && G.player.position) return G.player.position;
    return null;
  }

  function showObjective(text) {
    if (text === lastObjective) return;
    lastObjective = text;
    if (G.hud && typeof G.hud.showObjective === 'function') G.hud.showObjective(text);
  }

  function clearObjective() {
    lastObjective = '';
    if (G.hud && typeof G.hud.showObjective === 'function') G.hud.showObjective('');
  }

  function showMessage(text, dur) {
    if (G.hud && typeof G.hud.showMessage === 'function') G.hud.showMessage(text, dur);
  }

  function showDialogue(name, line, dur) {
    if (G.hud && typeof G.hud.showDialogue === 'function') G.hud.showDialogue(name, line, dur);
  }

  function isCompleted(id) {
    return completedIds.indexOf(id) !== -1;
  }

  function predecessorCompleted(def) {
    const idx = defs.indexOf(def);
    if (idx <= 0) return true;
    return isCompleted(defs[idx - 1].id);
  }

  // Assumes defs are built; availableMissions() is the public version that
  // builds first. refreshGiverMarkers uses this one to avoid re-entrancy.
  function availableDefs() {
    return defs.filter((def) => {
      if (isCompleted(def.id)) return false;
      if (currentRt && currentRt.def.id === def.id) return false;
      return predecessorCompleted(def);
    });
  }

  function availableMissions() {
    ensureBuilt();
    return availableDefs();
  }

  // --------------------------------------------------------------------------
  // Visuals: beacon, giver markers, tokens
  // --------------------------------------------------------------------------

  function buildBeacon() {
    if (beacon || !G.scene) return;
    const group = new THREE.Group();
    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xffd23f,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = 21;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd23f,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(beaconRingGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    group.add(pillar);
    group.add(ring);
    group.visible = false;
    G.scene.add(group);
    beacon = { group, pillar, ring, pillarMat, ringMat };
  }

  function setBeacon(x, z, color) {
    if (!beacon) return;
    beacon.group.visible = true;
    beacon.group.position.set(x, 0, z);
    if (typeof color === 'number') {
      beacon.pillarMat.color.setHex(color);
      beacon.ringMat.color.setHex(color);
    }
  }

  function hideBeacon() {
    if (beacon) beacon.group.visible = false;
  }

  function setCurrentMarker(x, z, label) {
    if (typeof x !== 'number' || typeof z !== 'number') {
      api.currentMarker = null;
      return;
    }
    markerObj.x = x;
    markerObj.z = z;
    markerObj.label = label || '';
    api.currentMarker = markerObj;
  }

  function refreshGiverMarkers() {
    if (!G.scene) return;
    for (const m of giverMarkers) {
      G.scene.remove(m.group);
    }
    giverMarkers = [];
    for (const def of availableDefs()) {
      const color = GIVER_COLORS[def.giver] || 0xffd23f;
      const letter = GIVER_LETTERS[def.giver] || '?';
      const group = new THREE.Group();
      const ring = new THREE.Mesh(ringGeo, markerMaterial(color));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.12;
      const sprite = new THREE.Sprite(letterMaterial(letter, color));
      sprite.scale.set(1.7, 1.7, 1);
      sprite.position.y = 2.6;
      group.add(ring);
      group.add(sprite);
      group.position.set(def.giverPos.x, 0, def.giverPos.z);
      G.scene.add(group);
      giverMarkers.push({ group, sprite, ring, phase: rng().next() * Math.PI * 2, def });
    }
    markersBuilt = true;
  }

  function buildTokens() {
    if (tokens.length > 0 || !G.scene) return;
    const used = new Set();
    const r = rng();
    for (let i = 0; i < TOKEN_COUNT; i++) {
      let x = 0;
      let z = 0;
      let key = '';
      let guard = 0;
      do {
        // Tokens sit at road intersections so they are always reachable.
        const ax = r.pick(AVENUES);
        const sz = r.pick(STREETS);
        x = ax + r.range(-4, 4);
        z = sz + r.range(-4, 4);
        key = ax + ',' + sz;
        guard++;
      } while (used.has(key) && guard < 40);
      used.add(key);
      const group = new THREE.Group();
      const disc = new THREE.Mesh(tokenGeo, tokenMat);
      disc.rotation.x = Math.PI / 2; // stand the disc up like a coin
      group.add(disc);
      group.position.set(x, 1.2, z);
      G.scene.add(group);
      tokens.push({ group, disc, index: i, phase: r.next() * Math.PI * 2, taken: false });
      tokenPositions.push({ x, z });
    }
  }

  function collectToken(t) {
    t.taken = true;
    t.group.visible = false;
    foundTokenIds.push(t.index);
    api.tokensFound = foundTokenIds.length;
    if (G.player) G.player.money += TUNING.tokenValue;
    if (G.audio && typeof G.audio.pickup === 'function') G.audio.pickup();
    showMessage('Sunset token! +$' + TUNING.tokenValue);
  }

  function updateTokens(dt, pos) {
    for (const t of tokens) {
      if (t.taken) continue;
      t.group.rotation.y += dt * 1.2;
      t.group.position.y = 1.2 + Math.sin(time * 1.6 + t.phase) * 0.2;
      if (pos && dist2D(pos.x, pos.z, t.group.position.x, t.group.position.z) < 2) {
        collectToken(t);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Enemies
  // --------------------------------------------------------------------------

  function spawnEnemies(count, center, spread) {
    const made = [];
    if (!G.scene) return made;
    const r = rng();
    for (let i = 0; i < count; i++) {
      let x = center.x + r.range(-spread, spread);
      let z = center.z + r.range(-spread, spread);
      if (G.city && typeof G.city.collides === 'function') {
        for (let attempt = 0; attempt < 5 && G.city.collides(x, z, 1); attempt++) {
          x = center.x + r.range(-spread, spread);
          z = center.z + r.range(-spread, spread);
        }
      }
      const body = createPersonMesh(r, {
        shirt: 0x23232b,
        pants: 0x17171c,
        skin: 0xb57a52,
        accent: 0xcc2222,
      });
      // Red bandana accent, added here so it shows whatever pedestrians.js
      // does with the opts above.
      const bandana = new THREE.Mesh(bandanaGeo, bandanaMat);
      bandana.position.y = 1.64;
      body.add(bandana);
      // Outer group owns position/facing; the body itself rotates when falling.
      const group = new THREE.Group();
      group.add(body);
      group.position.set(x, 0, z);
      group.rotation.y = r.range(0, Math.PI * 2);
      const enemy = {
        isEnemy: true,
        mesh: group,
        body,
        pos: group.position,
        health: ENEMY_HEALTH,
        state: 'alive',
        shootTimer: r.range(0.3, ENEMY_SHOOT_INTERVAL),
        deathTime: 0,
        fallT: 0,
      };
      // Clone materials so the death fade never touches shared ped materials,
      // and tag every mesh so combat.js raycasts find the enemy (see the
      // contract comment at the top of this file).
      group.traverse((child) => {
        if (child.isMesh) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((m) => m.clone());
          } else if (child.material) {
            child.material = child.material.clone();
          }
        }
        child.userData = { type: 'ped', ref: enemy };
      });
      G.scene.add(group);
      enemies.push(enemy);
      made.push(enemy);
    }
    return made;
  }

  // Called by combat.js when its raycast hits an enemy (see top-of-file
  // contract). Applies damage, starts the fall-and-fade death at 0 health.
  function damageEnemy(ref, damage) {
    if (!ref || ref.state !== 'alive') return;
    ref.health -= damage;
    if (G.effects && typeof G.effects.hitPuff === 'function' && ref.pos) {
      G.effects.hitPuff(new THREE.Vector3(ref.pos.x, 1.2, ref.pos.z));
    }
    if (ref.health <= 0) {
      ref.state = 'dead';
      ref.deathTime = 0;
      ref.fallT = 0;
    }
  }

  function setEnemyOpacity(e, opacity) {
    e.mesh.traverse((child) => {
      if (child.isMesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (!m) continue;
          m.transparent = true;
          m.opacity = opacity;
        }
      }
    });
  }

  function removeEnemyAt(i) {
    const e = enemies[i];
    if (G.scene) G.scene.remove(e.mesh);
    e.mesh.traverse((child) => {
      if (child.isMesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) if (m && typeof m.dispose === 'function') m.dispose();
      }
    });
    enemies.splice(i, 1);
  }

  function shootAtPlayer(e, pos, dx, dz, d) {
    const from = new THREE.Vector3(e.pos.x, 1.4, e.pos.z);
    const dir = d > 0.001
      ? new THREE.Vector3(dx / d, 0, dz / d)
      : new THREE.Vector3(0, 0, 1);
    if (G.effects && typeof G.effects.muzzleFlash === 'function') {
      G.effects.muzzleFlash(from, dir);
    }
    if (rng().chance(ENEMY_HIT_CHANCE) && G.player && typeof G.player.takeDamage === 'function') {
      G.player.takeDamage(ENEMY_DAMAGE);
    }
  }

  function updateEnemies(dt, pos) {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.state === 'alive') {
        if (pos) {
          const dx = pos.x - e.pos.x;
          const dz = pos.z - e.pos.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          e.mesh.rotation.y = Math.atan2(dx, dz);
          const playerDead = !!(G.player && G.player.isDead);
          if (d < ENEMY_RANGE && !playerDead) {
            e.shootTimer -= dt;
            if (e.shootTimer <= 0) {
              e.shootTimer = ENEMY_SHOOT_INTERVAL;
              shootAtPlayer(e, pos, dx, dz, d);
            }
          }
        }
      } else {
        // Fall over, lie still for a while, then fade away.
        e.deathTime += dt;
        e.fallT += dt;
        const k = Math.min(1, e.fallT / 0.4);
        e.body.rotation.x = (-Math.PI / 2) * k;
        if (e.deathTime > ENEMY_FADE_DELAY) {
          const fade = 1 - (e.deathTime - ENEMY_FADE_DELAY) / ENEMY_FADE_TIME;
          setEnemyOpacity(e, Math.max(0, fade));
          if (fade <= 0) removeEnemyAt(i);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Mission cars (scripted tail car + parked steal targets)
  // --------------------------------------------------------------------------

  // A scripted/parked car must not be driven by the traffic system: mark it
  // driverless and, if it landed in the traffic list, take it back out.
  function parkCar(car) {
    if (!car) return car;
    if ('driver' in car) car.driver = null;
    car.isPlayer = false;
    if (typeof car.speed === 'number') car.speed = 0;
    if (G.vehicles && Array.isArray(G.vehicles.traffic)) {
      const idx = G.vehicles.traffic.indexOf(car);
      if (idx !== -1) G.vehicles.traffic.splice(idx, 1);
    }
    return car;
  }

  function spawnMissionCar(spec, at) {
    if (!G.vehicles || typeof G.vehicles.spawnVehicle !== 'function') return null;
    const heading = rng().range(0, Math.PI * 2);
    const car = G.vehicles.spawnVehicle(spec.type || 'sports', at.x, at.z, heading, { color: spec.color });
    return parkCar(car || null);
  }

  function spawnTailCar(step) {
    if (!G.vehicles || typeof G.vehicles.spawnVehicle !== 'function') return null;
    const start = step.waypoints[0];
    const next = step.waypoints[1] || step.destination;
    const heading = Math.atan2(next.x - start.x, next.z - start.z);
    const car = G.vehicles.spawnVehicle('sedan', start.x, start.z, heading, { color: 0x2a2a33 });
    if (car && car.mesh) car.mesh.rotation.y = heading;
    return parkCar(car || null);
  }

  // --------------------------------------------------------------------------
  // Mission flow
  // --------------------------------------------------------------------------

  function currentStepDef() {
    if (!currentRt) return null;
    return currentRt.def.steps[currentRt.stepIndex] || null;
  }

  function objectiveText(step, rt) {
    let text = step.text || '';
    if (step.type === 'followTarget') {
      const car = rt.stepState.car;
      const pos = playerPos();
      if (car && car.mesh && pos) {
        const d = Math.round(dist2D(pos.x, pos.z, car.mesh.position.x, car.mesh.position.z));
        text = 'Tail the sedan - ' + d + 'm (stay 8-80m away)';
      }
    } else if (step.type === 'eliminate' && rt.stepState.enemies) {
      let left = 0;
      for (const e of rt.stepState.enemies) if (e.state === 'alive') left++;
      text += ' (' + left + ' left)';
    } else if (step.type === 'pickup' && rt.stepState.hold > 0) {
      text = 'Picking up... ' + Math.ceil(PICKUP_HOLD - rt.stepState.hold) + 's';
    } else if (step.type === 'pickupAndDeliver') {
      if (rt.stepState.phase === 'pickup') {
        text = rt.stepState.hold > 0
          ? 'Picking up... ' + Math.ceil(PICKUP_HOLD - rt.stepState.hold) + 's'
          : 'Pick up the crate at the docks';
      } else {
        text = 'Deliver the crate to the Hills villa';
      }
    } else if (step.type === 'loseWanted' && G.police && typeof G.police.wanted === 'number') {
      text += ' (wanted: ' + G.police.wanted + ')';
    }
    if (typeof step.timeLimit === 'number' && rt.stepTimer > 0) {
      text += ' - ' + formatTime(rt.stepTimer);
    }
    return text;
  }

  function enterStep() {
    const rt = currentRt;
    const step = currentStepDef();
    if (!rt || !step) return;
    rt.stepState = {};
    rt.stepTimer = typeof step.timeLimit === 'number' ? step.timeLimit : 0;
    // HUD reads these to derive the objective line, the step signature and
    // the timer chip (see hud.js currentStepInfo / updateTimer).
    api.stepIndex = rt.stepIndex;
    api.step = step;
    api.timeLeft = rt.stepTimer;
    // Briefing lines play as the mission advances: line 0 at the start, then
    // one more line per step while lines remain.
    if (rt.stepIndex > 0 && rt.def.briefing && rt.def.briefing[rt.stepIndex]) {
      showDialogue(rt.def.giver, rt.def.briefing[rt.stepIndex], 5);
    }
    switch (step.type) {
      case 'goto':
      case 'driveTo':
      case 'deliver': {
        if (step.spawnCar) {
          rt.stealCar = spawnMissionCar(step.spawnCar, step.target);
        }
        setBeacon(step.target.x, step.target.z, 0xffd23f);
        setCurrentMarker(step.target.x, step.target.z, step.text);
        break;
      }
      case 'getInCar': {
        if (rt.stealCar && rt.stealCar.mesh) {
          const p = rt.stealCar.mesh.position;
          setBeacon(p.x, p.z, 0xffd23f);
          setCurrentMarker(p.x, p.z, step.text);
        } else {
          hideBeacon();
          setCurrentMarker();
        }
        break;
      }
      case 'followTarget': {
        rt.stepState.car = spawnTailCar(step);
        rt.stepState.wpIndex = 1;
        rt.stepState.wait = TAIL_WAIT;
        rt.stepState.moving = false;
        if (!rt.stepState.car) {
          // No vehicle system: nothing to tail, so move on rather than soft-lock.
          advanceStep();
          return;
        }
        setBeacon(step.waypoints[0].x, step.waypoints[0].z, 0xcc44ff);
        setCurrentMarker(step.waypoints[0].x, step.waypoints[0].z, 'Target sedan');
        break;
      }
      case 'eliminate': {
        rt.stepState.enemies = spawnEnemies(step.count || 1, step.target, 6);
        setBeacon(step.target.x, step.target.z, 0xff4444);
        setCurrentMarker(step.target.x, step.target.z, step.text);
        break;
      }
      case 'pickup': {
        rt.stepState.hold = 0;
        setBeacon(step.target.x, step.target.z, 0xffd23f);
        setCurrentMarker(step.target.x, step.target.z, step.text);
        break;
      }
      case 'pickupAndDeliver': {
        rt.stepState.phase = 'pickup';
        rt.stepState.hold = 0;
        setBeacon(step.pickupTarget.x, step.pickupTarget.z, 0xffd23f);
        setCurrentMarker(step.pickupTarget.x, step.pickupTarget.z, 'Pick up the crate');
        break;
      }
      case 'loseWanted':
      default: {
        hideBeacon();
        setCurrentMarker();
        break;
      }
    }
    showObjective(objectiveText(step, rt));
  }

  function advanceStep() {
    const rt = currentRt;
    if (!rt) return;
    rt.stepIndex += 1;
    if (rt.stepIndex >= rt.def.steps.length) {
      completeMission();
    } else {
      enterStep();
    }
  }

  function cleanupMission() {
    const rt = currentRt;
    if (!rt) return;
    // Remove any enemies this mission spawned that are still standing. (Dead
    // ones finish their fade on their own.)
    if (rt.stepState && rt.stepState.enemies) {
      const doomed = rt.stepState.enemies;
      for (let i = enemies.length - 1; i >= 0; i--) {
        if (doomed.indexOf(enemies[i]) !== -1) removeEnemyAt(i);
      }
    }
    currentRt = null;
    api.current = null;
    api.currentMarker = null;
    api.stepIndex = 0;
    api.step = null;
    api.timeLeft = 0;
    hideBeacon();
    clearObjective();
  }

  function completeMission() {
    const rt = currentRt;
    if (!rt) return;
    const def = rt.def;
    if (G.player) G.player.money += def.reward;
    showMessage(def.title + ' complete! +$' + def.reward, 5);
    if (G.menus && typeof G.menus.showMissionComplete === 'function') {
      G.menus.showMissionComplete(def.title, def.reward);
    }
    if (def.id === 'mission-6') {
      showDialogue('Rosa Delgado', "That's the last of it, Milo. Solmar City is yours now — spend the sunset well.", 8);
    }
    if (!isCompleted(def.id)) completedIds.push(def.id);
    cleanupMission();
    if (G.save && typeof G.save.saveGame === 'function') {
      try {
        G.save.saveGame(G);
      } catch (err) {
        // Autosave is best-effort; a failed save must not break the game.
      }
    }
    refreshGiverMarkers();
  }

  function failMission(reason) {
    if (!currentRt) return;
    showMessage('Mission failed' + (reason ? ' - ' + reason : ''), 5);
    cleanupMission();
    refreshGiverMarkers();
  }

  function beginMission(def) {
    currentRt = {
      def,
      stepIndex: 0,
      stepState: {},
      stepTimer: 0,
      carrying: false,
      stealCar: null,
    };
    api.current = def;
    refreshGiverMarkers();
    if (def.briefing && def.briefing[0]) showDialogue(def.giver, def.briefing[0], 5);
    enterStep();
  }

  function startMission(id) {
    ensureBuilt();
    const def = defs.find((d) => d.id === id);
    if (!def) return false;
    if (isCompleted(id)) return false;
    if (currentRt) {
      if (currentRt.def.id === id) {
        // Restarting the active mission (e.g. from the pause menu).
        cleanupMission();
      } else {
        return false;
      }
    }
    if (!predecessorCompleted(def)) return false;
    beginMission(def);
    return true;
  }

  function setCompleted(ids) {
    ensureBuilt();
    completedIds.length = 0;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (defs.some((d) => d.id === id) && completedIds.indexOf(id) === -1) {
          completedIds.push(id);
        }
      }
    }
    if (currentRt && isCompleted(currentRt.def.id)) {
      cleanupMission();
    }
    refreshGiverMarkers();
  }

  function setCurrent(id) {
    ensureBuilt();
    if (id === null || id === undefined) {
      if (currentRt) cleanupMission();
      refreshGiverMarkers();
      return;
    }
    if (currentRt && currentRt.def.id === id) return;
    const def = defs.find((d) => d.id === id);
    if (!def || isCompleted(id)) return;
    if (currentRt) cleanupMission();
    // Restore from a save: trust the saved id and restart the mission fresh.
    beginMission(def);
  }

  function setFoundTokens(arr) {
    ensureBuilt();
    foundTokenIds.length = 0;
    if (Array.isArray(arr)) {
      for (const i of arr) {
        if (typeof i === 'number' && foundTokenIds.indexOf(i) === -1) foundTokenIds.push(i);
      }
    }
    for (const t of tokens) {
      const taken = foundTokenIds.indexOf(t.index) !== -1;
      t.taken = taken;
      t.group.visible = !taken;
    }
    api.tokensFound = foundTokenIds.length;
  }

  // --------------------------------------------------------------------------
  // Step updates
  // --------------------------------------------------------------------------

  function updateFollowTarget(dt, rt, step, pos) {
    const st = rt.stepState;
    const car = st.car;
    if (!car || !car.mesh) {
      advanceStep();
      return;
    }
    const carPos = car.mesh.position;
    // The beacon and minimap blip track the moving car.
    setBeacon(carPos.x, carPos.z, 0xcc44ff);
    setCurrentMarker(carPos.x, carPos.z, 'Target sedan');
    if (typeof car.health === 'number' && car.health <= 0) {
      failMission('The target car was destroyed');
      return;
    }

    if (st.wait > 0) {
      st.wait -= dt;
      if (st.wait <= 0) st.moving = true;
    } else if (st.wpIndex < step.waypoints.length) {
      const wp = step.waypoints[st.wpIndex];
      const dx = wp.x - carPos.x;
      const dz = wp.z - carPos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 5) {
        st.wpIndex += 1;
        if (st.wpIndex >= step.waypoints.length) {
          // Arrived at the destination: the tail is done.
          if (typeof car.speed === 'number') car.speed = 0;
          advanceStep();
          return;
        }
      } else {
        const desired = Math.atan2(dx, dz);
        car.mesh.rotation.y = lerpAngle(car.mesh.rotation.y, desired, Math.min(1, dt * 3));
        const h = car.mesh.rotation.y;
        carPos.x += Math.sin(h) * TAIL_SPEED * dt;
        carPos.z += Math.cos(h) * TAIL_SPEED * dt;
        if ('heading' in car) car.heading = h;
        // NOTE: deliberately do NOT set car.speed here. vehicles.js moves any
        // driverless car with speed > 0 a second time in its own update
        // (moveVehicle), which would double the tail car's speed. The car is
        // driven purely by the position updates above; its speed stays 0.
        if (car.wheels) {
          for (const w of car.wheels) w.rotation.x += (TAIL_SPEED * dt) / TAIL_WHEEL_RADIUS;
        }
      }
    }

    // Tail discipline: too close and you are spotted, too far and you lose it.
    // The "lost" check only starts once the car has pulled away.
    if (pos) {
      const pd = dist2D(pos.x, pos.z, carPos.x, carPos.z);
      if (pd < TAIL_MIN_DIST) {
        failMission('You were spotted!');
        return;
      }
      if (st.moving && pd > TAIL_MAX_DIST) {
        failMission('You lost the tail.');
      }
    }
  }

  function updateStep(dt) {
    const rt = currentRt;
    if (!rt) return;
    const step = currentStepDef();
    if (!step) return;
    const pos = playerPos();
    const beforeIndex = rt.stepIndex;

    // Timed steps count down; running out fails the mission.
    if (typeof step.timeLimit === 'number' && rt.stepTimer > 0) {
      rt.stepTimer -= dt;
      api.timeLeft = Math.max(0, rt.stepTimer);
      if (rt.stepTimer <= 0) {
        failMission('Out of time');
        return;
      }
    }

    switch (step.type) {
      case 'goto': {
        if (pos && step.target && dist2D(pos.x, pos.z, step.target.x, step.target.z) <= (step.radius || 8)) {
          // A step with `hold` needs the player to stand in the marker for
          // that many seconds: the first step of a mission shares its target
          // with the giver marker that starts it, so without the hold it
          // would complete in the same update the mission begins and its
          // objective text would never be seen.
          if (step.hold) {
            rt.stepState.hold = (rt.stepState.hold || 0) + dt;
            if (rt.stepState.hold >= step.hold) advanceStep();
          } else {
            advanceStep();
          }
        } else {
          rt.stepState.hold = 0;
        }
        break;
      }
      case 'getInCar': {
        if (rt.stealCar && rt.stealCar.mesh) {
          const p = rt.stealCar.mesh.position;
          setBeacon(p.x, p.z, 0xffd23f);
          setCurrentMarker(p.x, p.z, step.text);
          if (typeof rt.stealCar.health === 'number' && rt.stealCar.health <= 0) {
            failMission('The car was destroyed');
            break;
          }
        }
        if (G.player && G.player.mode === 'car') {
          if (step.steal && rt.stealCar) {
            const pv = G.vehicles && G.vehicles.playerVehicle;
            if (pv !== rt.stealCar) break;
          }
          if (step.wantedOnEnter && G.police && typeof G.police.setWanted === 'function') {
            G.police.setWanted(step.wantedOnEnter);
            showMessage('The cops are onto you!', 4);
          }
          advanceStep();
        }
        break;
      }
      case 'driveTo': {
        if (pos && G.player && G.player.mode === 'car' && step.target &&
            dist2D(pos.x, pos.z, step.target.x, step.target.z) <= (step.radius || 10)) {
          advanceStep();
        }
        break;
      }
      case 'followTarget': {
        updateFollowTarget(dt, rt, step, pos);
        break;
      }
      case 'loseWanted': {
        if (!G.police || G.police.wanted === 0) {
          advanceStep();
        }
        break;
      }
      case 'pickup': {
        if (pos && step.target && dist2D(pos.x, pos.z, step.target.x, step.target.z) <= (step.radius || 6)) {
          rt.stepState.hold = (rt.stepState.hold || 0) + dt;
          if (rt.stepState.hold >= PICKUP_HOLD) advanceStep();
        } else {
          rt.stepState.hold = 0;
        }
        break;
      }
      case 'eliminate': {
        const list = rt.stepState.enemies || [];
        if (list.length > 0 && list.every((e) => e.state !== 'alive')) {
          advanceStep();
        }
        break;
      }
      case 'deliver': {
        if (pos && step.target && dist2D(pos.x, pos.z, step.target.x, step.target.z) <= (step.radius || 10)) {
          rt.carrying = false;
          advanceStep();
        }
        break;
      }
      case 'pickupAndDeliver': {
        if (rt.stepState.phase === 'pickup') {
          if (pos && dist2D(pos.x, pos.z, step.pickupTarget.x, step.pickupTarget.z) <= (step.radius || 8)) {
            rt.stepState.hold = (rt.stepState.hold || 0) + dt;
            if (rt.stepState.hold >= PICKUP_HOLD) {
              rt.stepState.phase = 'deliver';
              rt.carrying = true;
              showMessage('Crate secured - take it to the Hills villa', 4);
              setBeacon(step.deliverTarget.x, step.deliverTarget.z, 0xffd23f);
              setCurrentMarker(step.deliverTarget.x, step.deliverTarget.z, 'Deliver the crate');
            }
          } else {
            rt.stepState.hold = 0;
          }
        } else if (pos && dist2D(pos.x, pos.z, step.deliverTarget.x, step.deliverTarget.z) <= (step.radius || 10)) {
          rt.carrying = false;
          advanceStep();
        }
        break;
      }
      default: {
        advanceStep();
        break;
      }
    }

    // Keep dynamic objective text (tail distance, countdown, guards left)
    // fresh, but only while still on the same step — advancing already set
    // the new step's objective in enterStep.
    if (currentRt === rt && rt.stepIndex === beforeIndex) {
      showObjective(objectiveText(step, rt));
    }
  }

  // --------------------------------------------------------------------------
  // Build + main update
  // --------------------------------------------------------------------------

  function ensureBuilt() {
    if (!built) {
      built = true;
      defs = buildDefs();
      api.list = defs;
      buildTokens();
      buildBeacon();
      refreshGiverMarkers();
      return;
    }
    // Retry visuals if the scene was not attached on the first pass.
    if (G.scene) {
      if (tokens.length === 0) buildTokens();
      if (!beacon) buildBeacon();
      if (!markersBuilt) refreshGiverMarkers();
    }
    // If the city was not attached when this factory ran, rebuild the mission
    // defs from the real spawn points once they appear (only while idle, so a
    // mission in progress never has its targets moved underneath it).
    if (usedFallback && !currentRt && G.city && G.city.spawnPoints) {
      defs = buildDefs();
      api.list = defs;
      refreshGiverMarkers();
    }
  }

  function update(dt) {
    ensureBuilt();
    time += dt;
    const pos = playerPos();

    // Animate giver markers (bobbing letter, pulsing ring) and check for
    // walk-in mission starts.
    for (const m of giverMarkers) {
      m.sprite.position.y = 2.6 + Math.sin(time * 2 + m.phase) * 0.25;
      const s = 1 + Math.sin(time * 2 + m.phase) * 0.08;
      m.ring.scale.set(s, s, 1);
    }
    if (!currentRt && pos) {
      for (const m of giverMarkers) {
        if (dist2D(pos.x, pos.z, m.def.giverPos.x, m.def.giverPos.z) < GIVER_RADIUS) {
          startMission(m.def.id);
          break;
        }
      }
    }

    // Death or arrest fails the active mission.
    if (currentRt) {
      const dead = !!(G.player && G.player.isDead);
      const busted = !!(G.menus && (G.menus.state === 'busted' || G.menus.state === 'wasted'));
      if (dead || busted) {
        failMission(dead ? 'You were wasted' : 'You were busted');
      }
    }

    if (currentRt) updateStep(dt);

    updateEnemies(dt, pos);
    updateTokens(dt, pos);

    // Beacon pulse.
    if (beacon && beacon.group.visible) {
      const s = 1 + Math.sin(time * 3) * 0.12;
      beacon.ring.scale.set(s, s, 1);
      beacon.pillarMat.opacity = 0.14 + Math.sin(time * 3) * 0.05;
    }
  }

  const api = {
    update,
    list: defs,
    current: null,
    currentMarker: null,
    stepIndex: 0,
    step: null,
    timeLeft: 0,
    startMission,
    availableMissions,
    completed: completedIds,
    setCompleted,
    setCurrent,
    tokensFound: 0,
    foundTokens: foundTokenIds,
    setFoundTokens,
    // Extra surface other modules read:
    tokenPositions, // [{x, z}] — HUD minimap draws green dots for these
    enemies, // live enemy objects (alive + dying)
    damageEnemy, // combat.js calls this for raycast hits on enemies
  };

  // Build eagerly (defs, tokens, beacon, giver markers) so the API is fully
  // populated as soon as the factory returns; ensureBuilt retries anything the
  // scene was not ready for, on the first update.
  ensureBuilt();

  G.missions = api;
  return api;
}
