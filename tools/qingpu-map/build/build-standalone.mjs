// 產生離線單檔版：把底圖與社區資料直接內嵌進 HTML。
// 用法： node build/build-standalone.mjs
//
// 產出 青埔地圖_離線版.html —— 點兩下就能開，不必啟動任何伺服器，
// 也可以直接用 LINE／email 傳給別人。
// （file:// 協定不能 fetch 本機 JSON，所以一定要內嵌，不能只複製 index.html）

import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');

const readJSONOr = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

async function main() {
  /* 換行一律先正規化成 LF。
     踩過的坑：git 的 autocrlf 會在 checkout 時把整個檔改成 CRLF，
     下面那幾個寫死換行的錨點就通通對不到，而錯誤訊息是「index.html 結構變了」，
     會讓人以為是自己剛剛改壞的。輸出的是離線單檔，換行本來就無所謂。 */
  const html = (await readFile(join(ROOT, 'index.html'), 'utf8')).replace(/\r\n/g, '\n');
  const basemap = await readJSONOr(join(DATA, 'basemap.json'), null);
  if (!basemap) throw new Error('找不到 data/basemap.json，先跑「更新青埔地圖.cmd」');
  const pins = await readJSONOr(join(DATA, 'pins.json'), null);
  const manual = await readJSONOr(join(DATA, 'pins-manual.json'), null);
  // 路網也要內嵌，離線版才畫得出帶看路線與時間
  const graph = await readJSONOr(join(DATA, 'roadgraph.json'), null);

  // </script> 出現在 JSON 字串裡會提早關掉標籤，一定要轉義
  const safe = (obj) => JSON.stringify(obj).replace(/<\//g, '<\\/');

  const inject =
    '<script>\n'
    + '/* 離線單檔版：資料已內嵌，不需要伺服器。'
    + ' 要改資料請重跑「更新青埔地圖.cmd」再跑 build-standalone.mjs。 */\n'
    + `window.__BASEMAP__ = ${safe(basemap)};\n`
    + (pins ? `window.__PINS__ = ${safe(pins)};\n` : '')
    + (manual ? `window.__MANUAL__ = ${safe(manual)};\n` : '')
    + (graph ? `window.__ROADGRAPH__ = ${safe(graph)};\n` : '')
    + '</script>\n';

  const marker = '<script type="module">';
  if (!html.includes(marker)) throw new Error('index.html 結構變了，找不到主程式標籤');

  /* 關鍵：<script type="module"> 在 file:// 下會被 CORS 擋掉，整頁不會執行。
     離線版必須改成一般 script。主程式用了頂層 await，所以要包進 async IIFE 裡。
     頁面沒有任何 inline onclick 依賴全域函式（只有 onerror="this.remove()"），
     所以整包縮進函式作用域不會壞掉。 */
  let out = html.replace(marker, inject + '<script>\n(async () => {\n');

  const endMarker = '</script>\n</body>';
  if (!out.includes(endMarker)) throw new Error('index.html 結構變了，找不到主程式結尾');
  out = out.replace(endMarker, '})();\n</script>\n</body>');

  /* QR 要內嵌成 data URI —— 這支檔案會被單獨傳出去，
     相對路徑 ../../assets/ 到了別人手上一定失效，QR 就消失了，
     而 QR 正是這張圖要客戶掃的東西，不能掉。 */
  const qrSvg = await readFile(join(ROOT, '..', '..', 'assets', 'qr-line.svg'), 'utf8')
    .catch(() => null);
  if (qrSvg) {
    const uri = 'data:image/svg+xml;base64,' + Buffer.from(qrSvg, 'utf8').toString('base64');
    out = out.replace(/src="\.\.\/\.\.\/assets\/qr-line\.svg"/, `src="${uri}"`);
  }

  // 官方 logo 同樣要內嵌，否則傳出去就變成破圖
  const logo = await readFile(join(ROOT, '..', '..', 'assets', 'logo-uch.jpg'))
    .catch(() => null);
  if (logo) {
    const uri = 'data:image/jpeg;base64,' + logo.toString('base64');
    out = out.replace(/src="\.\.\/\.\.\/assets\/logo-uch\.jpg"/, `src="${uri}"`);
  } else {
    // 沒有檔案就整塊拿掉，讓字體識別接手，不要留破圖
    out = out.replace(/<div class="brand-logo">[\s\S]*?<\/div>/, '');
  }

  /* 拿掉「看完整社區資料」連結。
     這支檔案是拿來單獨傳給別人的，收到的人手上不會有 tools/qingpu-communities，
     點下去只會 404。線上版（走伺服器那份）留著。 */
  out = out.replace(
    /\s*\+ `<a class="to-db"[\s\S]*?看完整社區資料（逐年成交、坪數分布）→<\/a>`;/,
    ';'
  );

  // 標題加註，免得跟線上版搞混
  out = out.replace('<title>青埔地圖｜蕭沛縈 Rita</title>',
    '<title>青埔地圖（離線版）｜蕭沛縈 Rita</title>');

  const file = join(ROOT, '青埔地圖_離線版.html');
  await writeFile(file, out, 'utf8');

  const { size } = await stat(file);
  console.log(`已產生 青埔地圖_離線版.html（${(size / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  地標 ${(basemap.pois || []).length} 個　建物 ${(basemap.buildings || []).length} 棟`);
  console.log(`  社區 ${pins ? pins.pins.length : 0} 個${manual ? '　含手動校正' : ''}`);
  console.log('\n點兩下就能開，不必啟動伺服器，也可以直接傳給別人。');
}

main().catch((err) => { console.error('失敗：', err.message); process.exit(1); });
