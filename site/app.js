const PAGE = 48;
const SHARDS = 100;
const DAY = 86400000;

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const state = { cities: [], city: null, products: [], byId: new Map(), meta: null, shown: PAGE, shards: new Map() };

const fmtPrice = (v) => v.toFixed(2).replace('.', ',');
const parseDate = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmtDate = (t, withYear = true) => {
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return withYear ? `${dd}.${mm}.${d.getUTCFullYear()}` : `${dd}.${mm}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// У назвах АТБ трапляються латинські двійники в кириличних словах («Снідaнок», «Днiпромлин») і навпаки:
// зводимо змішане слово до тієї абетки, в яку перекладаються всі «чужі» літери (спершу пробуємо кирилицю).
const TO_CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const TO_LAT = Object.fromEntries(Object.entries(TO_CYR).map(([l, c]) => [c, l]));
const unmix = (w) => {
  if (!/[а-яіїєґ]/.test(w) || !/[a-z]/.test(w)) return w;
  if (/^[^a-z]*$/.test(w.replace(/[abcehikmoptxy]/g, ''))) return w.replace(/[a-z]/g, (c) => TO_CYR[c]);
  if (/^[^а-яіїєґ]*$/.test(w.replace(/[авсенікмортху]/g, ''))) return w.replace(/[авсенікмортху]/g, (c) => TO_LAT[c]);
  return w;
};
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[’'`ʼ]/g, '').replace(/[^\s]+/g, unmix);
const discount = (p) => (p.oldPrice ? 1 - p.price / p.oldPrice : 0);
const inflation = (p) => (isInflated(p.oldPrice, p.regular) ? p.oldPrice / p.regular - 1 : 0);
// Реальна знижка: від меншої з цін — «до знижки» чи тієї, що була перед акцією.
// Без акції — 0; якщо «акційна» ціна не нижча за звичайну — від'ємна.
const realSaving = (p) => (p.oldPrice ? 1 - p.price / Math.min(p.oldPrice, p.regular || p.oldPrice) : 0);

// ---------- Ціна за кг / л / шт ----------
// Кількість беремо з назви: «0,5 кг», «170мл», «4х115 г», «(76 ф/п х 2г)», «200+100 мл», «30 шт».
const QTY_UNIT = { кг: ['кг', 1], г: ['кг', 1e-3], гр: ['кг', 1e-3], л: ['л', 1], мл: ['л', 1e-3] };
const QTY_MULTI = /(\d+|\(\d+\+\d+\))\s*(?:ф\/п|пак\.?|шт\.?|капс\.?)?\s*[хx*]\s*(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
// «200+100 мл», «140 г+15 г», «350г + 100г» — акційна упаковка з бонусом.
const QTY_SUM = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)?\s*\+\s*(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
const QTY_ONE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
const QTY_PCS = /(?<![\d.,])(\d+)\s*шт(?![а-яіїєґa-z])/i;
const QTY_PCS_SUM = /(?<![\d.,])(\d+)\s*\+\s*(\d+)\s*шт(?![а-яіїєґa-z])/i;
// Тут «150 мл», «20 л» — місткість речі, а не вміст: рахуємо лише за штуку.
const PCS_ONLY = new Set(['Дім, одяг і дозвілля', 'Канцелярські товари']);
// Тут штуки важливіші за вагу («Пакети 30 шт 35 л», «Підгузки 40 шт»).
const PCS_FIRST = new Set(['Товари для дому', 'Товари для дітей']);
// «12», «2,5» або «(20+2)»
const qtyNum = (s) => (s[0] === '(' ? s.slice(1, -1).split('+').reduce((a, b) => a + +b, 0) : parseFloat(s.replace(',', '.')));

function parseWeight(name) {
  if (name.includes('№')) return null; // таблетки, вітаміни
  let m = name.match(QTY_MULTI);
  if (m) {
    const [unit, k] = QTY_UNIT[m[3].toLowerCase()];
    return { unit, qty: qtyNum(m[1]) * qtyNum(m[2]) * k };
  }
  const one = name.match(QTY_ONE);
  m = name.match(QTY_SUM);
  // Сума — лише якщо стоїть не пізніше за звичайну вагу («Хліб 350 г … 1г+2г» — це 350 г).
  if (m && m.index <= one.index) {
    const [unit, k2] = QTY_UNIT[m[4].toLowerCase()];
    const k1 = m[2] ? QTY_UNIT[m[2].toLowerCase()] : [unit, k2];
    if (k1[0] === unit) return { unit, qty: qtyNum(m[1]) * k1[1] + qtyNum(m[3]) * k2 };
  }
  if (one) {
    const [unit, k] = QTY_UNIT[one[2].toLowerCase()];
    return { unit, qty: qtyNum(one[1]) * k };
  }
  return null;
}
function parsePieces(name) {
  const s = name.match(QTY_PCS_SUM);
  if (s) return { unit: 'шт', qty: +s[1] + +s[2] };
  const m = name.match(QTY_PCS);
  return m && +m[1] > 1 ? { unit: 'шт', qty: +m[1] } : null;
}

// { price, unit } — ціна за 1 кг / л / шт; null, якщо кількість невідома або це й так ціна за одиницю.
function perUnit(p) {
  if (p.unit === 'кг') return null; // вагові товари вже мають ціну за кг
  const g = p.group || '';
  // Набори — лише за штуку; у «штучних» розділах навіть «1 шт» означає, що вага там — не вміст.
  const pcsOnly = PCS_ONLY.has(g) || /^наб[іi]р/i.test(p.name) || (PCS_FIRST.has(g) && QTY_PCS.test(p.name));
  const q = pcsOnly ? parsePieces(p.name) : parseWeight(p.name) || parsePieces(p.name);
  if (!q || !(q.qty > 0) || q.qty === 1) return null;
  return { price: p.price / q.qty, unit: q.unit };
}
const perHtml = (p, cls = 'per') => (p._per ? `<span class="${cls}">${fmtPrice(p._per.price)} ₴/${p._per.unit}</span>` : '');

// ---------- Дані ----------

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const cityDir = () => `data/cities/${state.city.slug}`;

async function loadCities() {
  state.cities = await fetch('data/cities.json').then((r) => r.json());
  const saved = store.get('city');
  state.city = state.cities.find((c) => c.slug === saved) || state.cities.find((c) => c.slug === 'kyiv') || state.cities[0];
  $('#city').innerHTML = state.cities
    .map((c) => `<option value="${c.slug}"${c === state.city ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  $('#city').addEventListener('change', async () => {
    state.city = state.cities.find((c) => c.slug === $('#city').value);
    store.set('city', state.city.slug);
    app.innerHTML = skeleton();
    await loadData();
    state.shown = PAGE;
    route();
  });
}

async function loadData() {
  const [products, meta] = await Promise.all([
    fetch(`${cityDir()}/products.json`).then((r) => r.json()),
    fetch(`${cityDir()}/meta.json`).then((r) => r.json()),
  ]);
  state.byId = new Map();
  state.shards = new Map();
  for (const p of products) {
    p._q = norm(`${p.name} ${p.brand ?? ''}`);
    p._per = perUnit(p);
    state.byId.set(p.id, p);
  }
  state.products = products;
  state.meta = meta;
  state.changes = await fetch(`${cityDir()}/changes.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  $('#updated').textContent = `${state.city.name}, магазин: ${meta.store.address} · ${meta.productCount.toLocaleString('uk')} товарів · оновлено ${fmtDate(parseDate(meta.updated))}`;

  const groups = new Map();
  for (const p of products) groups.set(p.group || 'Інше', (groups.get(p.group || 'Інше') || 0) + 1);
  const order = (g) => (GROUPS.has(g) ? [...GROUPS.keys()].indexOf(g) : GROUPS.size);
  state.groups = [...groups].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'uk'));
  // Якщо вибраного розділу в цьому місті немає — скидаємо фільтр.
  if (filters.group && !groups.has(filters.group)) filters.group = '';
  fillCategories();
  syncFavs();
}

