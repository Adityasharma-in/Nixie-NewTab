'use strict';

const assert = require('assert');
const core = require('../core.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

/* ---------- settings ---------- */

test('settings: defaults for null/unknown input', () => {
  const expected = {
    clock24: false,
    showSeconds: true,
    theme: 'plasma',
    dim: false,
    alarmTone: 'classic',
    alarmVolume: 0.55,
    searchEngine: 'google',
    suggestions: true
  };
  assert.deepStrictEqual(core.normalizeSettings(null), expected);
  assert.deepStrictEqual(core.normalizeSettings(undefined), expected);
  assert.deepStrictEqual(core.normalizeSettings('nope'), expected);
  assert.deepStrictEqual(core.normalizeSettings([]), expected);
  assert.deepStrictEqual(core.SETTINGS_DEFAULTS, expected);
});

test('settings: output has exactly the eight keys and is fresh', () => {
  const first = core.normalizeSettings(null);
  assert.deepStrictEqual(Object.keys(first).sort(), [
    'alarmTone', 'alarmVolume', 'clock24', 'dim',
    'searchEngine', 'showSeconds', 'suggestions', 'theme'
  ]);
  first.theme = 'red';
  first.clock24 = true;
  assert.strictEqual(core.normalizeSettings(null).theme, 'plasma');
  assert.strictEqual(core.SETTINGS_DEFAULTS.theme, 'plasma');
});

test('settings: non-booleans fall back to defaults', () => {
  const result = core.normalizeSettings({
    clock24: 'true',
    showSeconds: 0,
    dim: 1,
    suggestions: null
  });
  assert.strictEqual(result.clock24, false);
  assert.strictEqual(result.showSeconds, true);
  assert.strictEqual(result.dim, false);
  assert.strictEqual(result.suggestions, true);
});

test('settings: theme, tone and engine ids are validated', () => {
  const valid = core.normalizeSettings({
    theme: 'ice',
    alarmTone: 'bell',
    searchEngine: 'perplexity'
  });
  assert.strictEqual(valid.theme, 'ice');
  assert.strictEqual(valid.alarmTone, 'bell');
  assert.strictEqual(valid.searchEngine, 'perplexity');

  const invalid = core.normalizeSettings({
    theme: 'mine',
    alarmTone: 'siren',
    searchEngine: 'yahoo'
  });
  assert.strictEqual(invalid.theme, 'plasma');
  assert.strictEqual(invalid.alarmTone, 'classic');
  assert.strictEqual(invalid.searchEngine, 'google');
});

test('settings: volume is clamped and non-numbers are rejected', () => {
  assert.strictEqual(core.normalizeSettings({ alarmVolume: 2 }).alarmVolume, 1);
  assert.strictEqual(core.normalizeSettings({ alarmVolume: -0.5 }).alarmVolume, 0);
  assert.strictEqual(core.normalizeSettings({ alarmVolume: 0.25 }).alarmVolume, 0.25);
  assert.strictEqual(core.normalizeSettings({ alarmVolume: NaN }).alarmVolume, 0.55);
  assert.strictEqual(core.normalizeSettings({ alarmVolume: Infinity }).alarmVolume, 0.55);
  assert.strictEqual(core.normalizeSettings({ alarmVolume: '0.4' }).alarmVolume, 0.55);
});

/* ---------- ids, dates, times ---------- */

test('makeId: prefixed unique string', () => {
  const first = core.makeId('e');
  const second = core.makeId('e');
  assert.strictEqual(typeof first, 'string');
  assert.ok(first.indexOf('e-') === 0);
  assert.notStrictEqual(first, second);
});

test('date keys: local round trip and strict validation', () => {
  const date = core.parseDateKey('2026-10-28');
  assert.strictEqual(date.getFullYear(), 2026);
  assert.strictEqual(date.getMonth(), 9);
  assert.strictEqual(date.getDate(), 28);
  assert.strictEqual(date.getHours(), 0);
  assert.strictEqual(date.getMinutes(), 0);
  assert.strictEqual(core.dateKeyLocal(date), '2026-10-28');
  assert.strictEqual(core.dateKeyLocal(new Date(2026, 0, 5)), '2026-01-05');

  assert.strictEqual(core.parseDateKey('2026-02-30'), null);
  assert.strictEqual(core.parseDateKey('2026-02-29'), null);
  assert.ok(core.parseDateKey('2028-02-29') instanceof Date);
  assert.strictEqual(core.parseDateKey('2026-13-01'), null);
  assert.strictEqual(core.parseDateKey('2026-00-10'), null);
  assert.strictEqual(core.parseDateKey('2026-10-00'), null);
  assert.strictEqual(core.parseDateKey('2026-1-01'), null);
  assert.strictEqual(core.parseDateKey('not-a-date'), null);
  assert.strictEqual(core.parseDateKey(null), null);
  assert.strictEqual(core.dateKeyLocal(new Date(NaN)), '');
});

test('time keys: strict HH:MM in 00:00-23:59', () => {
  assert.deepStrictEqual(core.parseTimeKey('00:00'), { h: 0, m: 0 });
  assert.deepStrictEqual(core.parseTimeKey('09:05'), { h: 9, m: 5 });
  assert.deepStrictEqual(core.parseTimeKey('23:59'), { h: 23, m: 59 });
  assert.strictEqual(core.parseTimeKey('24:00'), null);
  assert.strictEqual(core.parseTimeKey('12:60'), null);
  assert.strictEqual(core.parseTimeKey('9:05'), null);
  assert.strictEqual(core.parseTimeKey('09:5'), null);
  assert.strictEqual(core.parseTimeKey(''), null);
  assert.strictEqual(core.parseTimeKey(null), null);
});

test('event target and end respect date-only days', () => {
  const timed = { date: '2026-10-28', time: '09:30' };
  assert.strictEqual(core.eventTarget(timed).getTime(), new Date(2026, 9, 28, 9, 30, 0, 0).getTime());
  assert.strictEqual(core.eventEnd(timed).getTime(), core.eventTarget(timed).getTime());

  const dayOnly = { date: '2026-10-28', time: '' };
  assert.strictEqual(core.eventTarget(dayOnly).getTime(), new Date(2026, 9, 28, 0, 0, 0, 0).getTime());
  assert.strictEqual(core.eventEnd(dayOnly).getTime(), new Date(2026, 9, 28, 23, 59, 59, 999).getTime());

  assert.strictEqual(core.eventTarget({ date: '2026-02-30' }), null);
  assert.strictEqual(core.eventTarget({ date: '2026-10-28', time: 'nope' }), null);
  assert.strictEqual(core.eventEnd({ date: 'bad' }), null);
});

/* ---------- event normalization ---------- */

test('events: normalize, trim, validate, dedupe, generate ids, sort', () => {
  const raw = [
    { id: 'b', label: '  Later  ', date: '2026-12-01', time: '09:05' },
    { id: 'a', label: 'Earlier', date: '2026-10-28', time: '' },
    { id: 'a', label: 'Duplicate id', date: '2027-01-01', time: '' },
    { label: 'Generated', date: '2026-11-15' },
    { id: 'bad-date', label: 'Bad date', date: '2026-02-30' },
    { id: 'bad-time', label: 'Bad time', date: '2026-11-16', time: '24:00' },
    { id: 'bad-time2', label: 'Bad time 2', date: '2026-11-16', time: '9:05' },
    { id: 'blank', label: '   ', date: '2026-11-17' },
    { id: 'long', label: 'x'.repeat(60), date: '2026-11-18', time: '07:05' },
    { id: 'same-day', label: 'Same day', date: '2026-12-01', time: '' },
    null,
    'oops'
  ];

  const events = core.normalizeEvents(raw);
  assert.strictEqual(events.length, 5);
  assert.deepStrictEqual(events.map((event) => event.id),
    ['a', events[1].id, 'long', 'same-day', 'b']);
  assert.strictEqual(events[0].label, 'Earlier');
  assert.strictEqual(events[0].time, '');
  assert.strictEqual(events[1].label, 'Generated');
  assert.ok(/^e-/.test(events[1].id));
  assert.strictEqual(events[2].label, 'x'.repeat(40));
  assert.strictEqual(events[2].time, '07:05');
  assert.strictEqual(events[3].label, 'Same day');
  assert.strictEqual(events[4].label, 'Later');
  assert.strictEqual(events[4].time, '09:05');
  assert.strictEqual(new Set(events.map((event) => event.id)).size, events.length);
  assert.deepStrictEqual(Object.keys(events[0]).sort(), ['date', 'id', 'label', 'time']);
  assert.deepStrictEqual(core.normalizeEvents(null), []);
  assert.deepStrictEqual(core.normalizeEvents([{ label: 'No date' }]), []);
});

test('events: sortEvents orders by target then label', () => {
  const sorted = core.sortEvents([
    { id: '1', label: 'B', date: '2026-12-01', time: '' },
    { id: '2', label: 'A', date: '2026-12-01', time: '' },
    { id: '3', label: 'Early', date: '2026-11-01', time: '' },
    { id: '4', label: 'Timed', date: '2026-11-01', time: '08:00' }
  ]);
  assert.deepStrictEqual(sorted.map((event) => event.label), ['Early', 'Timed', 'A', 'B']);
  assert.deepStrictEqual(core.sortEvents(null), []);
});

/* ---------- event status ---------- */

test('status: date-only today, future, and past', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);
  const today = core.eventStatus({ id: '1', label: 'Today', date: '2026-10-28', time: '' }, now);
  assert.strictEqual(today.state, 'today');
  assert.strictEqual(today.code, 'TODAY');
  assert.strictEqual(today.days, 0);
  assert.strictEqual(today.hours, null);
  assert.strictEqual(today.minutes, null);
  assert.strictEqual(today.target.getTime(), new Date(2026, 9, 28, 0, 0, 0, 0).getTime());
  assert.strictEqual(today.ms, today.target.getTime() - now.getTime());
  assert.strictEqual(today.dateText, '28 OCT 2026');
  assert.strictEqual(today.label, 'Today');

  const future = core.eventStatus({ id: '2', label: 'Future', date: '2026-10-31', time: '' }, now);
  assert.strictEqual(future.state, 'upcoming');
  assert.strictEqual(future.code, 'T-3D');
  assert.strictEqual(future.days, 3);
  assert.strictEqual(future.dateText, '31 OCT 2026');

  const past = core.eventStatus({ id: '3', label: 'Past', date: '2026-10-27', time: '' }, now);
  assert.strictEqual(past.state, 'past');
  assert.strictEqual(past.code, 'PASSED');
  assert.strictEqual(past.label, 'Past');
});

