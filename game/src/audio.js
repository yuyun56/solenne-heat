// Solenne Heat — sound, all of it synthesised with WebAudio. No audio files, no network:
// the engine hum, police siren, every effect and the music loop are built from oscillators,
// filtered noise and gain envelopes. One dependency-free factory, `createAudio()`; in Node
// (no AudioContext) every method quietly does nothing.
//
// Lifecycle: the context is created lazily by start(), which must be called from a user
// gesture or the browser leaves it suspended. Every other method checks for a live context
// first and silently no-ops without one. Signal chain: everything feeds one master gain ->
// destination, so muting is just the master gain at 0 and unmuting restores the level.

/** Master level when unmuted. Kept below 1 so stacked effects never clip harshly. */
const MASTER_LEVEL = 0.9;

/** Engine hum range: a low sawtooth that climbs with load, softened by a lowpass filter. */
const ENGINE_MIN_HZ = 55;
const ENGINE_MAX_HZ = 165;
const ENGINE_LEVEL = 0.07;

/** Siren wail: the carrier sweeps between these frequencies at SIREN_RATE_HZ. */
const SIREN_MIN_HZ = 650;
const SIREN_MAX_HZ = 960;
const SIREN_RATE_HZ = 0.6;
const SIREN_LEVEL = 0.035;

/** Music: eighth notes at MUSIC_BPM, eight steps per chord, lookahead scheduling (seconds). */
const MUSIC_BPM = 112;
const MUSIC_STEP_SECONDS = 60 / MUSIC_BPM / 2;
const MUSIC_STEPS_PER_CHORD = 8;
const MUSIC_LOOKAHEAD_SECONDS = 0.15;

/** Chord progression, one entry per bar: Am – F – C – G. `bass` = bass-line root; `tones` = pad/arp chord tones (Hz). */
const PROGRESSION = [
  { bass: 110.0, tones: [220.0, 261.63, 329.63] }, // Am: A2 / A3 C4 E4
  { bass: 87.31, tones: [174.61, 220.0, 261.63] }, // F:  F2 / F3 A3 C4
  { bass: 130.81, tones: [196.0, 261.63, 329.63] }, // C:  C3 / G3 C4 E4
  { bass: 98.0, tones: [196.0, 246.94, 293.66] }, //  G:  G2 / G3 B3 D4
];

/** Arp pattern over the chord tones, one index per eighth step (up, then back down). */
const ARP_PATTERN = [0, 1, 2, 1, 0, 2, 1, 2];

/** Clamp a number into 0..1; non-numbers become 0 so a bad caller can never produce NaN gain. */
function clamp01(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, n));
}

