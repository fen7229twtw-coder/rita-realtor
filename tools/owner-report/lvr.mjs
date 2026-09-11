/* ===================================================================
   lvr.mjs — 同社區「實際成交」（實價登錄）

   為什麼要這一塊：
   回報單原本整張表都是 591 的「在售開價」—— 那是賣方喊的價。
   屋主心裡真正的錨點是實價登錄的成交價。而且成交價是政府登錄的，
   不是我們說的，所以講起來立場最乾淨（見 feedback_不要壓屋主的價）。

   資料源直接讀 tools/qingpu-communities/data/，不另存一份：
     communities.json  143 個青埔社區（人工核對過門牌區間、車位中位價）
     deals.json        按社區 id 收好的逐筆成交，只有 1 MB
   估價系統那份是分行政區的整包（中壢區 24 MB），這裡用不到那麼多。

   ⚠ 這支踩過的四個坑，改的時候不要拆掉：

   ① 坪數異常大的那幾筆要踢掉。
      竹風青庭 41 筆住家成交裡有 8 筆寫 75~80 坪、3 房，而這棟的 3 房
      實際是 40~56 坪 —— 那是車位坪被算進坪數了（實登的移轉總面積不是
      權狀坪，見 learning_使照算同層戶數）。這 8 筆會把每坪中位從
      40.6 萬拉低到 35.1 萬。用「跟屋主這一戶的坪數帶」篩掉。

   ② 近半年很可能 0 筆。
      青埔 91 個社區近一年 0 筆成交（learning_青埔行情樣本）。
      竹風青庭近半年就是 0 筆、近一年 2 筆。所以窗口要逐級放寬，
      而且一定要標明用的是哪一個窗口 —— 不能寫「近半年」卻拿兩年前的。

   ③ 車位未拆分的每筆都要還原，不可以丟掉也不可以留空白。
      Rita 拍板（feedback_實價登錄要扣車位）。竹風青庭 41 筆裡有 23 筆
      是「含車位未拆分」，丟掉就只剩 18 筆而且全是偏低的那些。
      還原值要標成「≈」跟實際值長得不一樣。

   ④ 樣本少於 3 筆不給中位數。
      2 筆的中位數不是行情。只列逐筆，並且說清楚樣本不足。
=================================================================== */

const M_TO_PING = 3.305785;

/* 坪數帶：跟屋主這一戶差幾成以內才算可比。
   ±25% 在竹風青庭實測剛好踢掉那 8 筆 75~80 坪的，留下 31 筆。 */
const BAND = 0.25;

/* 窗口逐級放寬（月）。停在第一個湊滿 MIN_MEDIAN 筆的。 */
const WINDOWS = [12, 24, 36];

/* 少於這個筆數不給中位數 */
const MIN_MEDIAN = 3;

/* 逐筆明細最多印幾筆 */
const MAX_ROWS = 8;

/* ---------- 小工具 ---------- */

const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** YYYYMM 往前推 n 個月 */
export function ymMinus(ym, n) {
  const y = Math.floor(ym / 100), m = ym % 100;
  const t = y * 12 + (m - 1) - n;
  return Math.floor(t / 12) * 100 + (t % 12) + 1;
}

export const nowYm = (d = new Date()) => d.getFullYear() * 100 + (d.getMonth() + 1);

export const ymText = (ym) => (ym ? Math.floor(ym / 100) + '/' + String(ym % 100).padStart(2, '0') : '—');

/* ---------- 讀資料 ---------- */

let cache = null;

/**
 * 讀社區庫與成交明細。整包只有 1.2 MB，讀一次記在記憶體裡。
 * 讀不到就回 null —— 呼叫端要當「這一塊不顯示」，不是當錯誤。
 */