test('status: timed future uses M/H/D and past at target', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);

  const twoHours = core.eventStatus({ label: 'Lunch', date: '2026-10-28', time: '14:00' }, now);
  assert.strictEqual(twoHours.state, 'upcoming');
  assert.strictEqual(twoHours.code, 'T-2H');
  assert.strictEqual(twoHours.hours, 2);
  assert.strictEqual(twoHours.minutes, null);
  assert.strictEqual(twoHours.ms, 2 * 3600000);
  assert.strictEqual(twoHours.dateText, '28 OCT 2026 · 14:00');

  const halfHour = core.eventStatus({ label: 'Soon', date: '2026-10-28', time: '12:30' }, now);
  assert.strictEqual(halfHour.code, 'T-30M');
  assert.strictEqual(halfHour.minutes, 30);
  assert.strictEqual(halfHour.hours, null);

  const tomorrow = core.eventStatus({ label: 'Tomorrow', date: '2026-10-29', time: '09:00' }, now);
  assert.strictEqual(tomorrow.code, 'T-21H');

  const twoDays = core.eventStatus({ label: 'Later', date: '2026-10-30', time: '12:00' }, now);
  assert.strictEqual(twoDays.code, 'T-2D');
  assert.strictEqual(twoDays.days, 2);

  const exactlyNow = core.eventStatus({ label: 'Now', date: '2026-10-28', time: '12:00' }, now);
  assert.strictEqual(exactlyNow.state, 'past');
  assert.strictEqual(exactlyNow.code, 'PASSED');

  const earlier = core.eventStatus({ label: 'Earlier', date: '2026-10-28', time: '11:59' }, now);
  assert.strictEqual(earlier.state, 'past');
});

