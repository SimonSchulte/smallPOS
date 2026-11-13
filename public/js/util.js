// Kleine Helfer ohne Abhängigkeiten. Geld wird überall als ganze Cent geführt.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 1350 -> "13,50" */
export function fmt(cents) {
  const a = Math.abs(cents);
  return (cents < 0 ? "−" : "") + Math.floor(a / 100) + "," + String(a % 100).padStart(2, "0");
}
export const eur = (cents) => fmt(cents) + " €";

/** "3,50" | "3.5" | "3" -> 350. Gibt null zurück, wenn der Text kein gültiger Betrag ist. */
export function parseEuro(text) {
  const t = String(text ?? "").trim().replace(/\s|€/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const neg = t.startsWith("-");
  const [e, c = ""] = t.replace("-", "").split(".");
  const cents = parseInt(e, 10) * 100 + parseInt(c.padEnd(2, "0") || "0", 10);
  return neg ? -cents : cents;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "Kasse 1" -> "K1", "Ausschank" -> "AU" (Kürzel für vorläufige Belegnummern) */
export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => (/\d/.test(w) ? w.replace(/\D/g, "") : w[0].toUpperCase())).join("").slice(0, 4);
  return (words[0] || "K").slice(0, 2).toUpperCase();
}

const pad2 = (n) => String(n).padStart(2, "0");
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtTime(iso, withSeconds = false) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? ":" + pad2(d.getSeconds()) : ""}`;
}
export function fmtDate(iso) {
  const [y, m, d] = String(iso).split("-");
  return d ? `${d}.${m}.${y}` : iso;
}
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const billNo = (sale) => (sale.number ? String(sale.number).padStart(4, "0") : sale.provisional);
