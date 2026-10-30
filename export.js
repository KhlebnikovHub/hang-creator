(function () {
  'use strict';
  const C = window.HangCore;
  const INK = '#263b35', MUTED = '#87917e', GRID = '#dbe1d1';
  const safeName = title => (title || 'табулатура').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 100).trim() || 'табулатура';
  function text(ctx, value, x, y, size = 20, color = INK, align = 'left', weight = '400', maxWidth) {
    ctx.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
    if (maxWidth) ctx.fillText(String(value), x, y, maxWidth); else ctx.fillText(String(value), x, y);
  }
  function wrap(ctx, value, width, size) {
    ctx.font = `400 ${size}px "Segoe UI", Arial, sans-serif`;
    const lines = [];
    for (const paragraph of String(value).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        if (ctx.measureText(line ? line + ' ' + word : word).width > width && line) { lines.push(line); line = ''; }
        if (ctx.measureText(word).width > width) {
          for (const character of word) { if (ctx.measureText(line + character).width > width) { lines.push(line); line = ''; } line += character; }
        } else line += (line ? ' ' : '') + word;
      }
      lines.push(line);
    }
    return lines;
  }
  function drawGrid(ctx, x, y, width, slots, rows, labels, withHands, rowHeight, groups = null) {
    const handWidth = withHands ? 54 : 0, gridX = x + handWidth, gridWidth = width - handWidth;
    const groupHeight = groups ? 28 : 0, headerHeight = 44 + groupHeight;
    const total = slots.reduce((sum, slot) => sum + slot.duration, 0);
    let previous = gridX; const boundaries = [gridX];
    slots.forEach(slot => { previous += slot.duration / total * gridWidth; boundaries.push(previous); });
    ctx.fillStyle = '#f0f3e9'; ctx.fillRect(gridX, y, gridWidth, headerHeight);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.strokeRect(gridX, y, gridWidth, headerHeight + rowHeight * rows.length);
    for (let r = 0; r <= rows.length; r++) { ctx.beginPath(); ctx.moveTo(gridX, y + headerHeight + rowHeight * r); ctx.lineTo(gridX + gridWidth, y + headerHeight + rowHeight * r); ctx.stroke(); }
    const groupStarts = new Set(), dividedSlots = new Set();
    if (groups) {
      let start = 0;
      groups.forEach(group => {
        const end = start + group.division, left = boundaries[start], right = boundaries[end];
        groupStarts.add(start);
        text(ctx, group.label, (left + right) / 2, y + (group.division > 1 ? groupHeight / 2 : headerHeight / 2), 20, '#4e704a', 'center', '600', right - left - 8);
        if (group.division > 1) {
          ctx.strokeStyle = GRID; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(left, y + groupHeight); ctx.lineTo(right, y + groupHeight); ctx.stroke();
          for (let i = start; i < end; i++) dividedSlots.add(i);
        }
        start = end;
      });
    }
    slots.forEach((slot, i) => {
      ctx.strokeStyle = slot.groupStart ? '#b6c4a3' : GRID; ctx.lineWidth = slot.groupStart ? 1.6 : 1;
      const boundaryTop = groups && !groupStarts.has(i) ? y + groupHeight : y;
      ctx.beginPath(); ctx.moveTo(boundaries[i], boundaryTop); ctx.lineTo(boundaries[i], y + headerHeight + rowHeight * rows.length); ctx.stroke();
      const cx = (boundaries[i] + boundaries[i + 1]) / 2, cellWidth = boundaries[i + 1] - boundaries[i];
      if (!groups || dividedSlots.has(i)) text(ctx, labels[i], cx, y + groupHeight + 23, 20, '#668256', 'center', '600', cellWidth - 8);
      rows.forEach((row, r) => {
        const cell = row.cells[i], cy = y + headerHeight + rowHeight * (r + .5);
        if (!cell.length) text(ctx, '—', cx, cy, 23, '#bdc6af', 'center');
        else {
          const fontSize = cell.length > 4 ? 22 : 28, lineHeight = fontSize + 7;
          cell.forEach((part, p) => {
            const py = cy + (p - (cell.length - 1) / 2) * lineHeight;
            text(ctx, part, cx, py, fontSize, INK, 'center', '500', cellWidth - 8);
            if (p < cell.length - 1) { ctx.strokeStyle = INK; ctx.lineWidth = 1.6; const bar = Math.min(cellWidth - 12, 26); ctx.beginPath(); ctx.moveTo(cx - bar / 2, py + lineHeight / 2); ctx.lineTo(cx + bar / 2, py + lineHeight / 2); ctx.stroke(); }
          });
        }
      });
    });
    if (withHands) rows.forEach((row, r) => text(ctx, row.label, x + handWidth / 2, y + headerHeight + rowHeight * (r + .5), 18, MUTED, 'center', '600'));
  }
  async function renderPNG(input) {
    const tab = C.validateTab(input), rowKeys = tab.hands === 'split' ? ['R', 'L'] : ['main'];
    const measureSlots = tab.measures.map((measure, index) => C.slots(tab, index));
    const gridWidths = measureSlots.map(slots => {
      const minDuration = Math.min(...slots.map(slot => slot.duration));
      return Math.ceil(slots.reduce((sum, slot) => sum + slot.duration / minDuration * 52, 0)) + 184 + (rowKeys.length === 2 ? 54 : 0);
    });
    const width = Math.max(1400, ...gridWidths, tab.phraseExample ? tab.phraseExample.labels.length * 52 + 160 : 0);
    if (width > 16000) throw new Error('Сетка слишком широкая для PNG. Уменьшите число частей доли.');
    const margin = 80, contentWidth = width - margin * 2, pageLimit = Math.min(8000, Math.floor(30000000 / width));
    const scratch = document.createElement('canvas').getContext('2d');
    const titleLines = wrap(scratch, tab.title || 'Без названия', contentWidth, 46);
    const subtitleLines = tab.subtitle ? wrap(scratch, tab.subtitle, contentWidth, 22) : [];
    const headerHeight = 76 + titleLines.length * 54 + subtitleLines.length * 30 + 72;
    const items = tab.measures.map((measure, i) => {
      const maxChord = Math.max(1, ...rowKeys.flatMap(row => measure.rows[row].map(cell => cell.length)));
      const rowHeight = Math.max(96, maxChord * (maxChord > 4 ? 29 : 35) + 20);
      const labelLines = measure.label ? wrap(scratch, measure.label, contentWidth - 110, 19) : [];
      const labelHeight = Math.max(36, labelLines.length * 25 + 10);
      const hybridGroups = tab.notation === 'hybrid' ? C.measureBeats(tab, i) : null;
      const gridHeaderHeight = hybridGroups ? 72 : 44;
      return { measure, index: i, slots: measureSlots[i], hybridGroups, rowHeight, labelLines, labelHeight, height: labelHeight + gridHeaderHeight + rowHeight * rowKeys.length + 32 };
    });
    if (tab.phraseExample) {
      const maxChord = Math.max(1, ...tab.phraseExample.notes.map(cell => cell.length));
      const rowHeight = Math.max(110, maxChord * (maxChord > 4 ? 29 : 35) + 20);
      items.push({ example: tab.phraseExample, rowHeight, height: 44 + 44 + rowHeight + 20 });
    }
    const noteLines = tab.notes ? wrap(scratch, tab.notes, contentWidth, 20) : [];
    if (noteLines.length) {
      const batchSize = Math.max(1, Math.floor((pageLimit - headerHeight - 160) / 28));
      for (let i = 0; i < noteLines.length; i += batchSize) items.push({ noteLines: noteLines.slice(i, i + batchSize), height: 55 + Math.min(batchSize, noteLines.length - i) * 28 });
    }
    const pages = []; let page = [], used = headerHeight + 100;
    for (const item of items) {
      if (page.length && used + item.height > pageLimit) { pages.push(page); page = []; used = headerHeight + 100; }
      page.push(item); used += item.height;
    }
    if (page.length) pages.push(page);
    const output = [];
    for (let p = 0; p < pages.length; p++) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = Math.ceil(headerHeight + pages[p].reduce((sum, item) => sum + item.height, 0) + 110);
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Браузер не смог создать PNG.');
      ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      let y = 68;
      titleLines.forEach(line => { text(ctx, line, margin, y, 46); y += 54; });
      subtitleLines.forEach(line => { text(ctx, line, margin, y + 5, 22, MUTED); y += 30; });
      text(ctx, `${tab.meter.numerator}/${tab.meter.denominator}   ·   ♩ = ${tab.tempo} BPM   ·   ${{ count: 'Обычный счёт', konnakol: 'Коннакол', hybrid: 'Гибрид' }[tab.notation]}   ·   ${tab.hands === 'split' ? 'Правая / левая' : 'Одна партия'}`, margin, y + 26, 19, MUTED);
      y = headerHeight - 10;
      for (const item of pages[p]) {
        if (item.measure) {
          text(ctx, String(item.index + 1).padStart(2, '0'), margin, y + 14, 19, '#81946c', 'left', '600');
          item.labelLines.forEach((line, i) => text(ctx, line, margin + 62, y + 14 + i * 25, 19, MUTED));
          drawGrid(ctx, margin, y + item.labelHeight, contentWidth, item.slots, rowKeys.map(row => ({ label: row, cells: item.measure.rows[row] })), item.slots.map(slot => slot.displayLabel), rowKeys.length === 2, item.rowHeight, item.hybridGroups);
        } else if (item.example) {
          text(ctx, 'Фразировка из оригинала · отдельный пример', margin, y + 16, 20, MUTED);
          const exampleSlots = item.example.labels.map((label, i) => ({ duration: 1, groupStart: i === 0 }));
          drawGrid(ctx, margin, y + 44, contentWidth, exampleSlots, [{ cells: item.example.notes }], item.example.labels, false, item.rowHeight);
        } else {
          text(ctx, 'Заметки к исполнению', margin, y + 18, 19, INK, 'left', '600');
          item.noteLines.forEach((line, i) => text(ctx, line, margin, y + 53 + i * 28, 20, MUTED));
        }
        y += item.height;
      }
      text(ctx, 'D · Ding     S · Slap     K · Ka     1–12 · тоновые поля     — · пауза', margin, canvas.height - 55, 17, MUTED);
      text(ctx, `ТИХИЙ РИТМ${pages.length > 1 ? '   ·   ' + (p + 1) + '/' + pages.length : ''}`, width - margin, canvas.height - 55, 15, MUTED, 'right');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Не удалось сформировать PNG.');
      output.push({ blob, name: safeName(tab.title) + (pages.length > 1 ? '_' + String(p + 1).padStart(2, '0') : '') + '.png' });
      canvas.width = 1; canvas.height = 1;
    }
    return output;
  }
  window.HangExport = { renderPNG };
})();
