// 把社區的點修準一點。跑在 geocode-pins.mjs 之後。
// 用法： node build/refine-pins.mjs        （加 --dry 只看報告不寫檔）
//
// 為什麼需要這一步
// ----------------
// geocode-pins 只有一個來源：OSM 的門牌點。而 OSM 的門牌點標在「路邊」不是「房子上」，
// 青埔又有很多新大樓根本還沒被畫進 OSM。實測 conf 標成 addr（最準的那一級）的社區，
// 還是有一堆離最近的建物 28~72 公尺 —— 那就是地圖上看起來「點歪掉」的原因。
// 一個來源錯了也沒人知道，所以這裡改成三個來源投票。
//
// 三個來源（彼此獨立）
//   A. OSM 門牌點     現在 pins.json 的位置，geocode-pins 算的
//   B. 591 社區頁     tools/qingpu-layouts 已經抓好、也對好社區編號了
//   C. 信義房屋社區頁   build/fetch-sinyi-xy.mjs 抓的
//
// 怎麼投
//   兩個以上互相靠近（35 公尺內）→ 取那一群的平均，那就是答案
//   三個各說各話                → 不猜，位置不動，列進待確認清單
//
// 建物只用來「微調」，不用來「搬家」
// --------------------------------
// 第一版是「把點吸到附近最像住宅的大樓上」，實測會出事：潤隆國家大院那棟有 12053 ㎡，
// 42 公尺內把亞昕喜徠登、青城之愛一起吸過去，等於把客戶帶到隔壁社區門口。
// OSM 在青埔只畫了 2120 棟，一棟大的旁邊常常沒有第二個候選可以拿來比對，
// 所以「唯一候選」這個條件根本擋不住。現在的規矩是：
//   1. 建物名字就等於社區名 → 直接用它（這種最多 80 公尺內都算數，名字不會騙人）
//   2. 否則只在「點本來就落在建物裡、或貼在 15 公尺內」才把點挪到建物中心，
//      而且同一棟建物只能被一個社區認領，最多挪 25 公尺。
//      這是微調（把路邊的點挪到房子中央），不是重新定位。
//
// 不碰的東西
//   data/pins-manual.json 裡 Rita 手動拖過的點完全不動，那是她親眼確認過的。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const CACHE = join(DATA, 'cache');
const LAYOUTS = join(HERE, '..', '..', 'qingpu-layouts', 'data');

const DRY = process.argv.includes('--dry');

/* ---------- 幾何 ---------- */
const R = 6378137;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) =>
  Math.hypot(
    rad(b.lon - a.lon) * R * Math.cos(rad((a.lat + b.lat) / 2)),
    rad(b.lat - a.lat) * R
  );

function inside(pt, ring) {
  let on = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    if ((yi > pt.lat) !== (yj > pt.lat) &&
        pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}
const toEdge = (pt, ring) => {
  let m = Infinity;
  for (const v of ring) m = Math.min(m, dist(pt, v));
  return m;
};

/* 商業設施的名字。這種建物不會是社區本體 —— 實測有社區的點旁邊最近的是
   「河馬水產 活體海鮮超市火鍋」。 */
const SHOP = /超市|火鍋|五金|便利|7-Eleven|全家|加油|停車場|銀行|郵局|醫院|診所|學校|國小|國中|高中|大學|派出所|消防|車站|廟|宮|寺|教會|市場|餐廳|咖啡|牛排|燒|飯店|旅館|商貿|購物|outlet|Outlet|IKEA|新光|環球|大江|球場|體育|美術館|圖書/;
const NOT_HOME = ['retail', 'commercial', 'industrial', 'school', 'train_station',
  'church', 'temple', 'warehouse', 'roof', 'garage', 'garages', 'service',
  'kindergarten', 'hospital', 'public', 'civic', 'sports_hall', 'stadium'];

const normName = (s) => String(s || '').replace(/[\s\-－—・·．.()（）]/g, '');

/* ---------- 讀資料 ---------- */
const pinsFile = join(DATA, 'pins.json');
const pinsDoc = JSON.parse(await readFile(pinsFile, 'utf8'));
const pins = pinsDoc.pins;

const bldRaw = JSON.parse(await readFile(join(CACHE, 'buildings.json'), 'utf8')).elements;
const buildings = [];
for (const b of bldRaw) {
  const g = b.geometry;
  if (!g || g.length < 3) continue;
  let la = 0, lo = 0, la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const p of g) {
    la += p.lat; lo += p.lon;
    la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat);
    lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon);
  }
  const c = { lat: la / g.length, lon: lo / g.length };
  const w = dist({ lat: la0, lon: lo0 }, { lat: la0, lon: lo1 });
  const h = dist({ lat: la0, lon: lo0 }, { lat: la1, lon: lo0 });
  const tags = b.tags || {};
  const name = tags.name || '';
  buildings.push({
    id: b.id, c, ring: g, area: Math.round(w * h), name,
    homey: !SHOP.test(name) && !NOT_HOME.includes(tags.building || ''),
  });
}