// Підкатегорії лише вибраного розділу.
function fillCategories() {
  const counts = new Map();
  for (const p of state.products) {
    if (p.category && (!filters.group || (p.group || 'Інше') === filters.group)) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  }
  const cats = [...counts].sort((a, b) => a[0].localeCompare(b[0], 'uk'));
  if (filters.cat && !counts.has(filters.cat)) filters.cat = '';
  $('#cat').innerHTML =
    `<option value="">${filters.group ? 'Усі підкатегорії' : 'Усі категорії'}</option>` +
    cats.map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join('');
  $('#cat').value = filters.cat;
}

// Розділи в порядку показу та їхні іконки.
const GROUPS = new Map([
  ['Овочі та фрукти', '🥦'],
  ['Молочні продукти та яйця', '🥛'],
  ["М'ясо", '🥩'],
  ["Ковбаса і м'ясні делікатеси", '🥓'],
  ['Риба і морепродукти', '🐟'],
  ['Хлібобулочні вироби', '🍞'],
  ['Бакалія', '🌾'],
  ['Кондитерські вироби', '🍫'],
  ['Заморожені продукти', '🧊'],
  ['Кулінарія', '🍲'],
  ['Японська кухня', '🍣'],
  ['Чипси, снеки', '🍿'],
  ['Кава, чай', '☕'],
  ['Напої безалкогольні', '🥤'],
  ['Алкоголь', '🍷'],
  ['Дитяче харчування', '🍼'],
  ['Товари для дітей', '🧸'],
  ['Гігієна і косметика', '🧼'],
  ['Побутова хімія та непродовольчі товари', '🧴'],
  ['Товари для дому', '🏠'],
  ['Дім, одяг і дозвілля', '🛋️'],
  ['Товари для тварин', '🐾'],
  ['Канцелярські товари', '✏️'],
  ['Тютюнові вироби', '🚬'],
  ['Сертифікати та платіжні картки', '💳'],
]);

async function loadHistory(id) {
  const shard = id % SHARDS;
  if (!state.shards.has(shard)) {
    state.shards.set(shard, fetch(`${cityDir()}/history/${String(shard).padStart(2, '0')}.json`).then((r) => r.json()));
  }
  return (await state.shards.get(shard))[id] || [];
}

// ---------- Обране і сповіщення ----------
// favs[id] = { name, img, unit, target, seen: { місто: ціна } }.
// seen — остання ціна, яку користувач бачив; «подешевшало» = поточна ціна нижча за seen
// (і не вища за target, якщо його задано). Подорожчання тихо піднімає seen, щоб наступне зниження теж помітили.
// Копія лежить у Cache Storage — її читає service worker для фонової перевірки (localStorage йому недоступний).

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.6-4.7-9.4-9.6C1.4 7.6 3.6 4.5 7 4.5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.4 0 5.6 3.1 4.4 6.4-1.8 4.9-9.4 9.6-9.4 9.6Z"/></svg>';
const STATE_CACHE = 'pricetrail-state';
let favs = {};
try {
  favs = JSON.parse(store.get('favs') || '{}');
} catch {}
const isFav = (id) => id in favs;

function saveFavs() {
  store.set('favs', JSON.stringify(favs));
  if ('caches' in window) {
    caches
      .open(STATE_CACHE)
      .then((c) => c.put('state/favs', new Response(JSON.stringify({ favs, city: state.city.slug }))))
      .catch(() => {});
  }
  updateFavBadge();
}

function toggleFav(p) {
  if (isFav(p.id)) delete favs[p.id];
  else favs[p.id] = { name: p.name, img: p.img, unit: p.unit, target: null, seen: { [state.city.slug]: p.price } };
  saveFavs();
}

const favDrop = (p, f) => {
  const seen = f.seen?.[state.city.slug];
  return seen != null && p.price < seen - 0.004 && (!f.target || p.price <= f.target);
};
const favHits = () =>
  Object.entries(favs)
    .map(([id, f]) => ({ p: state.byId.get(+id), f }))
    .filter(({ p, f }) => p && favDrop(p, f));

function markSeen(ids) {
  for (const id of ids) {
    const p = state.byId.get(id);
    if (p && favs[id]) favs[id].seen = { ...favs[id].seen, [state.city.slug]: p.price };
  }
  saveFavs();
}

// Після завантаження міста: ціна, яку ще не бачили, стає «баченою»; подорожчання піднімає seen.
function syncFavs() {
  for (const [id, f] of Object.entries(favs)) {
    const p = state.byId.get(+id);
    if (!p) continue;
    Object.assign(f, { name: p.name, img: p.img, unit: p.unit });
    const seen = f.seen?.[state.city.slug];
    if (seen == null || p.price > seen) f.seen = { ...f.seen, [state.city.slug]: p.price };
  }
  saveFavs();
}

