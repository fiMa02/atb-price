// Щоденний парсер каталогу atbmarket.com для кількох міст.
// Ціни й асортимент залежать від магазину, тому в кожному місті беремо один магазин
// (з найбільшим асортиментом) і ведемо окрему історію цін.
//
//   node scraper/scrape.js                     — усі міста
//   node scraper/scrape.js --city Хмельницький — лише вказані міста (можна кілька через кому)
//   node scraper/scrape.js --repick            — заново вибрати магазини в містах
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CITIES } from './cities.js';
import { buildGroupMap, groupOf } from './groups.js';
import { buildCompare } from './compare.js';
import { writeChanges } from './changes.js';

const execFileAsync = promisify(execFile);

const BASE = 'https://www.atbmarket.com';
const DATA_DIR = path.resolve('site/data');
const STORES_FILE = path.resolve('scraper/stores.json');
const SHARDS = 100;
const DELAY_MS = 700;
const PARALLEL_CITIES = 2;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Найбільший розділ — за ним оцінюємо асортимент магазину.
const PROBE_CATEGORY = '/catalog/285-bakaliya';
// Скільки магазинів міста перевіряти під час вибору (рівномірно по списку).
const MAX_PROBE_STORES = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дата за київським часом, щоб нічний запуск не «переїжджав» на інший день.
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// Завантажуємо через curl: вбудований fetch у Node Cloudflare на сайті АТБ відхиляє (403).
async function curl(url, { cookie, jar, form, headers = [] } = {}, attempt = 1) {
  const a = ['-sS', '--compressed', '-A', UA, '-H', 'Accept-Language: uk-UA,uk;q=0.9', '-w', '\n%{http_code}'];
  if (cookie) a.push('-b', cookie);
  if (jar) a.push('-b', jar, '-c', jar);
  for (const h of headers) a.push('-H', h);
  if (form) a.push('--data', new URLSearchParams(form).toString());
  a.push(url);
  try {
    const { stdout } = await execFileAsync('curl', a, { maxBuffer: 50 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1));
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return stdout.slice(0, cut);
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    await sleep(2000 * attempt);
    return curl(url, { cookie, jar, form, headers }, attempt + 1);
  }
}

const storePage = (href, storeId) => curl(BASE + href, { cookie: `nstore_id=${storeId}` });

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------- Міста й магазини ----------

// Розділи верхнього рівня. «Акція 7 днів» потрібна: лише в ній є непродовольчі
// підрозділи (іграшки, посуд, одяг…). Підрозділи окремо не обходимо — вони дублюють батьківські.
function parseCategories($) {
  const hrefs = new Set();
  $('a.category-menu__link-wrap').each((_, a) => {
    const href = $(a).attr('href');
    if (href?.startsWith('/catalog/') && href !== '/catalog/economy' && href !== '/catalog/novetly') hrefs.add(href);
  });
  return [...hrefs];
}

function parseCityIds($) {
  const ids = new Map();
  $('#city option').each((_, o) => {
    const name = $(o).text().trim();
    if (name && $(o).attr('value')) ids.set(name, $(o).attr('value'));
  });
  return ids;
}

async function getCityStores(cityId, session) {
  const res = JSON.parse(
    await curl(BASE + '/site/getstore', {
      jar: session.jar,
      form: { city: cityId, '_csrf-shop': session.csrf },
      headers: [`X-CSRF-Token: ${session.csrf}`, 'X-Requested-With: XMLHttpRequest'],
    }),
  );
  const $ = cheerio.load(res.optselect || '');
  return $('option')
    .map((_, o) => ({ id: Number($(o).attr('value')), address: $(o).text().trim() }))
    .get()
    .filter((s) => s.id);
}

