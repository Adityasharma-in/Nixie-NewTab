'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const CORE = window.NixieCore;

/* ---------- environment ---------- */

const EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
const SETTINGS_KEY = 'nixie.settings';
const EVENTS_KEY = 'nixie.events';

const readKey = async (key) => {
  try {
    if (EXT) {
      const data = await chrome.storage.local.get(key);
      return data[key] == null ? null : data[key];
    }
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch { return null; }
};

const writeKey = async (key, value) => {
  try {
    if (EXT) await chrome.storage.local.set({ [key]: value });
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
};

const removeKey = async (key) => {
  try {
    if (EXT) await chrome.storage.local.remove(key);
    else localStorage.removeItem(key);
  } catch { /* best-effort */ }
};

let settings = CORE.normalizeSettings(null);
let countdowns = [];

// Chrome historically stores favorites under the bare `sites` key; the
// file:// fallback uses the namespaced key. Keep both paths consistent.
const SITES_KEY = EXT ? 'sites' : 'nixie.sites';

const store = {
  async get() {
    if (EXT) {
      const data = await chrome.storage.local.get(SITES_KEY);
      return data[SITES_KEY] || null;
    }
    try { return JSON.parse(localStorage.getItem(SITES_KEY) || 'null'); }
    catch { return null; }
  },
  async set(sites) {
    await writeKey(SITES_KEY, sites);
  }
};

const DEFAULT_SITES = [
  { name: 'YouTube', url: 'https://www.youtube.com' },
  { name: 'GitHub', url: 'https://github.com' },
  { name: 'Gmail', url: 'https://mail.google.com' },
  { name: 'X', url: 'https://x.com' },
  { name: 'Reddit', url: 'https://www.reddit.com' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org' }
];

/* ---------- settings ---------- */

let settingsWriteTimer = 0;

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle('dim', settings.dim);
  applyClockVisibility();
  lastTubeSec = -1;
  updateSearchAffordance();
}

function persistSettings() {
  clearTimeout(settingsWriteTimer);
  settingsWriteTimer = 0;
  void writeKey(SETTINGS_KEY, { ...settings }).then((ok) => {
    if (!ok) setCalStatus('COULD NOT SAVE SETTINGS', 'error');
  });
}

function queueSettingsWrite() {
  clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = 0;
    void writeKey(SETTINGS_KEY, { ...settings });
  }, 180);
}

function updateSettings(patch, { persist = true, note = '' } = {}) {
  const next = CORE.normalizeSettings({ ...settings, ...patch });
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  applySettings();
  if (persist && changed) persistSettings();
  if (note) setCalStatus(note, 'ok');
  return changed;
}

async function loadSettings() {
  const raw = await readKey(SETTINGS_KEY);
  settings = CORE.normalizeSettings(raw);
  applySettings();
  syncCalibration();
}

function initSettingsSync() {
  const adopt = (raw) => {
    const incoming = CORE.normalizeSettings(raw);
    if (JSON.stringify(incoming) === JSON.stringify(settings)) return;
    settings = incoming;
    applySettings();
    syncCalibration();
    setCalStatus('SETTINGS SYNCED FROM ANOTHER TAB');
  };

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      adopt(changes[SETTINGS_KEY].newValue);
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== SETTINGS_KEY) return;
      try { adopt(JSON.parse(e.newValue || 'null')); } catch { /* malformed cross-tab value */ }
    });
  }
}

function initSitesSync() {
  const adopt = (raw) => {
    if (!Array.isArray(raw)) return;
    const incoming = CORE.normalizeSites(raw);
    if (JSON.stringify(incoming) === JSON.stringify(sites)) return;
    sites = incoming;
    renderKeys();
  };

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SITES_KEY]) return;
      adopt(changes[SITES_KEY].newValue);
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== SITES_KEY) return;
      try { adopt(JSON.parse(e.newValue || 'null')); } catch { /* malformed cross-tab value */ }
    });
  }
}

/* ---------- clock ---------- */

const tubeBank = $('#tubeBank');
const tubes = [];

function buildClock() {
  const groups = [['HOURS', 2, 'hours'], ['MINUTES', 2, 'minutes'], ['SECONDS', 2, 'seconds']];
  groups.forEach(([label, count, unit], gi) => {
    if (gi > 0) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      sep.dataset.before = unit;
      sep.setAttribute('aria-hidden', 'true');
      sep.innerHTML = '<i></i><i></i>';
      tubeBank.appendChild(sep);
    }
    const group = document.createElement('div');
    group.className = 'tube-group';
    group.dataset.unit = unit;
    const pair = document.createElement('div');
    pair.className = 'pair';
    for (let i = 0; i < count; i++) {
      const tube = document.createElement('div');
      tube.className = 'tube';
      tube.innerHTML =
        '<div class="glass"><div class="mesh"></div>' +
        '<div class="digit-stack"><span class="digit prev"></span><span class="digit now"></span></div>' +
        '<div class="glass-sheen"></div></div><div class="collar"></div>';
      pair.appendChild(tube);
      tubes.push(tube);
    }
    const cap = document.createElement('div');
    cap.className = 'group-label';
    cap.textContent = label;
    group.append(pair, cap);
    tubeBank.appendChild(group);
  });

  const meridiem = document.createElement('div');
  meridiem.className = 'meridiem';
  meridiem.setAttribute('aria-label', 'Day period');
  meridiem.innerHTML = '<span data-m="AM">AM</span><span data-m="PM">PM</span>';
  tubeBank.appendChild(meridiem);
}

function applyClockVisibility() {
  const clock = tubeMode === 'clock';
  const showSeconds = clock ? settings.showSeconds : true;
  const showMeridiem = clock && !settings.clock24;
  const secondsGroup = tubeBank.querySelector('.tube-group[data-unit="seconds"]');
  const secondsSep = tubeBank.querySelector('.sep[data-before="seconds"]');
  const meridiem = tubeBank.querySelector('.meridiem');
  if (secondsGroup) secondsGroup.hidden = !showSeconds;
  if (secondsSep) secondsSep.hidden = !showSeconds;
  if (meridiem) meridiem.hidden = !showMeridiem;
}

const pad2 = (n) => String(n).padStart(2, '0');

const clampInt = (value, max) => {
  const n = parseInt(String(value).replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(Math.max(n, 0), max);
};

function setDigit(stack, value) {
  const now = $('.digit.now', stack);
  const prev = $('.digit.prev', stack);
  if (now.textContent === value) return;
  prev.textContent = now.textContent;
  now.textContent = value;
  stack.classList.remove('tick');
  void stack.offsetWidth;
  stack.classList.add('tick');
}

const sepEls = () => [...tubeBank.querySelectorAll('.sep')];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let lastTubeSec = -1;

function renderClockDigits() {
  const d = new Date();
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const parts = settings.clock24
    ? [pad2(h24), pad2(d.getMinutes()), pad2(d.getSeconds())]
    : [
      h12 < 10 ? ' ' : '1',
      h12 < 10 ? String(h12) : String(h12 % 10),
      pad2(d.getMinutes()),
      pad2(d.getSeconds())
    ];
  const digits = parts.join('');
  digits.split('').forEach((ch, i) => {
    const stack = $('.digit-stack', tubes[i]);
    setDigit(stack, ch === ' ' ? '' : ch);
  });
  tubeBank.querySelectorAll('.meridiem span').forEach((s) => {
    s.classList.toggle('lit', !settings.clock24 && s.dataset.m === meridiem);
  });
  return settings.showSeconds ? d.getSeconds() : d.getMinutes();
}

function renderTimerDigits(totalSec) {
  const clamped = Math.max(0, Math.round(totalSec));
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = clamped % 60;
  const digits = pad2(hh) + pad2(mm) + pad2(ss);
  digits.split('').forEach((ch, i) => {
    const stack = $('.digit-stack', tubes[i]);
    setDigit(stack, ch);
  });
  tubeBank.querySelectorAll('.meridiem span').forEach((s) => s.classList.remove('lit'));
  return ss + mm * 60 + hh * 3600;
}

function beatSeparators() {
  if (reduceMotion.matches) return;
  sepEls().forEach((sep) => {
    sep.classList.remove('beat');
    void sep.offsetWidth;
    sep.classList.add('beat');
  });
}

let lastDayKey = '';

function tick() {
  const dayKey = CORE.dateKeyLocal(new Date());
  if (dayKey !== lastDayKey) {
    lastDayKey = dayKey;
    renderDate();
    lastCountdownKey = '';
  }
  const now = Date.now();
  ['timer', 'focus'].forEach((key) => {
    const eng = timers[key];
    if (eng.running) {
      const left = Math.max(0, Math.round((eng.endAt - now) / 1000));
      eng.remaining = left;
      if (left <= 0) finishEngine(key);
      else if (tubeMode === key) updateTimerReadout();
    }
  });
  let tubeSec = 0;
  if (tubeMode === 'clock') tubeSec = renderClockDigits();
  else tubeSec = renderTimerDigits(timers[tubeMode].remaining);
  if (tubeSec !== lastTubeSec) {
    lastTubeSec = tubeSec;
    beatSeparators();
  }
  renderCountdown();
  if (calDialog && calDialog.open) refreshEventListStatus();
  updateIndicators();
}

function startClock() {
  tubes.forEach((tube, i) => {
    $('.glass', tube).classList.add('ignite');
    $('.glass', tube).style.animationDelay = `${120 + i * 85}ms`;
  });
  lastTubeSec = -1;
  tick();
  setInterval(tick, 200);
}

/* ---------- tube modes + timers (independent engines) ---------- */

let tubeMode = 'clock';
const FOCUS_SECONDS = 25 * 60;

const makeEngine = (total) => ({ total, remaining: total, endAt: 0, running: false, finished: false, updatedAt: 0 });
const timers = { timer: makeEngine(5 * 60), focus: makeEngine(FOCUS_SECONDS) };
const activeEngine = () => (tubeMode === 'clock' ? null : timers[tubeMode]);

const TIMER_STORE_KEY = 'nixie.timers';

function serializeEngine(eng) {
  const remaining = eng.running
    ? Math.max(0, Math.round((eng.endAt - Date.now()) / 1000))
    : Math.max(0, Math.round(eng.remaining));
  return {
    total: eng.total,
    remaining,
    endAt: eng.running ? eng.endAt : 0,
    running: eng.running,
    finished: eng.finished,
    updatedAt: eng.updatedAt || 0
  };
}

async function persistTimers() {
  try {
    const payload = { timer: serializeEngine(timers.timer), focus: serializeEngine(timers.focus) };
    if (EXT) await chrome.storage.local.set({ [TIMER_STORE_KEY]: payload });
    else localStorage.setItem(TIMER_STORE_KEY, JSON.stringify(payload));
  } catch { /* persistence is best-effort */ }
}

async function restoreTimers() {
  try {
    let saved = null;
    if (EXT) {
      const data = await chrome.storage.local.get(TIMER_STORE_KEY);
      saved = data[TIMER_STORE_KEY] || null;
    } else {
      saved = JSON.parse(localStorage.getItem(TIMER_STORE_KEY) || 'null');
    }
    if (!saved) return;
    const now = Date.now();
    ['timer', 'focus'].forEach((key) => {
      const s = saved[key];
      if (!s || typeof s !== 'object') return;
      const eng = timers[key];
      eng.updatedAt = Number.isFinite(+s.updatedAt) ? +s.updatedAt : 0;
      if (Number.isFinite(+s.total) && +s.total >= 0) eng.total = Math.min(Math.round(+s.total), key === 'focus' ? FOCUS_SECONDS : 99 * 3600 + 59 * 60 + 59);
      if (key === 'focus') eng.total = FOCUS_SECONDS;
      if (s.finished) {
        eng.running = false;
        eng.finished = true;
        eng.remaining = 0;
      } else if (s.running && Number.isFinite(+s.endAt) && +s.endAt > 0) {
        eng.endAt = Math.round(+s.endAt);
        eng.remaining = Math.max(0, Math.round((eng.endAt - now) / 1000));
        if (eng.remaining <= 0) {
          // A timer that expired while no tab was open must stay complete,
          // not resurrect as a paused full-duration timer.
          eng.running = false;
          eng.finished = true;
          eng.remaining = 0;
        } else {
          eng.running = true;
          eng.finished = false;
        }
      } else if (Number.isFinite(+s.remaining) && +s.remaining > 0) {
        eng.running = false;
        eng.finished = false;
        eng.remaining = Math.min(Math.round(+s.remaining), eng.total);
      }
    });
    void persistTimers();
  } catch { /* corrupted state starts fresh */ }
}

function adoptTimerPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const now = Date.now();
  let changed = false;

  ['timer', 'focus'].forEach((key) => {
    const saved = payload[key];
    if (!saved || typeof saved !== 'object') return;
    const eng = timers[key];
    const stamp = Number.isFinite(+saved.updatedAt) ? +saved.updatedAt : 0;
    if (stamp <= (eng.updatedAt || 0)) return;

    if (saved.finished) {
      eng.running = false;
      eng.finished = true;
      eng.remaining = 0;
      eng.endAt = 0;
    } else if (saved.running && Number.isFinite(+saved.endAt) && +saved.endAt > now) {
      eng.running = true;
      eng.finished = false;
      eng.endAt = Math.round(+saved.endAt);
      eng.remaining = Math.max(0, Math.round((eng.endAt - now) / 1000));
      if (Number.isFinite(+saved.total) && +saved.total > 0) {
        eng.total = Math.min(Math.round(+saved.total), key === 'focus' ? FOCUS_SECONDS : 99 * 3600 + 59 * 60 + 59);
      }
    } else {
      eng.running = false;
      eng.finished = false;
      eng.endAt = 0;
      if (Number.isFinite(+saved.remaining) && +saved.remaining > 0) {
        eng.remaining = Math.min(Math.round(+saved.remaining), eng.total);
      }
    }
    eng.updatedAt = stamp;
    changed = true;
  });

  if (changed) {
    const eng = activeEngine();
    if (eng) {
      setInputsDisabled(eng.running);
      renderTimerDigits(eng.remaining);
      updateTimerReadout();
    }
    lastTubeSec = -1;
    updateIndicators();
  }
  return changed;
}

function initTimersSync() {
  const adopt = (payload) => { adoptTimerPayload(payload); };

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[TIMER_STORE_KEY]) return;
      adopt(changes[TIMER_STORE_KEY].newValue);
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== TIMER_STORE_KEY) return;
      try { adopt(JSON.parse(e.newValue || 'null')); } catch { /* malformed cross-tab value */ }
    });
  }
}

let audioCtx = null;

const modeBtns = () => [...document.querySelectorAll('.mode-btn')];
const timerPanel = $('#timerPanel');
const timerInputs = $('#timerInputs');
const focusPreset = $('#focusPreset');
const inH = $('#inH');
const inM = $('#inM');
const inS = $('#inS');
const timerToggle = $('#timerToggle');
const timerReset = $('#timerReset');
const timerReadout = $('#timerReadout');
const countEls = { timer: $('#countTimer'), focus: $('#countFocus') };

/* ---------- persistent alarm bridge ---------- */
// In the extension the service worker owns wall-clock expiry (chrome.alarms)
// and loops the tone via an offscreen document, so the alarm rings even with
// no new tab open. This page arms/disarms on start/pause/reset and renders the
// SILENCE strip while ringing. Outside the extension (plain file:// testing)
// a page-local beep loop stands in for the worker.

const SW = EXT && chrome.runtime && chrome.runtime.sendMessage ? true : false;

let alarmState = { ringing: false };
let alarmConfirmed = false; // true once the worker confirms it owns the ring
let localBeepTimer = 0;
let titleFlashTimer = 0;

