// Procedural canvas textures for Sunset Bay: building facades, roads, ground,
// sand, water and roofs. Everything is drawn on 2D canvases at load time —
// no image files, no network. All variation comes from the seeded rng passed in.

import * as THREE from 'three';
import { COLORS } from './config.js';

function makeTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function hex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

function speckle(ctx, width, height, rng, count, colors, maxSize) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rng.pick(colors);
    const size = rng.range(1, maxSize);
    ctx.fillRect(rng.range(0, width), rng.range(0, height), size, size);
  }
}

// One building facade: tinted wall, a darker parapet band, a ground floor with a
// door, and a grid of windows — some warmly lit, most dark glass.
function buildingTexture(rng, baseColor, cols, rows) {
  return makeTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = hex(baseColor);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 500, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.05)'], 3);

    // Parapet band along the top.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, 10);

    // Ground floor band with a door.
    const groundY = h - 34;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, groundY, w, 34);
    ctx.fillStyle = '#2a2a30';
    ctx.fillRect(w / 2 - 14, groundY + 6, 28, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(w / 2 - 14, groundY + 6, 28, 4);

    // Window grid.
    const marginX = 14;
    const top = 18;
    const bottom = groundY - 8;
    const cellW = (w - marginX * 2) / cols;
    const cellH = (bottom - top) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = marginX + c * cellW + cellW * 0.18;
        const y = top + r * cellH + cellH * 0.18;
        const ww = cellW * 0.64;
        const wh = cellH * 0.64;
        // Frame.
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(x - 2, y - 2, ww + 4, wh + 4);
        // Pane: sometimes lit, otherwise dark glass.
        if (rng.chance(0.22)) {
          ctx.fillStyle = '#ffd27a';
        } else {
          ctx.fillStyle = rng.chance(0.5) ? '#2a3a48' : '#33454f';
        }
        ctx.fillRect(x, y, ww, wh);
        // A little sky shine on the glass.
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, ww, wh * 0.3);
      }
    }
  });
}

// Asphalt with a dashed centre line (vertical in the tile, so it runs along the
// road when the tile repeats) and solid edge lines.
function roadTexture(rng) {
  return makeTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = hex(COLORS.asphalt);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 1800, ['#2a2a2e', '#3d3d42', '#45454a'], 2);
    ctx.fillStyle = 'rgba(216,216,200,0.55)';
    ctx.fillRect(8, 0, 4, h);
    ctx.fillRect(w - 12, 0, 4, h);
    ctx.fillStyle = hex(COLORS.asphaltLine);
    for (let y = 0; y < h; y += 64) {
      ctx.fillRect(w / 2 - 3, y + 8, 6, 40);
    }
  });
}

function sidewalkTexture(rng) {
  return makeTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = hex(COLORS.sidewalk);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 700, ['#8a8a82', '#aaaaa2', '#94948c'], 2);
    // Expansion joints.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, 2);
    ctx.fillRect(0, 64, w, 2);
    ctx.fillRect(0, 0, 2, h);
    ctx.fillRect(64, 0, 2, h);
  });
}

function grassTexture(rng) {
  return makeTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = hex(COLORS.ground);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 1400, ['#7a7f6a', '#9a9f8a', '#6a7a5a', '#a8a88a'], 3);
  });
}

function sandTexture(rng) {
  return makeTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = hex(COLORS.sand);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 900, ['#d8c898', '#f0e0b8', '#c8b888'], 2);
  });
}

function waterTexture(rng) {
  return makeTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = hex(COLORS.water);
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {
      const y = rng.range(0, h);
      const x = rng.range(0, w);
      const len = rng.range(20, 90);
      const light = rng.chance(0.6);
      ctx.strokeStyle = light ? 'rgba(255,255,255,0.10)' : 'rgba(0,40,60,0.12)';
      ctx.lineWidth = rng.range(2, 5);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len / 2, y + rng.range(-6, 6), x + len, y + rng.range(-3, 3));
      ctx.stroke();
    }
    speckle(ctx, w, h, rng, 300, ['rgba(255,255,255,0.08)'], 2);
  });
}

function roofTexture(rng) {
  return makeTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#55555a';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rng, 900, ['#4a4a4e', '#606066', '#424248'], 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i <= 128; i += 32) {
      ctx.fillRect(i, 0, 2, h);
      ctx.fillRect(0, i, w, 2);
    }
  });
}

/**
 * Build every procedural texture for the city. `rng` is the seeded generator
 * from G. Returns { building: [CanvasTexture x6], road, sidewalk, grass,
 * sand, beach (alias of sand), water, roof }.
 */
export function createTextures(rng) {
  const sand = sandTexture(rng);
  const building = COLORS.building.map((color, i) =>
    buildingTexture(rng, color, 4 + (i % 3), 6 + (i % 3) * 2));
  return {
    building,
    road: roadTexture(rng),
    sidewalk: sidewalkTexture(rng),
    grass: grassTexture(rng),
    sand,
    beach: sand,
    water: waterTexture(rng),
    roof: roofTexture(rng),
  };
}
