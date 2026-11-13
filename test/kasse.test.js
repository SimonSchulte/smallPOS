import { describe, expect, it } from "vitest";
import { call, freshEvent, item, saleBody, session, uuid } from "./helpers.js";

async function newArticle(api, group_id, name, price_cents) {
  const r = await api("/api/articles", { method: "POST", body: { group_id, name, price_cents } });
  return { id: r.data.id, name, price_cents };
}

// Jeder Test bekommt eine frische Veranstaltung und eigene Artikel (Speicher gilt pro Testdatei).
async function setup(opening = 0) {
  const s = await session();
  const eventId = await freshEvent(s.api, opening);
  const g = await newArticle(s.api, 1, "Glühwein", 350);
  const k = await newArticle(s.api, 1, "Kinderpunsch", 250);
  const c = await newArticle(s.api, 2, "Champignons", 405);
  return { ...s, eventId, g, k, c };
}

describe("Startdaten", () => {
  it("Seed: Gruppen, Artikel mit Preis 0, genau eine aktive Veranstaltung", async () => {
    const { api } = await session();
    const { data } = await api("/api/state");
    expect(data.groups.map((x) => x.name)).toEqual(["Getränke", "Essen"]);
    expect(data.articles.map((a) => [a.name, a.price_cents])).toEqual([["Glühwein", 0], ["Kinderpunsch", 0], ["Champignons", 0]]);
    expect(data.event).toMatchObject({ active: 1, opening_cents: 0 });
    expect(data.settings.receipt_footer).toBe("Zählbeleg, keine Kassenbon-Pflichtangaben");
  });
});