function stopTitleFlash() {
  clearInterval(titleFlashTimer);
  titleFlashTimer = 0;
}

function startTitleFlash() {
  if (titleFlashTimer) return;
  let on = false;
  titleFlashTimer = setInterval(() => {
    on = !on;
    const audible = settings.alarmTone !== 'silent' && !alarmState.capped;
    document.title = on
      ? `🔔 SILENCE THE ALARM — Nixie`
      : audible ? `ALARM — SOUNDING — Nixie` : `ALARM ACTIVE — Nixie`;
  }, 1000);
}

const alarmStrip = $('#alarmStrip');
const alarmText = $('#alarmText');
const alarmSilenceBtn = $('#alarmSilence');

function sendAlarmMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch { resolve(null); }
  });
}

/* Mirrors the offscreen recipes so file:// testing and the TEST TONE button
   sound exactly like the worker-owned alarm. */
const ALARM_TONES = {
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

function alarmPeakGain() {
  return Math.min(0.7, Math.max(0.0001, 0.6 * settings.alarmVolume));
}

function playTonePulse(toneId = settings.alarmTone) {
  const recipe = ALARM_TONES[toneId];
  if (!recipe) return false;
  try {
    ensureAudio();
    if (!audioCtx) return false;
    const at = audioCtx.currentTime + 0.02;
    const out = audioCtx.createGain();
    out.gain.value = alarmPeakGain();
    out.connect(audioCtx.destination);

    let pending = recipe.voices.length;
    const finished = () => {
      pending -= 1;
      if (pending > 0) return;
      try { out.disconnect(); } catch { /* already detached */ }
    };

    recipe.voices.forEach((spec) => {
      const startAt = at + (spec.offset || 0);
      const dur = spec.dur || recipe.pulse;
      const stopAt = startAt + dur;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const peak = Math.max(0.0001, Math.min(1, spec.amp));

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
        finished();
      };
      osc.onended = clean;
      try {
        osc.start(startAt);
        osc.stop(stopAt + 0.02);
      } catch {
        clean();
      }
    });
    return true;
  } catch { return false; }
}

function playAlarmPulse() {
  // One pulse of the selected tone; the loop (worker or local) repeats it.
  playTonePulse(settings.alarmTone);
}

function localLoopMs() {
  const recipe = ALARM_TONES[settings.alarmTone];
  return recipe ? Math.max(320, (recipe.pulse + recipe.gap) * 1000) : 0;
}

function startLocalBeep(force = false) {
  if ((SW && !force) || localBeepTimer) return;
  if (!ALARM_TONES[settings.alarmTone]) return; // silent stays visual-only
  playAlarmPulse();
  clearInterval(localBeepTimer);
  localBeepTimer = setInterval(playAlarmPulse, localLoopMs());
}

function restartLocalBeep() {
  if (!alarmState.ringing) return;
  if (SW && alarmConfirmed) return; // the worker owns the audible loop
  stopLocalBeep();
  startLocalBeep(true);
}

function stopLocalBeep() {
  clearInterval(localBeepTimer);
  localBeepTimer = 0;
}

/* source: 'worker' (push broadcast), 'sync' (GET_ALARM_STATE reply), else local. */
function dismissOverlaysForAlarm() {
  const panel = document.getElementById('servicePanel');
  if (panel && panel.classList.contains('open')) togglePanel(false);
  const cal = document.getElementById('calibrationDialog');
  if (cal && cal.open) closeCalibration();
  const con = document.getElementById('consoleDialog');
  if (con && con.open) closeConsole();
}

function applyAlarmState(state, source = 'local') {
  const wasRinging = alarmState.ringing;
  const ringing = !!(state && state.ringing);
  if (source === 'sync') {
    if (ringing) {
      alarmConfirmed = true;
    } else if (!alarmConfirmed) {
      // The worker hasn't fired for our just-finished timer yet — keep the
      // optimistic ring; its broadcast is on its way.
      return;
    } else {
      alarmConfirmed = false;
    }
  } else if (source === 'worker') {
    alarmConfirmed = ringing;
    // The worker's ring takes over — kill any local fallback loop.
    if (ringing) stopLocalBeep();
  } else if (!ringing) {
    alarmConfirmed = false;
  }
  alarmState = ringing
    ? { ringing: true, key: state.key || null, label: state.label || 'TIMER', capped: !!state.capped }
    : { ringing: false };
  if (!ringing) {
    stopLocalBeep();
    stopTitleFlash();
  }
  alarmStrip.hidden = !ringing;
  if (ringing) {
    startTitleFlash();
    const silent = settings.alarmTone === 'silent';
    alarmText.textContent = alarmState.capped
      ? `${alarmState.label} COMPLETE — AUTO-MUTED, STILL ACTIVE — SILENCE TO CLEAR`
      : silent
        ? `${alarmState.label} COMPLETE — ALARM ACTIVE — SILENCE TO CLEAR`
        : `${alarmState.label} COMPLETE — SOUNDING — SILENCE TO STOP`;
  }
  updateTimerReadout();
  updateIndicators();
  if (ringing && !wasRinging) {
    dismissOverlaysForAlarm();
    alarmSilenceBtn.focus({ preventScroll: true });
  }
}

async function silenceAlarm() {
  stopLocalBeep();
  if (SW) await sendAlarmMsg({ type: 'SILENCE_ALARM' });
  applyAlarmState({ ringing: false });
  updateTitle(); // cleared state stops the flasher; repaint the normal title now
}

if (SW) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ALARM_STATE' || !msg.state) return;
    if (msg.state.ringing && msg.state.key && timers[msg.state.key]) {
      const eng = timers[msg.state.key];
      eng.running = false;
      eng.remaining = 0;
      eng.finished = true;
      if (tubeMode === msg.state.key) {
        setInputsDisabled(false);
        renderTimerDigits(0);
      }
    }
    applyAlarmState(msg.state, 'worker');
  });
}

alarmSilenceBtn.addEventListener('click', () => { void silenceAlarm(); });

function fmtHMS(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function updateTitle() {
  if (alarmState.ringing) return; // the title flasher owns the title while ringing
  const eng = activeEngine();
  if (tubeMode === 'clock') {
    const other = runningEngineKey();
    document.title = other ? `${fmtHMS(timers[other].remaining)} — BG — Nixie` : 'New Tab';
    return;
  }
  if (!eng) { document.title = 'New Tab'; return; }
  if (eng.finished) { document.title = 'COMPLETE — Nixie Timer'; return; }
  document.title = eng.running
    ? `${fmtHMS(eng.remaining)} — Nixie Timer`
    : 'Nixie Timer — New Tab';
}

function runningEngineKey() {
  return ['timer', 'focus'].find((key) => timers[key].running) || null;
}

/* ---------- honest status chip ---------- */

const statusChip = $('#statusChip');
const statusLed = $('#statusLed');
const statusText = $('#statusText');
const statusAnnounce = $('#statusAnnounce');
let batteryState = null;
let lastStatusLabel = '';
let lastStatusMode = '';

function statusLabel() {
  const parts = [];
  parts.push(navigator.onLine === false ? 'OFFLINE' : 'ONLINE');
  if (batteryState) {
    const pct = Math.round((batteryState.level || 0) * 100);
    parts.push(batteryState.charging ? `CHG ${pct}%` : `${pct}%`);
  }
  if (alarmState.ringing) {
    parts.push('ALARM');
  } else {
    const running = runningEngineKey();
    if (running) {
      parts.push(`${running === 'focus' ? 'FOCUS' : 'TMR'} ${fmtHMS(timers[running].remaining)}`);
    } else {
      const done = ['timer', 'focus'].find((key) => timers[key].finished);
      if (done) parts.push('TIMER DONE');
    }
  }
  return parts.join(' \u00B7 ');
}

function updateStatusChip() {
  if (!statusChip || !statusText || !statusLed) return;
  const label = statusLabel();
  if (label !== lastStatusLabel) {
    statusText.textContent = label;
    statusChip.title = label;
    lastStatusLabel = label;
  }
  const offline = navigator.onLine === false;
  statusLed.classList.toggle('is-offline', offline);
  statusLed.classList.toggle('is-charging', !offline && !!(batteryState && batteryState.charging));
  statusLed.classList.toggle('is-alert', alarmState.ringing);
  statusChip.classList.toggle('is-offline', offline);
  statusChip.classList.toggle('is-alert', alarmState.ringing);

  const done = !alarmState.ringing && ['timer', 'focus'].some((key) => timers[key].finished);
  const mode = offline ? 'offline' : alarmState.ringing ? 'alarm' : done ? 'done' : 'online';
  if (statusAnnounce && mode !== lastStatusMode) {
    lastStatusMode = mode;
    statusAnnounce.textContent = label;
  }
}

async function initBatteryStatus() {
  if (!navigator.getBattery) return;
  try {
    batteryState = await navigator.getBattery();
    batteryState.addEventListener('levelchange', updateStatusChip);
    batteryState.addEventListener('chargingchange', updateStatusChip);
    updateStatusChip();
  } catch { /* battery telemetry is optional */ }
}

window.addEventListener('online', updateStatusChip);
window.addEventListener('offline', updateStatusChip);

function updateIndicators() {
  ['timer', 'focus'].forEach((key) => {
    const eng = timers[key];
    const btn = document.querySelector(`.mode-btn[data-mode="${key}"]`);
    const count = countEls[key];
    if (btn) {
      btn.classList.toggle('is-live', eng.running && key !== tubeMode);
      btn.classList.toggle('is-done', eng.finished && key !== tubeMode);
      btn.setAttribute('aria-label', eng.running && key !== tubeMode
        ? `${labelFor(key)} running in background, ${fmtHMS(eng.remaining)} left. Activate to return.`
        : eng.finished && key !== tubeMode
          ? `${labelFor(key)} finished. Activate to view.`
          : labelFor(key));
    }
    if (count) {
      count.hidden = key === tubeMode || (!eng.running && !eng.finished);
      if (eng.running) count.textContent = fmtHMS(eng.remaining);
      else if (eng.finished) count.textContent = 'DONE';
    }
  });
  updateStatusChip();
  updateTitle();
}

function labelFor(key) {
  return key === 'focus' ? 'FOCUS 25' : 'TIMER';
}

function updateTimerReadout() {
  const eng = activeEngine();
  if (!eng) return;
  if (alarmState.ringing) {
    const muted = alarmState.capped || settings.alarmTone === 'silent';
    timerReadout.textContent = muted ? 'ALARM ACTIVE — SILENCE TO CLEAR' : 'SOUNDING — SILENCE TO STOP';
    timerToggle.textContent = 'SILENCE';
    return;
  }
  if (eng.finished) {
    timerReadout.textContent = 'COMPLETE';
    timerToggle.textContent = 'RESTART';
    return;
  }
  if (eng.running) {
    timerReadout.textContent = `RUNNING ${fmtHMS(eng.remaining)}`;
    timerToggle.textContent = 'PAUSE';
  } else {
    timerReadout.textContent = eng.remaining === eng.total
      ? `READY ${fmtHMS(eng.total)}`
      : `PAUSED ${fmtHMS(eng.remaining)}`;
    timerToggle.textContent = eng.remaining === eng.total ? 'START' : 'RESUME';
  }
}

function readInputsToTotal() {
  const h = clampInt(inH.value, 99);
  const m = clampInt(inM.value, 59);
  const s = clampInt(inS.value, 59);
  inH.value = pad2(h);
  inM.value = pad2(m);
  inS.value = pad2(s);
  return h * 3600 + m * 60 + s;
}

function setInputsDisabled(disabled) {
  [inH, inM, inS].forEach((el) => { el.disabled = disabled; });
}

function ensureAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* audio is best-effort */ }
}

function playCompleteTone() {
  try {
    if (!audioCtx || !settings.alarmVolume || settings.alarmTone === 'silent') return;
    const t0 = audioCtx.currentTime;
    const level = Math.max(0.02, 0.3 * settings.alarmVolume);
    [0, 0.22, 0.44].forEach((offset, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 2 ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(level, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.22);
    });
  } catch { /* audio is best-effort */ }
}

function startTimer() {
  const eng = activeEngine();
  if (!eng) return;
  ensureAudio();
  if (alarmState.ringing) { void silenceAlarm(); return; }
  if (eng.finished) {
    eng.remaining = eng.total;
    eng.finished = false;
  }
  if (tubeMode === 'timer' && !eng.running && !eng.finished) {
    const total = readInputsToTotal();
    if (total !== eng.total) {
      eng.total = total;
      eng.remaining = total;
    }
  }
  if (eng.remaining <= 0) {
    timerReadout.textContent = 'SET A DURATION';
    return;
  }
  eng.running = true;
  eng.endAt = Date.now() + eng.remaining * 1000;
  eng.updatedAt = Date.now();
  if (SW) void sendAlarmMsg({ type: 'ARM_ALARM', key: tubeMode, endAt: eng.endAt });
  setInputsDisabled(true);
  updateTimerReadout();
  updateIndicators();
  void persistTimers();
}

function pauseTimer() {
  const eng = activeEngine();
  if (!eng || !eng.running) return;
  eng.remaining = Math.max(0, Math.round((eng.endAt - Date.now()) / 1000));
  eng.running = false;
  eng.updatedAt = Date.now();
  if (SW) void sendAlarmMsg({ type: 'DISARM_ALARM', key: tubeMode });
  setInputsDisabled(false);
  updateTimerReadout();
  updateIndicators();
  void persistTimers();
}

function finishEngine(key) {
  const eng = timers[key];
  eng.running = false;
  eng.remaining = 0;
  eng.finished = true;
  eng.updatedAt = Date.now();
  if (tubeMode === key) {
    setInputsDisabled(false);
    renderTimerDigits(0);
    updateTimerReadout();
  }
  updateIndicators();
  if (SW) {
    // The worker owns the ring: show the strip immediately (optimistic) so
    // there is no silent gap, then confirm against worker state. If the worker
    // hasn't fired yet its broadcast is on its way ('sync' keeps the ring).
    applyAlarmState({ ringing: true, key, label: key === 'focus' ? 'FOCUS 25' : 'TIMER' });
    void sendAlarmMsg({ type: 'GET_ALARM_STATE' }).then((res) => {
      if (res && res.state) applyAlarmState(res.state, 'sync');
      else startLocalBeep(true);
    });
    // Late-arrival safety net: if the worker never confirms (asleep/killed),
    // ring locally so the alarm is never silent.
    setTimeout(() => {
      if (!alarmConfirmed && timers[key].finished) {
        applyAlarmState({ ringing: true, key, label: key === 'focus' ? 'FOCUS 25' : 'TIMER' });
        startLocalBeep(true);
      }
    }, 5000);
  } else {
    applyAlarmState({ ringing: true, key, label: key === 'focus' ? 'FOCUS 25' : 'TIMER' });
    startLocalBeep();
  }
  playCompleteTone();
  void persistTimers();
}

function resetTimer() {
  const eng = activeEngine();
  if (!eng) return;
  if (alarmState.ringing) stopLocalBeep();
  if (SW) {
    if (alarmState.ringing) void sendAlarmMsg({ type: 'SILENCE_ALARM' });
    // Always clear this engine's pending worker alarm; the ring may belong to
    // the other engine and must not leave a stale one-shot behind.
    void sendAlarmMsg({ type: 'DISARM_ALARM', key: tubeMode });
  }
  applyAlarmState({ ringing: false });
  eng.running = false;
  eng.finished = false;
  if (tubeMode === 'focus') eng.total = FOCUS_SECONDS;
  else eng.total = readInputsToTotal();
  eng.remaining = eng.total;
  eng.endAt = 0;
  eng.updatedAt = Date.now();
  setInputsDisabled(false);
  renderTimerDigits(eng.remaining);
  lastTubeSec = -1;
  updateTimerReadout();
  updateIndicators();
  void persistTimers();
}

