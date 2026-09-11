/* ===================================================================
   build-parking.mjs — 從實價登錄原始檔算出「每個社區的車位規格」

   跑法：node tools/owner-report/build-parking.mjs
   產出：tools/owner-report/data/parking.json

   為什麼要這一支：

   ① 委託物件的「車位坪數」Rita 填不出來。
      「我真的沒辦法補，你直接從網路上查」—— 那就不要叫她查，系統自己查。
      實價登錄原始檔有「車位移轉總面積」，除以車位數就是一顆車位幾坪。

   ② ⚠⚠ communities.json 的 parkMedian 是「整筆車位總價」，沒有除以車位數。
      竹風青庭寫 240 萬 —— 那是兩顆車位的價，一顆其實 150~180 萬。
      回報單拿 240 去扣單一車位，每坪會少算 2 萬左右。這裡改成**每顆**。

   ③ ⚠⚠ 每一筆成交的車位數不一樣，不可以全部用同一個數字扣。
      竹風青庭近兩年那幾筆：3250 萬那筆是 2 顆、2210 萬那筆是 1 顆。
      所以除了社區層級的規格，還要留一份**逐筆的車位坪數**，
      用 `年月|總價萬|扣車位坪` 當鑰匙去接 deals.json（實測命中 82%、
      撞鍵但值不同的只有 0.16%）。

   ⚠ 產出的檔案只有：社區名、車位坪、車位型式、車位單價、逐筆車位坪。
     **沒有門牌、沒有屋主、沒有交易日期以外的個資**，所以可以進版控。
=================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '../qingpu-communities/data/cache');
const COMM = path.join(HERE, '../qingpu-communities/data/communities.json');
const OUT_DIR = path.join(HERE, 'data');
const OUT = path.join(OUT_DIR, 'parking.json');

const M2_TO_PING = 3.305785;

/* 車位單價的窗口，逐級放寬。⚠ 車位價這幾年在漲，全期中位會低估今天的行情，
   所以先試近三年。竹風青庭近三年只有 2 筆 → 退到近五年 10 筆 → 150 萬。 */
const WIN = [36, 60, 0];          /* 0 = 全部 */
const MIN_WAN_N = 3;              /* 單價至少要幾筆才給 */
const MIN_PING_N = 3;             /* 坪數至少要幾筆才給 */
const MIN_PING_SHARE = 0.5;       /* 坪數眾數要佔一半以上，不然這社區規格太雜 */

const half = (s) =>
  String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const P = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mode = (a) => {
  const t = {};
  a.forEach((x) => { t[x] = (t[x] || 0) + 1; });
  const e = Object.entries(t).sort((x, y) => y[1] - x[1]);
  return e.length ? { v: e[0][0], n: e[0][1], share: e[0][1] / a.length } : null;
};

/** 民國 yyyMMdd → 西元 YYYYMM */
function rocYM(s) {
  const t = half(s);
  if (t.length < 6) return null;
  const y = +t.slice(0, t.length - 4) + 1911;
  const m = +t.slice(t.length - 4, t.length - 2);
  return y > 1911 && m >= 1 && m <= 12 ? y * 100 + m : null;
}

const ymNum = (ym) => Math.floor(ym / 100) * 12 + (ym % 100);
const NOW = ymNum(new Date().getFullYear() * 100 + (new Date().getMonth() + 1));

/* ---------- 讀社區庫 ---------- */
const communities = JSON.parse(fs.readFileSync(COMM, 'utf8')).communities || [];
const idx = communities.filter((c) => c.road && c.noMin != null);
if (!idx.length) { console.error('communities.json 讀不到社區，先跑「更新青埔資料.cmd」'); process.exit(1); }

/* ---------- 掃 CSV ---------- */
/* ⚠ 只認「桃園市中壢區/大園區 <路> <段>? <號>」這種完整門牌。
   土地交易、車位單獨交易那種沒有門牌的直接跳過。 */
const ADDR_RE = /^桃園市(中壢區|大園區)([一-龥]+?[路街])(?:[一二三四五六七八九十]段)?(\d+)號/;

const bag = new Map();     /* id -> { specs:[], deals:Map } */
let scanned = 0, matched = 0, ambiguous = 0;

const files = fs.readdirSync(CACHE).filter((f) => /^A_\d+S\d\.csv$/.test(f)).sort();
if (!files.length) { console.error('找不到 A_*.csv，先跑「更新青埔資料.cmd」'); process.exit(1); }

