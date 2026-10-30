(function () {
  'use strict';
  const C = window.HangCore;
  const INK = '#263b35', MUTED = '#87917e', GRID = '#dbe1d1';
  // A page stays below 3.4 megapixels, including the footer. Only one canvas is
  // alive at a time; callers can consume renderPages() without retaining PNGs.
  const WIDTH = 1400, MAX_HEIGHT = 2400, MARGIN = 64, FOOTER = 96;
  const CONTENT = WIDTH - MARGIN * 2;
  const HAND_COLORS = { R: '#2463b4', L: '#c43d4d' };
  const FONT = '"Segoe UI", Arial, sans-serif';
  const safeName = title => (title || 'табулатура').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 100).trim().replace(/[. ]+$/g, '') || 'табулатура';

  function text(ctx, value, x, y, size = 20, color = INK, align = 'left', weight = '400') {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, y);
  }
  function measured(ctx, value, size, weight = '400') {
    ctx.font = `${weight} ${size}px ${FONT}`;
    return ctx.measureText(String(value)).width;
  }
  function wrap(ctx, value, width, size) {
    ctx.font = `400 ${size}px ${FONT}`;
    const lines = [];
    for (const paragraph of String(value).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        if (ctx.measureText(line ? line + ' ' + word : word).width > width && line) { lines.push(line); line = ''; }
        if (ctx.measureText(word).width > width) {
          for (const character of word) {
            if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ''; }
            line += character;
          }
        } else line += (line ? ' ' : '') + word;
      }
      lines.push(line);
    }
    return lines;
  }

  function chordSize(cell) { return cell.length > 4 ? 22 : 28; }
  function namedHand(row) { return row.label === 'R' || row.label === 'L'; }
  function chordHeight(rows) {
    let height = 96;
    for (let i = 0; i < rows[0].cells.length; i++) {
      const occupied = rows.filter(row => row.cells[i].length);
      const content = occupied.reduce((sum, row) => sum + row.cells[i].length * (chordSize(row.cells[i]) + 7), 0);
      height = Math.max(height, content + Math.max(0, occupied.length - 1) * 12 + 24);
    }
    return height;
  }

  function splitGrid(ctx, slots, rows, available, beats) {
    // Use the same musical proportions as the editor, with enough room for
    // actual labels and every note. A wide bar continues on the next line.
    let scale = 0;
    const minimums = slots.map((slot, i) => {
      let width = Math.max(52, measured(ctx, slot.displayLabel, 20, '600') + 20);
      for (const row of rows) for (const note of row.cells[i]) width = Math.max(width, measured(ctx, note, chordSize(row.cells[i]), '500') + (namedHand(row) ? 52 : 20));
      if (beats) width = Math.max(width, measured(ctx, beats[slot.beat].label, 20, '600') + 46);
      scale = Math.max(scale, width / slot.duration);
      return width;
    });
    const chunks = [];
    let start = 0;
    while (start < slots.length) {
      let end = start, used = 0;
      while (end < slots.length) {
        const width = Math.min(available, Math.max(minimums[end], slots[end].duration * scale));
        if (end > start && used + width > available) break;
        used += width; end++;
      }
      const chunkSlots = slots.slice(start, end);
      const chunkRows = rows.map(row => ({ ...row, cells: row.cells.slice(start, end) }));
      const groups = beats ? [] : null;
      if (groups) chunkSlots.forEach((slot, index) => {
        let group = groups[groups.length - 1];
        if (!group || group.beat !== slot.beat) {
          const beat = beats[slot.beat];
          group = { beat: slot.beat, start: index, count: 0, label: beat.label, divided: beat.division > 1 || slot.displayLabel !== slot.label, before: slot.sub > 0, after: false };
          groups.push(group);
        }
        group.count++;
        group.after = slot.sub + 1 < beats[slot.beat].division;
      });
      chunks.push({ slots: chunkSlots, rows: chunkRows, groups, start, end, rowHeight: chordHeight(chunkRows) });
      start = end;
    }
    return chunks;
  }

  function drawGrid(ctx, y, item) {
    const { slots, rows, groups, rowHeight } = item;
    const gridX = MARGIN, width = CONTENT;
    const groupHeight = groups ? 28 : 0, headerHeight = 44 + groupHeight;
    const total = slots.reduce((sum, slot) => sum + slot.duration, 0);
    const boundaries = [gridX];
    for (const slot of slots) boundaries.push(boundaries[boundaries.length - 1] + slot.duration / total * width);
    ctx.fillStyle = '#f0f3e9'; ctx.fillRect(gridX, y, width, headerHeight);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.strokeRect(gridX, y, width, headerHeight + rowHeight);
    ctx.beginPath(); ctx.moveTo(gridX, y + headerHeight); ctx.lineTo(gridX + width, y + headerHeight); ctx.stroke();
    const groupStarts = new Set(), dividedSlots = new Set();
    if (groups) for (const group of groups) {
      const end = group.start + group.count, left = boundaries[group.start], right = boundaries[end];
      groupStarts.add(group.start);
      text(ctx, `${group.before ? '‹ ' : ''}${group.label}${group.after ? ' ›' : ''}`, (left + right) / 2, y + (group.divided ? groupHeight / 2 : headerHeight / 2), 20, '#4e704a', 'center', '600');
      if (group.divided) {
        ctx.strokeStyle = GRID; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, y + groupHeight); ctx.lineTo(right, y + groupHeight); ctx.stroke();
        for (let i = group.start; i < end; i++) dividedSlots.add(i);
      }
    }
    slots.forEach((slot, i) => {
      ctx.strokeStyle = slot.groupStart ? '#b6c4a3' : GRID; ctx.lineWidth = slot.groupStart ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(boundaries[i], groups && !groupStarts.has(i) ? y + groupHeight : y); ctx.lineTo(boundaries[i], y + headerHeight + rowHeight); ctx.stroke();
      const cx = (boundaries[i] + boundaries[i + 1]) / 2;
      if (!groups || dividedSlots.has(i)) text(ctx, slot.displayLabel, cx, y + groupHeight + 23, 20, '#668256', 'center', '600');
      const occupied = rows.filter(row => row.cells[i].length), cy = y + headerHeight + rowHeight / 2;
      const contentHeight = occupied.reduce((sum, row) => sum + row.cells[i].length * (chordSize(row.cells[i]) + 7), 0) + Math.max(0, occupied.length - 1) * 12;
      let top = cy - contentHeight / 2;
      if (!occupied.length) text(ctx, '—', cx, cy, 23, '#bdc6af', 'center');
      occupied.forEach(row => {
        const cell = row.cells[i], size = chordSize(cell), lineHeight = size + 7, noteX = cx + (namedHand(row) ? 8 : 0);
        cell.forEach((note, n) => {
          const py = top + lineHeight * (n + .5);
          text(ctx, note, noteX, py, size, row.color || INK, 'center', '500');
          if (namedHand(row) && n === 0) text(ctx, row.label, boundaries[i] + 12, py, 12, row.color || INK, 'center', '600');
          if (n < cell.length - 1) { ctx.strokeStyle = row.color || INK; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(noteX - 13, py + lineHeight / 2); ctx.lineTo(noteX + 13, py + lineHeight / 2); ctx.stroke(); }
        });
        top += cell.length * lineHeight + 12;
      });
    });
  }

  function layout(ctx, tab, options) {
    // Headings are single text fields. Flatten pasted line breaks so a valid
    // title cannot consume an entire image with empty lines.
    const titleLines = wrap(ctx, (tab.title || 'Без названия').replace(/\s+/g, ' ').trim(), CONTENT, 46);
    const subtitleLines = tab.subtitle ? wrap(ctx, tab.subtitle.replace(/\s+/g, ' ').trim(), CONTENT, 22) : [];
    const handModes = new Set(tab.measures.flatMap((measure, index) => measure.rows.main.map((_, slot) => C.cellHands(tab, index, slot))));
    const handsLabel = handModes.size > 1 ? 'Обычные ячейки и R/L' : handModes.has('split') ? 'Правая / левая' : 'Одна партия';
    const meta = `${tab.meter.numerator}/${tab.meter.denominator}   ·   ♩ = ${tab.tempo} BPM   ·   ${{ count: 'Обычный счёт', konnakol: 'Коннакол', hybrid: 'Гибрид' }[tab.notation]}   ·   ${handsLabel}`;
    const metaLines = wrap(ctx, meta, CONTENT, 19);
    const headerHeight = 64 + titleLines.length * 54 + subtitleLines.length * 30 + metaLines.length * 27 + 36;
    const itemLimit = MAX_HEIGHT - headerHeight - FOOTER;
    const pages = [], rowKeys = ['main', 'R', 'L'];
    let page = [], used = 0;
    function add(item) {
      if (item.height > itemLimit) throw new Error('Заголовок или такт слишком длинный для страницы PNG. Сократите текст заголовка.');
      if (page.length && used + item.height > itemLimit) { pages.push(page); page = []; used = 0; }
      page.push(item); used += item.height;
    }
    let indices = tab.measures.map((_, index) => index);
    if (options.measureIndex !== undefined) {
      if (!Number.isInteger(options.measureIndex) || options.measureIndex < 0 || options.measureIndex >= tab.measures.length) throw new Error('Выберите существующий такт для экспорта.');
      indices = [options.measureIndex];
    }
    for (const index of indices) {
      const measure = tab.measures[index], slots = C.slots(tab, index);
      const rows = rowKeys.map(row => ({ label: row, cells: measure.rows[row].map((cell, slot) => C.cellRows(tab, index, slot).includes(row) ? cell : []), color: tab.handColors === false ? INK : HAND_COLORS[row] || INK }));
      const chunks = splitGrid(ctx, slots, rows, CONTENT, tab.notation === 'hybrid' ? C.measureBeats(tab, index) : null);
      chunks.forEach((chunk, part) => {
        const heading = `Такт ${index + 1}${chunks.length > 1 ? ` · часть ${part + 1}/${chunks.length} · позиции ${chunk.start + 1}–${chunk.end}` : ''}`;
        const labelLines = measure.label ? wrap(ctx, measure.label.replace(/\s+/g, ' ').trim(), CONTENT, 19) : [];
        const labelHeight = 36 + labelLines.length * 25;
        add({ ...chunk, heading, labelLines, labelHeight, height: labelHeight + (chunk.groups ? 72 : 44) + chunk.rowHeight + 32 });
      });
    }
    // A phrase example is independent of the selected measure; include it only
    // when exporting the whole document, like the original printed appendix.
    if (tab.phraseExample && options.measureIndex === undefined) {
      const example = tab.phraseExample;
      const slots = example.labels.map((label, index) => ({ duration: 1, displayLabel: label, groupStart: index === 0 }));
      const chunks = splitGrid(ctx, slots, [{ cells: example.notes }], CONTENT, null);
      chunks.forEach((chunk, part) => add({ ...chunk, heading: `Фразировка из оригинала · отдельный пример${chunks.length > 1 ? ` · ${part + 1}/${chunks.length}` : ''}`, labelLines: [], labelHeight: 40, height: 40 + 44 + chunk.rowHeight + 32 }));
    }
    const noteLines = tab.notes ? wrap(ctx, tab.notes, CONTENT, 20) : [];
    const batch = Math.max(1, Math.floor((itemLimit - 76) / 28));
    for (let i = 0; i < noteLines.length; i += batch) {
      const lines = noteLines.slice(i, i + batch);
      add({ noteLines: lines, heading: i ? 'Заметки к исполнению · продолжение' : 'Заметки к исполнению', height: 76 + lines.length * 28 });
    }
    if (page.length) pages.push(page);
    return { pages, titleLines, subtitleLines, metaLines, headerHeight };
  }

  async function* renderPages(input, options = {}) {
    // Validation returns an independent snapshot: edits during an export must
    // not change later pages of that export.
    const tab = C.validateTab(input);
    let scratch = document.createElement('canvas');
    scratch.width = scratch.height = 1;
    const measureContext = scratch.getContext('2d');
    if (!measureContext) throw new Error('Браузер не смог создать PNG.');
    const plan = layout(measureContext, tab, options);
    scratch = null;
    for (let p = 0; p < plan.pages.length; p++) {
      const items = plan.pages[p], canvas = document.createElement('canvas');
      let blob;
      try {
        canvas.width = WIDTH;
        canvas.height = Math.ceil(plan.headerHeight + items.reduce((sum, item) => sum + item.height, 0) + FOOTER);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Браузер не смог создать PNG.');
        ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        let y = 64;
        for (const line of plan.titleLines) { text(ctx, line, MARGIN, y, 46); y += 54; }
        for (const line of plan.subtitleLines) { text(ctx, line, MARGIN, y, 22, MUTED); y += 30; }
        for (const line of plan.metaLines) { text(ctx, line, MARGIN, y + 12, 19, MUTED); y += 27; }
        y = plan.headerHeight;
        for (const item of items) {
          text(ctx, item.heading, MARGIN, y + 14, 19, '#67815a', 'left', '600');
          if (item.noteLines) item.noteLines.forEach((line, i) => text(ctx, line, MARGIN, y + 53 + i * 28, 20, MUTED));
          else {
            item.labelLines.forEach((line, i) => text(ctx, line, MARGIN, y + 43 + i * 25, 19, MUTED));
            drawGrid(ctx, y + item.labelHeight, item);
          }
          y += item.height;
        }
        text(ctx, 'D · Ding    S · Slap    K · Ka    1–12 · тоновые поля    — · пауза', MARGIN, canvas.height - 48, 17, MUTED);
        text(ctx, `ТИХИЙ РИТМ · ${p + 1}/${plan.pages.length}`, WIDTH - MARGIN, canvas.height - 48, 15, MUTED, 'right');
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Не удалось сформировать PNG.');
      } finally {
        // Release pixels before yielding, including when encoding fails.
        canvas.width = canvas.height = 1;
      }
      const measureSuffix = options.measureIndex === undefined ? '' : `_такт-${options.measureIndex + 1}`;
      const pageSuffix = plan.pages.length > 1 ? '_' + String(p + 1).padStart(2, '0') : '';
      yield { blob, name: safeName(tab.title) + measureSuffix + pageSuffix + '.png', page: p + 1, total: plan.pages.length };
    }
  }
  async function renderPNG(input, options) {
    const output = [];
    for await (const page of renderPages(input, options)) output.push(page);
    return output;
  }
  window.HangExport = { renderPages, renderPNG };
})();