function setMode(mode) {
  // Switching views never pauses: engines keep running on wall-clock time.
  tubeMode = mode;
  modeBtns().forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const isClock = mode === 'clock';
  timerPanel.hidden = isClock;
  applyClockVisibility();
  if (!isClock) {
    const eng = timers[mode];
    const isFocus = mode === 'focus';
    timerInputs.hidden = isFocus;
    focusPreset.hidden = !isFocus;
    if (!eng.running && !eng.finished && eng.remaining === eng.total) {
      eng.total = isFocus ? FOCUS_SECONDS : readInputsToTotal();
      eng.remaining = eng.total;
    }
    setInputsDisabled(eng.running);
    renderTimerDigits(eng.remaining);
    updateTimerReadout();
  }
  lastTubeSec = -1;
  tick();
}

modeBtns().forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

timerToggle.addEventListener('click', () => {
  if (alarmState.ringing) { void silenceAlarm(); return; }
  const eng = activeEngine();
  if (!eng) return;
  if (eng.running) pauseTimer();
  else startTimer();
});

timerReset.addEventListener('click', resetTimer);

[inH, inM, inS].forEach((el) => {
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(0, 2);
  });
  el.addEventListener('blur', () => {
    if (tubeMode !== 'timer') return;
    const eng = timers.timer;
    if (eng.running || eng.finished) return;
    eng.total = readInputsToTotal();
    eng.remaining = eng.total;
    eng.updatedAt = Date.now();
    renderTimerDigits(eng.remaining);
    updateTimerReadout();
    updateIndicators();
    void persistTimers();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); startTimer(); }
    if (e.key === 'Escape') { el.blur(); return; }
    e.stopPropagation();
  });
});

/* ---------- date ---------- */

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function renderDate() {
  const d = new Date();
  $('#dateReadout').textContent =
    `${DAYS[d.getDay()]} \u00B7 ${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------- T-minus countdowns ---------- */

const tminusReadout = $('#tminusReadout');
const tminusCode = $('#tminusCode');
const tminusLabel = $('#tminusLabel');
const eventForm = $('#eventForm');
const eventLabel = $('#eventLabel');
const eventDate = $('#eventDate');
const eventTime = $('#eventTime');
const eventError = $('#eventError');
const eventList = $('#eventList');
const eventEmpty = $('#eventEmpty');
const eventUndoBar = $('#eventUndoBar');
const eventUndoText = $('#eventUndoText');
const eventUndoBtn = $('#eventUndo');

let lastCountdownKey = '';
let eventUndoTimer = 0;
let eventUndoAction = null;

function clearEventUndo() {
  clearTimeout(eventUndoTimer);
  eventUndoTimer = 0;
  eventUndoAction = null;
  if (eventUndoBar) eventUndoBar.hidden = true;
}

function showEventUndo(text, action) {
  clearEventUndo();
  if (!eventUndoBar) return;
  eventUndoText.textContent = text;
  eventUndoAction = action;
  eventUndoBar.hidden = false;
  eventUndoTimer = setTimeout(clearEventUndo, 6000);
}

if (eventUndoBtn) {
  eventUndoBtn.addEventListener('click', async () => {
    const action = eventUndoAction;
    clearEventUndo();
    if (action) await action();
    eventLabel.focus({ preventScroll: true });
  });
}

function renderCountdown() {
  const now = new Date();
  const event = CORE.nextEvent(countdowns, now);
  if (!event) {
    tminusReadout.hidden = true;
    lastCountdownKey = '';
    return;
  }

  const status = CORE.eventStatus(event, now);
  const key = `${event.id}\u0000${status.code}\u0000${status.label}`;
  tminusReadout.hidden = false;
  tminusReadout.classList.toggle('is-today', status.state === 'today');
  tminusReadout.classList.toggle('is-past', status.state === 'past');
  if (key === lastCountdownKey) return;
  lastCountdownKey = key;
  tminusCode.textContent = status.code;
  tminusLabel.textContent = status.label;
  const description = `${status.label} — ${status.code} — ${status.dateText}`;
  tminusReadout.title = `${description}. Open countdowns.`;
  tminusReadout.setAttribute('aria-label', `Countdown: ${description}. Open countdowns.`);
}

let lastEventListRefresh = 0;

function refreshEventListStatus() {
  const now = Date.now();
  if (now - lastEventListRefresh < 1000) return;
  lastEventListRefresh = now;
  const byId = new Map(countdowns.map((event) => [event.id, event]));
  [...eventList.children].forEach((item) => {
    const event = byId.get(item.dataset.id);
    if (!event) return;
    const status = CORE.eventStatus(event, new Date());
    const code = item.querySelector('.cal-event-code');
    if (code && code.textContent !== status.code) code.textContent = status.code;
    item.classList.toggle('is-past', status.state === 'past');
  });
}

function renderEventList() {
  const now = new Date();
  eventList.textContent = '';
  eventEmpty.hidden = countdowns.length > 0;

  CORE.sortEvents(countdowns).forEach((event) => {
    const status = CORE.eventStatus(event, now);
    const item = document.createElement('li');
    item.className = `cal-event${status.state === 'past' ? ' is-past' : ''}`;
    item.dataset.id = event.id;

    const copy = document.createElement('div');
    copy.className = 'cal-event-copy';
    const name = document.createElement('span');
    name.className = 'cal-event-name';
    name.textContent = event.label;
    const date = document.createElement('span');
    date.className = 'cal-event-date';
    date.textContent = CORE.formatEventDate(event);
    copy.append(name, date);

    const code = document.createElement('span');
    code.className = 'cal-event-code';
    code.textContent = status.code;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cal-event-del';
    remove.textContent = '\u00D7';
    remove.setAttribute('aria-label', `Delete countdown: ${event.label}`);
    remove.addEventListener('click', () => { void removeCountdown(event.id); });

    item.append(copy, code, remove);
    eventList.appendChild(item);
  });
}

async function persistCountdowns() {
  const ok = await writeKey(EVENTS_KEY, countdowns);
  if (!ok) setCalStatus('COULD NOT SAVE COUNTDOWNS', 'error');
  return ok;
}

async function removeCountdown(id) {
  const index = countdowns.findIndex((event) => event.id === id);
  if (index < 0) return;
  const removed = countdowns[index];
  countdowns.splice(index, 1);
  await persistCountdowns();
  lastCountdownKey = '';
  renderCountdown();
  renderEventList();
  setCalStatus('COUNTDOWN REMOVED', 'ok');
  showEventUndo(`${removed.label.toUpperCase()} COUNTDOWN REMOVED`, async () => {
    countdowns.splice(Math.min(index, countdowns.length), 0, removed);
    countdowns = CORE.normalizeEvents(countdowns);
    await persistCountdowns();
    lastCountdownKey = '';
    renderCountdown();
    renderEventList();
    setCalStatus('COUNTDOWN RESTORED', 'ok');
  });
  eventLabel.focus({ preventScroll: true });
}

function showEventError(message) {
  eventError.textContent = message || 'ENTER A LABEL AND A VALID DATE';
  eventError.hidden = false;
  eventLabel.classList.add('invalid');
  eventDate.classList.add('invalid');
  eventTime.classList.add('invalid');
  eventLabel.setAttribute('aria-invalid', 'true');
  eventDate.setAttribute('aria-invalid', 'true');
  eventTime.setAttribute('aria-invalid', 'true');
  eventForm.classList.remove('shake');
  void eventForm.offsetWidth;
  eventForm.classList.add('shake');
  eventLabel.focus({ preventScroll: true });
}

function hideEventError() {
  eventError.hidden = true;
  eventLabel.classList.remove('invalid');
  eventDate.classList.remove('invalid');
  eventTime.classList.remove('invalid');
  eventLabel.removeAttribute('aria-invalid');
  eventDate.removeAttribute('aria-invalid');
  eventTime.removeAttribute('aria-invalid');
}

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = eventLabel.value.replace(/\s+/g, ' ').trim().slice(0, 40);
  const date = eventDate.value;
  const time = eventTime.value;
  if (!label || !CORE.parseDateKey(date) || (time && !CORE.parseTimeKey(time))) {
    showEventError();
    return;
  }

  const next = CORE.normalizeEvents([{
    id: CORE.makeId('e'),
    label,
    date,
    time
  }]);
  if (!next.length) {
    showEventError();
    return;
  }

  countdowns = CORE.normalizeEvents([...countdowns, next[0]]);
  await persistCountdowns();
  lastCountdownKey = '';
  renderCountdown();
  renderEventList();
  eventForm.reset();
  hideEventError();
  setCalStatus(`T-MINUS COMMISSIONED · ${label.toUpperCase()}`, 'ok');
  eventLabel.focus({ preventScroll: true });
});

eventLabel.addEventListener('input', hideEventError);
eventDate.addEventListener('input', hideEventError);
eventTime.addEventListener('input', hideEventError);
tminusReadout.addEventListener('click', () => openCalibration({ section: 'tminus' }));

async function initCountdowns() {
  const raw = await readKey(EVENTS_KEY);
  countdowns = CORE.normalizeEvents(raw);
  if (raw != null && JSON.stringify(raw) !== JSON.stringify(countdowns)) {
    void persistCountdowns();
  }
  renderCountdown();
  renderEventList();

  const adopt = (nextRaw) => {
    const incoming = CORE.normalizeEvents(nextRaw);
    if (JSON.stringify(incoming) === JSON.stringify(countdowns)) return;
    countdowns = incoming;
    lastCountdownKey = '';
    renderCountdown();
    renderEventList();
  };

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[EVENTS_KEY]) return;
      adopt(changes[EVENTS_KEY].newValue);
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== EVENTS_KEY) return;
      try { adopt(JSON.parse(e.newValue || 'null')); } catch { /* malformed cross-tab value */ }
    });
  }
}

/* ---------- favorites rail ---------- */

let sites = [];
const keysEl = $('#keys');
const railEl = $('#rail');
const railEmpty = $('#railEmpty');

function faviconFor(url) {
  if (EXT) {
    return `${chrome.runtime.getURL('_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
  }
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  } catch { return ''; }
}

function makeLamp(site) {
  const lamp = document.createElement('span');
  lamp.className = 'lamp';
  const src = faviconFor(site.url);
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    img.onerror = () => {
      const fb = document.createElement('span');
      fb.className = 'lamp-fallback';
      fb.textContent = site.name.charAt(0).toUpperCase();
      img.replaceWith(fb);
    };
    lamp.appendChild(img);
  } else {
    const fb = document.createElement('span');
    fb.className = 'lamp-fallback';
    fb.textContent = site.name.charAt(0).toUpperCase();
    lamp.appendChild(fb);
  }
  return lamp;
}

function renderKeys() {
  keysEl.textContent = '';
  railEmpty.hidden = sites.length > 0;
  sites.forEach((site, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'key-wrap';

    const a = document.createElement('a');
    a.className = 'key';
    a.href = site.url;
    if (idx < 9) {
      const num = document.createElement('span');
      num.className = 'key-num';
      num.textContent = String(idx + 1);
      num.setAttribute('aria-hidden', 'true');
      a.appendChild(num);
      a.title = `${site.name} — press ${idx + 1} to open`;
    }
    a.appendChild(makeLamp(site));
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = site.name;
    a.appendChild(name);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove';
    rm.textContent = '\u00D7';
    rm.setAttribute('aria-label', `Remove ${site.name}`);
    rm.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add('out');
      setTimeout(() => removeAt(idx), 210);
    });

    wrap.append(a, rm);
    keysEl.appendChild(wrap);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'key add';
  add.setAttribute('aria-label', 'Add a site');
  add.setAttribute('aria-expanded', String(servicePanel.classList.contains('open')));
  const lamp = document.createElement('span');
  lamp.className = 'lamp';
  const plus = document.createElement('span');
  plus.className = 'lamp-fallback';
  plus.textContent = '+';
  lamp.appendChild(plus);
  const label = document.createElement('span');
  label.className = 'key-name';
  label.textContent = 'Add site';
  add.append(lamp, label);
  add.addEventListener('click', () => togglePanel(true));
  keysEl.appendChild(add);
}

/* service mode */
const editToggle = $('#editToggle');
editToggle.addEventListener('click', () => {
  const on = railEl.classList.toggle('service');
  editToggle.classList.toggle('on', on);
  editToggle.setAttribute('aria-pressed', String(on));
  $('.et-text', editToggle).textContent = on ? 'DONE' : 'EDIT KEYS';
});

/* ---------- removal + undo readout ---------- */

const toastEl = $('#toast');
const toastUndoBtn = $('#toastUndo');
let pendingUndo = null;
let toastTimer = 0;

function clearUndo() {
  clearTimeout(toastTimer);
  toastTimer = 0;
  pendingUndo = null;
  if (toastEl) {
    toastEl.classList.remove('show');
    toastEl.hidden = true;
  }
  if (toastUndoBtn) toastUndoBtn.hidden = true;
  clearEventUndo();
}

function showToast(text, onUndo) {
  $('#toastText').textContent = text;
  pendingUndo = onUndo || null;
  toastUndoBtn.hidden = !onUndo;
  toastEl.hidden = false;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.hidden = true;
    pendingUndo = null;
  }, 5000);
}

toastUndoBtn.addEventListener('click', async () => {
  clearTimeout(toastTimer);
  const action = pendingUndo;
  pendingUndo = null;
  toastEl.classList.remove('show');
  toastEl.hidden = true;
  toastUndoBtn.hidden = true;
  if (action) await action();
});

async function removeAt(idx) {
  const removed = sites[idx];
  if (!removed) return;
  sites.splice(idx, 1);
  await store.set(sites);
  renderKeys();
  showToast(`${removed.name.toUpperCase()} KEY REMOVED`, async () => {
    sites.splice(Math.min(idx, sites.length), 0, removed);
    await store.set(sites);
    renderKeys();
  });
}

/* ---------- add form ---------- */

const servicePanel = $('#servicePanel');
const addForm = $('#addForm');
const siteName = $('#siteName');
const siteUrl = $('#siteUrl');
const siteError = $('#siteError');

servicePanel.inert = true;

function showSiteError() {
  siteError.textContent = 'ENTER A VALID URL';
  siteError.hidden = false;
  siteUrl.classList.add('invalid');
  siteUrl.setAttribute('aria-invalid', 'true');
  siteUrl.focus();
}

function hideSiteError() {
  siteError.hidden = true;
  siteUrl.classList.remove('invalid');
  siteUrl.removeAttribute('aria-invalid');
}

function togglePanel(open) {
  servicePanel.classList.toggle('open', open);
  servicePanel.inert = !open;
  if (open) {
    hideSiteError();
    setTimeout(() => siteName.focus({ preventScroll: true }), 180);
  } else {
    addForm.reset();
  }
}

$('#cancelAdd').addEventListener('click', () => togglePanel(false));
siteUrl.addEventListener('input', hideSiteError);

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let raw = siteUrl.value.trim();
  if (!raw) { showSiteError(); return; }
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let parsed;
  try { parsed = new URL(raw); } catch { showSiteError(); return; }
  const name = siteName.value.trim() || parsed.hostname.replace(/^www\./, '');
  sites.push({ name, url: parsed.href });
  await store.set(sites);
  renderKeys();
  togglePanel(false);
  railEl.classList.add('service');
  editToggle.classList.add('on');
  editToggle.setAttribute('aria-pressed', 'true');
  $('.et-text', editToggle).textContent = 'DONE';
});

/* ---------- search ---------- */

const searchForm = $('#searchForm');
const searchInput = $('#searchInput');
const suggestStack = $('#suggestStack');

