import { OfflineError, api } from "./api.js";
import { S } from "./core.js";
import { metaGet, metaSet } from "./store.js";

/** Lädt Artikel, Gruppen und Einstellungen. Ohne Netz dient die zuletzt gespeicherte Fassung. */
export async function loadCatalog() {
  try {
    S.cat = await api("/api/state");
    S.online = true;
    await metaSet("catalog", S.cat);
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    S.online = false;
    S.cat = (await metaGet("catalog")) || S.cat;
    if (!S.cat) throw e;
  }
  return S.cat;
}
