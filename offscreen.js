'use strict';

/* Hidden audio page: loops the timer alarm until the service worker says stop.
   The tone is synthesized — no audio asset. Tone (classic / chime / bell /
   silent) and volume come from chrome.storage.local 'nixie.settings', loaded
   before the loop starts and updateable live while the alarm rings. Offscreen
   documents created for AUDIO_PLAYBACK may start playback without the
   user-gesture restrictions of a normal tab. */

const SETTINGS_KEY = 'nixie.settings';
const DEFAULT_TONE = 'classic';
const DEFAULT_VOLUME = 0.55;
const LEAD_S = 0.02;

/* Pulse/gap lengths and relative voice mixes for each synthesized tone. */
const TONES = {
  classic: {
    pulse: 0.62,
    gap: 0.38,
    voices: [
      { freq: 988, amp: 1, attack: 0.02, release: 0.05 },
      { freq: 1319, amp: 0.35, attack: 0.02, release: 0.05 }
    ]
  },
  chime: {
    pulse: 1.2,
    gap: 0.5,
    voices: [784, 988, 1318].map((freq, i) => ({
      freq, offset: i * 0.22, dur: 0.7, amp: 0.45, attack: 0.06, release: 0.45
    }))
  },
  bell: {
    pulse: 1.4,
    gap: 0.6,
    voices: [
      { freq: 523, dur: 1.4, amp: 0.55, attack: 0.015, release: 1.2 },
      { freq: 659, dur: 1.4, amp: 0.32, attack: 0.015, release: 0.95 },
      { freq: 784, dur: 1.4, amp: 0.22, attack: 0.015, release: 0.75 }
    ]
  },
  silent: null
};

let ctx = null;
let loopTimer = 0;
let active = false;
let generation = 0; // invalidates a settings load that outlives START_BEEP
let settingsRev = 0; // lets a live settings change beat a stale load
let tone = DEFAULT_TONE;
let volume = DEFAULT_VOLUME;

function normalizeVolume(value) {
  if (value == null || value === '') return DEFAULT_VOLUME;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

function parseSettings(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const name = data.alarmTone;
  return {
    tone: name === 'chime' || name === 'bell' || name === 'silent' ? name : DEFAULT_TONE,
    volume: normalizeVolume(data.alarmVolume)
  };
}

async function loadSettings() {
  try {
    if (!chrome.storage || !chrome.storage.local) return parseSettings(null);
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return parseSettings(data && data[SETTINGS_KEY]);
  } catch {
    return parseSettings(null); // settings are best-effort; ring with defaults
  }
}

function ensureCtx() {
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch {
      ctx = null;
      return null;
    }
  }
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const resuming = ctx.resume();
      if (resuming && typeof resuming.catch === 'function') resuming.catch(() => {});
    }
  } catch { /* resume is best-effort */ }
  return ctx;
}

function peakGain() {
  const peak = 0.6 * volume;
  return Math.min(0.7, Math.max(0.0001, peak));
}

/* One enveloped oscillator feeding a pulse's master gain. */
function voice(spec, at, pulse, out, done) {
  const startAt = at + (spec.offset || 0);
  const dur = spec.dur || pulse;
  const stopAt = startAt + dur;
  const peak = Math.max(0.0001, Math.min(1, spec.amp));
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(spec.freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + spec.attack);
  const decayAt = Math.max(startAt + spec.attack + 0.001, stopAt - spec.release);
  gain.gain.setValueAtTime(peak, decayAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
  osc.connect(gain);
  gain.connect(out);

  let cleaned = false;
  const clean = () => {
    if (cleaned) return;
    cleaned = true;
    try { osc.disconnect(); } catch { /* already detached */ }
    try { gain.disconnect(); } catch { /* already detached */ }
    done();
  };
  osc.onended = clean;
  try {
    osc.start(startAt);
    osc.stop(stopAt + 0.02);
  } catch {
    clean();
  }
}

/* Master gain carries the volume peak; voices are mixed relative to it. */
function playPulse(recipe, peak) {
  const at = ctx.currentTime + LEAD_S;
  const out = ctx.createGain();
  out.gain.value = peak;
  out.connect(ctx.destination);

  let pending = recipe.voices.length;
  const finished = () => {
    pending -= 1;
    if (pending > 0) return;
    try { out.disconnect(); } catch { /* already detached */ }
  };
  for (const spec of recipe.voices) voice(spec, at, recipe.pulse, out, finished);
}

function scheduleNext(delayMs) {
  clearTimeout(loopTimer);
  loopTimer = setTimeout(tick, Math.max(0, delayMs));
}

function tick() {
  loopTimer = 0;
  if (!active) return;
  const recipe = TONES[tone];
  if (!recipe) return; // silent: stay active, schedule nothing
  if (!ensureCtx()) return;
  try {
    playPulse(recipe, peakGain());
  } catch { /* keep the loop alive even if one pulse fails */ }
  scheduleNext((recipe.pulse + recipe.gap) * 1000);
}

async function start() {
  const token = ++generation;
  const rev = settingsRev;
  active = true;
  clearTimeout(loopTimer);
  loopTimer = 0;

  const loaded = await loadSettings();
  if (token !== generation || !active) return; // STOP_BEEP won the race
  if (settingsRev === rev) {
    tone = loaded.tone;
    volume = loaded.volume;
  }
  if (!TONES[tone]) return; // silent keeps active armed for STOP_BEEP
  if (!ensureCtx()) return;
  if (!loopTimer) scheduleNext(0); // a live change may have started the loop already
}

function stop() {
  active = false;
  generation += 1;
  clearTimeout(loopTimer);
  loopTimer = 0;
}

function handleSettingsChange(change) {
  settingsRev += 1;
  const next = parseSettings(change && change.newValue);
  tone = next.tone;
  volume = next.volume;
  if (!active) return;
  if (!TONES[tone]) {
    clearTimeout(loopTimer);
    loopTimer = 0;
    return;
  }
  if (!loopTimer) {
    if (!ensureCtx()) return;
    scheduleNext(0); // audible again: restart the loop
  }
}

/* An offscreen document can outlive an extension reload with stale API
   bindings, and the page may also be opened directly for debugging. Guard
   both listeners so a missing API cannot throw during script evaluation. */
const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
const storage = typeof chrome !== 'undefined' ? chrome.storage : null;

if (runtime && runtime.onMessage) {
  runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'START_BEEP') void start();
    else if (msg.type === 'STOP_BEEP') stop();
  });
}

if (storage && storage.onChanged) {
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes) return;
    if (!Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY)) return;
    handleSettingsChange(changes[SETTINGS_KEY]);
  });
}