let suggestions = [];
let activeIdx = -1;
let debounceTimer = 0;
let aborter = null;
let hideTimer = 0;

const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

function normalizeQuery(q) {
  return URL_RE.test(q) && !q.includes(' ')
    ? (/^https?:\/\//i.test(q) ? q : 'https://' + q)
    : null;
}

function searchEngineMeta() {
  return CORE.SEARCH_ENGINES[settings.searchEngine] || CORE.SEARCH_ENGINES.google;
}

function updateSearchAffordance() {
  const engine = searchEngineMeta();
  searchInput.placeholder = `Search ${engine.label}`;
  searchInput.setAttribute('aria-label', `Search ${engine.label}`);
}

function go(url) {
  window.location.href = url;
}

async function copyText(text) {
  const value = String(text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* clipboard API can be blocked on file:// */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

function calcValueFor(query) {
  if (!CORE.isMathExpression(query)) return null;
  const result = CORE.calculate(query);
  return result == null ? null : CORE.formatNumber(result);
}

async function copyCalc(value) {
  const ok = await copyText(value);
  showToast(ok ? `COPIED ${value}` : 'COPY FAILED');
}

function buildSearchExtras(query) {
  const extras = [];
  const calc = calcValueFor(query);
  if (calc != null) {
    extras.push({
      label: `= ${calc}`,
      kind: 'COPY',
      calc: true,
      action: () => { void copyCalc(calc); }
    });
  }
  const direct = normalizeQuery(query);
  if (direct) {
    extras.push({ label: direct, kind: 'OPEN', url: direct });
  } else {
    extras.push({
      label: query,
      kind: 'SEARCH',
      action: () => go(CORE.searchUrl(settings.searchEngine, query))
    });
  }
  return extras;
}

function renderSuggestions(list) {
  suggestStack.textContent = '';
  list.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `sug${item.kind === 'COPY' ? ' is-calc' : ''}`;
    row.id = `sug-${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.style.animationDelay = `${i * 25}ms`;
    const dot = document.createElement('i');
    dot.className = 'lamp-dot';
    const text = document.createElement('span');
    text.className = 'sug-text';
    text.textContent = item.label;
    const kind = document.createElement('span');
    kind.className = 'sug-kind';
    kind.textContent = item.kind;
    row.append(dot, text, kind);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('mouseenter', () => setActive(i, false));
    row.addEventListener('click', () => {
      if (typeof item.action === 'function') item.action();
      else if (item.url) go(item.url);
    });
    suggestStack.appendChild(row);
  });
  suggestions = list;
  activeIdx = -1;
  suggestStack.hidden = list.length === 0;
  searchInput.setAttribute('aria-expanded', String(list.length > 0));
  searchInput.removeAttribute('aria-activedescendant');
}

function setActive(i, scroll = true) {
  if (!suggestions.length) return;
  activeIdx = (i + suggestions.length) % suggestions.length;
  [...suggestStack.children].forEach((row, ri) => {
    row.classList.toggle('active', ri === activeIdx);
    row.setAttribute('aria-selected', String(ri === activeIdx));
    if (ri === activeIdx && scroll) row.scrollIntoView({ block: 'nearest' });
  });
  searchInput.setAttribute('aria-activedescendant', `sug-${activeIdx}`);
}

function clearSuggestions() {
  if (aborter) { aborter.abort(); aborter = null; }
  suggestions = [];
  activeIdx = -1;
  suggestStack.hidden = true;
  suggestStack.textContent = '';
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}

async function fetchSuggestions(q, base = []) {
  const engine = searchEngineMeta();
  if (!settings.suggestions || !engine.suggest) {
    renderSuggestions(base);
    return;
  }
  if (aborter) aborter.abort();
  const controller = new AbortController();
  aborter = controller;
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`,
      { signal: controller.signal }
    );
    const data = await res.json();
    const rows = (data[1] || []).slice(0, 8).map((s) => ({
      label: s,
      kind: engine.label.toUpperCase(),
      url: CORE.searchUrl('google', s)
    }));
    const seen = new Set();
    const list = [...base, ...rows]
      .filter((item) => {
        const key = item.label.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 9);
    renderSuggestions(list);
  } catch (err) {
    if (err && err.name !== 'AbortError') renderSuggestions(base);
  } finally {
    if (aborter === controller) aborter = null;
  }
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  clearTimeout(debounceTimer);
  if (aborter) { aborter.abort(); aborter = null; }
  if (!q) { clearSuggestions(); return; }

  const base = buildSearchExtras(q);
  const engine = searchEngineMeta();
  if (settings.suggestions && engine.suggest) {
    if (base.length) renderSuggestions(base);
    else clearSuggestions();
    debounceTimer = setTimeout(() => fetchSuggestions(q, base), 130);
  } else {
    renderSuggestions(base);
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(activeIdx < 0 ? suggestions.length - 1 : activeIdx - 1);
  }
  else if (e.key === 'Escape') {
    searchInput.value = '';
    clearSuggestions();
    searchInput.blur();
  } else if (e.key === 'Tab') {
    clearSuggestions();
  }
});

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  if (activeIdx >= 0 && suggestions[activeIdx]) {
    const item = suggestions[activeIdx];
    if (typeof item.action === 'function') item.action();
    else if (item.url) go(item.url);
    return;
  }
  const calc = calcValueFor(q);
  if (calc != null) { void copyCalc(calc); return; }
  const direct = normalizeQuery(q);
  go(direct || CORE.searchUrl(settings.searchEngine, q));
});

searchInput.addEventListener('blur', () => {
  hideTimer = setTimeout(clearSuggestions, 140);
});
searchInput.addEventListener('focus', () => clearTimeout(hideTimer));

/* ---------- task manifest ---------- */

const TASK_STORE_KEY = 'nixie.tasks';
const MAX_TASK_LEN = 200;

const taskModule = $('#taskModule');
const taskToggle = $('#taskToggle');
const taskBody = $('#taskBody');
const manifestCount = $('#manifestCount');
const manifestNext = $('#manifestNext');
const manifestPct = $('#manifestPct');
const manifestBar = $('#manifestBar');
const manifestGauge = $('#manifestGauge');
const manifestFilters = $('#manifestFilters');
const clearDoneBtn = $('#clearDone');
const taskForm = $('#taskForm');
const taskInput = $('#taskInput');
const taskError = $('#taskError');
const taskList = $('#taskList');
const taskEmpty = $('#taskEmpty');
const taskEmptyCode = $('#taskEmptyCode');
const taskEmptyTitle = $('#taskEmptyTitle');
const taskEmptySub = $('#taskEmptySub');
const taskAnnounce = $('#taskAnnounce');

const manifestScrim = $('#manifestScrim');
const narrowManifest = window.matchMedia('(max-width: 1279px)');
const manifestInertRegions = [$('main'), $('.dock')].filter(Boolean);

const MANIFEST_UI_KEY = 'nixie.manifest.ui';

let tasks = [];
let taskFilter = 'all';
let editingTaskId = null;
let manifestOpen = false;
let taskAnnounceTimer = 0;

function makeTaskId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function cleanTaskText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TASK_LEN);
}

function normalizeTasks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const text = cleanTaskText(item.text);
    if (!text) return;
    let id = typeof item.id === 'string' && item.id ? item.id : makeTaskId();
    if (seen.has(id)) id = makeTaskId();
    seen.add(id);
    const done = item.done === true;
    const createdAt = Number.isFinite(+item.createdAt) ? +item.createdAt : Date.now();
    const doneAt = done && Number.isFinite(+item.doneAt) ? +item.doneAt : null;
    out.push({ id, text, done, createdAt, doneAt });
  });
  return out;
}

async function readStoredTasks() {
  try {
    if (EXT) {
      const data = await chrome.storage.local.get(TASK_STORE_KEY);
      return { ok: true, value: data[TASK_STORE_KEY] == null ? null : data[TASK_STORE_KEY] };
    }
    const raw = localStorage.getItem(TASK_STORE_KEY);
    return { ok: true, value: raw == null ? null : JSON.parse(raw) };
  } catch {
    return { ok: false, value: null };
  }
}

async function persistTasks() {
  try {
    if (EXT) await chrome.storage.local.set({ [TASK_STORE_KEY]: tasks });
    else localStorage.setItem(TASK_STORE_KEY, JSON.stringify(tasks));
  } catch { /* persistence is best-effort */ }
}

async function readManifestUi() {
  try {
    if (EXT) {
      const data = await chrome.storage.local.get(MANIFEST_UI_KEY);
      return data[MANIFEST_UI_KEY] || null;
    }
    return JSON.parse(localStorage.getItem(MANIFEST_UI_KEY) || 'null');
  } catch { return null; }
}

async function persistManifestUi() {
  try {
    const value = { open: manifestOpen };
    if (EXT) await chrome.storage.local.set({ [MANIFEST_UI_KEY]: value });
    else localStorage.setItem(MANIFEST_UI_KEY, JSON.stringify(value));
  } catch { /* persistence is best-effort */ }
}

