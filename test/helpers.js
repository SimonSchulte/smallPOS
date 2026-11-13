import { exports } from "cloudflare:workers";

let ipCounter = 0;
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

export async function call(path, { method = "GET", body, cookie, ip = "192.0.2.1", headers = {} } = {}) {
  const res = await exports.default.fetch(
    new Request(`https://kasse.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return res;
}

export async function login(pin = "0000", ip = freshIp()) {
  const res = await call("/api/login", { method: "POST", body: { pin }, ip });
  const setCookie = res.headers.get("set-cookie");
  return { res, cookie: setCookie ? setCookie.split(";")[0] : null, setCookie };
}

/** Meldet an und liefert einen kleinen API-Client mit Cookie. */
export async function session() {
  const { cookie } = await login();
  const api = async (path, opts = {}) => {
    const res = await call(path, { ...opts, cookie });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, res };
  };
  return { cookie, api };
}

export const uuid = () => crypto.randomUUID();

/** Legt eine frische Veranstaltung an (schließt die alte), damit Tests sich nicht beeinflussen. */
export async function freshEvent(api, opening_cents = 0) {
  const r = await api("/api/events", { method: "POST", body: { name: "Test", date: "2026-11-13", opening_cents } });
  if (r.status !== 201) throw new Error("Veranstaltung anlegen fehlgeschlagen: " + JSON.stringify(r.data));
  return r.data.id;
}

export async function articleByName(api, name) {
  const { data } = await api("/api/state");
  return data.articles.find((a) => a.name === name);
}

export const item = (article, qty = 1, price = article.price_cents) => ({
  article_id: article.id,
  name: article.name,
  unit_price_cents: price,
  qty,
});

export const saleBody = (items, extra = {}) => ({ id: uuid(), device_name: "Kasse 1", created_at_client: new Date().toISOString(), items, ...extra });
