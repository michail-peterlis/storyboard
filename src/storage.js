// Browser-side persistence: an autosave draft (IndexedDB) and remembered file handles.
// Nothing here is required for the editor to work; every call degrades to "unavailable".
const DB = 'storyline', VERSION = 1;
let dbPromise = null;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ['draft', 'images', 'recent']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}
async function transaction(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = work(Object.fromEntries(stores.map(name => [name, tx.objectStore(name)])));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
function read(store, key) {
  return open().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }));
}
function readAll(store) {
  return open().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result ?? []); r.onerror = () => reject(r.error);
  }));
}

export function createDraftStore() {
  const written = new Map(); // image id → dataUrl already stored
  return {
    available: typeof indexedDB !== 'undefined',
    // Stores the project with image bytes split out so frequent text edits stay cheap.
    async save(project, meta = {}) {
      const images = new Map();
      const passages = project.passages.map(passage => {
        if (!passage.image) return passage;
        const { dataUrl, ...rest } = passage.image;
        images.set(passage.image.id, dataUrl);
        return { ...passage, image: { ...rest, dataUrl: null } };
      });
      const changed = [...images].filter(([id, dataUrl]) => written.get(id) !== dataUrl);
      await transaction(['draft', 'images'], 'readwrite', stores => {
        stores.draft.put({ savedAt: Date.now(), title: project.title, meta, project: { ...project, passages } }, 'current');
        for (const [id, dataUrl] of changed) stores.images.put(dataUrl, id);
      });
      for (const [id, dataUrl] of changed) written.set(id, dataUrl);
    },
    async load() {
      const draft = await read('draft', 'current');
      if (!draft) return null;
      const passages = [];
      for (const passage of draft.project.passages) {
        if (!passage.image) { passages.push(passage); continue; }
        const dataUrl = await read('images', passage.image.id);
        if (typeof dataUrl !== 'string') { const { image, ...rest } = passage; passages.push(rest); continue; }
        passages.push({ ...passage, image: { ...passage.image, dataUrl } });
      }
      return { ...draft, project: { ...draft.project, passages } };
    },
    async clear() {
      written.clear();
      await transaction(['draft', 'images'], 'readwrite', stores => { stores.draft.clear(); stores.images.clear(); });
    },
    async peek() { const draft = await read('draft', 'current'); return draft ? { savedAt: draft.savedAt, title: draft.title, meta: draft.meta } : null; }
  };
}
// Recently opened folders/ZIPs (File System Access handles survive in IndexedDB; permission is asked again on reuse).
export const recentProjects = {
  async list() { try { return (await readAll('recent')).sort((a, b) => b.openedAt - a.openedAt); } catch { return []; } },
  async remember(entry) {
    try { await transaction(['recent'], 'readwrite', ({ recent }) => { recent.put({ ...entry, openedAt: Date.now() }, entry.key); }); } catch { /* optional */ }
    try {
      const all = await readAll('recent');
      const stale = all.sort((a, b) => b.openedAt - a.openedAt).slice(6);
      if (stale.length) await transaction(['recent'], 'readwrite', ({ recent }) => { for (const item of stale) recent.delete(item.key); });
    } catch { /* optional */ }
  },
  async forget(key) { try { await transaction(['recent'], 'readwrite', ({ recent }) => { recent.delete(key); }); } catch { /* optional */ } }
};
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle?.queryPermission) return true;
  if (await handle.queryPermission({ mode }) === 'granted') return true;
  return await handle.requestPermission?.({ mode }) === 'granted';
}
