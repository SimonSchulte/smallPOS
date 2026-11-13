// Lokale Ablage in IndexedDB: Verkäufe (Warteschlange + Verlauf) und Metadaten.

const DB_NAME = "kasse";
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("meta");
        const sales = db.createObjectStore("sales", { keyPath: "id" });
        sales.createIndex("status", "status");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const metaGet = (key) => run("meta", "readonly", (s) => s.get(key));
export const metaSet = (key, value) => run("meta", "readwrite", (s) => s.put(value, key));
export const salePut = (sale) => run("sales", "readwrite", (s) => s.put(sale));
export const saleGet = (id) => run("sales", "readonly", (s) => s.get(id));
export const salesAll = () => run("sales", "readonly", (s) => s.getAll());

/** Zählt und vergibt die nächste lokale Belegnummer atomar in einer Transaktion. */
export async function nextCounter() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const s = tx.objectStore("meta");
    const get = s.get("counter");
    get.onsuccess = () => {
      const n = (get.result || 0) + 1;
      s.put(n, "counter");
      tx.oncomplete = () => resolve(n);
    };
    tx.onerror = () => reject(tx.error);
  });
}
