// Hintergrund-Synchronisation: sendet lokal gespeicherte Verkäufe an die API.
// Die UUID des Verkaufs macht jede Wiederholung unschädlich (Server: INSERT OR IGNORE).

import { ApiError, OfflineError, api } from "./api.js";
import { salePut, salesAll } from "./store.js";

export function createSync({ onChange, onAuthLost }) {
  let running = false;

  async function counts() {
    const all = await salesAll();
    return {
      pending: all.filter((s) => s.status === "pending").length,
      rejected: all.filter((s) => s.status === "rejected").length,
    };
  }

  async function flush() {
    if (running) return;
    running = true;
    try {
      const all = await salesAll();
      const queue = all.filter((s) => s.status === "pending").sort((a, b) => a.created_at_client.localeCompare(b.created_at_client));
      for (const sale of queue) {
        try {
          const body = {
            id: sale.id,
            device_name: sale.device_name,
            created_at_client: sale.created_at_client,
            items: sale.items,
            given_cents: sale.given_cents,
          };
          if (sale.event_id) body.event_id = sale.event_id;
          const r = await api("/api/sales", { method: "POST", body });
          await salePut({ ...sale, status: "synced", number: r.number, event_id: r.event_id, error: null });
        } catch (err) {
          if (err instanceof OfflineError) break;
          if (err instanceof ApiError && err.status === 401) {
            onAuthLost?.();
            break;
          }
          if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
            // Der Server lehnt diesen Verkauf dauerhaft ab: nicht endlos wiederholen, sondern sichtbar markieren.
            await salePut({ ...sale, status: "rejected", error: err.message });
            continue;
          }
          break; // 5xx o. ä.: später erneut versuchen
        }
      }
    } finally {
      running = false;
      onChange?.(await counts());
    }
  }

  return { flush, counts };
}
