// 抓信義房屋社區頁上的經緯度，存成 data/sinyi-xy.json。
// 用法： node build/fetch-sinyi-xy.mjs        （加 --force 連已經抓過的也重抓）
//
// 為什麼要這一份
// --------------
// 社區定位本來只有一個來源（OSM 門牌點），錯了也沒人知道。加上 591 之後變兩個，
// 但兩個吵架時沒有第三票可以決定誰對。信義是第三個獨立來源：
// 它每個社區頁右下角有一個「看地圖」連結，網址就是那個社區的座標，
// 形如 google.com.tw/maps/place/25.0159991,121.219482 —— 一頁只有一個，不會抓錯。
//
// 抓法上的規矩
//   - 一筆等 2.4 秒，跟 build/fetch-sinyi.mjs 同一個節奏，不要把人家網站打掛。
//   - 抓過的存進 data/sinyi-xy.json，重跑會跳過（--force 才重抓）。
//   - 社區編號來自 tools/qingpu-communities/data/sinyi-ids.tsv，那是既有的對照表，
//     這裡不自己去猜編號。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const IDS = join(HERE, '..', '..', 'qingpu-communities', 'data', 'sinyi-ids.tsv');
const OUT = join(DATA, 'sinyi-xy.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FORCE = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 社區編號有兩份，兩份都用：
     sinyi-ids.tsv    我自己核對過的對照表（社區名 → 編號），最可信
     sinyi-sweep.json 掃整個中壢＋大園收回來的（編號 → 社區名），量大
   同名以 tsv 為準。 */
const byName = new Map();
for (const a of (await readFile(IDS, 'utf8')).trim().split('\n').slice(1).map((l) => l.split('\t'))) {
  if (a[0] && a[1]) byName.set(a[0].trim(), a[1].trim());
}
const SWEEP = join(HERE, '..', '..', 'qingpu-communities', 'data', 'sinyi-sweep.json');
if (existsSync(SWEEP)) {
  const hits = JSON.parse(await readFile(SWEEP, 'utf8')).hits || {};
  for (const [id, v] of Object.entries(hits)) {
    const n = v && v['名稱'];
    if (n && !byName.has(n)) byName.set(n, id);
  }
}
const rows = [...byName].map(([name, id]) => ({ name, id }));

let store = { generatedAt: null, source: '信義房屋社區頁的「看地圖」連結', items: {} };
if (existsSync(OUT) && !FORCE) store = JSON.parse(await readFile(OUT, 'utf8'));

const todo = rows.filter((r) => FORCE || !store.items[r.name]);
console.log('社區編號共 ' + rows.length + ' 個，這次要抓 ' + todo.length + ' 個');
if (!todo.length) { console.log('都抓過了。加 --force 可以重抓。'); process.exit(0); }
console.log('一筆等 2.4 秒，預計 ' + Math.ceil((todo.length * 2.4) / 60) + ' 分鐘\n');

let ok = 0, miss = 0, fail = 0;
for (let i = 0; i < todo.length; i++) {
  const r = todo[i];
  try {
    const res = await fetch('https://www.sinyi.com.tw/communitylist/communityinfo/' + r.id,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    // 一頁只有一個這種連結，就是這個社區自己的座標
    const m = html.match(/google\.com(?:\.tw)?\/maps\/place\/(2[45]\.\d+),(12[01]\.\d+)/);
    if (m) {
      store.items[r.name] = { id: r.id, lat: +m[1], lon: +m[2] };
      ok++;
    } else {
      store.items[r.name] = { id: r.id, lat: null, lon: null, note: '頁面沒有地圖連結' };
      miss++;
    }
  } catch (e) {
    fail++;
    console.log('  抓不到 ' + r.name + '：' + e.message);
  }
  if ((i + 1) % 20 === 0) console.log('  ' + (i + 1) + '/' + todo.length + ' …');
  await sleep(2400);
}

store.generatedAt = new Date().toISOString();
await writeFile(OUT, JSON.stringify(store, null, 1), 'utf8');
console.log('\n抓到座標 ' + ok + ' 個　頁面沒有地圖 ' + miss + ' 個　失敗 ' + fail + ' 個');
console.log('存到 data/sinyi-xy.json');