/* 591 的座標（tools/qingpu-layouts 已經對好社區編號） */
const arrOf = (x) => (Array.isArray(x) ? x : Object.values(x).find(Array.isArray) || []);
const by591 = new Map();
for (const f of ['match.json', 'market-591-match.json']) {
  const p = join(LAYOUTS, f);
  if (!existsSync(p)) continue;
  for (const r of arrOf(JSON.parse(await readFile(p, 'utf8')))) {
    if (r.communityId && r.lat && r.lng) {
      by591.set(r.communityId, { lat: r.lat, lon: r.lng, addr: r.addr591 || r.addr || '' });
    }
  }
}

/* 門牌正規化：「領航北路1段296號」與「領航北路一段296號」是同一個地方。
   591 給的座標旁邊就寫著它自己認的門牌，那個門牌如果跟樂居核對過的門牌一模一樣，
   就等於「這個座標是這個門牌的座標」—— 這比兩個來源湊在一起還硬。 */
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const normAddr = (s) => String(s || '')
  .replace(/\s/g, '')
  .replace(/^桃園市/, '')
  .replace(/^(中壢區|大園區|蘆竹區|桃園區)/, '')
  .replace(/(\d+)段/, (_, d) => (CN[+d] || d) + '段')
  .replace(/台/g, '臺')
  .replace(/之\d+$|-\d+號$/, (m) => (m.endsWith('號') ? '號' : ''));

/* 信義的座標（build/fetch-sinyi-xy.mjs 抓的，用社區名對） */
const bySinyi = new Map();
const sinyiFile = join(DATA, 'sinyi-xy.json');
if (existsSync(sinyiFile)) {
  const doc = JSON.parse(await readFile(sinyiFile, 'utf8'));
  for (const [name, v] of Object.entries(doc.items || {})) {
    if (v && v.lat && v.lon) bySinyi.set(normName(name), { lat: v.lat, lon: v.lon });
  }
}
console.log('來源：OSM 門牌點 ' + pins.length + ' 個社區　'
  + '591 ' + by591.size + ' 個　信義 ' + bySinyi.size + ' 個'
  + (bySinyi.size ? '' : '（還沒抓，先跑 build/fetch-sinyi-xy.mjs）'));

/* Rita 手動拖過的點不碰 */
let manual = {};
const manualFile = join(DATA, 'pins-manual.json');
if (existsSync(manualFile)) manual = (JSON.parse(await readFile(manualFile, 'utf8')).pins) || {};

/* ---------- 第一輪：投票決定位置 ---------- */
const AGREE = 35;        // 兩個來源差在這個距離內就算「說的是同一個地方」
const FAR = 400;         // 差超過這個距離的多半是對到別的同名社區
const FAR_MAX = 900;     // 但如果它明顯更貼近社區自己那條路，最遠到這裡都還可以考慮

