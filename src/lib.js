// Gemeinsame Helfer: Antworten, Fehler, Validierung, CSV.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

export const bad = (msg) => new HttpError(400, msg);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID.test(v);

export function int(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name}: ganze Zahl von ${min} bis ${max} erwartet`);
  return v;
}

export function str(v, name, max, { allowEmpty = false } = {}) {
  if (typeof v !== "string") throw bad(`${name}: Text erwartet`);
  const t = v.trim();
  if ((!allowEmpty && t.length === 0) || t.length > max) throw bad(`${name}: 1 bis ${max} Zeichen erwartet`);
  return t;
}

export function onlyKeys(obj, allowed, name) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw bad(`${name}: Objekt erwartet`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw bad(`${name}: unbekanntes Feld "${k}"`);
  }
  return obj;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw bad("Ungültiges JSON");
  }
}

export const MAX_TOTAL_CENTS = 1_000_000; // 10.000 € pro Verkauf

/** Prüft einen Verkauf vom Gerät und liefert bereinigte Daten (Summe wird neu berechnet). */
export function validateSale(body) {
  onlyKeys(body, ["id", "device_name", "created_at_client", "event_id", "items", "given_cents"], "Verkauf");
  if (!isUuid(body.id)) throw bad("id: UUID erwartet");
  const device = str(body.device_name, "device_name", 40);
  let createdAt = new Date().toISOString();
  if (body.created_at_client !== undefined && body.created_at_client !== null) {
    const d = new Date(body.created_at_client);
    if (typeof body.created_at_client !== "string" || Number.isNaN(d.getTime())) throw bad("created_at_client: ISO-Zeit erwartet");
    createdAt = d.toISOString();
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw bad("items: 1 bis 50 Positionen erwartet");
  const items = body.items.map((it, i) => {
    onlyKeys(it, ["article_id", "name", "unit_price_cents", "qty"], `Position ${i + 1}`);
    return {
      article_id: int(it.article_id, "article_id", 1, 1_000_000),
      name: str(it.name, "name", 80),
      unit_price_cents: int(it.unit_price_cents, "unit_price_cents", -100_000, 100_000),
      qty: int(it.qty, "qty", 1, 99),
    };
  });
  const total = items.reduce((t, it) => t + it.unit_price_cents * it.qty, 0);
  if (Math.abs(total) > MAX_TOTAL_CENTS) throw bad("Summe außerhalb des erlaubten Bereichs");
  let given = null;
  if (body.given_cents !== undefined && body.given_cents !== null) given = int(body.given_cents, "given_cents", 0, 100_000_000);
  let eventId = null;
  if (body.event_id !== undefined && body.event_id !== null) eventId = int(body.event_id, "event_id", 1, 1_000_000_000);
  return { id: body.id.toLowerCase(), device, createdAt, items, total, given, eventId };
}

export const euro = (cents) => {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}`;
};

function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  // Schutz vor Formel-Injektion in Tabellenkalkulationen
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV mit Semikolon und BOM, damit deutsches Excel sie direkt richtig öffnet. */
export function toCsv(header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function csvResponse(name, text) {
  return new Response(text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}
