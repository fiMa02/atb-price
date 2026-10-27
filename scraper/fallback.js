// Спільний каталог: вибір міста впливає лише на ціни.
// site/data/cities/<місто>/extra.json — товари, яких у цьому місті немає, з цінами найближчого (по прямій) міста,
// де вони є; поле from — slug того міста. Свої products.json міст не змінюються.
//
//   node scraper/fallback.js — перебудувати з наявних products.json (парсер робить це сам після збору)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';

// Відстань між центрами міст, км (формула гаверсинусів).
function distance(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export async function buildFallback(dataDir) {
  const catalogs = new Map();
  for (const city of CITIES) {
    try {
      const list = JSON.parse(await fs.readFile(path.join(dataDir, 'cities', city.slug, 'products.json'), 'utf8'));
      catalogs.set(city.slug, new Map(list.map((p) => [p.id, p])));
    } catch {
      // міста ще немає в даних
    }
  }
  const cities = CITIES.filter((c) => catalogs.has(c.slug));
  const all = new Set([...catalogs.values()].flatMap((m) => [...m.keys()]));

  for (const city of cities) {
    const own = catalogs.get(city.slug);
    const nearest = cities.filter((c) => c !== city).sort((a, b) => distance(city, a) - distance(city, b));
    const extra = [];
    for (const id of all) {
      if (own.has(id)) continue;
      // Спершу місто, де товар зараз у каталозі; якщо такого немає — де він лишився з позначкою out.
      const src = nearest.find((c) => catalogs.get(c.slug).get(id) && !catalogs.get(c.slug).get(id).out) || nearest.find((c) => catalogs.get(c.slug).has(id));
      const { out, checked, ...p } = catalogs.get(src.slug).get(id);
      extra.push({ ...p, from: src.slug });
    }
    extra.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    await fs.writeFile(path.join(dataDir, 'cities', city.slug, 'extra.json'), JSON.stringify(extra));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildFallback(path.resolve('site/data'));
  console.log('Спільний каталог (extra.json) оновлено.');
}