test('nextEvent: nearest non-past, ignores invalid entries', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);
  const list = [
    { id: 'past', label: 'Past', date: '2026-10-27', time: '' },
    { id: 'bad', label: 'Bad', date: '2026-02-30', time: '' },
    { id: 'later', label: 'Later', date: '2026-10-30', time: '' },
    { id: 'soon', label: 'Soon', date: '2026-10-28', time: '13:00' },
    { id: 'tomorrow', label: 'Tomorrow', date: '2026-10-29', time: '' }
  ];
  assert.strictEqual(core.nextEvent(list, now).id, 'soon');
  assert.strictEqual(core.nextEvent(list.slice(0, 2), now), null);
  assert.strictEqual(core.nextEvent(null, now), null);

  const dayOnlyToday = [
    { id: 'today', label: 'Today', date: '2026-10-28', time: '' },
    { id: 'tonight', label: 'Tonight', date: '2026-10-28', time: '20:00' }
  ];
  assert.strictEqual(core.nextEvent(dayOnlyToday, now).id, 'today');
});

test('formatEventDate: uppercase month, padded day, optional time', () => {
  assert.strictEqual(core.formatEventDate({ date: '2026-10-28', time: '' }), '28 OCT 2026');
  assert.strictEqual(core.formatEventDate({ date: '2026-10-28', time: '09:00' }), '28 OCT 2026 · 09:00');
  assert.strictEqual(core.formatEventDate({ date: '2026-10-05', time: '' }), '05 OCT 2026');
  assert.strictEqual(core.formatEventDate({ date: 'bad' }), '');
  assert.strictEqual(core.formatEventDate(null), '');
});

