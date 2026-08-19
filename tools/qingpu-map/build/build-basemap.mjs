// 把 data/cache/*.json 的 OSM 原始資料，轉成前端可直接畫的 SVG 路徑。
// 輸出兩份：basemap.json（A2 海報用，含建物）、basemap-lite.json（嵌入用，不含建物）。
// 用法： node build/build-basemap.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, CANVAS_WIDTH, inBBox } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', 'data', 'cache');
const DATA = join(HERE, '..', 'data');

const PAD = 24; // 畫布留白，避免圖貼邊

/* ---------- 投影 ---------- */
// Web Mercator。範圍只有 4 公里，用哪種投影差異都很小，但用標準的比較不會錯。
const R = 6378137;
const toX = (lon) => R * ((lon * Math.PI) / 180);
const toY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/* ---------- Douglas-Peucker 簡化 ---------- */
function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 迴圈版而非遞迴版：有些 way 上千個點，遞迴會爆堆疊。
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], pts[lo], pts[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tol) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* ---------- 分類規則 ---------- */
const ROAD_CLASS = {
  motorway: 'major',
  motorway_link: 'major',
  trunk: 'major',
  trunk_link: 'major',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'minor',
  unclassified: 'minor',
  living_street: 'minor',
  service: 'service',
};

// 人行道與小徑不上圖：兩千多條裡佔一大半，畫出來只會讓圖變髒。
const ROAD_SKIP = new Set([
  'footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian',
  'construction', 'proposed', 'bridleway', 'corridor', 'raceway',
]);

function classifyArea(t) {
  if (t.natural === 'water' || t.waterway) return 'water';
  if (['school', 'university', 'college', 'kindergarten'].includes(t.amenity)) return 'school';
  if (t.amenity === 'hospital') return 'hospital';
  if (t.amenity === 'place_of_worship') return 'temple';
  if (['park', 'garden', 'playground', 'nature_reserve'].includes(t.leisure)) return 'green';
  if (['pitch', 'sports_centre', 'stadium', 'track'].includes(t.leisure)) return 'sport';
  if (['grass', 'forest', 'meadow', 'recreation_ground', 'village_green'].includes(t.landuse)) return 'green';
  if (['commercial', 'retail'].includes(t.landuse)) return 'commercial';
  if (t.landuse === 'industrial') return 'industrial';
  if (t.landuse === 'residential') return 'residential';
  if (['construction', 'brownfield', 'greenfield'].includes(t.landuse)) return 'construction';
  if (['farmland', 'orchard', 'farmyard'].includes(t.landuse)) return 'farm';
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
  return null;
}

const read = async (name) =>
  JSON.parse(await readFile(join(CACHE, `${name}.json`), 'utf8')).elements;

/* ---------- 把 element 攤成 [[lon,lat],...] 的線串 ---------- */
function ringsOf(el) {
  if (el.type === 'way' && el.geometry) {
    return [el.geometry.filter(Boolean).map((g) => [g.lon, g.lat])];
  }
  if (el.type === 'relation' && el.members) {
    // 多邊形關聯：只取 outer，忽略內環（洞）。青埔這個尺度看不出差別。
    return el.members
      .filter((m) => m.geometry && (m.role === 'outer' || m.role === ''))
      .map((m) => m.geometry.filter(Boolean).map((g) => [g.lon, g.lat]));
  }
  return [];
}

