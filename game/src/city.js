// The city of Solmar: ground, roads, sidewalks, buildings, street props,
// beach and docks, sky, sun and drifting clouds — plus the road/collision
// queries the rest of the game drives on. Ground is flat (y = 0).

import * as THREE from 'three';
import {
  CITY_HALF,
  ROAD_WIDTH,
  SIDEWALK,
  BLOCK,
  AVENUES,
  STREETS,
  COLORS,
  DISTRICTS,
} from './config.js';
import { createTextures } from './textures.js';

const HALF_ROAD = ROAD_WIDTH / 2;
const SIDEWALK_OFFSET = HALF_ROAD + SIDEWALK / 2; // 7.5: centre of a sidewalk strip
const BLOCK_CENTERS = [-210, -150, -90, -30, 30, 90, 150, 210];

// Scale a geometry's UVs so a texture tiles (repeatX, repeatY) times across it.
// Tiling lives in the geometry, so meshes can share one texture with different
// repeats instead of cloning textures.
function tileUVs(geometry, repeatX, repeatY) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * repeatX, uv.getY(i) * repeatY);
  }
  return geometry;
}

export function createCity(G) {
  const rng = G.rng;
  const scene = G.scene;
  const textures = G.textures || createTextures(rng);

  // ---- Sky, fog and light -------------------------------------------------
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.fog, 180, 650);

  const sun = new THREE.DirectionalLight(COLORS.sun, 2.8);
  sun.position.set(140, 220, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 600;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x8a7a5a, 0.9));

  const dummy = new THREE.Object3D();
  function setInstance(mesh, index, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  }

  // ---- Ground, beach and water --------------------------------------------
  const groundMat = new THREE.MeshLambertMaterial({ map: textures.grass });
  const ground = new THREE.Mesh(
    tileUVs(new THREE.PlaneGeometry(CITY_HALF * 2, CITY_HALF * 2).rotateX(-Math.PI / 2), 60, 60),
    groundMat,
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // Sand strip along the south edge, just past the southernmost street.
  const sandMat = new THREE.MeshLambertMaterial({ map: textures.sand });
  const beach = new THREE.Mesh(
    tileUVs(new THREE.PlaneGeometry(CITY_HALF * 2, 54).rotateX(-Math.PI / 2), 60, 6),
    sandMat,
  );
  beach.position.set(0, 0.018, 273);
  beach.receiveShadow = true;
  scene.add(beach);

  // Open water south of the beach, and a harbour basin along the east edge.
  const waterMat = new THREE.MeshLambertMaterial({ map: textures.water });
  const southWater = new THREE.Mesh(
    tileUVs(new THREE.PlaneGeometry(700, 240).rotateX(-Math.PI / 2), 70, 24),
    waterMat,
  );
  southWater.position.set(0, 0.02, 420);
  scene.add(southWater);
  const eastWater = new THREE.Mesh(
    tileUVs(new THREE.PlaneGeometry(150, 620).rotateX(-Math.PI / 2), 15, 62),
    waterMat,
  );
  eastWater.position.set(325, 0.03, 0);
  scene.add(eastWater);

  // ---- Roads and sidewalks (instanced; one draw call each) ----------------
  const roads = [];
  for (const a of AVENUES) roads.push({ axis: 'z', at: a });
  for (const s of STREETS) roads.push({ axis: 'x', at: s });

  const roadGeo = tileUVs(
    new THREE.PlaneGeometry(ROAD_WIDTH, CITY_HALF * 2).rotateX(-Math.PI / 2), 1, 50,
  );
  const roadMat = new THREE.MeshLambertMaterial({ map: textures.road });
  const roadMesh = new THREE.InstancedMesh(roadGeo, roadMat, roads.length);
  roads.forEach((road, i) => {
    if (road.axis === 'z') {
      setInstance(roadMesh, i, road.at, 0.01, 0);
    } else {
      setInstance(roadMesh, i, 0, 0.014, road.at, Math.PI / 2);
    }
  });
  roadMesh.instanceMatrix.needsUpdate = true;
  roadMesh.receiveShadow = true;
  scene.add(roadMesh);

  const sidewalkGeo = tileUVs(
    new THREE.PlaneGeometry(SIDEWALK, CITY_HALF * 2).rotateX(-Math.PI / 2), 1, 100,
  );
  const sidewalkMat = new THREE.MeshLambertMaterial({ map: textures.sidewalk });
  const sidewalkMesh = new THREE.InstancedMesh(sidewalkGeo, sidewalkMat, roads.length * 2);
  let sw = 0;
  for (const road of roads) {
    for (const side of [-1, 1]) {
      if (road.axis === 'z') {
        setInstance(sidewalkMesh, sw++, road.at + side * SIDEWALK_OFFSET, 0.02, 0);
      } else {
        setInstance(sidewalkMesh, sw++, 0, 0.024, road.at + side * SIDEWALK_OFFSET, Math.PI / 2);
      }
    }
  }
  sidewalkMesh.instanceMatrix.needsUpdate = true;
  sidewalkMesh.receiveShadow = true;
  scene.add(sidewalkMesh);

  // Paved pad under each block so buildings sit on concrete, not grass.
  const padGeo = tileUVs(
    new THREE.PlaneGeometry(BLOCK, BLOCK).rotateX(-Math.PI / 2), 7, 7,
  );
  const padMesh = new THREE.InstancedMesh(padGeo, sidewalkMat, BLOCK_CENTERS.length ** 2);
  let pi = 0;
  for (const cx of BLOCK_CENTERS) {
    for (const cz of BLOCK_CENTERS) {
      setInstance(padMesh, pi++, cx, 0.016, cz);
    }
  }
  padMesh.instanceMatrix.needsUpdate = true;
  padMesh.receiveShadow = true;
  scene.add(padMesh);

  // ---- Buildings ----------------------------------------------------------
  const facadeMats = textures.building.map(
    (tex) => new THREE.MeshLambertMaterial({ map: tex }),
  );
  const roofMat = new THREE.MeshLambertMaterial({ map: textures.roof });
  // Unit-box geometries with UVs tiled per size bucket, so windows stay roughly
  // the same size on a 6 m shop and a 50 m tower.
  const boxGeoCache = new Map();
  function boxGeometry(width, height, depth) {
    const rx = Math.max(1, Math.min(6, Math.round(Math.max(width, depth) / 12)));
    const ry = Math.max(1, Math.min(6, Math.round(height / 12)));
    const key = rx + ',' + ry;
    let geo = boxGeoCache.get(key);
    if (!geo) {
      geo = tileUVs(new THREE.BoxGeometry(1, 1, 1), rx, ry);
      boxGeoCache.set(key, geo);
    }
    return geo;
  }

  const buildingBoxes = [];
  const acSpots = []; // {x, y, z, ry}
  const towerSpots = []; // {x, y, z}

  function addBuilding(cx, cz, width, height, depth) {
    const variant = Math.max(0, Math.min(5, Math.floor(height / 10)));
    const materials = [facadeMats[variant], facadeMats[variant], roofMat, roofMat,
      facadeMats[variant], facadeMats[variant]];
    const mesh = new THREE.Mesh(boxGeometry(width, height, depth), materials);
    mesh.scale.set(width, height, depth);
    mesh.position.set(cx, height / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.type = 'building';
    scene.add(mesh);
    buildingBoxes.push({
      minX: cx - width / 2, maxX: cx + width / 2,
      minZ: cz - depth / 2, maxZ: cz + depth / 2,
    });
    // Rooftop props: AC units on most roofs, water towers on tall ones.
    if (rng.chance(0.55)) {
      acSpots.push({
        x: cx + rng.range(-width / 4, width / 4),
        y: height,
        z: cz + rng.range(-depth / 4, depth / 4),
        ry: rng.chance(0.5) ? 0 : Math.PI / 2,
      });
    }
    if (height >= 24 && rng.chance(0.35)) {
      towerSpots.push({
        x: cx + rng.range(-width / 4, width / 4),
        y: height,
        z: cz + rng.range(-depth / 4, depth / 4),
      });
    }
  }

  function districtAt(x, z) {
    for (const d of DISTRICTS) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) return d.name;
    }
    // The district rectangles leave a few gaps; those fall back to nearest.
    let best = DISTRICTS[0];
    let bestDist = Infinity;
    for (const d of DISTRICTS) {
      const dx = Math.max(d.minX - x, 0, x - d.maxX);
      const dz = Math.max(d.minZ - z, 0, z - d.maxZ);
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best.name;
  }

  for (const cx of BLOCK_CENTERS) {
    for (const cz of BLOCK_CENTERS) {
      const tall = districtAt(cx, cz) === 'Downtown';
      if (tall) {
        const w = rng.range(26, 36);
        const d = rng.range(26, 36);
        addBuilding(cx, cz, w, rng.range(18, 55), d);
      } else if (rng.chance(0.3)) {
        // Two smaller buildings in opposite corners of the block.
        const w1 = rng.range(13, 18);
        const d1 = rng.range(13, 18);
        const w2 = rng.range(13, 18);
        const d2 = rng.range(13, 18);
        addBuilding(cx - 10, cz - 10, w1, rng.range(6, 14), d1);
        addBuilding(cx + 10, cz + 10, w2, rng.range(6, 14), d2);
      } else {
        addBuilding(cx, cz, rng.range(16, 28), rng.range(6, 16), rng.range(16, 28));
      }
    }
  }

  // Rooftop AC units (instanced boxes).
  if (acSpots.length > 0) {
    const acMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.6, 0.9, 1.1),
      new THREE.MeshLambertMaterial({ color: 0x8a8a8a }),
      acSpots.length,
    );
    acSpots.forEach((spot, i) => setInstance(acMesh, i, spot.x, spot.y + 0.45, spot.z, spot.ry));
    acMesh.instanceMatrix.needsUpdate = true;
    acMesh.castShadow = true;
    scene.add(acMesh);
  }

  // Water towers: tank + cone roof on a column (three small instanced meshes).
  if (towerSpots.length > 0) {
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    const tankMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.6, 1.6, 2.4, 10), woodMat, towerSpots.length,
    );
    const coneMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.9, 1.2, 10),
      new THREE.MeshLambertMaterial({ color: 0x5a5a5a }), towerSpots.length,
    );
    const columnMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.4, 3, 1.4), woodMat, towerSpots.length,
    );
    towerSpots.forEach((spot, i) => {
      setInstance(columnMesh, i, spot.x, spot.y + 1.5, spot.z);
      setInstance(tankMesh, i, spot.x, spot.y + 4.2, spot.z);
      setInstance(coneMesh, i, spot.x, spot.y + 6, spot.z);
    });
    tankMesh.instanceMatrix.needsUpdate = true;
    coneMesh.instanceMatrix.needsUpdate = true;
    columnMesh.instanceMatrix.needsUpdate = true;
    tankMesh.castShadow = true;
    scene.add(tankMesh);
    scene.add(coneMesh);
    scene.add(columnMesh);
  }

  // ---- Streetlights and traffic lights (visual, instanced) ----------------
  const intersections = [];
  for (let i = 0; i < AVENUES.length; i++) {
    for (let j = 0; j < STREETS.length; j++) {
      intersections.push({ x: AVENUES[i], z: STREETS[j], i, j });
    }
  }

  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 6, 6);
  poleGeo.translate(0, 3, 0);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3e });
  const lampPoleMesh = new THREE.InstancedMesh(poleGeo, poleMat, intersections.length);
  const armMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.4, 0.1, 0.12), poleMat, intersections.length,
  );
  const lampHeadMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.7, 0.15, 0.3),
    new THREE.MeshBasicMaterial({ color: 0xfff2c0 }), intersections.length,
  );
  intersections.forEach((pt, k) => {
    const dx = (pt.i % 2 === 0 ? 1 : -1) * 7.5;
    const dz = (pt.j % 2 === 0 ? 1 : -1) * 7.5;
    const px = pt.x + dx;
    const pz = pt.z + dz;
    const dir = dx > 0 ? -1 : 1; // arm reaches back toward the road
    setInstance(lampPoleMesh, k, px, 0, pz);
    setInstance(armMesh, k, px + dir * 1.1, 5.9, pz);
    setInstance(lampHeadMesh, k, px + dir * 2.2, 5.85, pz);
  });
  lampPoleMesh.instanceMatrix.needsUpdate = true;
  armMesh.instanceMatrix.needsUpdate = true;
  lampHeadMesh.instanceMatrix.needsUpdate = true;
  scene.add(lampPoleMesh);
  scene.add(armMesh);
  scene.add(lampHeadMesh);

  // Traffic lights on every other intersection: pole, head box, one lit lamp.
  const signalPts = intersections.filter((pt) => (pt.i + pt.j) % 2 === 0);
  const signalPoleGeo = new THREE.CylinderGeometry(0.08, 0.1, 5, 6);
  signalPoleGeo.translate(0, 2.5, 0);
  const signalPoleMesh = new THREE.InstancedMesh(signalPoleGeo, poleMat, signalPts.length);
  const signalHeadMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.45, 1.1, 0.28),
    new THREE.MeshLambertMaterial({ color: 0x1e1e22 }), signalPts.length,
  );
  const signalLampMesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.13, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }), signalPts.length,
  );
  const lampColor = new THREE.Color();
  signalPts.forEach((pt, k) => {
    const dx = (pt.i % 2 === 0 ? -1 : 1) * 7;
    const dz = (pt.j % 2 === 0 ? -1 : 1) * 7;
    const px = pt.x + dx;
    const pz = pt.z + dz;
    const face = dx > 0 ? -1 : 1; // lamp faces the avenue
    setInstance(signalPoleMesh, k, px, 0, pz);
    setInstance(signalHeadMesh, k, px, 4.6, pz, face > 0 ? Math.PI / 2 : -Math.PI / 2);
    setInstance(signalLampMesh, k, px + face * 0.16, 4.75, pz, face > 0 ? Math.PI / 2 : -Math.PI / 2);
    const roll = rng.next();
    lampColor.setHex(roll < 0.6 ? 0xff2a2a : roll < 0.9 ? 0x2aff5a : 0xffc832);
    signalLampMesh.setColorAt(k, lampColor);
  });
  signalPoleMesh.instanceMatrix.needsUpdate = true;
  signalHeadMesh.instanceMatrix.needsUpdate = true;
  signalLampMesh.instanceMatrix.needsUpdate = true;
  if (signalLampMesh.instanceColor) signalLampMesh.instanceColor.needsUpdate = true;
  scene.add(signalPoleMesh);
  scene.add(signalHeadMesh);
  scene.add(signalLampMesh);

  // ---- Palm trees (instanced trunks + fronds) -----------------------------
  const palmSpots = [];
  for (let x = -290; x <= 290; x += 16) {
    palmSpots.push({ x: x + rng.range(-4, 4), z: rng.range(232, 244) });
  }
  for (let i = 0; i < 26; i++) {
    const road = rng.pick(roads);
    const along = rng.range(-CITY_HALF + 15, CITY_HALF - 15);
    const side = rng.chance(0.5) ? 1 : -1;
    if (road.axis === 'z') {
      palmSpots.push({ x: road.at + side * 10, z: along });
    } else {
      palmSpots.push({ x: along, z: road.at + side * 10 });
    }
  }
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 5, 6);
  trunkGeo.translate(0, 2.5, 0);
  const trunkMesh = new THREE.InstancedMesh(
    trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6a4a2a }), palmSpots.length,
  );
  const FRONDS_PER_PALM = 7;
  const frondGeo = new THREE.PlaneGeometry(2.4, 0.7);
  frondGeo.translate(1.2, 0, 0);
  const frondMesh = new THREE.InstancedMesh(
    frondGeo,
    new THREE.MeshLambertMaterial({ color: COLORS.palm, side: THREE.DoubleSide }),
    palmSpots.length * FRONDS_PER_PALM,
  );
  const topOffset = new THREE.Vector3();
  palmSpots.forEach((spot, k) => {
    const tiltX = rng.range(-0.06, 0.06);
    const tiltZ = rng.range(-0.06, 0.06);
    setInstance(trunkMesh, k, spot.x, 0, spot.z, 0, 1, 1, 1, tiltX, tiltZ);
    // Top of the (slightly tilted) trunk, where the fronds fan out.
    dummy.position.set(spot.x, 0, spot.z);
    dummy.rotation.set(tiltX, 0, tiltZ);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    topOffset.set(0, 5, 0).applyQuaternion(dummy.quaternion).add(dummy.position);
    for (let f = 0; f < FRONDS_PER_PALM; f++) {
      const yaw = (f / FRONDS_PER_PALM) * Math.PI * 2 + rng.range(-0.2, 0.2);
      setInstance(frondMesh, k * FRONDS_PER_PALM + f,
        topOffset.x, topOffset.y, topOffset.z, yaw, 1, 1, 1, 0, rng.range(-0.75, -0.45));
    }
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  frondMesh.instanceMatrix.needsUpdate = true;
  trunkMesh.castShadow = true;
  scene.add(trunkMesh);
  scene.add(frondMesh);

  // ---- Benches along the beach and in a few blocks -------------------------
  const benchSpots = [];
  for (let x = -270; x <= 270; x += 45) {
    benchSpots.push({ x: x + rng.range(-6, 6), z: 240, ry: 0 });
  }
  for (let i = 0; i < 8; i++) {
    const cx = rng.pick(BLOCK_CENTERS);
    const cz = rng.pick(BLOCK_CENTERS);
    benchSpots.push({
      x: cx + rng.range(-19, 19), z: cz + rng.range(-19, 19),
      ry: rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]),
    });
  }
  const benchMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
  const benchSeatMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.8, 0.12, 0.5), benchMat, benchSpots.length,
  );
  const benchBackMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.8, 0.5, 0.1), benchMat, benchSpots.length,
  );
  const benchLegMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.08, 0.45, 0.45), benchMat, benchSpots.length * 2,
  );
  benchSpots.forEach((spot, k) => {
    const cos = Math.cos(spot.ry);
    const sin = Math.sin(spot.ry);
    // Local (ox, oz) -> world under a Y rotation.
    const rot = (ox, oz) => ({ x: spot.x + ox * cos + oz * sin, z: spot.z - ox * sin + oz * cos });
    const seat = rot(0, 0);
    const back = rot(0, -0.22);
    const legA = rot(-0.8, 0);
    const legB = rot(0.8, 0);
    setInstance(benchSeatMesh, k, seat.x, 0.45, seat.z, spot.ry);
    setInstance(benchBackMesh, k, back.x, 0.75, back.z, spot.ry);
    setInstance(benchLegMesh, k * 2, legA.x, 0.225, legA.z, spot.ry);
    setInstance(benchLegMesh, k * 2 + 1, legB.x, 0.225, legB.z, spot.ry);
  });
  benchSeatMesh.instanceMatrix.needsUpdate = true;
  benchBackMesh.instanceMatrix.needsUpdate = true;
  benchLegMesh.instanceMatrix.needsUpdate = true;
  scene.add(benchSeatMesh);
  scene.add(benchBackMesh);
  scene.add(benchLegMesh);

  // ---- Docks at the east edge: piers, posts and boats ----------------------
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });
  const pierZs = [-120, 0, 120];
  for (const pz of pierZs) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(48, 0.5, 6), woodMat);
    pier.position.set(264, 0.3, pz);
    pier.castShadow = true;
    pier.receiveShadow = true;
    scene.add(pier);
  }
  const postGeo = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6);
  const postMesh = new THREE.InstancedMesh(postGeo, woodMat, pierZs.length * 4);
  let postIdx = 0;
  for (const pz of pierZs) {
    for (const px of [244, 286]) {
      for (const dz of [-2.6, 2.6]) {
        setInstance(postMesh, postIdx++, px, 0.3, pz + dz);
      }
    }
  }
  postMesh.instanceMatrix.needsUpdate = true;
  scene.add(postMesh);

  const hullGeo = new THREE.BoxGeometry(6, 1.2, 2.6);
  const cabinGeo = new THREE.BoxGeometry(2.5, 1, 2);
  const mastGeo = new THREE.CylinderGeometry(0.06, 0.06, 4, 6);
  const boatSpots = [
    { x: 275, z: -120, color: 0xe8e8e8 }, { x: 285, z: 40, color: 0xc83232 },
    { x: 272, z: 150, color: 0x3268c8 },
  ];
  for (const boat of boatSpots) {
    const hull = new THREE.Mesh(hullGeo, new THREE.MeshLambertMaterial({ color: boat.color }));
    hull.position.set(boat.x, 0.5, boat.z);
    hull.rotation.y = rng.range(0, Math.PI * 2);
    hull.castShadow = true;
    const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshLambertMaterial({ color: 0xf0f0e8 }));
    cabin.position.set(boat.x, 1.5, boat.z);
    cabin.rotation.y = hull.rotation.y;
    const mast = new THREE.Mesh(mastGeo, poleMat);
    mast.position.set(boat.x, 3, boat.z);
    scene.add(hull);
    scene.add(cabin);
    scene.add(mast);
  }

  // ---- Drifting clouds ------------------------------------------------------
  const clouds = [];
  const cloudGeo = new THREE.SphereGeometry(1, 10, 8);
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85,
  });
  for (let i = 0; i < 10; i++) {
    const group = new THREE.Group();
    const puffs = rng.int(3, 5);
    for (let j = 0; j < puffs; j++) {
      const puff = new THREE.Mesh(cloudGeo, cloudMat);
      puff.position.set(rng.range(-8, 8), rng.range(-1.5, 1.5), rng.range(-3, 3));
      puff.scale.set(rng.range(5, 10), rng.range(2, 3.5), rng.range(3, 5));
      group.add(puff);
    }
    group.position.set(rng.range(-320, 320), rng.range(70, 110), rng.range(-320, 320));
    scene.add(group);
    clouds.push({ group, speed: rng.range(1.2, 2.8) });
  }

  // ---- Queries --------------------------------------------------------------
  function isOnRoad(x, z) {
    for (const a of AVENUES) {
      if (Math.abs(x - a) <= HALF_ROAD) return true;
    }
    for (const s of STREETS) {
      if (Math.abs(z - s) <= HALF_ROAD) return true;
    }
    return false;
  }

  function nearestRoadPoint(x, z) {
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
    return dA <= dS ? { x: bestA, z } : { x, z: bestS };
  }

  function randomRoadPoint(rng) {
    const road = rng.pick(roads);
    const along = rng.range(-CITY_HALF + 15, CITY_HALF - 15);
    // Heading along the road: avenues run north-south (0 or PI), streets
    // east-west (PI/2 or -PI/2). Traffic reads it to pick its lane.
    if (road.axis === 'z') {
      return { x: road.at, z: along, heading: rng.chance(0.5) ? 0 : Math.PI };
    }
    return { x: along, z: road.at, heading: rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2 };
  }

  function collides(x, z, r) {
    for (let i = 0; i < buildingBoxes.length; i++) {
      const b = buildingBoxes[i];
      if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) {
        return true;
      }
    }
    return false;
  }

  const spawnPoints = {
    playerStart: { x: 0, z: 30 },
    garage: { x: -60, z: -60 },
    hospital: { x: 120, z: 60 },
    policeStation: { x: 60, z: -120 },
    marina: { x: 0, z: 250 },
    docks: { x: 250, z: 0 },
    hills: { x: -180, z: -180 },
  };

  function update(dt) {
    for (const cloud of clouds) {
      cloud.group.position.x += cloud.speed * dt;
      if (cloud.group.position.x > 380) cloud.group.position.x = -380;
    }
    if (textures.water) {
      textures.water.offset.x += dt * 0.004;
      textures.water.offset.y += dt * 0.002;
    }
  }

  return {
    update,
    roads,
    isOnRoad,
    nearestRoadPoint,
    randomRoadPoint,
    collides,
    spawnPoints,
    districtAt,
  };
}
