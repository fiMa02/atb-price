// Щоденний парсер каталогу atbmarket.com.
// Зберігає поточний каталог у site/data/products.json і дописує зміни цін
// у site/data/history/NN.json (шард = id % 100).
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BASE = 'https://www.atbmarket.com';
const DATA_DIR = path.resolve('site/data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SHARDS = 100;
const DELAY_MS = 700;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Розділи меню, що лише дублюють товари з інших категорій.
const SKIP_CATEGORIES = new Set(['/catalog/388-aktsiya-7-dniv', '/catalog/economy', '/catalog/novetly']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дата за київським часом, щоб нічний запуск не «переїжджав» на інший день.
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());

// Завантажуємо через curl: вбудований fetch у Node Cloudflare на сайті АТБ відхиляє (403).
async function fetchHtml(url, attempt = 1) {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '--compressed', '-A', UA, '-H', 'Accept-Language: uk-UA,uk;q=0.9', '-w', '\n%{http_code}', url],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1));
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return stdout.slice(0, cut);
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    await sleep(2000 * attempt);
    return fetchHtml(url, attempt + 1);
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Розділи й підрозділи з меню. Підрозділи теж потрібні: частина з них (іграшки, техніка)
// не входить до жодного розділу верхнього рівня.
async function getCategories() {
  const $ = cheerio.load(await fetchHtml(BASE + '/'));
  const hrefs = new Set();
  $('a.category-menu__link-wrap, a.submenu__link').each((_, a) => {
    const href = $(a).attr('href');
    if (href?.startsWith('/catalog/') && !SKIP_CATEGORIES.has(href)) hrefs.add(href);
  });
  return [...hrefs];
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('article.catalog-item').each((_, el) => {
    const card = $(el);
    const cart = card.find('.b-addToCart');
    const id = cart.attr('data-productid');
    const link = card.find('.catalog-item__title a');
    const price = num(card.find('.product-price__top').attr('value'));
    if (!id || !price) return;
    const label = card.find('.custom-product-label').first();
    items.push({
      id: Number(id),
      name: link.text().trim().replace(/\s+/g, ' '),
      url: link.attr('href'),
      img: card.find('img.catalog-item__img').attr('src') || null,
      price,
      oldPrice: num(card.find('.product-price__bottom').attr('value')),
      unit: card.find('.product-price__unit').first().text().replace('/', '').trim() || 'шт',
      category: cart.attr('data-category') || null,
      brand: cart.attr('data-brand') || null,
      label: label.length ? label.text().trim().replace(/\s+/g, ' ') : null,
    });
  });
  return items;
}

async function scrapeCategory(href, products) {
  let added = 0;
  const seenHere = new Set();
  for (let page = 1; page < 500; page++) {
    const html = await fetchHtml(`${BASE}${href}${page > 1 ? `?page=${page}` : ''}`);
    await sleep(DELAY_MS);
    const cards = parseCards(html);
    // Сторінки після останньої повторюють останню — зупиняємось, коли сторінка нічого нового не дала.
    const fresh = cards.filter((c) => !seenHere.has(c.id));
    if (!fresh.length) break;
    for (const c of fresh) {
      seenHere.add(c.id);
      if (!products.has(c.id)) {
        products.set(c.id, c);
        added++;
      }
    }
  }
  return added;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const started = Date.now();
  const categories = await getCategories();
  console.log(`Категорій: ${categories.length}`);

  const products = new Map();
  for (const href of categories) {
    const added = await scrapeCategory(href, products);
    console.log(`${href}: +${added} (всього ${products.size})`);
  }

  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), { productCount: 0 });
  // Захист від часткового збою: не позначаємо товари зниклими, якщо зібрали підозріло мало.
  const fullScrape = products.size >= meta.productCount * 0.9;
  if (!fullScrape) console.warn(`Увага: зібрано ${products.size} проти ${meta.productCount} минулого разу`);

  // Історія: [дата, ціна, стара_ціна] лише при зміні; [дата, null] — товар зник з каталогу.
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (let i = 0; i < SHARDS; i++) {
    shards[i] = await readJson(path.join(HISTORY_DIR, `${String(i).padStart(2, '0')}.json`), {});
  }
  let changed = 0;
  for (const p of products.values()) {
    const shard = shards[p.id % SHARDS];
    const hist = (shard[p.id] ||= []);
    const last = hist.at(-1);
    if (!last || last[1] !== p.price || (last[2] ?? null) !== p.oldPrice) {
      if (last && last[0] === today) hist.pop();
      hist.push(p.oldPrice ? [today, p.price, p.oldPrice] : [today, p.price]);
      changed++;
    }
    // Для карток: коли востаннє змінилась ціна і якою була до того.
    const prev = hist.slice(0, -1).findLast((h) => h[1] != null);
    p.changed = hist.at(-1)[0];
    p.prev = prev ? prev[1] : null;
    // Звичайна ціна перед поточною акцією — щоб виявляти завищену «ціну до знижки».
    const regular = p.oldPrice ? hist.findLast((h) => h[1] != null && h[2] == null) : null;
    p.regular = regular ? regular[1] : null;
  }
  if (fullScrape) {
    for (const shard of shards) {
      for (const [id, hist] of Object.entries(shard)) {
        const last = hist.at(-1);
        if (!products.has(Number(id)) && last[1] !== null) hist.push([today, null]);
      }
    }
  }
  for (let i = 0; i < SHARDS; i++) {
    await fs.writeFile(path.join(HISTORY_DIR, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  }

  const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  await fs.writeFile(path.join(DATA_DIR, 'products.json'), JSON.stringify(list));
  await fs.writeFile(
    path.join(DATA_DIR, 'meta.json'),
    JSON.stringify({ updated: today, updatedAt: new Date().toISOString(), productCount: list.length }, null, 2),
  );
  console.log(`Готово: ${list.length} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
