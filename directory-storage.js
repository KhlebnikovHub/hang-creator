(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangDirectory = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function failure(name, message) { return Object.assign(new Error(message), { name }); }
  function indexedStore(host) {
    let pending;
    function database() {
      if (pending) return pending;
      pending = new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { failed = true; reject(error); };
        if (!host.indexedDB) { reject(failure('NotSupportedError', 'Хранилище папки недоступно.')); return; }
        const request = host.indexedDB.open('hang-creator-folders-v1', 1);
        request.onupgradeneeded = () => {
          try { if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles'); }
          catch (error) { fail(error); }
        };
        request.onerror = () => fail(request.error || new Error('Не удалось открыть хранилище папки.'));
        request.onblocked = () => fail(new Error('Хранилище папки занято другой страницей.'));
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => { db.close(); pending = null; };
          resolve(db);
        };
      }).catch(error => { pending = null; throw error; });
      return pending;
    }
    async function transaction(mode, action) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('handles', mode), request = action(tx.objectStore('handles'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Не удалось сохранить выбор папки.'));
        request.onerror = () => reject(request.error || new Error('Хранилище папки недоступно.'));
      });
    }
    return { get: key => transaction('readonly', store => store.get(key)), set: (key, handle) => transaction('readwrite', store => store.put(handle, key)) };
  }

  function create({ host = root, remember } = {}) {
    const store = remember || indexedStore(host);
    const location = host.location || {};
    const scope = String(location.origin || '') + (location.pathname || String(location.href || '/').split(/[?#]/, 1)[0]);
    const key = 'directory:' + scope;
    let directory = null, permission = 'prompt', remembered = false, revision = 0;
    const busy = new Set();
    const available = () => host.isSecureContext !== false && typeof host.showDirectoryPicker === 'function';
    const info = () => directory ? { name: directory.name || 'Выбранная папка', permission, remembered } : null;
    function updatePermission(target, value) {
      if (directory === target) permission = ['granted', 'prompt', 'denied'].includes(value) ? value : 'prompt';
    }
    async function writePermission(target, requestFirst = false) {
      const options = { mode: 'readwrite' };
      const hasQuery = typeof target.queryPermission === 'function', hasRequest = typeof target.requestPermission === 'function';
      let result;
      try {
        // connect() starts this request directly in the original click handler.
        if (requestFirst && hasRequest) result = await target.requestPermission(options);
        else {
          result = hasQuery ? await target.queryPermission(options) : hasRequest ? 'prompt' : 'granted';
          if (result !== 'granted' && hasRequest) result = await target.requestPermission(options);
        }
        updatePermission(target, result);
        if (result !== 'granted') throw failure('NotAllowedError', 'Нет разрешения на запись в папку. Разрешите доступ или выберите другую папку.');
      } catch (error) {
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') updatePermission(target, 'denied');
        throw error;
      }
    }
    async function persist(target) {
      try { await store.set(key, target); if (directory === target) remembered = true; }
      catch { /* Keep working in memory when IndexedDB cannot store handles. */ }
    }
    async function restore() {
      const before = revision;
      try {
        const stored = await store.get(key);
        if (before !== revision || !stored || stored.kind !== 'directory') return info();
        directory = stored; remembered = true; permission = 'prompt';
        if (typeof stored.queryPermission === 'function') {
          try { updatePermission(stored, await stored.queryPermission({ mode: 'readwrite' })); }
          catch { /* Restoring a handle must never request permission or fail startup. */ }
        }
      } catch { /* Browsers may disable IndexedDB or cloning of directory handles. */ }
      return info();
    }
    async function choose() {
      if (!available()) throw failure('NotSupportedError', 'Этот браузер не поддерживает выбор папки.');
      try {
        const options = { id: 'hang-tabs', mode: 'readwrite' };
        if (directory) options.startIn = directory;
        // Preserve transient user activation: never read IndexedDB before this.
        const selected = host.showDirectoryPicker(options);
        const target = await selected;
        await writePermission(target);
        directory = target; permission = 'granted'; remembered = false; revision++;
        await persist(target);
        return info();
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
    }
    async function connect() {
      if (!directory) return choose();
      const target = directory;
      try { await writePermission(target, true); }
      catch (error) { if (error?.name === 'AbortError') return null; throw error; }
      await persist(target);
      return info();
    }
    function requiredDirectory() {
      if (!directory) throw failure('InvalidStateError', 'Сначала выберите папку табулатур.');
      return directory;
    }
    async function read() {
      const target = requiredDirectory(), files = [];
      try {
        for await (const handle of target.values()) {
          if (handle.kind === 'file' && /\.json$/i.test(handle.name)) files.push({ file: await handle.getFile(), handle });
        }
      } catch (error) {
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') updatePermission(target, 'denied');
        throw error;
      }
      return files;
    }
    async function save(tab) {
      if (!tab || typeof tab.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(tab.id)) throw new TypeError('Некорректный ID табулатуры для имени файла.');
      const id = tab.id, name = id + '.json', snapshot = JSON.stringify(tab, null, 2) + '\n';
      const target = requiredDirectory(), folder = target.name || 'Выбранная папка';
      if (busy.has(id)) throw failure('InvalidStateError', 'Сохранение этой табулатуры уже выполняется.');
      busy.add(id);
      let writable;
      try {
        await writePermission(target);
        const handle = await target.getFileHandle(name, { create: true });
        writable = await handle.createWritable();
        await writable.write(snapshot);
        await writable.close();
        return { kind: 'folder', name, folder, snapshot, handle };
      } catch (error) {
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') updatePermission(target, 'denied');
        if (writable && typeof writable.abort === 'function') {
          try { await writable.abort(); } catch { /* Preserve the original write error. */ }
        }
        throw error;
      } finally { busy.delete(id); }
    }
    return { available, info, restore, connect, choose, read, save };
  }
  return { create };
});
