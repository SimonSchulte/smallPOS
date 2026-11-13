// Dünner fetch-Wrapper. Unterscheidet "kein Netz" von Antworten des Servers.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class OfflineError extends Error {
  constructor() {
    super("Kein Netz");
    this.offline = true;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError();
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* leere oder keine JSON-Antwort */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Fehler ${res.status}`);
  return data;
}
