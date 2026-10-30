'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

function fractionSum(slots) {
  let numerator = 0n, denominator = 1n;
  for (const slot of slots) {
    const [n, d] = slot.durationFraction.split('/').map(BigInt);
    numerator = numerator * d + n * denominator;
    denominator *= d;
  }
  return [numerator, denominator];
}

function assertMeter(tab, measure = 0) {
  const [n, d] = fractionSum(Core.slots(tab, measure));
  assert.equal(n * BigInt(tab.meter.denominator), d * BigInt(tab.meter.numerator));
}

test('every integer split from 2 to 64 preserves the bar and round-trips through JSON and merge', () => {
  for (const parts of Array.from({ length: 63 }, (_, i) => i + 2)) {
    const original = Core.createTab();
    original.measures[0].rows.main[1] = ['D', '4'];
    original.measures[0].rows.main[2] = ['S'];
    const snapshot = Core.clone(original);
    const changed = Core.splitSlot(original, 0, 1, parts);
    const grid = Core.slots(changed.tab, 0);
    assert.equal(changed.lost, 0);
    assert.equal(changed.slot, 1);
    assert.equal(grid.length, 3 + parts);
    assert.deepEqual(grid.slice(1, parts + 1).map(slot => slot.durationFraction), Array(parts).fill('1/' + (4 * parts)));
    assert.deepEqual(changed.tab.measures[0].rows.main[1], ['D', '4']);
    assert.deepEqual(changed.tab.measures[0].rows.main[parts + 1], ['S']);
    assert.equal(grid[parts + 1].offset, 2);
    assert.deepEqual(changed.tab.measures.slice(1), original.measures.slice(1));
    assert.deepEqual(Core.validateTab(JSON.parse(JSON.stringify(changed.tab))), changed.tab);
    assertMeter(changed.tab);
    assert.deepEqual(Core.mergeSlot(changed.tab, 0, parts).tab, original);
    assert.deepEqual(original, snapshot);
  }
});

test('a nested split into 63 parts uses all remaining capacity without changing a neighboring eighth', () => {
  const original = Core.createTab({ division: 2 });
  original.measures[0].rows.main[1] = ['K'];
  original.measures[0].rows.main[2] = ['8'];
  const changed = Core.splitSlot(original, 0, 1, 63);
  const grid = Core.slots(changed.tab, 0);
  assert.equal(Core.measureBeats(changed.tab, 0)[0].division, 64);
  assert.equal(grid[0].durationFraction, '1/8');
  assert.deepEqual(grid.slice(1, 64).map(slot => slot.durationFraction), Array(63).fill('1/504'));
  assert.equal(grid[64].offset, 1);
  assert.deepEqual(changed.tab.measures[0].rows.main[64], ['8']);
  assert.deepEqual(Core.validateTab(Core.clone(changed.tab)), changed.tab);
  assertMeter(changed.tab);
  assert.deepEqual(Core.mergeSlot(changed.tab, 0, 63).tab, original);
  const snapshot = Core.clone(changed.tab);
  assert.throws(() => Core.splitSlot(changed.tab, 0, 0, 2), /64.*соедините/u);
  assert.deepEqual(changed.tab, snapshot);
});

test('six and eight nested parts preserve local R/L, explicit syllables, plain notes and inverse merges', () => {
  let original = Core.setCellHands(Core.createTab({ division: 2 }), 0, 3, 'split');
  original = Core.setSlotSyllable(original, 0, 3, 'Da');
  original.measures[0].rows.R[3] = ['D'];
  original.measures[0].rows.L[3] = ['8'];
  original.measures[0].rows.main[4] = ['S'];
  const six = Core.splitSlot(original, 0, 3, 6).tab;
  const eight = Core.splitSlot(six, 0, 5, 8).tab;
  assert.deepEqual(eight.measures[0].rows.R[3], ['D']);
  assert.deepEqual(eight.measures[0].rows.L[3], ['8']);
  assert.equal(Core.slots(eight, 0)[3].syllable, 'Da');
  for (let i = 3; i < 16; i++) assert.equal(Core.cellHands(eight, 0, i), 'split');
  assert.equal(Core.cellHands(eight, 0, 16), 'single');
  assert.deepEqual(eight.measures[0].rows.main[16], ['S']);
  assert.equal(Core.slots(eight, 0)[16].offset, 2);
  assert.deepEqual(Core.validateTab(Core.clone(eight)), eight);
  assertMeter(eight);
  assert.deepEqual(Core.mergeSlot(eight, 0, 12).tab, six);
  assert.deepEqual(Core.mergeSlot(six, 0, 8).tab, original);
});

