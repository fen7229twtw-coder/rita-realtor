// 把 sweep-sinyi.mjs 掃回來的中壢＋大園社區，對到地圖上的社區名，
// 併進 sinyi-extra.json（geocode-pins.mjs 讀的就是這一份）。
// 用法： node build/merge-sweep.mjs [--dry]
//
// 為什麼要在這裡對名字，不在畫卡片的時候對：
// 掃回來的是「整個中壢區＋大園區」幾千個社區，地圖上只有 250 個青埔的。
// 名字模糊比對放到出圖那一刻做，會讓「青田」這種短名字亂配到別的社區 ——
// 客戶看到的就是錯的公設。所以比對集中在這裡，配對結果印出來給人看過。
//
// 對法（嚴到寬，第一個中的就算）：
//   ① 名字正規化後完全相同
//   ② 信義的名字用「/」隔開多個別名，其中一個完全相同
//   ③ 一邊完整包含另一邊，而且地圖上那個名字至少 3 個字
//      （例：地圖「有境」← 信義「宜誠有境」）
//   ④ ③ 有多個候選時，用門牌路名決勝；決不出來就整組放棄，不猜。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMM = join(HERE, '..', '..', 'qingpu-communities', 'data');
const SWEEP = join(COMM, 'sinyi-sweep.json');
const EXTRA = join(COMM, 'sinyi-extra.json');
const PINS = join(HERE, '..', 'data', 'pins.json');

const DRY = process.argv.includes('--dry');

/* 信義寫「新潤明日苑NO.8-國峰苑」，地圖上是「新潤明日苑8國峰苑」——
   同一個社區，差在一個 NO. 跟一個破折號。把 NO. 這種序號前綴拿掉，
   數字本身要留（留著才分得出 8 國峰苑跟 2 國璽苑是兩個社區）。 */
const norm = (s) => String(s || '').replace(/[Nn][Oo]\.?|第/g, '').replace(/[\s\-－—・·．.()（）]/g, '').replace(/[0-9]+$/, '');
/* 信義的社區名常常是「A/B/C」，那是同一棟樓的別名，逐個拿來比 */
const aliases = (s) => String(s || '').split(/[/／]/).map(norm).filter((x) => x.length >= 2);
/* 名字結尾的那個數字是「第幾期／第幾棟」，是分辨社區的關鍵，不能被吃掉。
   「康橋新幹線6」跟「康橋新幹線No.2」去掉尾碼後長得一模一樣，
   但它們是兩個社區 —— 公設配錯，帶看現場就會出糗。 */
const tailNo = (s) => (String(s || '').replace(/[Nn][Oo].?|第/g, '').replace(/[s-－—・·．.()（）]/g, '').match(/[0-9]+$/) || [''])[0];
/* 「819戶」→ 819 */
const hh = (v) => { const m = String(v || '').match(/d+/); return m ? +m[0] : null; };
/* 門牌只留路名那段，用來決勝 */
const roadOf = (s) => (String(s || '').match(/(?:中壢區|大園區)([^0-9]{2,12}?(?:路|街|大道))/) || [])[1] || '';

async function main() {
  const sweep = JSON.parse(await readFile(SWEEP, 'utf8'));
  const hits = Object.entries(sweep.hits || {});
  const pinsFile = JSON.parse(await readFile(PINS, 'utf8'));
  const pins = pinsFile.pins || pinsFile;
  const extra = JSON.parse(await readFile(EXTRA, 'utf8'));

  console.log(`掃回來 ${hits.length} 個社區，地圖上 ${pins.length} 個`);

  /* 先建索引：正規化名 → 掃到的那幾筆 */
  const byAlias = new Map();
  for (const [id, rec] of hits) {
    for (const a of aliases(rec.名稱)) {
      if (!byAlias.has(a)) byAlias.set(a, []);
      byAlias.get(a).push({ id, rec });
    }
  }

  const matched = [];
  const ambiguous = [];
  const householdGap = [];
  for (const p of pins) {
    const already = extra.byName[p.name];
    if (already && already.公共設施) continue;          // 已經有公設就不動它
    const n = norm(p.name);
    if (n.length < 2) continue;

    const pTail = tailNo(p.name);
    let cands = (byAlias.get(n) || []).filter((c) => aliases(c.rec.名稱).some((a, i) =>
      a === n && tailNo(String(c.rec.名稱).split(/[/／]/)[i]) === pTail));
    let how = '同名';
    if (!cands.length && n.length >= 3) {
      how = '包含';
      const seen = new Set();
      cands = [];
      for (const [a, list] of byAlias) {
        if (a.length < 2) continue;
        if (!(a.includes(n) || n.includes(a))) continue;
        for (const c of list) {
          if (seen.has(c.id)) continue;
          /* 尾碼不同就是不同社區（一期／二期、No.1／No.2、V1／V2） */
          const cTail = aliases(c.rec.名稱).includes(a)
            ? tailNo(String(c.rec.名稱).split(/[/／]/)[aliases(c.rec.名稱).indexOf(a)])
            : tailNo(c.rec.名稱);
          if (cTail !== pTail) continue;
          seen.add(c.id); cands.push(c);
        }
      }
    }
    if (!cands.length) continue;

    if (cands.length > 1) {
      /* 用路名決勝 */
      const pr = roadOf('中壢區' + (p.lejuAddr || '')) || (p.road || '').replace(/\d+段?$/, '');
      const same = cands.filter((c) => pr && roadOf(c.rec.地址) && roadOf(c.rec.地址).includes(pr.replace(/\d+段?$/, '')));
      if (same.length === 1) { cands = same; how += '＋路名'; }
      else { ambiguous.push([p.name, cands.map((c) => `${c.rec.名稱}(${c.id})`).join('／')]); continue; }
    }

    const { id, rec } = cands[0];
    /* 最後一道：兩邊都有戶數的話要對得上。差超過兩成就是配到別棟，寧可不收。
       （店面那種一群幾戶的除外 —— 母棟幾百戶、店面十幾戶是正常的） */
    const a1 = hh(p.households);
    const b1 = hh(rec.戶數);
    if (a1 && b1 && !/店面|管理|委員/.test(p.name)) {
      const big = Math.max(a1, b1);
      const small = Math.min(a1, b1);
      if (small / big < 0.8) {
        householdGap.push([p.name, `${a1} 戶`, `${rec.名稱} ${b1} 戶`, id]);
        continue;
      }
    }
    matched.push([p.name, rec.名稱, id, how, rec.公共設施 ? '有公設' : '無公設']);
    extra.byName[p.name] = { ...rec, id, at: new Date().toISOString(), via: 'sweep' };
  }

  console.log(`\n配對成功 ${matched.length} 筆：`);
  for (const m of matched) console.log('  ' + m.join('\t'));
  if (householdGap.length) {
    console.log(`
戶數對不上、故意放掉的 ${householdGap.length} 筆：`);
    for (const g of householdGap) console.log('  ' + g.join('	'));
  }
  if (ambiguous.length) {
    console.log(`\n對不起來、故意放掉的 ${ambiguous.length} 筆（多個候選，不猜）：`);
    for (const a of ambiguous) console.log('  ' + a.join('\t'));
  }

  const withF = matched.filter((m) => m[4] === '有公設').length;
  console.log(`\n新增有公設的社區 ${withF} 個`);

  if (DRY) { console.log('（--dry，沒有寫檔）'); return; }
  extra.updatedAt = new Date().toISOString();
  await writeFile(EXTRA, JSON.stringify(extra, null, 1), 'utf8');
  console.log('已寫回 sinyi-extra.json，接著跑 node build/geocode-pins.mjs');
}

main();
