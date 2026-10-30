(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangCore = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const ROWS = ['main', 'R', 'L'];
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
      const division = integer(beat.division, 1, 16, 'Деление доли');
      return { units, division, label: text(beat.label, String(i + 1), 32, 'Счёт'), syllables: normalizeSyllables(beat.syllables, division, 'Слоги доли') };
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
  function syllablesFor(size) {
    return DEFAULT_SYLLABLES[size] || Array.from({ length: size }, (_, i) => i === 0 ? 'Ta' : 'Ka');
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
  function slots(tab, measureIndex) {
    const result = [];
    const beats = measureBeats(tab, measureIndex);
    let unitsBefore = 0;
    beats.forEach((beat, beatIndex) => {
      const syllables = beat.syllables && beat.syllables.length ? beat.syllables : syllablesFor(beat.division);
      for (let sub = 0; sub < beat.division; sub++) {
        result.push({ beat: beatIndex, index: result.length, sub,
          label: countLabel(beat, sub), syllable: syllables[sub],
          offset: (unitsBefore + beat.units * sub / beat.division) * 4 / tab.meter.denominator,
          duration: beat.units * 4 / tab.meter.denominator / beat.division,
          groupStart: sub === 0 });
      }
      unitsBefore += beat.units;
    });
    if (tab.notation !== 'hybrid' && tab.phrases && tab.phrases.length) {
      const phraseSlots = tab.phrases.flatMap(phrase => {
        const syllables = phrase.syllables && phrase.syllables.length ? phrase.syllables : syllablesFor(phrase.size);
        return syllables.map((syllable, i) => ({ syllable, groupStart: i === 0 }));
      });
      result.forEach((slot, i) => {
        const phraseSlot = phraseSlots[i % phraseSlots.length];
        slot.syllable = phraseSlot.syllable;
        if (tab.notation === 'konnakol') slot.groupStart = phraseSlot.groupStart;
      });
    }
    result.forEach(slot => {
      slot.displayLabel = tab.notation === 'count' || tab.notation === 'hybrid' && beats[slot.beat].division === 1 ? slot.label : slot.syllable;
    });
    return result;
  }
  function gcd(a, b) { while (b) { const next = a % b; a = b; b = next; } return a; }
  function onsetKeys(tab, measureIndex) {
    const keys = [];
    let unitsBefore = 0;
    measureBeats(tab, measureIndex).forEach(beat => {
      for (let sub = 0; sub < beat.division; sub++) {
        const n = (unitsBefore * beat.division + beat.units * sub) * 4;
        const d = beat.division * tab.meter.denominator;
        const divisor = gcd(n, d);
        keys.push((n / divisor) + '/' + (d / divisor));
      }
      unitsBefore += beat.units;
    });
    return keys;
  }
  function remapMeasure(measure, oldKeys, keys) {
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
    return { measure: mapped, lost };
  }
  function setMeasureRhythm(tab, measureIndex, beats) {
    integer(measureIndex, 0, tab.measures.length - 1, 'Индекс такта');
    const oldKeys = onsetKeys(tab, measureIndex);
    const nextBeats = beatsValue(beats, meterValue(tab.meter));
    const newKeys = onsetKeys({ meter: tab.meter, beats: nextBeats });
    const mapped = remapMeasure(tab.measures[measureIndex], oldKeys, newKeys);
    const result = clone(tab);
    if (JSON.stringify(nextBeats) === JSON.stringify(result.beats)) delete mapped.measure.beats;
    else mapped.measure.beats = nextBeats;
    result.measures[measureIndex] = mapped.measure;
    return { tab: result, lost: mapped.lost };
  }
  function setRhythm(tab, meter, beats) {
    const result = clone(tab);
    result.meter = meterValue(meter);
    result.beats = beatsValue(beats, result.meter);
    const newKeys = onsetKeys(result);
    let lost = 0;
    result.measures = tab.measures.map((measure, i) => {
      const mapped = remapMeasure(measure, onsetKeys(tab, i), newKeys);
      lost += mapped.lost;
      delete mapped.measure.beats;
      return mapped.measure;
    });
    return { tab: result, lost };
  }
  function setHands(tab, hands) {
    if (!['single', 'split'].includes(hands)) fail('Режим рук: single или split.');
    const result = clone(tab);
    if (result.hands === hands) return result;
    result.measures.forEach(measure => {
      const count = measure.rows.main.length;
      if (hands === 'split') {
        measure.rows.R = clone(measure.rows.main);
        measure.rows.L = blankRow(count);
        measure.rows.main = blankRow(count);
      } else {
        measure.rows.main = measure.rows.R.map((cell, i) => {
          const chord = [...new Set([...cell, ...measure.rows.L[i]])];
          if (chord.length > 8) fail('Нельзя объединить руки: в одной позиции получится больше 8 разных нот. Сначала уменьшите аккорд.');
          return chord;
        });
        measure.rows.R = blankRow(count);
        measure.rows.L = blankRow(count);
      }
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

  return { clone, uid, createTab, makeBeats, measureBeats, slots, setRhythm, setMeasureRhythm, setHands, parseToken, tokenText, validateTab, importText, emptyMeasure };
});
