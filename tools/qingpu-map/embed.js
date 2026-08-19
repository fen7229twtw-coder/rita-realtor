/* 青埔地圖 — 嵌入版
   給買方配案的配案表、屋主回報的回報單用。底圖只維護一份，三支工具共用。

   用法：
     import { renderQingpuMap } from '../qingpu-map/embed.js';
     await renderQingpuMap(el, { highlight:['竹風青庭'], showPrices:false });

   降級規則：highlight 的社區名一個都對不到 → 回傳 false 且不畫任何東西。
   寧可沒有地圖，也不要印一張標錯位置的圖給客戶。 */

const svgNS = 'http://www.w3.org/2000/svg';

/* 讀進來的底圖與社區在多個嵌入點之間共用，不重複下載 */
const cache = new Map();
async function loadJSON(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(url);
}

/* 跟主地圖同一套色階，改了要兩邊一起改 */
const PRICE_BANDS = [
  { max: 32,       color: '#DADAEB' },
  { max: 38,       color: '#B3AFD6' },
  { max: 44,       color: '#8C82BF' },
  { max: 50,       color: '#63499E' },
  { max: Infinity, color: '#3F007D' },
];
const NO_PRICE = '#B9BDB8';
const priceColor = up => (up ? PRICE_BANDS.find(b => up / 10000 < b.max).color : NO_PRICE);

const STYLE = {
  bg: '#FBF8F3', farm: '#F4F2E7', residential: '#F3E2D8', commercial: '#EFD3B8',
  industrial: '#E4DEE8', green: '#CFE3C3', sport: '#C3DCB4', water: '#BDD9EC',
  school: '#D8DCE8', hospital: '#F0D9D9',
  roadCase: '#CFC2B4', roadFill: '#FFFFFF', rail: '#5A6670',
  mark: '#D8261C', markText: '#0B2E20',
};
const ROAD_W = { major: 7, primary: 5.5, secondary: 4.2, tertiary: 3.2 };

const el = (name, attrs) => {
  const n = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};
const pathEl = (d, fill, stroke, sw, extra) =>
  el('path', { d, fill: fill || 'none', stroke, 'stroke-width': sw, ...extra });

/* 社區名比對：去掉空白與括號註記再比，對不到就退而求其次找包含關係。
   買方配案的物件名常是「竹風青庭 3房」這種，所以要能吃到部分比對。 */
function matchPin(pins, wanted) {
  const norm = s => String(s).replace(/[\s\-－—・·．.]/g, '').replace(/[（(].*?[）)]/g, '');
  const w = norm(wanted);
  if (!w) return null;
  return (
    pins.find(p => norm(p.name) === w) ||
    pins.find(p => w.includes(norm(p.name)) && norm(p.name).length >= 3) ||
    pins.find(p => norm(p.name).includes(w) && w.length >= 3) ||
    null
  );
}

function projector(proj) {
  const { R, cos, sin, scale, minX, minY, offX, offY, canvasH } = proj;
  return (lon, lat) => {
    const X = R * (lon * Math.PI / 180);
    const Y = R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    const rx = X * cos - Y * sin;
    const ry = X * sin + Y * cos;
    return [offX + (rx - minX) * scale, canvasH - (offY + (ry - minY) * scale)];
  };
}

/**
 * @param {HTMLElement} container 要塞地圖的容器
 * @param {object}  opts
 * @param {string[]} opts.highlight  要標出來的社區名（買方配案是挑中的物件，屋主回報是委託社區）
 * @param {boolean} opts.showPrices  是否用行情色階畫其他社區。
 *                                   給屋主看 true（佐證區域水位），給買方看 false（別讓他拿你的圖殺你的案）
 * @param {number}  opts.height      像素高，預設 300
 * @param {string}  opts.base        qingpu-map 的相對路徑，預設 '../qingpu-map/'
 * @returns {Promise<boolean>} 有沒有畫出來
 */
