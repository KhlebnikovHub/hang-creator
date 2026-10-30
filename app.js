(function () {
  'use strict';
  const C = window.HangCore;
  const $ = id => document.getElementById(id);
  const KEY = 'quiet-rhythm-library-v1';
  const state = { tabs: [], current: null, mode: 'browser', pending: new Set(), deleted: new Set(), undo: [], redo: [], selected: { measure: 0, row: 'main', slot: 0 }, rhythmScope: 'measure', playing: false, preview: false, autoAdvance: true };
  let saveTimer, toastTimer, savePromise, storageOK = true, historyTime = 0, historyKey = '', player;
  const files = window.HangFiles.create({ download });
  const directory = window.HangDirectory.create();
  const folderRecords = new Map();
  let savingTabId = null, fileSaveError = null, serverSaveError = false, openingFile = false, folderLoading = false;
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const current = () => state.tabs.find(tab => tab.id === state.current);
  const rowsFor = tab => tab.hands === 'split' ? ['R', 'L'] : ['main'];
  const notationNames = { count: 'Счёт', konnakol: 'Коннакол', hybrid: 'Гибрид' };
  const formatMeter = tab => `${tab.meter.numerator}/${tab.meter.denominator}`;
  function fileStatus(tab = current()) {
    if (!tab) return null;
    if (state.mode === 'browser' && directory.info()) {
      const record = folderRecords.get(tab.id);
      return record ? { kind: 'folder', name: record.name, folder: directory.info().name, dirty: record.snapshot !== JSON.stringify(tab, null, 2) + '\n' } : null;
    }
    return files.status(tab);
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
  }
  function persistCache() {
    try { localStorage.setItem(KEY, JSON.stringify({ tabs: state.tabs, current: state.current, pending: [...state.pending], deleted: [...state.deleted] })); storageOK = true; }
    catch { storageOK = false; toast('Браузер не смог сохранить копию. Нажмите «Сохранить изменения», чтобы записать JSON-файл.', true); }
  }
  function showSaveStatus() {
    const tab = current(), saved = fileStatus(tab), folder = directory.info();
    const status = $('save-status'), saving = savingTabId === state.current;
    status.dataset.fileState = saving || folderLoading ? 'saving' : fileSaveError === state.current ? 'error' : saved ? (saved.dirty ? 'dirty' : saved.kind === 'download' ? 'download' : 'saved') : 'browser';
    if (folderLoading) status.textContent = 'Чтение папки…';
    else if (saving) status.textContent = 'Запись изменений…';
    else if (fileSaveError === state.current) status.textContent = 'Ошибка записи файла';
    else if (state.mode === 'server') {
      status.dataset.fileState = serverSaveError ? 'error' : state.pending.size || state.deleted.size ? 'saving' : 'saved';
      status.textContent = serverSaveError ? (storageOK ? 'Копия в браузере · ошибка записи' : 'Ошибка сохранения · сохраните JSON') : state.pending.size || state.deleted.size ? 'Сохраняется…' : '✓ В папке tabs';
    }
    else if (saved?.dirty) status.textContent = storageOK ? 'Есть изменения · копия в браузере' : 'Есть несохранённые изменения';
    else if (folder && folder.permission !== 'granted') { status.dataset.fileState = 'browser'; status.textContent = 'Разрешите доступ к папке'; }
    else if (saved) status.textContent = saved.kind === 'folder' ? `✓ В папке ${folder.name}` : saved.kind === 'file' ? '✓ В файле' : 'JSON отправлен в загрузки';
    else status.textContent = storageOK ? 'Копия в браузере · сохраните файл' : 'Сохраните изменения в файл';
    $('save-changes').disabled = savingTabId !== null || folderLoading;
    $('save-changes').textContent = savingTabId !== null ? 'Сохраняю…' : 'Сохранить изменения';
    $('save-json').disabled = savingTabId !== null || folderLoading;
    $('storage-mode').textContent = state.mode === 'server' ? 'Файлы в папке tabs' : folder ? `Папка: ${folder.name}` : 'Без сервера · JSON-файлы';
    $('folder-settings').hidden = state.mode === 'server' || !directory.available();
    $('choose-folder').disabled = savingTabId !== null || folderLoading;
    $('change-folder').disabled = savingTabId !== null || folderLoading;
    $('choose-folder').textContent = folder ? folder.permission === 'granted' ? `▣ Папка ${folder.name}` : '▣ Разрешить доступ' : '▣ Выбрать папку tabs';
    $('choose-folder').title = folder ? 'Прочитать табулатуры из выбранной папки; несохранённые правки сохранятся' : 'Выберите папку tabs рядом с index.html';
    $('change-folder').hidden = !folder;
    $('folder-status').textContent = !folder ? 'Выберите tabs рядом с index.html один раз.' : folder.permission !== 'granted' ? 'Папка запомнена. Подтвердите доступ без нового выбора.' : folder.remembered ? 'Папка запомнена для следующих запусков.' : 'Доступ есть. Браузер не смог запомнить папку между запусками.';
    const note = $('file-save-note'); note.hidden = state.mode === 'server';
    if (folder && folder.permission !== 'granted') note.textContent = `Папка ${folder.name} запомнена. Нажмите «Разрешить доступ», чтобы загрузить табулатуры и продолжить сохранение в эту папку.`;
    else if (folder) note.textContent = `Табулатуры читаются из папки ${folder.name}. «Сохранить изменения» записывает текущую табулатуру туда без выбора файла.`;
    else if (directory.available()) note.textContent = 'Один раз выберите папку tabs рядом с index.html. Приложение прочитает её табулатуры и будет сохранять изменения туда.';
    else if (saved?.kind === 'file') note.textContent = `Файл: ${saved.name}. Кнопка «Сохранить изменения» обновляет его. После обновления или закрытия страницы откройте файл заново.`;
    else if (!saved && typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false) note.textContent = '«Сохранить изменения» запишет текущую табулатуру в выбранный JSON-файл. Следующие сохранения обновят этот файл.';
    else note.textContent = '«Сохранить изменения» скачивает текущую табулатуру в JSON со всеми настройками. Чтобы продолжить на другом устройстве, откройте этот файл.';
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { signal: AbortSignal.timeout(10000), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (!response.ok) throw new Error(`Сервер вернул ${response.status}`);
    return response.json();
  }
  function queueSave() {
    fileSaveError = null; serverSaveError = false;
    persistCache(); showSaveStatus(); clearTimeout(saveTimer);
    if (state.mode === 'server') saveTimer = setTimeout(flushSaves, 450);
  }
  async function flushSaves() {
    if (state.mode !== 'server') return;
    if (savePromise) { await savePromise; if (state.pending.size || state.deleted.size) return flushSaves(); return; }
    savePromise = (async () => {
      serverSaveError = false; showSaveStatus();
      try {
        for (const id of [...state.deleted]) { await request('/api/tabs/' + encodeURIComponent(id), { method: 'DELETE' }); state.deleted.delete(id); }
        for (const id of [...state.pending]) {
          const tab = state.tabs.find(item => item.id === id);
          if (!tab) { state.pending.delete(id); continue; }
          const snapshot = JSON.stringify(tab);
          await request('/api/tabs', { method: 'POST', body: snapshot });
          if (JSON.stringify(state.tabs.find(item => item.id === id)) === snapshot) state.pending.delete(id);
        }
        persistCache(); showSaveStatus();
      } catch (error) {
        serverSaveError = true; showSaveStatus();
        toast(storageOK ? 'Не удалось записать файлы. Копия сохранена в браузере; повторю запись при следующем изменении.' : 'Не удалось сохранить изменения. Скачайте JSON, чтобы сохранить свою работу.', true);
      }
    })();
    await savePromise; savePromise = null;
  }
  function commit(mutator, options = {}) {
    stopPlayback();
    const before = current(); if (!before) return;
    const selectedId = before.measures[state.selected.measure]?.id;
    const next = C.clone(before); const result = mutator(next) || next;
    if (JSON.stringify(before) === JSON.stringify(result)) return;
    const now = Date.now();
    if (!options.key || options.key !== historyKey || now - historyTime > 700) state.undo.push(C.clone(before));
    if (state.undo.length > 100) state.undo.shift();
    historyTime = now; historyKey = options.key || ''; state.redo = [];
    state.tabs[state.tabs.findIndex(tab => tab.id === before.id)] = result;
    const selectedIndex = result.measures.findIndex(measure => measure.id === selectedId);
    state.selected.measure = selectedIndex >= 0 ? selectedIndex : Math.min(state.selected.measure, result.measures.length - 1);
    state.pending.add(result.id); queueSave();
    if (options.render !== false) render(); else { renderLibrary(); updateUndo(); $('breadcrumb-title').textContent = result.title || 'Без названия'; }
  }
  function switchTab(id) {
    if (!state.tabs.some(tab => tab.id === id)) return;
    if (id === state.current) return;
    stopPlayback(); state.current = id; state.undo = []; state.redo = []; historyKey = '';
    state.rhythmScope = 'measure';
    state.selected = { measure: 0, row: current().hands === 'split' ? 'R' : 'main', slot: 0 };
    persistCache(); render();
  }
  function addTab(tab) {
    state.tabs.unshift(tab); state.pending.add(tab.id); state.deleted.delete(tab.id); switchTab(tab.id); queueSave();
  }
  function renderLibrary() {
    const query = $('search').value.toLocaleLowerCase();
    $('library-count').textContent = state.tabs.length;
    const filtered = state.tabs.filter(tab => (tab.title + ' ' + tab.subtitle).toLocaleLowerCase().includes(query));
    $('library').innerHTML = filtered.length ? filtered.map(tab => `<button class="library-item ${tab.id === state.current ? 'active' : ''}" data-tab="${esc(tab.id)}" ${tab.id === state.current ? 'aria-current="true"' : ''}><span class="library-icon" aria-hidden="true">♫</span><span><strong>${esc(tab.title || 'Без названия')}</strong><small>${formatMeter(tab)} &nbsp;·&nbsp; ${tab.measures.length} такт. &nbsp;·&nbsp; ${notationNames[tab.notation]}</small></span></button>`).join('') : '<div class="empty-library">Ничего не найдено</div>';
  }
  function updateUndo() { $('undo').disabled = !state.undo.length; $('redo').disabled = !state.redo.length; }
  function renderBeats(tab) {
    state.selected.measure = Math.min(state.selected.measure, tab.measures.length - 1);
    const local = state.rhythmScope === 'measure', selected = state.selected.measure;
    const beats = local ? C.measureBeats(tab, selected) : tab.beats;
    const slots = C.slots(tab, local ? selected : undefined);
    const mixed = tab.measures.some((measure, index) => JSON.stringify(C.measureBeats(tab, index)) !== JSON.stringify(tab.beats));
    $('rhythm-scope').value = state.rhythmScope;
    $('rhythm-measure').innerHTML = tab.measures.map((measure, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>Такт ${index + 1}</option>`).join('');
    $('rhythm-measure').disabled = !local;
    $('rhythm-scope-note').textContent = local ? `Изменения только в такте ${selected + 1}.` : 'Меняется выбранная доля во всех тактах; остальные деления сохраняются.';
    const options = [1, 2, 3, 4, 5, 7, 8, 16];
    $('beat-controls').innerHTML = beats.map((beat, i) => {
      const shown = slots.filter(slot => slot.beat === i).map(slot => slot.displayLabel);
      const choices = [...new Set([...options, beat.division])].sort((a, b) => a - b);
      const phraseActive = tab.notation === 'konnakol' && tab.phrases.length > 0;
      const different = !local && tab.measures.some((measure, index) => C.measureBeats(tab, index)[i]?.division !== beat.division);
      const usesSyllables = tab.notation === 'konnakol' || (tab.notation === 'hybrid' && beat.division > 1);
      const mixedHybrid = tab.notation === 'hybrid' && different;
      const value = usesSyllables ? (phraseActive ? shown.join(' ') : beat.syllables.length ? beat.syllables.join(' ') : shown.join(' ')) : beat.label;
      const title = mixedHybrid ? 'Для подписи выберите конкретный такт или одинаковое деление этой доли во всех тактах.' : phraseActive ? 'Слоги задаёт фраза. Чтобы редактировать доли, выберите «По долям» и нажмите «Применить».' : usesSyllables ? 'Свои слоги: по одному на часть, через пробел.' : 'Первая подпись доли. Остальные части подписываются автоматически.';
      return `<div class="beat-control"><div class="beat-control-head"><span title="${beat.units}/${tab.meter.denominator}">${i + 1}</span><select data-beat="${i}" aria-label="Части доли ${i + 1}">${different ? '<option value="" selected disabled>Разные</option>' : ''}${choices.map(n => `<option value="${n}" ${!different && n === beat.division ? 'selected' : ''}>${n} ${n === 1 ? 'часть' : n < 5 ? 'части' : 'частей'}</option>`).join('')}</select></div><input class="beat-label" data-label-beat="${i}" ${phraseActive || mixedHybrid ? 'disabled' : ''} aria-label="${usesSyllables ? 'Слоги' : 'Номер'} доли ${i + 1}" title="${esc(title)}" value="${esc(mixedHybrid ? '' : value)}" maxlength="${usesSyllables ? 500 : 32}" placeholder="${esc(mixedHybrid ? 'Разные деления' : shown.join(' '))}"></div>`;
    }).join('');
    $('rhythm-summary').textContent = `${local ? 'Такт ' + (selected + 1) : 'Все такты'} · ${formatMeter(tab)} · ${!local && mixed ? 'деления различаются между тактами' : slots.length + ' позиций'}.`;
    $('konnakol-panel').hidden = tab.notation !== 'konnakol';
    $('phrase-preset').value = !tab.phrases.length ? 'beats' : 'custom';
    $('phrase-input').value = tab.phrases.map(phrase => phrase.syllables.join(' ')).join(' | ');
    const total = tab.phrases.reduce((sum, phrase) => sum + phrase.size, 0);
    const equal = slots.every(slot => Math.abs(slot.duration - slots[0].duration) < 1e-9);
    $('phrase-note').textContent = total ? `Фраза: ${tab.phrases.map(p => p.size).join(' + ')}. ${slots.length % total ? 'Фраза обрывается на границе такта. ' : 'Повторяется в пределах такта. '}${equal ? 'Все позиции равной длительности.' : 'Позиции разной длительности: фраза следует текущей сетке.'}` : 'Ta Ki Ta — 3 части; Ta Ka Di Mi и Ta Ka Jo Nu — по 4. Здесь слоги следуют делению доли.';
  }
  function chordMarkup(cell) {
    return !cell.length ? '—' : cell.length === 1 ? esc(cell[0]) : `<span class="chord">${cell.map(part => `<span>${esc(part)}</span>`).join('')}</span>`;
  }
  function countHeader(tab, measureIndex, slots, withHands) {
    if (tab.notation !== 'hybrid') return `${withHands ? '<div class="hand-label count-hand">Счёт</div>' : ''}${slots.map(slot => `<div class="count-cell ${slot.sub === 0 ? 'beat-start' : ''} ${slot.groupStart ? 'group-start' : ''}" data-count-slot="${slot.index}">${esc(slot.displayLabel)}</div>`).join('')}`;
    let index = 0;
    const hand = withHands ? '<div class="hand-label count-hand hybrid-count-hand" style="grid-column:1;grid-row:1 / span 2">Счёт</div>' : '';
    return hand + C.measureBeats(tab, measureIndex).map((beat, beatIndex) => {
      const start = index; index += beat.division;
      const column = start + (withHands ? 2 : 1);
      if (beat.division === 1) return `<div class="count-cell hybrid-whole beat-start group-start" data-beat-number="${beatIndex}" data-count-slot="${start}" style="grid-column:${column};grid-row:1 / span 2">${esc(beat.label)}</div>`;
      return `<div class="hybrid-beat" data-beat-number="${beatIndex}" style="grid-column:${column} / span ${beat.division};grid-row:1" aria-label="Доля ${esc(beat.label)}">${esc(beat.label)}</div>` + slots.slice(start, index).map((slot, sub) => `<div class="count-cell hybrid-syllable ${sub === 0 ? 'beat-start group-start' : ''}" data-count-slot="${slot.index}" style="grid-column:${column + sub};grid-row:2">${esc(slot.displayLabel)}</div>`).join('');
    }).join('');
  }
  function renderScore(tab) {
    const rows = rowsFor(tab); const withHands = rows.length === 2;
    state.selected.measure = Math.min(state.selected.measure, tab.measures.length - 1);
    state.selected.slot = Math.min(state.selected.slot, C.slots(tab, state.selected.measure).length - 1);
    if (!rows.includes(state.selected.row)) state.selected.row = rows[0];
    $('measure-count').textContent = `${tab.measures.length} такт.`;
    $('score').innerHTML = tab.measures.map((measure, m) => {
      const slots = C.slots(tab, m);
      const columns = (withHands ? '35px ' : '') + slots.map(slot => `${Number(slot.duration.toFixed(8))}fr`).join(' ');
      const minDuration = Math.min(...slots.map(slot => slot.duration));
      const minWidth = Math.ceil(slots.reduce((sum, slot) => sum + slot.duration / minDuration * 34, 0)) + (withHands ? 35 : 0);
      return `<article class="measure-card ${state.rhythmScope === 'measure' && state.selected.measure === m ? 'current-measure' : ''}" data-measure="${m}"><div class="measure-header"><span class="measure-number">${String(m + 1).padStart(2, '0')}</span><input class="measure-label" data-measure-label="${m}" value="${esc(measure.label)}" aria-label="Название такта ${m + 1}" placeholder="Добавить пометку…" maxlength="200"><button class="measure-rhythm-button ${measure.beats ? 'custom-rhythm' : ''}" data-edit-rhythm="${m}" title="Настроить деление долей только в этом такте">Ритм такта</button><div class="measure-actions"><button data-duplicate="${m}" title="Дублировать такт" aria-label="Дублировать такт ${m + 1}">⧉</button><button data-remove="${m}" title="Удалить такт" aria-label="Удалить такт ${m + 1}">×</button>${measureMenu(m, tab.measures.length)}</div></div><div class="grid-scroll"><div class="measure-grid ${tab.notation === 'hybrid' ? 'hybrid-grid' : ''}" style="--columns:${columns};--grid-min:${minWidth}px">${countHeader(tab, m, slots, withHands)}${rows.map((row, r) => `${withHands ? `<div class="hand-label" ${tab.notation === 'hybrid' ? `style="grid-column:1;grid-row:${r + 3}"` : ''}>${row}</div>` : ''}${measure.rows[row].map((cell, s) => `<button class="note-cell ${!cell.length ? 'rest' : ''} ${slots[s].groupStart ? 'group-start' : ''} ${state.selected.measure === m && state.selected.row === row && state.selected.slot === s ? 'selected' : ''}" ${tab.notation === 'hybrid' ? `style="grid-column:${s + (withHands ? 2 : 1)};grid-row:${r + 3}"` : ''} data-cell="${m},${row},${s}" tabindex="${state.selected.measure === m && state.selected.row === row && state.selected.slot === s ? 0 : -1}" aria-label="Такт ${m + 1}, ${row === 'main' ? '' : row + ', '}позиция ${s + 1}: ${esc(C.tokenText(cell))}">${chordMarkup(cell)}</button>`).join('')}`).join('')}</div></div></article>`;
    }).join('');
    if (tab.phraseExample) {
      $('score').insertAdjacentHTML('beforeend', `<article class="measure-card phrase-example"><div class="measure-header"><span class="measure-number">Фразировка из оригинала · отдельный пример</span></div><div class="grid-scroll"><div class="measure-grid" style="--columns:repeat(${tab.phraseExample.labels.length},1fr);--grid-min:${tab.phraseExample.labels.length * 34}px">${tab.phraseExample.labels.map(label => `<div class="count-cell">${esc(label)}</div>`).join('')}${tab.phraseExample.notes.map(cell => `<div class="note-cell ${cell.length ? '' : 'rest'}">${chordMarkup(cell)}</div>`).join('')}</div></div></article>`);
    }
    $('add-measure').disabled = tab.measures.length >= 512;
    updateSelectionContext();
  }
  function render() {
    const tab = current(); if (!tab) return;
    renderLibrary();
    $('tab-title').value = tab.title; $('tab-subtitle').value = tab.subtitle; $('tab-notes').value = tab.notes; $('tempo').value = tab.tempo;
    $('breadcrumb-title').textContent = tab.title || 'Без названия';
    const meter = formatMeter(tab); $('meter-preset').value = [...$('meter-preset').options].some(option => option.value === meter) ? meter : 'custom';
    $('hands').value = tab.hands;
    document.querySelectorAll('[data-notation]').forEach(button => { button.classList.toggle('active', button.dataset.notation === tab.notation); button.setAttribute('aria-pressed', button.dataset.notation === tab.notation); });
    renderBeats(tab); renderScore(tab); updateUndo(); showSaveStatus();
    document.querySelector('.editor-content').classList.toggle('preview', state.preview);
  }
  function measureMenu(index, count) {
    return `<details class="measure-menu"><summary title="Действия с тактом" aria-label="Действия с тактом ${index + 1}">⋯</summary><div class="measure-menu-items"><button data-insert="${index}" ${count >= 512 ? 'disabled' : ''}>Вставить пустой после</button><button data-move-up="${index}" ${index === 0 ? 'disabled' : ''}>Переместить выше</button><button data-move-down="${index}" ${index === count - 1 ? 'disabled' : ''}>Переместить ниже</button><button data-clear="${index}">Очистить удары</button></div></details>`;
  }
  function updateSelectionContext() {
    const tab = current(), { measure, row, slot } = state.selected;
    if (!tab || !tab.measures[measure]) return;
    const position = C.slots(tab, measure)[slot]; if (!position) return;
    const beat = C.measureBeats(tab, measure)[position.beat], cell = tab.measures[measure].rows[row][slot];
    $('selection-context').textContent = `Такт ${measure + 1} · доля ${beat.label}${beat.division > 1 ? ' · ' + position.displayLabel : ''}${row === 'main' ? '' : ' · ' + row} · ${cell.length ? C.tokenText(cell) : 'пауза'}`;
    document.querySelectorAll('[data-note]').forEach(button => { const active = button.dataset.note === '—' ? !cell.length : cell.includes(button.dataset.note); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    document.querySelectorAll('[data-count-slot], [data-beat-number]').forEach(label => {
      const card = label.closest('[data-measure]');
      label.classList.toggle('selected-count', Number(card?.dataset.measure) === measure && (label.hasAttribute('data-count-slot') ? Number(label.dataset.countSlot) === slot : Number(label.dataset.beatNumber) === position.beat));
    });
    if (!state.playing) $('playback-status').textContent = $('playback-range').value === 'measure' ? `Такт ${measure + 1} · ${formatMeter(tab)}` : `${tab.measures.length} такт. · ${formatMeter(tab)}`;
  }
  function selectCell(selection, focus = false) {
    const previousMeasure = state.selected.measure;
    state.selected = selection;
    document.querySelectorAll('[data-cell]').forEach(cell => { const selected = cell.dataset.cell === `${selection.measure},${selection.row},${selection.slot}`; cell.classList.toggle('selected', selected); cell.tabIndex = selected ? 0 : -1; if (selected && focus) cell.focus({ preventScroll: false }); });
    document.querySelectorAll('[data-measure]').forEach(card => card.classList.toggle('current-measure', state.rhythmScope === 'measure' && Number(card.dataset.measure) === selection.measure));
    if (previousMeasure !== selection.measure) renderBeats(current());
    updateSelectionContext();
  }
  function moveSelection(delta, rowDelta = 0) {
    const tab = current(), counts = tab.measures.map((measure, index) => C.slots(tab, index).length), rows = rowsFor(tab);
    let index = counts.slice(0, state.selected.measure).reduce((sum, count) => sum + count, 0) + state.selected.slot + delta;
    index = Math.max(0, Math.min(index, counts.reduce((sum, count) => sum + count, 0) - 1));
    let measure = 0;
    while (index >= counts[measure]) { index -= counts[measure]; measure++; }
    let rowIndex = rows.indexOf(state.selected.row) + rowDelta;
    if (rowIndex < 0 || rowIndex >= rows.length) {
      const targetMeasure = state.selected.measure + (rowIndex < 0 ? -1 : 1);
      if (targetMeasure < 0 || targetMeasure >= tab.measures.length) return;
      const offset = C.slots(tab, state.selected.measure)[state.selected.slot].offset;
      const slots = C.slots(tab, targetMeasure);
      const targetSlot = slots.reduce((best, candidate, i) => Math.abs(candidate.offset - offset) < Math.abs(slots[best].offset - offset) ? i : best, 0);
      selectCell({ measure: targetMeasure, row: rows[rowIndex < 0 ? rows.length - 1 : 0], slot: targetSlot }, true); return;
    }
    const row = rows[rowIndex];
    selectCell({ measure, row, slot: index }, true);
  }
  function moveMeasure(delta) {
    const tab = current(), oldSlot = C.slots(tab, state.selected.measure)[state.selected.slot];
    const measure = Math.max(0, Math.min(tab.measures.length - 1, state.selected.measure + delta));
    const slots = C.slots(tab, measure);
    const slot = slots.reduce((best, candidate, index) => Math.abs(candidate.offset - oldSlot.offset) < Math.abs(slots[best].offset - oldSlot.offset) ? index : best, 0);
    selectCell({ measure, row: state.selected.row, slot }, true);
  }
  function chooseRhythmMeasure(index) {
    state.rhythmScope = 'measure';
    const slot = Math.min(state.selected.slot, C.slots(current(), index).length - 1);
    selectCell({ measure: index, row: state.selected.row, slot });
    renderBeats(current());
  }
  function setCell(value, advance = state.autoAdvance) {
    try {
      const cell = C.parseToken(value); const selected = { ...state.selected };
      commit(tab => { tab.measures[selected.measure].rows[selected.row][selected.slot] = cell; });
      if (advance) moveSelection(1); else selectCell(state.selected, true);
    } catch (error) { toast(error.message, true); }
  }
  function editCell() {
    if (state.preview) return;
    const { measure, row, slot } = state.selected;
    $('cell-location').textContent = `Такт ${measure + 1} · позиция ${slot + 1}${row === 'main' ? '' : ' · ' + row}`;
    $('cell-value').value = C.tokenText(current().measures[measure].rows[row][slot]).replace(/^-$/, '');
    $('cell-dialog').showModal(); $('cell-value').focus(); $('cell-value').select();
  }
  function confirmAction(title, message, yesText = 'Продолжить') {
    return new Promise(resolve => {
      const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-text').textContent = message; $('confirm-yes').textContent = yesText;
      function finish(value) { dialog.close(); $('confirm-yes').onclick = null; $('confirm-no').onclick = null; dialog.oncancel = null; resolve(value); }
      $('confirm-yes').onclick = () => finish(true); $('confirm-no').onclick = () => finish(false); dialog.oncancel = event => { event.preventDefault(); finish(false); }; dialog.showModal();
    });
  }
  async function applyRhythmChange(changed, before) {
    if (changed.lost && !await confirmAction('Изменить сетку?', `${changed.lost} ячеек с ударами не попадают в новую сетку и будут удалены. Изменение можно отменить.`, 'Изменить')) { render(); return; }
    if (JSON.stringify(current()) !== before) { render(); return; }
    const offset = C.slots(current(), state.selected.measure)[state.selected.slot]?.offset;
    const nextSlots = C.slots(changed.tab, state.selected.measure);
    const index = nextSlots.findIndex(slot => Math.abs(slot.offset - offset) < 1e-9);
    if (index >= 0) state.selected.slot = index;
    commit(() => changed.tab);
  }
  async function changeRhythm(meter, beats) {
    try {
      const before = JSON.stringify(current()); const changed = C.setRhythm(current(), meter, beats);
      await applyRhythmChange(changed, before);
    } catch (error) { toast(error.message, true); render(); }
  }
  async function changeBeats(mutator) {
    try {
      const tab = current(), before = JSON.stringify(tab);
      if (state.rhythmScope === 'all' && tab.measures.some((measure, index) => JSON.stringify(C.measureBeats(tab, index).map(beat => beat.units)) !== JSON.stringify(tab.beats.map(beat => beat.units)))) {
        throw new Error('В тактах разная группировка долей. Для этой записи изменяйте деление в режиме «Этот такт».');
      }
      const indices = state.rhythmScope === 'all' ? tab.measures.map((measure, index) => index) : [state.selected.measure];
      let next = C.clone(tab), lost = 0;
      for (const index of indices) {
        const beats = C.clone(C.measureBeats(next, index)); mutator(beats);
        const changed = C.setMeasureRhythm(next, index, beats); next = changed.tab; lost += changed.lost;
      }
      if (state.rhythmScope === 'all') {
        const defaults = C.clone(next.beats); mutator(defaults); next.beats = defaults;
        for (const measure of next.measures) if (measure.beats && JSON.stringify(measure.beats) === JSON.stringify(defaults)) delete measure.beats;
      }
      await applyRhythmChange({ tab: C.validateTab(next), lost }, before);
    } catch (error) { toast(error.message, true); render(); }
  }
  function undo(redo = false) {
    const source = redo ? state.redo : state.undo; if (!source.length) return;
    const selectedId = current().measures[state.selected.measure]?.id;
    stopPlayback(); (redo ? state.undo : state.redo).push(C.clone(current()));
    state.tabs[state.tabs.findIndex(tab => tab.id === state.current)] = source.pop();
    const selectedIndex = current().measures.findIndex(measure => measure.id === selectedId);
    state.selected.measure = selectedIndex >= 0 ? selectedIndex : Math.min(state.selected.measure, current().measures.length - 1);
    historyKey = ''; state.pending.add(state.current); queueSave(); render();
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function loadFolder() {
    stopPlayback();
    folderRecords.clear();
    const entries = await directory.read(), diskTabs = new Map();
    let invalid = 0;
    for (const { file, handle } of entries.sort((a, b) => a.file.name.localeCompare(b.file.name))) {
      try {
        if (file.size > 2000000) throw new Error('Слишком большой файл.');
        const tab = C.validateTab(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
        if (state.deleted.has(tab.id)) continue;
        // Prefer the canonical ID filename if an older named export also exists.
        if (diskTabs.has(tab.id) && file.name !== tab.id + '.json') continue;
        diskTabs.set(tab.id, tab);
        folderRecords.set(tab.id, { name: file.name, snapshot: JSON.stringify(tab, null, 2) + '\n' });
        files.attach(tab, handle);
      } catch { invalid++; }
    }
    if (diskTabs.size) {
      const previousTabs = state.tabs, previous = current();
      for (const tab of state.tabs) if (state.pending.has(tab.id)) diskTabs.set(tab.id, tab);
      state.tabs = [...diskTabs.values()];
      for (const tab of previousTabs) if (!diskTabs.has(tab.id)) files.forget(tab.id);
      if (!state.tabs.some(tab => tab.id === state.current)) {
        state.current = state.tabs[0].id;
        state.selected = { measure: 0, row: current().hands === 'split' ? 'R' : 'main', slot: 0 };
      }
      if (JSON.stringify(previous) !== JSON.stringify(current())) { state.undo = []; state.redo = []; historyKey = ''; }
    }
    persistCache(); render();
    if (invalid) toast(`Не удалось прочитать JSON-файлов: ${invalid}. Остальные табулатуры загружены.`, true);
    return diskTabs.size;
  }
  async function connectFolder(change = false) {
    if (state.mode !== 'browser' || savingTabId !== null || folderLoading) return;
    stopPlayback(); folderLoading = true; showSaveStatus();
    try {
      const connected = await (change ? directory.choose() : directory.connect());
      if (!connected) return;
      fileSaveError = null;
      const count = await loadFolder();
      toast(count ? `Папка ${connected.name}: табулатуры загружены.` : `Папка ${connected.name} подключена. Сохраняйте табулатуры кнопкой «Сохранить изменения».`);
    } catch (error) {
      toast('Не удалось открыть папку. ' + (error.message || 'Попробуйте снова.'), true);
    } finally { folderLoading = false; showSaveStatus(); }
  }
  async function saveChanges(copy = false) {
    if (savingTabId !== null || folderLoading || !current()) return;
    const active = document.activeElement;
    if (active?.matches('#tempo, [data-measure-label], [data-label-beat]')) active.blur();
    const tab = C.clone(current());
    savingTabId = tab.id; fileSaveError = null;
    persistCache(); showSaveStatus();
    try {
      if (state.mode === 'server' && !copy) {
        clearTimeout(saveTimer); await flushSaves();
        if (!state.pending.size && !state.deleted.size) toast('Изменения записаны в папку tabs.');
      } else if (!copy && directory.available()) {
        if (directory.info()?.permission !== 'granted') {
          // Keep the document being saved when the chosen folder is first read.
          state.pending.add(tab.id); persistCache();
          const connected = await directory.connect();
          if (!connected) return;
          await loadFolder();
        }
        const result = await directory.save(tab);
        const live = state.tabs.find(item => item.id === tab.id);
        if (live) {
          folderRecords.set(tab.id, { name: result.name, snapshot: result.snapshot });
          files.attach(tab, result.handle);
          if (JSON.stringify(live, null, 2) + '\n' === result.snapshot) state.pending.delete(tab.id);
          persistCache();
        }
        toast(`Сохранено в ${result.folder}: ${tab.title || 'Без названия'}`);
      } else {
        const result = await files.save(tab, { copy });
        if (result.kind === 'file') toast(`Сохранено: ${result.name}`);
        else if (result.kind === 'download') toast(`JSON передан в загрузки: ${result.name}`);
      }
    } catch (error) {
      fileSaveError = tab.id;
      toast('Не удалось сохранить файл. ' + (error.message || 'Попробуйте снова или скачайте копию JSON.'), true);
    } finally {
      savingTabId = null; showSaveStatus();
    }
  }
  async function openFile() {
    if (openingFile) return;
    if (state.mode !== 'browser' || !files.canOpen()) { $('import-file').click(); return; }
    openingFile = true; $('import-tab').disabled = true;
    try {
      const opened = await files.open();
      if (opened) await importFile(opened.file, opened.handle);
    } catch (error) {
      if (['SecurityError', 'NotSupportedError'].includes(error.name)) $('import-file').click();
      else toast('Не удалось открыть файл. ' + (error.message || 'Попробуйте снова.'), true);
    } finally { openingFile = false; $('import-tab').disabled = false; }
  }
  async function importFile(file, handle = null) {
    if (!file) return;
    try {
      if (file.size > 2000000) throw new Error('Выберите файл размером до 2 МБ.');
      const text = (await file.text()).replace(/^\uFEFF/, '');
      const json = file.name.toLowerCase().endsWith('.json');
      if (json && handle) {
        const existingId = await files.find(handle);
        if (existingId && state.tabs.some(tab => tab.id === existingId)) {
          switchTab(existingId); toast('Этот файл уже открыт в библиотеке.');
          $('import-file').value = ''; return;
        }
      }
      const tab = json ? C.validateTab(JSON.parse(text)) : C.importText(text, file.name.replace(/\.[^.]+$/, ''));
      tab.id = C.uid();
      if (json && handle) files.attach(tab, handle);
      addTab(tab); toast(json && handle ? `Открыт файл: ${file.name}` : 'Табулатура открыта как новая копия.');
    } catch (error) { toast(error.message || 'Не удалось прочитать файл.', true); }
    $('import-file').value = '';
  }
  function stopPlayback() { player?.stop(); }
  function playbackState(playing) {
    state.playing = playing;
    for (const id of ['play', 'transport-play']) {
      const button = $(id); button.textContent = playing ? '■' : '▶';
      button.classList.toggle('playing', playing); button.setAttribute('aria-pressed', String(playing));
      button.setAttribute('aria-label', playing ? 'Остановить прослушивание' : 'Прослушать ритм');
    }
    document.querySelector('.playback-bar').classList.toggle('is-playing', playing);
    if (!playing) updateSelectionContext();
  }
  function playbackPosition(position) {
    document.querySelectorAll('.playhead, .playing-measure').forEach(element => element.classList.remove('playhead', 'playing-measure'));
    if (!position) return;
    const tab = current(), { measure, slot } = position;
    const card = document.querySelector(`[data-measure="${measure}"]`);
    card?.classList.add('playing-measure');
    rowsFor(tab).forEach(row => document.querySelector(`[data-cell="${measure},${row},${slot}"]`)?.classList.add('playhead'));
    const count = C.slots(tab, measure)[slot];
    $('playback-status').textContent = `Играет · такт ${measure + 1} · доля ${C.measureBeats(tab, measure)[count.beat].label}`;
    const cell = card?.querySelector('.playhead');
    if (cell) {
      const scroll = card.querySelector('.grid-scroll'), box = cell.getBoundingClientRect(), view = scroll.getBoundingClientRect();
      if (box.left < view.left || box.right > view.right) scroll.scrollLeft += box.left - view.left - view.width / 2 + box.width / 2;
      const barBottom = document.querySelector('.playback-bar').getBoundingClientRect().bottom;
      if (box.bottom > innerHeight - 20 || box.top < barBottom) cell.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }
  }
  async function togglePlayback() {
    if (player.playing || player.starting) { stopPlayback(); return; }
    const promise = player.play(current(), { measure: $('playback-range').value === 'measure' ? state.selected.measure : null, loop: $('playback-loop').checked, metronome: $('playback-metronome').checked });
    if (player.starting) {
      for (const id of ['play', 'transport-play']) { $(id).textContent = '…'; $(id).setAttribute('aria-label', 'Отменить запуск прослушивания'); }
      $('playback-status').textContent = 'Запускаю прослушивание…';
    }
    await promise;
  }
  function bind() {
    player = window.HangPlayback.create({ onState: playbackState, onPosition: playbackPosition, onProgress: progress => document.querySelector('.playback-bar').style.setProperty('--progress', `${progress * 100}%`), onError: message => toast(message, true) });
    try { state.autoAdvance = localStorage.getItem('quiet-rhythm-auto-advance') !== 'false'; } catch { /* Entry preferences are optional. */ }
    $('auto-advance').checked = state.autoAdvance;
    $('auto-advance').onchange = () => { state.autoAdvance = $('auto-advance').checked; try { localStorage.setItem('quiet-rhythm-auto-advance', String(state.autoAdvance)); } catch { /* Editing still works without preference storage. */ } };
    for (const id of ['playback-range', 'playback-loop', 'playback-metronome']) $(id).onchange = () => { stopPlayback(); updateSelectionContext(); };
    $('library').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) switchTab(button.dataset.tab); };
    $('search').oninput = renderLibrary;
    $('new-tab').onclick = () => { addTab(C.createTab()); $('tab-title').focus(); $('tab-title').select(); };
    for (const [id, field] of [['tab-title', 'title'], ['tab-subtitle', 'subtitle'], ['tab-notes', 'notes']]) $(id).oninput = () => commit(tab => { tab[field] = $(id).value; }, { render: false, key: field });
    $('tempo').onchange = () => { const value = Number($('tempo').value); if (!Number.isInteger(value) || value < 20 || value > 400) { toast('Темп: целое число от 20 до 400 BPM.', true); $('tempo').value = current().tempo; return; } commit(tab => { tab.tempo = value; }); };
    $('meter-preset').onchange = async () => {
      let value = $('meter-preset').value;
      if (value === 'custom') { value = window.prompt('Размер такта, например 5/8 или 11/4', formatMeter(current())); if (!value) { render(); return; } }
      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
      if (!match) { toast('Введите размер как 7/4.', true); render(); return; }
      const meter = { numerator: Number(match[1]), denominator: Number(match[2]) };
      try { await changeRhythm(meter, C.makeBeats(meter)); } catch (error) { toast(error.message, true); render(); }
    };
    $('notation-control').onclick = event => { const button = event.target.closest('[data-notation]'); if (button) commit(tab => { tab.notation = button.dataset.notation; }); };
    $('hands').onchange = () => { try { commit(tab => C.setHands(tab, $('hands').value)); } catch (error) { toast(error.message, true); render(); } };
    $('rhythm-scope').onchange = () => { state.rhythmScope = $('rhythm-scope').value; renderBeats(current()); selectCell(state.selected); };
    $('rhythm-measure').onchange = () => chooseRhythmMeasure(Number($('rhythm-measure').value));
    $('all-division').onchange = () => { const value = Number($('all-division').value); if (!value) return; $('all-division').value = ''; changeBeats(beats => { beats.forEach(beat => { beat.division = value; beat.syllables = []; }); }); };
    $('beat-controls').onchange = event => {
      if (event.target.matches('[data-beat]')) { const index = Number(event.target.dataset.beat), value = Number(event.target.value); if (value) changeBeats(beats => { beats[index].division = value; beats[index].syllables = []; }); }
      if (event.target.matches('[data-label-beat]')) {
        const i = Number(event.target.dataset.labelBeat), value = event.target.value.trim();
        const displayedBeat = (state.rhythmScope === 'measure' ? C.measureBeats(current(), state.selected.measure) : current().beats)[i];
        const usesSyllables = current().notation === 'konnakol' || (current().notation === 'hybrid' && displayedBeat.division > 1);
        if (!usesSyllables) changeBeats(beats => { beats[i].label = value || String(i + 1); });
        else { const words = value ? value.split(/\s+/) : []; if (words.some(word => word.length > 32)) { toast('Каждый слог должен быть короче 33 символов.', true); render(); return; } changeBeats(beats => { if (words.length && words.length !== beats[i].division) throw new Error('Число слогов должно совпадать с числом частей доли во всех выбранных тактах.'); beats[i].syllables = words; }); }
      }
    };
    $('phrase-preset').onchange = () => {
      const patterns = { beats: '', '3+3+2': 'Ta Ki Ta | Ta Ki Ta | Ta Ka', '4+4': 'Ta Ka Di Mi | Ta Ka Jo Nu', '3+4': 'Ta Ki Ta | Ta Ka Di Mi' };
      if ($('phrase-preset').value !== 'custom') $('phrase-input').value = patterns[$('phrase-preset').value];
    };
    $('apply-phrase').onclick = () => {
      const text = $('phrase-input').value.trim();
      const phrases = text ? text.split('|').map(part => { const syllables = part.trim().split(/\s+/).filter(Boolean); return { size: syllables.length, syllables }; }) : [];
      try { const tab = C.clone(current()); tab.phrases = phrases; C.validateTab(tab); commit(() => tab); } catch (error) { toast(error.message, true); }
    };
    $('score').onclick = async event => {
      if (state.preview) return;
      const menu = event.target.closest('.measure-menu');
      document.querySelectorAll('.measure-menu[open]').forEach(other => { if (other !== menu) other.open = false; });
      const action = event.target.closest('[data-insert], [data-move-up], [data-move-down], [data-clear]');
      if (action && !action.disabled) {
        menu.open = false;
        const index = Number(action.dataset.insert ?? action.dataset.moveUp ?? action.dataset.moveDown ?? action.dataset.clear);
        if (action.hasAttribute('data-insert')) {
          if (current().measures.length >= 512) return;
          commit(tab => { const measure = C.clone(tab.measures[index]); measure.id = C.uid(); measure.label = ''; for (const row of Object.keys(measure.rows)) measure.rows[row] = measure.rows[row].map(() => []); tab.measures.splice(index + 1, 0, measure); });
          selectCell({ measure: index + 1, row: state.selected.row, slot: 0 }, true);
        } else if (action.hasAttribute('data-clear')) {
          const tabId = current().id, measureId = current().measures[index].id;
          const hasNotes = Object.values(current().measures[index].rows).some(row => row.some(cell => cell.length));
          if (!hasNotes) { toast('В этом такте уже нет ударов.'); return; }
          stopPlayback();
          if (await confirmAction('Очистить такт?', `Удары такта ${index + 1} будут удалены. Ритм и пометка сохранятся. Можно отменить через Ctrl+Z.`, 'Очистить') && current().id === tabId && current().measures[index]?.id === measureId) commit(tab => { for (const row of Object.keys(tab.measures[index].rows)) tab.measures[index].rows[row] = tab.measures[index].rows[row].map(() => []); });
        } else {
          const destination = index + (action.hasAttribute('data-move-up') ? -1 : 1);
          if (destination < 0 || destination >= current().measures.length) return;
          commit(tab => { const [measure] = tab.measures.splice(index, 1); tab.measures.splice(destination, 0, measure); });
        }
        return;
      }
      const rhythmButton = event.target.closest('[data-edit-rhythm]');
      if (rhythmButton) { chooseRhythmMeasure(Number(rhythmButton.dataset.editRhythm)); document.querySelector('.rhythm-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const cell = event.target.closest('[data-cell]');
      if (cell && !state.preview) { const [m, row, s] = cell.dataset.cell.split(','); selectCell({ measure: Number(m), row, slot: Number(s) }); }
      const duplicate = event.target.closest('[data-duplicate]');
      if (duplicate) { if (current().measures.length >= 512) { toast('Максимум 512 тактов.', true); return; } const index = Number(duplicate.dataset.duplicate); commit(tab => { const measure = C.clone(tab.measures[index]); measure.id = C.uid(); tab.measures.splice(index + 1, 0, measure); }); }
      const remove = event.target.closest('[data-remove]');
      if (remove) { if (current().measures.length === 1) { toast('Оставьте хотя бы один такт.'); return; } const index = Number(remove.dataset.remove), tabId = current().id, measureId = current().measures[index].id; stopPlayback(); if (await confirmAction('Удалить такт?', `Такт ${index + 1} будет удалён. Действие можно отменить.`, 'Удалить') && current().id === tabId && current().measures[index]?.id === measureId) commit(tab => { tab.measures.splice(index, 1); }); }
    };
    $('score').ondblclick = event => { if (event.target.closest('[data-cell]')) editCell(); };
    $('score').onchange = event => { if (event.target.matches('[data-measure-label]')) { const index = Number(event.target.dataset.measureLabel), value = event.target.value; commit(tab => { tab.measures[index].label = value; }, { render: false }); } };
    $('note-palette').innerHTML = ['D', 'S', 'K', ...Array.from({ length: 12 }, (_, index) => String(index + 1)), '—'].map(note => `<button data-note="${note}" title="Вставить ${note}" aria-label="Вставить ${note}" aria-pressed="false">${note}</button>`).join('') + '<button class="chord-button" data-chord>Аккорд</button>';
    $('note-palette').onclick = event => { if (state.preview) return; const button = event.target.closest('button'); if (!button) return; if (button.hasAttribute('data-chord')) editCell(); else setCell(button.dataset.note); };
    $('cell-form').onsubmit = event => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { C.parseToken($('cell-value').value); $('cell-dialog').close(); setCell($('cell-value').value); } catch (error) { toast(error.message, true); } };
    $('add-measure').onclick = () => { commit(tab => { if (tab.measures.length < 512) tab.measures.push(C.emptyMeasure(tab)); }); };
    $('undo').onclick = () => undo(); $('redo').onclick = () => undo(true);
    $('import-tab').onclick = openFile; $('import-file').onchange = () => importFile($('import-file').files[0]);
    $('choose-folder').onclick = () => connectFolder();
    $('change-folder').onclick = () => connectFolder(true);
    $('save-changes').onclick = () => saveChanges();
    $('save-json').onclick = () => saveChanges(true);
    $('export-png').onclick = async () => {
      const button = $('export-png'); button.disabled = true; button.textContent = 'Готовлю PNG…';
      try { const pages = await window.HangExport.renderPNG(C.clone(current())); for (const page of pages) download(page.blob, page.name); toast(pages.length > 1 ? `Готово: ${pages.length} страниц PNG. Разрешите несколько загрузок, если браузер спросит.` : 'Табулатура сохранена в PNG.'); }
      catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '↗ Экспорт PNG'; }
    };
    $('toggle-preview').onclick = () => { stopPlayback(); state.preview = !state.preview; document.querySelector('.editor-content').classList.toggle('preview', state.preview); $('toggle-preview').textContent = state.preview ? '✎ Вернуться к записи' : '◫ Вид для печати'; $('toggle-preview').setAttribute('aria-pressed', String(state.preview)); };
    $('duplicate-tab').onclick = () => { const tab = C.clone(current()); tab.id = C.uid(); tab.title = `${tab.title || 'Без названия'} · копия`.slice(0, 160); tab.measures.forEach(measure => { measure.id = C.uid(); }); addTab(tab); toast('Создана отдельная копия табулатуры.'); };
    $('rhythm-help').onclick = () => $('info-dialog').showModal(); $('close-info').onclick = () => $('info-dialog').close();
    $('delete-tab').onclick = async () => {
      const tab = current(); stopPlayback();
      if (!await confirmAction('Удалить табулатуру?', `«${tab.title || 'Без названия'}» будет удалена из библиотеки${state.mode === 'server' ? ' и папки tabs' : ''}. Скачайте JSON, если нужна копия.`, 'Удалить')) return;
      state.tabs = state.tabs.filter(item => item.id !== tab.id); state.pending.delete(tab.id); state.deleted.add(tab.id);
      files.forget(tab.id);
      folderRecords.delete(tab.id);
      if (!state.tabs.length) { const blank = C.createTab(); state.tabs.push(blank); state.pending.add(blank.id); }
      if (state.current === tab.id) switchTab(state.tabs[0].id); else render();
      queueSave();
    };
    $('play').onclick = togglePlayback;
    $('transport-play').onclick = togglePlayback;
    document.addEventListener('click', event => { if (!event.target.closest('.measure-menu')) document.querySelectorAll('.measure-menu[open]').forEach(menu => { menu.open = false; }); });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyS' || event.key.toLowerCase() === 's') && !document.querySelector('dialog[open]')) {
        event.preventDefault(); if (!event.repeat) saveChanges(); return;
      }
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { stopPlayback(); document.querySelectorAll('.measure-menu[open]').forEach(menu => { menu.open = false; }); return; }
      if (event.target.closest('input,textarea,select,dialog') || document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyZ' || event.key.toLowerCase() === 'z')) { event.preventDefault(); undo(event.shiftKey); return; }
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyY' || event.key.toLowerCase() === 'y')) { event.preventDefault(); undo(true); return; }
      if (event.target.closest('button,summary') && !event.target.closest('[data-cell]')) return;
      if (event.key === ' ') { event.preventDefault(); if (!event.repeat) togglePlayback(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey || state.preview) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(event.key === 'ArrowRight' ? 1 : -1); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (current().hands === 'split') moveSelection(0, event.key === 'ArrowDown' ? 1 : -1); else moveMeasure(event.key === 'ArrowDown' ? 1 : -1); }
      else if (event.key === 'Enter') { event.preventDefault(); editCell(); }
      else {
        const physicalNote = { KeyD: 'D', KeyS: 'S', KeyK: 'K' }[event.code];
        if (physicalNote || /^[dsk1-9-]$/i.test(event.key) || event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); const deleting = event.key === 'Delete' || event.key === 'Backspace'; setCell(deleting ? '-' : physicalNote || event.key.toUpperCase(), deleting ? false : state.autoAdvance); }
      }
    });
    window.addEventListener('beforeunload', () => { persistCache(); });
    window.addEventListener('pagehide', () => { if (state.mode === 'server') for (const id of state.pending) { const tab = state.tabs.find(item => item.id === id); if (tab) navigator.sendBeacon('/api/tabs', new Blob([JSON.stringify(tab)], { type: 'application/json' })); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
  }
  async function init() {
    let cached;
    try { const raw = localStorage.getItem(KEY); if (raw) cached = JSON.parse(raw); } catch { /* Invalid or unavailable browser cache: load from disk or examples. */ }
    if (cached) {
      for (const input of Array.isArray(cached.tabs) ? cached.tabs : []) { try { state.tabs.push(C.validateTab(input)); } catch { /* Retain other valid documents. */ } }
      state.pending = new Set((Array.isArray(cached.pending) ? cached.pending : []).filter(id => state.tabs.some(tab => tab.id === id)));
      state.deleted = new Set((Array.isArray(cached.deleted) ? cached.deleted : []).filter(id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)));
      state.current = cached.current;
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const response = await fetch('/api/tabs', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('API unavailable'); const data = await response.json();
        if (!Array.isArray(data.tabs)) throw new Error('API unavailable');
        const diskTabs = []; let invalid = 0;
        for (const input of data.tabs) { try { const tab = C.validateTab(input); if (!state.deleted.has(tab.id)) diskTabs.push(tab); } catch { invalid++; } }
        for (const tab of state.tabs) if (state.pending.has(tab.id)) { const index = diskTabs.findIndex(item => item.id === tab.id); if (index >= 0) diskTabs[index] = tab; else diskTabs.push(tab); }
        state.tabs = diskTabs; state.mode = 'server'; if (invalid) toast(`Не удалось открыть файлов: ${invalid}. Проверьте их формат.`, true);
      } catch { if (!state.tabs.length) state.tabs = window.HangSamples.map(C.clone); }
    } else if (!state.tabs.length) state.tabs = window.HangSamples.map(C.clone);
    if (!state.tabs.length) { const tab = C.createTab(); state.tabs.push(tab); state.pending.add(tab.id); }
    state.current = state.tabs.some(tab => tab.id === state.current) ? state.current : state.tabs[0].id;
    state.selected.row = current().hands === 'split' ? 'R' : 'main';
    if (state.mode === 'browser' && directory.available()) await directory.restore();
    bind(); render(); persistCache();
    if (state.mode === 'server') await flushSaves();
    else if (directory.info()?.permission === 'granted') {
      folderLoading = true; showSaveStatus();
      try { await loadFolder(); } catch (error) { toast('Не удалось прочитать папку. ' + error.message, true); }
      finally { folderLoading = false; showSaveStatus(); }
    }
  }
  window.HangApp = { getTab: () => C.clone(current()), getFileStatus: () => fileStatus(), getDirectoryStatus: () => directory.info(), connectFolder, saveChanges, flushSaves, importFile, selectCell };
  init().catch(error => { console.error(error); $('save-status').textContent = 'Ошибка запуска'; toast('Не удалось открыть редактор: ' + error.message, true); });
})();