describe("Verkäufe", () => {
  it("POST /api/sales ist idempotent: gleiche UUID ergibt genau einen Verkauf", async () => {
    const { api, g, eventId } = await setup();
    const body = saleBody([item(g, 2)]);
    const a = await api("/api/sales", { method: "POST", body });
    const b = await api("/api/sales", { method: "POST", body });
    const c = await api("/api/sales", { method: "POST", body: { ...body, device_name: "Anderes Gerät" } });
    expect(a.status).toBe(201);
    expect(a.data.duplicate).toBe(false);
    expect(b.status).toBe(200);
    expect(b.data.duplicate).toBe(true);
    expect(c.data.duplicate).toBe(true);
    expect(b.data.number).toBe(a.data.number);
    const list = await api("/api/sales");
    expect(list.data.sales).toHaveLength(1);
    expect(list.data.sales[0].items).toHaveLength(1);
    const rep = await api(`/api/report?event_id=${eventId}`);
    expect(rep.data.sales_count).toBe(1);
    expect(rep.data.total_cents).toBe(700);
  });

  it("parallele Wiederholungen derselben UUID zählen ebenfalls nur einmal", async () => {
    const { api, g, k, eventId } = await setup();
    const body = saleBody([item(g, 1), item(k, 3)]);
    const results = await Promise.all(Array.from({ length: 5 }, () => api("/api/sales", { method: "POST", body })));
    expect(results.filter((r) => r.data.duplicate === false)).toHaveLength(1);
    const rep = await api(`/api/report?event_id=${eventId}`);
    expect(rep.data.sales_count).toBe(1);
    expect(rep.data.total_cents).toBe(350 + 750);
  });

  it("zwei parallele Geräte: Bericht summiert beide, Belegnummern sind fortlaufend und eindeutig", async () => {
    const { api, g, k, c, eventId } = await setup();
    const device = (name, n) =>
      Promise.all(Array.from({ length: n }, () => api("/api/sales", { method: "POST", body: saleBody([item(g, 1), item(k, 2)], { device_name: name }) })));
    const [a, b] = await Promise.all([device("Kasse 1", 6), device("Ausschank", 4)]);
    await api("/api/sales", { method: "POST", body: saleBody([item(c, 1)], { device_name: "Ausschank" }) });
    const numbers = [...a, ...b].map((r) => r.data.number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));

    const rep = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(rep.sales_count).toBe(11);
    expect(rep.total_cents).toBe(10 * (350 + 500) + 405);
    expect(rep.average_cents).toBe(Math.round(rep.total_cents / 11));
    expect(rep.devices).toEqual([
      { device_name: "Ausschank", sales_count: 5, revenue_cents: 4 * 850 + 405 },
      { device_name: "Kasse 1", sales_count: 6, revenue_cents: 6 * 850 },
    ]);
    const drinks = rep.groups.find((x) => x.name === "Getränke");
    expect(drinks.articles.find((x) => x.name === "Glühwein")).toMatchObject({ qty: 10, revenue_cents: 3500 });
    expect(drinks.articles.find((x) => x.name === "Kinderpunsch")).toMatchObject({ qty: 20, revenue_cents: 5000 });
    expect(drinks).toMatchObject({ qty: 30, revenue_cents: 8500 });
    expect(rep.groups.find((x) => x.name === "Essen")).toMatchObject({ qty: 1, revenue_cents: 405 });
  });

  it("Preisänderung verändert alte Verkäufe nicht (Snapshot)", async () => {
    const { api, g, eventId } = await setup();
    const old = await api("/api/sales", { method: "POST", body: saleBody([item(g, 2)]) });
    await api(`/api/articles/${g.id}`, { method: "PATCH", body: { price_cents: 400, name: "Glühwein groß" } });
    const neu = await api("/api/sales", { method: "POST", body: saleBody([item({ ...g, name: "Glühwein groß" }, 1, 400)]) });
    expect(neu.status).toBe(201);

    const list = (await api("/api/sales")).data.sales;
    const oldSale = list.find((s) => s.id === old.data.id);
    expect(oldSale.total_cents).toBe(700);
    expect(oldSale.items[0]).toMatchObject({ name: "Glühwein", unit_price_cents: 350, qty: 2 });
    const rep = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(rep.total_cents).toBe(700 + 400);
  });

  it("Storno: Verkauf fällt aus Umsatz und Mengen, bleibt sichtbar, Kassensturz-Soll passt", async () => {
    const { api, g, k, eventId } = await setup(10000);
    const keep = await api("/api/sales", { method: "POST", body: saleBody([item(g, 2)]) });
    const gone = await api("/api/sales", { method: "POST", body: saleBody([item(k, 4), item(g, 1)]) });
    const before = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(before.total_cents).toBe(700 + 1000 + 350);

    const v = await api(`/api/sales/${gone.data.id}/void`, { method: "POST", body: { reason: "Vertippt" } });
    expect(v.status).toBe(200);
    const again = await api(`/api/sales/${gone.data.id}/void`, { method: "POST", body: { reason: "Nochmal" } });
    expect(again.data.changed).toBe(false);

    const rep = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(rep.total_cents).toBe(700);
    expect(rep.sales_count).toBe(1);
    expect(rep.voids).toEqual({ count: 1, total_cents: 1350 });
    const drinks = rep.groups.find((x) => x.name === "Getränke");
    expect(drinks.articles.find((x) => x.name === "Glühwein").qty).toBe(2);
    expect(drinks.articles.find((x) => x.name === "Kinderpunsch")).toBeUndefined();
    expect(rep.cash.expected_cents).toBe(10000 + 700);

    const list = (await api("/api/sales")).data.sales;
    const stored = list.find((s) => s.id === gone.data.id);
    expect(stored.voided_at).toBeTruthy();
    expect(stored.void_reason).toBe("Vertippt");
    expect(list.find((s) => s.id === keep.data.id).voided_at).toBeNull();
    expect((await api(`/api/sales/${uuid()}/void`, { method: "POST", body: { reason: "x" } })).status).toBe(404);
  });

  it("Kassensturz: Soll = Anfangsbestand + Umsatz, Differenz stimmt mit Cent-Beträgen", async () => {
    const { api, g, c, eventId } = await setup(12050);
    await api("/api/sales", { method: "POST", body: saleBody([item(g, 3), item(c, 1)]) }); // 1050 + 405 = 1455
    await api("/api/sales", { method: "POST", body: saleBody([item(c, 2)]) }); // 810
    const soll = 12050 + 1455 + 810;
    let rep = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(rep.cash.expected_cents).toBe(soll);
    expect(rep.cash.latest_difference_cents).toBeNull();

    await api("/api/cash-counts", { method: "POST", body: { counted_cents: soll - 5, note: "Erste Zählung" } });
    await api("/api/cash-counts", { method: "POST", body: { counted_cents: soll + 1, note: "Zweite" } });
    rep = (await api(`/api/report?event_id=${eventId}`)).data;
    expect(rep.cash.counts).toHaveLength(2);
    expect(rep.cash.counts[0]).toMatchObject({ counted_cents: soll + 1, difference_cents: 1, note: "Zweite" });
    expect(rep.cash.counts[1].difference_cents).toBe(-5);
    expect(rep.cash.latest_difference_cents).toBe(1);
  });

  it("Verkäufe werden der gewünschten Veranstaltung zugeordnet; neue Veranstaltung schließt die alte", async () => {
    const { api, g, eventId } = await setup();
    await api("/api/sales", { method: "POST", body: saleBody([item(g, 1)]) });
    const second = await freshEvent(api);
    const s2 = await api("/api/sales", { method: "POST", body: saleBody([item(g, 1)]) });
    expect(s2.data.event_id).toBe(second);
    expect(s2.data.number).toBe(1);
    const late = await api("/api/sales", { method: "POST", body: saleBody([item(g, 1)], { event_id: eventId }) });
    expect(late.data.event_id).toBe(eventId);
    expect(late.data.number).toBe(2);
    const events = (await api("/api/events")).data.events;
    expect(events.filter((e) => e.active)).toHaveLength(1);
    expect((await api(`/api/report?event_id=${eventId}`)).data.sales_count).toBe(2);
  });
});

