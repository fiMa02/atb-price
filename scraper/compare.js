// Ціни одного товару в усіх містах — для порівняння на сторінці товару.
// site/data/compare/NN.json (розбито за id % 100): { id: { місто: ціна | [ціна, ціна_до_знижки] } }.
//
//   node scraper/compare.js — перебудувати з наявних products.json (парсер робить це сам після збору)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';

const SHARDS = 100;

export async function buildCompare(dataDir) {
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const city of CITIES) {
    let products;
    try {
      products = JSON.parse(await fs.readFile(path.join(dataDir, 'cities', city.slug, 'products.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const p of products) {
      if (p.out) continue; // немає в наявності — у порівнянні не показуємо
      const shard = shards[p.id % SHARDS];
      (shard[p.id] ||= {})[city.slug] = p.oldPrice ? [p.price, p.oldPrice] : p.price;
    }
  }
  const dir = path.join(dataDir, 'compare');
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < SHARDS; i++) {
    await fs.writeFile(path.join(dir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildCompare(path.resolve('site/data'));
  console.log('Порівняння міст оновлено.');
}
