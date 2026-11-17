// HUD for Sunset Bay: money, health, wanted stars, weapon, speedometer,
// objective line, mission timer, sunset-token counter, dialogue box,
// message toasts, controls hint and the circular minimap. Every read of
// another system goes through G and is guarded, so the HUD never throws
// when a system is missing or not built yet.

import { CITY_HALF, ROAD_WIDTH, STREETS } from './config.js';

// The minimap maps the city plus a small margin onto the 180px canvas.
const MM_SIZE = 180;
const MM_HALF = MM_SIZE / 2;
const MM_WORLD = (CITY_HALF + 20) * 2;
const MM_SCALE = MM_SIZE / MM_WORLD;
const MM_WATER_Z = STREETS[STREETS.length - 1];
const MM_ROAD_WIDTH = Math.max(2, ROAD_WIDTH * MM_SCALE);
const HINT_FADE_SECONDS = 12;

function $(id) {
  return document.getElementById(id);
}

function formatMoney(n) {
  const value = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 0;
  return '$' + value.toLocaleString('en-US');
}

// Pull an {x, z} world position out of a game object, whatever shape it
// keeps its position in (position, mesh.position or pos).
function posOf(obj) {
  if (!obj) return null;
  const p = obj.position || (obj.mesh && obj.mesh.position) || obj.pos;
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return p;
  return null;
}

// A token or marker may be {x, z}, a [x, z] pair or an object with a
// position; normalise all of them to {x, z}.
function tokenXY(tok) {
  if (!tok) return null;
  if (Array.isArray(tok)) {
    const x = tok[0];
    const z = tok.length > 2 ? tok[2] : tok[1];
    if (typeof x === 'number' && typeof z === 'number') return { x, z };
    return null;
  }
  if (typeof tok.x === 'number' && typeof tok.z === 'number') return tok;
  return posOf(tok);
}