// Оцінка асортименту магазину: кількість товарів у найбільшому розділі.
async function probeStore(storeId) {
  const first = cheerio.load(await storePage(PROBE_CATEGORY, storeId));
  await sleep(DELAY_MS);
  const pages = first('.product-pagination__link')
    .map((_, a) => Number((first(a).attr('href') || '').match(/page=(\d+)/)?.[1] || 1))
    .get();
  const last = Math.max(1, ...pages);
  if (last === 1) return first('article.catalog-item').length;
  const $ = cheerio.load(await storePage(`${PROBE_CATEGORY}?page=${last}`, storeId));
  await sleep(DELAY_MS);
  return (last - 1) * 36 + $('article.catalog-item').length;
}

async function pickStore(city, cityId, session) {
  const stores = await getCityStores(cityId, session);
  await sleep(DELAY_MS);
  if (!stores.length) throw new Error('у місті немає магазинів');
  const step = Math.max(1, Math.floor(stores.length / MAX_PROBE_STORES));
  const candidates = stores.filter((_, i) => i % step === 0).slice(0, MAX_PROBE_STORES);
  let best = null;
  for (const s of candidates) {
    const score = await probeStore(s.id);
    if (!best || score > best.score) best = { ...s, score };
  }
  console.log(`[${city.name}] вибрано магазин ${best.id} (${best.address}), у «Бакалії» ${best.score} товарів; перевірено ${candidates.length} з ${stores.length}`);
  return { id: best.id, address: best.address, cityId: Number(cityId) };
}

// ---------- Каталог ----------

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
    // Мітки товару: знижка («-20% до 27.10») і рекламні кампанії («DC» з підказкою «Безмежний всесвіт DC»).
    const labels = card
      .find('.catalog-item__labels > .custom-product-label')
      .map((_, l) => {
        const el = $(l);
        const text = el.text().trim().replace(/\s+/g, ' ');
        const hint = (el.attr('data-tippy-content') || '').trim();
        // Підказку до знижки («Акційна пропозиція!…») не зберігаємо — вона однакова в усіх.
        return hint && !/^Акційна пропозиція/.test(hint) ? { text, hint } : { text };
      })
      .get()
      .filter((l) => l.text);
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
      labels,
    });
  });
  // Магазин, для якого сайт віддав сторінку, — щоб переконатися, що cookie спрацювала.
  return { items, store: Number($('[data-load-more]').attr('data-store')) || null };
}

async function scrapeCategory(href, storeId, products) {
  const seenHere = new Set();
  for (let page = 1; page < 500; page++) {
    const html = await storePage(`${href}${page > 1 ? `?page=${page}` : ''}`, storeId);
    await sleep(DELAY_MS);
    const { items, store } = parseCards(html);
    if (store && store !== storeId) throw new Error(`сайт віддав магазин ${store} замість ${storeId}`);
    // Сторінки після останньої повторюють останню — зупиняємось, коли сторінка нічого нового не дала.
    const fresh = items.filter((c) => !seenHere.has(c.id));
    if (!fresh.length) break;
    for (const c of fresh) {
      seenHere.add(c.id);
      if (!products.has(c.id)) products.set(c.id, c);
    }
  }
}

