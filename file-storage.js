(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangFiles = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function filename(title) {
    let name = String(title || 'табулатура').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 100).trim().replace(/[. ]+$/g, '');
    if (!name) name = 'табулатура';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name + '.json';
  }
  function serialize(tab) { return JSON.stringify(tab, null, 2) + '\n'; }
  function tabId(tab) {
    if (!tab || typeof tab.id !== 'string' || !tab.id) throw new TypeError('У табулатуры должен быть ID.');
    return tab.id;
  }
  function create({ download, host = root } = {}) {
    if (typeof download !== 'function') throw new TypeError('Нужна функция загрузки JSON.');
    const records = new Map(), busy = new Map();
    const secure = () => host.isSecureContext !== false;
    const canOpen = () => secure() && typeof host.showOpenFilePicker === 'function';
    const jsonTypes = () => [{ description: 'Табулатура JSON', accept: { 'application/json': ['.json'] } }];

    async function open() {
      if (!canOpen()) return null;
      try {
        const handles = await host.showOpenFilePicker({ multiple: false, types: [{ description: 'Табулатуры JSON и TXT', accept: { 'application/json': ['.json'], 'text/plain': ['.txt'] } }] });
        if (!handles.length) return null;
        const handle = handles[0];
        return { file: await handle.getFile(), handle };
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
    }
    function attach(tab, handle) {
      const id = tabId(tab), snapshot = serialize(tab);
      if (!handle || typeof handle.createWritable !== 'function') throw new TypeError('Нужен файловый дескриптор JSON.');
      const operation = busy.get(id);
      if (operation) operation.invalidated = true;
      records.set(id, { handle, snapshot, kind: 'file', name: handle.name || filename(tab.title) });
    }
    function forget(id) {
      records.delete(id);
      const operation = busy.get(id);
      if (operation) operation.invalidated = true;
    }
    function status(tab) {
      const record = records.get(tabId(tab));
      return record ? { name: record.name, kind: record.kind, dirty: record.snapshot !== serialize(tab) } : null;
    }
    async function find(handle) {
      if (!handle) return null;
      for (const [id, record] of records) if (record.handle === handle) return id;
      for (const [id, record] of records) {
        if (!record.handle) continue;
        const matches = typeof handle.isSameEntry === 'function' ? await handle.isSameEntry(record.handle)
          : typeof record.handle.isSameEntry === 'function' ? await record.handle.isSameEntry(handle) : false;
        if (matches) return id;
      }
      return null;
    }
    async function sendDownload(snapshot, name) {
      const BlobClass = host.Blob || root.Blob;
      await download(new BlobClass([snapshot], { type: 'application/json;charset=utf-8' }), name);
      return { kind: 'download', name, snapshot };
    }
    async function ensureWritePermission(handle) {
      const hasQuery = typeof handle.queryPermission === 'function', hasRequest = typeof handle.requestPermission === 'function';
      if (!hasQuery && !hasRequest) return;
      const options = { mode: 'readwrite' };
      if (hasQuery && await handle.queryPermission(options) === 'granted') return;
      if (hasRequest && await handle.requestPermission(options) === 'granted') return;
      const error = new Error('Нет разрешения на запись в выбранный файл. Разрешите запись или скачайте копию JSON.');
      error.name = 'NotAllowedError';
      throw error;
    }
    async function save(tab, { copy = false } = {}) {
      // Capture everything before opening the picker: edits and tab switches may
      // happen while a file dialog or a disk write is pending.
      const id = tabId(tab), snapshot = serialize(tab), name = filename(tab.title);
      if (copy) return sendDownload(snapshot, name);
      if (busy.has(id)) {
        const error = new Error('Сохранение этой табулатуры уже выполняется.');
        error.name = 'InvalidStateError';
        throw error;
      }
      const operation = { invalidated: false }, previous = records.get(id);
      busy.set(id, operation);
      function remember(record) { if (!operation.invalidated) records.set(id, record); }
      async function fallback() {
        const result = await sendDownload(snapshot, name);
        remember({ ...result, handle: previous?.handle });
        return result;
      }
      try {
        let handle = previous?.handle;
        if (!handle && (!secure() || typeof host.showSaveFilePicker !== 'function')) return await fallback();
        let writable, stage = 'permission';
        try {
          if (!handle) {
            // This call must run before the first await to retain user activation.
            stage = 'picker';
            const selection = host.showSaveFilePicker({ suggestedName: name, types: jsonTypes() });
            handle = await selection;
          } else await ensureWritePermission(handle);
          stage = 'write';
          writable = await handle.createWritable();
          await writable.write(snapshot);
          stage = 'close';
          await writable.close();
          const result = { kind: 'file', name: handle.name || name, snapshot };
          remember({ ...result, handle });
          return result;
        } catch (error) {
          if (writable && typeof writable.abort === 'function') {
            try { await writable.abort(); } catch { /* Preserve the original failure. */ }
          }
          if (error?.name === 'AbortError' && (stage === 'picker' || stage === 'permission')) return { kind: 'cancelled', name: previous?.name || name, snapshot };
          if (stage === 'picker' && (error?.name === 'SecurityError' || error?.name === 'NotSupportedError')) return await fallback();
          throw error;
        }
      } finally {
        busy.delete(id);
      }
    }
    return { canOpen, open, save, attach, forget, status, find };
  }
  return { create };
});