// foundTokens may be a Set of indices/ids, an array of indices, or an
// array of token objects; accept all three.
function isTokenFound(found, index, tok) {
  if (!found) return false;
  if (typeof found.has === 'function') {
    if (found.has(index)) return true;
    if (tok && typeof tok.id !== 'undefined' && found.has(tok.id)) return true;
    return false;
  }
  if (Array.isArray(found)) {
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      if (f === index) return true;
      if (f && typeof f === 'object') {
        if (tok && typeof tok.id !== 'undefined' && f.id === tok.id) return true;
        if (
          tok && typeof f.x === 'number' && typeof f.z === 'number' &&
          f.x === tok.x && f.z === tok.z
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// Heading in radians, camera-yaw convention: 0 faces north (-z).
function headingOf(G) {
  if (G.player && typeof G.player.heading === 'number') return G.player.heading;
  if (G.camera && typeof G.camera.yaw === 'number') return G.camera.yaw;
  const mesh = G.player && G.player.mesh;
  if (mesh && mesh.rotation && typeof mesh.rotation.y === 'number') {
    return mesh.rotation.y;
  }
  return 0;
}

function stepTextForType(type) {
  switch (type) {
    case 'goto': return 'Go to the marker';
    case 'getInCar': return 'Get in a car';
    case 'driveTo': return 'Drive to the marker';
    case 'followTarget': return 'Follow the target car';
    case 'loseWanted': return 'Lose the cops';
    case 'pickupAndDeliver': return 'Pick up the goods and deliver them';
    case 'eliminate': return 'Take out the targets';
    default: return 'Follow the marker';
  }
}

// Describe the current mission step, if there is one. The signature
// changes whenever the mission or step changes, so a stale manual
// objective can be dropped.
function currentStepInfo(G) {
  const missions = G.missions;
  if (!missions || !missions.current) return null;
  const mission = missions.current;
  let step = null;
  let stepIndex = 0;
  if (typeof missions.stepIndex === 'number') stepIndex = missions.stepIndex;
  else if (typeof missions.currentStepIndex === 'number') stepIndex = missions.currentStepIndex;
  else if (typeof mission.stepIndex === 'number') stepIndex = mission.stepIndex;
  if (missions.step && typeof missions.step === 'object') step = missions.step;
  else if (missions.currentStep && typeof missions.currentStep === 'object') step = missions.currentStep;
  else if (Array.isArray(mission.steps)) step = mission.steps[stepIndex] || mission.steps[0] || null;
  let stepText = '';
  if (step) {
    stepText = step.text || step.label || step.description || step.briefing || '';
    if (!stepText && step.type) stepText = stepTextForType(step.type);
  }
  const title = mission.title || mission.name || '';
  let text;
  if (title && stepText) text = title + ' — ' + stepText;
  else if (title) text = title;
  else text = stepText || 'Follow the marker';
  const signature =
    (mission.id || title) + ':' + stepIndex + ':' + (step && step.type ? step.type : '');
  return { signature, text };
}

function districtName(G) {
  const pos = posOf(G.player);
  if (G.city && typeof G.city.districtAt === 'function' && pos) {
    try {
      const d = G.city.districtAt(pos.x, pos.z);
      if (typeof d === 'string' && d) return d;
      if (d && typeof d.name === 'string' && d.name) return d.name;
    } catch (err) {
      // Fall through to the city name below.
    }
  }
  return 'Solmar City';
}

// Plot every unit in a list as dots of one radius into the current path.
// Returns true when at least one dot was plotted.
function plotDots(ctx, list, radius) {
  let any = false;
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) {
    const p = posOf(list[i]);
    if (!p) continue;
    const px = MM_HALF + p.x * MM_SCALE;
    const py = MM_HALF + p.z * MM_SCALE;
    ctx.moveTo(px + radius, py);
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    any = true;
  }
  return any;
}

export function createHUD(G) {
  const el = {
    money: $('money'),
    wanted: $('wanted'),
    tokens: $('tokens'),
    healthFill: $('health-fill'),
    healthBar: $('health-bar'),
    weapon: $('weapon'),
    ammo: $('ammo'),
    speedo: $('speedo'),
    objective: $('objective'),
    timer: $('timer'),
    dialogue: $('dialogue'),
    dialogueName: $('dialogue-name'),
    dialogueText: $('dialogue-text'),
    message: $('message'),
    crosshair: $('crosshair'),
    hint: $('hint'),
    status: $('status'),
    minimap: $('minimap'),
  };
  const mm = el.minimap ? el.minimap.getContext('2d') : null;

  let time = 0;
  let messageTimer = 0;
  let dialogueTimer = 0;
  let hintTimer = HINT_FADE_SECONDS;
  let objectiveOverride = null;
  let lastMissionSignature = '';

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function show(node) {
    if (node) node.style.display = 'block';
  }

  function hide(node) {
    if (node) node.style.display = 'none';
  }

  function announce(text) {
    if (el.status) el.status.textContent = text;
  }

  function updateMoneyHealth() {
    const player = G.player || null;
    const money = player && typeof player.money === 'number' ? player.money : 0;
    setText(el.money, formatMoney(money));
    const health = player && typeof player.health === 'number' ? player.health : 100;
    const maxHealth =
      player && typeof player.maxHealth === 'number' && player.maxHealth > 0
        ? player.maxHealth
        : 100;
    const frac = Math.max(0, Math.min(1, health / maxHealth));
    if (el.healthFill) {
      el.healthFill.style.width = (frac * 100).toFixed(1) + '%';
      el.healthFill.style.background = 'hsl(' + Math.round(frac * 120) + ', 85%, 45%)';
    }
    if (el.healthBar) el.healthBar.classList.toggle('low', frac < 0.3 && frac > 0);
  }

  function updateWanted() {
    const police = G.police || null;
    const wanted =
      police && typeof police.wanted === 'number'
        ? Math.max(0, Math.min(5, Math.floor(police.wanted)))
        : 0;
    if (!el.wanted) return;
    if (wanted > 0) {
      setText(el.wanted, '★'.repeat(wanted));
      show(el.wanted);
    } else {
      hide(el.wanted);
    }
  }

  function updateWeapon() {
    let name = 'Fists';
    let ammoText = '—';
    const combat = G.combat || null;
    if (combat) {
      let w = null;
      const list = combat.weapons;
      if (Array.isArray(list) && list.length > 0) {
        const idx = typeof combat.current === 'number' ? combat.current : 0;
        w = list[idx] || list[0];
      } else if (list && typeof list === 'object') {
        w = list[combat.current] || null;
      }
      if (typeof w === 'string') {
        name = w;
      } else if (w && typeof w === 'object') {
        name = w.name || w.id || w.type || 'Weapon';
        if (typeof w.ammo === 'number') {
          ammoText = String(w.ammo);
          if (typeof w.reserve === 'number') {
            ammoText += ' / ' + (w.reserve === Infinity ? '∞' : String(w.reserve));
          }
        } else if (typeof w.mag === 'number') {
          ammoText = String(w.mag);
        } else if (typeof combat.ammo === 'number') {
          ammoText = String(combat.ammo);
        }
      } else if (typeof combat.ammo === 'number') {
        ammoText = String(combat.ammo);
      }
      if (/fist/i.test(name)) ammoText = '—';
    }
    setText(el.weapon, name);
    setText(el.ammo, ammoText);
  }

  function updateSpeedo() {
    const player = G.player || null;
    const driving = !!player && player.mode === 'car';
    let kmh = null;
    if (driving) {
      const pv = G.vehicles && G.vehicles.playerVehicle;
      if (pv && typeof pv.speedKmh === 'number') kmh = pv.speedKmh;
      else if (pv && typeof pv.speed === 'number') kmh = pv.speed * 3.6;
      else if (typeof player.speedKmh === 'number') kmh = player.speedKmh;
    }
    if (!el.speedo) return;
    if (driving && kmh !== null) {
      setText(el.speedo, Math.max(0, Math.round(kmh)) + ' km/h');
      show(el.speedo);
    } else {
      hide(el.speedo);
    }
  }

  function updateObjective() {
    const info = currentStepInfo(G);
    if (info) {
      if (info.signature !== lastMissionSignature) {
        lastMissionSignature = info.signature;
        objectiveOverride = null;
      }
    } else if (lastMissionSignature !== '') {
      lastMissionSignature = '';
      objectiveOverride = null;
    }
    let text;
    if (objectiveOverride !== null) text = objectiveOverride;
    else if (info) text = info.text;
    else text = districtName(G);
    setText(el.objective, text);
  }

  function updateTimer() {
    const missions = G.missions || null;
    let seconds = null;
    if (missions) {
      const candidates = [
        missions.timeLeft,
        missions.stepTimeLeft,
        missions.currentTimeLeft,
        missions.timer,
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === 'number' && isFinite(candidates[i]) && candidates[i] > 0) {
          seconds = candidates[i];
          break;
        }
      }
    }
    if (!el.timer) return;
    if (seconds !== null) {
      const total = Math.ceil(seconds);
      const mins = Math.floor(total / 60);
      const secs = total % 60;
      setText(el.timer, mins + ':' + (secs < 10 ? '0' : '') + secs);
      show(el.timer);
    } else {
      hide(el.timer);
    }
  }

  function updateTokens() {
    if (!el.tokens) return;
    const missions = G.missions || null;
    let found = null;
    let total = 10;
    if (missions) {
      if (typeof missions.tokensFound === 'number') found = missions.tokensFound;
      else if (Array.isArray(missions.foundTokens)) found = missions.foundTokens.length;
      else if (missions.foundTokens && typeof missions.foundTokens.size === 'number') {
        found = missions.foundTokens.size;
      }
      if (Array.isArray(missions.tokenPositions) && missions.tokenPositions.length > 0) {
        total = missions.tokenPositions.length;
      }
    }
    if (found === null) {
      hide(el.tokens);
      return;
    }
    setText(el.tokens, '☀ ' + found + '/' + total);
    show(el.tokens);
  }

  function updateDialogue(dt) {
    if (dialogueTimer > 0) {
      dialogueTimer -= dt;
      if (dialogueTimer <= 0) hide(el.dialogue);
    }
  }

  function updateMessage(dt) {
    if (messageTimer > 0) {
      messageTimer -= dt;
      if (messageTimer <= 0) {
        hide(el.message);
      } else if (el.message) {
        el.message.style.opacity = messageTimer < 0.5 ? String(messageTimer / 0.5) : '1';
      }
    }
  }

  function updateHint(dt) {
    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) {
        hide(el.hint);
      } else if (el.hint && hintTimer < 1) {
        el.hint.style.opacity = String(hintTimer);
      }
    }
  }

  function drawMinimap() {
    if (!mm) return;
    const ctx = mm;
    ctx.save();
    ctx.beginPath();
    ctx.arc(MM_HALF, MM_HALF, MM_HALF - 1, 0, Math.PI * 2);
    ctx.clip();
    // Dark land.
    ctx.fillStyle = '#12202b';
    ctx.fillRect(0, 0, MM_SIZE, MM_SIZE);
    // Water at the south edge.
    ctx.fillStyle = '#1b6f8a';
    ctx.fillRect(0, MM_HALF + MM_WATER_Z * MM_SCALE, MM_SIZE, MM_SIZE);
    // Roads, batched into one stroke.
    const city = G.city;
    if (city && Array.isArray(city.roads)) {
      ctx.strokeStyle = '#5d6b78';
      ctx.lineWidth = MM_ROAD_WIDTH;
      ctx.beginPath();
      for (let i = 0; i < city.roads.length; i++) {
        const road = city.roads[i];
        if (!road) continue;
        if (road.axis === 'x') {
          const y = MM_HALF + road.at * MM_SCALE;
          ctx.moveTo(0, y);
          ctx.lineTo(MM_SIZE, y);
        } else {
          const x = MM_HALF + road.at * MM_SCALE;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, MM_SIZE);
        }
      }
      ctx.stroke();
    }
    // Uncollected sunset tokens, green dots.
    const missions = G.missions;
    if (missions && Array.isArray(missions.tokenPositions)) {
      const found = missions.foundTokens;
      ctx.fillStyle = '#39d353';
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < missions.tokenPositions.length; i++) {
        const tok = missions.tokenPositions[i];
        const p = tokenXY(tok);
        if (!p) continue;
        if (isTokenFound(found, i, tok)) continue;
        const px = MM_HALF + p.x * MM_SCALE;
        const py = MM_HALF + p.z * MM_SCALE;
        ctx.moveTo(px + 2.5, py);
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        any = true;
      }
      if (any) ctx.fill();
    }
    // Mission marker, a pulsing yellow diamond.
    if (missions && missions.currentMarker) {
      const m = tokenXY(missions.currentMarker);
      if (m) {
        const mx = MM_HALF + m.x * MM_SCALE;
        const my = MM_HALF + m.z * MM_SCALE;
        const r = 5 + Math.sin(time * 4) * 1.5;
        ctx.fillStyle = '#ffd60a';
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, my - r);
        ctx.lineTo(mx + r, my);
        ctx.lineTo(mx, my + r);
        ctx.lineTo(mx - r, my);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    // Police units, flashing blue/red.
    const police = G.police;
    if (police) {
      const flash = Math.floor(time * 2.5) % 2 === 0;
      ctx.fillStyle = flash ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      const anyCars = plotDots(ctx, police.policeCars, 3);
      const anyCops = plotDots(ctx, police.cops, 3);
      if (anyCars || anyCops) ctx.fill();
    }
    // Player arrow, rotating with heading.
    const playerPos = posOf(G.player);
    if (playerPos) {
      ctx.save();
      ctx.translate(MM_HALF + playerPos.x * MM_SCALE, MM_HALF + playerPos.z * MM_SCALE);
      ctx.rotate(-headingOf(G));
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // North indicator.
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', MM_HALF, 4);
    ctx.restore();
    // Rim.
    ctx.beginPath();
    ctx.arc(MM_HALF, MM_HALF, MM_HALF - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function update(dt) {
    const step = typeof dt === 'number' ? dt : 0;
    time += step;
    updateMoneyHealth();
    updateWanted();
    updateWeapon();
    updateSpeedo();
    updateObjective();
    updateTimer();
    updateTokens();
    updateDialogue(step);
    updateMessage(step);
    updateHint(step);
    drawMinimap();
  }

  function showObjective(text) {
    objectiveOverride = text;
    const info = currentStepInfo(G);
    lastMissionSignature = info ? info.signature : '';
    setText(el.objective, text);
    announce(text);
  }

  function showMessage(text, dur) {
    if (!el.message) return;
    setText(el.message, text);
    el.message.style.opacity = '1';
    show(el.message);
    messageTimer = typeof dur === 'number' && dur > 0 ? dur : 3;
    announce(text);
  }

  function showDialogue(name, text, dur) {
    setText(el.dialogueName, name || '');
    setText(el.dialogueText, text || '');
    show(el.dialogue);
    dialogueTimer = typeof dur === 'number' && dur > 0 ? dur : 4;
    announce((name ? name + ': ' : '') + (text || ''));
  }

  function showHelp(text) {
    if (!el.hint) return;
    setText(el.hint, text);
    el.hint.style.opacity = '1';
    show(el.hint);
    hintTimer = HINT_FADE_SECONDS;
  }

  function setCrosshair(visible) {
    if (!el.crosshair) return;
    if (visible) show(el.crosshair);
    else hide(el.crosshair);
  }

  return { update, showObjective, showMessage, showDialogue, showHelp, setCrosshair };
}