/* 社區門牌寫在哪條路，它就該在那條路旁邊 —— 這是最直白的一道裁判。
   實測靠這條分得出來：桃裏紅的 591 座標離「五青路」1209 公尺（591 對到別的同名社區），
   而青城之戀相反，地圖上的點離「青昇路一段」231 公尺、591 的只有 40 公尺（地圖錯了）。 */
const CN_ROAD = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const normRoad = (s) => String(s || '').replace(/\s/g, '')
  .replace(/(\d+)段/, (_, d) => (CN_ROAD[+d] || d) + '段').replace(/台/g, '臺');

const roadIndex = new Map();
{
  const raw = JSON.parse(await readFile(join(CACHE, 'roads.json'), 'utf8')).elements;
  for (const w of raw) {
    const n = normRoad(w.tags?.name || '');
    if (!n) continue;
    const list = roadIndex.get(n) || [];
    for (const p of (w.geometry || [])) list.push(p);
    roadIndex.set(n, list);
  }
}
/** 這個位置離「這個社區自己那條路」多遠。OSM 上找不到那條路就回 null（不加分也不扣分）。 */
function roadGap(pt, roadName) {
  const list = roadIndex.get(normRoad(roadName));
  if (!list || list.length < 3) return null;
  let m = Infinity;
  for (const q of list) m = Math.min(m, dist(pt, q));
  return m;
}

/* 這個位置離最近的「像住宅的大樓」多遠。0 = 就站在裡面。
   投票時拿來當證據：站在房子裡的位置，比兩家網站嘴巴講的還可信。 */
function nearestHome(pt) {
  let best = Infinity;
  for (const b of buildings) {
    if (!b.homey || b.area < 420) continue;
    if (dist(pt, b.c) > 260) continue;
    if (inside(pt, b.ring)) return 0;
    const d = toEdge(pt, b.ring);
    if (d < best) best = d;
  }
  return best;
}