test('arbitrary splitting preserves weighted imported timing and custom beat syllables exactly', () => {
  const original = Core.createTab({ division: 2 });
  original.beats[0].weights = [7, 3];
  original.beats[0].syllables = ['Da', 'Tum'];
  original.measures[0].rows.main[1] = ['K'];
  const changed = Core.splitSlot(original, 0, 0, 17).tab;
  const grid = Core.slots(changed, 0);
  assert.equal(grid[0].syllable, 'Da');
  assert.equal(grid[17].syllable, 'Tum');
  assert.equal(grid[17].offset, 0.7);
  assert.equal(grid[17].durationFraction, '3/40');
  assert.equal(grid[0].durationFraction, '7/680');
  assert.deepEqual(changed.measures[0].rows.main[17], ['K']);
  assertMeter(changed);
  assert.deepEqual(Core.validateTab(Core.clone(changed)), changed);
  assert.deepEqual(Core.mergeSlot(changed, 0, 16).tab, original);
});

test('compound and unusual meters retain exact duration after divisions into 4, 6, 8 and 23', () => {
  for (const meter of [{ numerator: 12, denominator: 8 }, { numerator: 7, denominator: 4 }, { numerator: 5, denominator: 16 }]) {
    const original = Core.createTab({ meter, hands: 'split' });
    Core.slots(original, 0).forEach((slot, i) => {
      original.measures[0].rows.R[i] = ['right' + i];
      original.measures[0].rows.L[i] = ['left' + i];
    });
    const onsets = Core.slots(original, 0).map(slot => slot.offset);
    for (const parts of [4, 6, 8, 23]) {
      const changed = Core.splitSlot(original, 0, 1, parts);
      const grid = Core.slots(changed.tab, 0);
      assert.equal(changed.lost, 0);
      assertMeter(changed.tab);
      onsets.forEach((onset, i) => {
        const index = changed.tab.measures[0].rows.R.findIndex(notes => notes[0] === 'right' + i);
        assert.equal(grid[index].offset, onset);
        assert.deepEqual(changed.tab.measures[0].rows.L[index], ['left' + i]);
      });
      assert.deepEqual(Core.mergeSlot(changed.tab, 0, parts).tab, original);
    }
  }
});

test('invalid or unavailable part counts fail atomically with a useful limit', () => {
  const original = Core.createTab({ division: 8 });
  const snapshot = Core.clone(original);
  for (const parts of [null, '', '6', 0, 1, -4, 2.5, NaN, Infinity, 65, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => Core.splitSlot(original, 0, 0, parts), /целое число от 2 до 64/u);
    assert.deepEqual(original, snapshot);
  }
  assert.throws(() => Core.splitSlot(original, 0, 0, 58), /максимум на 57/u);
  assert.deepEqual(original, snapshot);
  const maximal = Core.splitSlot(original, 0, 0, 57).tab;
  assert.equal(Core.measureBeats(maximal, 0)[0].division, 64);
  assertMeter(maximal);
});

test('the exact timing weight guard remains atomic even for a valid custom count', () => {
  const original = Core.createTab({ division: 2 });
  original.beats[0].weights = [999999999, 1];
  const snapshot = Core.validateTab(Core.clone(original));
  assert.throws(() => Core.splitSlot(original, 0, 0, 8), /Слишком мелкое деление/u);
  assert.deepEqual(original, snapshot);
});

test('merging an arbitrary group reports occupied discarded children and retains the first onset', () => {
  const original = Core.createTab({ hands: 'split' });
  const changed = Core.splitSlot(original, 0, 1, 8).tab;
  changed.measures[0].rows.R[1] = ['D'];
  changed.measures[0].rows.L[1] = ['8'];
  changed.measures[0].rows.R[2] = ['K'];
  changed.measures[0].rows.L[8] = ['S'];
  const merged = Core.mergeSlot(changed, 0, 7);
  assert.equal(merged.lost, 2);
  assert.deepEqual(merged.tab.measures[0].rows.R[1], ['D']);
  assert.deepEqual(merged.tab.measures[0].rows.L[1], ['8']);
  assertMeter(merged.tab);
});