function updateFavBadge() {
  const n = state.byId.size ? favHits().length : 0;
  const el = $('#favN');
  el.textContent = n;
  el.hidden = !n;
  $('#favLink').setAttribute('aria-label', n ? `Обране: подешевшало ${n}` : 'Обране');
}

// Підказка при відкритті сайту — раз за сесію на той самий набір знижок.
function favToast() {
  const hits = favHits();
  const sig = hits.map(({ p }) => `${p.id}:${p.price}`).join();
  if (!hits.length || location.hash === '#/fav') return;
  try {
    if (sessionStorage.getItem('favToast') === sig) return;
    sessionStorage.setItem('favToast', sig);
  } catch {}
  const t = document.createElement('a');
  t.className = 'toast';
  t.href = '#/fav';
  t.innerHTML = `${HEART}<span>${hits.length === 1 ? `Подешевшало: ${esc(hits[0].p.name)}` : `З обраного подешевшало товарів: ${hits.length}`}</span>`;
  t.onclick = () => t.remove();
  document.body.append(t);
  setTimeout(() => t.remove(), 7000);
}

// Фонова перевірка (Periodic Background Sync): Chrome/Edge, коли сайт встановлено як застосунок.
async function registerPeriodicCheck() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return false;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state !== 'granted') return false;
    await reg.periodicSync.register('prices', { minInterval: 12 * 3600 * 1000 });
    return true;
  } catch {
    return false;
  }
}

async function notifyPanel() {
  const el = $('#notify');
  if (!el) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    el.innerHTML = '<p class="note">Цей браузер не підтримує сповіщення. Подешевшання з обраного видно тут і на значку ♥ угорі.</p>';
    return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    el.innerHTML = '<p class="note">🔕 Сповіщення заблоковано в налаштуваннях браузера для цього сайту.</p>';
    return;
  }
  if (perm === 'default') {
    el.innerHTML = `<button class="btn btn--primary" id="notifyOn">🔔 Увімкнути сповіщення</button>
      <p class="note">Повідомимо, коли товар з обраного подешевшає або ціна опуститься до вказаної вами.</p>`;
    $('#notifyOn').onclick = async () => {
      await Notification.requestPermission();
      notifyPanel();
    };
    return;
  }
  const bg = await registerPeriodicCheck();
  if (!$('#notify')) return;
  el.innerHTML = bg
    ? '<p class="note">🔔 Сповіщення увімкнено: ціни з обраного перевіряються у фоні раз на день, навіть коли сайт закрито.</p>'
    : '<p class="note">🔔 Сповіщення дозволено, але фонова перевірка в цьому браузері недоступна. Вона працює в Chrome або Edge, якщо встановити PriceTrail як застосунок (меню браузера → «Встановити» / «Додати на головний екран»). Доти подешевшання видно тут і на значку ♥ угорі.</p>';
}

function renderFavs() {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Обране — PriceTrail';
  scrollTo(0, 0);
  const items = Object.entries(favs).map(([id, f]) => ({ id: +id, f, p: state.byId.get(+id) }));
  const hits = items.filter(({ p, f }) => p && favDrop(p, f));
  const rest = items
    .filter((x) => !hits.includes(x))
    .sort((a, b) => (a.p ? 0 : 1) - (b.p ? 0 : 1) || a.f.name.localeCompare(b.f.name, 'uk'));
  const missing = ({ id, f }) => `<div class="card card--missing">
      <div class="card__media"><img class="card__img" src="${esc(f.img)}" alt="" loading="lazy"><button class="fav-btn" data-fav="${id}" aria-pressed="true" aria-label="Прибрати з обраного">${HEART}</button></div>
      <div class="card__body"><div class="card__name">${esc(f.name)}</div><div class="note">Немає в цьому магазині</div></div>
    </div>`;
  const tile = (x) => (x.p ? card(x.p, x.f.seen?.[state.city.slug]) : missing(x));
  let html = '<a class="back" href="#/">← Усі товари</a><h1 class="page-title">Обране</h1><div class="panel notify" id="notify"></div>';
  if (!items.length) {
    html += '<div class="empty"><b>♡</b>Тут поки порожньо<br><span class="note">Натисніть ♡ на картці товару — і ми підкажемо, коли він подешевшає</span></div>';
  } else {
    if (hits.length) {
      html += `<div class="section-head"><h2>Подешевшало · ${hits.length}</h2><button id="seenAll">Позначити переглянутим</button></div>
        <div class="grid">${hits.map(tile).join('')}</div>`;
    }
    if (rest.length) {
      html += `<div class="section-head"><h2>${hits.length ? 'Решта обраного' : 'Усі обрані'} · ${rest.length}</h2></div>
        <div class="grid">${rest.map(tile).join('')}</div>`;
    }
  }
  app.innerHTML = html;
  notifyPanel();
  const seenAll = $('#seenAll');
  if (seenAll) {
    seenAll.onclick = () => {
      markSeen(hits.map((x) => x.id));
      renderFavs();
    };
  }
}

function favActions(p) {
  const f = favs[p.id];
  return `<button class="btn fav-toggle" data-fav="${p.id}" aria-pressed="${!!f}">${HEART}${f ? 'В обраному' : 'Стежити за ціною'}</button>
    ${
      f
        ? `<label class="fav-target">Сповістити, коли подешевшає, або лише коли ціна не вища за
            <input type="number" id="favTarget" min="0" step="0.01" inputmode="decimal" placeholder="${fmtPrice(p.price * 0.9)}" value="${f.target ?? ''}"> грн</label>`
        : ''
    }`;
}

function bindFavTarget(p) {
  const input = $('#favTarget');
  if (!input) return;
  input.onchange = () => {
    const v = parseFloat(input.value.replace(',', '.'));
    favs[p.id].target = v > 0 ? v : null;
    saveFavs();
  };
}

// ---------- Фільтри ----------

const filters = { q: '', group: '', cat: '', sort: 'name', sale: false };
try {
  Object.assign(filters, JSON.parse(sessionStorage.getItem('filters') || '{}'));
} catch {}
// Параметри з адреси (?sort=inflated&q=молоко&sale=1) мають пріоритет — щоб можна було ділитися посиланнями.
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k === 'sale') filters.sale = v === '1';
  else if (k in filters) filters[k] = v;
}

