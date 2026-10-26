// Caché local por mes en IndexedDB (no localStorage: los archivos de mes pesan
// ~2MB y localStorage tiene un techo de ~5MB y es síncrono). IndexedDB permite
// cientos de MB y es asíncrono, así que no bloquea el render.
//
// Cada entrada guarda { ts, value }. TTL = 1 hora: pasado ese tiempo se ignora
// (se vuelve a pedir a la red). El botón "Actualizar información" limpia todo.

const DB_NAME = "Acuacar-mapa-cache";
const STORE = "months";
const TTL_MS = 60 * 60 * 1000; // 1 hora

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB no disponible"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Devuelve el valor cacheado si existe y no ha expirado; si no, null.
export async function cacheGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec && rec.ts && Date.now() - rec.ts < TTL_MS) resolve(rec.value);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Guarda un valor con marca de tiempo. Silencioso ante errores/cuota.
export async function cachePut(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ ts: Date.now(), value }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* sin caché: seguimos con la red */
  }
}

// Borra toda la caché (lo usa el botón de actualizar).
export async function cacheClear() {
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* nada que limpiar */
  }
}