function taskStats() {
  const total = tasks.length;
  let done = 0;
  tasks.forEach((task) => { if (task.done) done += 1; });
  return { total, done, open: total - done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function visibleTasks() {
  return tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => taskFilter === 'all' || (taskFilter === 'open' ? !task.done : task.done));
}

function findTaskRow(id) {
  return [...taskList.children].find((row) => row.dataset.id === id) || null;
}

function announce(text) {
  clearTimeout(taskAnnounceTimer);
  taskAnnounce.textContent = '';
  taskAnnounceTimer = setTimeout(() => { taskAnnounce.textContent = text; }, 20);
}

function renderChrome() {
  const { total, done, open, pct } = taskStats();

  manifestCount.textContent = open ? `${pad2(open)} OPEN` : total ? 'ALL CLEAR' : '00 OPEN';
  manifestNext.textContent = open
    ? `NEXT · ${tasks.find((task) => !task.done)?.text || ''}`
    : total ? 'ALL WORK ORDERS CLOSED' : 'NO WORK ORDERS LOGGED — PRESS T TO ADD';
  taskModule.classList.toggle('has-open', open > 0);
  taskModule.classList.toggle('all-clear', total > 0 && open === 0);
  taskModule.classList.toggle('is-empty', total === 0);

  manifestPct.textContent = `${pct}%`;
  manifestBar.style.width = `${pct}%`;
  manifestGauge.setAttribute('aria-valuenow', String(pct));
  manifestGauge.setAttribute('aria-valuetext', total
    ? `${done} of ${total} work order${total === 1 ? '' : 's'} complete`
    : 'No work orders');

  manifestFilters.querySelectorAll('.mf-btn').forEach((btn) => {
    const filter = btn.dataset.filter;
    const count = filter === 'all' ? total : filter === 'open' ? open : done;
    const countEl = btn.querySelector('.mf-count');
    if (countEl) countEl.textContent = pad2(count);
    const active = filter === taskFilter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  clearDoneBtn.disabled = done === 0;
}

function syncTaskRowA11y(row, task) {
  row.classList.toggle('is-done', task.done);
  const check = row.querySelector('.task-check');
  if (check) {
    check.setAttribute('aria-checked', String(task.done));
    check.setAttribute('aria-label',
      `${task.done ? 'Mark as not complete' : 'Mark as complete'}: ${task.text}`);
  }
  const edit = row.querySelector('.task-edit');
  if (edit) edit.setAttribute('aria-label', `Edit: ${task.text}`);
  const del = row.querySelector('.task-del');
  if (del) del.setAttribute('aria-label', `Delete: ${task.text}`);
}

function renderTaskBody(row, task) {
  const body = row.querySelector('.task-body');
  if (!body) return;
  body.textContent = '';

  if (editingTaskId === task.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.maxLength = MAX_TASK_LEN;
    input.value = task.text;
    input.setAttribute('aria-label', 'Edit work order');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
    input.addEventListener('blur', () => {
      if (editingTaskId === task.id) finishEdit(true, false);
    });
    body.appendChild(input);
    requestAnimationFrame(() => {
      if (editingTaskId !== task.id) return;
      const liveInput = row.querySelector('.task-edit-input');
      if (liveInput && document.activeElement !== liveInput) {
        liveInput.focus({ preventScroll: true });
        liveInput.select();
      }
    });
    return;
  }

  const text = document.createElement('span');
  text.className = 'task-text';
  text.textContent = task.text;
  text.title = 'Double-click to edit';
  text.addEventListener('dblclick', () => beginEdit(task.id));
  body.appendChild(text);
}

function buildTaskRow(task, index) {
  const row = document.createElement('li');
  row.className = `task${task.done ? ' is-done' : ''}${task.id === editingTaskId ? ' is-editing' : ''}`;
  row.dataset.id = task.id;

  const num = document.createElement('span');
  num.className = 'task-index';
  num.textContent = pad2(index + 1);
  num.setAttribute('aria-hidden', 'true');

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'task-check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(task.done));
  check.setAttribute('aria-label',
    `${task.done ? 'Mark as not complete' : 'Mark as complete'}: ${task.text}`);
  check.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2.8 8.3 6.2 11.7 13.2 4.4" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  check.addEventListener('click', () => toggleTask(task.id));

  const body = document.createElement('div');
  body.className = 'task-body';

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'task-act task-edit';
  edit.title = 'Edit work order';
  edit.setAttribute('aria-label', `Edit: ${task.text}`);
  edit.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3 11.8 3.6 13l1.2.6 7.7-7.7-1.8-1.8L3 11.8Z" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M10 3.4 11.8 5.2" stroke="currentColor" stroke-width="1.2"/></svg>';
  edit.addEventListener('mousedown', (e) => e.preventDefault());
  edit.addEventListener('click', () => beginEdit(task.id));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-act task-del';
  del.title = 'Delete work order';
  del.setAttribute('aria-label', `Delete: ${task.text}`);
  del.textContent = '\u00D7';
  del.addEventListener('mousedown', (e) => e.preventDefault());
  del.addEventListener('click', () => removeTask(task.id));

  actions.append(edit, del);
  row.append(num, check, body, actions);
  renderTaskBody(row, task);
  return row;
}

function renderTaskList() {
  const visible = visibleTasks();
  const frag = document.createDocumentFragment();
  visible.forEach(({ task, index }) => frag.appendChild(buildTaskRow(task, index)));
  taskList.textContent = '';
  taskList.appendChild(frag);
  updateEmptyState(visible.length);
}

function renderManifest() {
  renderChrome();
  renderTaskList();
}

function updateEmptyState(count) {
  if (count > 0) {
    taskEmpty.hidden = true;
    return;
  }
  taskEmpty.hidden = false;
  if (!tasks.length) {
    taskEmptyCode.textContent = '00';
    taskEmptyTitle.textContent = 'NO WORK ORDERS ON FILE';
    taskEmptySub.textContent = 'Log one above to commission the manifest.';
  } else if (taskFilter === 'open') {
    taskEmptyCode.textContent = 'OK';
    taskEmptyTitle.textContent = 'ALL CLEAR';
    taskEmptySub.textContent = 'Every work order is closed. Nothing is waiting.';
  } else if (taskFilter === 'done') {
    taskEmptyCode.textContent = '\u2014';
    taskEmptyTitle.textContent = 'NO COMPLETED WORK ORDERS';
    taskEmptySub.textContent = 'Finished jobs will file here.';
  } else {
    taskEmptyCode.textContent = '00';
    taskEmptyTitle.textContent = 'NO WORK ORDERS ON FILE';
    taskEmptySub.textContent = 'Log one above to commission the manifest.';
  }
}

function focusTask(id) {
  const row = findTaskRow(id);
  if (row) {
    const check = row.querySelector('.task-check');
    if (check) {
      check.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  if (manifestOpen) taskInput.focus({ preventScroll: true });
}

function focusTaskAt(index) {
  if (!manifestOpen) return;
  const rows = [...taskList.children];
  if (!rows.length) {
    taskInput.focus({ preventScroll: true });
    return;
  }
  const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
  const check = row.querySelector('.task-check');
  if (check) {
    check.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  } else {
    taskInput.focus({ preventScroll: true });
  }
}

function showTaskError() {
  taskError.hidden = false;
  taskInput.classList.add('invalid');
  taskInput.setAttribute('aria-invalid', 'true');
  taskForm.classList.remove('shake');
  void taskForm.offsetWidth;
  taskForm.classList.add('shake');
  taskInput.focus({ preventScroll: true });
}

function hideTaskError() {
  taskError.hidden = true;
  taskInput.classList.remove('invalid');
  taskInput.removeAttribute('aria-invalid');
}

function addTask(value, { focus = true } = {}) {
  const text = cleanTaskText(value);
  if (!text) { showTaskError(); return false; }

  const task = { id: makeTaskId(), text, done: false, createdAt: Date.now(), doneAt: null };
  tasks.unshift(task);
  if (taskFilter === 'done') taskFilter = 'open';
  void persistTasks();
  renderManifest();
  taskInput.value = '';
  hideTaskError();
  if (focus) {
    taskList.parentElement.scrollTop = 0;
    taskInput.focus({ preventScroll: true });
  }
  announce(`Added: ${text}`);

  const row = findTaskRow(task.id);
  if (row) {
    row.classList.add('is-new');
    row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
  }
  return true;
}

function beginEdit(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  if (editingTaskId && editingTaskId !== id) finishEdit(true, false);
  if (editingTaskId === id) {
    const existing = taskList.querySelector('.task-edit-input');
    if (existing) { existing.focus({ preventScroll: true }); existing.select(); }
    return;
  }
  editingTaskId = id;
  const row = findTaskRow(id);
  if (!row) { editingTaskId = null; return; }
  row.classList.add('is-editing');
  renderTaskBody(row, task);
}

function finishEdit(commit, focusAfter = true) {
  if (!editingTaskId) return;
  const id = editingTaskId;
  const task = tasks.find((item) => item.id === id);
  const row = findTaskRow(id);
  const input = row ? row.querySelector('.task-edit-input') : null;
  editingTaskId = null;

  let changed = false;
  if (commit && task && input) {
    const text = cleanTaskText(input.value);
    if (text && text !== task.text) {
      task.text = text;
      changed = true;
      announce(`Updated: ${text}`);
    }
  }
  if (changed) void persistTasks();

  if (row && task) {
    row.classList.remove('is-editing');
    renderTaskBody(row, task);
    syncTaskRowA11y(row, task);
  } else {
    renderTaskList();
  }
  renderChrome();
  if (focusAfter && manifestOpen && task) focusTask(id);
}

function toggleTask(id) {
  if (editingTaskId) finishEdit(true, false);
  const task = tasks.find((item) => item.id === id);
  if (!task) return;

  const row = findTaskRow(id);
  const rowIndex = row ? [...taskList.children].indexOf(row) : -1;

  task.done = !task.done;
  task.doneAt = task.done ? Date.now() : null;
  void persistTasks();
  announce(`${task.done ? 'Completed' : 'Reopened'}: ${task.text}`);

  const { open } = taskStats();
  const allClear = task.done && open === 0;
  const willLeave = (taskFilter === 'open' && task.done) || (taskFilter === 'done' && !task.done);

  if (row) {
    row.classList.toggle('is-done', task.done);
    syncTaskRowA11y(row, task);
  }
  renderChrome();

  if (willLeave) {
    if (row) row.classList.add('task-exit');
    setTimeout(() => {
      renderTaskList();
      if (manifestOpen) focusTaskAt(rowIndex);
      if (allClear) showToast('ALL WORK ORDERS CLEARED');
    }, reduceMotion.matches ? 0 : 180);
  } else if (allClear) {
    showToast('ALL WORK ORDERS CLEARED');
  }
}

function removeTask(id) {
  if (editingTaskId) finishEdit(true, false);
  const index = tasks.findIndex((item) => item.id === id);
  if (index < 0) return;
  const removed = tasks[index];
  const row = findTaskRow(id);
  const rowIndex = row ? [...taskList.children].indexOf(row) : -1;

  const commitRemoval = () => {
    const liveIndex = tasks.findIndex((item) => item.id === id);
    if (liveIndex >= 0) tasks.splice(liveIndex, 1);
    void persistTasks();
    renderManifest();
    if (manifestOpen) focusTaskAt(rowIndex);
    announce(`Deleted: ${removed.text}`);
    showToast('WORK ORDER DELETED', async () => {
      tasks.splice(Math.min(index, tasks.length), 0, removed);
      await persistTasks();
      renderManifest();
      focusTask(removed.id);
    });
  };

  if (row) {
    row.classList.add('task-exit');
    setTimeout(commitRemoval, reduceMotion.matches ? 0 : 180);
  } else {
    commitRemoval();
  }
}

function clearCompleted() {
  if (editingTaskId) finishEdit(true, false);
  const removed = [];
  tasks.forEach((task, index) => { if (task.done) removed.push({ task, index }); });
  if (!removed.length) return;

  tasks = tasks.filter((task) => !task.done);
  void persistTasks();
  renderManifest();
  if (manifestOpen) taskInput.focus({ preventScroll: true });
  announce(`${removed.length} completed ${removed.length === 1 ? 'task' : 'tasks'} cleared`);
  showToast(
    `${removed.length} COMPLETED ${removed.length === 1 ? 'TASK' : 'TASKS'} CLEARED`,
    async () => {
      removed.forEach(({ task, index }) => {
        tasks.splice(Math.min(index, tasks.length), 0, task);
      });
      await persistTasks();
      renderManifest();
      if (manifestOpen) taskInput.focus({ preventScroll: true });
    }
  );
}

function syncManifestLayers() {
  const scrimmed = manifestOpen && narrowManifest.matches;
  document.body.classList.toggle('manifest-scrimmed', scrimmed);
  manifestInertRegions.forEach((region) => { region.inert = scrimmed; });
}

function applyManifestOpen(open, { persist = false } = {}) {
  manifestOpen = !!open;
  taskModule.classList.toggle('is-open', manifestOpen);
  taskToggle.setAttribute('aria-expanded', String(manifestOpen));
  taskToggle.title = manifestOpen
    ? 'Collapse task manifest — press T'
    : 'Expand task manifest — press T';
  if (manifestOpen) taskBody.removeAttribute('inert');
  else taskBody.setAttribute('inert', '');
  syncManifestLayers();
  if (persist) void persistManifestUi();
}

function openManifest({ focus = true } = {}) {
  if (manifestOpen) {
    if (focus) taskInput.focus({ preventScroll: true });
    return;
  }
  hideTaskError();
  applyManifestOpen(true, { persist: true });
  if (focus) requestAnimationFrame(() => taskInput.focus({ preventScroll: true }));
}

function closeManifest({ restoreFocus = true } = {}) {
  if (!manifestOpen) return;
  const hadFocus = taskModule.contains(document.activeElement);
  if (editingTaskId) finishEdit(true, false);
  applyManifestOpen(false, { persist: true });
  if (restoreFocus && hadFocus) taskToggle.focus({ preventScroll: true });
}

function toggleManifest() {
  if (manifestOpen) closeManifest();
  else openManifest({ focus: false });
}

taskToggle.addEventListener('click', toggleManifest);
manifestScrim.addEventListener('click', () => closeManifest());
narrowManifest.addEventListener('change', syncManifestLayers);

taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addTask(taskInput.value);
});
taskInput.addEventListener('input', hideTaskError);

manifestFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.mf-btn');
  if (!btn) return;
  const filter = btn.dataset.filter;
  if (filter !== 'all' && filter !== 'open' && filter !== 'done') return;
  if (editingTaskId) finishEdit(true, false);
  taskFilter = filter;
  renderManifest();
  btn.focus({ preventScroll: true });
});

clearDoneBtn.addEventListener('click', clearCompleted);

async function initManifest() {
  const stored = await readStoredTasks();
  tasks = stored.ok ? normalizeTasks(stored.value) : [];
  renderManifest();
  if (stored.ok && JSON.stringify(stored.value) !== JSON.stringify(tasks)) void persistTasks();

  const ui = await readManifestUi();
  const autoOpen = window.matchMedia('(min-width: 1280px) and (min-height: 660px)').matches;
  applyManifestOpen(ui && typeof ui.open === 'boolean' ? ui.open : autoOpen);

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[TASK_STORE_KEY]) return;
      const incoming = normalizeTasks(changes[TASK_STORE_KEY].newValue);
      if (JSON.stringify(incoming) === JSON.stringify(tasks)) return;
      if (editingTaskId) return;
      tasks = incoming;
      renderManifest();
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== TASK_STORE_KEY) return;
      let incoming = [];
      try { incoming = normalizeTasks(JSON.parse(e.newValue || 'null')); } catch { return; }
      if (JSON.stringify(incoming) === JSON.stringify(tasks)) return;
      if (editingTaskId) return;
      tasks = incoming;
      renderManifest();
    });
  }
}

/* ---------- calibration ---------- */

const calDialog = $('#calibrationDialog');
const openCalibrationBtn = $('#openCalibration');
const calCloseBtn = $('#calClose');
const setClock24 = $('#setClock24');
const setSeconds = $('#setSeconds');
const setTheme = $('#setTheme');
const setDim = $('#setDim');
const setTone = $('#setTone');
const setVolume = $('#setVolume');
const volumeOut = $('#volumeOut');
const testAlarmBtn = $('#testAlarm');
const setEngine = $('#setEngine');
const setSuggestions = $('#setSuggestions');
const exportBtn = $('#exportData');
const importBtn = $('#importData');
const resetBtn = $('#resetData');
const importFile = $('#importFile');
const calStatus = $('#calStatus');
const calVersion = $('.cal-version');

const CAL_STATUS_DEFAULT = 'CHANGES SAVE AUTOMATICALLY';
let calStatusTimer = 0;
let resetArmed = false;
let resetArmTimer = 0;
let lastCalTrigger = null;

function setCalStatus(text, kind = '') {
  if (!calStatus) return;
  calStatus.textContent = text || CAL_STATUS_DEFAULT;
  calStatus.classList.toggle('is-ok', kind === 'ok');
  calStatus.classList.toggle('is-error', kind === 'error');
  clearTimeout(calStatusTimer);
  calStatusTimer = setTimeout(() => {
    calStatus.textContent = CAL_STATUS_DEFAULT;
    calStatus.classList.remove('is-ok', 'is-error');
  }, 4200);
}

function fillSelect(select, entries) {
  select.textContent = '';
  entries.forEach(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    select.appendChild(option);
  });
}

function populateCalibration() {
  fillSelect(setTheme, CORE.THEMES);
  fillSelect(setTone, CORE.TONES);
  fillSelect(setEngine, Object.keys(CORE.SEARCH_ENGINES).map((id) => ({
    id,
    label: CORE.SEARCH_ENGINES[id].label
  })));
  if (calVersion) calVersion.textContent = `MF-01 / ${CORE.VERSION.split('.').slice(0, 2).join('.')}`;
}

function syncCalibration() {
  if (!setTheme.options.length) populateCalibration();
  setClock24.checked = settings.clock24;
  setSeconds.checked = settings.showSeconds;
  setTheme.value = settings.theme;
  setDim.checked = settings.dim;
  setTone.value = settings.alarmTone;
  setVolume.value = String(Math.round(settings.alarmVolume * 100));
  volumeOut.textContent = `${Math.round(settings.alarmVolume * 100)}%`;
  setEngine.value = settings.searchEngine;
  setSuggestions.checked = settings.suggestions;

  const engine = searchEngineMeta();
  setSuggestions.disabled = !engine.suggest;
  setSuggestions.title = engine.suggest
    ? 'Sends typed text to Google for suggestions'
    : `${engine.label} does not support live suggestions`;

  syncShieldsCalibration();
}

function disarmReset() {
  resetArmed = false;
  clearTimeout(resetArmTimer);
  resetArmTimer = 0;
  if (!resetBtn) return;
  resetBtn.classList.remove('is-armed');
  resetBtn.textContent = 'RESET';
}

function openCalibration({ section = '' } = {}) {
  const active = document.activeElement;
  lastCalTrigger = active &&
    typeof active.focus === 'function' &&
    !calDialog.contains(active) &&
    !consoleDialog.contains(active)
    ? active
    : openCalibrationBtn;
  if (consoleDialog.open) consoleDialog.close();
  syncCalibration();
  renderEventList();
  if (!calDialog.open) calDialog.showModal();

  const target = section
    ? calDialog.querySelector(`[data-cal-section="${section}"]`)
    : null;
  requestAnimationFrame(() => {
    if (target) {
      target.scrollIntoView({ block: 'start' });
      const field = target.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])');
      if (field) field.focus({ preventScroll: true });
    } else {
      calCloseBtn.focus({ preventScroll: true });
    }
  });
}

function closeCalibration() {
  if (calDialog.open) calDialog.close();
}

