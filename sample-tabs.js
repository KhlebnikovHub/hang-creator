(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.HangCore;
  const samples = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = samples;
  if (root) root.HangSamples = samples;
})(typeof window === 'undefined' ? globalThis : window, function (Core) {
  'use strict';

  function pattern(values) { return values.map(Core.parseToken); }
  function measure(tab, id, rows) {
    const result = Core.emptyMeasure(tab);
    result.id = id;
    Object.keys(rows).forEach(row => { result.rows[row] = pattern(rows[row]); });
    return result;
  }
  function customBeats(divisions, labels) {
    return divisions.map((division, i) => ({ units: 1, division, label: String(labels[i]), syllables: [] }));
  }

  const first = Core.createTab({ title: 'Табулатура для ханга', meter: { numerator: 7, denominator: 4 }, division: 2 });
  first.id = 'hang-1';
  first.subtitle = 'Исходный пример №1 · 7 тактов';
  first.notes = 'Основной ритм: D--DS--KD-S--K. D/4…D/7 — одновременные ноты в одной ячейке. Отдельный пример фразировки содержит 16 слогов и не меняет сетку произведения из 14 ячеек.';
  first.measures = [
    ['D/4', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '-', 'K'],
    ['D', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '5', '6'],
    ['D/5', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '-', 'K'],
    ['D', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '7', '6'],
    ['D/6', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '-', 'K'],
    ['D', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '8', '7'],
    ['D/7', '-', '-', 'D', 'S', '-', '-', 'K', 'D', '-', 'S', '-', '-', 'K']
  ].map((row, i) => measure(first, 'sample-hang-1-m' + (i + 1), { main: row }));
  first.phraseExample = {
    labels: ['Ta', 'ki', 'ta', 'Ta', 'ki', 'ta', 'Ta', 'ki', 'ta', 'Ta', 'ki', 'ta', 'Та', 'ка', 'Та', 'ка'],
    notes: pattern(['D', '-', '-', 'D', '-', '-', 'D', '-', '-', 'D', '-', '-', 'S', '-', 'S', '-'])
  };

  const second = Core.createTab({ title: 'Табулатура для ханга №2', meter: { numerator: 7, denominator: 4 } });
  second.id = 'hang-2';
  second.subtitle = 'Аккорды · счёт 1 2 и 3 · 1 2 · 1 2';
  second.beats = customBeats([1, 2, 1, 1, 1, 1, 1], [1, 2, 3, 1, 2, 1, 2]);
  second.notes = 'Перенесено из generate_tablature_2.py и 2.txt. Размер 7/4 интерпретирует цифровые доли как четверти, а «2 и» как две восьмые; исходный рисунок явно не задаёт длительности. Аккорды из 2–3 нот занимают одну ячейку.';
  second.measures = [
    ['2/4/8', '8', '2/4', '8', '2/4/8', '8', '2/4/8', '7'],
    ['2/4/6', '6', '2/4', '6', '2/4/6', '6', '2/4/6', '6'],
    ['1/3/7', '7', '1/3', '7', '1/3/7', '7', '1/3/7', '8'],
    ['1/3/5', '5', '1/3', '5', '1/3/5', '1', '5', '6']
  ].map((row, i) => measure(second, 'sample-hang-2-m' + (i + 1), { main: row }));

  const massive = Core.createTab({ title: 'Hang Massive', meter: { numerator: 8, denominator: 4 }, hands: 'split' });
  massive.id = 'hang-massive';
  massive.subtitle = 'Отдельные партии правой и левой руки';
  massive.beats = customBeats([1, 2, 1, 1, 2, 1, 1, 1], [1, 2, 3, 1, 2, 3, 1, 2]);
  massive.notes = 'Правая играет маятником. Перенесено из generate_tablature_hang_massive.py. Размер 8/4 интерпретирует цифровые доли как четверти, а «2 и» как две восьмые; исходный рисунок явно не задаёт длительности.';
  massive.measures = [
    { R: ['D', '1', '-', 'D', '1', 'D', '-', '1', 'D', '1'], L: ['6', '-', '6', '-', '6', '-', '6', '-', '6', '-'] },
    { R: ['D', '1', '-', 'D', '1', 'D', '-', '1', 'D', '1'], L: ['8', '-', '7', '-', '6', '-', '1', '-', '6', '-'] }
  ].map((rows, i) => measure(massive, 'sample-hang-massive-m' + (i + 1), rows));

  return [first, second, massive].map(Core.validateTab);
});
