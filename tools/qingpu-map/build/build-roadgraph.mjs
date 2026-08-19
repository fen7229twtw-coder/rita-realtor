// 從 OSM 道路資料建一張「路網圖」，給帶看路線算站與站之間的行車時間。
// 用法： node build/build-roadgraph.mjs
//
// 為什麼不能用直線距離估：
//   青埔中間隔著老街溪、高鐵軌道與國道 2 號，兩個社區直線 400 公尺，
//   但要繞到橋才過得去，實際可能 1.5 公里。直線估會給客戶錯的時間。
//
// 為什麼不接線上路徑服務：
//   帶看時在車上、在店頭，網路不一定穩；而且那是外部相依，哪天它掛了功能就死。
//   路網自己帶著走，離線也算得出來。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOCODE_BBOX } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', 'data', 'cache');
const DATA = join(HERE, '..', 'data');

/* 各級道路的實際平均車速（km/h）。
   不是速限，是「含紅綠燈與轉彎的實際平均」——青埔路口多，抓保守一點，
   寧可跟客戶說 8 分鐘實際 6 分鐘到，不要反過來。 */
const SPEED = {
  motorway: 70, motorway_link: 40,
  trunk: 50, trunk_link: 35,
  primary: 38, primary_link: 30,
  secondary: 34, secondary_link: 28,
  tertiary: 30, tertiary_link: 26,
  residential: 22, unclassified: 22, living_street: 14,
  service: 14,
};
// 開車走不了的一律不進圖
const SKIP = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian',
  'bridleway', 'corridor', 'proposed', 'construction', 'track', 'raceway']);

const COS_LAT = Math.cos(25 * Math.PI / 180);
/** 兩點實際地面距離（公尺） */
const meters = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111320 * COS_LAT, (a[1] - b[1]) * 110540);

const inArea = (lon, lat) =>
  lat >= GEOCODE_BBOX.south && lat <= GEOCODE_BBOX.north &&
  lon >= GEOCODE_BBOX.west && lon <= GEOCODE_BBOX.east;

// 座標當節點鍵。OSM 的 way 在路口會共用同一個節點，座標完全相同，所以可以直接比對。
const key = (lon, lat) => `${lon.toFixed(7)},${lat.toFixed(7)}`;

async function main() {
  const roads = JSON.parse(await readFile(join(CACHE, 'roads.json'), 'utf8')).elements;

  /* ---- 第一輪：數每個座標被幾條路用到，找出路口 ---- */
  const useCount = new Map();
  const ways = [];
  for (const el of roads) {
    const hw = el.tags?.highway;
    if (!hw || SKIP.has(hw) || !SPEED[hw] || !el.geometry) continue;
    const pts = el.geometry.filter(Boolean).map((g) => [g.lon, g.lat]);
    if (pts.length < 2) continue;
    ways.push({ pts, hw, name: el.tags.name, oneway: el.tags.oneway === 'yes' });
    for (const p of pts) {
      const k = key(p[0], p[1]);
      useCount.set(k, (useCount.get(k) || 0) + 1);
    }
  }

  /* ---- 第二輪：只留「路口 + 每條路的頭尾」當節點，
         中間的轉折點併進邊長，圖就小很多 ---- */
  const nodeIndex = new Map();     // key -> 節點編號
  const nodes = [];                // [lon, lat]
  const nodeOf = (p) => {
    const k = key(p[0], p[1]);
    if (!nodeIndex.has(k)) {
      nodeIndex.set(k, nodes.length);
      nodes.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
    }
    return nodeIndex.get(k);
  };

  const edges = [];
  for (const w of ways) {
    let from = null;
    let dist = 0;
    for (let i = 0; i < w.pts.length; i++) {
      const p = w.pts[i];
      const k = key(p[0], p[1]);
      const isJunction = useCount.get(k) > 1;
      const isEnd = i === 0 || i === w.pts.length - 1;

      if (i > 0) dist += meters(w.pts[i - 1], p);

      if (from === null) {
        if (isJunction || isEnd) { from = nodeOf(p); dist = 0; }
        continue;
      }
      if (isJunction || isEnd) {
        const to = nodeOf(p);
        if (to !== from && dist > 0 && inArea(p[0], p[1])) {
          // 秒數 = 距離 / 速度。單行道只記一個方向。
          const sec = Math.round(dist / (SPEED[w.hw] * 1000 / 3600));
          edges.push([from, to, Math.round(dist), sec]);
          if (!w.oneway) edges.push([to, from, Math.round(dist), sec]);
        }
        from = to;
        dist = 0;
      }
    }
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      nodes: nodes.length,
      edges: edges.length,
      source: '© OpenStreetMap contributors (ODbL)',
      note: '車行時間是用各級道路的實際平均車速估的，不含找車位與等紅燈的變異',
    },
    nodes,
    edges,
  };
  const str = JSON.stringify(out);
  await writeFile(join(DATA, 'roadgraph.json'), str, 'utf8');

  console.log(`路網圖：${nodes.length} 個節點、${edges.length} 條邊`);
  console.log(`roadgraph.json ${(str.length / 1024).toFixed(0)} KB`);

  /* ---- 連通性自檢：孤島太多代表圖有問題，算出來的時間會不準 ---- */
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const n of adj.get(stack.pop()) || []) {
      if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  const pct = ((seen.size / nodes.length) * 100).toFixed(1);
  console.log(`最大連通區塊涵蓋 ${seen.size}/${nodes.length} 個節點（${pct}%）`);
  if (seen.size / nodes.length < 0.8) {
    console.log('⚠ 連通率偏低，可能有整片路網沒接上，行車時間會不準');
  }
}

main().catch((err) => { console.error('失敗：', err.stack); process.exit(1); });