function exportArchive() {
  const archive = CORE.buildBackup({
    sites,
    tasks,
    events: countdowns,
    settings
  });
  try {
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nixie-archive-${CORE.dateKeyLocal(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setCalStatus('ARCHIVE EXPORTED', 'ok');
  } catch {
    setCalStatus('EXPORT FAILED', 'error');
  }
}

async function applyArchive(archive) {
  const writes = [];
  clearUndo();

  if (archive.sites !== null) {
    sites = archive.sites;
    writes.push(store.set(sites));
  }
  if (Array.isArray(archive.tasks)) {
    tasks = normalizeTasks(archive.tasks);
    editingTaskId = null;
    writes.push(writeKey(TASK_STORE_KEY, tasks));
  }
  if (archive.events !== null) {
    countdowns = archive.events;
    writes.push(writeKey(EVENTS_KEY, countdowns));
  }
  if (archive.settings !== null) {
    // Archives may carry a partial settings patch; merge it over current
    // preferences instead of resetting unspecified keys.
    settings = CORE.normalizeSettings({ ...settings, ...archive.settings });
    applySettings();
    writes.push(writeKey(SETTINGS_KEY, settings));
  }

  await Promise.all(writes);
  renderKeys();
  renderManifest();
  lastCountdownKey = '';
  renderCountdown();
  renderEventList();
  syncCalibration();
}

async function performReset() {
  disarmReset();
  clearUndo();
  clearTimeout(settingsWriteTimer);
  settingsWriteTimer = 0;
  clearTimeout(debounceTimer);
  clearTimeout(shieldsPathTimer);
  shieldsPathTimer = 0;
  clearSuggestions();
  stopLocalBeep();
  if (SW) {
    await sendAlarmMsg({ type: 'SILENCE_ALARM' });
    await sendAlarmMsg({ type: 'DISARM_ALARM' });
  }
  applyAlarmState({ ringing: false });

  settings = CORE.normalizeSettings(null);
  countdowns = [];
  sites = DEFAULT_SITES.slice();
  tasks = [];
  editingTaskId = null;
  taskFilter = 'all';
  timers.timer = makeEngine(5 * 60);
  timers.focus = makeEngine(FOCUS_SECONDS);
  inH.value = '00';
  inM.value = '05';
  inS.value = '00';
  setInputsDisabled(false);
  eventForm.reset();
  hideEventError();
  taskInput.value = '';
  hideTaskError();

  shields = CORE.normalizeShields(null);
  ++shieldsRequest;
  stopShieldsPoll();
  clearShieldsDisplay();

  await Promise.all([
    writeKey(SETTINGS_KEY, settings),
    writeKey(EVENTS_KEY, countdowns),
    store.set(sites),
    writeKey(TASK_STORE_KEY, tasks),
    removeKey(TIMER_STORE_KEY),
    removeKey(MANIFEST_UI_KEY),
    removeKey(SHIELDS_KEY)
  ]);

  applySettings();
  syncCalibration();
  applyShieldsVisibility();
  syncShieldsCalibration();
  setShieldsStatus('SHIELDS RESET · AUTO-DETECT ON', '');
  lastCountdownKey = '';
  renderCountdown();
  renderEventList();
  renderManifest();
  renderKeys();
  setMode('clock');
  lastTubeSec = -1;
  updateIndicators();
  setCalStatus('FACTORY RESET COMPLETE', 'ok');
  void refreshShields({ detect: true });
}

function armReset() {
  if (!resetArmed) {
    resetArmed = true;
    resetBtn.classList.add('is-armed');
    resetBtn.textContent = 'CONFIRM RESET';
    setCalStatus('PRESS AGAIN TO ERASE ALL DATA', 'error');
    clearTimeout(resetArmTimer);
    resetArmTimer = setTimeout(disarmReset, 4000);
    return;
  }
  void performReset();
}

openCalibrationBtn.addEventListener('click', () => openCalibration());
calCloseBtn.addEventListener('click', closeCalibration);

calDialog.addEventListener('click', (e) => {
  if (e.target === calDialog) closeCalibration();
});

calDialog.addEventListener('close', () => {
  disarmReset();
  clearEventUndo();
  clearSuggestions();
  if (consoleDialog.open) return;
  const trigger = lastCalTrigger &&
    document.contains(lastCalTrigger) &&
    lastCalTrigger.offsetParent !== null
    ? lastCalTrigger
    : openCalibrationBtn;
  trigger.focus({ preventScroll: true });
});

setClock24.addEventListener('change', () => {
  updateSettings(
    { clock24: setClock24.checked },
    { note: setClock24.checked ? '24-HOUR CLOCK ON' : '12-HOUR CLOCK ON' }
  );
  lastTubeSec = -1;
  tick();
});

setSeconds.addEventListener('change', () => {
  updateSettings(
    { showSeconds: setSeconds.checked },
    { note: setSeconds.checked ? 'SECONDS TUBES ON' : 'SECONDS TUBES OFF' }
  );
  lastTubeSec = -1;
  tick();
});

setTheme.addEventListener('change', () => {
  const theme = CORE.THEMES.find((entry) => entry.id === setTheme.value);
  updateSettings(
    { theme: setTheme.value },
    { note: `TUBE COLOUR · ${(theme ? theme.label : setTheme.value).toUpperCase()}` }
  );
});

setDim.addEventListener('change', () => {
  updateSettings(
    { dim: setDim.checked },
    { note: setDim.checked ? 'CHASSIS DIM ON' : 'CHASSIS DIM OFF' }
  );
});

setTone.addEventListener('change', () => {
  const tone = CORE.TONES.find((entry) => entry.id === setTone.value);
  updateSettings(
    { alarmTone: setTone.value },
    { note: `ALARM TONE · ${(tone ? tone.label : setTone.value).toUpperCase()}` }
  );
  restartLocalBeep();
  if (settings.alarmTone === 'silent') setCalStatus('SILENT TONE — ALARM IS VISUAL ONLY', 'ok');
});

setVolume.addEventListener('input', () => {
  const pct = Math.min(100, Math.max(0, Number(setVolume.value) || 0));
  volumeOut.textContent = `${Math.round(pct)}%`;
  if (updateSettings({ alarmVolume: pct / 100 }, { persist: false })) {
    queueSettingsWrite();
  }
});

testAlarmBtn.addEventListener('click', () => {
  ensureAudio();
  if (settings.alarmTone === 'silent') {
    setCalStatus('SILENT TONE — NO AUDIO', 'ok');
    return;
  }
  if (!settings.alarmVolume) {
    setCalStatus('ALARM VOLUME IS ZERO', 'error');
    return;
  }
  const tone = CORE.TONES.find((entry) => entry.id === settings.alarmTone);
  const played = playTonePulse(settings.alarmTone);
  setCalStatus(
    played ? `TESTING · ${(tone ? tone.label : settings.alarmTone).toUpperCase()}` : 'AUDIO UNAVAILABLE',
    played ? 'ok' : 'error'
  );
});

setEngine.addEventListener('change', () => {
  const engine = CORE.SEARCH_ENGINES[setEngine.value] || CORE.SEARCH_ENGINES.google;
  updateSettings(
    { searchEngine: setEngine.value },
    { note: `SEARCH · ${engine.label.toUpperCase()}` }
  );
  setSuggestions.disabled = !engine.suggest;
  setSuggestions.title = engine.suggest
    ? 'Sends typed text to Google for suggestions'
    : `${engine.label} does not support live suggestions`;
  clearSuggestions();
});

setSuggestions.addEventListener('change', () => {
  updateSettings(
    { suggestions: setSuggestions.checked },
    { note: setSuggestions.checked ? 'LIVE SUGGESTIONS ON' : 'LIVE SUGGESTIONS OFF' }
  );
  if (!settings.suggestions) clearSuggestions();
});

exportBtn.addEventListener('click', exportArchive);
importBtn.addEventListener('click', () => importFile.click());
resetBtn.addEventListener('click', armReset);

importFile.addEventListener('change', async () => {
  const file = importFile.files && importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const archive = CORE.parseBackup(await file.text());
    if (!archive) throw new Error('invalid archive');
    await applyArchive(archive);
    setCalStatus('ARCHIVE RESTORED', 'ok');
  } catch {
    setCalStatus('IMPORT FAILED — INVALID ARCHIVE', 'error');
  }
});

function initCalibration() {
  populateCalibration();
  syncCalibration();
  renderEventList();
}

/* ---------- Brave Shields telemetry ---------- */

const SHIELDS_KEY = 'nixie.shields';
const SHIELDS_POLL_MS = 12000;
const SHIELDS_MAX_CANDIDATES = 16;

const SHIELDS_ROOTS = [
  { root: 'file:///C:/Users/', kind: 'win' },
  { root: 'file:///Users/', kind: 'mac' },
  { root: 'file:///home/', kind: 'linux' }
];

const SHIELDS_BRAVE_PATHS = {
  win: [
    'AppData/Local/BraveSoftware/Brave-Browser/User Data',
    'AppData/Local/BraveSoftware/Brave-Browser-Beta/User Data',
    'AppData/Local/BraveSoftware/Brave-Browser-Nightly/User Data'
  ],
  mac: [
    'Library/Application Support/BraveSoftware/Brave-Browser/User Data',
    'Library/Application Support/BraveSoftware/Brave-Browser-Beta/User Data',
    'Library/Application Support/BraveSoftware/Brave-Browser-Nightly/User Data'
  ],
  linux: [
    '.config/BraveSoftware/Brave-Browser/User Data',
    '.config/BraveSoftware/Brave-Browser-Beta/User Data',
    '.config/BraveSoftware/Brave-Browser-Nightly/User Data'
  ]
};

const datePlate = $('#datePlate');
const telemetry = $('#telemetry');
const telemetryLink = $('#telemetryLink');
const telemetryState = $('#telemetryState');
const telemetryAnnounce = $('#telemetryAnnounce');
const statBlocked = $('#statBlocked');
const statBandwidth = $('#statBandwidth');
const statBandwidthUnit = $('#statBandwidthUnit');
const statTime = $('#statTime');
const statTimeUnit = $('#statTimeUnit');
const setShields = $('#setShields');
const setShieldsPath = $('#setShieldsPath');
const detectShieldsBtn = $('#detectShields');
const testShieldsBtn = $('#testShields');
const shieldsStatus = $('#shieldsStatus');

let shields = CORE.normalizeShields(null);
let shieldsState = 'off';
let shieldsMessage = 'TELEMETRY OFF';
let shieldsStatusKind = '';
let shieldsAnnouncement = '';
let lastShieldsStats = null;
let lastShieldsPath = '';
let lastShieldsSync = 0;
let shieldsRequest = 0;
let shieldsPollTimer = 0;
let shieldsUpdatedTimer = 0;
let shieldsPathTimer = 0;
let shieldsReady = false;

function setShieldsStatus(text, kind = '') {
  const next = text || 'TELEMETRY OFF';
  if (next === shieldsMessage && kind === shieldsStatusKind) return;
  shieldsMessage = next;
  shieldsStatusKind = kind;
  if (!shieldsStatus) return;
  shieldsStatus.textContent = next;
  shieldsStatus.classList.toggle('is-ok', kind === 'ok');
  shieldsStatus.classList.toggle('is-error', kind === 'error');
  shieldsStatus.classList.toggle('is-busy', kind === 'busy');
}

function setShieldsState(state, label) {
  shieldsState = state;
  if (!telemetry) return;
  telemetry.classList.toggle('is-linking', state === 'linking');
  telemetry.classList.toggle('is-live', state === 'live');
  telemetry.classList.toggle('is-error', state === 'error');
  telemetry.classList.toggle('is-stale', state === 'error' && !!lastShieldsStats);
  if (telemetryState) telemetryState.textContent = label;
}

function announceShields(text) {
  if (!telemetryAnnounce || text === shieldsAnnouncement) return;
  shieldsAnnouncement = text;
  telemetryAnnounce.textContent = text;
}

function stopShieldsPoll() {
  clearInterval(shieldsPollTimer);
  shieldsPollTimer = 0;
}

function scheduleShieldsPoll() {
  stopShieldsPoll();
  if (!shieldsReady || !shields.enabled || !shields.path || document.hidden) return;
  shieldsPollTimer = setInterval(() => {
    if (!shields.enabled || !shields.path || document.hidden) return;
    void refreshShields({ quiet: true });
  }, SHIELDS_POLL_MS);
}

function applyShieldsVisibility() {
  if (!telemetry || !datePlate) return;
  telemetry.hidden = !shields.enabled;
  datePlate.classList.toggle('has-telemetry', shields.enabled);
  if (!shields.enabled) {
    stopShieldsPoll();
    setShieldsState('off', 'OFF');
  } else if (shieldsReady) {
    scheduleShieldsPoll();
  }
}

function syncShieldsCalibration() {
  if (!setShields || !setShieldsPath) return;
  setShields.checked = shields.enabled;
  if (document.activeElement !== setShieldsPath) {
    setShieldsPath.value = shields.path;
    setShieldsPath.title = shields.path;
  }
}

function clearShieldsDisplay() {
  lastShieldsStats = null;
  lastShieldsPath = '';
  lastShieldsSync = 0;
  if (statBlocked) statBlocked.textContent = '—';
  if (statBandwidth) statBandwidth.textContent = '—';
  if (statBandwidthUnit) statBandwidthUnit.textContent = '';
  if (statTime) statTime.textContent = '—';
  if (statTimeUnit) statTimeUnit.textContent = '';
  setShieldsState('error', 'NO LINK');
}

function renderShieldsStats(stats) {
  const blocked = CORE.formatCount(stats.adsBlocked);
  const bandwidth = CORE.formatBytes(stats.bandwidthBytes);
  const saved = CORE.formatTimeSaved(stats.adsBlocked);
  const changed = new Set();
  const updates = [
    [statBlocked, blocked],
    [statBandwidth, bandwidth.value],
    [statBandwidthUnit, bandwidth.unit],
    [statTime, saved.value],
    [statTimeUnit, saved.unit]
  ];

  updates.forEach(([element, value]) => {
    if (!element || element.textContent === value) return;
    element.textContent = value;
    const stat = element.closest('.telemetry-stat');
    if (stat) changed.add(stat);
  });

  if (!changed.size) return;
  changed.forEach((stat) => {
    stat.classList.remove('is-updated');
    void stat.offsetWidth;
    stat.classList.add('is-updated');
  });
  clearTimeout(shieldsUpdatedTimer);
  shieldsUpdatedTimer = setTimeout(() => {
    if (!telemetry) return;
    telemetry.querySelectorAll('.telemetry-stat.is-updated').forEach((stat) => {
      stat.classList.remove('is-updated');
    });
  }, 950);
}

function renderShieldsLive(stats, path, { announce = false } = {}) {
  const wasLive = shieldsState === 'live';
  lastShieldsStats = stats;
  lastShieldsPath = path;
  lastShieldsSync = Date.now();
  renderShieldsStats(stats);
  setShieldsState('live', 'LIVE');

  const label = CORE.profileLabelFromPath(path) || 'BRAVE';
  if (telemetryLink) {
    const time = new Date(lastShieldsSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    telemetryLink.title = `Brave Shields · ${label} · synced ${time} · click to configure`;
  }
  setShieldsStatus(
    `LINKED · ${label.toUpperCase()} · ${CORE.formatCount(stats.adsBlocked)} BLOCKED`,
    'ok'
  );
  if (announce && !wasLive) {
    announceShields(`Shields live. ${CORE.formatCount(stats.adsBlocked)} trackers and ads blocked.`);
  }
  syncShieldsCalibration();
}

function renderShieldsError(message, path = '') {
  const hasData = !!lastShieldsStats && path === lastShieldsPath;
  if (!hasData) {
    lastShieldsStats = null;
    lastShieldsPath = '';
    lastShieldsSync = 0;
    if (statBlocked) statBlocked.textContent = '—';
    if (statBandwidth) statBandwidth.textContent = '—';
    if (statBandwidthUnit) statBandwidthUnit.textContent = '';
    if (statTime) statTime.textContent = '—';
    if (statTimeUnit) statTimeUnit.textContent = '';
  }
  setShieldsState('error', hasData ? 'STALE' : 'NO LINK');
  if (telemetryLink) telemetryLink.title = `Brave Shields · ${message} · click to configure`;
  setShieldsStatus(message, 'error');
  announceShields(`Shields link failed. ${message}.`);
  syncShieldsCalibration();
}

async function readShieldsPreferences(path) {
  const normalized = CORE.normalizePreferencesPath(path);
  if (!normalized) throw new Error('NO PREFERENCES PATH');
  const url = CORE.toFileUrl(normalized);
  if (!url) throw new Error('INVALID PREFERENCES PATH');

  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error('PREFERENCES UNREACHABLE');
  }
  if (response.status !== 200) throw new Error('PREFERENCES NOT FOUND');

  let raw;
  try {
    raw = JSON.parse(await response.text());
  } catch {
    throw new Error('PREFERENCES UNREADABLE');
  }
  const stats = CORE.extractBraveStats(raw);
  if (!stats) throw new Error('NO SHIELDS STATS IN PREFERENCES');
  return stats;
}

function encodeShieldsSegments(path) {
  return path.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
}

function joinShieldsUrl(base, relative) {
  return `${base.replace(/\/+$/, '')}/${encodeShieldsSegments(relative)}/`;
}

async function listShieldsDirectory(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return CORE.parseDirectoryListing(await response.text());
  } catch {
    return [];
  }
}