/* ---------- calculator ---------- */

test('calculate: supported arithmetic and precedence', () => {
  assert.strictEqual(core.calculate('12*8'), 96);
  assert.strictEqual(core.calculate('(2+3)*4'), 20);
  assert.strictEqual(core.calculate('2^3^2'), 512);
  assert.strictEqual(core.calculate('-5+2'), -3);
  assert.strictEqual(core.calculate('5%2'), 1);
  assert.strictEqual(core.calculate(' 1.5 + 2.5 '), 4);
  assert.strictEqual(core.calculate('2^-3'), 0.125);
  assert.strictEqual(core.calculate('-2^2'), -4);
  assert.strictEqual(core.calculate('--5'), 5);
  assert.strictEqual(core.calculate('+5'), 5);
  assert.strictEqual(core.calculate('.5 + .5'), 1);
  assert.strictEqual(core.calculate('2.'), 2);
  assert.strictEqual(core.calculate('((2))'), 2);
  assert.strictEqual(core.calculate('10/4'), 2.5);
  assert.strictEqual(core.calculate('2^3*2'), 16);
  assert.strictEqual(core.calculate('1/2/2'), 0.25);
});

test('calculate: rejects invalid input, zero division and non-finite results', () => {
  assert.strictEqual(core.calculate(''), null);
  assert.strictEqual(core.calculate('   '), null);
  assert.strictEqual(core.calculate('abc'), null);
  assert.strictEqual(core.calculate('1e3'), null);
  assert.strictEqual(core.calculate('2+'), null);
  assert.strictEqual(core.calculate('1+*2'), null);
  assert.strictEqual(core.calculate('(2+3'), null);
  assert.strictEqual(core.calculate('2+3)'), null);
  assert.strictEqual(core.calculate('2(3)'), null);
  assert.strictEqual(core.calculate('1 2'), null);
  assert.strictEqual(core.calculate('1..2'), null);
  assert.strictEqual(core.calculate('1/0'), null);
  assert.strictEqual(core.calculate('5%0'), null);
  assert.strictEqual(core.calculate('0/0'), null);
  assert.strictEqual(core.calculate('9^9999'), null);
  assert.strictEqual(core.calculate('http://example.com/2'), null);
  assert.strictEqual(core.calculate(null), null);
  assert.strictEqual(core.calculate('1+'.repeat(61)), null);
});