export async function renderQingpuMap(container, opts = {}) {
  const {
    highlight = [], showPrices = false, height = 300, base = '../qingpu-map/',
  } = opts;

  container.innerHTML = '';

  const [map, pinData] = await Promise.all([
    loadJSON(base + 'data/basemap-lite.json'),
    loadJSON(base + 'data/pins.json'),
  ]);
  if (!map || !pinData) return false;

  // 手動校正檔如果存在就套用，跟主地圖一致
  const manual = await loadJSON(base + 'data/pins-manual.json');
  const pins = pinData.pins.map(p => {
    const m = manual?.pins?.[p.id];
    return m ? { ...p, lat: m.lat, lon: m.lon } : p;
  });

  // 對不到任何一個社區就整塊不畫
  const marks = highlight.map(n => matchPin(pins, n)).filter(Boolean);
  if (highlight.length && !marks.length) return false;

  const { w, h } = map.meta.canvas;
  const project = projector(map.meta.proj);

  /* 裁切視野的錨點：標的 + 捷運站與賣場（買方最在意的距離參照）。
     實際的 viewBox 要等 SVG 掛上去、量得到容器真實寬度才算得準，見下方 fitView。 */
  const anchors = marks.map(p => project(p.lon, p.lat));
  for (const poi of map.pois || []) {
    if (poi.kind === 'station' || poi.kind === 'mall') anchors.push([poi.x, poi.y]);
  }

  const svg = el('svg', {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: `display:block;width:100%;height:${height}px;background:${STYLE.bg}`,
    xmlns: svgNS,
  });

  /* --- 面 --- */
  for (const kind of ['farm', 'industrial', 'residential', 'commercial', 'green', 'sport', 'school', 'hospital']) {
    for (const f of map[kind] || []) svg.appendChild(pathEl(f.d, STYLE[kind]));
  }
  for (const f of map.water || []) {
    svg.appendChild(f.d.endsWith('Z')
      ? pathEl(f.d, STYLE.water)
      : pathEl(f.d, null, STYLE.water, 2.6));
  }

  /* --- 道路：casing 全畫完再畫 fill，路口才不會斷 --- */
  const rounded = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  for (const pass of [0, 1]) {
    for (const r of map.roads || []) {
      const wdt = ROAD_W[r.cls] || 3;
      svg.appendChild(pass === 0
        ? pathEl(r.d, null, STYLE.roadCase, wdt + 1.2, rounded)
        : pathEl(r.d, null, STYLE.roadFill, wdt, rounded));
    }
  }
  for (const r of map.rail || []) {
    svg.appendChild(pathEl(r.d, null, STYLE.rail, 2.6));
    svg.appendChild(pathEl(r.d, null, '#fff', 1.2, { 'stroke-dasharray': '5 5' }));
  }

  /* --- 其他社區：小點襯托，讓被標的物件看起來有座落感 --- */
  for (const p of pins) {
    if (marks.includes(p)) continue;
    const [x, y] = project(p.lon, p.lat);
    svg.appendChild(el('circle', {
      cx: x, cy: y, r: 3,
      fill: showPrices ? priceColor(p.upMedian) : '#C9C3BB',
      stroke: '#fff', 'stroke-width': 1,
    }));
  }

  /* --- 捷運站：買方最在意的距離參照 --- */
  for (const poi of map.pois || []) {
    if (poi.kind !== 'station' && poi.kind !== 'mall') continue;
    const isStation = poi.kind === 'station';
    svg.appendChild(el('circle', {
      cx: poi.x, cy: poi.y, r: isStation ? 6 : 5,
      fill: isStation ? '#2B6CB0' : '#C8811A', stroke: '#fff', 'stroke-width': 1.8,
    }));
    svg.appendChild(Object.assign(el('text', {
      x: poi.x, y: poi.y - 10, 'text-anchor': 'middle',
      style: 'font-size:15px;font-weight:700;fill:#2A3D36;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round',
    }), { textContent: poi.name.replace(/（.*?）/, '') }));
  }

  /* --- 標的：大紅點 + 編號 + 名稱，一眼看得出來 --- */
  marks.forEach((p, i) => {
    const [x, y] = project(p.lon, p.lat);
    svg.appendChild(el('circle', { cx: x, cy: y, r: 15, fill: STYLE.mark, opacity: .18 }));
    svg.appendChild(el('circle', { cx: x, cy: y, r: 9, fill: STYLE.mark, stroke: '#fff', 'stroke-width': 2.5 }));
    if (marks.length > 1) {
      svg.appendChild(Object.assign(el('text', {
        x, y: y + 4, 'text-anchor': 'middle',
        style: 'font-size:11px;font-weight:800;fill:#fff',
      }), { textContent: i + 1 }));
    }
    svg.appendChild(Object.assign(el('text', {
      x, y: y - 20, 'text-anchor': 'middle',
      style: 'font-size:19px;font-weight:800;fill:' + STYLE.markText
        + ';paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round',
    }), { textContent: p.name }));
  });

  container.appendChild(svg);

  /* 底圖是近正方形，報表裡的欄位是寬的 —— 整張塞進去左右會各留一大片白。
     以錨點為中心裁一塊「跟容器同比例」的視野把空間吃滿。
     容器寬度必須等掛上 DOM 之後才量得到；報表剛用 innerHTML 產生時常常還沒排版完，
     量到 0 就再等一個影格，不要用預設值硬算（會算出對不上的比例）。 */
  function fitView(retry = 0) {
    const boxW = svg.getBoundingClientRect().width;
    if (!boxW) {
      // 呼叫端可能還沒把區塊顯示出來，多等幾個影格再放棄
      if (retry < 30) requestAnimationFrame(() => fitView(retry + 1));
      return;
    }
    if (!anchors.length) return;
    const aspect = boxW / height;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of anchors) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const padX = Math.max((x1 - x0) * 0.16, 90);
    const padY = Math.max((y1 - y0) * 0.16, 90);
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    let vw = x1 - x0;
    let vh = y1 - y0;
    // 補到容器比例：不足的那一邊往兩側均分，內容才會置中而不是偏一邊
    if (vw / vh < aspect) { const t = vh * aspect; x0 -= (t - vw) / 2; vw = t; }
    else { const t = vw / aspect; y0 -= (t - vh) / 2; vh = t; }
    svg.setAttribute('viewBox', `${x0.toFixed(1)} ${y0.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`);
  }
  fitView();

  const note = document.createElement('div');
  note.style.cssText = 'font-size:.62rem;color:#95A69C;line-height:1.5;margin-top:4px';
  note.textContent = '底圖 © OpenStreetMap contributors (ODbL)　參考用，非法定都市計畫圖'
    + (showPrices ? '　社區色階為實價登錄住家類成交每坪中位數，非開價' : '');
  container.appendChild(note);

  return true;
}

/** 只查社區在不在地圖資料裡，給呼叫端決定要不要顯示地圖區塊 */
export async function hasQingpuPin(name, base = '../qingpu-map/') {
  const d = await loadJSON(base + 'data/pins.json');
  return !!(d && matchPin(d.pins, name));
}
