const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../core.js');

function renderer({ failEncoding = false, source = path.join(__dirname, '../export.js') } = {}) {
  const canvases = [], pages = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 300, height: 150 };
      const labels = [], rectangles = [], lines = [];
      let lineStart;
      const ctx = {
        font: '20px Arial', textAlign: 'left',
        measureText(value) { return { width: [...String(value)].length * Number(this.font.match(/(\d+)px/)[1]) * .6 }; },
        fillText(value, x, y, ...extra) {
          // Supplying maxWidth would hide overlapping columns by compressing
          // note names. The exporter must allocate their actual text width.
          assert.equal(extra.length, 0);
          const width = this.measureText(value).width;
          const left = this.textAlign === 'center' ? x - width / 2 : this.textAlign === 'right' ? x - width : x;
          assert.ok(left >= 0 && left + width <= canvas.width + 1, `Text outside page: ${value}`);
          assert.ok(y > 0 && y < canvas.height, `Text outside page vertically: ${value}`);
          labels.push({ text: String(value), x, y, width, color: this.fillStyle });
        },
        fillRect() {}, strokeRect(x, y, width, height) { rectangles.push({ x, y, width, height }); },
        beginPath() { lineStart = null; }, moveTo(x, y) { lineStart = { x, y }; },
        lineTo(x, y) { if (lineStart) lines.push({ from: lineStart, to: { x, y } }); lineStart = { x, y }; }, stroke() {}
      };
      canvas.getContext = () => ctx;
      canvas.toBlob = callback => {
        pages.push({ width: canvas.width, height: canvas.height, labels: [...labels], rectangles: [...rectangles], lines: [...lines] });
        callback(failEncoding ? null : new Blob(['PNG page'], { type: 'image/png' }));
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  const window = { HangCore: C };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { window, document });
  return { api: window.HangExport, canvases, pages };
}

