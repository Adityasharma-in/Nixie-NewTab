'use strict';

/* Nixie alarm service worker — owns wall-clock timer expiry so the alarm
   rings even when no new-tab page is open. Each engine (timer/focus) has its
   own one-shot alarm and armed entry so one can finish while the other runs.
   State machine per engine: armed -> ringing (beep loop + banner) -> cleared. */

const ALARM_STORE_KEY = 'nixie.alarm';
const ARMED_STORE_KEY = 'nixie.armed';
const TIMERS_STORE_KEY = 'nixie.timers';
const RING_PREFIX = 'nixie-ring-';
const CAP_NAME = 'nixie-ring-cap';
const RING_CAP_MS = 10 * 60 * 1000; // beep loop auto-stops; SILENCE in a new tab still required
const KEYS = ['timer', 'focus'];

const labelFor = (key) => (key === 'focus' ? 'FOCUS 25' : 'TIMER');
const ringName = (key) => `${RING_PREFIX}${key}`;
const normalizeKey = (key) => (key === 'focus' ? 'focus' : key === 'timer' ? 'timer' : null);

async function readAlarm() {
  try {
    const data = await chrome.storage.local.get(ALARM_STORE_KEY);
    return data[ALARM_STORE_KEY] || null;
  } catch { return null; }
}

async function writeAlarm(state) {
  try {
    if (state) await chrome.storage.local.set({ [ALARM_STORE_KEY]: state });
    else await chrome.storage.local.remove(ALARM_STORE_KEY);
  } catch { /* persistence is best-effort */ }
}

function isArmedEntry(value) {
  return value && typeof value === 'object' && Number.isFinite(+value.endAt) && +value.endAt > 0;
}

async function readArmed() {
  try {
    const data = await chrome.storage.local.get([ARMED_STORE_KEY, ALARM_STORE_KEY]);
    const raw = data[ARMED_STORE_KEY];
    const armed = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      KEYS.forEach((key) => {
        if (isArmedEntry(raw[key])) {
          armed[key] = { endAt: Math.round(+raw[key].endAt), armedAt: Math.round(+raw[key].armedAt) || Date.now() };
        }
      });
    } else {
      // Migrate the 1.2 single-entry state where `nixie.alarm` held a pending timer.
      const legacy = data[ALARM_STORE_KEY];
      if (legacy && !legacy.ringing && normalizeKey(legacy.key) && isArmedEntry(legacy)) {
        armed[legacy.key] = { endAt: Math.round(+legacy.endAt), armedAt: Math.round(+legacy.armedAt) || Date.now() };
      }
    }
    return armed;
  } catch { return {}; }
}

async function writeArmed(armed) {
  const clean = {};
  KEYS.forEach((key) => {
    if (isArmedEntry(armed[key])) {
      clean[key] = { endAt: Math.round(+armed[key].endAt), armedAt: Math.round(+armed[key].armedAt) || Date.now() };
    }
  });
  try {
    if (Object.keys(clean).length) await chrome.storage.local.set({ [ARMED_STORE_KEY]: clean });
    else await chrome.storage.local.remove(ARMED_STORE_KEY);
  } catch { /* persistence is best-effort */ }
}

/* Mirror completion into the shared timer payload so reopened tabs render DONE. */
async function markEngineFinished(key) {
  try {
    const data = await chrome.storage.local.get(TIMERS_STORE_KEY);
    const payload = data[TIMERS_STORE_KEY];
    if (!payload || !payload[key]) return;
    payload[key] = { ...payload[key], running: false, remaining: 0, finished: true, endAt: 0, updatedAt: Date.now() };
    await chrome.storage.local.set({ [TIMERS_STORE_KEY]: payload });
  } catch { /* best-effort */ }
}

async function offscreenExists() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      return await chrome.offscreen.hasDocument();
    }
    if (chrome.runtime && chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length > 0;
    }
  } catch { /* fall through */ }
  return false;
}

async function ensureOffscreen() {
  try {
    if (await offscreenExists()) return true;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Loop the timer-complete alarm tone until silenced in a new tab.'
    });
    return true;
  } catch { return false; }
}

async function closeOffscreen() {
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch { /* best-effort */ }
}

async function tellOffscreen(type) {
  try { await chrome.runtime.sendMessage({ type }); } catch { /* no listeners */ }
}

async function broadcast(state) {
  try { await chrome.runtime.sendMessage({ type: 'ALARM_STATE', state }); }
  catch { /* no open pages */ }
}

async function stopSound() {
  try { await chrome.alarms.clear(CAP_NAME); } catch { /* best-effort */ }
  await tellOffscreen('STOP_BEEP');
  await closeOffscreen();
}

