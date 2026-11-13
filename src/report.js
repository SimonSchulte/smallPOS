// Berichtslogik: Menge/Umsatz je Artikel und Gruppe, Geräte, Stornos, Kassensturz.

/** Reine Funktion über Zeilen aus der Datenbank, damit sie leicht testbar bleibt. */
export function buildReport({ event, itemRows, totals, deviceRows, voids, counts }) {
  const groups = [];
  const byGroup = new Map();
  for (const r of itemRows) {
    let g = byGroup.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, name: r.group_name, articles: [], qty: 0, revenue_cents: 0 };
      byGroup.set(r.group_id, g);
      groups.push(g);
    }
    g.articles.push({ article_id: r.article_id, name: r.name, qty: r.qty, revenue_cents: r.revenue });
    g.qty += r.qty;
    g.revenue_cents += r.revenue;
  }
  const total = totals.total;
  const soll = event.opening_cents + total;
  const latest = counts.length ? counts[0] : null;
  return {
    event,
    groups,
    total_cents: total,
    sales_count: totals.n,
    average_cents: totals.n ? Math.round(total / totals.n) : 0,
    devices: deviceRows.map((d) => ({ device_name: d.device_name, sales_count: d.n, revenue_cents: d.total })),
    voids: { count: voids.n, total_cents: voids.total },
    cash: {
      opening_cents: event.opening_cents,
      expected_cents: soll,
      counts: counts.map((c) => ({ ...c, difference_cents: c.counted_cents - soll })),
      latest_difference_cents: latest ? latest.counted_cents - soll : null,
    },
    generated_at: new Date().toISOString(),
  };
}

export async function loadReport(db, event) {
  const [items, totals, devices, voids, counts] = await db.batch([
    db.prepare(
      `SELECT si.article_id AS article_id, a.name AS name, g.id AS group_id, g.name AS group_name,
              SUM(si.qty) AS qty, SUM(si.qty * si.unit_price_cents) AS revenue
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN articles a ON a.id = si.article_id
         JOIN groups g ON g.id = a.group_id
        WHERE s.event_id = ?1 AND s.voided_at IS NULL
        GROUP BY si.article_id
        ORDER BY g.sort, g.id, a.sort, a.id`,
    ).bind(event.id),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total FROM sales WHERE event_id = ?1 AND voided_at IS NULL").bind(event.id),
    db.prepare(
      `SELECT device_name, COUNT(*) AS n, SUM(total_cents) AS total FROM sales
        WHERE event_id = ?1 AND voided_at IS NULL GROUP BY device_name ORDER BY device_name`,
    ).bind(event.id),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total FROM sales WHERE event_id = ?1 AND voided_at IS NOT NULL").bind(event.id),
    db.prepare("SELECT id, counted_cents, note, created_at FROM cash_counts WHERE event_id = ?1 ORDER BY id DESC").bind(event.id),
  ]);
  return buildReport({
    event,
    itemRows: items.results,
    totals: totals.results[0],
    deviceRows: devices.results,
    voids: voids.results[0],
    counts: counts.results,
  });
}
