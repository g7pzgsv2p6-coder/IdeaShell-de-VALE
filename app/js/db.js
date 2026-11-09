// Almacenamiento local en IndexedDB (todo queda en el teléfono)

const DB_NAME = 'chispa-db';
const DB_VERSION = 3;
export const STORES = ['ideas', 'categories', 'settings', 'audio', 'plans'];

let dbPromise = null;

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

function friendly(err) {
  if (err instanceof StorageError) return err;
  const name = err && err.name;
  if (name === 'QuotaExceededError') {
    return new StorageError('El teléfono no tiene espacio suficiente para guardar. Libere espacio o haga un respaldo y borre ideas antiguas.', err);
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return new StorageError('El almacenamiento del navegador no está disponible. Si usa navegación privada, ábrala en modo normal.', err);
  }
  return new StorageError('No se pudo acceder al almacenamiento del teléfono. Cierre y vuelva a abrir la app.', err);
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new StorageError('Este navegador no permite guardar datos (IndexedDB no disponible).'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(friendly(e));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ideas')) {
        const s = db.createObjectStore('ideas', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      // v2: audios de las grabaciones, separados para que la lista cargue rápido
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      // v3: planes de trabajo importados desde Excel
      if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(friendly(req.error));
    req.onblocked = () => reject(new StorageError('La base de datos está en uso por otra ventana de IdeaShel Vale. Ciérrela e intente de nuevo.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(store, mode);
    } catch (e) {
      dbPromise = null;
      reject(friendly(e));
      return;
    }
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req && typeof req === 'object' && 'onsuccess' in req) {
      req.onsuccess = () => { result = req.result; };
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(friendly(t.error));
    t.onabort = () => reject(friendly(t.error));
  }));
}

export const db = {
  getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  bulkPut: (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
  bulkDelete: (store, keys) => run(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }),
  replaceAll: (store, values) => run(store, 'readwrite', (s) => { s.clear(); values.forEach((v) => s.put(v)); })
};

export async function loadSettings() {
  const rows = await db.getAll('settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function saveSetting(key, value) {
  return db.put('settings', { key, value });
}