async function startRinging(entry) {
  const key = normalizeKey(entry.key) || 'timer';
  const startedAt = Date.now();
  const endAt = Number.isFinite(+entry.endAt) ? +entry.endAt : startedAt;
  // Measure lateness from expiry, not from when the timer was armed. A normal
  // 25-minute focus session is not an overdue alarm.
  const capped = startedAt - endAt >= RING_CAP_MS;
  const state = { ringing: true, key, label: labelFor(key), startedAt, capped };
  await writeAlarm(state);
  await markEngineFinished(key);
  if (!capped) {
    if (await ensureOffscreen()) await tellOffscreen('START_BEEP');
    try { await chrome.alarms.create(CAP_NAME, { when: startedAt + RING_CAP_MS }); } catch { /* best-effort */ }
  }
  await broadcast(state);
}

async function silence() {
  await stopSound();
  await writeAlarm(null);
  await broadcast({ ringing: false });
}

async function disarm(key) {
  const keys = key ? [key] : KEYS;
  try {
    await Promise.all(keys.map((name) => chrome.alarms.clear(ringName(name))));
  } catch { /* best-effort */ }
  const armed = await readArmed();
  keys.forEach((name) => { delete armed[name]; });
  await writeArmed(armed);
  // Do not clear a ring for the other engine.
  const current = await readAlarm();
  if (!current || !current.ringing) await broadcast({ ringing: false });
}

function alarmKeyFromName(name) {
  if (typeof name !== 'string' || !name.startsWith(RING_PREFIX)) return null;
  return normalizeKey(name.slice(RING_PREFIX.length));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CAP_NAME) {
    const state = await readAlarm();
    if (state && state.ringing && !state.capped) {
      state.capped = true;
      await writeAlarm(state);
      await tellOffscreen('STOP_BEEP');
      await broadcast(state);
    }
    return;
  }

  const key = alarmKeyFromName(alarm.name);
  if (!key) return;
  const armed = await readArmed();
  const entry = armed[key];
  if (!entry) {
    try { await chrome.alarms.clear(alarm.name); } catch { /* best-effort */ }
    return;
  }
  delete armed[key];
  await writeArmed(armed);
  await startRinging({ key, endAt: entry.endAt, armedAt: entry.armedAt });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== 'string') { sendResponse({ ok: false }); return; }
    switch (msg.type) {
      case 'ARM_ALARM': {
        const endAt = Math.round(+msg.endAt);
        const key = normalizeKey(msg.key);
        if (!key || !Number.isFinite(endAt) || endAt <= Date.now()) { sendResponse({ ok: false }); return; }
        const armed = await readArmed();
        armed[key] = { endAt, armedAt: Date.now() };
        await writeArmed(armed);
        try { await chrome.alarms.create(ringName(key), { when: endAt }); } catch { /* best-effort */ }
        sendResponse({ ok: true });
        return;
      }
      case 'DISARM_ALARM': {
        await disarm(normalizeKey(msg.key));
        sendResponse({ ok: true });
        return;
      }
      case 'SILENCE_ALARM': {
        await silence();
        sendResponse({ ok: true });
        return;
      }
      case 'GET_ALARM_STATE': {
        const state = await readAlarm();
        const armed = await readArmed();
        sendResponse({
          ok: true,
          state: state && state.ringing ? state : { ringing: false, armed }
        });
        return;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

/* Recreate one-shot alarms that Chrome dropped (extension update/restart) and
   resume a ring that was active when the browser closed. */
async function reconcileAlarms() {
  const state = await readAlarm();
  if (state && state.ringing) {
    const elapsed = Date.now() - (state.startedAt || Date.now());
    if (elapsed >= RING_CAP_MS) {
      if (!state.capped) {
        state.capped = true;
        await writeAlarm(state);
      }
    } else {
      if (await ensureOffscreen()) await tellOffscreen('START_BEEP');
      try { await chrome.alarms.create(CAP_NAME, { when: state.startedAt + RING_CAP_MS }); } catch { /* best-effort */ }
    }
  }

  const armed = await readArmed();
  let changed = false;
  for (const key of KEYS) {
    const entry = armed[key];
    if (!entry) continue;
    delete armed[key];
    changed = true;
    if (entry.endAt <= Date.now()) await startRinging({ key, endAt: entry.endAt, armedAt: entry.armedAt });
    else {
      try { await chrome.alarms.create(ringName(key), { when: entry.endAt }); } catch { /* best-effort */ }
    }
  }
  if (changed) await writeArmed(armed);
}

chrome.runtime.onStartup.addListener(() => { void reconcileAlarms(); });
chrome.runtime.onInstalled.addListener(() => { void reconcileAlarms(); });
