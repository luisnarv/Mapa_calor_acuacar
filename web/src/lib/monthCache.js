// Caché local por mes en IndexedDB (no localStorage: los archivos de mes pesan
// ~2MB y localStorage tiene un techo de ~5MB y es síncrono). IndexedDB permite
// cientos de MB y es asíncrono, así que no bloquea el render.
//
// Cada entrada guarda { ts, value }. TTL = 1 hora: pasado ese tiempo se ignora
// (se vuelve a pedir a la red). El botón "Actualizar información" limpia todo.
//
// Las claves llevan la versión de los datos (`version.json`, que escribe el ETL): si el
// ETL se corre de nuevo dentro de la hora, la versión cambia y la caché vieja no se usa.

const DB_NAME = "dashboard-cache-v4";
const STORE = "months";
const TTL_MS = 60 * 60 * 1000; // 1 hora

let versionPromise = null;

// Hora de generación de los datos. Si no se puede leer (sin archivo, sin red) devuelve ""
// y la caché se comporta como antes, solo con el TTL.
function versionDatos() {
  if (!versionPromise) {
    versionPromise = fetch(`/scr/version.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.generated) || "")
      .catch(() => "");
  }
  return versionPromise;
}

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
    key = `${await versionDatos()}|${key}`;
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
    const version = await versionDatos();
    key = `${version}|${key}`;
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put({ ts: Date.now(), value }, key);
      // Las entradas de versiones anteriores ya no se usan: se borran para que la base no crezca.
      store.openKeyCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (!String(cursor.key).startsWith(`${version}|`)) store.delete(cursor.key);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* sin caché: seguimos con la red */
  }
}

// Borra la base de datos completa de la caché (la invoca "Actualizar información").
export async function cacheClear() {
  versionPromise = null; // la próxima lectura vuelve a pedir la versión
  try {
    if (typeof indexedDB === "undefined") return;
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    /* silencioso */
  }
}