test('formatNumber: compact, precision trimmed, exponential extremes', () => {
  assert.strictEqual(core.formatNumber(96), '96');
  assert.strictEqual(core.formatNumber(2.5), '2.5');
  assert.strictEqual(core.formatNumber(0.1 + 0.2), '0.3');
  assert.strictEqual(core.formatNumber(-3), '-3');
  assert.strictEqual(core.formatNumber(0), '0');
  assert.strictEqual(core.formatNumber(1e12), '1e+12');
  assert.strictEqual(core.formatNumber(1.5e-10), '1.5e-10');
  assert.strictEqual(core.formatNumber(NaN), '');
  assert.strictEqual(core.formatNumber(Infinity), '');
});

test('isMathExpression: requires a digit, an operator, and a valid result', () => {
  assert.strictEqual(core.isMathExpression('12*8'), true);
  assert.strictEqual(core.isMathExpression('(2+3)*4'), true);
  assert.strictEqual(core.isMathExpression('2^3'), true);
  assert.strictEqual(core.isMathExpression('5%2'), true);
  assert.strictEqual(core.isMathExpression('  7 + 5  '), true);
  assert.strictEqual(core.isMathExpression('42'), false);
  assert.strictEqual(core.isMathExpression(''), false);
  assert.strictEqual(core.isMathExpression('abc'), false);
  assert.strictEqual(core.isMathExpression('timer 10'), false);
  assert.strictEqual(core.isMathExpression('https://example.com/2'), false);
  assert.strictEqual(core.isMathExpression('1/0'), false);
  assert.strictEqual(core.isMathExpression('2+'), false);
  assert.strictEqual(core.isMathExpression('2026-10-28'), false);
  assert.strictEqual(core.isMathExpression('1-800-555-0199'), false);
  assert.strictEqual(core.isMathExpression('100-50'), true);
});

/* ---------- search ---------- */

test('search engines: labels, suggestion flags and every URL', () => {
  const starts = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
    youtube: 'https://www.youtube.com/results?search_query=',
    perplexity: 'https://www.perplexity.ai/search?q='
  };
  const engines = Object.keys(starts);
  assert.deepStrictEqual(engines.sort(), Object.keys(core.SEARCH_ENGINES).sort());
  engines.forEach((engine) => {
    assert.strictEqual(core.SEARCH_ENGINES[engine].suggest, engine === 'google');
    assert.strictEqual(typeof core.SEARCH_ENGINES[engine].label, 'string');
    assert.strictEqual(core.searchUrl(engine, 'nixie clock'), starts[engine] + 'nixie%20clock');
    assert.strictEqual(core.searchUrl(engine, 'a&b'), starts[engine] + 'a%26b');
  });
  assert.strictEqual(core.searchUrl('unknown', 'a&b'),
    'https://www.google.com/search?q=a%26b');
});

/* ---------- fuzzy matching ---------- */

test('fuzzyScore: ranking and rejection', () => {
  const exact = core.fuzzyScore('timer', 'timer');
  const prefix = core.fuzzyScore('timer', 'timer 10');
  const includes = core.fuzzyScore('timer', 'start timer');
  const subsequence = core.fuzzyScore('tmr', 'start timer');

  assert.strictEqual(exact, 1000);
  assert.ok(prefix < exact);
  assert.ok(includes < prefix);
  assert.ok(subsequence >= 0);
  assert.ok(subsequence < includes);
  assert.strictEqual(core.fuzzyScore('zzz', 'timer'), -1);
  assert.strictEqual(core.fuzzyScore('timer', 'TIMER'), 1000);
  assert.strictEqual(core.fuzzyScore(' timer ', 'Timer'), 1000);
  assert.strictEqual(core.fuzzyScore('', 'anything'), 0);
  assert.strictEqual(core.fuzzyScore('timer', ''), -1);
  assert.strictEqual(core.fuzzyScore(null, 'timer'), -1);
});

/* ---------- sites ---------- */

test('sites: validates, names, truncates and dedupes normalized URLs', () => {
  const longName = '  ' + 'N'.repeat(80) + '  ';
  const sites = core.normalizeSites([
    { name: '  GitHub  ', url: ' https://github.com ' },
    { name: 'Duplicate', url: 'https://github.com/' },
    { url: 'https://www.example.com/path' },
    { name: longName, url: 'http://example.org' },
    { name: 'FTP', url: 'ftp://example.com' },
    { name: 'Script', url: 'javascript:alert(1)' },
    { name: 'Broken', url: 'not a url' },
    { name: 'Empty', url: '   ' },
    { name: 'UpperCaseHost', url: 'https://www.EXAMPLE.com/path' },
    null,
    'nope'
  ]);

  assert.deepStrictEqual(sites, [
    { name: 'GitHub', url: 'https://github.com' },
    { name: 'example.com', url: 'https://www.example.com/path' },
    { name: 'N'.repeat(60), url: 'http://example.org' }
  ]);
  assert.deepStrictEqual(core.normalizeSites(null), []);
  assert.deepStrictEqual(core.normalizeSites([{}]), []);
});

