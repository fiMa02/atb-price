// Стрічка «Що змінилося»: changes.json — зміни сьогоднішнього збору відносно попереднього дня.
//   prices:  [{ id, from, fromOld, to, toOld }] — змінилась ціна або почалась/закінчилась акція
//   added:   [id]                               — новий товар (раніше його в цьому магазині не було)
//   back:    [id]                               — знову в наявності (був, зникав, повернувся)
//   removed: [{ id, name, img, unit, price }]   — сьогодні зник (у products.json лишається з позначкою out)
// Рахуємо з історії, тож повторний збір того ж дня дає той самий результат.
import fs from 'node:fs/promises';
import path from 'node:path';

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// shards — історія міста (уже з сьогоднішніми записами), products — Map id → товар сьогоднішнього збору,
// oldList — учорашній products.json (звідти назви й фото зниклих).
export async function writeChanges(dir, shards, products, today, oldList) {
  const file = path.join(dir, 'changes.json');
  const prevChanges = await readJson(file, null);
  const known = new Map(oldList.map((p) => [p.id, p]));
  if (prevChanges?.date === today) for (const r of prevChanges.removed) if (!known.has(r.id)) known.set(r.id, r);

  // Перший день збору: усе «нове», порівнювати нема з чим.
  const firstDay = !shards.some((shard) => Object.values(shard).some((h) => h[0][0] < today));
  const changes = { date: today, prices: [], added: [], back: [], removed: [] };
  for (const shard of shards) {
    for (const [key, hist] of Object.entries(shard)) {
      const last = hist.at(-1);
      if (last[0] !== today) continue;
      const before = hist.at(-2);
      const id = Number(key);
      if (last[1] == null) {
        const p = known.get(id);
        if (before && p) changes.removed.push({ id, name: p.name, img: p.img, unit: p.unit, price: before[1] });
      } else if (!before) {
        if (!firstDay && products.has(id)) changes.added.push(id);
      } else if (before[1] == null) {
        if (products.has(id)) changes.back.push(id);
      } else {
        changes.prices.push({ id, from: before[1], fromOld: before[2] ?? null, to: last[1], toOld: last[2] ?? null });
      }
    }
  }
  await fs.writeFile(file, JSON.stringify(changes));
  return changes;
}
