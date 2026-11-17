// Synthesized audio for Sunset Bay: every sound is built with the WebAudio API —
// no audio files, no network. The AudioContext is created lazily in start(), which
// the menus call after the first user gesture. If WebAudio is unavailable, every
// method silently no-ops and nothing ever throws.

export function createAudio(G) {
  let ctx = null; // AudioContext, created in start()
  let master = null; // master GainNode (0.5 when unmuted)
  let noiseBuffer = null; // 1s of white noise, shared by all noise-based sounds
  let muted = false;
  let musicOn = true; // music is on by default once audio starts
  let time = 0; // accumulated dt, for throttling

  // --- Engine voice (one sawtooth osc + lowpass, kept alive, gain by on/off) ---
  let engineOsc = null;
  let engineFilter = null;
  let engineGain = null;
  let engineTargetSpeed = 0; // 0..1, set by engine()
  let engineTargetOn = false;
  let engineSpeed = 0; // smoothed speed

  // --- Siren voice (one square osc through a bandpass, alternating tones) ---
  let sirenOsc = null;
  let sirenFilter = null;
  let sirenGain = null;
  let sirenOn = false;
  let sirenPhase = 0; // seconds into the current tone
  let sirenHigh = false;

  // --- Music sequencer state ---
  let schedulerId = null; // setInterval handle
  let nextNoteTime = 0;
  let step = 0; // eighth-note index in the 32-step loop
  let padVoices = []; // { osc, stopTime } so setMusic(false) can silence pads

  // --- One-shot throttles ---
  let lastSkidTime = -1;
  let hornUntil = -1;

  // Chords: Am - F - C - G, one per bar. Each chord lists its pad notes (Hz) and
  // its bass root (Hz, one octave below the chord root).
  const CHORDS = [
    { pad: [110.0, 130.81, 164.81], bass: 55.0 }, // Am
    { pad: [87.31, 110.0, 130.81], bass: 43.65 }, // F
    { pad: [130.81, 164.81, 196.0], bass: 65.41 }, // C
    { pad: [98.0, 123.47, 146.83], bass: 49.0 }, // G
  ];
  const BPM = 100;
  const EIGHTH = 60 / BPM / 2; // 0.3s
  const BAR = EIGHTH * 8; // 2.4s
  const STEPS_PER_BAR = 8;

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function makeNoiseBuffer() {
    const length = Math.floor(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const rng = G && G.rng;
    for (let i = 0; i < length; i++) {
      // White noise; use the seeded rng when available for determinism.
      data[i] = rng ? rng.range(-1, 1) : 0;
    }
    return buffer;
  }

  // Short filtered noise burst. `filterType`/`freq` shape the sound; `sweepTo`
  // optionally glides the filter cutoff down over the burst.
  function playNoise(dur, filterType, freq, q, gainValue, sweepTo) {
    if (!ctx || !noiseBuffer) return;
    const t = now();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
    }
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // A single oscillator blip with a pitch glide and an exponential decay.
  function playTone(type, freq, dur, gainValue, glideTo) {
    if (!ctx) return;
    const t = now();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function ensureEngineNodes() {
    if (!ctx || engineOsc) return;
    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 55;
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 300;
    engineFilter.Q.value = 1;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engineOsc.start();
  }

  function ensureSirenNodes() {
    if (!ctx || sirenOsc) return;
    sirenOsc = ctx.createOscillator();
    sirenOsc.type = 'square';
    sirenOsc.frequency.value = 700;
    sirenFilter = ctx.createBiquadFilter();
    sirenFilter.type = 'bandpass';
    sirenFilter.frequency.value = 820;
    sirenFilter.Q.value = 2;
    sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenOsc.connect(sirenFilter);
    sirenFilter.connect(sirenGain);
    sirenGain.connect(master);
    sirenOsc.start();
  }

  // Schedule one eighth-note step of the music loop at absolute time `t`.
  function scheduleStep(stepIndex, t) {
    const barIndex = Math.floor(stepIndex / STEPS_PER_BAR) % CHORDS.length;
    const stepInBar = stepIndex % STEPS_PER_BAR;
    const chord = CHORDS[barIndex];

    // Chord pad at the start of each bar: two detuned triangle oscs per note,
    // slow attack, released at the end of the bar.
    if (stepInBar === 0) {
      for (let i = 0; i < chord.pad.length; i++) {
        for (let d = 0; d < 2; d++) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = chord.pad[i];
          osc.detune.value = d === 0 ? -5 : 5;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.035, t + 0.4);
          gain.gain.setValueAtTime(0.035, t + BAR - 0.4);
          gain.gain.linearRampToValueAtTime(0, t + BAR);
          osc.connect(gain);
          gain.connect(master);
          osc.start(t);
          osc.stop(t + BAR + 0.05);
          padVoices.push({ osc, stopTime: t + BAR });
        }
      }
      // Prune pad voices that have already finished so the list stays short.
      padVoices = padVoices.filter((v) => v.stopTime > t);
    }

    // Bassline: eighth-note roots, triangle, short plucky envelope.
    {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = chord.bass;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.14, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + EIGHTH * 0.9);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + EIGHTH);
    }

    // Soft kick on beats 1 and 3 (steps 0 and 4): sine pitch drop.
    if (stepInBar === 0 || stepInBar === 4) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + 0.16);
    }

    // Soft hat on the off-beats: highpassed noise tick.
    if (stepInBar % 2 === 1 && noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 6000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.03, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start(t);
      src.stop(t + 0.06);
    }
  }

  function startScheduler() {
    if (!ctx || schedulerId !== null) return;
    step = 0;
    nextNoteTime = now() + 0.1;
    schedulerId = setInterval(() => {
      if (!ctx) return;
      try {
        while (nextNoteTime < now() + 0.25) {
          scheduleStep(step, nextNoteTime);
          nextNoteTime += EIGHTH;
          step = (step + 1) % (STEPS_PER_BAR * CHORDS.length);
        }
      } catch (err) {
        // A scheduling hiccup must never break the game loop.
      }
    }, 100);
  }

  function stopScheduler() {
    if (schedulerId !== null) {
      clearInterval(schedulerId);
      schedulerId = null;
    }
    // Silence any pad still ringing out.
    for (let i = 0; i < padVoices.length; i++) {
      try {
        padVoices[i].osc.stop();
      } catch (err) {
        // Already stopped; ignore.
      }
    }
    padVoices = [];
  }

  function start() {
    if (ctx) {
      // Already started; just make sure we are running (autoplay resume).
      try {
        if (ctx.state === 'suspended') ctx.resume();
      } catch (err) {
        // Ignore.
      }
      return;
    }
    try {
      const AudioCtx =
        typeof window !== 'undefined' &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AudioCtx) return;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      noiseBuffer = makeNoiseBuffer();
      if (ctx.state === 'suspended') ctx.resume();
      if (musicOn) startScheduler();
    } catch (err) {
      // WebAudio unavailable: stay silent, every method no-ops via !ctx checks.
      ctx = null;
      master = null;
      noiseBuffer = null;
    }
  }

  function setMusic(on) {
    musicOn = !!on;
    if (!ctx) return;
    try {
      if (musicOn) startScheduler();
      else stopScheduler();
    } catch (err) {
      // Ignore.
    }
  }

  function setMuted(m) {
    muted = !!m;
    if (!ctx || !master) return;
    try {
      master.gain.setTargetAtTime(muted ? 0 : 0.5, now(), 0.02);
    } catch (err) {
      // Ignore.
    }
  }

  function update(dt) {
    time += dt;
    if (!ctx) return;

    // M toggles mute, N toggles music. Prefer consumePressed (edge, consumed once)
    // and fall back to pressed() if the input module only offers that.
    try {
      const input = G && G.input;
      if (input) {
        const hit = (code) => {
          if (typeof input.consumePressed === 'function') {
            return input.consumePressed(code);
          }
          if (typeof input.pressed === 'function') {
            return input.pressed(code);
          }
          return false;
        };
        if (hit('KeyM')) setMuted(!muted);
        if (hit('KeyN')) setMusic(!musicOn);
      }
    } catch (err) {
      // Key handling must never break the frame.
    }

    // Engine smoothing: ease the speed toward its target, then glide pitch,
    // filter cutoff and gain so the engine never jumps.
    try {
      if (engineOsc && engineGain) {
        const k = Math.min(1, dt * 6);
        engineSpeed += (engineTargetSpeed - engineSpeed) * k;
        const t = now();
        const freq = 55 + engineSpeed * 165;
        const cutoff = 300 + engineSpeed * 900;
        const gain = engineTargetOn ? 0.05 + engineSpeed * 0.06 : 0;
        engineOsc.frequency.setTargetAtTime(freq, t, 0.05);
        engineFilter.frequency.setTargetAtTime(cutoff, t, 0.05);
        engineGain.gain.setTargetAtTime(gain, t, 0.08);
      }
    } catch (err) {
      // Ignore.
    }

    // Siren: alternate 700/950 Hz every 0.35s; loudness follows police heat.
    try {
      if (sirenOsc && sirenGain) {
        const t = now();
        if (sirenOn) {
          sirenPhase += dt;
          if (sirenPhase >= 0.35) {
            sirenPhase = 0;
            sirenHigh = !sirenHigh;
            sirenOsc.frequency.setTargetAtTime(sirenHigh ? 950 : 700, t, 0.02);
          }
          let heat = 0.5;
          if (G.police && typeof G.police.heat === 'number') {
            heat = Math.max(0, Math.min(1, G.police.heat));
          }
          sirenGain.gain.setTargetAtTime(0.04 + 0.1 * heat, t, 0.1);
        } else {
          sirenGain.gain.setTargetAtTime(0, t, 0.1);
        }
      }
    } catch (err) {
      // Ignore.
    }
  }

  return {
    update,
    start,
    setMusic,
    // speedNorm 0..1; `on` false silences the engine (parked / on foot).
    engine(speedNorm, on) {
      engineTargetSpeed = Math.max(0, Math.min(1, speedNorm || 0));
      engineTargetOn = !!on;
      if (!ctx) return;
      try {
        ensureEngineNodes();
      } catch (err) {
        // Ignore.
      }
    },
    // One siren voice; police.js turns it on while wanted > 0.
    siren(on) {
      sirenOn = !!on;
      if (!ctx) return;
      try {
        ensureSirenNodes();
      } catch (err) {
        // Ignore.
      }
    },
    gunshot() {
      if (!ctx) return;
      try {
        playNoise(0.12, 'bandpass', 1800, 1, 0.5);
        playTone('sine', 130, 0.12, 0.4, 60);
      } catch (err) {
        // Ignore.
      }
    },
    explosion() {
      if (!ctx) return;
      try {
        playNoise(0.7, 'lowpass', 800, 0.7, 0.8, 100);
        playTone('sine', 70, 0.6, 0.7, 35);
      } catch (err) {
        // Ignore.
      }
    },
    uiClick() {
      if (!ctx) return;
      try {
        playTone('square', 880, 0.06, 0.1);
      } catch (err) {
        // Ignore.
      }
    },
    pickup() {
      if (!ctx) return;
      try {
        // Two-note chime: E5 then A5, staggered.
        const t = now();
        const notes = [659.25, 880.0];
        for (let i = 0; i < notes.length; i++) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = notes[i];
          const gain = ctx.createGain();
          const startAt = t + i * 0.09;
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(0.15, startAt + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.3);
          osc.connect(gain);
          gain.connect(master);
          osc.start(startAt);
          osc.stop(startAt + 0.32);
        }
      } catch (err) {
        // Ignore.
      }
    },
    horn() {
      if (!ctx) return;
      // Don't stack horns on top of each other.
      if (time < hornUntil) return;
      hornUntil = time + 0.4;
      try {
        const t = now();
        const freqs = [400, 500];
        for (let i = 0; i < freqs.length; i++) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = freqs[i];
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 1200;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.12, t);
          gain.gain.setValueAtTime(0.12, t + 0.35);
          gain.gain.linearRampToValueAtTime(0, t + 0.4);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(master);
          osc.start(t);
          osc.stop(t + 0.42);
        }
      } catch (err) {
        // Ignore.
      }
    },
    skid() {
      if (!ctx) return;
      // Throttled: at most one skid sound per 0.3s.
      if (time - lastSkidTime < 0.3) return;
      lastSkidTime = time;
      try {
        playNoise(0.18, 'bandpass', 900, 3, 0.15);
      } catch (err) {
        // Ignore.
      }
    },
    setMuted,
    get muted() {
      return muted;
    },
  };
}