test('wide hybrid measures keep every chord note, hand and beat across bounded pages', async () => {
  const tab = C.createTab({ title: 'Длинная табулатура', meter: { numerator: 32, denominator: 4 }, division: 16, hands: 'split' });
  tab.notation = 'hybrid';
  tab.measures = tab.measures.slice(0, 1);
  tab.measures[0].label = 'Неровная фраза';
  tab.measures[0].rows.R = tab.measures[0].rows.R.map((_, i) => [`R${i}`, `X${i}`]);
  tab.measures[0].rows.L = tab.measures[0].rows.L.map((_, i) => [`L${i}`]);
  const { api, pages, canvases } = renderer();
  const outputs = await api.renderPNG(tab);
  assert.ok(outputs.length > 1);
  assert.equal(outputs.length, pages.length);
  const allText = pages.flatMap(page => page.labels.map(label => label.text));
  for (let i = 0; i < 512; i++) for (const prefix of ['R', 'X', 'L']) assert.equal(allText.filter(value => value === `${prefix}${i}`).length, 1);
  assert.ok(allText.some(value => /часть 2\//.test(value)));
  assert.ok(allText.some(value => /‹|›/.test(value)), 'Split beats must visibly continue');
  assert.ok(allText.includes('R') && allText.includes('L'));
  for (const page of pages) { assert.equal(page.width, 1400); assert.ok(page.height <= 2400); }
  for (const canvas of canvases) { assert.equal(canvas.width, 1); assert.equal(canvas.height, 1); }
  assert.equal(new Set(outputs.map(item => item.name)).size, outputs.length);
});

test('per-measure rhythms, phrase syllables, appendix and long notes survive export', async () => {
  let tab = C.createTab({ title: 'Тест' });
  tab = C.setMeasureRhythm(tab, 1, C.makeBeats(tab.meter, 3)).tab;
  tab.notation = 'konnakol';
  tab.phrases = [{ size: 2, syllables: ['phraseA', 'phraseB'] }];
  tab.measures[1].rows.main = tab.measures[1].rows.main.map((_, i) => [`own${i}`]);
  tab.phraseExample = { labels: Array.from({ length: 80 }, (_, i) => `syllable${i}`), notes: Array.from({ length: 80 }, (_, i) => [`example${i}`]) };
  tab.notes = Array.from({ length: 150 }, (_, i) => `Заметка-${i}`).join('\n');
  const { api, pages } = renderer();
  await api.renderPNG(tab);
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  for (let i = 0; i < 12; i++) assert.equal(texts.filter(value => value === `own${i}`).length, 1);
  for (let i = 0; i < 80; i++) { assert.equal(texts.filter(value => value === `example${i}`).length, 1); assert.equal(texts.filter(value => value === `syllable${i}`).length, 1); }
  for (let i = 0; i < 150; i++) assert.equal(texts.filter(value => value === `Заметка-${i}`).length, 1);
  assert.ok(texts.includes('phraseA') && texts.includes('phraseB'));
  assert.ok(pages.every(page => page.height <= 2400));
});

test('lazy iteration encodes only requested pages, releases canvas and snapshots the document', async () => {
  const tab = C.createTab();
  tab.measures = Array.from({ length: 25 }, () => C.emptyMeasure(tab));
  tab.measures[24].rows.main[0] = ['original'];
  const { api, pages, canvases } = renderer();
  const iterator = api.renderPages(tab);
  assert.equal(pages.length, 0);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(pages.length, 1);
  assert.ok(canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
  tab.measures[24].rows.main[0] = ['changed'];
  for await (const _ of iterator) { /* consume the snapshot */ }
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  assert.ok(texts.includes('original'));
  assert.ok(!texts.includes('changed'));
  const cancelled = api.renderPages(tab);
  await cancelled.next();
  const encoded = pages.length;
  await cancelled.return();
  assert.equal(pages.length, encoded);
});

test('single measure retains its original number, and encoding failures free pixels', async () => {
  const tab = C.createTab();
  tab.measures.forEach((measure, i) => { measure.rows.main[0] = [`measure${i}`]; });
  const { api, pages } = renderer();
  const result = await api.renderPNG(tab, { measureIndex: 2 });
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  assert.ok(texts.includes('Такт 3') && texts.includes('measure2'));
  assert.ok(!texts.includes('measure0'));
  assert.match(result[0].name, /_такт-3\.png$/);
  await assert.rejects(api.renderPNG(tab, { measureIndex: 9 }), /существующий такт/);
  const failing = renderer({ failEncoding: true });
  await assert.rejects(failing.api.renderPNG(tab), /сформировать PNG/);
  assert.ok(failing.canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
});

for (const edition of ['desktop']) {
  const source = path.join(__dirname, '../export.js');
  // mobile is also distributed as its own repository and iOS source package.
  // Exercise sibling editions only when running in the full development tree.
  if (edition !== 'mobile' && !fs.existsSync(source)) continue;
  test(`${edition}: simultaneous hands share one grid cell, preserve identical notes and remain identifiable without color`, async () => {
    const tab = C.createTab({ hands: 'split' });
    tab.measures = tab.measures.slice(0, 1);
    tab.measures[0].rows.R[0] = ['D', '4'];
    tab.measures[0].rows.L[0] = ['D', '8'];
    for (const handColors of [true, false]) {
      tab.handColors = handColors;
      const { api, pages } = renderer({ source });
      await api.renderPNG(tab);
      const page = pages[0], rect = page.rectangles[0];
      assert.equal(page.rectangles.length, 1, 'The whole bar uses one note row');
      const tones = page.labels.filter(label => ['D', '4', '8'].includes(label.text) && label.y > rect.y + 44 && label.y < rect.y + rect.height);
      assert.equal(tones.filter(label => label.text === 'D').length, 2, 'Both hands playing the same tone are retained');
      assert.equal(new Set(tones.map(label => label.x)).size, 1, 'Hands occupy the same time column');
      assert.ok(tones.every(label => label.y > rect.y + 44 && label.y < rect.y + rect.height));
      const internalFullWidthLines = page.lines.filter(line => line.from.x === rect.x && line.to.x === rect.x + rect.width && line.from.y > rect.y + 44 && line.from.y < rect.y + rect.height);
      assert.equal(internalFullWidthLines.length, 0, 'No horizontal cell border divides the hands');
      assert.ok(page.labels.some(label => label.text === 'R') && page.labels.some(label => label.text === 'L'));
      assert.equal(tones.find(label => label.text === '4').color, handColors ? '#2463b4' : '#263b35');
      assert.equal(tones.find(label => label.text === '8').color, handColors ? '#c43d4d' : '#263b35');
    }
  });
  test(`${edition}: local splitting keeps 2:1:1 cell proportions and exports personal syllables`, async () => {
    let tab = C.createTab({ meter: { numerator: 1, denominator: 4 }, division: 2 });
    tab.measures = tab.measures.slice(0, 1);
    tab = C.splitSlot(tab, 0, 1, 2).tab;
    tab = C.setKonnakolPattern(tab, ['Pa', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Jo', 'Nu']);
    tab = C.setSlotSyllable(tab, 0, 2, 'Da');
    tab.notation = 'konnakol';
    tab.measures[0].rows.main = [['A'], ['B'], ['C']];
    const { api, pages } = renderer({ source });
    await api.renderPNG(tab);
    const page = pages[0], rect = page.rectangles[0];
    const bounds = [...new Set(page.lines.filter(line => line.from.x === line.to.x && line.from.y === rect.y).map(line => line.from.x)), rect.x + rect.width].sort((a, b) => a - b);
    assert.equal(bounds.length, 4);
    assert.equal(bounds[1] - bounds[0], 2 * (bounds[2] - bounds[1]));
    assert.equal(bounds[2] - bounds[1], bounds[3] - bounds[2]);
    assert.ok(page.labels.some(label => label.text === 'Pa'));
    assert.ok(page.labels.some(label => label.text === 'Da'));
    for (const note of ['A', 'B', 'C']) assert.equal(page.labels.filter(label => label.text === note).length, 1);
  });
  test(`${edition}: hybrid whole-beat syllable keeps its beat number above the custom syllable`, async () => {
    let tab = C.createTab({ meter: { numerator: 1, denominator: 4 } });
    tab.measures = tab.measures.slice(0, 1);
    tab = C.setSlotSyllable(tab, 0, 0, 'Da');
    tab.notation = 'hybrid';
    const { api, pages } = renderer({ source });
    await api.renderPNG(tab);
    const labels = pages.flatMap(page => page.labels);
    const beat = labels.find(label => label.text === '1'), syllable = labels.find(label => label.text === 'Da');
    assert.ok(beat && syllable);
    assert.equal(beat.x, syllable.x);
    assert.ok(beat.y < syllable.y);
  });
  test(`${edition}: local hand modes export only active notes without adding a main badge`, async () => {
    for (const hands of ['single', 'split']) for (const handColors of [true, false]) {
      let tab = C.createTab({ hands, division: 2 });
      tab.measures = tab.measures.slice(0, 1);
      tab.handColors = handColors;
      tab = C.setCellHands(tab, 0, 0, 'single');
      tab = C.setCellHands(tab, 0, 1, 'split');
      tab.measures[0].rows.main[0] = ['neutral'];
      tab.measures[0].rows.R[1] = ['right'];
      tab.measures[0].rows.L[1] = ['left'];
      tab.measures[0].rows.R[0] = ['ghostR'];
      tab.measures[0].rows.L[0] = ['ghostL'];
      tab.measures[0].rows.main[1] = ['ghostMain'];
      const { api, pages } = renderer({ source });
      await api.renderPNG(tab);
      const labels = pages.flatMap(page => page.labels), texts = labels.map(label => label.text);
      for (const note of ['neutral', 'right', 'left']) assert.equal(texts.filter(text => text === note).length, 1);
      assert.ok(!texts.some(text => ['main', 'ghostR', 'ghostL', 'ghostMain'].includes(text)));
      assert.equal(texts.filter(text => text === 'R').length, 1);
      assert.equal(texts.filter(text => text === 'L').length, 1);
      assert.equal(labels.find(label => label.text === 'neutral').color, '#263b35');
      assert.equal(labels.find(label => label.text === 'right').color, handColors ? '#2463b4' : '#263b35');
      assert.equal(labels.find(label => label.text === 'left').color, handColors ? '#c43d4d' : '#263b35');
      assert.equal(labels.find(label => label.text === 'right').x, labels.find(label => label.text === 'left').x);
      const rect = pages[0].rectangles[0];
      assert.ok(Math.abs(labels.find(label => label.text === 'neutral').x - (rect.x + rect.width / 16)) < .01);
      assert.ok(Math.abs(labels.find(label => label.text === 'right').x - (rect.x + rect.width * 3 / 16 + 8)) < .01);
    }
  });
}