/* ---------- backup ---------- */

test('backup: build shape and parse round trip (object + JSON string)', () => {
  const sites = [
    { name: 'GitHub', url: 'https://github.com' },
    { name: 'Example', url: 'https://example.com/' }
  ];
  const tasks = [{ id: 't1', text: 'Buy milk', done: false }];
  const events = [
    { id: 'e1', label: 'Exam', date: '2026-11-05', time: '09:00' },
    { id: 'e2', label: 'Trip', date: '2026-11-01', time: '' }
  ];
  const settings = Object.assign({}, core.SETTINGS_DEFAULTS, {
    clock24: true,
    theme: 'ice',
    dim: true,
    alarmTone: 'chime',
    alarmVolume: 0.4,
    searchEngine: 'duckduckgo',
    suggestions: false
  });

  const backup = core.buildBackup({ sites, tasks, events, settings });
  assert.strictEqual(backup.app, 'Nixie New Tab');
  assert.strictEqual(backup.version, 1);
  assert.ok(!Number.isNaN(Date.parse(backup.exportedAt)));
  assert.deepStrictEqual(backup.data.sites, sites);
  assert.deepStrictEqual(backup.data.tasks, tasks);
  assert.deepStrictEqual(backup.data.events, events);
  assert.deepStrictEqual(backup.data.settings, settings);

  const expected = {
    sites: core.normalizeSites(sites),
    tasks,
    events: core.normalizeEvents(events),
    settings
  };

  assert.deepStrictEqual(core.parseBackup(backup), expected);
  assert.deepStrictEqual(core.parseBackup(JSON.stringify(backup)), expected);
});

test('backup: missing fields stay null so callers can merge', () => {
  const partial = core.parseBackup({ settings: { dim: true } });
  assert.strictEqual(partial.sites, null);
  assert.strictEqual(partial.tasks, null);
  assert.strictEqual(partial.events, null);
  assert.deepStrictEqual(partial.settings, { dim: true });

  const wrapped = core.parseBackup({ data: { sites: [] } });
  assert.deepStrictEqual(wrapped.sites, []);
  assert.strictEqual(wrapped.tasks, null);
  assert.strictEqual(wrapped.events, null);
  assert.strictEqual(wrapped.settings, null);
});

test('backup: empty arrays are preserved', () => {
  const empty = core.parseBackup({
    data: { sites: [], tasks: [], events: [], settings: {} }
  });
  assert.deepStrictEqual(empty.sites, []);
  assert.deepStrictEqual(empty.tasks, []);
  assert.deepStrictEqual(empty.events, []);
  assert.strictEqual(empty.settings, null);
});

test('backup: null and wrong-type fields do not erase existing data', () => {
  assert.strictEqual(core.parseBackup({
    data: { sites: null, tasks: null, events: {}, settings: null }
  }), null);

  const partial = core.parseBackup({
    data: { sites: null, tasks: [], events: {}, settings: null }
  });
  assert.strictEqual(partial.sites, null);
  assert.deepStrictEqual(partial.tasks, []);
  assert.strictEqual(partial.events, null);
  assert.strictEqual(partial.settings, null);

  const tasksOnly = core.parseBackup(core.buildBackup({ tasks: [] }));
  assert.strictEqual(tasksOnly.sites, null);
  assert.deepStrictEqual(tasksOnly.tasks, []);
  assert.strictEqual(tasksOnly.events, null);
  assert.strictEqual(tasksOnly.settings, null);

  assert.strictEqual(core.parseBackup({
    sites: [{ name: '', url: '' }],
    events: [{ label: '', date: 'not-a-date', time: '' }]
  }), null);
});