function applyFilters() {
  try {
    sessionStorage.setItem('filters', JSON.stringify(filters));
  } catch {}
  state.shown = PAGE;
  if (location.hash.startsWith('#/p/') || location.hash === '#/fav' || location.hash.startsWith('#/today')) location.hash = '#/';
  else renderList();
}

function bindFilters() {
  $('#q').value = filters.q;
  $('#cat').value = filters.cat;
  $('#sort').value = filters.sort;
  $('#sale').checked = filters.sale;
  let t;
  const update = () => {
    filters.q = $('#q').value;
    filters.cat = $('#cat').value;
    filters.sort = $('#sort').value;
    filters.sale = $('#sale').checked;
    applyFilters();
  };
  // Серце на картці (вона — посилання, тож не даємо перейти) і кнопка на сторінці товару.
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fav]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(b.dataset.fav);
    const p = state.byId.get(id);
    if (p) toggleFav(p);
    else {
      delete favs[id];
      saveFavs();
    }
    if (location.hash === '#/fav') return renderFavs();
    if (b.classList.contains('fav-toggle')) {
      $('.fav-actions').innerHTML = favActions(p);
      bindFavTarget(p);
      return;
    }
    b.setAttribute('aria-pressed', isFav(id));
    b.setAttribute('aria-label', isFav(id) ? 'Прибрати з обраного' : 'Додати в обране');
  });
  // Клік по чипу розділу (ряд чипів перемальовується разом зі списком, тому делегуємо).
  app.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-group]');
    if (!chip) return;
    filters.group = chip.dataset.group;
    filters.cat = '';
    fillCategories();
    applyFilters();
  });
  $('#q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(update, 150);
  });
  for (const id of ['#cat', '#sort', '#sale']) $(id).addEventListener('change', update);
}

const perRank = (p) => (p.unit === 'кг' || (p._per && p._per.unit !== 'шт') ? 0 : p._per ? 1 : 2);
const perValue = (p) => (p._per ? p._per.price : p.price);

function filtered() {
  const words = norm(filters.q).split(/\s+/).filter(Boolean);
  let list = state.products.filter(
    (p) =>
      (!filters.group || (p.group || 'Інше') === filters.group) &&
      (!filters.cat || p.category === filters.cat) &&
      (!filters.sale || p.oldPrice) &&
      words.every((w) => p._q.includes(w)),
  );
  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    discount: (a, b) => discount(b) - discount(a),
    // На скільки «ціна до знижки» вища за звичайну ціну перед акцією; незавищені — після, за назвою.
    inflated: (a, b) => inflation(b) - inflation(a),
    // Акції з найбільшою реальною знижкою; далі товари без акції, наприкінці — фіктивні акції.
    real: (a, b) => realSaving(b) - realSaving(a),
    changed: (a, b) => (b.changed || '').localeCompare(a.changed || ''),
    // Спершу за кг/л (вагові товари — за їхньою ціною), потім за штуку, решта — за ціною.
    'per-asc': (a, b) => perRank(a) - perRank(b) || perValue(a) - perValue(b),
  };
  if (sorters[filters.sort]) list = [...list].sort(sorters[filters.sort]);
  return list;
}

// ---------- Список ----------

// from — попередня ціна, яку показуємо поруч («↓ було 34,90»): на сторінках «Обране» і «Що змінилося».
function card(p, from) {
  const sale = p.oldPrice ? `<span class="badge">−${Math.round(discount(p) * 100)}%</span>` : '';
  let flags = '';
  if (isInflated(p.oldPrice, p.regular)) {
    flags += `<span class="tag tag--warn" title="Перед акцією було ${fmtPrice(p.regular)} грн — ціну до знижки завищено">⚠ до акції ${fmtPrice(p.regular)}</span>`;
  }
  if (from != null && Math.abs(p.price - from) > 0.004) {
    const up = p.price > from;
    flags += `<span class="tag tag--${up ? 'up' : 'down'}" title="Попередня ціна ${fmtPrice(from)} грн">${up ? '↑' : '↓'} було ${fmtPrice(from)}</span>`;
  } else if (p.prev && p.prev !== p.price && !p.oldPrice) {
    const up = p.price > p.prev;
    const change = Math.abs((p.price / p.prev - 1) * 100);
    flags += `<span class="tag tag--${up ? 'up' : 'down'}" title="Було ${fmtPrice(p.prev)}">${up ? '↑' : '↓'} ${change < 1 ? change.toFixed(1).replace('.', ',') : Math.round(change)}%</span>`;
  }
  return `<a class="card" href="#/p/${p.id}">
    <div class="card__media">
      <img class="card__img" src="${esc(p.img)}" alt="" loading="lazy" decoding="async">
      ${sale}
      <button class="fav-btn" data-fav="${p.id}" aria-pressed="${isFav(p.id)}" aria-label="${isFav(p.id) ? 'Прибрати з обраного' : 'Додати в обране'}">${HEART}</button>
    </div>
    <div class="card__body">
      <div class="card__name">${esc(p.name)}</div>
      <div class="card__price">
        <span class="price ${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} <small>₴/${esc(p.unit)}</small></span>
        ${p.oldPrice ? `<span class="old">${fmtPrice(p.oldPrice)}</span>` : ''}
        ${perHtml(p)}
      </div>
      <div class="card__flags">${flags}</div>
    </div>
  </a>`;
}

const skeleton = (n = 12) =>
  `<p class="count">&nbsp;</p><div class="grid">${'<div class="card skeleton"><div class="card__media"></div><div class="card__body"><div class="sk"></div><div class="sk" style="width:60%"></div><div class="sk" style="width:40%;height:18px;margin-top:8px"></div></div></div>'.repeat(n)}</div>`;

