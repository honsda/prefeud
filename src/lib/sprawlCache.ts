// Settlement cost-grid caches (suggestion #1 + #4).
// Costs depend only on (box, cell, data version) — never on nodes or budget —
// so slider drags and node edits skip sampling + masks + cost math entirely.
// Two layers:
// - memory LRU (any box): slider drags / node edits on a settled view.
// - IndexedDB (coarse full-map only): static costs persist across sessions,
//   keyed by COST_VERSION + data flags. Fine boxes are view-dependent and
//   re-solve cheaply from the memory layer.
// Main thread only (IndexedDB + DOM-free, but the Worker never calls here).

import { COST_VERSION, type SimGrid } from './settlement';

const MEM_CAP = 2; // coarse (10MB) + one fine box fit comfortably
const mem = new Map<string, SimGrid>();

export function costKey(
  ox: number,
  oy: number,
  w: number,
  h: number,
  cell: number,
  dataTag: string,
): string {
  return `v${COST_VERSION}|${ox},${oy},${w},${h},${cell}|${dataTag}`;
}

export function costMemGet(key: string): SimGrid | null {
  const hit = mem.get(key);
  if (!hit) return null;
  mem.delete(key);
  mem.set(key, hit);
  return hit;
}

export function costMemSet(key: string, sim: SimGrid): void {
  mem.delete(key);
  mem.set(key, sim);
  while (mem.size > MEM_CAP) {
    const first = mem.keys().next();
    if (first.done) break;
    mem.delete(first.value);
  }
}

export function costMemClear(): void {
  mem.clear();
}

const IDB_NAME = 'prefeud-sprawl-v1';

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('costs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

interface StoredCosts {
  w: number;
  h: number;
  ox: number;
  oy: number;
  cell: number;
  cost: Float32Array;
  blocked: Uint8Array;
}

/** Coarse full-map key — stable across sessions for the same data version. */
export function coarseCostKey(dataTag: string): string {
  return `coarse-v${COST_VERSION}|${dataTag}`;
}

export async function idbCostGet(key: string): Promise<SimGrid | null> {
  try {
    const db = await openIdb();
    if (!db) return null;
    const got = await new Promise<StoredCosts | undefined>((resolve) => {
      try {
        const tx = db.transaction('costs', 'readonly');
        const rq = tx.objectStore('costs').get(key);
        rq.onsuccess = () => resolve(rq.result as StoredCosts | undefined);
        rq.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    if (!got || !(got.cost instanceof Float32Array) || !(got.blocked instanceof Uint8Array)) return null;
    if (got.cost.length !== got.w * got.h || got.blocked.length !== got.w * got.h) return null;
    return { w: got.w, h: got.h, cost: got.cost, blocked: got.blocked, ox: got.ox, oy: got.oy, cell: got.cell };
  } catch {
    return null;
  }
}

export function idbCostPut(key: string, sim: SimGrid): void {
  openIdb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction('costs', 'readwrite');
      const rec: StoredCosts = {
        w: sim.w,
        h: sim.h,
        ox: sim.ox,
        oy: sim.oy,
        cell: sim.cell,
        cost: sim.cost.slice(),
        blocked: sim.blocked.slice(),
      };
      tx.objectStore('costs').put(rec, key);
    } catch {
      /* quota or privacy mode — caching is best-effort */
    }
  });
}