describe("Eingabevalidierung", () => {
  it.each([
    ["Menge 0", (g) => ({ items: [{ ...item(g), qty: 0 }] })],
    ["Menge zu groß", (g) => ({ items: [{ ...item(g), qty: 100 }] })],
    ["Menge Kommazahl", (g) => ({ items: [{ ...item(g), qty: 1.5 }] })],
    ["Preis als Kommazahl", (g) => ({ items: [{ ...item(g), unit_price_cents: 3.5 }] })],
    ["unbekannte Artikel-ID", (g) => ({ items: [{ ...item(g), article_id: 999999 }] })],
    ["leere Positionen", () => ({ items: [] })],
    ["unbekanntes Feld", (g) => ({ items: [item(g)], total_cents: 1 })],
    ["unbekanntes Feld in Position", (g) => ({ items: [{ ...item(g), extra: 1 }] })],
    ["ungültige UUID", (g) => ({ id: "nicht-uuid", items: [item(g)] })],
    ["negatives Gegeben", (g) => ({ items: [item(g)], given_cents: -1 })],
    ["unbekannte Veranstaltung", (g) => ({ items: [item(g)], event_id: 987654 })],
    ["Summe zu hoch", (g) => ({ items: Array.from({ length: 20 }, () => ({ ...item(g), unit_price_cents: 100000, qty: 99 })) })],
  ])("lehnt ab: %s", async (_name, make) => {
    const { api, g } = await setup();
    const r = await api("/api/sales", { method: "POST", body: { ...saleBody([item(g)]), ...make(g) } });
    expect(r.status).toBe(400);
    expect((await api("/api/sales")).data.sales).toHaveLength(0);
  });

  it("Verwaltungs-Eingaben werden geprüft", async () => {
    const { api } = await setup();
    expect((await api("/api/articles", { method: "POST", body: { group_id: 1, name: "X", price_cents: 1.2 } })).status).toBe(400);
    expect((await api("/api/articles", { method: "POST", body: { group_id: 999, name: "X" } })).status).toBe(400);
    expect((await api("/api/events", { method: "POST", body: { name: "A", date: "13.11.2026" } })).status).toBe(400);
    expect((await api("/api/settings", { method: "PUT", body: { evil: "x" } })).status).toBe(400);
    expect((await api("/api/cash-counts", { method: "POST", body: { counted_cents: -5 } })).status).toBe(400);
    expect((await api("/api/sales/" + uuid() + "/void", { method: "POST", body: {} })).status).toBe(400);
  });
});

describe("Verwaltung und Export", () => {
  it("Artikel anlegen, umbenennen, deaktivieren (nie löschen) und sortieren", async () => {
    const { api } = await setup();
    const created = await api("/api/articles", { method: "POST", body: { group_id: 1, name: "Bratwurst", price_cents: 300 } });
    expect(created.status).toBe(201);
    await api(`/api/articles/${created.data.id}`, { method: "PATCH", body: { active: false } });
    let state = (await api("/api/state")).data;
    expect(state.articles.find((a) => a.id === created.data.id)).toMatchObject({ active: 0, name: "Bratwurst" });
    const ids = state.articles.filter((a) => a.group_id === 1).map((a) => a.id).reverse();
    await api("/api/reorder", { method: "POST", body: { kind: "articles", ids } });
    state = (await api("/api/state")).data;
    expect(state.articles.filter((a) => a.group_id === 1).map((a) => a.id)).toEqual(ids);
  });

  it("Einstellungen lassen sich ändern", async () => {
    const { api } = await setup();
    await api("/api/settings", { method: "PUT", body: { club_name: "TSV Beispiel", receipt_footer: "Zählbeleg" } });
    expect((await api("/api/state")).data.settings).toEqual({ club_name: "TSV Beispiel", receipt_footer: "Zählbeleg" });
  });

  it("CSV-Exporte und JSON-Backup", async () => {
    const { api, cookie, g, k, eventId } = await setup(5000);
    const s = await api("/api/sales", { method: "POST", body: saleBody([item(g, 2), item(k, 1)], { given_cents: 2000 }) });
    await api(`/api/articles/${g.id}`, { method: "PATCH", body: { name: "=Glühwein" } });

    const sales = await api(`/api/export/sales.csv?event_id=${eventId}`);
    expect(sales.res.headers.get("content-type")).toMatch(/text\/csv/);
    const raw = new Uint8Array(await (await call(`/api/export/sales.csv?event_id=${eventId}`, { cookie })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM für Excel
    expect(sales.data).toContain("Beleg;Zeit (Gerät);Gerät;Status");
    expect(sales.data).toContain("2x Glühwein à 3,50 | 1x Kinderpunsch à 2,50");
    expect(sales.data).toContain(";9,50;20,00;10,50");

    const arts = await api(`/api/export/articles.csv?event_id=${eventId}`);
    expect(arts.data).toContain("Getränke;=Glühwein".replace("=", "'="));
    expect(arts.data).toContain("Gesamt;");

    const backup = await api("/api/export/all.json");
    expect(backup.status).toBe(200);
    expect(backup.data.sales.some((x) => x.id === s.data.id)).toBe(true);
    expect(backup.data).not.toHaveProperty("login_attempts");
  });
});
