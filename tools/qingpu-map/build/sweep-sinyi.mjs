// 掃信義房屋的社區清單（community.xml），把中壢區與大園區的社區整份撈下來。
// 用法： node build/sweep-sinyi.mjs
//
// 為什麼要掃：公設、建商、警衛、垃圾處理這些欄位只有信義的社區頁有，
// 但它沒有「用名字查編號」的公開入口 —— 搜尋 API 要認證 token（不碰），
// 區域列表頁只吐前 20 筆，社區頁之間也沒有互連可以爬。
// 剩下唯一乾淨的路就是它自己在 robots.txt 公告的 community.xml：
// 兩萬筆社區編號，一筆一筆開，看標題是不是青埔所在的那兩個區。
//
// 分寸：只掃編號落在青埔那個年代的區間（已知的青埔社區編號都在裡面），
// 一筆等 0.6 秒，掃完存檔，中斷再跑會從斷點接。robots.txt 是 Allow: /，
// sitemap 本來就是給人照著爬的，但速度還是自己壓著。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'qingpu-communities', 'data', 'sinyi-sweep.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/* 一次開 4 條線，每條開一筆之間隔 2.4 秒 —— 平均每秒 1.6 個請求。
   單線跑實測一筆要 2.4 秒（光是等它回就 1.8 秒），4345 筆要跑快 3 小時，
   人在旁邊等太久。4 條線壓在每秒 1.6 個請求，是一般爬蟲的正常速度。 */
const LANES = 4;
const GAP_MS = 2400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 青埔橫跨中壢區與大園區兩個行政區，只留這兩區 */
const WANT_DIST = ['中壢區', '大園區'];

/* 已知的青埔社區編號都落在這幾段裡。掃全部兩萬筆沒有必要，
   對人家的機器也不厚道。 */
const BANDS = [[24500, 33500], [9000000, 9022500]];

const FIELD_RE = /basic-info-area-title__[^>]*>([^<]+)<\/div><div class="community_basic-info-area-content__[^>]*>([^<]*)</g;
const KEEP = ['類型', '屋齡', '樓高', '戶數', '格局', '公設比', '建設公司',
  '主要結構', '外牆建材', '警衛管理', '垃圾處理', '無障礙設施', '公共設施'];

function parse(html) {
  const out = {};
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(html))) {
    const k = m[1].trim();
    const v = m[2].trim();
    if (KEEP.includes(k) && v && v !== '--') out[k] = v;
  }
  const t = html.match(/<title>([^<|]+)/);
  if (t) out.名稱 = t[1].replace(/實價登錄.*$/, '').trim();
  const d = html.match(/桃園市(中壢區|大園區)/);
  if (d) out.行政區 = d[1];
  /* 地址取最短的那個（最短的通常是社區本身的門牌，長的是各筆成交的樓層） */
  const addrs = [...html.matchAll(/桃園市(?:中壢區|大園區)[^"<>]{4,30}?(?:路|街|大道)[一二三四五六七八九]?段?\d+號/g)]
    .map((x) => x[0]);
  if (addrs.length) out.地址 = addrs.sort((a, b) => a.length - b.length)[0];
  return out;
}

async function main() {
  const t0 = Date.now();
  const xml = await (await fetch('https://www.sinyi.com.tw/community.xml', { headers: { 'User-Agent': UA } })).text();
  const all = [...new Set([...xml.matchAll(/communityinfo\/([A-Z0-9]{7,8})/g)].map((m) => m[1]))];
  const todo = all.filter((id) => {
    if (!/^\d+$/.test(id)) return false;
    const n = +id;
    return BANDS.some(([lo, hi]) => n >= lo && n <= hi);
  });

  /* 斷點續跑：seen 記錄「開過了」，hits 記錄「是青埔那兩區的」 */
  let state = { seen: {}, hits: {} };
  try { state = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 第一次跑 */ }
  state.seen ||= {}; state.hits ||= {};

  const left = todo.filter((id) => !state.seen[id]);
  console.log(`清單共 ${all.length} 筆，落在青埔區間 ${todo.length} 筆，還沒開過 ${left.length} 筆`);
  console.log(`預計 ${Math.round(left.length * GAP_MS / 60000)} 分鐘`);

  let n = 0, fail = 0;
  let saving = null;
  const save = async () => {
    if (saving) return saving;
    saving = writeFile(OUT, JSON.stringify(state), 'utf8').finally(() => { saving = null; });
    return saving;
  };

  const lane = async (laneNo) => {
    for (let i = laneNo; i < left.length; i += LANES) {
      const id = left[i];
      try {
        const r = await fetch(`https://www.sinyi.com.tw/communitylist/communityinfo/${id}`,
          { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
        if (r.status === 429 || r.status >= 500) {    // 對方喊累就整條線退一步
          console.log(`  ${id} 回 ${r.status}，這條線等 30 秒`);
          await sleep(30000);
          i -= LANES;                                  // 同一筆再試一次
          continue;
        }
        const html = await r.text();
        state.seen[id] = 1;
        const rec = parse(html);
        if (rec.行政區 && WANT_DIST.includes(rec.行政區) && rec.名稱) {
          state.hits[id] = rec;
          if (rec.公共設施) console.log(`  ✔ ${id} ${rec.名稱}（有公設）`);
        }
      } catch (e) {
        fail++;
        if (fail % 20 === 0) console.log(`  連線失敗累計 ${fail}`);
        await sleep(3000);
        continue;
      }
      n++;
      if (n % 200 === 0) {
        await save();
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        const rate = n / ((Date.now() - t0) / 60000);
        console.log(`[${n}/${left.length}] 已 ${mins} 分，命中 ${Object.keys(state.hits).length} 筆，`
          + `估還要 ${Math.round((left.length - n) / rate)} 分`);
      }
      await sleep(GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: LANES }, (_, k) => lane(k)));
  await writeFile(OUT, JSON.stringify(state), 'utf8');
  const withF = Object.values(state.hits).filter((r) => r.公共設施).length;
  console.log(`掃完。中壢＋大園 ${Object.keys(state.hits).length} 個社區，其中 ${withF} 個有公設。`);
}

main();
