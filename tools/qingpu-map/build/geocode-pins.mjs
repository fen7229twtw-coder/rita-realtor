// 把 143 個青埔社區定位到經緯度。
// 用法： node build/geocode-pins.mjs
//
// 定位順序（先到先得）：
//   1. 門牌比對 —— 用社區的路名 + 門牌號範圍，去 OSM 的 2.7 萬個門牌點裡撈，取平均位置。最準。
//   2. OSM 建物名 —— 社區名剛好被標在建物上，取該建物中心。
//   3. 路段中點 —— 只知道在哪條路上，落在路中間，標記為待校正。
//
// 為什麼不用 Nominatim：實測台灣門牌 6 筆全部查無，它對台灣地址沒有覆蓋。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inBBox } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', 'data', 'cache');
const DATA = join(HERE, '..', 'data');
const COMMUNITIES = join(HERE, '..', '..', 'qingpu-communities', 'data', 'communities.json');
const NOTES = join(HERE, '..', '..', 'qingpu-communities', 'data', 'my-notes.json');
const LEJU_TSV = join(HERE, '..', '..', 'qingpu-communities', 'data', 'leju-crosscheck.tsv');

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/* 路名正規化：資料庫寫「青峰路1段」，OSM 寫「青峰路一段」。 */
function normRoad(s) {
  if (!s) return '';
  return s
    .replace(/\s/g, '')
    .replace(/(\d+)段/, (_, d) => (CN[+d] || d) + '段')
    .replace(/台/g, '臺');
}

/* 門牌號取開頭的整數：「67之1」「67-1」「67號」都算 67。 */
function houseNo(s) {
  const m = String(s).match(/^\s*(\d+)/);
  return m ? +m[1] : null;
}

/* 社區名正規化：去掉空白、括號註記與結尾流水號，兩邊才對得起來 */
const normName = (s) =>
  String(s || '').replace(/[\s\-－—・·．.()（）]/g, '').replace(/[0-9]+$/, '');