export async function loadLvr(base = '../qingpu-communities/data/') {
  if (cache) return cache;
  try {
    const [c, d, p] = await Promise.all([
      fetch(base + 'communities.json').then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch(base + 'deals.json').then((r) => (r.ok ? r.json() : Promise.reject())),
      /* 車位規格。⚠ 這一份可以載不到（沒跑過 build-parking.mjs），
         載不到就退回舊的算法，不要整塊壞掉。 */
      fetch('./data/parking.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    cache = {
      communities: c.communities || [],
      byId: d.byId || {},
      park: p?.byId || {},
      parkAt: (p?.meta?.generatedAt || '').slice(0, 10),
      latestDealYM: c.meta?.latestDealYM || null,
      generatedAt: c.meta?.generatedAt || null,
    };
    return cache;
  } catch {
    return null;
  }
}

/**
 * 這個社區的車位規格（一顆幾坪、什麼型式、一顆多少錢）。
 * ⚠ 回傳的 wan 是**一顆**的價格，不是整筆車位總價 —— 見檔頭 ②。
 */
export function parkingSpec(park, id) {
  const p = park && park[id];
  if (!p || !(p.ping > 0)) return null;
  return { ping: p.ping, kind: p.kind, wan: p.wan, wanN: p.wanN, wanWin: p.wanWin,
           n: p.n, share: p.pingShare };
}

/* ---------- 配社區 ---------- */

/* 名字正規化：括號、空白、全形都拿掉。
   ⚠ 只做正規化，不做同義詞替換 —— 名字像不代表是同一棟
   （learning_跨來源對名字，四個猜三個錯）。 */
const normName = (s) =>
  String(s || '').replace(/[\s（）()「」【】·・．.]/g, '').trim();

/**
 * 用委託案的社區名去配實價登錄的社區。
 * 三道，配不到就回 null（回 null 是正常結果，報告那一塊整個不顯示）。
 */
export function matchCommunity(list, name, addr) {
  const n = normName(name);
  if (!n || n.length < 2) return null;

  /* ① 完全一樣 */
  let hit = list.filter((c) => normName(c.name) === n);
  if (hit.length === 1) return hit[0];

  /* ② 一方包含另一方，且長度差不多（差太多是「青埔」對「青埔一號」那種誤配）。
        多個命中就用路段再篩。 */
  if (!hit.length) {
    hit = list.filter((c) => {
      const cn = normName(c.name);
      if (!cn || cn.length < 2) return false;
      const inc = cn.includes(n) || n.includes(cn);
      return inc && Math.abs(cn.length - n.length) <= 2;
    });
  }

  /* ③ 還是多個 → 拿路段對。對不出來就放棄，不要猜。 */
  if (hit.length > 1 && addr) {
    const a = normName(addr);
    const byRoad = hit.filter((c) => a.includes(normName(c.road)) || normName(c.roadFull) && a.includes(normName(c.roadFull)));
    if (byRoad.length === 1) return byRoad[0];
  }
  return hit.length === 1 ? hit[0] : null;
}

/* ---------- 算同社區成交 ---------- */

/**
 * 這個社區「一顆」車位的行情（萬）。
 *
 * ⚠⚠ 不可以直接用 communities.json 的 parkMedian —— 那是**整筆車位總價**，
 *   沒有除以車位數。竹風青庭寫 240 萬，但那是兩顆的價，一顆其實 150~180。
 *   拿 240 去扣單一車位，每坪會少算 2 萬左右。
 *   正解在 data/parking.json（build-parking.mjs 算的，已經除過車位數）。
 *
 * 載不到 parking.json 時才退回舊路：拿這個社區有拆分車位價的成交取中位。
 * ⚠ 那條退路一樣有「沒除以車位數」的問題，所以會回報 rough:true，
 *   讓畫面上講清楚這是粗估。
 */
function parkWanOf(c, deals, spec) {
  if (spec && spec.wan > 0) return { wan: spec.wan, rough: false };
  const pks = (deals || []).filter((d) => d.pk > 0).map((d) => d.pk);
  if (pks.length >= 3) return { wan: med(pks), rough: true };
  if (c && c.parkMedian > 0) return { wan: c.parkMedian, rough: true };
  return { wan: null, rough: true };
}

/**
 * 這一筆成交有幾個車位。
 * deals.json 沒有記，所以用「年月|總價萬|扣車位坪」去 parking.json 的逐筆表查
 * 車位總坪數，再除以一顆的坪數。
 * ⚠ 對不上就回 null —— **不要預設 1 個**。竹風青庭近兩年那幾筆有一半是 2 個，
 *   統一當成 1 個會把單價灌高 1~2 萬/坪。
 */
function pkCountOf(parkRow, spec, d) {
  if (!parkRow || !spec || !(spec.ping > 0)) return null;
  const pp = parkRow.deals?.[`${d.ym}|${d.tot}|${d.pg}`];
  if (pp == null) return null;
  if (pp === 0) return 0;
  return Math.max(1, Math.round(pp / spec.ping));
}

/**
 * @param {object} c        communities.json 的一筆
 * @param {object[]} deals  deals.json 裡這個社區的成交
 * @param {object} subj     { ping, pingExPk }
 *                          ping     = 權狀坪（含車位）
 *                          pingExPk = 扣車位坪，不知道就給 null
 * @returns {object|null}
 */
export function communityDeals(c, deals, subj = {}, park = null) {
  const all = (deals || []).filter((d) => d.k === '住家' && d.pg > 0 && d.tot > 0 && d.ym);
  if (!all.length) {
    return { n: 0, rows: [], empty: 'noDeal', name: c?.name || '', parkWan: null };
  }

  const parkRow = park && c ? park[c.id] : null;
  const spec = parkRow && parkRow.ping > 0 ? parkRow : null;
  const { wan: parkWan, rough: parkRough } = parkWanOf(c, all, spec);

  /* 每一筆都算出「扣車位」的每坪單價。
     up 有值 = 實登本來就拆好的；沒有 = 含車位未拆分，要用車位行情還原。
     ⚠ 還原要扣「這一筆自己的車位數 × 一顆的價」，不是所有筆都扣同一個數字。
       竹風青庭近兩年 7 筆裡，2 顆車位的有 2 筆、1 顆的有 3 筆、沒車位的 2 筆。 */
  let pkKnown = 0, pkGuessed = 0;
  const withUp = all.map((d) => {
    if (d.up > 0) return { ...d, upWan: Math.round((d.up / 10000) * 10) / 10, est: false, pkN: null };
    if (parkWan == null) return { ...d, upWan: null, est: true, pkN: null };

    let n = pkCountOf(parkRow, spec, d);
    let guessed = false;
    if (n == null) {
      /* 逐筆表對不上（實測約兩成）。這一筆的備註寫著「含車位未拆分」，
         所以至少有 1 個 —— 用 1 個當下限，並標記成「推估」。 */
      n = 1; guessed = true;
    }
    if (n === 0) {
      /* 車位坪是 0：那是「備註有車位但面積沒登記」，扣不了 —— 當成沒車位，
         單價照原樣算。⚠ 不要硬扣一顆，會把單價灌高。 */
      return { ...d, upWan: Math.round((d.tot / d.pg) * 10) / 10, est: true, pkN: 0 };
    }
    const cut = parkWan * n;
    if (d.tot <= cut) return { ...d, upWan: null, est: true, pkN: n };
    guessed ? pkGuessed++ : pkKnown++;
    return { ...d, upWan: Math.round(((d.tot - cut) / d.pg) * 10) / 10, est: true, pkN: n, pkGuess: guessed };
  });

  /* 坪數帶的中心：有扣車位坪就用它（實登的 pg 就是扣車位坪，口徑才對得上），
     沒有就退而用權狀坪，並回報 basis 讓畫面提醒她去補車位欄位。 */
  const centre = subj.pingExPk > 0 ? subj.pingExPk : (subj.ping > 0 ? subj.ping : null);
  const basis = subj.pingExPk > 0 ? 'exPk' : (subj.ping > 0 ? 'gross' : 'none');
  const inBand = centre
    ? (d) => Math.abs(d.pg - centre) / centre <= BAND
    : () => true;

  const now = nowYm();
  const pick = (months, banded) => {
    const from = ymMinus(now, months);
    return withUp.filter((d) => d.ym >= from && (!banded || inBand(d)));
  };

  let rows = [], months = WINDOWS[WINDOWS.length - 1], bandDropped = false;

  /* ① 帶著坪數帶，窗口逐級放寬 */
  let done = false;
  for (const m of WINDOWS) {
    const s = pick(m, true);
    if (s.length >= MIN_MEDIAN) { rows = s; months = m; done = true; break; }
  }
  /* ② 湊不滿就把坪數帶放掉再試一輪（並且要說出來） */
  if (!done && centre) {
    for (const m of WINDOWS) {
      const s = pick(m, false);
      if (s.length >= MIN_MEDIAN) { rows = s; months = m; bandDropped = true; done = true; break; }
    }
  }
  /* ③ 還是湊不滿：用最寬的窗口，有幾筆算幾筆（可能是 0 筆） */
  if (!done) {
    const wide = WINDOWS[WINDOWS.length - 1];
    const banded = pick(wide, true);
    const loose = pick(wide, false);
    if (banded.length) { rows = banded; months = wide; }
    else { rows = loose; months = wide; bandDropped = !!centre && loose.length > 0; }
  }

  rows = rows.sort((a, b) => b.ym - a.ym);

  const ups = rows.filter((d) => d.upWan != null).map((d) => d.upWan);
  const tots = rows.map((d) => d.tot);
  const enough = ups.length >= MIN_MEDIAN;

  return {
    name: c?.name || '',
    n: rows.length,
    months,
    bandDropped,
    basis,
    centre,
    parkWan,
    parkRough,
    /* 車位規格。畫面上要講「一顆 10.39 坪、坡道平面、行情 150 萬」。 */
    spec: spec ? { ping: spec.ping, kind: spec.kind, wan: spec.wan,
                   wanN: spec.wanN, wanWin: spec.wanWin, n: spec.n, share: spec.pingShare } : null,
    /* 有幾筆的車位數是查到的、有幾筆是推估 1 個 */
    pkKnown, pkGuessed,
    restored: rows.filter((d) => d.est && d.upWan != null).length,
    noUnit: rows.filter((d) => d.upWan == null).length,
    /* ⚠ 樣本少於 3 筆不給中位數 —— 2 筆的中位數不是行情 */
    upMedian: enough ? Math.round(med(ups) * 10) / 10 : null,
    upLo: ups.length ? Math.min(...ups) : null,
    upHi: ups.length ? Math.max(...ups) : null,
    totLo: tots.length ? Math.min(...tots) : null,
    totHi: tots.length ? Math.max(...tots) : null,
    lastYM: rows.length ? rows[0].ym : null,
    /* 全社區（不分窗口、不分坪數帶）的樣本量，用來講「這個社區成交多不多」 */
    allN: all.length,
    rows: rows.slice(0, MAX_ROWS).map((d) => ({
      ym: d.ym, fl: d.fl, pg: d.pg, tot: d.tot, up: d.upWan, est: d.est, r: d.r,
      pkN: d.pkN, pkGuess: !!d.pkGuess,
    })),
  };
}

/* ═══ 區域定位（地圖底下那一行）═══════════════════════════
   地圖標了高鐵、IKEA、華泰 —— 屋主住那裡，他知道。
   真正有價值的是「我這個社區在青埔是什麼水位」。

   ⚠⚠ 這裡用的算法**刻意跟 communityDeals() 不一樣**，而且不印本社區的中位數。
     communityDeals 用的是「跟屋主這一戶坪數 ±25%」，那是為了比得準；
     排名要跟其他 142 個社區比，就得每個社區用同一套規則。
     兩套算法會算出兩個不同的「本社區每坪中位」（竹風青庭 46.4 vs 50.3），
     **兩個數字同時印在一頁上，屋主一定看不懂**。所以這裡只給位置，不給數字。

   坪數守門：每個社區用自己的 pgP25/pgP75，砍掉 pgP75×1.25 以上與 pgP25×0.6 以下。
   這是為了踢掉「車位坪算進坪數」那種 75~80 坪的離群（見檔頭 ①），
   但不能用屋主那一戶的坪數當基準 —— 那樣每個社區的門檻會不一樣。
═════════════════════════════════════════════════════════ */

const AREA_WINDOW = 12;   /* 青埔整體用近一年 —— 全區筆數夠 */
const RANK_WINDOW = 24;   /* 單一社區要湊得滿，用近兩年 */
const RANK_MIN_N = 3;     /* 少於 3 筆的社區不進排名（也不列入分母）*/

/** 一個社區在某個窗口裡、套過坪數守門的每坪單價（萬）
    ⚠ 還原的算法要跟 communityDeals() 一致 —— 一顆車位的價 × 這一筆的車位數。
      兩邊用不同算法，排名就不能拿來跟明細對照。 */
function upsOf(c, deals, months, park) {
  const from = ymMinus(nowYm(), months);
  const all = (deals || []).filter((d) => d.k === '住家' && d.pg > 0 && d.tot > 0 && d.ym >= from);
  const parkRow = park && c ? park[c.id] : null;
  const spec = parkRow && parkRow.ping > 0 ? parkRow : null;
  const { wan: pk } = parkWanOf(c, deals, spec);
  const hi = c?.pgP75 > 0 ? c.pgP75 * 1.25 : Infinity;
  const lo = c?.pgP25 > 0 ? c.pgP25 * 0.6 : 0;
  return all
    .filter((d) => d.pg <= hi && d.pg >= lo)
    .map((d) => {
      if (d.up > 0) return d.up / 10000;
      if (pk == null) return null;
      const n = pkCountOf(parkRow, spec, d) ?? 1;
      if (n === 0) return d.tot / d.pg;
      const cut = pk * n;
      return d.tot > cut ? (d.tot - cut) / d.pg : null;
    })
    .filter((x) => x != null);
}

/**
 * @param {object[]} list   communities.json 的 communities
 * @param {object} byId     deals.json 的 byId
 * @param {object} subject  這個委託案配到的社區
 * @returns {object|null}
 */
export function areaContext(list, byId, subject, park) {
  if (!subject) return null;

  /* 青埔整體：近一年所有社區的成交攤平取中位 */
  let pool = [], commN = 0;
  for (const c of list || []) {
    const u = upsOf(c, byId[c.id], AREA_WINDOW, park);
    if (u.length) { pool = pool.concat(u); commN++; }
  }
  if (!pool.length) return null;

  /* 排名：每個社區近兩年、湊滿 3 筆才進榜 */
  const ranked = [];
  for (const c of list || []) {
    const u = upsOf(c, byId[c.id], RANK_WINDOW, park);
    if (u.length >= RANK_MIN_N) ranked.push({ id: c.id, m: med(u) });
  }
  ranked.sort((a, b) => b.m - a.m);
  const i = ranked.findIndex((x) => x.id === subject.id);

  /* 白話的位置。⚠ 只分五段，不要給「第 29.3 百分位」那種數字。 */
  const bandOf = (pct) =>
    pct <= 0.2 ? '前段' : pct <= 0.4 ? '中段偏上' : pct <= 0.6 ? '中段'
      : pct <= 0.8 ? '中段偏下' : '後段';

  return {
    areaMedian: Math.round(med(pool) * 10) / 10,
    areaN: pool.length,
    areaComm: commN,
    areaMonths: AREA_WINDOW,
    rankMonths: RANK_WINDOW,
    /* 排不進榜（成交少於 3 筆）也是一種結果，要說得出來 */
    rank: i >= 0 ? i + 1 : null,
    total: ranked.length,
    band: i >= 0 ? bandOf((i + 1) / ranked.length) : null,
  };
}

/** 窗口的中文說法。⚠ 一定要跟實際用的窗口一致，不可以寫死「近半年」。 */
export function windowText(months) {
  if (months <= 6) return '近半年';
  if (months <= 12) return '近一年';
  if (months <= 24) return '近兩年';
  return '近三年';
}

export { M_TO_PING, BAND, WINDOWS, MIN_MEDIAN };