/** Create one sound engine: start, update, the one-shot effects, setMuted and `muted`. */
export function createAudio() {
  // --- Live audio graph (all null until start() succeeds) -------------------
  let ctx = null; // the AudioContext
  let master = null; // master gain -> destination; mute lives here
  let noiseBuffer = null; // one shared second of white noise, reused by every burst

  // Engine voice: sawtooth -> lowpass -> gain, created in start(), driven by update().
  let engineOsc = null;
  let engineFilter = null;
  let engineGain = null;
  // Siren voice: triangle -> gain. An LFO (oscillator -> gain -> frequency) does the wailing,
  // so the sweep stays smooth between frames and update() only gates the gain.
  let sirenOsc = null;
  let sirenGain = null;

  let mutedFlag = false;
  // Music scheduler state: next step index and when it sounds on the context clock.
  let musicStep = 0;
  let musicNextTime = 0;

  /** Build the shared white-noise buffer (1 s is plenty; bursts just play a slice of it). */
  function makeNoiseBuffer() {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Create the continuous engine and siren voices (once, from start()). Both start silent. */
  function createVoices() {
    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = ENGINE_MIN_HZ;
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 320;
    engineFilter.Q.value = 2;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engineOsc.start();

    sirenOsc = ctx.createOscillator();
    sirenOsc.type = 'triangle';
    const sirenCentre = (SIREN_MIN_HZ + SIREN_MAX_HZ) / 2;
    const sirenDepth = (SIREN_MAX_HZ - SIREN_MIN_HZ) / 2;
    sirenOsc.frequency.value = sirenCentre;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = SIREN_RATE_HZ;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = sirenDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(sirenOsc.frequency);
    sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenOsc.connect(sirenGain);
    sirenGain.connect(master);
    sirenOsc.start();
    lfo.start();
  }

  // --- Small synthesis helpers (all assume a live ctx) ------------------------

  /** One oscillator note: `freq` Hz at `when`, optional glide to `freqEnd`, quick attack, exponential decay over `duration` at peak `level`. */
  function tone({ type = 'sine', freq, freqEnd = null, when = 0, duration = 0.15, level = 0.2 }) {
    const t = Math.max(when, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** One white-noise burst through a filter at `freq` Hz, decaying over `duration` at peak `level`. The filter is what makes each effect sound different. */
  function noise({ filterType = 'bandpass', freq = 1000, q = 1, when = 0, duration = 0.1, level = 0.3 }) {
    const t = Math.max(when, ctx.currentTime);
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true; // bursts are short; looping avoids running off the buffer's end
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t, Math.random() * 0.5); // random offset so repeated bursts don't sound cloned
    source.stop(t + duration + 0.05);
  }

  // --- Music scheduler --------------------------------------------------------

  /**
   * Schedule one music step (an eighth note) at time `t`. Step 0 of each bar lays down the
   * bass root and the soft pad chord; every step adds a quiet arp note an octave above the
   * chord tones; the bar's midpoint gets a bass fifth. Levels stay tiny — under the game.
   */
  function scheduleStep(step, t) {
    const chord = PROGRESSION[Math.floor(step / MUSIC_STEPS_PER_CHORD) % PROGRESSION.length];
    const stepInChord = step % MUSIC_STEPS_PER_CHORD;
    const barSeconds = MUSIC_STEP_SECONDS * MUSIC_STEPS_PER_CHORD;

    if (stepInChord === 0) {
      // Bass root, held for most of the bar.
      tone({ type: 'sine', freq: chord.bass, when: t, duration: barSeconds * 0.9, level: 0.05 });
      // Pad: the three chord tones as slow, soft triangles.
      for (const freq of chord.tones) {
        tone({ type: 'triangle', freq, when: t, duration: barSeconds, level: 0.012 });
      }
    }
    if (stepInChord === 4) {
      // Bass fifth (root x 1.5) halfway through the bar.
      tone({ type: 'sine', freq: chord.bass * 1.5, when: t, duration: barSeconds * 0.4, level: 0.04 });
    }
    // Arp: one chord tone an octave up, short and quiet.
    const arpFreq = chord.tones[ARP_PATTERN[stepInChord]] * 2;
    tone({ type: 'triangle', freq: arpFreq, when: t, duration: MUSIC_STEP_SECONDS * 0.9, level: 0.016 });
  }

  /**
   * Advance the music scheduler: schedule every step inside the lookahead window. While
   * muted nothing is scheduled and the next-step time is pushed forward, so unmuting resumes
   * cleanly instead of bursting the missed steps.
   */
  function scheduleMusic() {
    if (mutedFlag) {
      musicNextTime = Math.max(musicNextTime, ctx.currentTime + MUSIC_STEP_SECONDS);
      return;
    }
    // If the clock has run far past the next step (tab was hidden, first call, ...), resync
    // to just ahead of now rather than scheduling a backlog of stale notes.
    if (musicNextTime < ctx.currentTime - MUSIC_STEP_SECONDS) {
      musicNextTime = ctx.currentTime + 0.02;
    }
    while (musicNextTime < ctx.currentTime + MUSIC_LOOKAHEAD_SECONDS) {
      scheduleStep(musicStep, musicNextTime);
      musicStep += 1;
      musicNextTime += MUSIC_STEP_SECONDS;
    }
  }

  // --- Public API ---------------------------------------------------------------

  return {
    /** Whether everything is currently muted (read-only view of the internal flag). */
    get muted() {
      return mutedFlag;
    },

    /**
     * Create (first call) or resume the AudioContext and build the graph. Call it from a
     * user-gesture handler; safe to call repeatedly (later calls only resume). With no
     * WebAudio available it leaves the context null and everything else stays a no-op.
     */
    start() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        return;
      }
      const AudioCtor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;
      if (!AudioCtor) return;
      ctx = new AudioCtor();
      master = ctx.createGain();
      master.gain.value = mutedFlag ? 0 : MASTER_LEVEL;
      master.connect(ctx.destination);
      noiseBuffer = makeNoiseBuffer();
      createVoices();
      musicStep = 0;
      musicNextTime = ctx.currentTime + 0.05;
      if (ctx.state === 'suspended') ctx.resume();
    },

    /**
     * Per-frame driver. `opts` = { engineOn, engineLoad (0..1), sirenOn }. Steers the engine
     * and siren with short ramps (no zipper noise) and advances the music scheduler. `dt` is
     * accepted for the caller; the voices run off the context clock, steadier than frames.
     */
    update(dt, opts = {}) {
      if (!ctx) return;
      const now = ctx.currentTime;
      const ramp = 0.08; // seconds; short enough to feel responsive, long enough to be smooth

      const load = clamp01(opts.engineLoad);
      if (opts.engineOn) {
        const hz = ENGINE_MIN_HZ + (ENGINE_MAX_HZ - ENGINE_MIN_HZ) * load;
        engineOsc.frequency.setTargetAtTime(hz, now, ramp / 3);
        engineFilter.frequency.setTargetAtTime(280 + 900 * load, now, ramp / 3);
        engineGain.gain.setTargetAtTime(ENGINE_LEVEL + 0.03 * load, now, ramp / 3);
      } else {
        engineGain.gain.setTargetAtTime(0, now, ramp / 3);
      }

      sirenGain.gain.setTargetAtTime(opts.sirenOn ? SIREN_LEVEL : 0, now, ramp / 3);

      scheduleMusic();
    },

    /** Pistol gunshot: a sharp bandpassed noise crack over a quick low sine thump. ~0.15 s. */
    shot() {
      if (!ctx) return;
      noise({ filterType: 'bandpass', freq: 1800, q: 0.7, duration: 0.12, level: 0.5 });
      tone({ type: 'sine', freq: 160, freqEnd: 42, duration: 0.15, level: 0.55 });
    },

    /** Melee swing/hit: a dull, low thud — filtered noise kept well down in frequency. */
    melee() {
      if (!ctx) return;
      noise({ filterType: 'lowpass', freq: 420, duration: 0.13, level: 0.45 });
      tone({ type: 'sine', freq: 95, freqEnd: 50, duration: 0.12, level: 0.3 });
    },

    /** Vehicle impact crunch; `strength` (0..1) scales gain and brightness. */
    hit(strength = 0.5) {
      if (!ctx) return;
      const s = clamp01(strength);
      noise({ filterType: 'lowpass', freq: 500 + 900 * s, duration: 0.18 + 0.1 * s, level: 0.15 + 0.5 * s });
      tone({ type: 'sine', freq: 80, freqEnd: 34, duration: 0.22, level: 0.2 + 0.45 * s });
    },

    /** Player takes damage: a short descending blip, unmistakably "that hurt". */
    hurt() {
      if (!ctx) return;
      tone({ type: 'square', freq: 320, freqEnd: 110, duration: 0.18, level: 0.16 });
    },

    /** Pickup: a bright two-note coin blip (up a fifth, quick). */
    pickup() {
      if (!ctx) return;
      const now = ctx.currentTime;
      tone({ type: 'triangle', freq: 880, when: now, duration: 0.07, level: 0.22 });
      tone({ type: 'triangle', freq: 1318.5, when: now + 0.07, duration: 0.14, level: 0.22 });
    },

    /** Cash: a paper-ish rustle — two quick high filtered noise ticks, close together. */
    cash() {
      if (!ctx) return;
      const now = ctx.currentTime;
      noise({ filterType: 'bandpass', freq: 3200, q: 0.8, when: now, duration: 0.035, level: 0.28 });
      noise({ filterType: 'bandpass', freq: 2600, q: 0.8, when: now + 0.055, duration: 0.05, level: 0.24 });
    },

    /**
     * Mission jingle. `win` true: a rising four-note major arpeggio (C5 E5 G5 C6) on a warm
     * triangle. `win` false: a descending three-note minor phrase that trails off.
     */
    jingle(win) {
      if (!ctx) return;
      const now = ctx.currentTime;
      const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [329.63, 261.63, 220.0];
      notes.forEach((freq, i) => {
        tone({
          type: 'triangle',
          freq,
          when: now + i * 0.11,
          duration: i === notes.length - 1 ? 0.34 : 0.16,
          level: 0.24,
        });
      });
    },

    /** UI click: one tiny high tick. */
    click() {
      if (!ctx) return;
      tone({ type: 'square', freq: 1050, duration: 0.035, level: 0.12 });
      noise({ filterType: 'highpass', freq: 4000, duration: 0.02, level: 0.08 });
    },

    /**
     * Mute/unmute everything via the master gain (short ramp, so no click). Works before
     * start() too: the flag is remembered and applied when the graph is built.
     */
    setMuted(m) {
      mutedFlag = Boolean(m);
      if (!ctx || !master) return;
      master.gain.setTargetAtTime(mutedFlag ? 0 : MASTER_LEVEL, ctx.currentTime, 0.02);
    },
  };
}