async function readShieldsProfileActivity(userDataUrl) {
  try {
    const response = await fetch(`${userDataUrl}Local%20State`, { cache: 'no-store' });
    if (response.status !== 200) return null;
    return CORE.extractBraveProfileActivity(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

function isShieldsProfile(name) {
  return /^(?:Default|Profile \d+)$/i.test(name);
}

async function collectShieldsCandidates() {
  const candidates = [];
  const skip = /^(?:all users|default|default user|public|shared|guest|lost\+found)$/i;

  for (const entry of SHIELDS_ROOTS) {
    const users = await listShieldsDirectory(entry.root);
    const userDirs = users
      .filter((item) => item.isDir)
      .map((item) => item.name)
      .filter((name) => name && !name.startsWith('.') && !skip.test(name))
      .slice(0, 8);

    for (const user of userDirs) {
      for (const relative of SHIELDS_BRAVE_PATHS[entry.kind]) {
        const userDataUrl = joinShieldsUrl(`${entry.root}${encodeURIComponent(user)}`, relative);
        const entries = await listShieldsDirectory(userDataUrl);
        const profiles = entries.filter((item) => item.isDir && isShieldsProfile(item.name));
        if (!profiles.length) continue;

        const activity = await readShieldsProfileActivity(userDataUrl);
        profiles.forEach((item) => {
          candidates.push({
            path: `${userDataUrl}${encodeURIComponent(item.name)}/Preferences`,
            profile: item.name,
            activity: activity && activity.active ? Number(activity.active[item.name]) || 0 : 0,
            lastUsed: !!activity && activity.lastUsed === item.name
          });
        });
        if (candidates.length >= SHIELDS_MAX_CANDIDATES) break;
      }
      if (candidates.length >= SHIELDS_MAX_CANDIDATES) break;
    }
    if (candidates.length >= SHIELDS_MAX_CANDIDATES) break;
  }

  return candidates.slice(0, SHIELDS_MAX_CANDIDATES);
}

async function detectBraveProfile() {
  if (!EXT) throw new Error('EXTENSION REQUIRED FOR FILE ACCESS');
  const candidates = await collectShieldsCandidates();
  if (!candidates.length) throw new Error('NO BRAVE PROFILE FOUND');

  const readable = [];
  for (const candidate of candidates) {
    try {
      readable.push({ ...candidate, stats: await readShieldsPreferences(candidate.path) });
    } catch { /* unreadable profile, keep scanning */ }
  }

  if (!readable.length) throw new Error('BRAVE PREFERENCES COULD NOT BE READ');
  readable.sort((a, b) => {
    if (b.activity !== a.activity) return b.activity - a.activity;
    if (a.lastUsed !== b.lastUsed) return a.lastUsed ? -1 : 1;
    if (b.stats.adsBlocked !== a.stats.adsBlocked) return b.stats.adsBlocked - a.stats.adsBlocked;
    return b.stats.bandwidthBytes - a.stats.bandwidthBytes;
  });
  return readable[0];
}

async function saveShields(patch, { note = '', noteKind = 'ok' } = {}) {
  const next = CORE.normalizeShields({ ...shields, ...patch });
  const changed = JSON.stringify(next) !== JSON.stringify(shields);
  shields = next;
  applyShieldsVisibility();
  syncShieldsCalibration();

  if (changed) {
    const ok = await writeKey(SHIELDS_KEY, shields);
    if (!ok) setShieldsStatus('COULD NOT SAVE SHIELDS SETTINGS', 'error');
  }
  if (note) setShieldsStatus(note, noteKind);
  return changed;
}

async function refreshShields({ detect = false, manual = false, quiet = false } = {}) {
  if (!shields.enabled && !manual) return null;
  if (!EXT) {
    setShieldsState('error', 'NO LINK');
    setShieldsStatus('EXTENSION REQUIRED FOR FILE ACCESS', 'error');
    return null;
  }

  const request = ++shieldsRequest;
  let path = CORE.normalizePreferencesPath(shields.path);

  if (!quiet) {
    setShieldsState('linking', 'LINKING');
    setShieldsStatus(
      detect || !path ? 'SCANNING FOR BRAVE PREFERENCES…' : 'READING BRAVE PREFERENCES…',
      'busy'
    );
  }

  try {
    let stats = null;
    if (detect || !path) {
      const found = await detectBraveProfile();
      if (request !== shieldsRequest) return null;
      path = found.path;
      stats = found.stats;
      if (path !== shields.path) {
        await saveShields({ path });
        if (request !== shieldsRequest) return null;
      }
    }
    if (!stats) stats = await readShieldsPreferences(path);
    if (request !== shieldsRequest) return null;
    // A poll that started before the toggle was switched off must not paint.
    if (!shields.enabled && !manual) return null;
    renderShieldsLive(stats, path, { announce: manual || shieldsState !== 'live' });
    return stats;
  } catch (err) {
    if (request !== shieldsRequest) return null;
    renderShieldsError(err && err.message ? err.message : 'SHIELDS LINK FAILED', path);
    return null;
  }
}

async function testShieldsLink() {
  clearTimeout(shieldsPathTimer);
  shieldsPathTimer = 0;
  const path = CORE.normalizePreferencesPath(setShieldsPath ? setShieldsPath.value : shields.path);
  if (!path) {
    setShieldsStatus('ENTER A PREFERENCES PATH OR PRESS DETECT', 'error');
    if (setShieldsPath) setShieldsPath.focus({ preventScroll: true });
    return null;
  }
  if (!EXT) {
    setShieldsStatus('EXTENSION REQUIRED FOR FILE ACCESS', 'error');
    return null;
  }

  const request = ++shieldsRequest;
  setShieldsState('linking', 'LINKING');
  setShieldsStatus('READING BRAVE PREFERENCES…', 'busy');

  try {
    const stats = await readShieldsPreferences(path);
    if (request !== shieldsRequest) return null;
    if (path !== shields.path) await saveShields({ path });
    if (request !== shieldsRequest) return null;
    renderShieldsLive(stats, path, { announce: true });
    return stats;
  } catch (err) {
    if (request !== shieldsRequest) return null;
    renderShieldsError(err && err.message ? err.message : 'SHIELDS LINK FAILED', path);
    return null;
  }
}

async function detectShieldsLink() {
  clearTimeout(shieldsPathTimer);
  shieldsPathTimer = 0;
  if (!EXT) {
    setShieldsStatus('EXTENSION REQUIRED FOR FILE ACCESS', 'error');
    return null;
  }

  const request = ++shieldsRequest;
  setShieldsState('linking', 'SCANNING');
  setShieldsStatus('SCANNING FOR BRAVE PROFILES…', 'busy');

  try {
    const found = await detectBraveProfile();
    if (request !== shieldsRequest) return null;
    await saveShields({ path: found.path });
    if (request !== shieldsRequest) return null;
    renderShieldsLive(found.stats, found.path, { announce: true });
    return found;
  } catch (err) {
    if (request !== shieldsRequest) return null;
    renderShieldsError(err && err.message ? err.message : 'SHIELDS LINK FAILED', '');
    return null;
  }
}

async function loadShields() {
  const raw = await readKey(SHIELDS_KEY);
  shields = CORE.normalizeShields(raw);
  applyShieldsVisibility();
  syncShieldsCalibration();

  if (!shields.enabled) {
    setShieldsStatus('TELEMETRY OFF', '');
  } else if (!EXT) {
    setShieldsStatus('EXTENSION REQUIRED FOR FILE ACCESS', 'error');
  } else if (shields.path) {
    const label = CORE.profileLabelFromPath(shields.path).toUpperCase() || 'CUSTOM';
    setShieldsStatus(`PATH SET · ${label} · SYNCING`, 'busy');
  } else {
    setShieldsStatus('AUTO-DETECT ARMED · SCANNING FOR BRAVE', 'busy');
  }
}

function initShields() {
  shieldsReady = true;
  applyShieldsVisibility();
  syncShieldsCalibration();

  telemetryLink.addEventListener('click', () => openCalibration({ section: 'shields' }));

  setShields.addEventListener('change', () => {
    const enabled = setShields.checked;
    if (!enabled) {
      // Cancel an in-flight read before it can repaint the hidden rail.
      ++shieldsRequest;
      stopShieldsPoll();
    }
    void saveShields({ enabled }, {
      note: enabled ? 'TELEMETRY ON · LINKING' : 'TELEMETRY OFF',
      noteKind: enabled ? 'busy' : ''
    }).then(() => {
      if (enabled) void refreshShields({ detect: !shields.path, manual: true });
    });
  });

  setShieldsPath.addEventListener('input', () => {
    clearTimeout(shieldsPathTimer);
    shieldsPathTimer = setTimeout(() => {
      const path = CORE.normalizePreferencesPath(setShieldsPath.value);
      if (!path) {
        clearShieldsDisplay();
        setShieldsStatus('NO PREFERENCES PATH · PRESS DETECT', 'error');
      }
      void saveShields({ path });
    }, 700);
  });

  setShieldsPath.addEventListener('change', () => {
    clearTimeout(shieldsPathTimer);
    const path = CORE.normalizePreferencesPath(setShieldsPath.value);
    if (!path) {
      clearShieldsDisplay();
      setShieldsStatus('NO PREFERENCES PATH · PRESS DETECT', 'error');
    }
    void saveShields({ path });
  });

  setShieldsPath.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(shieldsPathTimer);
    void testShieldsLink();
  });

  detectShieldsBtn.addEventListener('click', () => { void detectShieldsLink(); });
  testShieldsBtn.addEventListener('click', () => { void testShieldsLink(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopShieldsPoll();
      return;
    }
    if (!shields.enabled) return;
    if (!shields.path) void refreshShields({ detect: true, quiet: true });
    else void refreshShields({ quiet: true });
    scheduleShieldsPoll();
  });

  if (shields.enabled && EXT) {
    void refreshShields({ detect: !shields.path });
  }
}

/* Shields settings are machine-local, but open tabs should still agree when
   one of them toggles the rail or changes the Preferences path. */
function initShieldsSync() {
  const adopt = (raw) => {
    const incoming = CORE.normalizeShields(raw);
    if (JSON.stringify(incoming) === JSON.stringify(shields)) return;
    const wasEnabled = shields.enabled;
    const previousPath = shields.path;
    shields = incoming;
    applyShieldsVisibility();
    syncShieldsCalibration();

    if (!incoming.enabled) {
      ++shieldsRequest;
      stopShieldsPoll();
      setShieldsStatus('TELEMETRY OFF', '');
      return;
    }

    if (!wasEnabled || incoming.path !== previousPath) {
      const label = CORE.profileLabelFromPath(incoming.path).toUpperCase() || 'CUSTOM';
      setShieldsStatus(
        incoming.path ? `PATH SET · ${label} · SYNCING` : 'AUTO-DETECT ARMED · SCANNING FOR BRAVE',
        'busy'
      );
      void refreshShields({ detect: !incoming.path, manual: true });
    }
  };

  if (EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SHIELDS_KEY]) return;
      adopt(changes[SHIELDS_KEY].newValue);
    });
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key !== SHIELDS_KEY) return;
      try { adopt(JSON.parse(e.newValue || 'null')); } catch { /* malformed cross-tab value */ }
    });
  }
}

/* ---------- command console ---------- */

const consoleDialog = $('#consoleDialog');
const openConsoleBtn = $('#openConsole');
const consoleCloseBtn = $('#consoleClose');
const consoleInput = $('#consoleInput');
const consoleResults = $('#consoleResults');
const consoleHint = $('#consoleHint');
const consoleAnnounce = $('#consoleAnnounce');

const CONSOLE_HINT_DEFAULT = consoleHint.textContent;
let consoleRowsCache = [];
let consoleActive = -1;
let consoleHintTimer = 0;

const CONSOLE_THEME_ALIASES = {
  green: 'phosphor',
  phosphor: 'phosphor',
  amber: 'plasma',
  orange: 'plasma',
  plasma: 'plasma',
  blue: 'ice',
  cyan: 'ice',
  ice: 'ice',
  red: 'red'
};

const CONSOLE_ENGINE_ALIASES = {
  google: 'google',
  ddg: 'duckduckgo',
  duck: 'duckduckgo',
  duckduckgo: 'duckduckgo',
  bing: 'bing',
  yt: 'youtube',
  youtube: 'youtube',
  perplexity: 'perplexity',
  pplx: 'perplexity'
};

function parseDurationInput(raw) {
  const source = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!source) return 0;
  if (/^\d+(?::\d{1,2}){1,2}$/.test(source)) {
    const parts = source.split(':').map(Number);
    if (parts.slice(1).some((part) => part > 59)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  if (/^\d+(?:\.\d+)?$/.test(source)) return Math.round(Number(source) * 60);

  const units = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let matched = false;
  let consumed = '';
  let match;
  while ((match = units.exec(source))) {
    matched = true;
    consumed += match[0];
    const value = Number(match[1]);
    const unit = match[2].charAt(0);
    total += unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
  }
  if (!matched) return 0;
  if (consumed.replace(/\s+/g, '').length !== source.replace(/\s+/g, '').length) return 0;
  return Math.round(total);
}

function setTimerFromConsole(seconds) {
  const total = Math.min(99 * 3600 + 59 * 60 + 59, Math.max(1, Math.round(seconds)));
  const engine = timers.timer;
  engine.total = total;
  engine.remaining = total;
  engine.running = false;
  engine.finished = false;
  engine.endAt = 0;
  inH.value = pad2(Math.floor(total / 3600));
  inM.value = pad2(Math.floor((total % 3600) / 60));
  inS.value = pad2(total % 60);
  setInputsDisabled(false);
  if (tubeMode !== 'timer') setMode('timer');
  startTimer();
  return total;
}

function startFocusFromConsole() {
  if (alarmState.ringing) throw new Error('SILENCE THE ACTIVE ALARM FIRST');
  if (tubeMode !== 'focus') setMode('focus');
  if (timers.focus.running) throw new Error('FOCUS IS ALREADY RUNNING');
  startTimer();
}

function onOffValue(raw, current) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'toggle') return !current;
  if (/^(on|true|1|yes)$/.test(value)) return true;
  if (/^(off|false|0|no)$/.test(value)) return false;
  throw new Error('USE on OR off');
}

function themeLabel(id) {
  const theme = CORE.THEMES.find((entry) => entry.id === id);
  return theme ? theme.label.toUpperCase() : id.toUpperCase();
}

function engineLabel(id) {
  const engine = CORE.SEARCH_ENGINES[id];
  return engine ? engine.label.toUpperCase() : id.toUpperCase();
}