for (const f of files) {
  const lines = fs.readFileSync(path.join(CACHE, f), 'utf8').split(/\r?\n/);
  for (let i = 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(',');
    const pArea = P(c[24]);
    if (!pArea) continue;                       /* 沒有車位面積就沒事做 */
    scanned++;

    const m = half(c[2] || '').match(ADDR_RE);
    if (!m) continue;
    const hit = idx.filter((x) => x.dist === m[1] && x.road === m[2] &&
      +m[3] >= x.noMin && +m[3] <= x.noMax);
    /* ⚠ 配到兩個以上就放棄，不要猜（見 learning_跨來源對名字）*/
    if (hit.length !== 1) { if (hit.length > 1) ambiguous++; continue; }
    matched++;

    const id = hit[0].id;
    if (!bag.has(id)) bag.set(id, { specs: [], deals: new Map() });
    const b = bag.get(id);

    /* 車位數寫在「交易筆棟數」欄，長這樣：土地1建物1車位2 */
    const nPk = +((c[8] || '').match(/車位(\d+)/) || [0, 1])[1] || 1;
    const ym = rocYM(c[7]);
    const pPrice = P(c[25]);

    b.specs.push({
      ym,
      ping: +(pArea / M2_TO_PING / nPk).toFixed(2),
      kind: (c[23] || '').trim() || null,
      wan: pPrice ? Math.round(pPrice / 10000 / nPk) : null,
    });

    /* 逐筆：用 年月|總價萬|扣車位坪 當鑰匙，對回 deals.json。
       ⚠ 這三個數字的算法要跟 qingpu-communities/build/fetch-build.mjs 一模一樣，
         差一位小數就全部對不上。 */
    const area = P(c[15]), total = P(c[21]);
    const net = area - pArea;
    if (ym && total && net > 0) {
      const pg = Math.round((net / M2_TO_PING) * 10) / 10;
      b.deals.set(`${ym}|${Math.round(total / 10000)}|${pg}`, +(pArea / M2_TO_PING).toFixed(2));
    }
  }
}

/* ---------- 收斂成規格 ---------- */
const byId = {};
let okPing = 0, scatter = 0, thin = 0, okWan = 0;

for (const c of communities) {
  const b = bag.get(c.id);
  if (!b || b.specs.length < MIN_PING_N) { thin++; continue; }

  const mp = mode(b.specs.map((x) => x.ping));
  if (!mp || mp.share < MIN_PING_SHARE) { scatter++; continue; }   /* 規格太雜就不填 */
  okPing++;

  const mk = mode(b.specs.filter((x) => x.kind).map((x) => x.kind));

  /* 單價：窗口逐級放寬，記下用的是哪一個 */
  let wan = null, wanN = 0, wanWin = 0;
  for (const w of WIN) {
    const pool = b.specs.filter((x) => x.wan > 0 && (!w || (x.ym && NOW - ymNum(x.ym) <= w)));
    if (pool.length >= MIN_WAN_N) { wan = Math.round(med(pool.map((x) => x.wan))); wanN = pool.length; wanWin = w; break; }
  }
  if (wan) okWan++;

  byId[c.id] = {
    nm: c.name || null,
    ping: +mp.v,
    pingShare: Math.round(mp.share * 100),
    n: b.specs.length,
    kind: mk ? mk.v : null,
    wan, wanN, wanWin,
    /* 逐筆車位坪，用來算「那一筆成交有幾個車位」*/
    deals: Object.fromEntries(b.deals),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    generatedAt: new Date().toISOString(),
    source: '內政部實價登錄 A 檔（不動產買賣）',
    seasons: files.map((f) => f.replace(/^A_|\.csv$/g, '')),
    note: '只有社區層級的車位規格與逐筆車位坪數，不含門牌與任何個資',
  },
  byId,
}));

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`掃到有車位面積的成交 ${scanned.toLocaleString()} 筆，配得到社區 ${matched.toLocaleString()} 筆（多重命中放棄 ${ambiguous}）`);
console.log(`→ 給得出車位坪數：${okPing} 個社區｜其中連單價也給得出：${okWan}`);
console.log(`   規格太雜不填：${scatter}｜樣本不足 ${MIN_PING_N} 筆：${thin}（共 ${communities.length}）`);
console.log(`寫出 ${OUT}（${kb} KB）`);
