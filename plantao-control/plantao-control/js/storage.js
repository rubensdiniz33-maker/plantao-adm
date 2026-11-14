// Armazenamento local (IndexedDB). Se indisponível, cai para memória e informa a interface.
import { normalizeShift } from './validation.js';

const DB_NAME = 'plantao-control';
const DB_VERSION = 1;
const STORE = 'shifts';

let db = null;
let mode = 'idb'; // 'idb' | 'memory'
let initError = null;
const memory = new Map();

export const status = () => ({ mode, persistent: mode === 'idb', error: initError });

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Erro de armazenamento'));
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Erro de armazenamento'));
    tx.onabort = () => reject(tx.error || new Error('Transação abortada'));
  });

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Não foi possível abrir o banco local'));
    req.onblocked = () => reject(new Error('Banco local bloqueado por outra aba'));
  });
}

export async function init() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB indisponível neste navegador');
    db = await openDb();
    db.onversionchange = () => { db.close(); };
    // Prova de escrita: garante que o armazenamento realmente funciona (ex.: modo privado).
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    st.put({ id: '__probe__' });
    st.delete('__probe__');
    await txDone(tx);
    mode = 'idb';
    initError = null;
    try { navigator.storage?.persist?.(); } catch { /* opcional */ }
  } catch (e) {
    db = null;
    mode = 'memory';
    initError = e;
  }
  return status();
}

export async function listShifts() {
  let rows;
  if (mode === 'idb') {
    const tx = db.transaction(STORE, 'readonly');
    rows = await wrap(tx.objectStore(STORE).getAll());
  } else {
    rows = [...memory.values()];
  }
  const out = [];
  for (const r of rows) {
    try { out.push(normalizeShift(r)); } catch { /* registro inválido ignorado */ }
  }
  out.sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start) || b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function getShift(id) {
  let row;
  if (mode === 'idb') {
    const tx = db.transaction(STORE, 'readonly');
    row = await wrap(tx.objectStore(STORE).get(id));
  } else {
    row = memory.get(id);
  }
  if (!row) return null;
  try { return normalizeShift(row); } catch { return null; }
}

// Retorna { persisted } — persisted=false significa que NÃO foi gravado no dispositivo.
export async function saveShift(shift) {
  const copy = JSON.parse(JSON.stringify(shift));
  if (mode === 'idb') {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(copy);
    await txDone(tx);
    return { persisted: true };
  }
  memory.set(copy.id, copy);
  return { persisted: false };
}

export async function saveMany(shifts) {
  if (mode === 'idb') {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const s of shifts) st.put(JSON.parse(JSON.stringify(s)));
    await txDone(tx);
    return { persisted: true };
  }
  for (const s of shifts) memory.set(s.id, JSON.parse(JSON.stringify(s)));
  return { persisted: false };
}

export async function deleteShift(id) {
  if (mode === 'idb') {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
  } else {
    memory.delete(id);
  }
}