const CONSOLE_COMMANDS = [
  {
    id: 'timer',
    aliases: ['t'],
    title: 'TIMER',
    hint: 'timer 10 · timer 1:30 · timer pause · timer reset',
    run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        setMode('timer');
        return 'TIMER MODE';
      }
      if (/^(pause|stop)$/.test(value)) {
        if (!timers.timer.running) throw new Error('TIMER IS NOT RUNNING');
        setMode('timer');
        pauseTimer();
        return 'TIMER PAUSED';
      }
      if (value === 'reset') {
        setMode('timer');
        resetTimer();
        return 'TIMER RESET';
      }
      if (alarmState.ringing) throw new Error('SILENCE THE ACTIVE ALARM FIRST');
      const seconds = parseDurationInput(value);
      if (!seconds) throw new Error('USE timer 10 OR timer 1:30');
      setTimerFromConsole(seconds);
      return `TIMER ${fmtHMS(seconds)} STARTED`;
    }
  },
  {
    id: 'focus',
    aliases: ['f'],
    title: 'FOCUS 25',
    hint: 'focus · focus pause · focus reset',
    run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        startFocusFromConsole();
        return 'FOCUS 25 STARTED';
      }
      if (/^(pause|stop)$/.test(value)) {
        if (!timers.focus.running) throw new Error('FOCUS IS NOT RUNNING');
        setMode('focus');
        pauseTimer();
        return 'FOCUS PAUSED';
      }
      if (value === 'reset') {
        setMode('focus');
        resetTimer();
        return 'FOCUS RESET';
      }
      throw new Error('USE focus, focus pause OR focus reset');
    }
  },
  {
    id: 'task',
    aliases: ['todo'],
    title: 'TASK',
    hint: 'task buy milk · leave blank to open the manifest',
    run(args) {
      const text = args.trim();
      if (!text) {
        openManifest();
        return null;
      }
      if (!addTask(text, { focus: false })) throw new Error('TASK COULD NOT BE LOGGED');
      return `TASK LOGGED · ${text.slice(0, 36)}`;
    }
  },
  {
    id: 'theme',
    aliases: ['colour', 'color'],
    title: 'THEME',
    hint: 'theme green · amber · blue · red',
    run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        openCalibration({ section: 'time' });
        return null;
      }
      const id = CONSOLE_THEME_ALIASES[value] || value;
      if (!CORE.THEMES.some((entry) => entry.id === id)) {
        throw new Error(`UNKNOWN THEME · ${value.toUpperCase()}`);
      }
      updateSettings({ theme: id });
      return `TUBE COLOUR · ${themeLabel(id)}`;
    }
  },
  {
    id: 'open',
    aliases: ['o'],
    title: 'OPEN',
    hint: 'open github · open example.com',
    run(args) {
      const target = args.trim();
      if (!target) {
        requestAnimationFrame(() => {
          closeConsole();
          searchInput.focus({ preventScroll: true });
        });
        return null;
      }
      const lower = target.toLowerCase();
      const site = sites.find((entry) => entry.name.toLowerCase() === lower) ||
        sites.find((entry) => entry.name.toLowerCase().includes(lower));
      if (site) {
        setTimeout(() => go(site.url), 80);
        return `OPENING ${site.name.toUpperCase()}`;
      }
      const direct = normalizeQuery(target);
      if (direct) {
        setTimeout(() => go(direct), 80);
        return `OPENING ${target.toUpperCase()}`;
      }
      throw new Error(`NO KEY NAMED ${target.toUpperCase()}`);
    }
  },
  {
    id: 'search',
    aliases: ['s', 'find'],
    title: 'SEARCH',
    hint: 'search quiet keyboards',
    run(args) {
      const query = args.trim();
      if (!query) {
        requestAnimationFrame(() => {
          closeConsole();
          searchInput.focus({ preventScroll: true });
        });
        return null;
      }
      setTimeout(() => go(CORE.searchUrl(settings.searchEngine, query)), 80);
      return `SEARCHING · ${query.slice(0, 36)}`;
    }
  },
  {
    id: 'settings',
    aliases: ['calibration', 'config', 'preferences'],
    title: 'SETTINGS',
    hint: 'settings · settings alarm · settings tminus',
    run(args) {
      const value = args.trim().toLowerCase();
      const sections = {
        time: 'time',
        clock: 'time',
        display: 'time',
        alarm: 'alarm',
        tone: 'alarm',
        search: 'search',
        engine: 'search',
        tminus: 'tminus',
        events: 'tminus',
        shields: 'shields',
        stats: 'shields',
        telemetry: 'shields',
        brave: 'shields',
        data: 'data',
        archive: 'data'
      };
      openCalibration({ section: sections[value] || '' });
      return null;
    }
  },
  {
    id: 'engine',
    aliases: ['provider'],
    title: 'SEARCH ENGINE',
    hint: 'engine duckduckgo · google · bing · youtube',
    run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        openCalibration({ section: 'search' });
        return null;
      }
      const id = CONSOLE_ENGINE_ALIASES[value] || value;
      if (!CORE.SEARCH_ENGINES[id]) throw new Error(`UNKNOWN ENGINE · ${value.toUpperCase()}`);
      updateSettings({ searchEngine: id });
      clearSuggestions();
      return `SEARCH · ${engineLabel(id)}`;
    }
  },
  {
    id: 'clock',
    title: 'CLOCK',
    hint: 'clock 24 · clock 12',
    run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        openCalibration({ section: 'time' });
        return null;
      }
      if (value !== '24' && value !== '24h' && value !== '12' && value !== '12h') {
        throw new Error('USE clock 24 OR clock 12');
      }
      const clock24 = value === '24' || value === '24h';
      updateSettings({ clock24 });
      lastTubeSec = -1;
      tick();
      return clock24 ? 'CLOCK · 24-HOUR' : 'CLOCK · 12-HOUR';
    }
  },
  {
    id: 'seconds',
    title: 'SECONDS',
    hint: 'seconds on · seconds off',
    run(args) {
      const showSeconds = onOffValue(args, settings.showSeconds);
      updateSettings({ showSeconds });
      lastTubeSec = -1;
      tick();
      return `SECONDS ${showSeconds ? 'ON' : 'OFF'}`;
    }
  },
  {
    id: 'dim',
    title: 'DIM',
    hint: 'dim on · dim off · dim toggle',
    run(args) {
      const dim = onOffValue(args, settings.dim);
      updateSettings({ dim });
      return `CHASSIS DIM ${dim ? 'ON' : 'OFF'}`;
    }
  },
  {
    id: 'suggestions',
    aliases: ['suggest'],
    title: 'SUGGESTIONS',
    hint: 'suggestions on · suggestions off',
    run(args) {
      const suggestions = onOffValue(args, settings.suggestions);
      updateSettings({ suggestions });
      if (!suggestions) clearSuggestions();
      const scope = suggestions && settings.searchEngine !== 'google' ? ' · GOOGLE ONLY' : '';
      return `LIVE SUGGESTIONS ${suggestions ? 'ON' : 'OFF'}${scope}`;
    }
  },
  {
    id: 'shields',
    aliases: ['stats', 'telemetry', 'brave'],
    title: 'SHIELDS',
    hint: 'shields · shields on · off · detect · refresh',
    async run(args) {
      const value = args.trim().toLowerCase();
      if (!value) {
        openCalibration({ section: 'shields' });
        return null;
      }
      if (/^(detect|find|scan)$/.test(value)) {
        const found = await detectShieldsLink();
        if (!found) throw new Error(shieldsMessage || 'NO BRAVE PROFILE FOUND');
        return `SHIELDS · ${CORE.profileLabelFromPath(found.path).toUpperCase()} · ${CORE.formatCount(found.stats.adsBlocked)} BLOCKED`;
      }
      if (/^(refresh|sync|reload)$/.test(value)) {
        const stats = await refreshShields({ manual: true });
        if (!stats) throw new Error(shieldsMessage || 'SHIELDS LINK FAILED');
        return `SHIELDS · ${CORE.formatCount(stats.adsBlocked)} BLOCKED`;
      }
      const enabled = onOffValue(value, shields.enabled);
      await saveShields({ enabled }, {
        note: enabled ? 'TELEMETRY ON · LINKING' : 'TELEMETRY OFF',
        noteKind: enabled ? 'busy' : ''
      });
      if (enabled) void refreshShields({ detect: !shields.path, manual: true });
      return `SHIELDS TELEMETRY ${enabled ? 'ON' : 'OFF'}`;
    }
  }
];

function commandRow(command, args) {
  return {
    title: args ? `${command.title} · ${args}` : command.title,
    hint: command.hint,
    kind: 'RUN',
    complete: command.id,
    run: () => command.run(args)
  };
}

function scoreConsoleCommands(head) {
  const needle = head.toLowerCase();
  if (!needle) return [];
  return CONSOLE_COMMANDS
    .map((command) => {
      const candidates = [command.id, command.title].concat(command.aliases || []);
      let score = -1;
      candidates.forEach((candidate) => {
        score = Math.max(score, CORE.fuzzyScore(needle, candidate));
      });
      return score >= 0 ? { command, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function consoleRows(raw) {
  const query = raw.trim();
  if (!query) return CONSOLE_COMMANDS.slice(0, 9).map((command) => commandRow(command, ''));

  const rows = [];
  const calc = calcValueFor(query);
  if (calc != null) {
    rows.push({
      title: `= ${calc}`,
      hint: 'Copy result to clipboard',
      kind: 'COPY',
      calc: true,
      keepOpen: true,
      run: async () => {
        const ok = await copyText(calc);
        return ok ? `COPIED ${calc}` : 'COPY FAILED';
      }
    });
  }

  const direct = normalizeQuery(query);
  if (direct) {
    rows.push({
      title: `OPEN ${direct.replace(/^https?:\/\//, '')}`,
      hint: direct,
      kind: 'OPEN',
      run: () => { go(direct); return null; }
    });
  }

  const space = query.search(/\s/);
  const head = space === -1 ? query : query.slice(0, space);
  const args = space === -1 ? '' : query.slice(space + 1).trim();
  scoreConsoleCommands(head).slice(0, 6).forEach(({ command }) => {
    rows.push(commandRow(command, args));
  });

  if (!rows.length) {
    rows.push({
      title: `SEARCH ${query}`,
      hint: `via ${searchEngineMeta().label}`,
      kind: 'SEARCH',
      run: () => {
        go(CORE.searchUrl(settings.searchEngine, query));
        return null;
      }
    });
  }

  return rows.slice(0, 9);
}

function flashConsoleHint(text) {
  consoleHint.textContent = text;
  if (consoleAnnounce) consoleAnnounce.textContent = text;
  clearTimeout(consoleHintTimer);
  consoleHintTimer = setTimeout(() => {
    consoleHint.textContent = CONSOLE_HINT_DEFAULT;
  }, 3000);
}

function resetConsoleHint() {
  clearTimeout(consoleHintTimer);
  consoleHint.textContent = CONSOLE_HINT_DEFAULT;
}

function setConsoleActive(index, scroll = true) {
  if (!consoleRowsCache.length) {
    consoleActive = -1;
    consoleInput.removeAttribute('aria-activedescendant');
    return;
  }
  consoleActive = (index + consoleRowsCache.length) % consoleRowsCache.length;
  [...consoleResults.children].forEach((row, idx) => {
    row.classList.toggle('active', idx === consoleActive);
    row.setAttribute('aria-selected', String(idx === consoleActive));
  });
  if (scroll) {
    const active = consoleResults.children[consoleActive];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  consoleInput.setAttribute('aria-activedescendant', `console-row-${consoleActive}`);
}

function renderConsole(raw) {
  consoleRowsCache = consoleRows(raw);
  consoleResults.textContent = '';

  consoleRowsCache.forEach((row, index) => {
    const item = document.createElement('li');
    item.className = `console-row${row.calc ? ' is-calc' : ''}`;
    item.id = `console-row-${index}`;
    item.setAttribute('role', 'option');

    const title = document.createElement('span');
    title.className = 'console-row-title';
    title.textContent = row.title;

    const hint = document.createElement('span');
    hint.className = 'console-row-hint';
    hint.textContent = row.hint;

    const kind = document.createElement('span');
    kind.className = 'console-row-kind';
    kind.textContent = row.kind;

    item.append(title, hint, kind);
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('mouseenter', () => setConsoleActive(index, false));
    item.addEventListener('click', () => { void runConsoleRow(row); });
    consoleResults.appendChild(item);
  });

  consoleInput.setAttribute('aria-expanded', String(consoleRowsCache.length > 0));
  setConsoleActive(0, false);
}

async function runConsoleRow(row) {
  if (!row) return;
  try {
    const result = await row.run();
    if (row.keepOpen) {
      if (result) flashConsoleHint(result);
      return;
    }
    closeConsole();
    if (result) showToast(String(result).toUpperCase().slice(0, 90));
  } catch (err) {
    flashConsoleHint(String(err && err.message ? err.message : 'COMMAND FAILED').toUpperCase());
  }
}

function openConsole() {
  if (calDialog.open) calDialog.close();
  if (consoleDialog.open) {
    consoleInput.focus({ preventScroll: true });
    consoleInput.select();
    return;
  }
  consoleInput.value = '';
  resetConsoleHint();
  renderConsole('');
  consoleDialog.showModal();
  requestAnimationFrame(() => {
    consoleInput.focus({ preventScroll: true });
    consoleInput.select();
  });
}

function closeConsole() {
  if (consoleDialog.open) consoleDialog.close();
}

openConsoleBtn.addEventListener('click', openConsole);
consoleCloseBtn.addEventListener('click', closeConsole);

consoleDialog.addEventListener('click', (e) => {
  if (e.target === consoleDialog) closeConsole();
});

consoleDialog.addEventListener('close', () => {
  resetConsoleHint();
});

consoleInput.addEventListener('input', () => {
  resetConsoleHint();
  renderConsole(consoleInput.value);
});

consoleInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setConsoleActive(consoleActive + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setConsoleActive(consoleActive - 1);
  } else if (e.key === 'Tab') {
    const row = consoleRowsCache[consoleActive];
    if (row && row.complete) {
      e.preventDefault();
      consoleInput.value = `${row.complete} `;
      renderConsole(consoleInput.value);
      consoleInput.setSelectionRange(consoleInput.value.length, consoleInput.value.length);
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void runConsoleRow(consoleRowsCache[consoleActive]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeConsole();
  }
});

function initConsole() {
  renderConsole('');
}

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  const typing = /^(INPUT|TEXTAREA)$/.test(tag);

  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openConsole();
    return;
  }
  if (calDialog.open || consoleDialog.open) return;

  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === ':' || e.key === ';') {
      e.preventDefault();
      openConsole();
      return;
    }
    if (e.key === ',') {
      e.preventDefault();
      openCalibration();
      return;
    }
  }

  if (e.key === 'Escape' && manifestOpen &&
    (taskModule.contains(document.activeElement) || document.activeElement === document.body)) {
    e.preventDefault();
    closeManifest();
    return;
  }
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    if (manifestOpen) taskInput.focus({ preventScroll: true });
    else openManifest();
    return;
  }
  if (manifestOpen && taskModule.contains(document.activeElement)) return;

  if (e.key === '/' && document.activeElement !== searchInput && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (e.key === 'Escape' && servicePanel.classList.contains('open')) {
    togglePanel(false);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    const site = sites[idx];
    if (site && site.url) {
      e.preventDefault();
      window.location.href = site.url;
    }
  }
});

/* ---------- boot ---------- */

(async function boot() {
  buildClock();
  renderDate();
  const [stored] = await Promise.all([
    store.get(),
    loadSettings(),
    initCountdowns(),
    initManifest(),
    restoreTimers(),
    loadShields()
  ]);
  sites = Array.isArray(stored) ? stored : DEFAULT_SITES.slice();
  if (!Array.isArray(stored)) await store.set(sites);
  renderKeys();
  initCalibration();
  initShields();
  initShieldsSync();
  initConsole();
  initSettingsSync();
  initSitesSync();
  initTimersSync();
  if (SW) {
    // Adopt worker truth: a timer that expired while no tab was open shows
    // the SILENCE strip; an in-flight timer is re-armed with the worker.
    try {
      const res = await sendAlarmMsg({ type: 'GET_ALARM_STATE' });
      if (res && res.state && res.state.ringing) {
        const key = res.state.key === 'focus' ? 'focus' : 'timer';
        const eng = timers[key];
        eng.running = false;
        eng.remaining = 0;
        eng.finished = true;
        if (tubeMode === key) {
          setInputsDisabled(false);
          renderTimerDigits(0);
        }
        applyAlarmState(res.state, 'worker');
      } else {
        const running = ['timer', 'focus'].filter((key) => timers[key].running);
        if (running.length) {
          running.forEach((key) => {
            void sendAlarmMsg({ type: 'ARM_ALARM', key, endAt: timers[key].endAt });
          });
        } else {
          void sendAlarmMsg({ type: 'DISARM_ALARM' });
        }
      }
    } catch { /* worker sync is best-effort */ }
  }
  const tTotal = timers.timer.total;
  inH.value = pad2(Math.floor(tTotal / 3600));
  inM.value = pad2(Math.floor((tTotal % 3600) / 60));
  inS.value = pad2(tTotal % 60);
  startClock();
  updateIndicators();
  void initBatteryStatus();
  requestAnimationFrame(() => {
    document.body.classList.add('booted');
    setTimeout(() => {
      document.body.querySelectorAll('.glass').forEach((g) => {
        g.classList.remove('ignite');
        g.style.animationDelay = '';
      });
    }, 1800);
  });
})();