const votes = [];        // { p, pt, srcs, why }
for (const p of pins) {
  /* 一定要從「geocode 原本算的位置」開始投票，不能從上次修正後的位置開始 ——
     否則重跑一次就再位移一次，跑三次就飄走了。第一次修正時把原始位置存進 p0。 */
  if (!p.p0) p.p0 = { lat: p.lat, lon: p.lon };
  const now = { lat: p.p0.lat, lon: p.p0.lon };
  if (manual[p.id]) { votes.push({ p, pt: { lat: p.lat, lon: p.lon }, srcs: ['manual'], why: 'manual' }); continue; }

  const myRoad = roadGap(now, p.road);

  /* 離現在的點超過 FAR 的，多半是對到別的同名社區（實測差到 2 公里）——
     除非它明顯更貼近「這個社區自己那條路」，那就是地圖本身錯了。 */
  const keep = (q) => {
    const d = dist(now, q);
    if (d <= FAR) return true;
    if (d > FAR_MAX) return false;
    const g = roadGap(q, p.road);
    return g != null && myRoad != null && g + 100 < myRoad;
  };

  const cand = [{ k: 'osm', pt: now }];
  const s5 = by591.get(p.id);
  if (s5 && keep(s5)) cand.push({ k: '591', pt: { lat: s5.lat, lon: s5.lon } });
  const sy = bySinyi.get(normName(p.name));
  if (sy && keep(sy)) cand.push({ k: 'sinyi', pt: sy });

  /* 591 自己標的門牌就等於樂居核對過的門牌 → 它的座標多算一票。
     ⚠ 只是多一票，不是說了算。第一版讓它直接蓋過其他證據，實測把本來
     好好站在建物上的點拉走了（寶徠花園 0m→106m、京懋敦和 0m→37m）——
     門牌字串對得上只證明「講的是同一個門牌」，不證明「那個座標畫在房子上」。 */
  const addrHit = !!(s5 && s5.addr && p.lejuAddr && normAddr(s5.addr) === normAddr(p.lejuAddr));

  /* 每個候選位置打分，最高分的贏。
     「這個點就站在一棟像住宅的大樓裡」是很硬的證據，要贏得過兩家網站的說法。 */
  const score = (c) => {
    const grp = cand.filter((b) => dist(c.pt, b.pt) <= AGREE);
    let s = grp.length * 2;                               // 有幾個來源說同一個地方
    if (addrHit && grp.some((x) => x.k === '591')) s += 3; // 591 的門牌跟樂居一致
    /* 離自己那條路太遠幾乎不可能對。實測青城之戀地圖上的點離青昇路一段 231 公尺，
       591 的只有 40 公尺 —— 光這一項就分得出誰對。 */
    const rg = roadGap(c.pt, p.road);
    if (rg != null) {
      if (rg <= 40) s += 3;
      else if (rg > 150) s -= 4;
    }
    const bd = nearestHome(c.pt);
    if (bd === 0) s += 4;                                 // 落在住宅大樓裡
    else if (bd <= 12) s += 2;                            // 貼著住宅大樓
    else if (bd > 60) s -= 3;                             // 方圓 60 公尺內沒有畫出來的住宅
    if (c.k === 'osm') s += 0.5;                          // 同分時不要沒事亂搬
    return { s, grp, bd };
  };
  let win = null;
  for (const c of cand) {
    const r = score(c);
    if (!win || r.s > win.r.s) win = { c, r };
  }

  /* 只有一家在講、而且不是原本那個位置 —— 這種要再多一道門檻才准搬。
     單憑一家之言把點搬幾百公尺太冒險，所以要求兩件事同時成立：
       ① 它指的位置就落在一棟住宅大樓裡（不是「附近」，是裡面）
       ② 原本那個位置方圓 60 公尺內根本沒有畫出來的住宅（代表原本就是懸空的）
     兩個條件都成立才搬，而且照樣列進待確認清單讓我自己看一眼。 */
  let lone = false;
  if (win.r.grp.length === 1 && win.c.k !== 'osm') {
    const rgWin = roadGap(win.c.pt, p.road);
    /* 放行的第二條路：它就在社區自己那條路旁邊，而現在的點離那條路遠得離譜。
       門牌寫在青昇路一段，點卻在 231 公尺外 —— 那不是誤差，是定位定錯了。 */
    const roadProves = rgWin != null && myRoad != null && rgWin <= 40 && myRoad > 150;
    if ((win.r.bd === 0 && nearestHome(now) > 60) || roadProves) lone = true;
    else win = { c: cand[0], r: score(cand[0]) };        // 退回原本的位置
  }

  const grp = win.r.grp;
  const pt = {
    lat: grp.reduce((s, x) => s + x.pt.lat, 0) / grp.length,
    lon: grp.reduce((s, x) => s + x.pt.lon, 0) / grp.length,
  };
  const why = grp.length >= 3 ? 'vote3'
    : grp.length === 2 ? 'vote2'
      : lone ? 'lone-building'
        : (addrHit && win.c.k === '591') ? 'addr591'
          : cand.length === 1 ? 'only-osm' : 'split';
  votes.push({ p, pt, srcs: grp.map((x) => x.k), why });
}

/* ---------- 第二輪：建物微調 ---------- */
/* 先幫每個社區找一棟「敢認」的建物，再處理一棟被兩個社區搶的情況 */
const SNAP_NEAR = 15;    // 沒有名字佐證時，點要貼這麼近才敢挪
const SNAP_MAX = 25;     // 微調最多挪這麼多，超過就不是微調是搬家
const NAME_R = 80;       // 建物名字就是社區名時，這個距離內都算數