test('backup: malformed input returns null and an archive with no usable fields is rejected', () => {
  [null, 42, 'not json', '{', 'null', '[]', '"text"', [], {}, { foo: 1 }, { data: [] }]
    .forEach((input) => assert.strictEqual(core.parseBackup(input), null, String(input)));

  assert.strictEqual(core.parseBackup({ tasks: 'not an array' }), null);
  assert.strictEqual(core.parseBackup({ data: { tasks: 'not an array' } }), null);

  const partialBad = core.parseBackup({ tasks: 'not an array', events: [] });
  assert.strictEqual(partialBad.tasks, null);
  assert.deepStrictEqual(partialBad.events, []);
  assert.strictEqual(partialBad.sites, null);
  assert.strictEqual(partialBad.settings, null);
});

/* ---------- Brave Shields telemetry ---------- */

test('shields: settings normalise and default to enabled with no path', () => {
  assert.deepStrictEqual(core.normalizeShields(null), { enabled: true, path: '' });
  assert.deepStrictEqual(core.normalizeShields({ enabled: false, path: '  C:\\x\\Preferences  ' }),
    { enabled: false, path: 'C:\\x\\Preferences' });
  assert.deepStrictEqual(core.normalizeShields({ enabled: 'no', path: 42 }), { enabled: true, path: '' });
});

test('shields: count formatting uses thousands separators', () => {
  assert.strictEqual(core.formatCount(0), '0');
  assert.strictEqual(core.formatCount(64152), '64,152');
  assert.strictEqual(core.formatCount('1234567'), '1,234,567');
  assert.strictEqual(core.formatCount(-4), '0');
  assert.strictEqual(core.formatCount('nope'), '0');
});

test('shields: bandwidth uses Brave binary thresholds', () => {
  assert.deepStrictEqual(core.formatBytes(500), { value: '500', unit: 'B' });
  assert.deepStrictEqual(core.formatBytes(1024), { value: '1', unit: 'KB' });
  assert.deepStrictEqual(core.formatBytes(1536), { value: '2', unit: 'KB' });
  assert.deepStrictEqual(core.formatBytes(1048576), { value: '1.0', unit: 'MB' });
  assert.deepStrictEqual(core.formatBytes(1987576763), { value: '1.85', unit: 'GB' });
  assert.deepStrictEqual(core.formatBytes(0), { value: '0', unit: 'B' });
});

test('shields: time saved follows the 50 ms per blocked item estimate', () => {
  assert.deepStrictEqual(core.formatTimeSaved(0), { value: '0', unit: 'SEC' });
  assert.deepStrictEqual(core.formatTimeSaved(10), { value: '1', unit: 'SEC' });
  assert.deepStrictEqual(core.formatTimeSaved(1200), { value: '1', unit: 'MIN' });
  assert.deepStrictEqual(core.formatTimeSaved(64152), { value: '54', unit: 'MIN' });
  assert.deepStrictEqual(core.formatTimeSaved(144000), { value: '2', unit: 'HRS' });
  assert.deepStrictEqual(core.formatTimeSaved(1728000), { value: '1', unit: 'DAYS' });
});

test('shields: extract brave.stats from a parsed Preferences object', () => {
  const stats = core.extractBraveStats({
    brave: {
      stats: {
        ads_blocked: '64152',
        bandwidth_saved_bytes: '1987576763',
        daily_saving_predictions_bytes: [
          { day: 1793212200, value: 303177 },
          { day: 'bad', value: 1 },
          null
        ]
      }
    }
  });
  assert.strictEqual(stats.adsBlocked, 64152);
  assert.strictEqual(stats.bandwidthBytes, 1987576763);
  assert.strictEqual(stats.timeSavedMs, 3207600);
  assert.deepStrictEqual(stats.daily, [{ day: 1793212200, value: 303177 }]);

  assert.strictEqual(core.extractBraveStats(null), null);
  assert.strictEqual(core.extractBraveStats({ brave: {} }), null);
  assert.strictEqual(core.extractBraveStats({ brave: { stats: {} } }), null);
});