async function scrapeCity(city, store, categories, groupMap) {
  const started = Date.now();
  const dir = path.join(DATA_DIR, 'cities', city.slug);
  const historyDir = path.join(dir, 'history');
  const products = new Map();
  for (const href of categories) await scrapeCategory(href, store.id, products);

  const meta = await readJson(path.join(dir, 'meta.json'), { productCount: 0 });
  // Захист від часткового збою: не позначаємо товари зниклими, якщо зібрали підозріло мало.
  const fullScrape = products.size >= meta.productCount * 0.9;
  if (!fullScrape) console.warn(`[${city.name}] увага: зібрано ${products.size} проти ${meta.productCount} минулого разу`);

  // Історія: [дата, ціна, стара_ціна] лише при зміні; [дата, null] — товар зник з каталогу.
  await fs.mkdir(historyDir, { recursive: true });
  const shards = [];
  for (let i = 0; i < SHARDS; i++) {
    shards.push(await readJson(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), {}));
  }
  let changed = 0;
  const same = (h, p) => h && h[1] === p.price && (h[2] ?? null) === p.oldPrice;
  for (const p of products.values()) {
    p.group = groupOf(p.category, groupMap);
    const hist = (shards[p.id % SHARDS][p.id] ||= []);
    if (!same(hist.at(-1), p)) {
      // Повторний збір того ж дня замінює сьогоднішній запис (і не дублює вчорашню ціну).
      if (hist.at(-1)?.[0] === today) hist.pop();
      if (!same(hist.at(-1), p)) hist.push(p.oldPrice ? [today, p.price, p.oldPrice] : [today, p.price]);
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
        if (!products.has(Number(id)) && hist.at(-1)[1] !== null) hist.push([today, null]);
      }
    }
  }
  for (let i = 0; i < SHARDS; i++) {
    await fs.writeFile(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  }
  await writeChanges(dir, shards, products, today);

  const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  await fs.writeFile(path.join(dir, 'products.json'), JSON.stringify(list));
  const cityMeta = { updated: today, updatedAt: new Date().toISOString(), productCount: list.length, store };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(cityMeta, null, 2));
  console.log(`[${city.name}] ${list.length} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
  return cityMeta;
}

// ---------- Головне ----------

async function main() {
  const started = Date.now();
  const only = argValue('--city')?.split(',').map((s) => s.trim());
  const cities = only ? CITIES.filter((c) => only.includes(c.name) || only.includes(c.slug)) : CITIES;
  if (!cities.length) throw new Error(`Невідоме місто: ${only}`);

  // Сесія потрібна для запиту списку магазинів (CSRF-токен + cookie).
  const jar = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'atb-')), 'cookies.txt');
  const home = await curl(BASE + '/', { jar });
  const $ = cheerio.load(home);
  const session = { jar, csrf: $('meta[name="csrf-token"]').attr('content') };
  const categories = parseCategories($);
  const cityIds = parseCityIds($);
  const groupMap = buildGroupMap($);
  console.log(`Розділів: ${categories.length}, міст на сайті: ${cityIds.size}`);

  const stores = await readJson(STORES_FILE, {});
  for (const city of cities) {
    if (stores[city.slug] && !args.includes('--repick')) continue;
    const cityId = cityIds.get(city.name);
    if (!cityId) {
      console.warn(`[${city.name}] немає у списку міст АТБ — пропускаю`);
      continue;
    }
    try {
      stores[city.slug] = await pickStore(city, cityId, session);
      await fs.writeFile(STORES_FILE, JSON.stringify(stores, null, 2) + '\n');
    } catch (err) {
      console.error(`[${city.name}] не вдалося вибрати магазин: ${err.message}`);
    }
  }

  // Міста обробляємо по PARALLEL_CITIES одночасно.
  const queue = cities.filter((c) => stores[c.slug]);
  const results = {};
  const failed = [];
  await Promise.all(
    Array.from({ length: PARALLEL_CITIES }, async () => {
      for (let city; (city = queue.shift()); ) {
        try {
          results[city.slug] = await scrapeCity(city, stores[city.slug], categories, groupMap);
        } catch (err) {
          failed.push(city.name);
          console.error(`[${city.name}] ПОМИЛКА: ${err.message}`);
        }
      }
    }),
  );

  // Список міст для сайту: беремо всі міста, для яких уже є дані.
  const index = [];
  for (const city of CITIES) {
    const meta = results[city.slug] || (await readJson(path.join(DATA_DIR, 'cities', city.slug, 'meta.json'), null));
    if (meta) index.push({ slug: city.slug, name: city.name, address: meta.store.address, productCount: meta.productCount, updated: meta.updated });
  }
  await fs.writeFile(path.join(DATA_DIR, 'cities.json'), JSON.stringify(index, null, 2));
  await buildCompare(DATA_DIR);

  console.log(`Готово за ${Math.round((Date.now() - started) / 60000)} хв: міст ${Object.keys(results).length}, з помилками ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
  if (!Object.keys(results).length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