const claims = new Map();  // buildingId -> [{ v, d, byName }]
for (const v of votes) {
  if (v.why === 'manual') continue;
  let named = null, near = null;
  for (const b of buildings) {
    const dc = dist(v.pt, b.c);
    if (dc > NAME_R + 260) continue;
    const d = inside(v.pt, b.ring) ? 0 : toEdge(v.pt, b.ring);
    if (b.name && normName(b.name) === normName(v.p.name) && d <= NAME_R) {
      if (!named || d < named.d) named = { b, d };
    }
    if (b.homey && b.area >= 420 && d <= SNAP_NEAR) {
      if (!near || d < near.d) near = { b, d };
    }
  }
  const pick = named || near;
  if (!pick) continue;
  const list = claims.get(pick.b.id) || [];
  list.push({ v, d: pick.d, byName: !!named, b: pick.b });
  claims.set(pick.b.id, list);
}

const snapped = [];
for (const [, list] of claims) {
  /* 一棟建物只能屬於一個社區。名字對得上的優先，其次是貼得最近的；
     其他的不動 —— 兩個社區指到同一棟就代表 OSM 這一帶畫得不夠細，猜了會害人。
     例外：同一個社區的店面分身（名字包含母社區名）可以一起認領。 */
  list.sort((a, b) => (b.byName - a.byName) || (a.d - b.d));
  const owner = list[0];
  for (const c of list) {
    const sameFamily = c === owner
      || normName(c.v.p.name).includes(normName(owner.v.p.name))
      || normName(owner.v.p.name).includes(normName(c.v.p.name));
    if (!sameFamily) continue;
    const d = Math.round(dist(c.v.pt, c.b.c));
    if (!c.byName && d > SNAP_MAX) continue;
    if (d < 3) { c.v.snapNote = '本來就在建物上'; continue; }
    c.v.pt = { lat: c.b.c.lat, lon: c.b.c.lon };
    c.v.snapped = { d, name: c.b.name, byName: c.byName, area: c.b.area };
    snapped.push(c.v);
  }
}

/* ---------- 寫回 ---------- */
const moved = [];
const review = [];
for (const v of votes) {
  if (v.why === 'manual') continue;
  const d = Math.round(dist(v.p.p0, v.pt));     // 跟原始定位比，才知道這次到底挪了多少
  if (d >= 3) moved.push({ p: v.p, d, why: v.why, srcs: v.srcs, snapped: v.snapped });
  // 不管有沒有移動都寫回：這一輪判定不該動的，要退回原始定位，不能留著上一輪的結果
  v.p.lat = +v.pt.lat.toFixed(6);
  v.p.lon = +v.pt.lon.toFixed(6);
  v.p.posSrc = v.snapped ? (v.snapped.byName ? 'building-name' : 'building') : v.why;

  /* 位置到底可不可信，用這個欄位講清楚 —— 卡片上的警語與地圖上的虛線圈都看它。
     原本的 conf 只記「當初是用什麼方法定位的」，經過投票之後那個講法會過期：
     conf 明明是 road，但 591 與信義都指同一個地方，那它其實是準的。 */
  const verified = v.why === 'vote3' || v.why === 'vote2' || v.why === 'addr591'
    || (v.snapped && v.snapped.byName);
  v.p.needCheck = !verified && !v.snapped;
  if (verified) v.p.conf = v.why === 'vote3' ? 'verified3' : 'verified';

  if ((v.why === 'split' || v.why === 'only-osm' || v.why === 'lone-building') && !v.snapped) {
    review.push({
      id: v.p.id, name: v.p.name, deals: v.p.dealsAll || 0,
      addr: v.p.lejuAddr || v.p.road || '',
      /* 沒有門牌的社區，客戶按導航時 Google 收到的是地圖上的座標。
         有門牌的那些，導航吃的是門牌，地圖點歪一點也不會害人走錯 ——
         所以「沒門牌 ＋ 位置沒把握」才是真正會出事的組合，要排最前面。 */
      navByCoord: !/號/.test(v.p.lejuAddr || ''),
      why: v.why === 'split' ? '三個來源各說各話，沒有多數'
        : v.why === 'lone-building' ? '只有一家在講，我照它搬了但沒有第二個來源背書'
        : '只有一個來源，沒得對照',
    });
  }
}

