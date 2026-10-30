(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangCore = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const ROWS = ['main', 'R', 'L'];
  const MAX_SLOTS_PER_BEAT = 64;
  const MAX_WEIGHT_TOTAL = 1000000000;
  const DEFAULT_SYLLABLES = {
    1: ['Ta'], 2: ['Ta', 'Ka'], 3: ['Ta', 'Ki', 'Ta'],
    4: ['Ta', 'Ka', 'Di', 'Mi'], 5: ['Ta', 'Di', 'Gi', 'Na', 'Tom'],
    7: ['Ta', 'Ki', 'Ta', 'Ta', 'Ka', 'Di', 'Mi'],
    8: ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Jo', 'Nu']
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'hang-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function fail(message) { throw new Error(message); }
  function integer(value, low, high, name) {
    if (!Number.isInteger(value) || value < low || value > high) fail(name + ': допустимо целое число от ' + low + ' до ' + high + '.');
    return value;
  }
  function text(value, fallback, limit, name) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('Некорректное поле «' + name + '».');
    return value;
  }
  function idValue(value, name) {
    if (value === undefined) return uid();
    if (typeof value !== 'string' || value.length < 1 || value.length > 80 || /[^A-Za-z0-9_-]/u.test(value)) fail('Некорректный ' + name + ': используйте 1–80 латинских букв, цифр, дефисов или знаков подчёркивания.');
    return value;
  }
  function meterValue(meter) {
    if (!meter || typeof meter !== 'object' || Array.isArray(meter)) fail('Укажите размер такта.');
    const numerator = integer(meter.numerator, 1, 32, 'Числитель размера');
    const denominator = integer(meter.denominator, 1, 32, 'Знаменатель размера');
    if (![1, 2, 4, 8, 16, 32].includes(denominator)) fail('Знаменатель размера: 1, 2, 4, 8, 16 или 32.');
    return { numerator, denominator };
  }
  function makeBeats(meter, division) {
    const m = meterValue(meter);
    const compound = m.denominator === 8 && m.numerator > 3 && m.numerator % 3 === 0;
    const units = compound ? 3 : 1;
    const div = division === undefined ? (compound ? 3 : 1) : integer(division, 1, 16, 'Деление доли');
    return Array.from({ length: m.numerator / units }, (_, i) => ({ units, division: div, label: String(i + 1), syllables: [] }));
  }
  function normalizeSyllables(values, size, name) {
    if (values === undefined) return [];
    if (!Array.isArray(values) || (values.length !== 0 && values.length !== size)) fail(name + ': число слогов должно совпадать с числом ячеек.');
    return values.map(value => text(value, '', 32, name));
  }
  function beatsValue(beats, meter) {
    if (!Array.isArray(beats) || !beats.length || beats.length > 32) fail('В такте должно быть от 1 до 32 долей.');
    const result = beats.map((beat, i) => {
      if (!beat || typeof beat !== 'object' || Array.isArray(beat)) fail('Некорректная доля ' + (i + 1) + '.');
      const units = integer(beat.units, 1, 32, 'Длительность доли');
      const division = integer(beat.division, 1, MAX_SLOTS_PER_BEAT, 'Деление доли');
      const result = { units, division, label: text(beat.label, String(i + 1), 32, 'Счёт'), syllables: normalizeSyllables(beat.syllables, division, 'Слоги доли') };
      if (beat.subdivisions !== undefined) {
        result.subdivisions = subdivisionValue(beat.subdivisions);
        if (beat.baseWeights !== undefined) result.baseWeights = weightsValue(beat.baseWeights, result.subdivisions.length);
        if (beat.weights !== undefined) fail('Укажите либо дерево делений, либо веса ячеек.');
        if (beatGrid(result).length !== division) fail('Число ячеек не совпадает с деревом делений.');
      } else {
        if (beat.baseWeights !== undefined) fail('Базовые длительности требуют дерева делений.');
        if (beat.weights !== undefined) result.weights = weightsValue(beat.weights, division);
      }
      return result;
    });
    if (result.reduce((sum, beat) => sum + beat.units, 0) !== meter.numerator) fail('Сумма длительностей долей должна совпадать с числителем размера.');
    return result;
  }
  function parseToken(value) {
    if (Array.isArray(value)) {
      if (value.length > 8) fail('В одной ячейке допускается до 8 нот.');
      return value.map(part => {
        if (typeof part !== 'string' || !part.trim() || /[\s/|\u0000-\u001f]/u.test(part) || part.length > 24 || part === '-') fail('Некорректная нота в аккорде.');
        return part.trim();
      });
    }
    if (typeof value !== 'string') fail('Нота должна быть строкой или массивом нот.');
    const token = value.trim();
    if (token === '' || token === '-' || token === '—') return [];
    return parseToken(token.split('/').map(part => part.trim()));
  }
  function tokenText(cell) { return cell && cell.length ? cell.join('/') : '-'; }
  function blankRow(count) { return Array.from({ length: count }, () => []); }
  function emptyMeasure(tab) {
    const count = tab.beats.reduce((sum, beat) => sum + beat.division, 0);
    return { id: uid(), label: '', rows: { main: blankRow(count), R: blankRow(count), L: blankRow(count) } };
  }
  function createTab(options = {}) {
    const meter = meterValue(options.meter || { numerator: 4, denominator: 4 });
    const hands = options.hands === undefined ? 'single' : options.hands;
    if (!['single', 'split'].includes(hands)) fail('Режим рук: single или split.');
    const tab = {
      format: 'hang-tab', version: 1, id: uid(),
      title: text(options.title, 'Новая табулатура', 300, 'Название'),
      subtitle: '', tempo: 90, meter, notation: 'count', hands,
      beats: makeBeats(meter, options.division), phrases: [], measures: [], notes: ''
    };
    tab.measures = Array.from({ length: 4 }, () => emptyMeasure(tab));
    return tab;
  }
  function phraseValue(phrases) {
    if (phrases === undefined) return [];
    if (!Array.isArray(phrases) || phrases.length > 128) fail('Некорректный список фраз.');
    return phrases.map(phrase => {
      if (!phrase || typeof phrase !== 'object') fail('Некорректная фраза.');
      const size = integer(phrase.size, 1, 32, 'Длина фразы');
      return { size, syllables: normalizeSyllables(phrase.syllables, size, 'Слоги фразы') };
    });
  }
  function getKonnakolPattern(tab) { return (tab.konnakolPattern || DEFAULT_SYLLABLES[8]).slice(); }
  function patternValue(pattern) {
    const result = normalizeSyllables(pattern, 8, 'Основные слоги');
    if (result.length !== 8 || result.some(word => !word.trim() || /\s/u.test(word))) fail('Укажите ровно восемь слогов без пробелов внутри.');
    return result;
  }
  function setKonnakolPattern(tab, pattern) {
    const result = clone(tab);
    const normalized = patternValue(pattern);
    if (JSON.stringify(normalized) === JSON.stringify(DEFAULT_SYLLABLES[8])) delete result.konnakolPattern;
    else result.konnakolPattern = normalized;
    return result;
  }
  function syllablesFor(size, tab) {
    const original = DEFAULT_SYLLABLES[size] || Array.from({ length: size }, (_, i) => i === 0 ? 'Ta' : 'Ka');
    if (!tab || !tab.konnakolPattern) return original;
    const pattern = tab.konnakolPattern;
    if ([1, 2, 4, 8].includes(size)) return pattern.slice(0, size);
    return original.map(word => {
      const index = DEFAULT_SYLLABLES[8].indexOf(word);
      return index < 0 ? word : pattern[index];
    });
  }
  function countLabel(beat, sub) {
    if (sub === 0) return beat.label;
    const suffix = { 2: ['и'], 3: ['и', 'а'], 4: ['e', 'and', 'a'] }[beat.division];
    return suffix ? suffix[sub - 1] : String(sub + 1);
  }
  function measureBeats(tab, measureIndex) {
    if (measureIndex === undefined) return tab.beats;
    integer(measureIndex, 0, tab.measures.length - 1, 'Индекс такта');
    return tab.measures[measureIndex].beats || tab.beats;
  }
  function weightsValue(weights, count) {
    if (!Array.isArray(weights) || weights.length !== count) fail('Число длительностей должно совпадать с числом ячеек.');
    const result = weights.map(value => integer(value, 1, MAX_WEIGHT_TOTAL, 'Вес длительности'));
    if (result.reduce((sum, value) => sum + value, 0) > MAX_WEIGHT_TOTAL) fail('Слишком мелкое деление: объедините соседние части.');
    const divisor = result.reduce(gcd);
    return result.map(value => value / divisor);
  }
  function subdivisionValue(tree) {
    let leaves = 0;
    function visit(nodes, depth) {
      if (!Array.isArray(nodes) || nodes.length < (depth ? 2 : 1) || nodes.length > MAX_SLOTS_PER_BEAT || depth > 8) fail('Некорректное или слишком глубокое деление ячейки.');
      return nodes.map(node => {
        if (node === null) { if (++leaves > MAX_SLOTS_PER_BEAT) fail('В одной доле допускается до 64 ячеек.'); return null; }
        return visit(node, depth + 1);
      });
    }
    return visit(tree, 0);
  }
  // Convert a subdivision tree into integer weights. No rounded onset is ever
  // used to remap notes: all denominators stay integral and bounded.
  function beatGrid(beat) {
    if (!beat.subdivisions) {
      const weights = beat.weights || Array(beat.division).fill(1);
      return weights.map((weight, i) => ({ weight, path: [i], depth: 0, label: countLabel(beat, i), parentLabel: '', syllableIndex: i, syllableSize: beat.division }));
    }
    const root = beat.subdivisions;
    const base = beat.baseWeights || Array(root.length).fill(1);
    const rootBeat = { label: beat.label, division: root.length };
    const leaves = [];
    function visit(node, numerator, denominator, path, label, parentLabel, syllableIndex, syllableSize) {
      if (node === null) { leaves.push({ numerator, denominator, path, depth: path.length - 1, label, parentLabel, syllableIndex, syllableSize }); return; }
      const first = leaves.length;
      node.forEach((child, i) => visit(child, numerator, denominator * node.length, path.concat(i), String(i + 1), label, i, node.length));
      // Keep the beat number when its first part is divided. Brackets span
      // actual children, including further nested groups, rather than leaving
      // ambiguous/unbalanced labels after repeated edits.
      const anchor = path.length === 1 && path[0] > 0 ? '' : label;
      leaves[first].label = anchor + '(' + leaves[first].label;
      leaves[leaves.length - 1].label += ')';
    }
    root.forEach((node, i) => visit(node, base[i], 1, [i], countLabel(rootBeat, i), '', i, root.length));
    const denominator = leaves.reduce((common, leaf) => {
      const next = common / gcd(common, leaf.denominator) * leaf.denominator;
      if (!Number.isSafeInteger(next) || next > MAX_WEIGHT_TOTAL) fail('Слишком мелкое деление: объедините соседние части.');
      return next;
    }, 1);
    const weights = weightsValue(leaves.map(leaf => leaf.numerator * (denominator / leaf.denominator)), leaves.length);
    return leaves.map((leaf, i) => ({ ...leaf, weight: weights[i] }));
  }
  function resetBeatDivision(beat, division) {
    beat.division = integer(division, 1, 16, 'Деление доли');
    beat.syllables = [];
    delete beat.weights;
    delete beat.subdivisions;
    delete beat.baseWeights;
    return beat;
  }
  function slots(tab, measureIndex) {
    const result = [];
    const beats = measureBeats(tab, measureIndex);
    let unitsBefore = 0;
    beats.forEach((beat, beatIndex) => {
      const grid = beatGrid(beat);
      const syllables = beat.syllables && beat.syllables.length ? beat.syllables : grid.map(cell => syllablesFor(cell.syllableSize, tab)[cell.syllableIndex]);
      const total = grid.reduce((sum, cell) => sum + cell.weight, 0);
      let before = 0;
      for (let sub = 0; sub < beat.division; sub++) {
        const durationNumerator = beat.units * grid[sub].weight;
        const durationDenominator = tab.meter.denominator * total;
        const durationDivisor = gcd(durationNumerator, durationDenominator);
        result.push({ beat: beatIndex, index: result.length, sub,
          label: grid[sub].label, syllable: syllables[sub], depth: grid[sub].depth, parentLabel: grid[sub].parentLabel,
          durationFraction: (durationNumerator / durationDivisor) + '/' + (durationDenominator / durationDivisor),
          offset: (unitsBefore + beat.units * before / total) * 4 / tab.meter.denominator,
          duration: beat.units * 4 / tab.meter.denominator * grid[sub].weight / total,
          groupStart: sub === 0 });
        before += grid[sub].weight;
      }
      unitsBefore += beat.units;
    });
    if (tab.notation !== 'hybrid' && tab.phrases && tab.phrases.length) {
      const phraseSlots = tab.phrases.flatMap(phrase => {
        const syllables = phrase.syllables && phrase.syllables.length ? phrase.syllables : syllablesFor(phrase.size, tab);
        return syllables.map((syllable, i) => ({ syllable, groupStart: i === 0 }));
      });
      result.forEach((slot, i) => {
        const phraseSlot = phraseSlots[i % phraseSlots.length];
        slot.syllable = phraseSlot.syllable;
        if (tab.notation === 'konnakol') slot.groupStart = phraseSlot.groupStart;
      });
    }
    const overrides = measureIndex === undefined ? [] : tab.measures[measureIndex].syllables || [];
    result.forEach(slot => {
      if (overrides[slot.index]) slot.syllable = overrides[slot.index];
      slot.displayLabel = tab.notation === 'count' || tab.notation === 'hybrid' && beats[slot.beat].division === 1 && !overrides[slot.index] ? slot.label : slot.syllable;
    });
    return result;
  }
  function gcd(a, b) { while (b) { const next = a % b; a = b; b = next; } return a; }
  function onsetKeys(tab, measureIndex) {
    const keys = [];
    let unitsBefore = 0;
    measureBeats(tab, measureIndex).forEach(beat => {
      const grid = beatGrid(beat);
      const total = grid.reduce((sum, cell) => sum + cell.weight, 0);
      let before = 0;
      for (let sub = 0; sub < beat.division; sub++) {
        const n = (unitsBefore * total + beat.units * before) * 4;
        const d = total * tab.meter.denominator;
        const divisor = gcd(n, d);
        keys.push((n / divisor) + '/' + (d / divisor));
        before += grid[sub].weight;
      }
      unitsBefore += beat.units;
    });
    return keys;
  }
  function compareOnsets(left, right) {
    const [ln, ld] = left.split('/').map(BigInt), [rn, rd] = right.split('/').map(BigInt);
    const difference = ln * rd - rn * ld;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  function remapMeasure(measure, oldKeys, keys, oldMeter) {
    const mapped = clone(measure);
    const newKeys = new Map(keys.map((key, i) => [key, i]));
    let lost = 0;
    ROWS.forEach(row => {
      mapped.rows[row] = blankRow(keys.length);
      measure.rows[row].forEach((cell, i) => {
        const index = newKeys.get(oldKeys[i]);
        if (index === undefined) { if (cell.length) lost++; }
        else mapped.rows[row][index] = clone(cell);
      });
    });
    if (measure.syllables) {
      mapped.syllables = Array(keys.length).fill('');
      measure.syllables.forEach((word, i) => {
        const index = newKeys.get(oldKeys[i]);
        if (index !== undefined) mapped.syllables[index] = word;
      });
      if (!mapped.syllables.some(Boolean)) delete mapped.syllables;
    }
    if (measure.handModes) {
      let source = 0;
      const end = (oldMeter.numerator * 4) + '/' + oldMeter.denominator;
      mapped.handModes = keys.map(key => {
        while (source + 1 < oldKeys.length && compareOnsets(oldKeys[source + 1], key) <= 0) source++;
        return compareOnsets(key, end) < 0 ? measure.handModes[source] || '' : '';
      });
      if (!mapped.handModes.some(Boolean)) delete mapped.handModes;
    }
    return { measure: mapped, lost };
  }
  function setMeasureRhythm(tab, measureIndex, beats) {
    integer(measureIndex, 0, tab.measures.length - 1, 'Индекс такта');
    const oldKeys = onsetKeys(tab, measureIndex);
    const nextBeats = beatsValue(beats, meterValue(tab.meter));
    const newKeys = onsetKeys({ meter: tab.meter, beats: nextBeats });
    const mapped = remapMeasure(tab.measures[measureIndex], oldKeys, newKeys, tab.meter);
    const result = clone(tab);
    if (JSON.stringify(nextBeats) === JSON.stringify(result.beats)) delete mapped.measure.beats;
    else mapped.measure.beats = nextBeats;
    result.measures[measureIndex] = mapped.measure;
    return { tab: result, lost: mapped.lost };
  }
  function selectedSlot(tab, measureIndex, slotIndex) {
    integer(measureIndex, 0, tab.measures.length - 1, 'Индекс такта');
    const all = slots(tab, measureIndex);
    integer(slotIndex, 0, all.length - 1, 'Индекс ячейки');
    return all[slotIndex];
  }
  function setSlotSyllable(tab, measureIndex, slotIndex, value) {
    selectedSlot(tab, measureIndex, slotIndex);
    const syllable = text(value, '', 32, 'Слог ячейки').trim();
    if (/\s/u.test(syllable)) fail('В одной ячейке укажите один слог без пробелов.');
    const result = clone(tab);
    const measure = result.measures[measureIndex];
    if (!measure.syllables || !measure.syllables.length) measure.syllables = Array(measure.rows.main.length).fill('');
    measure.syllables[slotIndex] = syllable;
    if (!measure.syllables.some(Boolean)) delete measure.syllables;
    return result;
  }
  function subdivisionParent(beat, sub) {
    const grid = beatGrid(beat);
    const path = grid[sub].path;
    const tree = beat.subdivisions || Array(beat.division).fill(null);
    let parent = tree;
    for (const index of path.slice(0, -1)) parent = parent[index];
    return { grid, path, tree, parent };
  }
  function splitSlot(tab, measureIndex, slotIndex, parts = 2) {
    integer(parts, 2, MAX_SLOTS_PER_BEAT, 'Число частей ячейки');
    const selected = selectedSlot(tab, measureIndex, slotIndex);
    const beats = clone(measureBeats(tab, measureIndex));
    const beat = beats[selected.beat];
    if (beat.division + parts - 1 > MAX_SLOTS_PER_BEAT) fail('В одной доле допускается до ' + MAX_SLOTS_PER_BEAT + ' ячеек. ' + (beat.division < MAX_SLOTS_PER_BEAT ? 'Эту ячейку можно разделить максимум на ' + (MAX_SLOTS_PER_BEAT - beat.division + 1) + ' частей.' : 'Сначала соедините части доли.'));
    const info = subdivisionParent(beat, selected.sub);
    if (!beat.subdivisions && beat.weights) beat.baseWeights = beat.weights.slice();
    if (info.tree.length === 1 && info.tree[0] === null) {
      beat.subdivisions = Array(parts).fill(null);
      delete beat.baseWeights;
    } else {
      info.parent[info.path[info.path.length - 1]] = Array(parts).fill(null);
      beat.subdivisions = info.tree;
    }
    delete beat.weights;
    beat.division += parts - 1;
    if (beat.syllables.length) beat.syllables.splice(selected.sub, 1, beat.syllables[selected.sub], ...syllablesFor(parts, tab).slice(1));
    const changed = setMeasureRhythm(tab, measureIndex, beats);
    return { ...changed, slot: slotIndex };
  }
  function canMergeSlot(tab, measureIndex, slotIndex) {
    const selected = selectedSlot(tab, measureIndex, slotIndex);
    const beat = measureBeats(tab, measureIndex)[selected.beat];
    const { parent } = subdivisionParent(beat, selected.sub);
    return parent.length > 1 && parent.every(node => node === null);
  }
  function mergeSlot(tab, measureIndex, slotIndex) {
    const selected = selectedSlot(tab, measureIndex, slotIndex);
    const beats = clone(measureBeats(tab, measureIndex));
    const beat = beats[selected.beat];
    const info = subdivisionParent(beat, selected.sub);
    if (info.parent.length < 2 || info.parent.some(node => node !== null)) fail('Сначала объедините самые мелкие части выбранной группы.');
    const firstSub = selected.sub - info.path[info.path.length - 1];
    const removed = info.parent.length - 1;
    if (info.path.length === 1) {
      delete beat.subdivisions;
      delete beat.baseWeights;
      delete beat.weights;
    } else {
      let ancestor = info.tree;
      for (const index of info.path.slice(0, -2)) ancestor = ancestor[index];
      ancestor[info.path[info.path.length - 2]] = null;
      beat.subdivisions = info.tree;
      if (info.tree.every(node => node === null)) {
        if (beat.baseWeights) beat.weights = beat.baseWeights;
        delete beat.subdivisions;
        delete beat.baseWeights;
      }
    }
    beat.division -= removed;
    if (beat.syllables.length) beat.syllables.splice(firstSub + 1, removed);
    const changed = setMeasureRhythm(tab, measureIndex, beats);
    return { ...changed, slot: slotIndex - selected.sub + firstSub };
  }
  function setRhythm(tab, meter, beats) {
    const result = clone(tab);
    result.meter = meterValue(meter);
    result.beats = beatsValue(beats, result.meter);
    const newKeys = onsetKeys(result);
    let lost = 0;
    result.measures = tab.measures.map((measure, i) => {
      const mapped = remapMeasure(measure, onsetKeys(tab, i), newKeys, tab.meter);
      lost += mapped.lost;
      delete mapped.measure.beats;
      return mapped.measure;
    });
    return { tab: result, lost };
  }
  function cellHands(tab, measureIndex, slotIndex) {
    integer(measureIndex, 0, tab.measures.length - 1, 'Индекс такта');
    const measure = tab.measures[measureIndex];
    integer(slotIndex, 0, measure.rows.main.length - 1, 'Индекс ячейки');
    return measure.handModes && measure.handModes[slotIndex] || tab.hands;
  }
  function cellRows(tab, measureIndex, slotIndex) {
    return cellHands(tab, measureIndex, slotIndex) === 'split' ? ['R', 'L'] : ['main'];
  }
  function convertCellHands(measure, slotIndex, from, to) {
    if (from === to) return;
    if (to === 'split') {
      measure.rows.R[slotIndex] = clone(measure.rows.main[slotIndex]);
      measure.rows.L[slotIndex] = [];
      measure.rows.main[slotIndex] = [];
    } else {
      const chord = [...new Set([...measure.rows.R[slotIndex], ...measure.rows.L[slotIndex]])];
      if (chord.length > 8) fail('Нельзя объединить руки: в одной позиции получится больше 8 разных нот. Сначала уменьшите аккорд.');
      measure.rows.main[slotIndex] = chord;
      measure.rows.R[slotIndex] = [];
      measure.rows.L[slotIndex] = [];
    }
  }
  function setCellHands(tab, measureIndex, slotIndex, mode) {
    if (!['single', 'split'].includes(mode)) fail('Режим рук ячейки: single или split.');
    const previous = cellHands(tab, measureIndex, slotIndex);
    const result = clone(tab), measure = result.measures[measureIndex];
    convertCellHands(measure, slotIndex, previous, mode);
    if (!measure.handModes) measure.handModes = Array(measure.rows.main.length).fill('');
    measure.handModes[slotIndex] = mode === tab.hands ? '' : mode;
    if (!measure.handModes.some(Boolean)) delete measure.handModes;
    return result;
  }
  function setHands(tab, hands) {
    if (!['single', 'split'].includes(hands)) fail('Режим рук: single или split.');
    const result = clone(tab);
    if (result.hands === hands) return result;
    result.measures.forEach((measure, measureIndex) => {
      const count = measure.rows.main.length;
      for (let slot = 0; slot < count; slot++) convertCellHands(measure, slot, cellHands(tab, measureIndex, slot), hands);
      delete measure.handModes;
    });
    result.hands = hands;
    return result;
  }
  function validateTab(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('JSON должен содержать объект табулатуры.');
    if (input.format !== 'hang-tab' || input.version !== 1) fail('Неподдерживаемый формат: ожидается hang-tab версии 1.');
    const meter = meterValue(input.meter);
    const beats = beatsValue(input.beats, meter);
    if (!['count', 'konnakol', 'hybrid'].includes(input.notation)) fail('Неизвестный вид счёта.');
    if (!['single', 'split'].includes(input.hands)) fail('Неизвестный режим рук.');
    const tab = {
      format: 'hang-tab', version: 1, id: idValue(input.id, 'ID табулатуры'),
      title: text(input.title, 'Без названия', 300, 'Название'),
      subtitle: text(input.subtitle, '', 500, 'Подзаголовок'),
      tempo: input.tempo === undefined ? 90 : integer(input.tempo, 20, 400, 'Темп'),
      meter, notation: input.notation, hands: input.hands, beats,
      phrases: phraseValue(input.phrases), measures: [], notes: text(input.notes, '', 20000, 'Заметки')
    };
    if (input.konnakolPattern !== undefined) tab.konnakolPattern = patternValue(input.konnakolPattern);
    if (input.handColors !== undefined) {
      if (typeof input.handColors !== 'boolean') fail('Цвет рук должен быть включён или выключен.');
      tab.handColors = input.handColors;
    }
    if (!Array.isArray(input.measures) || input.measures.length < 1 || input.measures.length > 512) fail('Табулатура должна содержать от 1 до 512 тактов.');
    const ids = new Set();
    tab.measures = input.measures.map((measure, i) => {
      if (!measure || typeof measure !== 'object' || !measure.rows || typeof measure.rows !== 'object') fail('Некорректный такт ' + (i + 1) + '.');
      const id = idValue(measure.id, 'ID такта');
      if (ids.has(id)) fail('ID тактов не должны повторяться.');
      ids.add(id);
      const ownBeats = measure.beats === undefined ? null : beatsValue(measure.beats, meter);
      const count = (ownBeats || beats).reduce((sum, beat) => sum + beat.division, 0);
      const rows = {};
      ROWS.forEach(row => {
        if (!Array.isArray(measure.rows[row]) || measure.rows[row].length !== count) fail('Такт ' + (i + 1) + ', строка ' + row + ': должно быть ' + count + ' ячеек.');
        rows[row] = measure.rows[row].map(parseToken);
      });
      const result = { id, label: text(measure.label, '', 200, 'Название такта'), rows };
      if (ownBeats) result.beats = ownBeats;
      if (measure.syllables !== undefined) result.syllables = normalizeSyllables(measure.syllables, count, 'Слоги ячеек');
      if (measure.handModes !== undefined) {
        if (!Array.isArray(measure.handModes) || measure.handModes.length !== count || Array.from(measure.handModes).some(mode => !['', 'single', 'split'].includes(mode))) fail('Режимы рук должны содержать по одному значению single, split или пустой строке для каждой ячейки.');
        result.handModes = measure.handModes.slice();
      }
      return result;
    });
    if (input.phraseExample !== undefined) {
      const example = input.phraseExample;
      if (!example || !Array.isArray(example.labels) || !Array.isArray(example.notes) || !example.labels.length || example.labels.length > 256 || example.labels.length !== example.notes.length) fail('Некорректный отдельный пример фразировки.');
      tab.phraseExample = { labels: example.labels.map(label => text(label, '', 32, 'Слог примера')), notes: example.notes.map(parseToken) };
    }
    return tab;
  }
  function lineCells(line, countLine) {
    const value = line.trim().replace(/^\|/, '').replace(/\|$/, '').trim();
    if (value.includes('|')) return value.split('|').map(part => part.trim());
    if (/\s/u.test(value)) return value.split(/\s+/u);
    if (countLine) {
      const tokens = value.match(/\d+|и|e|and|a/giu) || [];
      if (tokens.join('').toLowerCase() !== value.toLowerCase()) fail('Не удалось прочитать счёт. Используйте цифры, «и» и разделители |.');
      return tokens;
    }
    return value.match(/[^\s/\-](?:\/[^\s/\-])*|-/gu) || [];
  }
  function countBeats(labels, explicitMeter) {
    const beats = [];
    for (const label of labels) {
      if (/^\d+$/u.test(label)) beats.push({ units: 1, division: 1, label, syllables: [] });
      else {
        if (!beats.length) fail('Невозможно вывести размер из счёта: первая доля должна быть числом.');
        beats[beats.length - 1].division++;
      }
    }
    if (!beats.length || beats[0].label !== '1') fail('Невозможно вывести размер из счёта. Укажите обычный цифровой счёт.');
    beats.forEach(beat => {
      const start = beats.slice(0, beats.indexOf(beat)).reduce((sum, item) => sum + item.division, 0);
      const expected = Array.from({ length: beat.division }, (_, sub) => countLabel(beat, sub));
      const actual = labels.slice(start, start + beat.division);
      if (actual.some((label, i) => label.toLowerCase() !== expected[i].toLowerCase())) fail('Невозможно вывести длительности из такого счёта. Добавьте размер и используйте цифры / «и» / e-and-a.');
    });
    const meter = explicitMeter || { numerator: beats.length, denominator: 4 };
    if (meter.numerator % beats.length !== 0) fail('Число долей счёта не соответствует указанному размеру.');
    const units = meter.numerator / beats.length;
    beats.forEach(beat => { beat.units = units; });
    return { meter: meterValue(meter), beats: beatsValue(beats, meter) };
  }
  function importText(source, title = 'Импортированная табулатура') {
    if (typeof source !== 'string' || source.length > 2000000) fail('Некорректный TXT или файл слишком большой.');
    const lines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    let labels = null;
    let explicitMeter;
    let current = null;
    const measures = [];
    function flush() {
      if (!current) return;
      if (!current.main && !(current.R && current.L)) fail('Для такта укажите строку нот или обе строки R и L.');
      measures.push(current);
      current = null;
    }
    for (const line of lines) {
      const meterMatch = /^(?:meter|размер)\s*:?\s*(\d+)\s*\/\s*(\d+)$/iu.exec(line);
      if (meterMatch) { explicitMeter = meterValue({ numerator: Number(meterMatch[1]), denominator: Number(meterMatch[2]) }); continue; }
      const hand = /^\(?([RL])\)?(?:\s*:\s*|\s*\|\s*|\s+)(.+)$/iu.exec(line);
      if (hand) {
        if (!labels) fail('Перед строками R и L укажите счёт.');
        const row = hand[1].toUpperCase();
        if (current && current[row]) flush();
        if (!current) current = {};
        current[row] = lineCells(hand[2], false);
        continue;
      }
      const countPrefix = /^(?:count|сч[её]т)\s*:\s*(.+)$/iu.exec(line);
      const expectsCount = Boolean(countPrefix) || !current || Boolean(current.main) || Boolean(current.R && current.L);
      const cells = lineCells(countPrefix ? countPrefix[1] : line, expectsCount);
      const isCount = countPrefix || (!current || current.main || (current.R && current.L)) && /^1$/u.test(cells[0]) && cells.every(cell => /^\d+$|^(?:и|e|and|a)$/iu.test(cell));
      if (isCount) {
        flush();
        if (labels && JSON.stringify(labels) !== JSON.stringify(cells)) fail('В одном TXT все такты должны использовать одинаковый счёт.');
        labels = cells;
        current = {};
      } else {
        if (!labels) fail('Первая строка TXT должна содержать счёт.');
        if (current && current.main) flush();
        if (!current) current = {};
        current.main = lineCells(line.replace(/^(?:notes|ноты)\s*:\s*/iu, ''), false);
      }
    }
    flush();
    if (!labels || !measures.length) fail('В TXT не найдены счёт и ноты.');
    const rhythm = countBeats(labels, explicitMeter);
    const split = measures.some(measure => measure.R || measure.L);
    if (split && measures.some(measure => measure.main)) fail('В одном TXT нельзя смешивать общую строку и партии R/L.');
    const tab = createTab({ title, meter: rhythm.meter, hands: split ? 'split' : 'single' });
    tab.beats = rhythm.beats;
    tab.measures = measures.map((measure, i) => {
      const result = emptyMeasure(tab);
      for (const row of ROWS) {
        if (measure[row]) {
          if (measure[row].length !== labels.length) fail('В такте ' + (i + 1) + ' число нот не совпадает с числом ячеек счёта.');
          result.rows[row] = measure[row].map(parseToken);
        }
      }
      return result;
    });
    if (!explicitMeter) tab.notes = 'Импорт TXT: цифровые доли прочитаны как четверти, «и» — как деление доли пополам. При необходимости уточните размер.';
    return validateTab(tab);
  }

  return { clone, uid, createTab, makeBeats, measureBeats, slots, setRhythm, setMeasureRhythm, setHands, parseToken, tokenText, validateTab, importText, emptyMeasure,
    splitSlot, mergeSlot, canMergeSlot, resetBeatDivision, setSlotSyllable, getKonnakolPattern, setKonnakolPattern, cellHands, cellRows, setCellHands };
});
