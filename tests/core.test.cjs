'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../core.js');
const samples = require('../sample-tabs.js');

function total(tab) { return Core.slots(tab).reduce((sum, slot) => sum + slot.duration, 0); }
function beats(tab, divisions) { return tab.beats.map((beat, i) => ({ ...beat, division: divisions[i] })); }

test('4/4 with eighth subdivisions keeps quarter beats and is distinct from 8/8', () => {
  const four = Core.createTab({ division: 2 });
  const eight = Core.createTab({ meter: { numerator: 8, denominator: 8 } });
  assert.equal(total(four), 4);
  assert.equal(total(eight), 4);
  assert.equal(four.beats.length, 4);
  assert.equal(eight.beats.length, 8);
  assert.deepEqual(Core.slots(four).map(slot => slot.label), ['1', 'и', '2', 'и', '3', 'и', '4', 'и']);
  assert.deepEqual(Core.slots(eight).map(slot => slot.label), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(Core.slots(four).map(slot => slot.offset), Core.slots(eight).map(slot => slot.offset));
  assert.equal(four.measures.length, 4);
  for (const measure of four.measures) for (const row of ['main', 'R', 'L']) assert.equal(measure.rows[row].length, 8);
});

test('12/8 groups four dotted-quarter beats with three eighth-note slots each', () => {
  const tab = Core.createTab({ meter: { numerator: 12, denominator: 8 } });
  assert.deepEqual(tab.beats.map(beat => [beat.units, beat.division]), [[3, 3], [3, 3], [3, 3], [3, 3]]);
  assert.equal(Core.slots(tab).length, 12);
  assert.equal(total(tab), 6);
  assert.equal(Core.slots(tab)[3].offset, 1.5);
  assert.equal(Core.slots(tab)[0].duration, 0.5);
  assert.deepEqual(Core.makeBeats(tab.meter, 1).map(beat => beat.division), [1, 1, 1, 1]);
});

test('only the third quarter can be divided without changing other durations', () => {
  const tab = Core.createTab();
  const changed = Core.setRhythm(tab, tab.meter, beats(tab, [1, 1, 2, 1]));
  assert.equal(changed.lost, 0);
  assert.deepEqual(Core.slots(changed.tab).map(slot => slot.label), ['1', '2', '3', 'и', '4']);
  assert.deepEqual(Core.slots(changed.tab).map(slot => slot.offset), [0, 1, 2, 2.5, 3]);
  assert.deepEqual(Core.slots(changed.tab).map(slot => slot.duration), [1, 1, 0.5, 0.5, 1]);
  assert.equal(tab.measures[0].rows.main.length, 4);
});

test('subdivision changes preserve onset positions and report disappearing occupied cells', () => {
  const original = Core.createTab({ division: 2 });
  original.measures[0].rows.main[1] = ['D', '4'];
  original.measures[0].rows.main[2] = ['S'];
  const changed = Core.setRhythm(original, original.meter, Core.makeBeats(original.meter, 1));
  assert.equal(changed.lost, 1);
  assert.deepEqual(changed.tab.measures[0].rows.main, [[], ['S'], [], []]);
  assert.deepEqual(original.measures[0].rows.main[1], ['D', '4']);
  const expanded = Core.setRhythm(original, original.meter, Core.makeBeats(original.meter, 4));
  assert.equal(expanded.lost, 0);
  assert.deepEqual(expanded.tab.measures[0].rows.main[2], ['D', '4']);
  assert.deepEqual(expanded.tab.measures[0].rows.main[4], ['S']);
});

test('rational onset matching handles thirds exactly across different meters', () => {
  const tab = Core.createTab({ meter: { numerator: 1, denominator: 4 }, division: 3 });
  tab.measures[0].rows.main[1] = ['D'];
  const changed = Core.setRhythm(tab, { numerator: 2, denominator: 8 }, [{ units: 2, division: 3, label: '1', syllables: [] }]);
  assert.equal(changed.lost, 0);
  assert.deepEqual(changed.tab.measures[0].rows.main[1], ['D']);
  assert.equal(total(changed.tab), 1);
});

test('separate hand rows merge simultaneous notes into one chord and split deterministically', () => {
  const tab = Core.createTab({ hands: 'split' });
  tab.measures[0].rows.R[0] = ['D'];
  tab.measures[0].rows.L[0] = ['4', '8'];
  tab.measures[0].rows.L[1] = ['6'];
  const single = Core.setHands(tab, 'single');
  assert.deepEqual(single.measures[0].rows.main[0], ['D', '4', '8']);
  assert.deepEqual(single.measures[0].rows.main[1], ['6']);
  assert.deepEqual(single.measures[0].rows.L[0], []);
  const split = Core.setHands(single, 'split');
  assert.deepEqual(split.measures[0].rows.R[0], ['D', '4', '8']);
  assert.deepEqual(split.measures[0].rows.L[0], []);
  assert.deepEqual(split.measures[0].rows.main[0], []);
  assert.deepEqual(tab.measures[0].rows.R[0], ['D']);
});

test('merging hand rows deduplicates shared notes and rejects oversized chords without mutating either hand', () => {
  const tab = Core.createTab({ hands: 'split' });
  tab.measures[0].rows.R[0] = ['D', '1', '2', '3', '4', '5', '6', '7'];
  tab.measures[0].rows.L[0] = ['D', '3', '7'];
  const merged = Core.setHands(tab, 'single');
  assert.deepEqual(merged.measures[0].rows.main[0], ['D', '1', '2', '3', '4', '5', '6', '7']);
  assert.doesNotThrow(() => Core.validateTab(merged));
  tab.measures[0].rows.L[0].push('8');
  const before = Core.clone(tab);
  assert.throws(() => Core.setHands(tab, 'single'), /больше 8 разных нот/u);
  assert.deepEqual(tab, before);
  assert.equal(tab.hands, 'split');
});

test('konnakol phrase groups repeat across the unchanged timing grid', () => {
  const tab = Core.createTab({ division: 2 });
  tab.notation = 'konnakol';
  tab.phrases = [{ size: 3, syllables: ['Ta', 'Ki', 'Ta'] }, { size: 2, syllables: ['Ta', 'Ka'] }];
  const grid = Core.slots(tab);
  assert.deepEqual(grid.map(slot => slot.syllable), ['Ta', 'Ki', 'Ta', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta']);
  assert.deepEqual(grid.map(slot => slot.groupStart), [true, false, false, true, false, true, false, false]);
  assert.equal(total(tab), 4);
  const custom = Core.createTab();
  custom.beats[0].syllables = ['Dhom'];
  assert.equal(Core.slots(custom)[0].syllable, 'Dhom');
});

test('chords remain one cell, rests are empty arrays, invalid tokens fail', () => {
  assert.deepEqual(Core.parseToken(' D / 4 / 8 '), ['D', '4', '8']);
  assert.deepEqual(Core.parseToken('-'), []);
  assert.deepEqual(Core.parseToken(''), []);
  assert.equal(Core.tokenText(['D', '4']), 'D/4');
  assert.equal(Core.tokenText([]), '-');
  assert.throws(() => Core.parseToken('D//4'));
  assert.throws(() => Core.parseToken(['-']));
});

test('all three samples match original column counts, chords and hand rows', () => {
  assert.deepEqual(samples.map(tab => tab.measures.length), [7, 4, 2]);
  assert.deepEqual(samples.map(tab => Core.slots(tab).length), [14, 8, 10]);
  assert.deepEqual(Core.slots(samples[1]).map(slot => slot.label), ['1', '2', 'и', '3', '1', '2', '1', '2']);
  assert.deepEqual(Core.slots(samples[2]).map(slot => slot.label), ['1', '2', 'и', '3', '1', '2', 'и', '3', '1', '2']);
  assert.deepEqual(samples[0].measures[0].rows.main[0], ['D', '4']);
  assert.deepEqual(samples[1].measures[0].rows.main[0], ['2', '4', '8']);
  assert.deepEqual(samples[2].measures[1].rows.L.map(Core.tokenText), ['8', '-', '7', '-', '6', '-', '1', '-', '6', '-']);
  assert.equal(samples[0].phraseExample.labels.length, 16);
  assert.equal(samples[0].phrases.length, 0);
  for (const filename of ['hang-1.json', 'hang-2.json', 'hang-massive.json']) {
    const tab = JSON.parse(fs.readFileSync(path.join(__dirname, '../tabs', filename), 'utf8'));
    const sample = samples.find(sample => sample.id === tab.id);
    assert.deepEqual(Core.validateTab(tab), sample);
  }
});

test('every bundled JSON filename matches its document ID used by save and delete', () => {
  const directory = path.join(__dirname, '../tabs');
  for (const filename of fs.readdirSync(directory).filter(filename => filename.endsWith('.json'))) {
    const tab = Core.validateTab(JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')));
    assert.equal(tab.id, path.basename(filename, '.json'), filename);
  }
});

test('imports public sample COUNT/note pairs without changing local count labels', () => {
  // Build the legacy TXT fixture from the already bundled public example.
  const count = Core.slots(samples[1]).map(slot => slot.label).join(' | ');
  const source = samples[1].measures.map(measure => 'COUNT: ' + count + '\n' + measure.rows.main.map(Core.tokenText).join(' | ')).join('\n\n');
  const imported = Core.importText(source, 'Из TXT');
  assert.deepEqual(imported.meter, { numerator: 7, denominator: 4 });
  assert.equal(imported.measures.length, 4);
  assert.deepEqual(Core.slots(imported).map(slot => slot.label), Core.slots(samples[1]).map(slot => slot.label));
  assert.deepEqual(imported.measures.map(measure => measure.rows.main), samples[1].measures.map(measure => measure.rows.main));
});

test('imports legacy COUNT/R/L blocks and compact count/note pairs', () => {
  const text = 'COUNT: 1 | 2 | и | 3\nR: D | 1 | - | D\nL: 6 | - | 6 | -\n\nCOUNT: 1 | 2 | и | 3\n(R) D | 1 | - | D\n(L) 8 | - | 7 | -';
  const tab = Core.importText(text);
  assert.equal(tab.hands, 'split');
  assert.equal(tab.measures.length, 2);
  assert.deepEqual(tab.measures[1].rows.L[2], ['7']);
  const compact = Core.importText('1и2и3и4и5и6и7и\nD/4--DS--KD-S--K');
  assert.equal(Core.slots(compact).length, 14);
  assert.deepEqual(compact.measures[0].rows.main, samples[0].measures[0].rows.main);
  assert.throws(() => Core.importText('TA | KA | DI | MI\nD | - | S | -'), /счёт|счета|счёта/iu);
  assert.throws(() => Core.importText('1 | 2\nD'), /число нот/iu);
});

test('JSON validates to a cloned canonical object and rejects incompatible or corrupt rhythm data', () => {
  const original = Core.createTab();
  original.title = '<script>example</script>';
  original.unknown = { dangerous: true };
  const tab = Core.validateTab(JSON.parse(JSON.stringify(original)));
  assert.equal(tab.title, original.title);
  assert.equal(tab.unknown, undefined);
  tab.measures[0].rows.main[0].push('D');
  assert.deepEqual(original.measures[0].rows.main[0], []);
  for (const mutation of [
    value => { value.version = 2; },
    value => { value.format = 'another-format'; },
    value => { value.meter.denominator = 3; },
    value => { value.beats[0].division = 0; },
    value => { value.beats[0].units = 2; },
    value => { value.measures[0].rows.main.pop(); },
    value => { value.measures[1].id = value.measures[0].id; },
    value => { value.phrases = [{ size: 3, syllables: ['Ta'] }]; }
  ]) {
    const bad = Core.clone(original);
    mutation(bad);
    assert.throws(() => Core.validateTab(bad));
  }
});

test('document and measure IDs match the storage server character and length rules', () => {
  const valid = Core.createTab();
  valid.id = 'A_z-0123';
  assert.equal(Core.validateTab(valid).id, 'A_z-0123');
  for (const id of ['', '../tab', 'sub/tab', 'tab.json', 'таб', 'tab\n', 'tab\r', 'x'.repeat(81), 42, null]) {
    const badDocument = Core.clone(valid);
    badDocument.id = id;
    assert.throws(() => Core.validateTab(badDocument), /ID/u);
    const badMeasure = Core.clone(valid);
    badMeasure.measures[0].id = id;
    assert.throws(() => Core.validateTab(badMeasure), /ID/u);
  }
  const absent = Core.clone(valid);
  delete absent.id;
  const assigned = Core.validateTab(absent).id;
  assert.ok(assigned.length <= 80 && !/[^A-Za-z0-9_-]/u.test(assigned));
});

test('splitting the first quarter of one measure preserves other measures and chord onsets', () => {
  const original = Core.createTab();
  original.measures[0].label = 'Вступление';
  original.measures[0].rows.main[0] = ['D', '4'];
  original.measures[0].rows.main[1] = ['S'];
  original.measures[1].rows.main[1] = ['8'];
  const snapshot = Core.clone(original);
  const changed = Core.setMeasureRhythm(original, 0, beats(original, [2, 1, 1, 1]));
  assert.equal(changed.lost, 0);
  assert.deepEqual(changed.tab.beats, original.beats);
  assert.deepEqual(Core.slots(changed.tab, 0).map(slot => slot.label), ['1', 'и', '2', '3', '4']);
  assert.deepEqual(Core.slots(changed.tab, 0).map(slot => slot.offset), [0, 0.5, 1, 2, 3]);
  assert.deepEqual(changed.tab.measures[0].rows.main, [['D', '4'], [], ['S'], [], []]);
  assert.equal(changed.tab.measures[0].label, 'Вступление');
  assert.equal(changed.tab.measures[0].id, original.measures[0].id);
  assert.deepEqual(changed.tab.measures.slice(1), original.measures.slice(1));
  assert.deepEqual(Core.measureBeats(changed.tab, 0).map(beat => beat.division), [2, 1, 1, 1]);
  assert.deepEqual(Core.measureBeats(changed.tab, 1), original.beats);
  assert.equal(Core.slots(changed.tab).length, 4);
  assert.equal(Core.emptyMeasure(changed.tab).rows.main.length, 4);
  assert.deepEqual(original, snapshot);
  const reset = Core.setMeasureRhythm(changed.tab, 0, original.beats);
  assert.equal(reset.lost, 0);
  assert.equal(Object.hasOwn(reset.tab.measures[0], 'beats'), false);
  assert.deepEqual(reset.tab, original);
  assert.throws(() => Core.setMeasureRhythm(original, -1, original.beats), /Индекс/u);
  assert.throws(() => Core.setMeasureRhythm(original, 4, original.beats), /Индекс/u);
  assert.throws(() => Core.setMeasureRhythm(original, undefined, original.beats), /Индекс/u);
});

test('local rhythm loss counts only occupied target cells and remaps both hand rows', () => {
  const original = Core.createTab({ hands: 'split', division: 2 });
  original.measures[0].rows.R[1] = ['D', '4'];
  original.measures[0].rows.L[1] = ['6'];
  original.measures[0].rows.R[2] = ['S'];
  original.measures[0].rows.L[6] = ['7', '8'];
  original.measures[1].rows.R[1] = ['D'];
  const changed = Core.setMeasureRhythm(original, 0, Core.makeBeats(original.meter, 1));
  assert.equal(changed.lost, 2);
  assert.deepEqual(changed.tab.measures[0].rows.R, [[], ['S'], [], []]);
  assert.deepEqual(changed.tab.measures[0].rows.L, [[], [], [], ['7', '8']]);
  assert.deepEqual(changed.tab.measures[1], original.measures[1]);
  const merged = Core.setHands(changed.tab, 'single');
  assert.deepEqual(merged.measures.map(measure => measure.rows.main.length), [4, 8, 8, 8]);
  assert.deepEqual(merged.measures[0].rows.main[3], ['7', '8']);
  assert.deepEqual(merged.measures[0].beats, changed.tab.measures[0].beats);
  assert.doesNotThrow(() => Core.validateTab(merged));
});

test('global rhythm changes remap every measure from its own grid and remove all overrides', () => {
  const original = Core.createTab();
  let mixed = Core.setMeasureRhythm(original, 0, beats(original, [2, 1, 1, 1])).tab;
  mixed = Core.setMeasureRhythm(mixed, 1, beats(original, [3, 1, 1, 1])).tab;
  mixed.measures[0].rows.main[1] = ['D', '4']; // Onset 1/2.
  mixed.measures[0].rows.main[2] = ['S']; // Onset 1, despite differing cell index.
  mixed.measures[1].rows.main[1] = ['6']; // Onset 1/3 cannot map to eighths.
  mixed.measures[1].rows.main[3] = ['K']; // Onset 1.
  mixed.measures[2].rows.main[1] = ['8']; // Global grid onset 1.
  const snapshot = Core.clone(mixed);
  const changed = Core.setRhythm(mixed, mixed.meter, Core.makeBeats(mixed.meter, 2));
  assert.equal(changed.lost, 1);
  assert.deepEqual(changed.tab.measures[0].rows.main[1], ['D', '4']);
  assert.deepEqual(changed.tab.measures[0].rows.main[2], ['S']);
  assert.deepEqual(changed.tab.measures[1].rows.main[2], ['K']);
  assert.deepEqual(changed.tab.measures[2].rows.main[2], ['8']);
  for (const measure of changed.tab.measures) {
    assert.equal(Object.hasOwn(measure, 'beats'), false);
    for (const row of ['main', 'R', 'L']) assert.equal(measure.rows[row].length, 8);
  }
  assert.doesNotThrow(() => Core.validateTab(changed.tab));
  assert.deepEqual(mixed, snapshot);
});

test('mixed per-measure grids roundtrip JSON and reject corrupt overrides or wrong row sizes', () => {
  const original = Core.createTab();
  const mixed = Core.setMeasureRhythm(original, 2, beats(original, [1, 1, 4, 1])).tab;
  const roundtrip = Core.validateTab(JSON.parse(JSON.stringify(mixed)));
  assert.deepEqual(roundtrip, mixed);
  assert.deepEqual(roundtrip.measures.map((measure, i) => Core.slots(roundtrip, i).length), [4, 4, 7, 4]);
  roundtrip.measures[2].beats[2].label = 'Изменено';
  assert.equal(mixed.measures[2].beats[2].label, '3');
  for (const mutation of [
    tab => { tab.measures[2].beats[0].units = 2; },
    tab => { tab.measures[2].beats[2].division = 0; },
    tab => { tab.measures[2].beats[2].syllables = ['Ta']; },
    tab => { tab.measures[2].beats = []; },
    tab => { tab.measures[2].beats = null; },
    tab => { tab.measures[2].rows.L.pop(); },
    tab => { tab.measures[0].rows.main.push([]); }
  ]) {
    const bad = Core.clone(mixed);
    mutation(bad);
    assert.throws(() => Core.validateTab(bad));
  }
});

test('compound per-measure subdivisions preserve measure duration and use global phrases on each grid', () => {
  const original = Core.createTab({ meter: { numerator: 12, denominator: 8 } });
  const local = Core.clone(original.beats);
  local[0].division = 6;
  const changed = Core.setMeasureRhythm(original, 1, local).tab;
  assert.equal(Core.slots(changed).length, 12);
  assert.equal(Core.slots(changed, 0).length, 12);
  assert.equal(Core.slots(changed, 1).length, 15);
  assert.deepEqual(Core.slots(changed, 1).slice(0, 7).map(slot => slot.offset), [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]);
  assert.equal(Core.slots(changed, 1).reduce((sum, slot) => sum + slot.duration, 0), 6);
  changed.notation = 'konnakol';
  changed.phrases = [{ size: 4, syllables: ['Ta', 'Ka', 'Di', 'Mi'] }];
  assert.deepEqual(Core.slots(changed, 1).slice(0, 7).map(slot => slot.syllable), ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Di']);
  assert.deepEqual(Core.slots(changed, 1).slice(0, 7).map(slot => slot.groupStart), [true, false, false, false, true, false, false]);
  assert.doesNotThrow(() => Core.validateTab(changed));
});

test('hybrid notation keeps whole beats numeric and uses syllables only inside divided beats', () => {
  const original = Core.createTab();
  const tab = Core.setRhythm(original, original.meter, beats(original, [1, 2, 3, 4])).tab;
  tab.notation = 'hybrid';
  assert.deepEqual(Core.slots(tab).map(slot => slot.displayLabel), ['1', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta', 'Ta', 'Ka', 'Di', 'Mi']);
  assert.deepEqual(Core.slots(tab).map(slot => slot.groupStart), [true, true, false, true, false, false, true, false, false, false]);
  tab.notation = 'count';
  assert.deepEqual(Core.slots(tab).map(slot => slot.displayLabel), ['1', '2', 'и', '3', 'и', 'а', '4', 'e', 'and', 'a']);
  tab.notation = 'konnakol';
  assert.deepEqual(Core.slots(tab).map(slot => slot.displayLabel), ['Ta', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta', 'Ta', 'Ka', 'Di', 'Mi']);
});

test('hybrid notation resolves each measure and custom beat syllables without changing hits or timing', () => {
  const original = Core.createTab({ hands: 'split' });
  const local = beats(original, [1, 2, 1, 3]);
  local[0].label = 'A';
  local[0].syllables = ['Dhom'];
  local[1].syllables = ['Tum', 'Ka'];
  local[3].syllables = ['Ta', 'Ke', 'Tom'];
  const tab = Core.setMeasureRhythm(original, 1, local).tab;
  tab.measures[1].rows.R[1] = ['D', '4'];
  tab.measures[1].rows.L[5] = ['7'];
  const measuresBefore = Core.clone(tab.measures);
  const timingsBefore = Core.slots(tab, 1).map(({ offset, duration }) => ({ offset, duration }));
  tab.notation = 'hybrid';
  assert.deepEqual(Core.slots(tab, 1).map(slot => slot.displayLabel), ['A', 'Tum', 'Ka', '3', 'Ta', 'Ke', 'Tom']);
  assert.deepEqual(Core.slots(tab, 0).map(slot => slot.displayLabel), ['1', '2', '3', '4']);
  assert.deepEqual(Core.slots(tab, 1).map(({ offset, duration }) => ({ offset, duration })), timingsBefore);
  const roundtrip = Core.validateTab(JSON.parse(JSON.stringify(tab)));
  assert.deepEqual(roundtrip, tab);
  roundtrip.notation = 'konnakol';
  assert.equal(Core.slots(roundtrip, 1)[0].displayLabel, 'Dhom');
  roundtrip.notation = 'count';
  assert.equal(Core.slots(roundtrip, 1)[1].displayLabel, '2');
  assert.deepEqual(roundtrip.measures, measuresBefore);
});

test('hybrid ignores global phrases while preserving them for switching back to konnakol', () => {
  const original = Core.createTab();
  const tab = Core.setRhythm(original, original.meter, beats(original, [1, 2, 1, 1])).tab;
  tab.phrases = [{ size: 3, syllables: ['Dhom', 'Ki', 'Tom'] }];
  const phraseBefore = Core.clone(tab.phrases);
  tab.notation = 'hybrid';
  assert.deepEqual(Core.slots(tab).map(slot => slot.displayLabel), ['1', 'Ta', 'Ka', '3', '4']);
  assert.deepEqual(Core.slots(tab).map(slot => slot.groupStart), [true, true, false, true, true]);
  assert.deepEqual(Core.slots(tab).map(slot => slot.syllable), ['Ta', 'Ta', 'Ka', 'Ta', 'Ta']);
  tab.notation = 'konnakol';
  assert.deepEqual(Core.slots(tab).map(slot => slot.displayLabel), ['Dhom', 'Ki', 'Tom', 'Dhom', 'Ki']);
  assert.deepEqual(Core.slots(tab).map(slot => slot.groupStart), [true, false, false, true, false]);
  tab.notation = 'hybrid';
  assert.deepEqual(Core.validateTab(tab).phrases, phraseBefore);
});

test('splitting only the second offbeat creates two sixteenths and preserves every original onset', () => {
  const original = Core.createTab({ division: 2, hands: 'split' });
  original.measures[0].rows.R = Array.from({ length: 8 }, (_, i) => [String(i + 1)]);
  original.measures[0].rows.L[3] = ['D', '4'];
  original.measures[1].rows.L[3] = ['K'];
  const snapshot = Core.clone(original);
  const changed = Core.splitSlot(original, 0, 3);
  assert.equal(changed.lost, 0);
  assert.equal(changed.slot, 3);
  assert.deepEqual(changed.tab.meter, { numerator: 4, denominator: 4 });
  assert.deepEqual(Core.slots(changed.tab, 0).map(s => s.offset), [0, .5, 1, 1.5, 1.75, 2, 2.5, 3, 3.5]);
  assert.deepEqual(Core.slots(changed.tab, 0).map(s => s.duration), [.5, .5, .5, .25, .25, .5, .5, .5, .5]);
  assert.deepEqual(Core.slots(changed.tab, 0).map(s => s.label), ['1', 'и', '2', '(1', '2)', '3', 'и', '4', 'и']);
  assert.equal(Core.slots(changed.tab, 0)[3].parentLabel, 'и');
  assert.equal(Core.slots(changed.tab, 0)[3].durationFraction, '1/16');
  assert.deepEqual(changed.tab.measures[0].rows.R, [['1'], ['2'], ['3'], ['4'], [], ['5'], ['6'], ['7'], ['8']]);
  assert.deepEqual(changed.tab.measures[0].rows.L[3], ['D', '4']);
  assert.deepEqual(changed.tab.measures.slice(1), original.measures.slice(1));
  assert.deepEqual(Core.validateTab(Core.clone(changed.tab)), changed.tab);
  assert.deepEqual(original, snapshot);
  const merged = Core.mergeSlot(changed.tab, 0, 4);
  assert.equal(merged.slot, 3);
  assert.equal(merged.lost, 0);
  assert.deepEqual(merged.tab, original);
});

test('nested splits and merges retain exact third and sixth onsets across compound meters', () => {
  const original = Core.createTab({ meter: { numerator: 12, denominator: 8 } });
  original.measures[0].rows.main[1] = ['D'];
  original.measures[0].rows.main[2] = ['S'];
  let changed = Core.splitSlot(original, 0, 1, 3).tab;
  changed.measures[0].rows.main[2] = ['8']; // 2/3 of a quarter after bar start.
  changed = Core.setSlotSyllable(changed, 0, 2, 'Dhom');
  const beforeNested = Core.clone(changed);
  changed = Core.splitSlot(changed, 0, 2, 2).tab;
  assert.equal(Core.slots(changed, 0)[2].offset, 2 / 3);
  assert.equal(Core.slots(changed, 0)[2].durationFraction, '1/48');
  assert.deepEqual(changed.measures[0].rows.main[2], ['8']);
  assert.equal(Core.slots(changed, 0)[2].syllable, 'Dhom');
  assert.ok(Math.abs(Core.slots(changed, 0).reduce((n, s) => n + s.duration, 0) - 6) < 1e-12);
  assert.equal(Core.canMergeSlot(changed, 0, 1), false);
  assert.equal(Core.canMergeSlot(changed, 0, 2), true);
  assert.throws(() => Core.mergeSlot(changed, 0, 1), /мелкие/u);
  assert.deepEqual(Core.mergeSlot(changed, 0, 3).tab, beforeNested);
  const remapped = Core.setRhythm(changed, changed.meter, Core.makeBeats(changed.meter, 9));
  assert.equal(remapped.lost, 0);
  const onset = Core.slots(remapped.tab, 0).findIndex(s => s.offset === 2 / 3);
  assert.deepEqual(remapped.tab.measures[0].rows.main[onset], ['8']);
  assert.equal(Core.slots(remapped.tab, 0)[onset].syllable, 'Dhom');
});

test('merge reports notes removed from sibling children on both hands without modifying input', () => {
  let tab = Core.splitSlot(Core.createTab({ division: 2, hands: 'split' }), 0, 3, 3).tab;
  tab.measures[0].rows.R[3] = ['D'];
  tab.measures[0].rows.R[4] = ['4', '8'];
  tab.measures[0].rows.L[4] = ['S'];
  tab.measures[0].rows.L[5] = ['K'];
  const snapshot = Core.clone(tab);
  const changed = Core.mergeSlot(tab, 0, 4);
  assert.equal(changed.lost, 3);
  assert.equal(changed.slot, 3);
  assert.deepEqual(changed.tab.measures[0].rows.R[3], ['D']);
  assert.deepEqual(tab, snapshot);
});

test('weighted imported beats can be split and restored without quantizing their onsets', () => {
  const original = Core.createTab({ division: 2 });
  original.beats[0].weights = [2, 1];
  original.measures[0].rows.main[1] = ['D'];
  assert.equal(Core.slots(original, 0)[1].offset, 2 / 3);
  const split = Core.splitSlot(original, 0, 0, 2).tab;
  assert.deepEqual(Core.slots(split, 0).slice(0, 4).map(s => s.offset), [0, 1 / 3, 2 / 3, 1]);
  assert.deepEqual(split.measures[0].rows.main[2], ['D']);
  assert.deepEqual(Core.validateTab(Core.clone(split)), split);
  assert.deepEqual(Core.mergeSlot(split, 0, 1).tab, original);
});

test('global syllable pattern changes inherited defaults while cell, beat and phrase edits stay explicit', () => {
  const original = Core.createTab({ division: 8 });
  original.notation = 'konnakol';
  assert.deepEqual(Core.getKonnakolPattern(original), ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Jo', 'Nu']);
  const pattern = ['Pa', 'Ka', 'Di', 'Mi', 'Da', 'Ke', 'Jo', 'Nu'];
  const custom = Core.setKonnakolPattern(original, pattern);
  assert.deepEqual(Core.slots(custom, 0).slice(0, 8).map(s => s.syllable), pattern);
  let edited = Core.setSlotSyllable(custom, 0, 1, 'Tum');
  edited.phrases = [{ size: 2, syllables: ['Dhom', 'Ki'] }];
  assert.deepEqual(Core.slots(edited, 0).slice(0, 4).map(s => s.syllable), ['Dhom', 'Tum', 'Dhom', 'Ki']);
  edited = Core.setSlotSyllable(edited, 0, 1, '');
  assert.equal(Core.slots(edited, 0)[1].syllable, 'Ki');
  assert.equal(Object.hasOwn(edited.measures[0], 'syllables'), false);
  edited.phrases = [];
  edited.beats[0].syllables = Array(8).fill('Custom');
  assert.equal(Core.slots(edited, 0)[0].syllable, 'Custom');
  assert.deepEqual(Core.validateTab(Core.clone(edited)), edited);
  assert.deepEqual(Core.setKonnakolPattern(custom, Core.getKonnakolPattern(original)), original);
  const returned = Core.getKonnakolPattern(original);
  returned[0] = 'Mutation';
  assert.equal(Core.getKonnakolPattern(original)[0], 'Ta');
});

test('cell syllables survive JSON, rhythm edits and hand changes independently of displayed notation', () => {
  const original = Core.createTab();
  const edited = Core.setSlotSyllable(original, 2, 1, 'Да');
  assert.equal(Core.slots(edited, 2)[1].displayLabel, '2');
  edited.notation = 'hybrid';
  assert.equal(Core.slots(edited, 2)[1].displayLabel, 'Да');
  assert.equal(Core.slots(edited, 0)[1].displayLabel, '2');
  edited.handColors = false;
  const split = Core.setHands(Core.splitSlot(edited, 2, 0).tab, 'split');
  assert.equal(Core.slots(split, 2)[2].syllable, 'Да');
  assert.deepEqual(Core.validateTab(Core.clone(split)), split);
  assert.equal(Core.validateTab(split).handColors, false);
  assert.deepEqual(original.measures[2].syllables, undefined);
});

test('invalid patterns, weighted rhythms and excessive subdivision are rejected atomically', () => {
  const original = Core.createTab({ division: 2 });
  const badMutations = [
    tab => { tab.konnakolPattern = ['Pa']; },
    tab => { tab.konnakolPattern = Array(8).fill(''); },
    tab => { tab.konnakolPattern = Array(8).fill('two words'); },
    tab => { tab.handColors = 'false'; },
    tab => { tab.beats[0].weights = [0, 1]; },
    tab => { tab.beats[0].weights = [1]; },
    tab => { tab.beats[0].weights = [1.5, 1]; },
    tab => { tab.beats[0].weights = [1000000000, 1]; },
    tab => { tab.beats[0].subdivisions = [null, [null, null]]; },
    tab => { tab.beats[0].subdivisions = [null, 'oops']; },
    tab => { tab.measures[0].syllables = ['Da']; }
  ];
  for (const mutate of badMutations) {
    const bad = Core.clone(original);
    mutate(bad);
    assert.throws(() => Core.validateTab(bad));
  }
  assert.throws(() => Core.setSlotSyllable(original, 0, 0, 'two words'));
  assert.throws(() => Core.splitSlot(original, 0, 0, 1));
  assert.throws(() => Core.splitSlot(original, 0, 30));
  let tab = original;
  for (let i = 0; i < 8; i++) tab = Core.splitSlot(tab, 0, 1, 2).tab;
  const snapshot = Core.clone(tab);
  assert.throws(() => Core.splitSlot(tab, 0, 1, 2), /глубокое/u);
  assert.deepEqual(tab, snapshot);
  const beat = Core.clone(Core.measureBeats(tab, 0)[0]);
  Core.resetBeatDivision(beat, 4);
  assert.deepEqual(beat, { units: 1, division: 4, label: '1', syllables: [] });
});

test('repeated edits across different meters keep existing hits at their exact musical positions', () => {
  for (const meter of [{ numerator: 7, denominator: 4 }, { numerator: 12, denominator: 8 }, { numerator: 5, denominator: 16 }]) {
    let tab = Core.createTab({ meter, hands: 'split' });
    const original = Core.slots(tab, 0);
    original.forEach((slot, i) => {
      tab.measures[0].rows.R[i] = ['note' + i];
      tab.measures[0].rows.L[i] = ['left' + i];
    });
    for (let step = 0; step < 32; step++) {
      const grid = Core.slots(tab, 0);
      const selected = (step * 7 + 1) % grid.length;
      const changed = Core.splitSlot(tab, 0, selected, step % 3 ? 2 : 3);
      assert.equal(changed.lost, 0);
      tab = Core.validateTab(Core.clone(changed.tab));
      const next = Core.slots(tab, 0);
      assert.ok(Math.abs(next.reduce((n, s) => n + s.duration, 0) - meter.numerator * 4 / meter.denominator) < 1e-10);
      original.forEach((slot, i) => {
        const index = tab.measures[0].rows.R.findIndex(cell => cell[0] === 'note' + i);
        assert.ok(index >= 0);
        assert.ok(Math.abs(next[index].offset - slot.offset) < 1e-12);
        assert.deepEqual(tab.measures[0].rows.L[index], ['left' + i]);
      });
    }
  }
});

test('nested count labels keep beat anchors and balanced brackets after splitting the first part', () => {
  const original = Core.createTab({ division: 2 });
  const once = Core.splitSlot(original, 0, 2).tab;
  assert.deepEqual(Core.slots(once, 0).slice(2, 5).map(s => s.label), ['2(1', '2)', 'и']);
  const twice = Core.splitSlot(once, 0, 2).tab;
  assert.deepEqual(Core.slots(twice, 0).slice(2, 6).map(s => s.label), ['2(1(1', '2)', '2)', 'и']);
  assert.deepEqual(Core.mergeSlot(twice, 0, 3).tab, once);
});

test('an imported empty override array can be edited without creating sparse or null syllables', () => {
  const original = Core.createTab();
  original.measures[0].syllables = [];
  const tab = Core.setSlotSyllable(Core.validateTab(original), 0, 3, 'Da');
  assert.deepEqual(tab.measures[0].syllables, ['', '', '', 'Da']);
  assert.deepEqual(Core.validateTab(JSON.parse(JSON.stringify(tab))), tab);
});

test('only one cell can switch to both hands in an otherwise single-hand document', () => {
  const original = Core.createTab({ division: 2 });
  original.measures[0].rows.main[2] = ['D', '4'];
  original.measures[0].rows.main[3] = ['S'];
  original.measures[1].rows.main[2] = ['K'];
  const before = Core.clone(original);
  const tab = Core.setCellHands(original, 0, 2, 'split');
  assert.equal(tab.hands, 'single');
  assert.deepEqual(tab.measures[0].handModes, ['', '', 'split', '', '', '', '', '']);
  assert.equal(Core.cellHands(tab, 0, 2), 'split');
  assert.deepEqual(Core.cellRows(tab, 0, 2), ['R', 'L']);
  assert.deepEqual(Core.cellRows(tab, 0, 3), ['main']);
  assert.deepEqual(tab.measures[0].rows.R[2], ['D', '4']);
  assert.deepEqual(tab.measures[0].rows.main[2], []);
  assert.deepEqual(tab.measures[0].rows.main[3], ['S']);
  assert.deepEqual(tab.measures.slice(1), original.measures.slice(1));
  tab.measures[0].rows.L[2] = ['4', '8'];
  assert.deepEqual(Core.validateTab(JSON.parse(JSON.stringify(tab))), tab);
  const single = Core.setCellHands(tab, 0, 2, 'single');
  assert.deepEqual(single.measures[0].rows.main[2], ['D', '4', '8']);
  assert.deepEqual(single.measures[0].rows.R[2], []);
  assert.deepEqual(single.measures[0].rows.L[2], []);
  assert.equal(Object.hasOwn(single.measures[0], 'handModes'), false);
  assert.deepEqual(original, before);
});

test('a local single cell works inside a two-hand document without hiding its notes', () => {
  const original = Core.createTab({ hands: 'split' });
  original.measures[0].rows.R[1] = ['D'];
  original.measures[0].rows.L[1] = ['4'];
  original.measures[0].rows.L[2] = ['S'];
  const tab = Core.setCellHands(original, 0, 1, 'single');
  assert.equal(tab.hands, 'split');
  assert.deepEqual(tab.measures[0].handModes, ['', 'single', '', '']);
  assert.deepEqual(Core.cellRows(tab, 0, 1), ['main']);
  assert.deepEqual(tab.measures[0].rows.main[1], ['D', '4']);
  assert.deepEqual(tab.measures[0].rows.R[1], []);
  assert.deepEqual(tab.measures[0].rows.L[1], []);
  assert.deepEqual(tab.measures[0].rows.L[2], ['S']);
  const restored = Core.setCellHands(tab, 0, 1, 'split');
  assert.deepEqual(restored.measures[0].rows.R[1], ['D', '4']);
  assert.deepEqual(restored.measures[0].rows.main[1], []);
  assert.equal(Object.hasOwn(restored.measures[0], 'handModes'), false);
});

test('global hand changes convert every effective mode and unchanged settings preserve local overrides', () => {
  const original = Core.createTab();
  original.measures[0].rows.main[0] = ['S'];
  let mixed = Core.setCellHands(original, 0, 1, 'split');
  mixed.measures[0].rows.R[1] = ['D'];
  mixed.measures[0].rows.L[1] = ['8'];
  assert.deepEqual(Core.setHands(mixed, 'single'), mixed, 'saving unchanged global mode preserves local hands');
  const split = Core.setHands(mixed, 'split');
  assert.equal(split.hands, 'split');
  assert.equal(Object.hasOwn(split.measures[0], 'handModes'), false);
  assert.deepEqual(split.measures[0].rows.R[0], ['S']);
  assert.deepEqual(split.measures[0].rows.R[1], ['D']);
  assert.deepEqual(split.measures[0].rows.L[1], ['8']);
  const anotherMixed = Core.setCellHands(split, 0, 1, 'single');
  assert.deepEqual(Core.setHands(anotherMixed, 'split'), anotherMixed);
  const single = Core.setHands(anotherMixed, 'single');
  assert.equal(Object.hasOwn(single.measures[0], 'handModes'), false);
  assert.deepEqual(single.measures[0].rows.main[0], ['S']);
  assert.deepEqual(single.measures[0].rows.main[1], ['D', '8']);
  for (const measure of single.measures) for (const row of ['R', 'L']) assert.ok(measure.rows[row].every(cell => !cell.length));
});

test('subdivisions inherit local hand mode and merging retains the surviving onset mode', () => {
  let tab = Core.setCellHands(Core.createTab({ division: 2 }), 0, 3, 'split');
  tab.measures[0].rows.R[3] = ['D'];
  tab.measures[0].rows.L[3] = ['8'];
  tab.measures[0].rows.main[4] = ['S'];
  const original = Core.clone(tab);
  const split = Core.splitSlot(tab, 0, 3).tab;
  assert.deepEqual(split.measures[0].handModes, ['', '', '', 'split', 'split', '', '', '', '']);
  assert.deepEqual(Core.cellRows(split, 0, 4), ['R', 'L']);
  assert.deepEqual(split.measures[0].rows.R[3], ['D']);
  assert.deepEqual(split.measures[0].rows.L[3], ['8']);
  assert.deepEqual(split.measures[0].rows.main[5], ['S']);
  assert.deepEqual(Core.mergeSlot(split, 0, 4).tab, original);
  const nested = Core.splitSlot(split, 0, 4, 3).tab;
  for (const slot of [3, 4, 5, 6]) assert.equal(Core.cellHands(nested, 0, slot), 'split');
  const different = Core.setCellHands(split, 0, 4, 'single');
  different.measures[0].rows.main[4] = ['K'];
  const merged = Core.mergeSlot(different, 0, 4);
  assert.equal(merged.lost, 1);
  assert.equal(Core.cellHands(merged.tab, 0, 3), 'split');
  assert.deepEqual(merged.tab.measures[0].rows.main[3], []);
  assert.deepEqual(merged.tab.measures[0].rows.L[3], ['8']);
});

test('rhythm remapping preserves mixed modes by exact source interval and defaults beyond an enlarged bar', () => {
  const original = Core.setCellHands(Core.createTab({ meter: { numerator: 1, denominator: 4 }, division: 3 }), 0, 1, 'split');
  original.measures[0].rows.R[1] = ['D'];
  original.measures[0].rows.L[1] = ['S'];
  const six = Core.setMeasureRhythm(original, 0, Core.makeBeats(original.meter, 6)).tab;
  assert.deepEqual(six.measures[0].handModes, ['', '', 'split', 'split', '', '']);
  assert.deepEqual(six.measures[0].rows.R[2], ['D']);
  const enlarged = Core.setRhythm(original, { numerator: 2, denominator: 4 }, Core.makeBeats({ numerator: 2, denominator: 4 }, 3)).tab;
  assert.deepEqual(enlarged.measures[0].handModes, ['', 'split', '', '', '', '']);
  assert.deepEqual(Core.validateTab(Core.clone(enlarged)), enlarged);
});

test('mixed hand validation and oversized local/global joins fail without mutating their input', () => {
  const original = Core.createTab();
  for (const modes of [[], ['split'], ['split', '', '', null], ['split', '', '', 'R'], new Array(4), 'split']) {
    const bad = Core.clone(original);
    bad.measures[0].handModes = modes;
    assert.throws(() => Core.validateTab(bad), /Режимы рук/u);
  }
  assert.throws(() => Core.setCellHands(original, 0, 0, 'R'), /Режим рук/u);
  assert.throws(() => Core.cellHands(original, -1, 0), /Индекс такта/u);
  assert.throws(() => Core.cellRows(original, 0, 40), /Индекс ячейки/u);
  const oversized = Core.setCellHands(original, 0, 1, 'split');
  oversized.measures[0].rows.R[1] = ['1', '2', '3', '4', '5'];
  oversized.measures[0].rows.L[1] = ['6', '7', '8', '9'];
  const snapshot = Core.clone(oversized);
  assert.throws(() => Core.setCellHands(oversized, 0, 1, 'single'), /больше 8/u);
  assert.deepEqual(oversized, snapshot);
  const allSplit = Core.setHands(oversized, 'split');
  const splitSnapshot = Core.clone(allSplit);
  assert.throws(() => Core.setHands(allSplit, 'single'), /больше 8/u);
  assert.deepEqual(allSplit, splitSnapshot);
});