test('shields: active profile metadata identifies the profile in use', () => {
  const activity = core.extractBraveProfileActivity({
    profile: {
      last_used: 'Default',
      last_active_profiles: ['Default', 'Profile 1'],
      info_cache: {
        Default: { active_time: 100 },
        'Profile 1': { active_time: 200 },
        Broken: { active_time: 'nope' }
      }
    }
  });
  assert.deepStrictEqual(activity, {
    active: { Default: 100, 'Profile 1': 200 },
    lastUsed: 'Default',
    order: ['Default', 'Profile 1']
  });
  assert.deepStrictEqual(core.extractBraveProfileActivity({ profile: { last_used: 'Default' } }),
    { active: {}, lastUsed: 'Default', order: [] });
  assert.strictEqual(core.extractBraveProfileActivity(null), null);
  assert.strictEqual(core.extractBraveProfileActivity({}), null);
  assert.strictEqual(core.extractBraveProfileActivity({ profile: {} }), null);
});

test('shields: windows and posix paths become file URLs', () => {
  assert.strictEqual(
    core.toFileUrl('C:\\Users\\PC\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Profile 1\\Preferences'),
    'file:///C:/Users/PC/AppData/Local/BraveSoftware/Brave-Browser/User%20Data/Profile%201/Preferences'
  );
  assert.strictEqual(core.toFileUrl('/Users/me/Library/Preferences'), 'file:///Users/me/Library/Preferences');
  assert.strictEqual(core.toFileUrl('file:///C:/already/here'), 'file:///C:/already/here');
  assert.strictEqual(core.toFileUrl(''), '');
  assert.strictEqual(core.toFileUrl(null), '');
});

test('shields: profile folder paths gain the Preferences filename', () => {
  assert.strictEqual(
    core.normalizePreferencesPath('C:\\Users\\PC\\Brave\\User Data\\Profile 1'),
    'C:/Users/PC/Brave/User Data/Profile 1/Preferences'
  );
  assert.strictEqual(
    core.normalizePreferencesPath('C:\\Users\\PC\\Brave\\User Data\\Default\\Preferences'),
    'C:/Users/PC/Brave/User Data/Default/Preferences'
  );
  assert.strictEqual(
    core.normalizePreferencesPath('C:\\Users\\PC\\Brave\\User Data'),
    'C:/Users/PC/Brave/User Data'
  );
});

test('shields: profile label is the parent folder', () => {
  assert.strictEqual(
    core.profileLabelFromPath('C:\\Users\\PC\\Brave\\User Data\\Profile 1\\Preferences'),
    'Profile 1'
  );
  assert.strictEqual(
    core.profileLabelFromPath('file:///Users/me/Brave/User%20Data/Default/Preferences'),
    'Default'
  );
  assert.strictEqual(core.profileLabelFromPath(''), '');
});

test('shields: chromium directory listings are parsed', () => {
  const html = '<script>function addRow(name, url, isdir, size) {}' +
    'addRow("Default","Default",1,0,"0 B",1,"x")' +
    'addRow("Profile%201","Profile%201",1,0,"0 B",1,"x")' +
    'addRow("Preferences","Preferences",0,12,"12 B",1,"x")' +
    'addRow("odd \\"name\\"","odd",1,0,"0 B",1,"x")</script>';
  assert.deepStrictEqual(core.parseDirectoryListing(html), [
    { name: 'Default', url: 'Default', isDir: true },
    { name: 'Profile%201', url: 'Profile%201', isDir: true },
    { name: 'Preferences', url: 'Preferences', isDir: false },
    { name: 'odd "name"', url: 'odd', isDir: true }
  ]);
  assert.deepStrictEqual(core.parseDirectoryListing('<html></html>'), []);
  assert.deepStrictEqual(core.parseDirectoryListing(null), []);
});

/* ---------- top-level metadata ---------- */

test('metadata: version and option lists', () => {
  assert.strictEqual(core.VERSION, '1.3.0');
  assert.deepStrictEqual(core.THEMES.map((theme) => theme.id),
    ['plasma', 'phosphor', 'ice', 'red']);
  assert.deepStrictEqual(core.TONES.map((tone) => tone.id),
    ['classic', 'chime', 'bell', 'silent']);
  assert.strictEqual(core.TONES[3].label, 'Silent / visual only');
});

console.log('\n' + passed + ' tests passed.');
