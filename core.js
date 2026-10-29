/* Nixie New Tab — shared pure helpers.
 * No DOM, no chrome APIs, no network. Browser + Node (UMD).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.NixieCore = api;
  }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = '1.3.1';

  var SETTINGS_DEFAULTS = {
    clock24: false,
    showSeconds: true,
    theme: 'plasma',
    dim: false,
    alarmTone: 'classic',
    alarmVolume: 0.55,
    searchEngine: 'google',
    suggestions: true
  };

  var THEMES = [
    { id: 'plasma', label: 'Plasma' },
    { id: 'phosphor', label: 'Phosphor' },
    { id: 'ice', label: 'Ice' },
    { id: 'red', label: 'Red' }
  ];

  var TONES = [
    { id: 'classic', label: 'Classic nixie' },
    { id: 'chime', label: 'Chime' },
    { id: 'bell', label: 'Bell' },
    { id: 'silent', label: 'Silent / visual only' }
  ];

  var SEARCH_ENGINES = {
    google: {
      label: 'Google',
      suggest: true,
      url: function (q) { return 'https://www.google.com/search?q=' + encodeURIComponent(q); }
    },
    duckduckgo: {
      label: 'DuckDuckGo',
      suggest: false,
      url: function (q) { return 'https://duckduckgo.com/?q=' + encodeURIComponent(q); }
    },
    bing: {
      label: 'Bing',
      suggest: false,
      url: function (q) { return 'https://www.bing.com/search?q=' + encodeURIComponent(q); }
    },
    youtube: {
      label: 'YouTube',
      suggest: false,
      url: function (q) { return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q); }
    },
    perplexity: {
      label: 'Perplexity',
      suggest: false,
      url: function (q) { return 'https://www.perplexity.ai/search?q=' + encodeURIComponent(q); }
    }
  };

  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  var THEME_IDS = THEMES.map(function (theme) { return theme.id; });
  var TONE_IDS = TONES.map(function (tone) { return tone.id; });
  var ENGINE_IDS = Object.keys(SEARCH_ENGINES);

  var MINUTE_MS = 60000;
  var HOUR_MS = 3600000;
  var DAY_MS = 86400000;

  /* ---------- generic helpers ---------- */

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function pad4(value) {
    return String(value).padStart(4, '0');
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function makeId(prefix) {
    var p = prefix == null ? 'id' : String(prefix);
    var uuid = '';
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      try { uuid = crypto.randomUUID(); } catch (err) { uuid = ''; }
    }
    if (!uuid) {
      uuid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return p ? p + '-' + uuid : uuid;
  }

  /* ---------- settings ---------- */

  function normalizeSettings(raw) {
    var source = isObject(raw) ? raw : {};
    var volume = source.alarmVolume;
    var alarmVolume = typeof volume === 'number' && Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : SETTINGS_DEFAULTS.alarmVolume;

    return {
      clock24: typeof source.clock24 === 'boolean' ? source.clock24 : SETTINGS_DEFAULTS.clock24,
      showSeconds: typeof source.showSeconds === 'boolean' ? source.showSeconds : SETTINGS_DEFAULTS.showSeconds,
      theme: THEME_IDS.indexOf(source.theme) !== -1 ? source.theme : SETTINGS_DEFAULTS.theme,
      dim: typeof source.dim === 'boolean' ? source.dim : SETTINGS_DEFAULTS.dim,
      alarmTone: TONE_IDS.indexOf(source.alarmTone) !== -1 ? source.alarmTone : SETTINGS_DEFAULTS.alarmTone,
      alarmVolume: alarmVolume,
      searchEngine: ENGINE_IDS.indexOf(source.searchEngine) !== -1
        ? source.searchEngine
        : SETTINGS_DEFAULTS.searchEngine,
      suggestions: typeof source.suggestions === 'boolean'
        ? source.suggestions
        : SETTINGS_DEFAULTS.suggestions
    };
  }

  /* Import only the setting keys that are present and valid so a partial
     archive does not silently reset unrelated preferences. */
  function settingsPatch(raw) {
    if (!isObject(raw)) return null;
    var patch = {};

    if (typeof raw.clock24 === 'boolean') patch.clock24 = raw.clock24;
    if (typeof raw.showSeconds === 'boolean') patch.showSeconds = raw.showSeconds;
    if (THEME_IDS.indexOf(raw.theme) !== -1) patch.theme = raw.theme;
    if (typeof raw.dim === 'boolean') patch.dim = raw.dim;
    if (TONE_IDS.indexOf(raw.alarmTone) !== -1) patch.alarmTone = raw.alarmTone;
    if (typeof raw.alarmVolume === 'number' && Number.isFinite(raw.alarmVolume)) {
      patch.alarmVolume = Math.min(1, Math.max(0, raw.alarmVolume));
    }
    if (ENGINE_IDS.indexOf(raw.searchEngine) !== -1) patch.searchEngine = raw.searchEngine;
    if (typeof raw.suggestions === 'boolean') patch.suggestions = raw.suggestions;

    return Object.keys(patch).length ? patch : null;
  }

  /* ---------- dates and times ---------- */

  function dateKeyLocal(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
    return pad4(date.getFullYear()) + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function parseDateKey(key) {
    if (typeof key !== 'string') return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (year < 1 || year > 9999) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    var date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function parseTimeKey(key) {
    if (typeof key !== 'string') return null;
    var match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(key);
    if (!match) return null;
    return { h: Number(match[1]), m: Number(match[2]) };
  }

  function eventTarget(event) {
    if (!isObject(event)) return null;
    var date = parseDateKey(event.date);
    if (!date) return null;
    if (event.time) {
      var time = parseTimeKey(event.time);
      if (!time) return null;
      date.setHours(time.h, time.m, 0, 0);
    }
    return date;
  }

  function eventEnd(event) {
    if (!isObject(event)) return null;
    var date = parseDateKey(event.date);
    if (!date) return null;
    if (event.time) {
      var time = parseTimeKey(event.time);
      if (!time) return null;
      date.setHours(time.h, time.m, 0, 0);
      return date;
    }
    date.setHours(23, 59, 59, 999);
    return date;
  }

  function formatEventDate(event) {
    if (!isObject(event)) return '';
    var date = parseDateKey(event.date);
    if (!date) return '';
    var text = pad2(date.getDate()) + ' ' + MONTHS[date.getMonth()] + ' ' + pad4(date.getFullYear());
    if (event.time) {
      var time = parseTimeKey(event.time);
      if (time) text += ' · ' + pad2(time.h) + ':' + pad2(time.m);
    }
    return text;
  }

  function pastStatus(target, dateText, label, ms) {
    return {
      state: 'past',
      code: 'PASSED',
      days: null,
      hours: null,
      minutes: null,
      ms: ms,
      target: target,
      dateText: dateText,
      label: label
    };
  }

  function eventStatus(event, now) {
    var current = now === undefined ? new Date() : now;
    var label = isObject(event) && typeof event.label === 'string' ? event.label : '';
    var dateText = formatEventDate(event);
    var target = eventTarget(event);

    if (!target || !(current instanceof Date) || !Number.isFinite(current.getTime())) {
      return pastStatus(target, dateText, label, null);
    }

    var nowMs = current.getTime();
    var diff = target.getTime() - nowMs;
    var timed = !!(event.time);

    if (!timed) {
      var targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
      var currentDay = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
      var dayDiff = Math.round((targetDay - currentDay) / DAY_MS);
      if (dayDiff === 0) {
        return {
          state: 'today',
          code: 'TODAY',
          days: 0,
          hours: null,
          minutes: null,
          ms: diff,
          target: target,
          dateText: dateText,
          label: label
        };
      }
      if (dayDiff > 0) {
        return {
          state: 'upcoming',
          code: 'T-' + dayDiff + 'D',
          days: dayDiff,
          hours: null,
          minutes: null,
          ms: diff,
          target: target,
          dateText: dateText,
          label: label
        };
      }
      return pastStatus(target, dateText, label, diff);
    }

    if (diff <= 0) return pastStatus(target, dateText, label, diff);

    if (diff < HOUR_MS) {
      var minutes = Math.max(1, Math.floor(diff / MINUTE_MS));
      return {
        state: 'upcoming',
        code: 'T-' + minutes + 'M',
        days: null,
        hours: null,
        minutes: minutes,
        ms: diff,
        target: target,
        dateText: dateText,
        label: label
      };
    }

    if (diff < DAY_MS) {
      var hours = Math.max(1, Math.floor(diff / HOUR_MS));
      return {
        state: 'upcoming',
        code: 'T-' + hours + 'H',
        days: null,
        hours: hours,
        minutes: null,
        ms: diff,
        target: target,
        dateText: dateText,
        label: label
      };
    }

    var days = Math.max(1, Math.ceil(diff / DAY_MS));
    return {
      state: 'upcoming',
      code: 'T-' + days + 'D',
      days: days,
      hours: null,
      minutes: null,
      ms: diff,
      target: target,
      dateText: dateText,
      label: label
    };
  }

  function sortEvents(events) {
    if (!Array.isArray(events)) return [];
    return events.slice().sort(function (a, b) {
      var targetA = eventTarget(a);
      var targetB = eventTarget(b);
      if (targetA && targetB) {
        var diff = targetA.getTime() - targetB.getTime();
        if (diff !== 0) return diff;
      } else if (targetA) {
        return -1;
      } else if (targetB) {
        return 1;
      }
      var labelA = isObject(a) && typeof a.label === 'string' ? a.label : '';
      var labelB = isObject(b) && typeof b.label === 'string' ? b.label : '';
      return labelA.localeCompare(labelB);
    });
  }

  function normalizeEvents(raw) {
    if (!Array.isArray(raw)) return [];

    var seenIds = Object.create(null);
    var events = [];

    raw.forEach(function (item) {
      if (!isObject(item)) return;

      var label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!label) return;
      label = label.slice(0, 40);

      var date = typeof item.date === 'string' ? item.date.trim() : '';
      if (!parseDateKey(date)) return;

      var time = '';
      if (item.time !== undefined && item.time !== null && item.time !== '') {
        if (typeof item.time !== 'string') return;
        var parsedTime = parseTimeKey(item.time.trim());
        if (!parsedTime) return;
        time = pad2(parsedTime.h) + ':' + pad2(parsedTime.m);
      }

      var givenId = typeof item.id === 'string' ? item.id.trim() : '';
      var id = givenId;
      if (!id) id = makeId('e');
      if (seenIds[id]) {
        if (givenId) return;
        do { id = makeId('e'); } while (seenIds[id]);
      }
      seenIds[id] = true;

      events.push({ id: id, label: label, date: date, time: time });
    });

    return sortEvents(events);
  }

  function nextEvent(events, now) {
    if (!Array.isArray(events)) return null;
    var current = now === undefined ? new Date() : now;
    var best = null;
    var bestTarget = null;

    events.forEach(function (event) {
      var target = eventTarget(event);
      if (!target) return;
      var status = eventStatus(event, current);
      if (!status || status.state === 'past') return;
      if (!bestTarget || target.getTime() < bestTarget.getTime()) {
        best = event;
        bestTarget = target;
      }
    });

    return best;
  }

  /* ---------- sites ---------- */

  function normalizeSites(raw) {
    if (!Array.isArray(raw)) return [];

    var seen = Object.create(null);
    var sites = [];

    raw.forEach(function (item) {
      if (!isObject(item)) return;
      var rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
      if (!rawUrl) return;

      var parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (err) {
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      if (!parsed.hostname) return;

      var key = parsed.href;
      if (seen[key]) return;
      seen[key] = true;

      var name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) name = parsed.hostname.replace(/^www\./i, '');
      name = name.slice(0, 60).trim();
      if (!name) return;

      sites.push({ name: name, url: rawUrl });
    });

    return sites;
  }

  /* ---------- search ---------- */

  function searchUrl(engine, query) {
    var definition = hasOwn(SEARCH_ENGINES, engine)
      ? SEARCH_ENGINES[engine]
      : SEARCH_ENGINES.google;
    var text = query == null ? '' : String(query);
    return definition.url(text);
  }

  /* ---------- calculator ---------- */

  function calculate(expression) {
    if (typeof expression !== 'string') return null;
    if (expression.length > 120) return null;

    var source = expression;
    var length = source.length;
    var pos = 0;

    function fail() {
      throw new Error('invalid expression');
    }

    function skipSpace() {
      while (pos < length) {
        var ch = source.charAt(pos);
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
            ch === '\f' || ch === '\v') {
          pos += 1;
        } else {
          break;
        }
      }
    }

    function parsePrimary() {
      skipSpace();
      if (source.charAt(pos) === '(') {
        pos += 1;
        var inner = parseAdditive();
        skipSpace();
        if (source.charAt(pos) !== ')') fail();
        pos += 1;
        return inner;
      }

      var match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(pos));
      if (!match) fail();
      pos += match[0].length;
      return Number(match[0]);
    }

    function parsePower() {
      var base = parsePrimary();
      skipSpace();
      if (source.charAt(pos) === '^') {
        pos += 1;
        return Math.pow(base, parseUnary());
      }
      return base;
    }

    function parseUnary() {
      skipSpace();
      var ch = source.charAt(pos);
      if (ch === '+') {
        pos += 1;
        return parseUnary();
      }
      if (ch === '-') {
        pos += 1;
        return -parseUnary();
      }
      return parsePower();
    }

    function parseMultiplicative() {
      var value = parseUnary();
      for (;;) {
        skipSpace();
        var ch = source.charAt(pos);
        if (ch === '*') {
          pos += 1;
          value *= parseUnary();
        } else if (ch === '/') {
          pos += 1;
          var divisor = parseUnary();
          if (divisor === 0) fail();
          value /= divisor;
        } else if (ch === '%') {
          pos += 1;
          var modulus = parseUnary();
          if (modulus === 0) fail();
          value %= modulus;
        } else {
          break;
        }
        if (!Number.isFinite(value)) fail();
      }
      return value;
    }

    function parseAdditive() {
      var value = parseMultiplicative();
      for (;;) {
        skipSpace();
        var ch = source.charAt(pos);
        if (ch === '+') {
          pos += 1;
          value += parseMultiplicative();
        } else if (ch === '-') {
          pos += 1;
          value -= parseMultiplicative();
        } else {
          break;
        }
        if (!Number.isFinite(value)) fail();
      }
      return value;
    }

    try {
      var result = parseAdditive();
      skipSpace();
      if (pos !== length || !Number.isFinite(result)) return null;
      return result;
    } catch (err) {
      return null;
    }
  }

  function formatNumber(value) {
    var number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return '';
    if (Object.is(number, -0)) number = 0;
    if (number === 0) return '0';

    var abs = Math.abs(number);
    if (abs >= 1e12 || abs < 1e-9) {
      return number.toExponential();
    }

    var rounded = Number(number.toPrecision(12));
    if (String(rounded).indexOf('e') !== -1) return rounded.toExponential();
    return String(rounded);
  }

  function isMathExpression(query) {
    if (typeof query !== 'string') return false;
    var text = query.trim();
    if (!text) return false;
    if (!/\d/.test(text)) return false;
    if (!/[+\-*/%^]/.test(text)) return false;
    // Dates and phone numbers look like subtraction to the parser; treat them
    // as search queries instead of silently copying a meaningless result.
    if (/^\d{4}-\d{1,2}(?:-\d{1,2})?(?:[T ].*)?$/.test(text)) return false;
    var digits = (text.match(/\d/g) || []).length;
    if (digits >= 10 && /^[+\d][\d\s().-]*$/.test(text)) return false;
    var result = calculate(text);
    return typeof result === 'number' && Number.isFinite(result);
  }

  /* ---------- fuzzy matching ---------- */

  function fuzzyScore(query, text) {
    if (typeof query !== 'string' || typeof text !== 'string') return -1;
    var needle = query.trim().toLowerCase();
    var haystack = text.trim().toLowerCase();

    if (!needle) return 0;
    if (!haystack) return -1;
    if (needle === haystack) return 1000;

    if (haystack.slice(0, needle.length) === needle) {
      return 800 + Math.max(0, 100 - (haystack.length - needle.length));
    }

    var index = haystack.indexOf(needle);
    if (index !== -1) {
      return 500 + Math.max(0, 100 - index * 4) + Math.min(40, needle.length);
    }

    var cursor = 0;
    var previous = -2;
    var streak = 0;
    var score = 0;

    for (var i = 0; i < needle.length; i += 1) {
      var found = haystack.indexOf(needle.charAt(i), cursor);
      if (found === -1) return -1;
      if (found === previous + 1) {
        streak += 1;
        score += 10 + Math.min(5, streak);
      } else {
        streak = 0;
        score += 4;
      }
      if (found === 0 || /[\s\-_/.]/.test(haystack.charAt(found - 1))) score += 6;
      previous = found;
      cursor = found + 1;
    }

    score -= Math.ceil((haystack.length - needle.length) * 0.4);
    return Math.max(0, Math.min(499, score));
  }

  /* ---------- Brave Shields telemetry ---------- */

  /* Brave estimates 50 ms saved per blocked item (brave-core stats.tsx). */
  var SHIELDS_MS_PER_ITEM = 50;

  function normalizeShields(raw) {
    var source = isObject(raw) ? raw : {};
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
      path: typeof source.path === 'string' ? source.path.trim().slice(0, 1024) : ''
    };
  }

  function formatCount(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '0';
    return String(Math.floor(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* Same thresholds and rounding as Brave's new-tab stats card. */
  function formatBytes(bytes) {
    var number = Number(bytes);
    if (!Number.isFinite(number) || number <= 0) return { value: '0', unit: 'B' };
    if (number < 1024) return { value: String(Math.round(number)), unit: 'B' };
    if (number < 1048576) return { value: (number / 1024).toFixed(0), unit: 'KB' };
    if (number < 1073741824) return { value: (number / 1048576).toFixed(1), unit: 'MB' };
    return { value: (number / 1073741824).toFixed(2), unit: 'GB' };
  }

  function formatTimeSaved(adsBlocked) {
    var ads = Number(adsBlocked);
    var ms = Number.isFinite(ads) && ads > 0 ? ads * SHIELDS_MS_PER_ITEM : 0;
    if (ms < 60000) return { value: String(Math.ceil(ms / 1000)), unit: 'SEC' };
    if (ms < 3600000) return { value: String(Math.ceil(ms / 60000)), unit: 'MIN' };
    if (ms < 86400000) return { value: String(+((ms / 3600000).toFixed(1))), unit: 'HRS' };
    return { value: String(+((ms / 86400000).toFixed(2))), unit: 'DAYS' };
  }

  /* Pull brave.stats out of a parsed Preferences document. Values are stored
     as strings in Chromium prefs, so normalise before use. */
  function extractBraveStats(raw) {
    if (!isObject(raw) || !isObject(raw.brave) || !isObject(raw.brave.stats)) return null;
    var source = raw.brave.stats;
    var ads = Number(source.ads_blocked);
    var bytes = Number(source.bandwidth_saved_bytes);
    var hasAds = Number.isFinite(ads) && ads >= 0;
    var hasBytes = Number.isFinite(bytes) && bytes >= 0;
    if (!hasAds && !hasBytes) return null;

    var daily = [];
    if (Array.isArray(source.daily_saving_predictions_bytes)) {
      source.daily_saving_predictions_bytes.forEach(function (item) {
        if (!isObject(item)) return;
        var day = Number(item.day);
        var value = Number(item.value);
        if (!Number.isFinite(day) || !Number.isFinite(value)) return;
        daily.push({ day: day, value: Math.max(0, value) });
      });
    }

    var adsBlocked = hasAds ? Math.floor(ads) : 0;
    return {
      adsBlocked: adsBlocked,
      bandwidthBytes: hasBytes ? Math.floor(bytes) : 0,
      timeSavedMs: adsBlocked * SHIELDS_MS_PER_ITEM,
      daily: daily
    };
  }

  /* Brave's Local State records when each profile was last active. The
     profile in current use is a better default than the largest counter,
     which may belong to an old profile. */
  function extractBraveProfileActivity(raw) {
    if (!isObject(raw) || !isObject(raw.profile)) return null;
    var cache = isObject(raw.profile.info_cache) ? raw.profile.info_cache : {};
    var active = {};
    Object.keys(cache).forEach(function (name) {
      var entry = cache[name];
      var time = Number(entry && entry.active_time);
      if (Number.isFinite(time) && time > 0) active[name] = time;
    });
    var lastUsed = typeof raw.profile.last_used === 'string' ? raw.profile.last_used : '';
    var order = Array.isArray(raw.profile.last_active_profiles)
      ? raw.profile.last_active_profiles.filter(function (name) {
        return typeof name === 'string';
      })
      : [];
    if (!Object.keys(active).length && !lastUsed) return null;
    return { active: active, lastUsed: lastUsed, order: order };
  }

  /* Chromium writes `last_used` and the winner's `active_time` from the same
     browser-window activation, so they identify the profile whose window is
     in use. Shields counters say nothing about that — a profile with a bigger
     counter may be a different, older profile — so they are never a fallback.
     Returns null when Local State cannot decide, which callers must treat as
     "do not show another profile's stats". */
  function pickBraveProfile(activity, names) {
    if (!isObject(activity)) return null;
    var candidates = [];
    if (Array.isArray(names)) {
      names.forEach(function (name) {
        if (typeof name === 'string' && name && candidates.indexOf(name) === -1) {
          candidates.push(name);
        }
      });
    }
    if (!candidates.length) return null;

    var active = isObject(activity.active) ? activity.active : {};
    var bestName = '';
    var bestTime = 0;
    var tied = false;
    candidates.forEach(function (name) {
      var time = Number(active[name]);
      if (!Number.isFinite(time) || time <= 0) return;
      if (time > bestTime) {
        bestTime = time;
        bestName = name;
        tied = false;
      } else if (time === bestTime) {
        tied = true;
      }
    });

    var lastUsed = typeof activity.lastUsed === 'string' ? activity.lastUsed : '';
    if (lastUsed && candidates.indexOf(lastUsed) !== -1) {
      var lastTime = Number(active[lastUsed]);
      // A clearly newer active_time (more than 2s) means last_used is lagging.
      if (bestName && !tied && Number.isFinite(lastTime) && bestTime - lastTime > 2) {
        return { profile: bestName, reason: 'active_time' };
      }
      return { profile: lastUsed, reason: 'last_used' };
    }
    if (bestName && !tied) return { profile: bestName, reason: 'active_time' };

    // With no timestamps, the only safe signal is a single open window that
    // is also a scanned profile. Unknown open profiles make the answer ambiguous.
    var order = Array.isArray(activity.order)
      ? activity.order.filter(function (name) { return typeof name === 'string'; })
      : [];
    if (order.length === 1 && candidates.indexOf(order[0]) !== -1) {
      return { profile: order[0], reason: 'only_open_profile' };
    }
    return null;
  }

  /* True when this extension is enabled in a parsed Preferences document.
     Detection uses it to reject a profile that cannot be running the page. */
  function extensionInstalledInPreferences(raw, extensionId) {
    if (!isObject(raw) || typeof extensionId !== 'string' || !extensionId) return false;
    var settings = raw.extensions && raw.extensions.settings;
    if (!isObject(settings)) return false;
    var entry = settings[extensionId];
    if (!isObject(entry)) return false;
    if (entry.state === 0) return false;
    if (Array.isArray(entry.disable_reasons) && entry.disable_reasons.length) return false;
    return true;
  }

  /* Windows paths, POSIX paths, and file:// URLs all become a fetchable URL. */
  function toFileUrl(path) {
    if (typeof path !== 'string') return '';
    var p = path.trim();
    if (!p) return '';
    if (/^file:\/\//i.test(p)) return p.replace(/\\/g, '/');
    p = p.replace(/\\/g, '/');
    if (p.indexOf('//') === 0) return 'file:' + encodeURI(p);
    if (/^[A-Za-z]:\//.test(p)) p = '/' + p;
    else if (p.charAt(0) !== '/') p = '/' + p;
    return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  /* A profile folder can be supplied instead of the Preferences file. */
  function normalizePreferencesPath(path) {
    if (typeof path !== 'string') return '';
    var p = path.trim();
    if (!p) return '';
    p = p.replace(/\\/g, '/');
    p = p.replace(/\/+$/, '');
    if (/\/preferences$/i.test(p)) return p;
    if (/\/(?:default|profile\s*\d+)$/i.test(p)) return p + '/Preferences';
    return p;
  }

  function profileLabelFromPath(path) {
    if (typeof path !== 'string') return '';
    var p = path.trim().replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/\/preferences$/i.test(p)) p = p.slice(0, -12);
    var parts = p.split('/').filter(Boolean);
    var name = parts.length ? parts[parts.length - 1] : '';
    try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
    return name;
  }

  /* Chromium's file:// directory listing calls addRow(name, url, isdir, ...). */
  function parseDirectoryListing(html) {
    if (typeof html !== 'string' || html.indexOf('addRow(') === -1) return [];
    var items = [];
    var pattern = /addRow\("((?:\\.|[^"\\])*)","((?:\\.|[^"\\])*)",(\d+)/g;
    var match;
    while ((match = pattern.exec(html))) {
      var name = match[1];
      try { name = JSON.parse('"' + name + '"'); } catch (err) { /* keep raw */ }
      items.push({ name: name, url: match[2], isDir: match[3] === '1' });
    }
    return items;
  }

  /* ---------- backup ---------- */

  function buildBackup(source) {
    var input = isObject(source) ? source : {};
    return {
      app: 'Nixie New Tab',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        sites: input.sites === undefined ? null : input.sites,
        tasks: input.tasks === undefined ? null : input.tasks,
        events: input.events === undefined ? null : input.events,
        settings: input.settings === undefined ? null : input.settings
      }
    };
  }

  function parseBackup(raw) {
    var parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return null;
      }
    }
    if (!isObject(parsed)) return null;

    var known = ['sites', 'tasks', 'events', 'settings'];
    var data = parsed;
    if (isObject(parsed.data)) {
      var hasDataField = known.some(function (key) { return hasOwn(parsed.data, key); });
      if (hasDataField) data = parsed.data;
    }

    var hasAny = known.some(function (key) { return hasOwn(data, key); });
    if (!hasAny) return null;

    var sites = null;
    if (Array.isArray(data.sites)) {
      var normalizedSites = normalizeSites(data.sites);
      // An empty array deliberately clears; a non-empty list of only invalid
      // entries is rejected rather than wiping existing favorites.
      if (data.sites.length === 0 || normalizedSites.length > 0) sites = normalizedSites;
    }

    var events = null;
    if (Array.isArray(data.events)) {
      var normalizedEvents = normalizeEvents(data.events);
      if (data.events.length === 0 || normalizedEvents.length > 0) events = normalizedEvents;
    }

    var result = {
      sites: sites,
      tasks: Array.isArray(data.tasks) ? data.tasks : null,
      events: events,
      settings: hasOwn(data, 'settings') ? settingsPatch(data.settings) : null
    };

    var usable = result.sites !== null ||
      result.tasks !== null ||
      result.events !== null ||
      result.settings !== null;
    return usable ? result : null;
  }

  return {
    VERSION: VERSION,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    THEMES: THEMES,
    TONES: TONES,
    SEARCH_ENGINES: SEARCH_ENGINES,
    normalizeSettings: normalizeSettings,
    settingsPatch: settingsPatch,
    normalizeEvents: normalizeEvents,
    normalizeSites: normalizeSites,
    makeId: makeId,
    dateKeyLocal: dateKeyLocal,
    parseDateKey: parseDateKey,
    parseTimeKey: parseTimeKey,
    eventTarget: eventTarget,
    eventEnd: eventEnd,
    eventStatus: eventStatus,
    nextEvent: nextEvent,
    sortEvents: sortEvents,
    formatEventDate: formatEventDate,
    searchUrl: searchUrl,
    calculate: calculate,
    formatNumber: formatNumber,
    isMathExpression: isMathExpression,
    fuzzyScore: fuzzyScore,
    normalizeShields: normalizeShields,
    formatCount: formatCount,
    formatBytes: formatBytes,
    formatTimeSaved: formatTimeSaved,
    extractBraveStats: extractBraveStats,
    extractBraveProfileActivity: extractBraveProfileActivity,
    pickBraveProfile: pickBraveProfile,
    extensionInstalledInPreferences: extensionInstalledInPreferences,
    toFileUrl: toFileUrl,
    normalizePreferencesPath: normalizePreferencesPath,
    profileLabelFromPath: profileLabelFromPath,
    parseDirectoryListing: parseDirectoryListing,
    buildBackup: buildBackup,
    parseBackup: parseBackup
  };
}));
