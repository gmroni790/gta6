// Combat for Sunset Bay: fists, pistol and (from mission 3) SMG. On foot
// only. Left mouse fires toward the centre of the camera view, right mouse
// aims (camera.js reads `aiming` for its FOV zoom), R reloads, 1/2/3 switch
// weapons. Hits damage peds, cops and cars via raycast; shooting raises the
// wanted level, throttled to once per 3 seconds.

import * as THREE from 'three';

const RAY_FAR = 200;
const MELEE_RANGE = 2;
const WANTED_THROTTLE = 3; // seconds between wanted gains from shooting

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

export function createCombat(G) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = RAY_FAR;
  const aimCenter = new THREE.Vector2(0, 0);

  const weapons = [
    { id: 'fists', name: 'Fists', damage: 20, rate: 2.5 },
    { id: 'pistol', name: 'Pistol', damage: 34, rate: 4, mag: 12, ammo: 12, reserve: Infinity },
    {
      id: 'smg',
      name: 'SMG',
      damage: 22,
      rate: 9,
      mag: 30,
      ammo: 30,
      reserve: 120,
      locked: true,
    },
  ];

  let time = 0; // internal clock, advanced by update()
  let lastShotTime = -100;
  let lastWantedTime = -100;
  let prevLeft = false;
  let lastCrosshair = null;
  // Downed people fade out 3 s after falling; each entry is { mesh, t }.
  const downed = [];
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

  // Resolve the THREE camera: G.camera may be the camera itself, or the
  // camera module wrapping it.
  function threeCamera() {
    const c = G.camera;
    if (!c) return null;
    if (c.isPerspectiveCamera) return c;
    if (c.camera && c.camera.isPerspectiveCamera) return c.camera;
    if (c.threeCamera && c.threeCamera.isPerspectiveCamera) return c.threeCamera;
    return null;
  }

  function switchWeapon(i) {
    if (i < 0 || i >= weapons.length) return;
    const w = weapons[i];
    if (w.locked) {
      if (G.hud && typeof G.hud.showMessage === 'function') {
        G.hud.showMessage('SMG unlocks in mission 3');
      }
      return;
    }
    api.current = i;
    api.currentWeapon = w;
  }

  function reload() {
    const w = weapons[api.current];
    if (!w.mag) return;
    if (w.ammo >= w.mag) return;
    const need = w.mag - w.ammo;
    if (w.reserve === Infinity) {
      w.ammo = w.mag;
    } else {
      const take = Math.min(need, w.reserve);
      w.ammo += take;
      w.reserve -= take;
    }
    if (G.hud && typeof G.hud.showMessage === 'function') {
      G.hud.showMessage(`${w.name} reloaded`);
    }
  }

  // --- hitting people --------------------------------------------------------

  function knockDown(target) {
    if (!target || target.state === 'down') return;
    target.state = 'down';
    target.downTime = 0;
    if (target.mesh) {
      target.mesh.rotation.x = -Math.PI / 2;
      downed.push({ mesh: target.mesh, t: 0 });
    }
  }

  function damagePerson(target, damage, point) {
    if (!target || target.state === 'down') return;
    if (typeof target.health !== 'number') target.health = 100;
    target.health -= damage;
    if (G.effects && typeof G.effects.hitPuff === 'function') G.effects.hitPuff(point);
    if (target.health > 0) {
      if (target.state !== 'flee') target.state = 'flee';
      return;
    }
    knockDown(target);
    if (G.police && typeof G.police.addWanted === 'function') G.police.addWanted(2);
  }

  // Find the owning ped/cop/car for a raycast hit when userData.ref is absent,
  // by matching the hit object (or one of its ancestors) against known meshes.
  function findOwner(hitObject, list) {
    let obj = hitObject;
    while (obj) {
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && entry.mesh === obj) return entry;
        }
      }
      obj = obj.parent;
    }
    return null;
  }

  function applyHit(hit, w) {
    let obj = hit.object;
    let type = null;
    let ref = null;
    while (obj) {
      if (obj.userData && obj.userData.type) {
        type = obj.userData.type;
        ref = obj.userData.ref || null;
        break;
      }
      obj = obj.parent;
    }
    const point = hit.point;
    if (type === 'ped') {
      const ped =
        ref ||
        findOwner(hit.object, G.peds && G.peds.peds) ||
        findOwner(hit.object, G.missions && G.missions.enemies);
      // Mission enemies wear the 'ped' tag but own their damage handling.
      if (ped && ped.isEnemy && G.missions && typeof G.missions.damageEnemy === 'function') {
        G.missions.damageEnemy(ped, w.damage);
        if (G.effects && typeof G.effects.hitPuff === 'function') G.effects.hitPuff(point);
        return;
      }
      damagePerson(ped, w.damage, point);
    } else if (type === 'cop') {
      const cop = ref || findOwner(hit.object, G.police && G.police.cops);
      damagePerson(cop, w.damage, point);
    } else if (type === 'car') {
      const car = ref || findOwner(hit.object, G.vehicles && G.vehicles.all);
      if (car && typeof car.health === 'number') car.health -= w.damage;
      if (G.effects && typeof G.effects.sparks === 'function') G.effects.sparks(point);
      // vehicles.js handles smoke and the explosion when health reaches 0.
    } else {
      // Building, ground or anything else solid: spark and stop.
      if (G.effects && typeof G.effects.sparks === 'function') G.effects.sparks(point);
    }
  }

  function collectTargets(out) {
    if (G.peds && Array.isArray(G.peds.peds)) {
      for (const p of G.peds.peds) {
        if (p && p.mesh && p.state !== 'down') out.push(p.mesh);
      }
    }
    if (G.police && Array.isArray(G.police.cops)) {
      for (const c of G.police.cops) {
        if (c && c.mesh && c.state !== 'down') out.push(c.mesh);
      }
    }
    if (G.vehicles && Array.isArray(G.vehicles.all)) {
      for (const v of G.vehicles.all) {
        if (v && v.mesh) out.push(v.mesh);
      }
    }
    if (G.city && Array.isArray(G.city.hitMeshes)) {
      for (const m of G.city.hitMeshes) out.push(m);
    }
  }

  // --- firing ----------------------------------------------------------------

  function meleeHit() {
    const pp = G.player.position;
    let best = null;
    let bestDist = MELEE_RANGE;
    const lists = [
      G.peds && G.peds.peds,
      G.police && G.police.cops,
      G.missions && G.missions.enemies,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        if (!t || !t.mesh || t.state === 'down') continue;
        const d = Math.hypot(t.mesh.position.x - pp.x, t.mesh.position.z - pp.z);
        if (d < bestDist) {
          best = t;
          bestDist = d;
        }
      }
    }
    if (!best) return;
    if (best.isEnemy && G.missions && typeof G.missions.damageEnemy === 'function') {
      G.missions.damageEnemy(best, 20);
      if (G.effects && typeof G.effects.hitPuff === 'function') {
        G.effects.hitPuff(best.mesh.position);
      }
      return;
    }
    if (typeof best.health === 'number') best.health = Math.max(0, best.health - 20);
    knockDown(best);
    if (G.effects && typeof G.effects.hitPuff === 'function') {
      G.effects.hitPuff(best.mesh.position);
    }
  }

  function fireBullet(w) {
    const player = G.player;
    const origin = player.position;
    const dir = new THREE.Vector3();
    const cam = threeCamera();
    if (cam) {
      raycaster.setFromCamera(aimCenter, cam);
      dir.copy(raycaster.ray.direction);
    } else {
      // No camera to aim through: fire along the camera heading from the eyes.
      const yaw = G.camera && typeof G.camera.yaw === 'number' ? G.camera.yaw : 0;
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      raycaster.set(new THREE.Vector3(origin.x, origin.y + 1.6, origin.z), dir);
    }
    const muzzle = new THREE.Vector3(origin.x, origin.y + 1.4, origin.z).addScaledVector(
      dir,
      0.8
    );
    if (G.effects && typeof G.effects.muzzleFlash === 'function') {
      G.effects.muzzleFlash(muzzle, dir);
    }
    if (G.audio && typeof G.audio.gunshot === 'function') G.audio.gunshot();

    const targets = [];
    collectTargets(targets);
    const hits = raycaster.intersectObjects(targets, true);
    const end = new THREE.Vector3()
      .copy(raycaster.ray.origin)
      .addScaledVector(dir, RAY_FAR);
    if (hits.length > 0) {
      end.copy(hits[0].point);
      applyHit(hits[0], w);
    }
    if (G.effects && typeof G.effects.tracer === 'function') {
      try {
        G.effects.tracer(muzzle, end);
      } catch (err) {
        // Tracers are cosmetic; never let them break a shot.
      }
    }
    // Shooting draws attention, at most once per 3 seconds.
    if (
      time - lastWantedTime >= WANTED_THROTTLE &&
      G.police &&
      typeof G.police.addWanted === 'function'
    ) {
      lastWantedTime = time;
      G.police.addWanted(1);
    }
    if (G.peds && typeof G.peds.scatterAt === 'function') {
      try {
        G.peds.scatterAt(origin, 25);
      } catch (err) {
        // Ignore.
      }
    }
  }

  function shoot() {
    const player = G.player;
    if (!player || player.mode !== 'foot' || player.isDead) return false;
    const w = weapons[api.current];
    if (time - lastShotTime < 1 / w.rate) return false;
    if (w.id === 'fists') {
      lastShotTime = time;
      meleeHit();
      return true;
    }
    if (w.ammo <= 0) {
      lastShotTime = time; // throttle the reminder to the fire rate
      if (G.hud && typeof G.hud.showMessage === 'function') {
        G.hud.showMessage('Out of ammo — press R to reload');
      }
      return false;
    }
    w.ammo -= 1;
    lastShotTime = time;
    fireBullet(w);
    return true;
  }

  // --- per-frame update ------------------------------------------------------

  function updateDowned(dt) {
    for (let i = downed.length - 1; i >= 0; i--) {
      const d = downed[i];
      d.t += dt;
      if (!d.mesh || !d.mesh.parent) {
        downed.splice(i, 1);
        continue;
      }
      if (d.t > 3) {
        const f = Math.max(0, 1 - (d.t - 3) / 2);
        fadeMesh(d.mesh, f);
        if (f <= 0) {
          d.mesh.visible = false;
          downed.splice(i, 1);
        }
      }
    }
  }

  function update(dt) {
    time += dt;
    // The SMG unlocks once mission 3 is complete.
    const smg = weapons[2];
    if (
      smg.locked &&
      G.missions &&
      Array.isArray(G.missions.completed) &&
      G.missions.completed.includes('mission-3')
    ) {
      smg.locked = false;
      if (G.hud && typeof G.hud.showMessage === 'function') {
        G.hud.showMessage('SMG unlocked!');
      }
    }
    updateDowned(dt);

    const input = G.input;
    const mouse = (input && input.mouse) || {};
    const onFoot = !!(G.player && G.player.mode === 'foot' && !G.player.isDead);
    api.aiming = !!mouse.right && onFoot;
    const showCross = api.aiming || (onFoot && api.current !== 0);
    if (showCross !== lastCrosshair) {
      lastCrosshair = showCross;
      if (G.hud && typeof G.hud.setCrosshair === 'function') G.hud.setCrosshair(showCross);
    }
    if (!onFoot) {
      prevLeft = !!mouse.left;
      return;
    }

    // Edge actions run only on the first step of a frame (see player.js).
    if ((G.stepInFrame || 0) === 0) {
      if (pressed('Digit1')) switchWeapon(0);
      if (pressed('Digit2')) switchWeapon(1);
      if (pressed('Digit3')) switchWeapon(2);
      if (pressed('KeyR')) reload();
    }

    const leftEdge = mouse.leftPressed === true || (!!mouse.left && !prevLeft);
    prevLeft = !!mouse.left;
    const w = weapons[api.current];
    if (w.id === 'smg') {
      if (mouse.left) shoot(); // autofire; shoot() enforces the rate limit
    } else if (leftEdge) {
      shoot();
    }
  }

  const api = {
    update,
    weapons,
    current: 1, // start with the pistol
    currentWeapon: weapons[1],
    shoot,
    switchWeapon,
    aiming: false,
  };
  return api;
}