// Ряд розділів на комп'ютері: стрілки, прокрутка коліщатком і перетягування мишею.
function initGroupsRow(scrollLeft) {
  const row = $('.groups');
  const left = $('.gscroll--left');
  const right = $('.gscroll--right');
  const updateArrows = () => {
    left.disabled = row.scrollLeft <= 2;
    right.disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
  };
  if (scrollLeft != null) row.scrollLeft = scrollLeft;
  else {
    const active = row.querySelector('[aria-pressed=true]');
    if (active) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }
  updateArrows();
  row.addEventListener('scroll', updateArrows, { passive: true });
  for (const b of [left, right]) {
    b.onclick = () => row.scrollBy({ left: Number(b.dataset.dir) * row.clientWidth * 0.7, behavior: 'smooth' });
  }
  // Вертикальне коліщатко миші → горизонтальна прокрутка (поки є куди крутити).
  row.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = row.scrollWidth - row.clientWidth;
      if ((e.deltaY < 0 && row.scrollLeft <= 0) || (e.deltaY > 0 && row.scrollLeft >= max)) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  // Перетягування мишею; якщо тягнули — клік по чипу не спрацьовує.
  let drag = null;
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, left: row.scrollLeft, moved: false };
  });
  row.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 5) {
      drag.moved = true;
      row.classList.add('is-dragging');
    }
    if (drag.moved) row.scrollLeft = drag.left - dx;
  });
  const end = () => {
    if (drag?.moved) {
      const block = (e) => e.stopPropagation();
      row.addEventListener('click', block, { capture: true });
      setTimeout(() => {
        row.removeEventListener('click', block, { capture: true });
        row.classList.remove('is-dragging');
      });
    }
    drag = null;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointerleave', end);
}

// ---------- Що змінилося ----------
// changes.json будує scraper/changes.js: зміни останнього збору відносно попереднього дня.

const changeKind = (c) => (!c.fromOld && c.toOld ? 'sale' : c.fromOld && !c.toOld ? 'saleEnd' : c.to < c.from ? 'down' : 'up');
const pctChange = (c) => (c.to / c.from - 1) * 100;

function todayData() {
  const ch = state.changes;
  if (!ch) return null;
  const rows = ch.prices.map((c) => ({ c, p: state.byId.get(c.id), kind: changeKind(c) })).filter((r) => r.p);
  const tabs = [
    ['down', '↓ Подешевшало', rows.filter((r) => r.c.to < r.c.from).sort((a, b) => pctChange(a.c) - pctChange(b.c))],
    ['up', '↑ Подорожчало', rows.filter((r) => r.c.to > r.c.from).sort((a, b) => pctChange(b.c) - pctChange(a.c))],
    ['sale', '% Нові акції', rows.filter((r) => r.kind === 'sale').sort((a, b) => discount(b.p) - discount(a.p))],
    ['new', '✦ Нові товари', ch.added.map((id) => ({ p: state.byId.get(id) })).filter((r) => r.p)],
    ['gone', '✕ Зникли', ch.removed.map((r) => ({ gone: r }))],
  ];
  return { date: ch.date, tabs };
}

function todayBanner() {
  const d = todayData();
  if (!d) return '';
  const n = (k) => d.tabs.find((t) => t[0] === k)[2].length;
  const parts = [
    n('down') && `<span class="tb__down">↓ ${n('down')}</span>`,
    n('up') && `<span class="tb__up">↑ ${n('up')}</span>`,
    n('sale') && `<span>% ${n('sale')} нових акцій</span>`,
    n('new') && `<span>✦ ${n('new')} нових товарів</span>`,
  ].filter(Boolean);
  if (!parts.length && !n('gone')) return '';
  return `<a class="today-banner" href="#/today"><b>Що змінилося ${fmtDate(parseDate(d.date), false)}</b>${parts.join('')}<span class="today-banner__go">Переглянути →</span></a>`;
}

function renderToday(tab) {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Що змінилося — PriceTrail';
  scrollTo(0, 0);
  const d = todayData();
  const head = '<a class="back" href="#/">← Усі товари</a><h1 class="page-title">Що змінилося</h1>';
  if (!d) {
    app.innerHTML = `${head}<div class="empty"><b>🗓</b>Змін поки немає<br><span class="note">Стрічка з'явиться після наступного щоденного збору цін</span></div>`;
    return;
  }
  const tabs = d.tabs.filter((t) => t[2].length);
  const cur = tabs.find((t) => t[0] === tab) || tabs[0];
  const stale = d.date !== state.meta.updated ? ` (останній збір у цьому місті — ${fmtDate(parseDate(state.meta.updated))})` : '';
  let html = `${head}<p class="note today-sub">${state.city.name}: зміни за ${fmtDate(parseDate(d.date))} порівняно з попереднім днем${stale}.</p>`;
  if (!cur) {
    app.innerHTML = `${html}<div class="empty"><b>😌</b>Ціни не змінилися<br><span class="note">Порівняно з попереднім днем — жодних змін</span></div>`;
    return;
  }
  html += `<div class="seg today-tabs" role="tablist">${tabs
    .map(([k, label, list]) => `<a href="#/today/${k}" role="tab" aria-selected="${k === cur[0]}">${label} <small>${list.length}</small></a>`)
    .join('')}</div>`;
  const tile = (r) =>
    r.gone
      ? `<div class="card card--missing">
          <div class="card__media"><img class="card__img" src="${esc(r.gone.img)}" alt="" loading="lazy"></div>
          <div class="card__body"><div class="card__name">${esc(r.gone.name)}</div>
            <div class="card__price"><span class="price">${fmtPrice(r.gone.price)} <small>₴/${esc(r.gone.unit)}</small></span></div>
            <div class="note">Зник з каталогу</div></div>
        </div>`
      : card(r.p, r.c && r.c.to !== r.c.from ? r.c.from : undefined);
  html += `<div class="grid">${cur[2].map(tile).join('')}</div>`;
  app.innerHTML = html;
}