async function main() {
  const [roadsRaw, areasRaw, buildingsRaw, poisRaw] = await Promise.all(
    ['roads', 'areas', 'buildings', 'pois'].map(read)
  );

  /* ===== 1. 收集代表點，決定旋轉角與畫布比例 ===== */
  // 只用「已開發區域」的點：道路節點 + 建物中心。
  // 關鍵：一定要用 inBBox 濾掉界外的點。Overpass 的 out geom 會把與 bbox 相交的 way
  // 整條回傳，國道與台鐵拖出去好幾公里，不濾的話範圍會從 4.4km 被撐成 9.4km，
  // 旋轉角會算出 89.5° 這種把北方轉到側邊的荒謬結果。
  const anchor = [];
  for (const el of roadsRaw) {
    const t = el.tags || {};
    if (t.highway && ROAD_SKIP.has(t.highway)) continue;
    for (const ring of ringsOf(el)) {
      for (const p of ring) if (inBBox(p[0], p[1])) anchor.push([toX(p[0]), toY(p[1])]);
    }
  }
  for (const el of buildingsRaw) {
    for (const ring of ringsOf(el)) {
      if (!ring.length) continue;
      let slon = 0;
      let slat = 0;
      for (const p of ring) {
        slon += p[0];
        slat += p[1];
      }
      const lon = slon / ring.length;
      const lat = slat / ring.length;
      if (inBBox(lon, lat)) anchor.push([toX(lon), toY(lat)]);
    }
  }

  // 掃 0–90 度找「最小外接矩形」的角度。
  // 用面積當目標而不是縮放比：面積不依賴畫布尺寸，不會跟「畫布比例由內容決定」互相打架。
  // 青埔實測結果是 0°（內容 4.45×4.30km 近正方形），等於北方朝上 —— 這是對的，
  // 同業那張會斜是因為他們用法定都計區界那塊斜多邊形，不是方形範圍。
  let best = { deg: 0, area: Infinity, minX: 0, minY: 0, w: 0, h: 0 };
  for (let deg = 0; deg < 90; deg += 0.5) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of anchor) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w * h < best.area) best = { deg, area: w * h, minX, minY, w, h };
  }

  // 畫布高度由內容長寬比推得，不硬填 A2 比例：
  // 內容是正方形就給正方形畫布，海報上多出來的橫向空間留給圖例與品牌欄。
  const availW = CANVAS_WIDTH - PAD * 2;
  const S = availW / best.w;
  const CANVAS_HEIGHT = Math.round(best.h * S + PAD * 2);
  const availH = CANVAS_HEIGHT - PAD * 2;

  const rad = (best.deg * Math.PI) / 180;
  const COS = Math.cos(rad);
  const SIN = Math.sin(rad);
  // 置中：內容乘上縮放後，剩餘空間平均分配
  const offX = PAD + (availW - best.w * S) / 2;
  const offY = PAD + (availH - best.h * S) / 2;

  // 經緯度 → 畫布座標。Y 軸翻轉（SVG 往下為正，Mercator 往上為正）。
  const project = (lon, lat) => {
    const x = toX(lon);
    const y = toY(lat);
    const rx = x * COS - y * SIN;
    const ry = x * SIN + y * COS;
    return [
      offX + (rx - best.minX) * S,
      CANVAS_HEIGHT - (offY + (ry - best.minY) * S),
    ];
  };

  console.log(
    `旋轉角 ${best.deg}°　實地 ${(best.w / 1000).toFixed(2)}×${(best.h / 1000).toFixed(2)} km　畫布 ${CANVAS_WIDTH}×${CANVAS_HEIGHT}　錨點 ${anchor.length}`
  );

  /* ===== 2. 轉路徑 ===== */
  const r1 = (n) => Math.round(n * 10) / 10;

  // 畫布外緣的容許範圍。超出這個框的幾何直接砍掉：
  // Overpass 回傳的國道與台鐵整條長達 9 公里，不砍的話 SVG 會多出四倍看不見的路徑。
  const CLIP = { x0: -40, y0: -40, x1: CANVAS_WIDTH + 40, y1: CANVAS_HEIGHT + 40 };
  const inClip = (p) => p[0] >= CLIP.x0 && p[0] <= CLIP.x1 && p[1] >= CLIP.y0 && p[1] <= CLIP.y1;

  // 把折線切成「留在框內」的段落。跨界的線段補一個邊界交點，切口才不會縮進去。
  function clipLine(pts) {
    const segs = [];
    let cur = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (inClip(p)) {
        if (!cur.length && i > 0) cur.push(edgePoint(pts[i - 1], p));
        cur.push(p);
      } else {
        if (cur.length) {
          cur.push(edgePoint(p, pts[i - 1]));
          segs.push(cur);
          cur = [];
        }
      }
    }
    if (cur.length) segs.push(cur);
    return segs.filter((s) => s.length >= 2);
  }
  // outside → inside 之間取一個貼近邊界的點（二分逼近，夠準也夠快）
  function edgePoint(outside, inside) {
    let a = outside;
    let b = inside;
    for (let i = 0; i < 12; i++) {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (inClip(m)) b = m;
      else a = m;
    }
    return b;
  }

  const fmt = (pts, close) => {
    let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `L${r1(pts[i][0])} ${r1(pts[i][1])}`;
    return close ? d + 'Z' : d;
  };

  // Sutherland-Hodgman：把多邊形依序切過四條邊界。
  // 不切的話，農地與水域那種大面積多邊形會整片伸出畫布外，
  // SVG 雖然看不到，但檔案會白白大三倍。
  function clipPoly(pts) {
    const edges = [
      { keep: (p) => p[0] >= CLIP.x0, cut: (a, b) => lerpX(a, b, CLIP.x0) },
      { keep: (p) => p[0] <= CLIP.x1, cut: (a, b) => lerpX(a, b, CLIP.x1) },
      { keep: (p) => p[1] >= CLIP.y0, cut: (a, b) => lerpY(a, b, CLIP.y0) },
      { keep: (p) => p[1] <= CLIP.y1, cut: (a, b) => lerpY(a, b, CLIP.y1) },
    ];
    let out = pts;
    for (const e of edges) {
      const input = out;
      out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const prev = input[(i + input.length - 1) % input.length];
        const curIn = e.keep(cur);
        const prevIn = e.keep(prev);
        if (curIn) {
          if (!prevIn) out.push(e.cut(prev, cur));
          out.push(cur);
        } else if (prevIn) {
          out.push(e.cut(prev, cur));
        }
      }
      if (!out.length) return [];
    }
    return out;
  }
  const lerpX = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const lerpY = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];

  // 面：切到畫布框內
  function toPath(ring, tol, close) {
    let pts = ring.map(([lon, lat]) => project(lon, lat));
    if (pts.length > 2) pts = simplify(pts, tol);
    if (pts.length < 2) return null;
    if (!pts.some(inClip)) {
      pts = clipPoly(pts);
      if (pts.length < 3) return null;
    } else if (!pts.every(inClip)) {
      pts = clipPoly(pts);
      if (pts.length < 3) return null;
    }
    return fmt(pts, close);
  }

  // 線：切成框內段落，回傳多條路徑
  function toLinePaths(ring, tol) {
    let pts = ring.map(([lon, lat]) => project(lon, lat));
    if (pts.length > 2) pts = simplify(pts, tol);
    if (pts.length < 2) return [];
    return clipLine(pts).map((seg) => fmt(seg, false));
  }
  const isClosed = (ring) =>
    ring.length > 3 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];

  /* --- 道路與軌道 --- */
  const roads = [];
  const rail = [];
  const skipped = {};
  for (const el of roadsRaw) {
    const t = el.tags || {};
    if (t.railway) {
      const cls =
        t.usage === 'high_speed' || t.highspeed === 'yes'
          ? 'hsr'
          : t.railway === 'light_rail' || t.railway === 'subway'
            ? 'mrt'
            : 'rail';
      for (const ring of ringsOf(el)) {
        for (const d of toLinePaths(ring, 1.2)) {
          rail.push(t.name ? { d, cls, name: t.name } : { d, cls });
        }
      }
      continue;
    }
    if (!t.highway) continue;
    const cls = ROAD_CLASS[t.highway];
    if (!cls || ROAD_SKIP.has(t.highway)) {
      skipped[t.highway] = (skipped[t.highway] || 0) + 1;
      continue;
    }
    const tol = cls === 'service' || cls === 'minor' ? 1.5 : 0.7;
    for (const ring of ringsOf(el)) {
      for (const d of toLinePaths(ring, tol)) {
        roads.push(t.name ? { d, cls, name: t.name } : { d, cls });
      }
    }
  }

  /* --- 面（水、綠、機關、街廓） --- */
  const layers = {
    water: [], green: [], sport: [], school: [], hospital: [], temple: [],
    residential: [], commercial: [], industrial: [], construction: [],
    farm: [], cemetery: [],
  };
  const unclassified = {};
  for (const el of areasRaw) {
    const t = el.tags || {};
    const kind = classifyArea(t);
    if (!kind) {
      const key = ['landuse', 'leisure', 'amenity', 'natural']
        .filter((k) => t[k])
        .map((k) => `${k}=${t[k]}`)
        .join(',');
      if (key) unclassified[key] = (unclassified[key] || 0) + 1;
      continue;
    }
    for (const ring of ringsOf(el)) {
      // waterway 常是線不是面（河道），線要切、面不用
      if (kind === 'water' && !isClosed(ring)) {
        for (const d of toLinePaths(ring, 1.0)) {
          layers.water.push(t.name ? { d, name: t.name } : { d });
        }
        continue;
      }
      const d = toPath(ring, 1.0, true);
      if (d) layers[kind].push(t.name ? { d, name: t.name } : { d });
    }
  }

  /* --- 建物 --- */
  const buildings = [];
  for (const el of buildingsRaw) {
    const t = el.tags || {};
    for (const ring of ringsOf(el)) {
      const d = toPath(ring, 0.6, true);
      if (d) buildings.push(t.name ? { d, name: t.name } : { d });
    }
  }

  /* --- 地標：走 landmarks.src.json 白名單，順序就是圖上編號 --- */
  // OSM 抓回來的 POI 有一半是雜訊（旅館、公共藝術、被誤標成 tourism=apartment 的住宅社區），
  // 全上圖會蓋掉真正的賣點，所以只認白名單。
  const src = JSON.parse(await readFile(join(HERE, 'landmarks.src.json'), 'utf8'));
  const osmByName = new Map();
  for (const el of poisRaw) {
    const t = el.tags || {};
    if (!t.name) continue;
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon == null || lat == null) continue;
    if (!osmByName.has(t.name)) osmByName.set(t.name, { lat, lon });
  }

  const pois = [];
  const missing = [];
  for (const want of src.show) {
    let lat = want.lat;
    let lon = want.lon;
    if (lat == null && want.osm) {
      const hit = osmByName.get(want.osm);
      if (!hit) { missing.push(want.osm); continue; }
      lat = hit.lat;
      lon = hit.lon;
    }
    if (lat == null || lon == null) continue;
    const [x, y] = project(lon, lat);
    pois.push({ x: r1(x), y: r1(y), name: want.label, kind: want.kind, lat, lon });
  }

  /* ===== 3. 輸出 ===== */
  const meta = {
    generatedAt: new Date().toISOString(),
    bbox: BBOX,
    rotation: best.deg,
    canvas: { w: CANVAS_WIDTH, h: CANVAS_HEIGHT },
    // 每公尺幾個 SVG 單位。比例尺要照這個畫才準。
    // Web Mercator 在緯度 φ 會放大 1/cos(φ) 倍，青埔約 25°N，這裡先除掉再存，
    // 存的是「地面實距」的比例，不是投影平面的比例。
    unitsPerMeter: S * Math.cos(((BBOX.south + BBOX.north) / 2) * Math.PI / 180),

    // 投影參數。前端要把社區的經緯度換算成畫布座標就靠這組，
    // 這樣投影邏輯只有這裡一份，pins.json 只存經緯度、不存畫布座標，
    // bbox 或畫布一改，重跑 build 就自動對齊，pins 不用重新定位。
    proj: {
      cos: COS, sin: SIN, scale: S,
      minX: best.minX, minY: best.minY,
      offX, offY, canvasH: CANVAS_HEIGHT,
      R: 6378137,
    },
    source: '© OpenStreetMap contributors (ODbL)',
    note: '參考用，非法定都市計畫圖',
  };

  const full = { meta, ...layers, roads, rail, buildings, pois };
  const fullStr = JSON.stringify(full);
  await writeFile(join(DATA, 'basemap.json'), fullStr, 'utf8');

  // 輕量版：不含建物，道路只留主幹
  const lite = {
    meta,
    water: layers.water,
    green: layers.green,
    sport: layers.sport,
    school: layers.school,
    hospital: layers.hospital,
    residential: layers.residential,
    commercial: layers.commercial,
    industrial: layers.industrial,
    roads: roads.filter((r) => r.cls !== 'service' && r.cls !== 'minor'),
    rail,
    pois,
  };
  const liteStr = JSON.stringify(lite);
  await writeFile(join(DATA, 'basemap-lite.json'), liteStr, 'utf8');

  /* ===== 4. 回報 ===== */
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log('\n圖層統計：');
  for (const [k, v] of Object.entries(layers)) {
    if (v.length) console.log(`  ${k.padEnd(13)} ${v.length}`);
  }
  console.log(`  ${'roads'.padEnd(13)} ${roads.length}（軌道 ${rail.length}）`);
  console.log(`  ${'buildings'.padEnd(13)} ${buildings.length}`);
  console.log(`  ${'pois'.padEnd(13)} ${pois.length}`);
  console.log(`\nbasemap.json      ${kb(fullStr.length)}`);
  console.log(`basemap-lite.json ${kb(liteStr.length)}`);

  if (missing.length) {
    console.log(`\n⚠ landmarks.src.json 裡這些名稱在 OSM 找不到，沒上圖：`);
    missing.forEach((n) => console.log(`   ${n}`));
    console.log('   → 到 landmarks.src.json 補 lat/lon 手動定位。');
  }
  if (Object.keys(unclassified).length) {
    console.log('\n未分類的面（沒上圖，確認要不要補規則）：');
    Object.entries(unclassified)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}×  ${k}`));
  }
}

main().catch((err) => {
  console.error('失敗：', err.stack);
  process.exit(1);
});
