// 從信義房屋的社區頁補齊「樂居沒有的欄位」。
// 用法： node build/fetch-sinyi.mjs [--force]
//
// 為什麼是信義：樂居那份人工快照只有 6 欄（區／名稱／地址／戶數／公設比／屋齡），
// 客戶當面會問的「有沒有健身房」「誰蓋的」「垃圾怎麼倒」「有沒有警衛」全都沒有。
// 信義的社區頁一頁就有 15 欄，而且 —— 這點跟樂居完全相反 ——
// 它的 robots.txt 寫 Allow: /，還自己公告了 community.xml 這份社區清單，
// 等於網站明講可以抓。實測純 HTML 就有資料，不必跑 JS。
//
// 對照表 data/sinyi-ids.tsv 是人工累積的（社區名 → 信義的社區編號），
// 跟 leju-crosscheck.tsv 同一個模式：查到一個就補一列，重跑就上圖。
// 沒有自動搜尋是因為信義的社區搜尋要真人互動才會動，猜網址是禁止的。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMM = join(HERE, '..', '..', 'qingpu-communities', 'data');
const IDS = join(COMM, 'sinyi-ids.tsv');
const OUT = join(COMM, 'sinyi-extra.json');

const FORCE = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 一筆抓完等 1.5 秒。人家沒擋我們，是我們自己要有分寸 ——
   20 筆多花 30 秒沒差，被當成攻擊擋掉整個 IP 才麻煩。 */
const POLITE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 頁面結構是「標題 div 緊接內容 div」，成對出現。
   class 名字尾巴那串 hash 會隨改版變，所以只認前綴。 */
const FIELD_RE = /basic-info-area-title__[^>]*>([^<]+)<\/div><div class="community_basic-info-area-content__[^>]*>([^<]*)</g;

/* 只留帶看真的用得到的。主要特色那欄是行銷文案（還帶著資料更新日），不收。 */
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
  // 社區名拿來驗證抓對了沒 —— 編號貼錯的話這裡就對不起來
  const t = html.match(/<title>([^<|]+)/);
  if (t) out.名稱 = t[1].replace(/實價登錄.*$/, '').trim();
  return out;
}

async function main() {
  if (!existsSync(IDS)) {
    console.error(`找不到對照表：${IDS}`);
    console.error('格式是三欄（用 tab 分隔）：社區名　信義編號　備註');
    process.exit(1);
  }

  const rows = (await readFile(IDS, 'utf8')).trim().split('\n').slice(1)
    .map((l) => l.split('\t').map((x) => (x || '').trim()))
    .filter((r) => r[0] && /^\d{7}$/.test(r[1] || ''));

  const old = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { byName: {} };
  const byName = old.byName || {};

  console.log(`對照表 ${rows.length} 筆`);
  let got = 0;
  let skip = 0;
  let fail = 0;

  for (const [name, id] of rows) {
    // 一個月內抓過就不重抓 —— 公設與建商幾乎不會變
    const prev = byName[name];
    /* 對照表裡的編號改過就一定要重抓 —— 只看「30 天內抓過」的話，
       改編號等於沒改（實際踩過：宜誠青埔市原本填成二期的編號，
       改成一期之後跑一次，快取照樣沿用二期的資料）。 */
    const sameId = prev?.id === id;
    const fresh = sameId && prev?.at && (Date.now() - Date.parse(prev.at)) < 30 * 24 * 60 * 60 * 1000;
    if (fresh && !FORCE) { skip++; continue; }

    const url = `https://www.sinyi.com.tw/communitylist/communityinfo/${id}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = parse(await r.text());
      if (!Object.keys(data).length) throw new Error('頁面沒有可解析的欄位');
      byName[name] = { ...data, id, at: new Date().toISOString() };
      got++;
      const fac = data['公共設施'] ? data['公共設施'].split(/[,、]/).length + ' 項公設' : '沒有公設欄';
      console.log(`  ✓ ${name.padEnd(14)} ${fac}　${data['建設公司'] || ''}`);
      // 抓到的名字跟對照表對不起來就提醒：多半是編號貼錯了
      if (data.名稱 && !data.名稱.includes(name) && !name.includes(data.名稱)) {
        console.log(`     ⚠ 信義那邊寫的是「${data.名稱}」，跟「${name}」對不起來，確認一下編號`);
      }
    } catch (err) {
      fail++;
      console.log(`  ✗ ${name.padEnd(14)} ${err.message}`);
    }
    await sleep(POLITE_MS);
  }

  await writeFile(OUT, JSON.stringify({
    source: '信義房屋社區資訊頁（robots.txt 允許）',
    updatedAt: new Date().toISOString(),
    byName,
  }, null, 1), 'utf8');

  console.log(`\n抓到 ${got} 筆、沿用 ${skip} 筆、失敗 ${fail} 筆 → ${OUT}`);
  console.log('接著跑 build/geocode-pins.mjs 就會上圖。');
}

main().catch((e) => { console.error('失敗：', e.stack); process.exit(1); });