function renderList() {
  document.querySelector('.top').classList.remove('is-product');
  document.title = 'PriceTrail — історія цін';
  const list = filtered();
  // Ряд розділів перемальовується разом зі списком — зберігаємо його горизонтальну прокрутку.
  const scrollLeft = $('.groups')?.scrollLeft;
  const chip = (g, label, n) =>
    `<button class="gchip" data-group="${esc(g)}" aria-pressed="${filters.group === g}">${label}${n != null ? `<small>${n}</small>` : ''}</button>`;
  const groupsRow = `<div class="groups-wrap">
    <button class="gscroll gscroll--left" data-dir="-1" aria-label="Прокрутити розділи ліворуч">‹</button>
    <nav class="groups" aria-label="Розділи">${chip('', 'Усі товари')}${state.groups
      .map(([g, n]) => chip(g, `<span aria-hidden="true">${GROUPS.get(g) || '📦'}</span>${esc(g)}`, n))
      .join('')}</nav>
    <button class="gscroll gscroll--right" data-dir="1" aria-label="Прокрутити розділи праворуч">›</button>
  </div>`;
  if (!list.length) {
    app.innerHTML = `${groupsRow}<div class="empty"><b>🔍</b>Нічого не знайдено<br><span class="note">Спробуйте іншу назву або приберіть фільтри</span></div>`;
    initGroupsRow(scrollLeft);
    return;
  }
  let count = `Знайдено: ${list.length.toLocaleString('uk')}`;
  if (filters.sort === 'inflated') {
    const n = list.filter((p) => inflation(p) > 0).length;
    count += n ? ` · із завищеною «ціною до знижки»: ${n}` : ' · акцій із завищеною «ціною до знижки» поки не виявлено';
  }
  if (filters.sort === 'real') {
    const n = list.filter((p) => realSaving(p) > 0.005).length;
    count += ` · реальних акцій: ${n.toLocaleString('uk')}`;
  }
  app.innerHTML = `${filters.q ? '' : todayBanner()}${groupsRow}<p class="count">${count}</p>
    <div class="grid">${list.slice(0, state.shown).map((p) => card(p)).join('')}</div>
    ${list.length > state.shown ? '<button class="more" id="more">Показати ще</button>' : ''}`;
  initGroupsRow(scrollLeft);
  const more = $('#more');
  if (more) {
    more.onclick = () => {
      state.shown += PAGE;
      const y = scrollY;
      renderList();
      scrollTo(0, y);
    };
    // Автопідвантаження при прокрутці до кінця.
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) {
        obs.disconnect();
        more.click();
      }
    }, { rootMargin: '600px' }).observe(more);
  }
}

// ---------- Сторінка товару ----------

const RANGES = [
  ['1м', 30],
  ['3м', 91],
  ['6м', 182],
  ['Рік', 365],
  ['Усе', Infinity],
];

// Мітки з сайту АТБ: знижка («-20% до 27.10») і рекламні кампанії, які на АТБ мають лише
// короткий значок («DC») з підказкою («Безмежний всесвіт DC») — показуємо підказку.
const KNOWN_HINTS = { DC: 'Безмежний всесвіт DC' }; // для даних, зібраних до появи поля labels
function labelsHtml(p) {
  const labels = p.labels || (p.label ? [{ text: p.label, hint: KNOWN_HINTS[p.label] }] : []);
  return labels
    .map((l) =>
      l.hint
        ? `<span class="product__promo" title="Рекламна кампанія АТБ">🎁 ${esc(l.hint)}</span>`
        : `<span class="product__label">${esc(l.text)}</span>`,
    )
    .join('');
}

async function renderProduct(id) {
  document.querySelector('.top').classList.add('is-product');
  const p = state.byId.get(id);
  scrollTo(0, 0);
  if (!p) {
    app.innerHTML = '<a class="back" href="#/">← Усі товари</a><p class="status">Товар не знайдено — можливо, його вже немає в каталозі.</p>';
    return;
  }
  document.title = `${p.name} — PriceTrail`;
  app.innerHTML = `<a class="back" href="#/">← Усі товари</a>
    <div class="product">
      <div class="product__media"><img class="product__img" src="${esc(p.img)}" alt=""></div>
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="chips">${[p.group, p.category, p.brand].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <div class="product__price">
          <span class="price ${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} <small>грн/${esc(p.unit)}</small></span>
          ${p.oldPrice ? `<span class="old">${fmtPrice(p.oldPrice)}</span>` : ''}
          ${labelsHtml(p)}
          ${p._per ? `<span class="product__per">${fmtPrice(p._per.price)} грн за 1 ${p._per.unit}</span>` : ''}
        </div>
        <div id="warn"></div>
        <div class="product__actions"><span class="fav-actions">${favActions(p)}</span><a class="btn btn--primary" href="https://www.atbmarket.com${esc(p.url)}" target="_blank" rel="noopener">Відкрити на atbmarket.com ↗</a></div>
      </div>
    </div>
    <section class="panel">
      <div class="panel__head">
        <h2>Історія ціни</h2>
        <div class="seg ranges" role="group" aria-label="Період">${RANGES.map(([l], i) => `<button data-r="${i}" aria-pressed="${i === 4}">${l}</button>`).join('')}</div>
      </div>
      <div class="chart" id="chart"><div class="sk" style="height:280px;border-radius:12px"></div></div>
      <div id="stats"></div>
    </section>
    <section class="panel" id="compare">
      <div class="panel__head"><h2>Ціна в інших містах</h2></div>
      <div class="sk" style="height:120px;border-radius:12px"></div>
    </section>`;
  bindFavTarget(p);
  renderCompare($('#compare'), p);
  // Користувач побачив поточну ціну — знижка «з обраного» для цього товару вже не нова.
  if (isFav(id) && favDrop(p, favs[id])) markSeen([id]);

  const hist = await loadHistory(id);
  if (state.byId.get(id) !== p || !$('#chart')) return;
  const cur = segments(hist, Infinity).at(-1);
  if (p.oldPrice && cur?.inflated) {
    $('#warn').innerHTML = `<p class="warn-box"><b>⚠</b><span>Ціну до знижки завищено: перед акцією товар коштував <b>${fmtPrice(cur.ref)} грн</b>, а не ${fmtPrice(p.oldPrice)} грн.
      ${realDiscount(p.price, cur.ref)}, а не знижка ${pct(p.price, p.oldPrice)}%.</span></p>`;
  }
  let range = 4;
  const draw = () => {
    renderChart($('#chart'), hist, RANGES[range][1], p.unit);
    renderStats($('#stats'), hist, RANGES[range][1], p.unit);
  };
  for (const b of document.querySelectorAll('.ranges button')) {
    b.onclick = () => {
      range = +b.dataset.r;
      for (const x of document.querySelectorAll('.ranges button')) x.setAttribute('aria-pressed', x === b);
      draw();
    };
  }
  draw();
  const ro = new ResizeObserver(() => $('#chart') && draw());
  ro.observe($('#chart'));
  addEventListener('hashchange', () => ro.disconnect(), { once: true });
}

// ---------- Ціни в інших містах ----------
// data/compare/NN.json: { id: { місто: ціна | [ціна, ціна_до_знижки] } } — будує scraper/compare.js.