/* 「33.99」→ 33.99；「0」與空字串一律當沒有 */
const numOr = (v) => {
  const n = parseFloat(String(v || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const centroid = (pts) => {
  let lat = 0;
  let lon = 0;
  for (const p of pts) { lat += p.lat; lon += p.lon; }
  return { lat: lat / pts.length, lon: lon / pts.length };
};

/* ---------- 沿路門牌內插 ----------
   OSM 的門牌有兩個現實問題：
     1. 大缺口 —— 領航北路四段 901 個點只有 65 個相異號碼（整棟每戶都掛同一號），
        70 之後直接跳到 110，中間的社區查不到。
     2. 收錄不全 —— 五青路只到 515 號，但木川清在 601-613；高鐵南路三段只有 2 個號碼。

   台灣門牌沿著路遞增，所以可以把「已知門牌」投影到道路中心線上，
   對「沿線距離 vs 門牌號」做線性迴歸，再推算目標號碼該落在哪。
   內插（填缺口）與外推（超出收錄範圍）都吃這一套，比丟到路段中點準得多。 */

// 這個尺度下用平面近似就夠：緯度 25 度，經度要乘 cos 修正
const COS_LAT = Math.cos(25 * Math.PI / 180);
const toXY = (lon, lat) => [lon * COS_LAT, lat];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** 把散落的 way 片段接成一條折線：每次挑「離目前尾端最近」的片段接上去。 */
function buildCenterline(ways) {
  const segs = ways
    .map((w) => (w.geometry || []).filter(Boolean).map((g) => toXY(g.lon, g.lat)))
    .filter((s) => s.length >= 2);
  if (!segs.length) return null;

  let line = segs.shift();
  while (segs.length) {
    const tail = line[line.length - 1];
    let best = null;
    let bestD = Infinity;
    let flip = false;
    for (let i = 0; i < segs.length; i++) {
      const dHead = dist2(tail, segs[i][0]);
      const dTail = dist2(tail, segs[i][segs[i].length - 1]);
      if (dHead < bestD) { bestD = dHead; best = i; flip = false; }
      if (dTail < bestD) { bestD = dTail; best = i; flip = true; }
    }
    const seg = segs.splice(best, 1)[0];
    line = line.concat(flip ? seg.reverse() : seg);
  }

  // 累積距離，之後用它當「沿線位置」的座標軸
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(...[0, 1].map((k) => line[i][k] - line[i - 1][k])));
  return { line, cum, total: cum[cum.length - 1] };
}

/** 求某點投影到折線上的「沿線距離」 */
function projectOnLine(cl, p) {
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 1; i < cl.line.length; i++) {
    const a = cl.line[i - 1];
    const b = cl.line[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < bestD) { bestD = d; bestT = cl.cum[i - 1] + t * Math.hypot(dx, dy); }
  }
  return bestT;
}

/** 沿線距離換回經緯度 */
function pointAt(cl, t) {
  const clamped = Math.max(0, Math.min(cl.total, t));
  for (let i = 1; i < cl.cum.length; i++) {
    if (cl.cum[i] >= clamped) {
      const span = cl.cum[i] - cl.cum[i - 1];
      const f = span ? (clamped - cl.cum[i - 1]) / span : 0;
      const a = cl.line[i - 1];
      const b = cl.line[i];
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      return { lat: y, lon: x / COS_LAT };
    }
  }
  const last = cl.line[cl.line.length - 1];
  return { lat: last[1], lon: last[0] / COS_LAT };
}

/**
 * 用同一條路上已知門牌的位置，推算目標門牌號的位置。
 * @returns {{lat,lon,r2,n,extrapolated}|null}
 */
function interpolateByNumber(cl, known, targetNo) {
  /* 台灣門牌是「單號一側、雙號另一側」，兩側各自遞增。
     混在一起做迴歸會互相干擾（青昇路混算只有 R²=0.55），
     所以先只取跟目標同奇偶的門牌；同側樣本太少才退回全部一起算。 */
  const sameParity = known.filter((a) => a.no % 2 === targetNo % 2);
  const pool = sameParity.length >= 3 ? sameParity : known;

  // 同號碼多點先合併，否則整棟大樓的幾十戶會把迴歸拉偏
  const byNo = new Map();
  for (const a of pool) {
    if (!byNo.has(a.no)) byNo.set(a.no, []);
    byNo.get(a.no).push(projectOnLine(cl, toXY(a.lon, a.lat)));
  }
  const pts = [...byNo.entries()]
    .map(([no, ts]) => ({ no, t: ts.reduce((s, x) => s + x, 0) / ts.length }))
    .sort((a, b) => a.no - b.no);
  if (pts.length < 3) return null;

  // t = a*no + b
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.no, 0) / n;
  const my = pts.reduce((s, p) => s + p.t, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) { num += (p.no - mx) * (p.t - my); den += (p.no - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;
  const intercept = my - slope * mx;

  // 判定係數：門牌與位置的關係夠線性才採用，否則這條路的編號方式不吃這套
  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    ssRes += (p.t - (slope * p.no + intercept)) ** 2;
    ssTot += (p.t - my) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  if (r2 < 0.8) return null;          // 線性度不夠就別猜，寧可標成待校正

  const lo = pts[0].no;
  const hi = pts[n - 1].no;
  const extrapolated = targetNo < lo || targetNo > hi;

  /* 內插時要看「左右兩個已知門牌隔多遠」。
     高捷VILLA 是高鐵南路三段 169 號，同側只有 73／467／655 三個門牌，
     用 73 和 467 去夾 169，中間隔了 394 號約 800 公尺 ——
     這種粗糙度定位不了一棟樓，硬算會把它丟到離譜的地方（實測落到圖框角落）。 */
  if (!extrapolated) {
    let below = -Infinity;
    let above = Infinity;
    for (const p of pts) {
      if (p.no <= targetNo && p.no > below) below = p.no;
      if (p.no >= targetNo && p.no < above) above = p.no;
    }
    if (above - below > 120) return null;
  }

  const t = slope * targetNo + intercept;
  const pos = pointAt(cl, t);

  /* 外推要用「離最近的已知門牌多遠」來卡，不能用門牌號的比例。
     青昇路已知雙號只有 250-280（跨距 30 號），但那段路的門牌很密，
     推到 338 號其實只離 280 號 178 公尺，完全合理；
     用比例卡（超出跨距的 60%）會把這種正常情況誤殺。 */
  let nearest = Infinity;
  for (const a of pool) {
    const d = Math.hypot((pos.lat - a.lat) * 111000, (pos.lon - a.lon) * 111000 * COS_LAT);
    if (d < nearest) nearest = d;
  }
  if (extrapolated && nearest > 250) return null;   // 離已知門牌超過 250 公尺就沒依據了

  return { ...pos, r2, n, extrapolated, nearest: Math.round(nearest) };
}

/* ---------- 樂居地址解析 ----------
   樂居 TSV 的「地址」欄有三種寫法，各自要用不同方式定位：
     1. 「青峰路一段71號」  → 路名 + 門牌，走跟社區資料庫同一套門牌比對，最準。
     2. 「領航南路四段、青溪路二段」→ 基地的四至（幾條路圍起來的街廓），
        取這幾條路彼此最靠近的地方，也就是街角。整個街廓通常就那麼一棟。
     3. 「高鐵北路二段」    → 只知道在哪條路上，落路中點，標成待校正。
   括號註記（例：「青境路(國泰資訊大樓對面)」）先剝掉再解析。 */
function parseLejuAddr(raw) {
  const clean = String(raw || '')
    .replace(/[（(][^）)]*[）)]/g, '')       // 剝掉「(國泰資訊大樓對面)」這種註記
    .replace(/\s/g, '')
    .trim();
  if (!clean) return null;

  const parts = clean.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  const roads = [];
  let no = null;
  for (const part of parts) {
    // 「五青路63巷601號」：巷弄之後的號才是門牌，路名只取到巷之前
    const m = part.match(/^(.+?[路街道])((?:[一二三四五六七八九十\d]+段)?)(.*)$/);
    if (!m) { roads.push(part); continue; }
    const road = m[1] + m[2];
    roads.push(road);
    const tail = m[3] || '';
    const hit = tail.match(/(\d+)(?:[-之](\d+))?號/) || tail.match(/^(\d+)/);
    if (hit && no == null) no = +hit[1];
  }
  if (!roads.length) return null;
  return { roads, no };
}

/** 兩條路中心線彼此最靠近的位置（街角）。用來定位只給四至、沒給門牌的建案。 */
function nearestCrossing(clA, clB) {
  if (!clA || !clB) return null;
  let best = null;
  let bestD = Infinity;
  // 折線點很多時抽樣就夠：街角的精度到公尺級即可，不需要逐點比
  const stepA = Math.max(1, Math.floor(clA.line.length / 400));
  const stepB = Math.max(1, Math.floor(clB.line.length / 400));
  for (let i = 0; i < clA.line.length; i += stepA) {
    for (let j = 0; j < clB.line.length; j += stepB) {
      const d = dist2(clA.line[i], clB.line[j]);
      if (d < bestD) { bestD = d; best = [clA.line[i], clB.line[j]]; }
    }
  }
  if (!best) return null;
  const x = (best[0][0] + best[1][0]) / 2;
  const y = (best[0][1] + best[1][1]) / 2;
  // 兩條路最近處還差 300 公尺以上，代表根本沒交會，這組四至不可信
  const gapM = Math.sqrt(bestD) * 111000;
  if (gapM > 300) return null;
  return { lat: y, lon: x / COS_LAT, gapM: Math.round(gapM) };
}

async function main() {
  const communities = JSON.parse(await readFile(COMMUNITIES, 'utf8')).communities;

  /* 「我的註記」層：Rita 用樂居人工核對過的戶數、公設比與修正過的社區名。
     這層是人工查證的，優先於官方管線跑出來的資料 —— 重跑管線不會蓋掉它，
     所以地圖也要吃這一層，不然圖上顯示的會是比較差的那份。 */
  const notes = await readFile(NOTES, 'utf8')
    .then((s) => JSON.parse(s).byId || {})
    .catch(() => ({}));
  const noteOf = (id) => notes[id] || {};

  /* ---- 樂居人工快照（leju-crosscheck.tsv，225 筆）----
     my-notes 只留了戶數與公設比，但這份原始檔還有「地址」與「屋齡或完工」，
     帶看時客戶會問的就是這些。整份接進來，讓卡片一按就看得到，不用再跳出去查。
     樂居有 Cloudflare 不能自動抓，這是 Rita 一次性人工核對的成果。 */
  const leju = new Map();
  const lejuAll = [];                               // 保留全部 225 筆，補點時要用
  try {
    const raw = await readFile(LEJU_TSV, 'utf8');
    const lines = raw.trim().split('\n').map((l) => l.split('\t'));
    lines.shift();                                  // 表頭
    for (const r of lines) {
      const rawName = (r[1] || '').trim();
      const k = normName(rawName);
      if (!k) continue;
      const rec = {
        rawName,
        block: (r[0] || '').trim() || undefined,
        addr: (r[2] || '').trim() || undefined,
        households: numOr(r[3]),
        ratio: numOr(r[4]),
        age: (r[5] || '').trim() || undefined,
      };
      lejuAll.push(rec);
      /* Map 只留同名的第一筆：normName 會去掉結尾流水號，
         「禾林RICH ONE」「禾林RICH ONE2」「禾林RICH ONE3」會撞成同一個 key。
         查欄位時取第一筆就好，但補點要當成三個不同建案 —— 所以另存 lejuAll。 */
      if (!leju.has(k)) leju.set(k, rec);
    }
  } catch { /* 沒有這份檔就只是少了樂居欄位，不影響定位 */ }

  /* 社區名對樂居名。先求完全相同，再退一步找包含關係
     （樂居用銷售名、管委會用登記名，例：良茂詠恆詠美館 vs 良茂詠恆）。
     命中的樂居原始名記進 usedLeju，後面補點時就不會再畫一次同一個社區。 */
  const lejuKeys = [...leju.keys()];
  const usedLeju = new Set();
  const lejuOf = (name) => {
    const n = normName(name);
    if (!n) return null;
    let hit = leju.get(n);
    if (!hit) {
      const k = lejuKeys.find((x) => x.length > 2 && (x.includes(n) || n.includes(x)));
      hit = k ? leju.get(k) : null;
    }
    if (hit) usedLeju.add(hit.rawName);
    return hit || null;
  };
  const addrRaw = JSON.parse(await readFile(join(CACHE, 'addresses.json'), 'utf8')).elements;
  const bldRaw = JSON.parse(await readFile(join(CACHE, 'buildings.json'), 'utf8')).elements;
  const roadRaw = JSON.parse(await readFile(join(CACHE, 'roads.json'), 'utf8')).elements;

  /* ---- 索引 0：路名 → 中心線（門牌內插要用） ---- */
  const roadWays = new Map();
  for (const el of roadRaw) {
    const name = el.tags?.name;
    if (!name || !el.tags?.highway || !el.geometry) continue;
    if (!roadWays.has(name)) roadWays.set(name, []);
    roadWays.get(name).push(el);
  }
  const clCache = new Map();
  const centerlineOf = (name) => {
    if (!clCache.has(name)) clCache.set(name, buildCenterline(roadWays.get(name) || []));
    return clCache.get(name);
  };

  /* ---- 索引 1：路名 → 門牌點 ----
     這裡刻意「不」濾 inBBox：門牌抓的是放大範圍，
     要先能定位到，才判斷得出這個社區是落在圖框外還是根本查不到。 */
  const byStreet = new Map();
  for (const el of addrRaw) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const no = houseNo(t['addr:housenumber']);
    if (no == null) continue;
    const street = normRoad(t['addr:street']);
    if (!street) continue;
    if (!byStreet.has(street)) byStreet.set(street, []);
    byStreet.get(street).push({ no, lat, lon });
  }

  /* ---- 索引 2：建物名 → 中心點 ---- */
  const byBldName = new Map();
  for (const el of bldRaw) {
    const t = el.tags || {};
    if (!t.name || !el.geometry) continue;
    const pts = el.geometry.filter(Boolean);
    if (!pts.length) continue;
    const c = centroid(pts);
    if (!inBBox(c.lon, c.lat)) continue;
    const key = t.name.replace(/[\s\-－—・·．.]/g, '');
    if (!byBldName.has(key)) byBldName.set(key, c);
  }

  console.log(`門牌索引：${byStreet.size} 條路、${[...byStreet.values()].reduce((a, b) => a + b.length, 0)} 個門牌點`);
  console.log(`建物名索引：${byBldName.size} 筆\n`);

  /* ---- 逐一定位 ---- */
  const pins = [];
  const stats = { addr: 0, addrLoose: 0, interp: 0, name: 0, road: 0, offMap: 0, none: 0 };
  const interpNotes = [];
  const offMap = [];

  for (const c of communities) {
    const note = noteOf(c.id);
    // 我人工核對過的名字優先（例：站前新? → 站前新銳）
    const name = note.name || c.name;
    if (!name) continue;                         // 未命名社區不上圖
    const lj = lejuOf(name);

    /* 路名要試好幾種寫法。
       OSM 會把同一條路拆成兩個名字：「青昇路一段」只有 8 個門牌（23~105），
       但「青昇路」（不寫段）另外有 21 個（123~280）—— 青城之愛的 250-252 就在後者。
       只認 roadFull 會漏掉一整段。
       順序是「先精確、再放寬」：有分段的路（高鐵南路一/二/三段）不能一開始就合併，
       不同段的門牌號會重號，混在一起反而定位到錯的地方。 */
    const candidates = [...new Set([
      normRoad(c.roadFull || c.road),
      normRoad(c.road),
    ].filter(Boolean))];

    let street = candidates[0];
    // 先挑「門牌號真的落在社區範圍內」的那個寫法，都沒有才用點數最多的
    const lo0 = c.noMin;
    const hi0 = c.noMax ?? c.noMin;
    let list = [];
    if (lo0 != null) {
      for (const k of candidates) {
        const l = byStreet.get(k) || [];
        if (l.some((a) => a.no >= lo0 && a.no <= hi0)) { list = l; street = k; break; }
      }
    }
    if (!list.length) {
      for (const k of candidates) {
        const l = byStreet.get(k) || [];
        if (l.length > list.length) { list = l; street = k; }
      }
    }
    let pos = null;
    let conf = null;
    let hits = 0;

    // 1. 門牌號落在社區的門牌範圍內
    if (list.length && c.noMin != null) {
      const lo = c.noMin;
      const hi = c.noMax ?? c.noMin;
      const inRange = list.filter((a) => a.no >= lo && a.no <= hi);
      if (inRange.length) {
        pos = centroid(inRange);
        conf = 'addr';
        hits = inRange.length;
        stats.addr++;
      } else {
        // 範圍內沒有，退一步找最接近的門牌號（社區門牌常有跳號）
        let bestDiff = Infinity;
        let best = null;
        for (const a of list) {
          const d = Math.min(Math.abs(a.no - lo), Math.abs(a.no - hi));
          if (d < bestDiff) { bestDiff = d; best = a; }
        }
        if (best && bestDiff <= 20) {
          pos = { lat: best.lat, lon: best.lon };
          conf = 'addr-near';
          hits = 1;
          stats.addrLoose++;
        }
      }
    }

    // 2. 沿路門牌內插／外推。
    //    處理兩種現實狀況：OSM 門牌有大缺口（70 直接跳 110），或整段沒收錄
    //    （五青路只到 515 號，但社區在 601-613）。
    if (!pos && list.length >= 3 && c.noMin != null) {
      const cl = centerlineOf(street);
      if (cl) {
        const target = (c.noMin + (c.noMax ?? c.noMin)) / 2;
        const got = interpolateByNumber(cl, list, target);
        if (got) {
          pos = { lat: got.lat, lon: got.lon };
          conf = 'interp';
          stats.interp++;
          interpNotes.push(`${name}（${street}${c.addrRange || ''}）→ 沿路推算，`
            + `參考 ${got.n} 個門牌、線性度 R²=${got.r2.toFixed(2)}`
            + (got.extrapolated ? `、外推自 ${got.nearest}m 外的最近門牌` : ''));
        }
      }
    }

    // 3. OSM 建物名比對
    if (!pos) {
      const key = name.replace(/[\s\-－—・·．.]/g, '');
      const hit = byBldName.get(key);
      if (hit) { pos = hit; conf = 'name'; stats.name++; }
    }

    // 4. 路段中點（最後手段，位置不準，圖上會標成待校正）
    if (!pos && list.length) {
      pos = centroid(list);
      conf = 'road';
      stats.road++;
    }

    if (!pos) {
      stats.none++;
      offMap.push({ name, dist: c.dist, road: c.roadFull || c.road, addrRange: c.addrRange, why: '查無門牌' });
      continue;
    }

    // 定位到了，但落在地圖範圍外 —— 不要硬畫進圖裡（會標在錯的地方），改列進清單
    if (!inBBox(pos.lon, pos.lat)) {
      stats.offMap++;
      offMap.push({
        name, dist: c.dist, road: c.roadFull || c.road, addrRange: c.addrRange,
        lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), why: '在本圖範圍外',
      });
      continue;
    }

    pins.push({
      id: c.id,
      name,
      nameIsMine: note.name ? true : undefined,
      /* 樂居人工核對來的欄位，官方管線沒有這些。帶看時客戶最常問的就是這幾項。
         my-notes（我自己改過的）優先於 TSV 原始快照。 */
      households: note.households ? Number(note.households) : lj?.households,
      publicRatio: note.ratio ? Number(note.ratio) : lj?.ratio,
      lejuAddr: lj?.addr,
      lejuAge: lj?.age,
      lejuBlock: lj?.block,
      lat: +pos.lat.toFixed(6),
      lon: +pos.lon.toFixed(6),
      conf,
      hits,
      block: c.block,
      dist: c.dist,
      road: c.roadFull || c.road,
      addrRange: c.addrRange,
      age: c.age,
      doneRoc: c.doneRoc,
      totalFloor: c.totalFloor,
      upMedian: c.upMedian,
      trend: c.trend,
      deals1y: c.deals1yHome ?? c.deals1y,
      dealsAll: c.dealsHome ?? c.dealsAll,
      rooms: c.rooms,
      parkMedian: c.parkMedian,
      propertyKind: c.propertyKind,
    });
  }

  /* ---- 樂居補點 ----
     實價登錄資料庫只收得到「有成交紀錄」的社區，所以圖上原本只有 114 個點，
     但 Rita 人工核對過的樂居清單有 225 筆 —— 中間差的多半是預售屋、剛交屋、
     或成交量少到沒進實價登錄的社區。這些帶看時照樣會被客戶問到，圖上不能沒有。
     這一段把「樂居有、上面主流程沒對到」的社區，用樂居自己的地址欄定位補上圖，
     標成 src:'leju'，前端用不同顏色畫，一眼看得出它沒有成交行情可查。 */
  const BLOCK_LABEL = { A17: 'A17 領航', A18: 'A18 高鐵站', A19: 'A19 體育園區', 大園: '其他' };
  const onMapNames = new Set(pins.map((p) => normName(p.name)));
  const lejuStats = { addr: 0, interp: 0, name: 0, cross: 0, road: 0, offMap: 0, none: 0 };
  let lejuSeq = 0;

  for (const lj of lejuAll) {
    if (usedLeju.has(lj.rawName)) continue;            // 主流程已經對到這筆
    const nm = normName(lj.rawName);
    if (!nm || onMapNames.has(nm)) continue;           // 名字已經在圖上
    lejuSeq++;

    const parsed = parseLejuAddr(lj.addr);
    if (!parsed) {
      lejuStats.none++;
      offMap.push({ name: lj.rawName, dist: '', road: lj.addr || '', why: '樂居沒給地址' , src: 'leju' });
      continue;
    }

    let pos = null;
    let conf = null;
    let hits = 0;

    // 1. 有門牌 → 走跟社區資料庫同一套：先找同號、再找最接近的號
    if (parsed.no != null) {
      for (const r of parsed.roads) {
        const street = normRoad(r);
        const list = byStreet.get(street) || [];
        if (!list.length) continue;
        const exact = list.filter((a) => a.no === parsed.no);
        if (exact.length) { pos = centroid(exact); conf = 'addr'; hits = exact.length; lejuStats.addr++; break; }
        let bestDiff = Infinity;
        let best = null;
        for (const a of list) {
          const d = Math.abs(a.no - parsed.no);
          if (d < bestDiff) { bestDiff = d; best = a; }
        }
        if (best && bestDiff <= 20) {
          pos = { lat: best.lat, lon: best.lon }; conf = 'addr-near'; hits = 1; lejuStats.addr++; break;
        }
        // 2. 門牌有缺口就沿路推算（跟主流程同一支迴歸）
        if (list.length >= 3) {
          const cl = centerlineOf(street);
          const got = cl && interpolateByNumber(cl, list, parsed.no);
          if (got) { pos = { lat: got.lat, lon: got.lon }; conf = 'interp'; lejuStats.interp++; break; }
        }
      }
    }

    // 3. OSM 建物名比對（樂居用銷售名，有些剛好標在建物上）
    if (!pos) {
      const hit = byBldName.get(lj.rawName.replace(/[\s\-－—・·．.]/g, ''));
      if (hit) { pos = hit; conf = 'name'; lejuStats.name++; }
    }

    // 4. 只給四至（幾條路圍起來的街廓）→ 取街角
    if (!pos && parsed.roads.length >= 2) {
      for (let i = 0; i < parsed.roads.length - 1 && !pos; i++) {
        for (let j = i + 1; j < parsed.roads.length && !pos; j++) {
          const x = nearestCrossing(centerlineOf(normRoad(parsed.roads[i])), centerlineOf(normRoad(parsed.roads[j])));
          if (x) { pos = { lat: x.lat, lon: x.lon }; conf = 'corner'; lejuStats.cross++; }
        }
      }
    }

    // 5. 只知道在哪條路上 → 路段中點，前端會標成待校正
    if (!pos) {
      for (const r of parsed.roads) {
        const list = byStreet.get(normRoad(r)) || [];
        if (list.length) { pos = centroid(list); conf = 'road'; lejuStats.road++; break; }
        const cl = centerlineOf(normRoad(r));
        if (cl) { pos = pointAt(cl, cl.total / 2); conf = 'road'; lejuStats.road++; break; }
      }
    }

    if (!pos) {
      lejuStats.none++;
      offMap.push({ name: lj.rawName, dist: '', road: lj.addr || '', why: '查無門牌', src: 'leju' });
      continue;
    }
    if (!inBBox(pos.lon, pos.lat)) {
      lejuStats.offMap++;
      offMap.push({
        name: lj.rawName, dist: '', road: lj.addr || '',
        lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), why: '在本圖範圍外', src: 'leju',
      });
      continue;
    }

    /* 「2026年第四季度完工」這種是還沒交屋的預售案，跟成屋要分得開 ——
       帶看時講法完全不同，圖上會另外標一個「預售」記號。
       樂居的屋齡欄只有數字（例：「3」）就是已完工的成屋。 */
    const ageTxt = lj.age || '';
    const presale = /202[6-9]|20[3-9]\d|完工|交屋|年底|季度/.test(ageTxt) && !/^\d+$/.test(ageTxt.trim());
    const ageNum = /^\d+$/.test(ageTxt.trim()) ? +ageTxt.trim() : undefined;

    pins.push({
      id: 'leju-' + lejuSeq,
      name: lj.rawName,
      src: 'leju',                                    // 前端靠這個欄位換顏色
      presale: presale || undefined,
      households: lj.households,
      publicRatio: lj.ratio,
      lejuAddr: lj.addr,
      lejuAge: lj.age,
      lejuBlock: lj.block,
      lat: +pos.lat.toFixed(6),
      lon: +pos.lon.toFixed(6),
      conf,
      hits,
      block: BLOCK_LABEL[lj.block] || lj.block || '其他',
      dist: lj.block === '大園' ? '大園區' : '中壢區',
      road: parsed.roads[0],
      addrRange: lj.addr,
      age: ageNum,
    });
    onMapNames.add(nm);
  }

  const MIN_GAP_M = 28;                        // 圓點在圖上的直徑差不多這麼大
  const M_PER_DEG_LAT = 111000;
  const M_PER_DEG_LON = 111000 * COS_LAT;
  const metersApart = (a, b) => Math.hypot(
    (a.lat - b.lat) * M_PER_DEG_LAT,
    (a.lon - b.lon) * M_PER_DEG_LON
  );

  /* 撞名（同一棟樓兩個名字）的偵測搬到 build/find-duplicates.mjs：
     那支用門牌比對，比在這裡用座標猜準得多，跑完地圖再跑一次就好。 */

  /* ---- 疊點錯開 ----
     樂居補的點常常落在同一個位置：兩個建案只給「青峰路二段」就都掉到路中點，
     同一個街廓的四至也會算出同一個街角。座標一樣的話圖上只看得到一個圓點，
     另一個永遠點不到 —— 跟功能壞掉沒兩樣。
     所以補點放上去之前，先看有沒有人站在那裡，有的話沿小圓往外挪到空位。
     只挪樂居補的點，官方管線那 114 個是門牌級精準定位，絕對不動。 */
  const placed = pins.filter((p) => p.src !== 'leju').map((p) => ({ lat: p.lat, lon: p.lon }));
  let nudged = 0;
  for (const p of pins) {
    if (p.src !== 'leju') continue;
    let spot = { lat: p.lat, lon: p.lon };
    if (placed.some((q) => metersApart(spot, q) < MIN_GAP_M)) {
      // 一圈一圈往外找空位：先繞半徑 30 公尺八個方向，不夠再放大
      outer:
      for (let ring = 1; ring <= 4; ring++) {
        const rM = MIN_GAP_M * (ring + 0.1);
        for (let k = 0; k < 8; k++) {
          const th = (k / 8) * 2 * Math.PI + ring;   // 每圈轉一點角度，不然會排成十字
          const cand = {
            lat: p.lat + (rM * Math.sin(th)) / M_PER_DEG_LAT,
            lon: p.lon + (rM * Math.cos(th)) / M_PER_DEG_LON,
          };
          if (!inBBox(cand.lon, cand.lat)) continue;
          if (placed.every((q) => metersApart(cand, q) >= MIN_GAP_M)) { spot = cand; break outer; }
        }
      }
      if (spot.lat !== p.lat || spot.lon !== p.lon) {
        p.lat = +spot.lat.toFixed(6);
        p.lon = +spot.lon.toFixed(6);
        p.nudged = true;                       // 卡片上會註明位置是挪過的
        nudged++;
      }
    }
    placed.push({ lat: p.lat, lon: p.lon });
  }
  if (nudged) console.log(`\n疊點錯開：${nudged} 個樂居點原本壓在別的社區上，已挪開`);

  // 官方管線命名的 + 我人工補命名的都算「有名字」，兩者都會上圖
  const named = communities.filter((c) => c.name || noteOf(c.id).name).length;
  await writeFile(
    join(DATA, 'pins.json'),
    JSON.stringify({
      meta: {
        generatedAt: new Date().toISOString(),
        total: named,
        located: pins.length,
        govLocated: pins.filter((p) => p.src !== 'leju').length,
        lejuLocated: pins.filter((p) => p.src === 'leju').length,
        lejuTotal: lejuAll.length,
        byConfidence: stats,
        offMapCount: offMap.length,
        source: '社區資料：內政部實價登錄 + 桃園市管委會清冊；座標比對：OpenStreetMap 門牌點（ODbL）',
      },
      pins,
      offMap,
    }),
    'utf8'
  );

  /* 統計要從最終結果反推。
     stats 是「某個方法成功了」的計數，但成功之後還可能被判定在圖框外而不上圖，
     直接印 stats 會重複計算、加起來超過社區總數。
     官方管線與樂居補點要分開算：兩邊的分母不一樣，混在一起看不出誰的定位比較準。 */
  const govPins = pins.filter((p) => p.src !== 'leju');
  const lejuPins = pins.filter((p) => p.src === 'leju');
  const onMap = {};
  for (const p of govPins) onMap[p.conf] = (onMap[p.conf] || 0) + 1;
  const pct = (n) => ((n / named) * 100).toFixed(0) + '%';
  const row = (label, n) => console.log(`  ${label.padEnd(16)}${String(n).padStart(3)}  ${pct(n)}`);
  console.log(`已命名社區 ${named} 個 → 上圖 ${govPins.length} 個、範圍外 ${offMap.filter((o) => o.src !== 'leju').length} 個\n`);
  console.log('上圖的定位方式：');
  row('門牌精準比對', onMap.addr || 0);
  row('門牌就近比對', onMap['addr-near'] || 0);
  row('沿路門牌推算', onMap.interp || 0);
  row('建物名比對', onMap.name || 0);
  row('路段中點(待校正)', onMap.road || 0);
  const precise = (onMap.addr || 0) + (onMap['addr-near'] || 0) + (onMap.interp || 0);
  console.log(`\n  → 門牌級精準 ${precise} 個，佔上圖的 ${((precise / govPins.length) * 100).toFixed(0)}%`);

  /* ---- 樂居補點的統計 ---- */
  const ljOn = {};
  for (const p of lejuPins) ljOn[p.conf] = (ljOn[p.conf] || 0) + 1;
  const ljOff = offMap.filter((o) => o.src === 'leju').length;
  console.log(`\n樂居補點：清單 ${lejuAll.length} 筆，其中 ${lejuSeq} 筆官方管線沒有`
    + ` → 補上圖 ${lejuPins.length} 個、圖框外或查不到 ${ljOff} 個`);
  const ljRow = (label, n) => console.log(`  ${label.padEnd(16)}${String(n).padStart(3)}`);
  ljRow('門牌比對', (ljOn.addr || 0) + (ljOn['addr-near'] || 0));
  ljRow('沿路門牌推算', ljOn.interp || 0);
  ljRow('建物名比對', ljOn.name || 0);
  ljRow('街角(只給四至)', ljOn.corner || 0);
  ljRow('路段中點(待校正)', ljOn.road || 0);
  console.log(`\n全圖共 ${pins.length} 個社區（官方 ${govPins.length} + 樂居 ${lejuPins.length}）`);
  const presaleN = lejuPins.filter((p) => p.presale).length;
  if (presaleN) console.log(`  其中 ${presaleN} 個是還沒交屋的預售案`);
  if (offMap.length) {
    console.log(`
本圖範圍外或查無門牌（不畫進圖裡，改列在側欄）：`);
    offMap.forEach((o) => console.log(`  ${o.name.padEnd(12)} ${o.dist} ${o.road} ${o.addrRange || ""}  — ${o.why}`));
  }
  if (interpNotes.length) {
    console.log('\n沿路推算的明細：');
    interpNotes.forEach((n) => console.log('  ' + n));
  }
}

main().catch((err) => { console.error('失敗：', err.stack); process.exit(1); });
