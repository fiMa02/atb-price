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
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[’'`ʼ]/g, '');
const discount = (p) => (p.oldPrice ? 1 - p.price / p.oldPrice : 0);
const inflation = (p) => (isInflated(p.oldPrice, p.regular) ? p.oldPrice / p.regular - 1 : 0);
// Реальна знижка: від меншої з цін — «до знижки» чи тієї, що була перед акцією.
// Без акції — 0; якщо «акційна» ціна не нижча за звичайну — від'ємна.
const realSaving = (p) => (p.oldPrice ? 1 - p.price / Math.min(p.oldPrice, p.regular || p.oldPrice) : 0);

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
    state.byId.set(p.id, p);
  }
  state.products = products;
  state.meta = meta;
  $('#updated').textContent = `${state.city.name}, магазин: ${meta.store.address} · ${meta.productCount.toLocaleString('uk')} товарів · оновлено ${fmtDate(parseDate(meta.updated))}`;

  const groups = new Map();
  for (const p of products) groups.set(p.group || 'Інше', (groups.get(p.group || 'Інше') || 0) + 1);
  const order = (g) => (GROUPS.has(g) ? [...GROUPS.keys()].indexOf(g) : GROUPS.size);
  state.groups = [...groups].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'uk'));
  // Якщо вибраного розділу в цьому місті немає — скидаємо фільтр.
  if (filters.group && !groups.has(filters.group)) filters.group = '';
  fillCategories();
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
  if (location.hash.startsWith('#/p/')) location.hash = '#/';
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
  };
  if (sorters[filters.sort]) list = [...list].sort(sorters[filters.sort]);
  return list;
}

// ---------- Список ----------

function card(p) {
  const sale = p.oldPrice ? `<span class="badge">−${Math.round(discount(p) * 100)}%</span>` : '';
  let flags = '';
  if (isInflated(p.oldPrice, p.regular)) {
    flags += `<span class="tag tag--warn" title="Перед акцією було ${fmtPrice(p.regular)} грн — ціну до знижки завищено">⚠ до акції ${fmtPrice(p.regular)}</span>`;
  }
  if (p.prev && p.prev !== p.price && !p.oldPrice) {
    const up = p.price > p.prev;
    const change = Math.abs((p.price / p.prev - 1) * 100);
    flags += `<span class="tag tag--${up ? 'up' : 'down'}" title="Було ${fmtPrice(p.prev)}">${up ? '↑' : '↓'} ${change < 1 ? change.toFixed(1).replace('.', ',') : Math.round(change)}%</span>`;
  }
  return `<a class="card" href="#/p/${p.id}">
    <div class="card__media">
      <img class="card__img" src="${esc(p.img)}" alt="" loading="lazy" decoding="async">
      ${sale}
    </div>
    <div class="card__body">
      <div class="card__name">${esc(p.name)}</div>
      <div class="card__price">
        <span class="price ${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} <small>₴/${esc(p.unit)}</small></span>
        ${p.oldPrice ? `<span class="old">${fmtPrice(p.oldPrice)}</span>` : ''}
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
  app.innerHTML = `${groupsRow}<p class="count">${count}</p>
    <div class="grid">${list.slice(0, state.shown).map(card).join('')}</div>
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
        </div>
        <div id="warn"></div>
        <div class="product__actions"><a class="btn btn--primary" href="https://www.atbmarket.com${esc(p.url)}" target="_blank" rel="noopener">Відкрити на atbmarket.com ↗</a></div>
      </div>
    </div>
    <section class="panel">
      <div class="panel__head">
        <h2>Історія ціни</h2>
        <div class="seg ranges" role="group" aria-label="Період">${RANGES.map(([l], i) => `<button data-r="${i}" aria-pressed="${i === 4}">${l}</button>`).join('')}</div>
      </div>
      <div class="chart" id="chart"><div class="sk" style="height:280px;border-radius:12px"></div></div>
      <div id="stats"></div>
    </section>`;

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
  const render = () => (m ? renderProduct(Number(m[1])) : renderList());
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
  })
  .catch((err) => {
    console.error(err);
    app.innerHTML = '<p class="status">Не вдалося завантажити дані.</p>';
  });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