const compareShards = new Map();
async function loadCompare(id) {
  const shard = String(id % SHARDS).padStart(2, '0');
  if (!compareShards.has(shard)) {
    compareShards.set(shard, fetch(`data/compare/${shard}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return (await compareShards.get(shard))[id] || {};
}

const COMPARE_SHOWN = 8;

async function renderCompare(el, p) {
  const prices = await loadCompare(p.id);
  if (!el.isConnected) return;
  const rows = state.cities
    .filter((c) => prices[c.slug] != null)
    .map((c) => {
      const v = prices[c.slug];
      const [price, old] = Array.isArray(v) ? v : [v, null];
      return { c, price, old };
    })
    .sort((a, b) => a.price - b.price || a.c.name.localeCompare(b.c.name, 'uk'));
  if (rows.length < 2) {
    el.remove();
    return;
  }
  const here = rows.find((r) => r.c === state.city);
  const min = rows[0].price;
  const max = rows.at(-1).price;
  const cheapest = rows.filter((r) => r.price === min).map((r) => r.c.name);
  const absent = state.cities.length - rows.length;

  let summary;
  if (min === max) summary = `Однакова ціна в усіх ${rows.length} містах.`;
  else {
    summary = `Найдешевше — ${esc(cheapest.slice(0, 3).join(', '))}${cheapest.length > 3 ? ` і ще ${cheapest.length - 3}` : ''}: <b>${fmtPrice(min)} грн</b>. Найдорожче — <b>${fmtPrice(max)} грн</b>.`;
    if (here) {
      const cheaper = rows.filter((r) => r.price < here.price).length;
      summary += here.price === min ? ` У місті ${esc(here.c.name)} — найнижча ціна.` : ` У місті ${esc(here.c.name)} на ${Math.round((here.price / min - 1) * 100) || '<1'}% дорожче за найдешевше; дешевше — у ${cheaper} з ${rows.length - 1} міст.`;
    }
  }

  const pos = (v) => (max > min ? ((v - min) / (max - min)) * 100 : 50);
  const diff = (r) => {
    if (r === here) return '<span class="crow__diff">ваше місто</span>';
    if (!here) return '';
    const d = (r.price / here.price - 1) * 100;
    if (Math.abs(d) < 0.5) return '<span class="crow__diff">так само</span>';
    return `<span class="crow__diff crow__diff--${d < 0 ? 'down' : 'up'}">${d < 0 ? '−' : '+'}${Math.abs(d) < 1 ? '<1' : Math.round(Math.abs(d))}%</span>`;
  };
  const row = (r, i) => `<button class="crow${r === here ? ' is-here' : ''}${i >= COMPARE_SHOWN && r !== here ? ' is-extra' : ''}" data-city="${r.c.slug}"
      title="${r === here ? 'Поточне місто' : `Перейти до міста ${esc(r.c.name)}`}">
      <span class="crow__city">${esc(r.c.name)}</span>
      <span class="crow__track" aria-hidden="true"><i style="left:${pos(r.price).toFixed(1)}%"></i></span>
      <span class="crow__price${r.old ? ' price--sale' : ''}">${fmtPrice(r.price)}${r.old ? ` <span class="old">${fmtPrice(r.old)}</span>` : ''}</span>
      ${diff(r)}
    </button>`;
  const extra = rows.filter((r, i) => i >= COMPARE_SHOWN && r !== here).length;
  el.innerHTML = `<div class="panel__head"><h2>Ціна в інших містах</h2></div>
    <p class="compare__summary">${summary}</p>
    <div class="crows">${rows.map(row).join('')}</div>
    ${extra ? `<button class="compare__more" id="compareMore">Показати всі міста (${rows.length})</button>` : ''}
    <p class="note">Ціни за ${fmtDate(parseDate(state.meta.updated))}, по одному магазину в кожному місті${absent ? `; у ${absent} містах товару немає в асортименті` : ''}. Натисніть місто, щоб перейти до нього.</p>`;
  const more = $('#compareMore');
  if (more) {
    more.onclick = () => {
      el.classList.add('is-open');
      more.remove();
    };
  }
  el.onclick = (e) => {
    const b = e.target.closest('[data-city]');
    if (!b || b.dataset.city === state.city.slug) return;
    $('#city').value = b.dataset.city;
    $('#city').dispatchEvent(new Event('change'));
  };
}

// Акцію вважаємо «завищеною», якщо ціна до знижки вища за звичайну ціну перед акцією (з допуском 0,5%).
const isInflated = (old, regular) => !!(old && regular && old > regular * 1.005);
const pct = (a, b) => Math.round((1 - a / b) * 100);
// «Реальна знижка» відносно ціни перед акцією; якщо ціна натомість зросла — так і кажемо.
const realDiscount = (price, ref) =>
  price < ref ? `Реальна знижка — <b>${pct(price, ref)}%</b>` : `Насправді це <b>подорожчання на ${-pct(price, ref)}%</b>`;

// Перетворює точки змін у відрізки в межах періоду.
// ref — звичайна ціна, що діяла перед акцією (для перевірки «ціни до знижки»).
function segments(hist, days) {
  const end = parseDate(state.meta.updated) + DAY;
  const start = Number.isFinite(days) ? end - days * DAY : -Infinity;
  const segs = [];
  let regular = null;
  hist.forEach(([d, price, old], i) => {
    const from = parseDate(d);
    const to = i + 1 < hist.length ? parseDate(hist[i + 1][0]) : end;
    if (price != null && !old) regular = price;
    if (price == null || to <= start) return;
    const ref = old ? regular : null;
    segs.push({ from: Math.max(from, start), to, price, old: old ?? null, ref, inflated: isInflated(old, ref) });
  });
  return segs;
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

function renderChart(el, hist, days, unit) {
  const segs = segments(hist, days);
  if (!segs.length) {
    el.innerHTML = '<p class="note">Немає даних за цей період.</p>';
    return;
  }
  const W = el.clientWidth || 600;
  const H = 260;
  const m = { l: 46, r: 12, t: 12, b: 26 };
  const x0 = segs[0].from;
  const x1 = segs.at(-1).to;
  const values = segs.flatMap((s) => [s.price, s.old, s.inflated ? s.ref : null]).filter((v) => v != null);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < hi * 0.04) {
    const pad = Math.max(hi * 0.05, 1);
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.ceil(hi / step) * step;
  const X = (t) => m.l + ((t - x0) / Math.max(x1 - x0, DAY)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
  }
  const spanDays = (x1 - x0) / DAY;
  const ticks = Math.max(1, Math.min(6, Math.floor((W - m.l - m.r) / 90), Math.round(spanDays)));
  let xt = '';
  for (let i = 0; i < ticks; i++) {
    const t = ticks === 1 ? x0 : x0 + ((x1 - x0 - DAY) * i) / (ticks - 1);
    const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
    xt += `<text x="${X(t)}" y="${H - 6}" text-anchor="${anchor}">${fmtDate(t, spanDays > 300)}</text>`;
  }

  // Ступінчаста лінія; розрив, якщо товар зникав з каталогу.
  let path = '';
  let area = '';
  let bands = '';
  let oldPath = ''; // «ціна до знижки» під час акцій
  let inflPath = ''; // те саме, коли її завищено
  let refPath = ''; // фактична звичайна ціна перед завищеною акцією
  segs.forEach((s, i) => {
    const contiguous = i > 0 && segs[i - 1].to === s.from;
    path += `${contiguous ? '' : `M${X(s.from)},`}${contiguous ? 'V' : ''}${Y(s.price)}H${X(s.to)}`;
    area += `M${X(s.from)},${Y(lo)}V${Y(s.price)}H${X(s.to)}V${Y(lo)}Z`;
    if (!s.old) return;
    bands += `<rect class="sale-band" x="${X(s.from)}" y="${m.t}" width="${X(s.to) - X(s.from)}" height="${H - m.t - m.b}"/>`;
    if (s.inflated) {
      inflPath += `M${X(s.from)},${Y(s.ref)}V${Y(s.old)}H${X(s.to)}`;
      refPath += `M${X(s.from)},${Y(s.ref)}H${X(s.to)}`;
    } else {
      oldPath += `M${X(s.from)},${Y(s.old)}H${X(s.to)}`;
    }
  });
  const hasSale = segs.some((s) => s.old);
  const hasInflated = segs.some((s) => s.inflated);
  const swatch = (cls) => `<svg width="18" height="10" aria-hidden="true"><path class="${cls}" d="M1,5H17"/></svg>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Графік ціни">
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--chart-line);stop-opacity:.22"/>
        <stop offset="1" style="stop-color:var(--chart-line);stop-opacity:0"/>
      </linearGradient></defs>
      <g class="axis">${grid}${xt}</g>
      ${bands}
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
      <path class="old-line" d="${oldPath}"/>
      <path class="ref-line" d="${refPath}"/>
      <path class="old-line old-line--inflated" d="${inflPath}"/>
      <line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
      <circle class="dot" r="5" visibility="hidden"/>
      <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>
    </svg>
    <div class="tip" hidden></div>
    <div class="legend">
      <span><i style="background:var(--chart-line)"></i>Ціна, грн/${esc(unit)}</span>
      ${hasSale ? '<span><i style="background:var(--sale);opacity:.25"></i>Акція</span>' : ''}
      ${oldPath ? `<span>${swatch('old-line')}Ціна до знижки</span>` : ''}
      ${hasInflated ? `<span>${swatch('old-line old-line--inflated')}⚠ Завищена ціна до знижки</span><span>${swatch('ref-line')}Ціна перед акцією</span>` : ''}
    </div>
    ${spanDays < 3 ? `<p class="note">Історія збирається з ${fmtDate(x0)}. Графік наповнюватиметься щодня.</p>` : ''}`;

  const svg = el.querySelector('svg');
  const cross = el.querySelector('.cross');
  const dot = el.querySelector('.dot');
  const tip = el.querySelector('.tip');
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const day = Math.floor(t / DAY) * DAY;
    const s = segs.find((g) => day >= g.from && day < g.to);
    if (!s) return hide();
    const cx = X(day + DAY / 2);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', Y(s.price));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    let html = `${fmtDate(day)}<br><b>${fmtPrice(s.price)} грн</b>`;
    if (s.old) html += ` <span class="old">${fmtPrice(s.old)}</span> акція −${pct(s.price, s.old)}%`;
    if (s.inflated) {
      html += `<br><span class="warn">⚠ Перед акцією було ${fmtPrice(s.ref)} грн</span><br>${realDiscount(s.price, s.ref)}`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const left = (cx / W) * r.width;
    tip.style.left = `${Math.min(Math.max(left, tip.offsetWidth / 2), r.width - tip.offsetWidth / 2)}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

function renderStats(el, hist, days, unit) {
  const segs = segments(hist, days);
  if (!segs.length) {
    el.innerHTML = '';
    return;
  }
  let sum = 0;
  let len = 0;
  for (const s of segs) {
    sum += s.price * (s.to - s.from);
    len += s.to - s.from;
  }
  const prices = segs.map((s) => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const first = parseDate(hist[0][0]);
  const rows = hist
    .slice()
    .reverse()
    .map(([d, p, o]) => `<tr><td>${fmtDate(parseDate(d))}</td><td>${p == null ? 'немає в каталозі' : fmtPrice(p)}</td><td>${o ? fmtPrice(o) : ''}</td></tr>`)
    .join('');
  el.innerHTML = `<div class="stats">
      <div class="stat"><div class="stat__k">Мінімум</div><div class="stat__v">${fmtPrice(min)} грн</div></div>
      <div class="stat"><div class="stat__k">Максимум</div><div class="stat__v">${fmtPrice(max)} грн</div></div>
      <div class="stat"><div class="stat__k">Середня</div><div class="stat__v">${fmtPrice(sum / len)} грн</div></div>
      <div class="stat"><div class="stat__k">Відстежується з</div><div class="stat__v">${fmtDate(first)}</div></div>
    </div>
    <details class="table"><summary>Таблиця змін ціни (${hist.length})</summary>
      <div class="tablewrap"><table><thead><tr><th>Дата</th><th>Ціна, грн/${esc(unit)}</th><th>Ціна до знижки</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
}

// ---------- Маршрутизація ----------

function route() {
  const m = location.hash.match(/^#\/p\/(\d+)/);
  const onFavs = location.hash === '#/fav';
  if (onFavs) $('#favLink').setAttribute('aria-current', 'page');
  else $('#favLink').removeAttribute('aria-current');
  const today = location.hash.match(/^#\/today(?:\/(\w+))?/);
  const render = () => (m ? renderProduct(Number(m[1])) : onFavs ? renderFavs() : today ? renderToday(today[1]) : renderList());
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(render);
  else render();
}

app.innerHTML = skeleton();
loadCities()
  .then(loadData)
  .then(() => {
    bindFilters();
    addEventListener('hashchange', route);
    route();
    favToast();
  })
  .catch((err) => {
    console.error(err);
    app.innerHTML = '<p class="status">Не вдалося завантажити дані.</p>';
  });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
