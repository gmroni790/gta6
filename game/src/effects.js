// Pooled visual effects for Sunset Bay: particles, skid marks, tracers, muzzle
// flashes and screen shake. Everything is pre-allocated in pools — no new THREE
// objects are created per call, and the per-frame update writes into typed arrays
// only. All randomness comes from G.rng.

import * as THREE from 'three';

const MAX_PARTICLES = 300;
const MAX_SKIDS = 40;
const MAX_TRACERS = 8;
const MAX_FLASHES = 4;
const SKID_LIFE = 6; // seconds a skid mark takes to fade
const TRACER_LIFE = 0.08; // seconds a tracer stays visible
const FLASH_LIFE = 0.05; // seconds a muzzle-flash sprite stays visible

export function createEffects(G) {
  const scene = G && G.scene;

  // Deterministic randomness: G.rng when present, else a tiny local mulberry32
  // fallback so the module still works standalone. Never Math.random().
  let rng = G && G.rng;
  if (!rng) {
    let state = 1234567;
    rng = {
      range(min, max) {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        const n = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        return min + (max - min) * n;
      },
    };
  }

  let shake = 0;

  // ---------------------------------------------------------------- particles
  // One THREE.Points pool. Per-particle state lives in typed arrays; the shader
  // reads size and alpha attributes so particles can grow and fade individually.
  const pPos = new Float32Array(MAX_PARTICLES * 3);
  const pVel = new Float32Array(MAX_PARTICLES * 3);
  const pColor = new Float32Array(MAX_PARTICLES * 3);
  const pSize = new Float32Array(MAX_PARTICLES);
  const pSize0 = new Float32Array(MAX_PARTICLES); // spawn size (smoke grows)
  const pAlpha = new Float32Array(MAX_PARTICLES);
  const pLife = new Float32Array(MAX_PARTICLES);
  const pMaxLife = new Float32Array(MAX_PARTICLES);
  const pGrav = new Float32Array(MAX_PARTICLES); // gravity; negative = buoyant
  const pGrow = new Float32Array(MAX_PARTICLES); // size growth over life
  let pCursor = 0; // ring cursor: next slot to overwrite

  // Park every particle far below the world until it is spawned.
  for (let i = 0; i < MAX_PARTICLES; i++) {
    pPos[i * 3 + 1] = -999;
  }

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  particleGeo.setAttribute('aColor', new THREE.BufferAttribute(pColor, 3));
  particleGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
  particleGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1));
  const particleMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: [
      'attribute vec3 aColor;',
      'attribute float aSize;',
      'attribute float aAlpha;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vColor = aColor;',
      '  vAlpha = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * (240.0 / -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 d = gl_PointCoord - 0.5;',
      '  float falloff = smoothstep(0.5, 0.1, length(d));',
      '  gl_FragColor = vec4(vColor, vAlpha * falloff);',
      '}',
    ].join('\n'),
  });
  const points = new THREE.Points(particleGeo, particleMat);
  points.frustumCulled = false; // positions move; never cull the pool away
  if (scene) scene.add(points);

  function spawnParticle(x, y, z, vx, vy, vz, r, g, b, size, life, grav, grow) {
    const i = pCursor;
    pCursor = (pCursor + 1) % MAX_PARTICLES;
    const i3 = i * 3;
    pPos[i3] = x;
    pPos[i3 + 1] = y;
    pPos[i3 + 2] = z;
    pVel[i3] = vx;
    pVel[i3 + 1] = vy;
    pVel[i3 + 2] = vz;
    pColor[i3] = r;
    pColor[i3 + 1] = g;
    pColor[i3 + 2] = b;
    pSize0[i] = size;
    pSize[i] = size;
    pLife[i] = life;
    pMaxLife[i] = life;
    pGrav[i] = grav;
    pGrow[i] = grow;
    pAlpha[i] = 1;
  }

  function updateParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      const i3 = i * 3;
      if (pLife[i] <= 0) {
        pAlpha[i] = 0;
        pPos[i3 + 1] = -999;
        continue;
      }
      pVel[i3 + 1] -= pGrav[i] * dt;
      pPos[i3] += pVel[i3] * dt;
      pPos[i3 + 1] += pVel[i3 + 1] * dt;
      pPos[i3 + 2] += pVel[i3 + 2] * dt;
      // Keep particles out of the ground.
      if (pPos[i3 + 1] < 0.05) pPos[i3 + 1] = 0.05;
      const frac = pLife[i] / pMaxLife[i]; // 1 at spawn -> 0 at death
      pAlpha[i] = frac < 0.7 ? frac / 0.7 : 1; // full, then fade in last 70%
      pSize[i] = pSize0[i] * (1 + pGrow[i] * (1 - frac));
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.aColor.needsUpdate = true;
    particleGeo.attributes.aSize.needsUpdate = true;
    particleGeo.attributes.aAlpha.needsUpdate = true;
  }

  // ------------------------------------------------------- explosion light
  // One reusable PointLight; intensity decays to zero after each flash.
  const flashLight = new THREE.PointLight(0xffa040, 0, 25, 2);
  if (scene) scene.add(flashLight);
  let flashIntensity = 0;

  // ------------------------------------------------------- muzzle flashes
  // Pool of small additive sprites on a shared radial-gradient canvas texture.
  const flashTexture = (() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const c = canvas.getContext('2d');
    const grad = c.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,220,1)');
    grad.addColorStop(0.4, 'rgba(255,200,80,0.8)');
    grad.addColorStop(1, 'rgba(255,120,0,0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  })();
  const flashes = [];
  for (let i = 0; i < MAX_FLASHES; i++) {
    const mat = new THREE.SpriteMaterial({
      map: flashTexture,
      color: 0xffd070,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.scale.set(0.7, 0.7, 1);
    if (scene) scene.add(sprite);
    flashes.push({ sprite, life: 0 });
  }
  let flashCursor = 0;

  // ------------------------------------------------------------- skid marks
  // Pool of dark quads lying flat on the ground, fading over SKID_LIFE.
  const skidGeo = new THREE.PlaneGeometry(0.45, 1.1);
  skidGeo.rotateX(-Math.PI / 2); // lie flat; length axis along local Z
  const skids = [];
  for (let i = 0; i < MAX_SKIDS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(skidGeo, mat);
    mesh.visible = false;
    mesh.position.y = 0.02; // just above the asphalt, no z-fighting
    if (scene) scene.add(mesh);
    skids.push({ mesh, life: 0 });
  }
  let skidCursor = 0;

  // ---------------------------------------------------------------- tracers
  // Pool of thin glowing boxes, stretched between two points, fading in 80ms.
  const tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 1);
  const tracers = [];
  for (let i = 0; i < MAX_TRACERS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe9a0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    if (scene) scene.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerCursor = 0;

  // Scratch vectors so update/spawn code never allocates.
  const tmpMid = new THREE.Vector3();

  function update(dt) {
    updateParticles(dt);

    // Explosion light flash decays fast.
    if (flashIntensity > 0) {
      flashIntensity = Math.max(0, flashIntensity - dt * 500);
      flashLight.intensity = flashIntensity;
    }

    // Muzzle-flash sprites fade out.
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.sprite.visible = false;
      } else {
        f.sprite.material.opacity = f.life / FLASH_LIFE;
      }
    }

    // Skid marks fade over their life.
    for (let i = 0; i < skids.length; i++) {
      const s = skids[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
      } else {
        s.mesh.material.opacity = 0.5 * (s.life / SKID_LIFE);
      }
    }

    // Tracers fade in 80ms.
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i];
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.visible = false;
        t.mesh.material.opacity = 0;
      } else {
        t.mesh.material.opacity = t.life / TRACER_LIFE;
      }
    }

    // Screen shake decays; camera.js reads G.effects.shake.
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 2);
    }
  }

  return {
    update,

    explosion(pos) {
      // Orange/yellow burst.
      const count = 40;
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const up = rng.range(-0.3, 1);
        const speed = rng.range(4, 12);
        const horiz = Math.sqrt(Math.max(0, 1 - up * up));
        const hot = rng.range(0, 1);
        spawnParticle(
          pos.x,
          pos.y + 0.5,
          pos.z,
          Math.cos(a) * horiz * speed,
          up * speed,
          Math.sin(a) * horiz * speed,
          1, // r
          0.45 + hot * 0.45, // g: orange -> yellow
          0.1 + hot * 0.2, // b
          rng.range(0.8, 1.6),
          rng.range(0.5, 1.0),
          6, // gravity
          0.5, // slight growth
        );
      }
      // Smoke on top of the fire.
      for (let i = 0; i < 6; i++) {
        const gray = rng.range(0.25, 0.4);
        spawnParticle(
          pos.x + rng.range(-0.5, 0.5),
          pos.y + rng.range(0.5, 1.5),
          pos.z + rng.range(-0.5, 0.5),
          rng.range(-0.5, 0.5),
          rng.range(1, 2),
          rng.range(-0.5, 0.5),
          gray,
          gray,
          gray,
          rng.range(1.2, 2),
          rng.range(1.5, 2.5),
          -1.5, // buoyant: keeps rising
          1.5, // grows as it rises
        );
      }
      // Light flash + shake. Audio is the caller's job.
      flashLight.position.set(pos.x, pos.y + 1.5, pos.z);
      flashIntensity = 120;
      flashLight.intensity = flashIntensity;
      shake = Math.min(1, Math.max(shake, 0.6));
    },

    muzzleFlash(pos, dir) {
      // A few bright particles flying along the shot direction.
      for (let i = 0; i < 5; i++) {
        const spread = 0.25;
        spawnParticle(
          pos.x,
          pos.y,
          pos.z,
          dir.x * rng.range(6, 10) + rng.range(-spread, spread),
          dir.y * rng.range(6, 10) + rng.range(-spread, spread),
          dir.z * rng.range(6, 10) + rng.range(-spread, spread),
          1,
          rng.range(0.8, 1),
          rng.range(0.4, 0.6),
          rng.range(0.25, 0.45),
          rng.range(0.06, 0.12),
          0,
          0,
        );
      }
      // Short-lived additive sprite at the muzzle.
      const f = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % MAX_FLASHES;
      f.sprite.position.set(pos.x, pos.y, pos.z);
      f.sprite.material.opacity = 1;
      f.sprite.visible = true;
      f.life = FLASH_LIFE;
    },

    sparks(pos) {
      const count = 12;
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const speed = rng.range(6, 14);
        spawnParticle(
          pos.x,
          pos.y + 0.2,
          pos.z,
          Math.cos(a) * speed * rng.range(0.4, 1),
          rng.range(2, 7),
          Math.sin(a) * speed * rng.range(0.4, 1),
          1,
          rng.range(0.85, 1),
          rng.range(0.6, 0.85),
          rng.range(0.15, 0.3),
          rng.range(0.3, 0.6),
          12, // heavy gravity: sparks arc down fast
          0,
        );
      }
    },

    smoke(pos) {
      const count = 7;
      for (let i = 0; i < count; i++) {
        const gray = rng.range(0.35, 0.55);
        spawnParticle(
          pos.x + rng.range(-0.3, 0.3),
          pos.y + rng.range(0, 0.4),
          pos.z + rng.range(-0.3, 0.3),
          rng.range(-0.4, 0.4),
          rng.range(0.6, 1.4),
          rng.range(-0.4, 0.4),
          gray,
          gray,
          gray,
          rng.range(1, 1.8),
          rng.range(1.5, 2.5),
          -1, // buoyant
          1.5, // grows as it rises
        );
      }
    },

    skid(pos, heading) {
      const s = skids[skidCursor];
      skidCursor = (skidCursor + 1) % MAX_SKIDS;
      s.mesh.position.set(pos.x, 0.02, pos.z);
      s.mesh.rotation.y = heading;
      s.mesh.material.opacity = 0.5;
      s.mesh.visible = true;
      s.life = SKID_LIFE;
    },

    hitPuff(pos) {
      // Small, mild red-gray puff for a hit.
      for (let i = 0; i < 6; i++) {
        const r = rng.range(0.45, 0.6);
        const gb = rng.range(0.2, 0.3);
        spawnParticle(
          pos.x + rng.range(-0.2, 0.2),
          pos.y + rng.range(-0.2, 0.2),
          pos.z + rng.range(-0.2, 0.2),
          rng.range(-1, 1),
          rng.range(0.5, 1.5),
          rng.range(-1, 1),
          r,
          gb,
          gb,
          rng.range(0.3, 0.5),
          rng.range(0.3, 0.5),
          2,
          0.8,
        );
      }
    },

    tracer(from, to) {
      const t = tracers[tracerCursor];
      tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
      tmpMid.addVectors(from, to).multiplyScalar(0.5);
      t.mesh.position.copy(tmpMid);
      t.mesh.lookAt(to);
      const length = from.distanceTo(to);
      t.mesh.scale.set(1, 1, Math.max(0.1, length));
      t.mesh.material.opacity = 1;
      t.mesh.visible = true;
      t.life = TRACER_LIFE;
    },

    screenShake(amount) {
      shake = Math.min(1, Math.max(shake, amount || 0));
    },

    get shake() {
      return shake;
    },
  };
}
