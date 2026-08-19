/* 找出「同一棟樓，兩個名字」的疑似組合。只分析、不合併 —— 合錯比圖上多一個點嚴重。
   用法：node build/find-duplicates.mjs（要先跑過 geocode-pins）

   為什麼會撞名：樂居用銷售名（建商打廣告的名字），管委會清冊用登記名，
   同一棟樓兩邊各一個名字，補點之後就變成圖上兩個點。
   判斷依據按可信度排：門牌 > 戶數 > 完工年 > 公設比 > 圖上距離。
   門牌最硬 —— 同一棟樓的門牌一定重疊。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (...a) => join(HERE, '..', ...a);

const pins = JSON.parse(readFileSync(P('data', 'pins.json'), 'utf8')).pins;
const comm = JSON.parse(readFileSync(P('..', 'qingpu-communities', 'data', 'communities.json'), 'utf8')).communities;
const commById = new Map(comm.map((c) => [c.id, c]));

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const normRoad = (s) => String(s || '').replace(/\s/g, '')
  .replace(/(\d+)段/, (_, d) => (CN[+d] || d) + '段').replace(/台/g, '臺');

/* 從樂居地址拆出「路名 + 門牌號」 */
function lejuAddr(raw) {
  const clean = String(raw || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '');
  const m = clean.match(/^(.+?[路街道])((?:[一二三四五六七八九十\d]+段)?)(.*)$/);
  if (!m) return { road: normRoad(clean), no: null };
  const hit = (m[3] || '').match(/(\d+)/);
  return { road: normRoad(m[1] + m[2]), no: hit ? +hit[1] : null };
}

const COS = Math.cos(25 * Math.PI / 180);
const metersApart = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 111000 * COS);

const lejuPins = pins.filter((p) => p.src === 'leju');
const govPins = pins.filter((p) => p.src !== 'leju');

const rows = [];
for (const L of lejuPins) {
  const la = lejuAddr(L.lejuAddr);
  for (const G of govPins) {
    const c = commById.get(G.id) || {};
    const dist = metersApart(L, G);

    /* 門牌：同一條路，而且樂居的號碼落在實價登錄的門牌範圍內（或差 4 號內）。
       同一棟樓的門牌一定重疊，這是最硬的證據。 */
    const sameRoad = la.road && normRoad(c.roadFull || c.road) === la.road;
    let addrHit = null;
    if (sameRoad && la.no != null && c.noMin != null) {
      const lo = c.noMin;
      const hi = c.noMax ?? c.noMin;
      if (la.no >= lo && la.no <= hi) addrHit = '門牌落在範圍內';
      else if (Math.min(Math.abs(la.no - lo), Math.abs(la.no - hi)) <= 4) addrHit = '門牌只差幾號';
    }

    // 屋齡：樂居寫年數，實價寫民國完工年 → 都換算成西元完工年再比
    const lejuAgeNum = /^\d+$/.test(String(L.lejuAge || '').trim()) ? +L.lejuAge : null;
    const lejuDoneY = lejuAgeNum != null ? 2026 - lejuAgeNum : null;
    const govDoneY = c.doneRoc ? c.doneRoc + 1911 : null;
    const ageHit = lejuDoneY != null && govDoneY != null && Math.abs(lejuDoneY - govDoneY) <= 1;

    const hhHit = L.households && c.households && L.households === c.households;

    let score = 0;
    const why = [];
    if (addrHit) { score += addrHit === '門牌落在範圍內' ? 5 : 3; why.push(addrHit); }
    else if (sameRoad) { score += 1; why.push('同一條路'); }
    if (hhHit) { score += 3; why.push(`戶數都是 ${L.households}`); }
    if (ageHit) { score += 2; why.push(`完工年都是 ${govDoneY}`); }
    if (dist < 15) { score += 2; why.push(`圖上相距 ${dist.toFixed(0)} 公尺`); }
    else if (dist < 40) { score += 1; why.push(`圖上相距 ${dist.toFixed(0)} 公尺`); }

    // 反證：門牌同路但號碼差很遠、或完工年差 3 年以上 → 幾乎確定不同棟
    const against = [];
    if (sameRoad && la.no != null && c.noMin != null && !addrHit) {
      against.push(`門牌差很多（樂居 ${la.no} 號 vs 實價 ${c.addrRange}）`);
    }
    if (lejuDoneY != null && govDoneY != null && Math.abs(lejuDoneY - govDoneY) >= 3) {
      against.push(`完工年差 ${Math.abs(lejuDoneY - govDoneY)} 年（樂居 ${lejuDoneY} vs 實價 ${govDoneY}）`);
    }
    if (L.households && c.households && Math.abs(L.households - c.households) > 20) {
      against.push(`戶數差很多（${L.households} vs ${c.households}）`);
    }
    if (L.presale && c.dealsAll > 0) against.push('樂居說還沒交屋，但實價登錄已有成交');

    if (score >= 5) rows.push({ L, G, c, dist, score, why, against, la });
  }
}

rows.sort((a, b) => b.score - a.score);
console.log(`疑似「同一棟樓兩個名字」共 ${rows.length} 組（分數越高越可能是同一棟）\n`);
for (const r of rows) {
  const verdict = r.against.length ? '❌ 不同社區' : (r.score >= 8 ? '🔴 很可能同一棟' : '🟡 有可能，要你確認');
  console.log(`${verdict}  ［${r.score} 分］ ${r.L.name}（樂居） ↔ ${r.G.name}（實價登錄）`);
  console.log(`   樂居：${r.L.lejuAddr || '—'}　${r.L.households || '?'} 戶　公設 ${r.L.publicRatio || '?'}%　屋齡 ${r.L.lejuAge || '?'}`);
  console.log(`   實價：${r.c.roadFull || r.c.road} ${r.c.addrRange || '—'}　${r.c.households || '?'} 戶　民國 ${r.c.doneRoc || '?'} 年完工　${r.c.totalFloor || '?'} 層　累計 ${r.c.dealsAll || 0} 筆成交`);
  console.log(`   相符：${r.why.join('、')}`);
  if (r.against.length) console.log(`   矛盾：${r.against.join('；')}`);
  console.log('');
}
