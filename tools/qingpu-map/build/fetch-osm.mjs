// 抓 Overpass 圖資，存進 data/cache/。
// 用法： node build/fetch-osm.mjs [--force]
// 不加 --force 時，已存在的 cache 直接沿用，不重打 API（對 Overpass 有禮貌，也快）。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERPASS_ENDPOINTS, USER_AGENT, bboxStr, geocodeBboxStr } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', 'data', 'cache');
const BB = bboxStr();
const GBB = geocodeBboxStr();   // 門牌用放大範圍，見 config.mjs 的說明

// 分批查詢，不要一次全抓：Overpass 對單一大查詢容易逾時，分開還能個別重試。
const QUERIES = {
  roads: `
    (way(${BB})[highway];
     way(${BB})[railway~"^(rail|light_rail|subway|monorail)$"];);
    out geom tags;`,

  areas: `
    (way(${BB})[landuse];
     way(${BB})[leisure];
     way(${BB})[amenity~"^(school|hospital|university|college|kindergarten|place_of_worship)$"];
     way(${BB})[natural=water];
     way(${BB})[waterway];
     rel(${BB})[landuse];
     rel(${BB})[leisure=park];
     rel(${BB})[natural=water];);
    out geom tags;`,

  buildings: `
    (way(${BB})[building];);
    out geom tags;`,

  // 門牌點。OSM 台灣有完整門牌（政府資料匯入），青埔一帶好幾萬點。
  // 社區定位靠這個 —— Nominatim 查台灣門牌實測 6/6 全部查無，別再試了。
  // 用放大範圍抓：這樣才分得出社區是「在圖框外」還是「OSM 沒收錄」。
  addresses: `
    (node(${GBB})["addr:housenumber"]["addr:street"];
     way(${GBB})["addr:housenumber"]["addr:street"];);
    out center tags;`,

  pois: `
    (node(${BB})[railway=station];
     node(${BB})[public_transport=station];
     way(${BB})[shop=mall];
     way(${BB})[amenity~"^(theatre|cinema|hospital|marketplace)$"];
     way(${BB})[tourism];
     way(${BB})[leisure=stadium];
     node(${BB})[shop=mall];
     node(${BB})[tourism];);
    out geom center tags;`,
};

async function overpass(body) {
  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: 'data=' + encodeURIComponent(`[out:json][timeout:180];${body}`),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements) throw new Error('回應沒有 elements');
        return json;
      } catch (err) {
        lastErr = err;
        const wait = attempt * 5000;
        console.log(`    ${ep.replace(/^https:\/\//, '').split('/')[0]} 第 ${attempt} 次失敗（${err.message}），${wait / 1000}s 後重試`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`所有 Overpass 端點都失敗：${lastErr?.message}`);
}

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(CACHE, { recursive: true });

  for (const [key, query] of Object.entries(QUERIES)) {
    const file = join(CACHE, `${key}.json`);
    if (!force && existsSync(file)) {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      console.log(`[skip] ${key}：沿用 cache（${cached.elements.length} 筆）`);
      continue;
    }
    console.log(`[抓取] ${key} …`);
    const json = await overpass(query);
    await writeFile(file, JSON.stringify(json), 'utf8');
    console.log(`[完成] ${key}：${json.elements.length} 筆`);
    // 連續查詢之間停一下，避免被 Overpass 當成濫用。
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\nOSM 圖資抓取完成。');
}

main().catch(err => { console.error('失敗：', err.message); process.exit(1); });
