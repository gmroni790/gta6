// Saving for Sunset Bay: one localStorage slot holding the player's
// position, health and money, mission progress, found sunset tokens and
// time played. Every storage access is wrapped in try/catch, so a missing
// or blocked localStorage degrades to "no save" instead of an exception.

import { CONFIG } from './config.js';

const KEY = CONFIG.SAVE_KEY;

// Set an {x, y, z} vector, whether it is a three.js Vector3 (with .set)
// or a plain object.
function setVec(vec, x, y, z) {
  if (!vec) return;
  if (typeof vec.set === 'function') vec.set(x, y, z);
  else {
    vec.x = x;
    vec.y = y;
    vec.z = z;
  }
}

export function saveGame(G) {
  try {
    const player = G.player || {};
    const pos =
      player.position || (player.mesh && player.mesh.position) || { x: 0, y: 0, z: 0 };
    const missions = G.missions || {};
    const found = missions.foundTokens;
    let foundArr = [];
    if (Array.isArray(found)) {
      foundArr = found.slice();
    } else if (found && typeof found.forEach === 'function') {
      found.forEach(function (value) {
        foundArr.push(value);
      });
    }
    const data = {
      version: 1,
      player: {
        x: typeof pos.x === 'number' ? pos.x : 0,
        y: typeof pos.y === 'number' ? pos.y : 0,
        z: typeof pos.z === 'number' ? pos.z : 0,
        mode: player.mode || 'foot',
        health: typeof player.health === 'number' ? player.health : 100,
        money: typeof player.money === 'number' ? player.money : 0,
      },
      missions: {
        completed: Array.isArray(missions.completed) ? missions.completed.slice() : [],
        currentId: missions.current ? missions.current.id || null : null,
      },
      tokensFound: foundArr,
      timePlayed:
        typeof G.timePlayed === 'number'
          ? G.timePlayed
          : typeof G.time === 'number'
            ? G.time
            : 0,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    return false;
  }
}

export function loadGame(G) {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch (err) {
    return false;
  }
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return false;
  }
  if (!data || typeof data !== 'object' || !data.player) return false;

  try {
    // Player: step out of any car first, then restore position on foot.
    // Vehicles are not saved, so a saved car trip always resumes on foot
    // at the saved spot.
    const p = data.player;
    const player = G.player;
    if (player) {
      if (player.mode === 'car' && typeof player.exitVehicle === 'function') {
        try {
          player.exitVehicle();
        } catch (err) {
          // Carry on; the position restore below still applies.
        }
      }
      const x = typeof p.x === 'number' ? p.x : 0;
      const y = typeof p.y === 'number' ? p.y : 0;
      const z = typeof p.z === 'number' ? p.z : 0;
      if (typeof player.setPosition === 'function') {
        try {
          player.setPosition(x, y, z);
        } catch (err) {
          // Fall through to the direct restore below.
        }
      }
      try {
        setVec(player.position, x, y, z);
      } catch (err) {
        // Position is best-effort if the player object is unusual.
      }
      const meshPos = player.mesh && player.mesh.position;
      if (meshPos && meshPos !== player.position) {
        try {
          setVec(meshPos, x, y, z);
        } catch (err) {
          // As above.
        }
      }
      if (typeof p.health === 'number') {
        const maxHealth =
          typeof player.maxHealth === 'number' && player.maxHealth > 0
            ? player.maxHealth
            : 100;
        try {
          player.health = Math.max(1, Math.min(maxHealth, p.health));
        } catch (err) {
          // Health restore is best-effort.
        }
      }
      if (typeof p.money === 'number') {
        try {
          player.money = p.money;
        } catch (err) {
          // As above.
        }
      }
      try {
        player.mode = 'foot';
      } catch (err) {
        // As above.
      }
    }

    // Missions: completed list, current mission id, found tokens. The
    // missions module may expose setters for these; fall back to direct
    // assignment (or Set refill) when it does not. The current mission
    // resumes from its first step: mid-mission step progress is not saved.
    const missions = G.missions;
    const savedMissions = data.missions || {};
    if (missions) {
      const completed = Array.isArray(savedMissions.completed)
        ? savedMissions.completed.slice()
        : [];
      if (typeof missions.setCompleted === 'function') {
        try {
          missions.setCompleted(completed.slice());
        } catch (err) {
          // Fall back to direct assignment below.
          try {
            missions.completed = completed.slice();
          } catch (err2) {
            // Completed list is best-effort.
          }
        }
      } else {
        try {
          missions.completed = completed.slice();
        } catch (err) {
          // As above.
        }
      }
      const currentId = savedMissions.currentId || null;
      if (currentId) {
        if (typeof missions.setCurrent === 'function') {
          try {
            missions.setCurrent(currentId);
          } catch (err) {
            // Fall through to the list lookup below.
            setCurrentFromList(missions, currentId);
          }
        } else {
          setCurrentFromList(missions, currentId);
        }
      } else if (typeof missions.setCurrent === 'function') {
        try {
          missions.setCurrent(null);
        } catch (err) {
          // No current mission is the default anyway.
        }
      } else {
        try {
          missions.current = null;
        } catch (err) {
          // As above.
        }
      }
      const tokens = Array.isArray(data.tokensFound) ? data.tokensFound.slice() : [];
      if (typeof missions.setFoundTokens === 'function') {
        try {
          missions.setFoundTokens(tokens.slice());
        } catch (err) {
          // Fall through to the direct restore below.
          restoreFoundTokens(missions, tokens);
        }
      } else {
        restoreFoundTokens(missions, tokens);
      }
      if (typeof missions.tokensFound === 'number') {
        try {
          missions.tokensFound = tokens.length;
        } catch (err) {
          // tokensFound may be a derived getter; ignore if so.
        }
      }
    }

    // Time played.
    if (typeof data.timePlayed === 'number') {
      try {
        G.timePlayed = data.timePlayed;
      } catch (err) {
        // Time played is informational only.
      }
    }

    // Wanted level always resets to 0 on load.
    const police = G.police;
    if (police) {
      if (typeof police.clearWanted === 'function') {
        try {
          police.clearWanted();
        } catch (err) {
          // Fall through to the other resets below.
          try {
            police.wanted = 0;
          } catch (err2) {
            // Wanted reset is best-effort.
          }
        }
      } else if (typeof police.setWanted === 'function') {
        try {
          police.setWanted(0);
        } catch (err) {
          try {
            police.wanted = 0;
          } catch (err2) {
            // As above.
          }
        }
      } else {
        try {
          police.wanted = 0;
        } catch (err) {
          // As above.
        }
      }
    }

    return true;
  } catch (err) {
    return false;
  }
}

// Find a mission by id in the mission list and make it current.
function setCurrentFromList(missions, currentId) {
  if (!Array.isArray(missions.list)) return;
  for (let i = 0; i < missions.list.length; i++) {
    const entry = missions.list[i];
    if (entry && entry.id === currentId) {
      try {
        missions.current = entry;
      } catch (err) {
        // Current mission is best-effort without a setter.
      }
      return;
    }
  }
}

// Restore the found-token collection without a setter: refill a Set in
// place, or replace a plain array.
function restoreFoundTokens(missions, tokens) {
  const found = missions.foundTokens;
  if (
    found &&
    typeof found.clear === 'function' &&
    typeof found.add === 'function'
  ) {
    try {
      found.clear();
      tokens.forEach(function (t) {
        found.add(t);
      });
    } catch (err) {
      // Token restore is best-effort.
    }
  } else {
    try {
      missions.foundTokens = tokens.slice();
    } catch (err) {
      // As above.
    }
  }
}

export function hasSave() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch (err) {
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    // Nothing to clear, or storage is unavailable.
  }
}