/* ---------- 報告 ---------- */
const tally = {};
for (const v of votes) tally[v.p.posSrc || v.why] = (tally[v.p.posSrc || v.why] || 0) + 1;
const label = {
  vote3: '三個來源都同意', vote2: '兩個來源同意', split: '各說各話（沒動）',
  addr591: '591 標的門牌跟樂居一致，用它的座標',
  'lone-building': '只有一家在講，但它指的位置就在一棟大樓裡（原本那個位置懸空）',
  'only-osm': '只有 OSM 一個來源（沒動）', manual: '你手動拖過的（沒碰）',
  building: '貼到建物上微調', 'building-name': '建物名字就是社區名，直接對上',
};
console.log('');
console.log('社區共 ' + pins.length + ' 個，定位依據：');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
  console.log('  ' + (label[k] || k).padEnd(24) + String(v).padStart(4));

const ds = moved.map((m) => m.d).sort((a, b) => a - b);
console.log('');
console.log('這次移動了 ' + moved.length + ' 個社區，中位數 '
  + (ds.length ? ds[Math.floor(ds.length / 2)] : 0) + ' 公尺，最多 '
  + (ds.length ? ds[ds.length - 1] : 0) + ' 公尺');

console.log('');
console.log('=== 移動最多、又有成交紀錄的 ===');
moved.filter((m) => (m.p.dealsAll || 0) > 0).sort((a, b) => b.d - a.d).slice(0, 20)
  .forEach((m) => console.log('  ' + ('移 ' + m.d + 'm').padEnd(10)
    + ((m.p.dealsAll || 0) + '筆').padEnd(8)
    + m.p.name.padEnd(20)
    // 移動可能是兩段疊起來的：先投票換位置，再貼到建物上。兩段都要講，不然數字看起來莫名其妙
    + '← ' + (label[m.why] || m.why)
    + (m.srcs.length > 1 ? '（' + m.srcs.join('+') + '）' : '')
    + (m.snapped
      ? (m.snapped.byName ? ' ＋ 建物名字就叫「' + m.snapped.name + '」'
                          : ' ＋ 再貼到建物上 ' + m.snapped.d + 'm')
      : '')));

console.log('');
console.log('=== 沒把握、要你自己看一眼的（照成交量排，前 20）===');
review.sort((a, b) => (b.navByCoord - a.navByCoord) || (b.deals - a.deals)).slice(0, 20)
  .forEach((r) => console.log('  ' + (r.navByCoord ? '⚠導航吃座標 ' : '　　　　　　 ')
    + (r.deals + '筆').padEnd(8) + r.name.padEnd(20) + r.why));
console.log('  …共 ' + review.length + ' 個');

if (DRY) { console.log('\n（--dry：沒有寫檔）'); process.exit(0); }

pinsDoc.meta = pinsDoc.meta || {};
pinsDoc.meta.refinedAt = new Date().toISOString();
pinsDoc.meta.refine = { moved: moved.length, review: review.length, bySource: tally };
await writeFile(pinsFile, JSON.stringify(pinsDoc), 'utf8');

await writeFile(join(DATA, 'pins-review.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: '這些社區的位置沒有第二個來源可以對照，只能靠人眼確認。'
    + '開地圖 → 勾「校正模式」→ 拖到對的位置 → 按「匯出校正檔」，把檔案放進 data/pins-manual.json。',
  // 會害客戶走錯的排最前面（導航吃座標的），其次照成交量
  items: review.sort((a, b) => (b.navByCoord - a.navByCoord) || (b.deals - a.deals)),
}, null, 1), 'utf8');

console.log('\n已寫回 data/pins.json，待確認清單在 data/pins-review.json');
