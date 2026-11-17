// Menus for Sunset Bay: title, pause, help, wasted, busted and
// mission-complete screens. Menus own the DOM and the state string;
// main.js pauses the simulation whenever state is not 'play'.
// main.js wires the game flow by setting onStart, onContinue and
// onRestartMission on the returned object.

function $(id) {
  return document.getElementById(id);
}

export function createMenus(G) {
  const el = {
    title: $('menu-title'),
    pause: $('menu-pause'),
    help: $('menu-help'),
    wasted: $('menu-wasted'),
    busted: $('menu-busted'),
    missionComplete: $('menu-mission-complete'),
    missionCompleteText: $('mission-complete-text'),
    btnStart: $('btn-start'),
    btnContinue: $('btn-continue'),
    btnControls: $('btn-controls'),
    btnSound: $('btn-sound'),
    btnResume: $('btn-resume'),
    btnRestartMission: $('btn-restart-mission'),
    btnSave: $('btn-save'),
    btnLoad: $('btn-load'),
    btnControlsPause: $('btn-controls-pause'),
    btnQuit: $('btn-quit'),
    btnHelpClose: $('btn-help-close'),
    btnWastedRespawn: $('btn-wasted-respawn'),
    btnBustedRespawn: $('btn-busted-respawn'),
    btnMissionClose: $('btn-mission-close'),
    saveNote: $('save-note'),
    status: $('status'),
  };

  // Which screen the help overlay returns to when it closes.
  let helpReturn = 'title';
  let muted = false;
  let audioStarted = false;
  let titleRefreshTimer = 0;

  const api = {
    state: 'title',
    onStart: function () {},
    onContinue: function () {},
    onRestartMission: defaultRestartMission,
    update: update,
    showTitle: showTitle,
    showPause: showPause,
    hideAll: hideAll,
    showWasted: showWasted,
    showBusted: showBusted,
    showMissionComplete: showMissionComplete,
  };

  function showMenu(node) {
    if (node) node.style.display = 'flex';
  }

  function hideMenu(node) {
    if (node) node.style.display = 'none';
  }

  function hideMenus() {
    hideMenu(el.title);
    hideMenu(el.pause);
    hideMenu(el.help);
    hideMenu(el.wasted);
    hideMenu(el.busted);
    hideMenu(el.missionComplete);
  }

  function announce(text) {
    if (el.status) el.status.textContent = text;
  }

  function setSaveNote(text) {
    if (el.saveNote) el.saveNote.textContent = text;
  }

  function hasSave() {
    try {
      return !!(G.save && typeof G.save.hasSave === 'function' && G.save.hasSave());
    } catch (err) {
      return false;
    }
  }

  function refreshTitle() {
    if (el.btnContinue) el.btnContinue.disabled = !hasSave();
  }

  function refreshPause() {
    if (el.btnLoad) el.btnLoad.disabled = !hasSave();
    setSaveNote('');
  }

  function toast(text) {
    try {
      if (G.hud && typeof G.hud.showMessage === 'function') G.hud.showMessage(text, 3);
    } catch (err) {
      // The toast is a nicety; never let it break the menu action.
    }
    announce(text);
  }

  // Audio starts only after a user gesture; every button click is one.
  function clickSound() {
    try {
      const audio = G.audio;
      if (!audio) return;
      if (!audioStarted && typeof audio.start === 'function') {
        audio.start();
        audioStarted = true;
      }
      if (typeof audio.uiClick === 'function') audio.uiClick();
    } catch (err) {
      // Audio must never break the menus.
    }
  }

  function wire(btn, fn) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      clickSound();
      btn.blur();
      fn();
    });
  }

  // One edge press, consumed so it cannot leak into gameplay.
  function consume(code) {
    const input = G.input;
    if (!input) return false;
    if (typeof input.consumePressed === 'function') return input.consumePressed(code);
    if (typeof input.pressed === 'function') return input.pressed(code);
    return false;
  }

  function startGame() {
    try {
      api.onStart();
    } catch (err) {
      // The game-start callback is the coordinator's; a failure there
      // must not leave the menus stuck.
    }
    hideAll();
  }

  function continueGame() {
    try {
      api.onContinue();
    } catch (err) {
      // As above.
    }
    hideAll();
  }

  function defaultRestartMission() {
    try {
      const missions = G.missions;
      if (missions && missions.current && typeof missions.startMission === 'function') {
        missions.startMission(missions.current.id);
      }
    } catch (err) {
      // No current mission, or missions is not ready yet.
    }
  }

  function restartMission() {
    try {
      api.onRestartMission();
    } catch (err) {
      // As above.
    }
    hideAll();
  }

  function doSave() {
    let ok = false;
    try {
      ok =
        !!(G.save && typeof G.save.saveGame === 'function') && G.save.saveGame(G) !== false;
    } catch (err) {
      ok = false;
    }
    if (ok && el.btnLoad) el.btnLoad.disabled = false;
    setSaveNote(ok ? 'Game saved.' : 'Could not save the game.');
    announce(ok ? 'Game saved.' : 'Could not save the game.');
  }

  function doLoad() {
    let ok = false;
    try {
      ok = !!(G.save && typeof G.save.loadGame === 'function') && !!G.save.loadGame(G);
    } catch (err) {
      ok = false;
    }
    if (ok) {
      hideAll();
      toast('Game loaded.');
    } else {
      setSaveNote('No save found.');
      announce('No save found.');
    }
  }

  function toggleSound() {
    muted = !muted;
    try {
      if (G.audio && typeof G.audio.setMuted === 'function') G.audio.setMuted(muted);
    } catch (err) {
      // Audio must never break the menus.
    }
    if (el.btnSound) el.btnSound.textContent = muted ? 'Sound: Off' : 'Sound: On';
  }

  function respawn() {
    try {
      if (G.player && typeof G.player.respawn === 'function') G.player.respawn();
    } catch (err) {
      // No respawn hook yet; returning to play is still the right move.
    }
    hideAll();
  }

  // Busted means the police station, not the hospital: respawn (which clears
  // the wanted level and takes the fine) then move Milo to the station.
  function respawnBusted() {
    try {
      if (G.player && typeof G.player.respawn === 'function') G.player.respawn();
      const station = G.city && G.city.spawnPoints && G.city.spawnPoints.policeStation;
      if (station && G.player && G.player.position) {
        G.player.position.set(station.x, 0, station.z);
      }
    } catch (err) {
      // Returning to play is still the right move.
    }
    hideAll();
  }

  function openHelp(fromState) {
    helpReturn = fromState;
    hideMenus();
    showMenu(el.help);
    api.state = 'help';
    announce('Controls.');
  }

  function closeHelp() {
    hideMenus();
    if (helpReturn === 'pause') {
      showMenu(el.pause);
      api.state = 'pause';
    } else {
      refreshTitle();
      showMenu(el.title);
      api.state = 'title';
    }
  }

  function showTitle() {
    hideMenus();
    refreshTitle();
    showMenu(el.title);
    api.state = 'title';
    announce('Sunset Bay title screen.');
  }

  function showPause() {
    hideMenus();
    refreshPause();
    showMenu(el.pause);
    api.state = 'pause';
    announce('Game paused.');
  }

  function hideAll() {
    hideMenus();
    api.state = 'play';
    // Flush input queued while the menu was up: the click that resumes the
    // game must not also fire the pistol or enter a car.
    if (G.input) {
      if (typeof G.input.update === 'function') G.input.update();
      if (G.input.mouse) {
        G.input.mouse.left = false;
        G.input.mouse.right = false;
      }
    }
  }

  function showWasted() {
    hideMenus();
    showMenu(el.wasted);
    api.state = 'wasted';
    announce('Wasted. Milo was taken down.');
  }

  function showBusted() {
    hideMenus();
    showMenu(el.busted);
    api.state = 'busted';
    announce('Busted. The police caught Milo.');
  }

  function showMissionComplete(title, reward) {
    hideMenus();
    if (el.missionCompleteText) {
      let text = title || 'Mission complete';
      if (typeof reward === 'number') text += '\nReward: $' + reward;
      el.missionCompleteText.textContent = text;
    }
    showMenu(el.missionComplete);
    api.state = 'mission-complete';
    announce('Mission complete' + (title ? ': ' + title : '') + '.');
  }

  function update(dt) {
    const step = typeof dt === 'number' ? dt : 0;
    // Re-check for a save while on the title screen, so Continue lights
    // up even if the save system attached after the menus were built.
    if (api.state === 'title') {
      titleRefreshTimer += step;
      if (titleRefreshTimer >= 0.5) {
        titleRefreshTimer = 0;
        refreshTitle();
      }
    }
    if (!G.input) return;
    if (api.state === 'play' || api.state === 'pause') {
      if (consume('Escape') || consume('KeyP')) {
        clickSound();
        if (api.state === 'play') showPause();
        else hideAll();
      }
      return;
    }
    if (api.state === 'title') {
      // When a button has keyboard focus, Enter/Space activates it
      // natively; only handle the keys here when no button is focused,
      // so a start is never fired twice.
      const focused = document.activeElement;
      const onButton =
        !!(focused && typeof focused.closest === 'function' && focused.closest('button'));
      if (!onButton && (consume('Enter') || consume('Space'))) {
        clickSound();
        startGame();
      }
      return;
    }
    if (api.state === 'help') {
      if (consume('Escape')) {
        clickSound();
        closeHelp();
      }
      return;
    }
    if (api.state === 'mission-complete') {
      if (consume('Enter') || consume('Space') || consume('Escape')) {
        clickSound();
        hideAll();
      }
    }
  }

  wire(el.btnStart, startGame);
  wire(el.btnContinue, continueGame);
  wire(el.btnControls, function () {
    openHelp('title');
  });
  wire(el.btnSound, toggleSound);
  wire(el.btnResume, hideAll);
  wire(el.btnRestartMission, restartMission);
  wire(el.btnSave, doSave);
  wire(el.btnLoad, doLoad);
  wire(el.btnControlsPause, function () {
    openHelp('pause');
  });
  wire(el.btnQuit, showTitle);
  wire(el.btnHelpClose, closeHelp);
  wire(el.btnWastedRespawn, respawn);
  wire(el.btnBustedRespawn, respawnBusted);
  wire(el.btnMissionClose, hideAll);

  // Boot on the title screen, with Continue enabled only if a save exists.
  showTitle();

  return api;
}
