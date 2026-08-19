// 青埔地圖自動更新。
// 用法： node build/auto-update.mjs [--dry] [--no-push] [--skip-fetch]
//
// 為什麼要這支：地圖的資料有兩個會自己變的來源 ——
//   OSM（青埔的路、建物、門牌，隨時有人在編輯）
//   實價登錄（內政部每月更新成交、屋齡、樓高）
// 手動記得重跑是不可能的事，所以讓它自己跑。
//
// 但「自動覆蓋」有個真實風險：OSM 那邊改了東西，某個社區的定位就可能跑掉，
// 而跑掉這件事沒人會發現 —— 直到帶看當天客戶站在錯的樓下。
// 所以這支的重點不是「跑得動」，是「跑壞了要擋下來」：
//   更新前備份 → 跑完比對 → 任何一項不對就還原，不推上線，把原因寫進狀態檔。
//
// 樂居那份資料（戶數、公設比、地址）不在自動範圍內 —— 樂居整站有 Cloudflare，
// 查證過抓不到，只能人工補進 leju-crosscheck.tsv。

import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = join(HERE, '..');
const DATA = join(MAP, 'data');
const COMM = join(MAP, '..', 'qingpu-communities');
const ROOT = join(MAP, '..', '..');
const PINS = join(DATA, 'pins.json');
const BACKUP = join(DATA, 'pins.backup.json');
const STATE = join(DATA, 'auto-update-state.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NO_PUSH = argv.includes('--no-push');
const SKIP_FETCH = argv.includes('--skip-fetch');

/* 免安裝 Node 的實際路徑。spawn 不能直接跑 .cmd，所以一律叫 node.exe 跑 .mjs。 */
const NODE = process.execPath;

const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

function run(script, cwd, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(NODE, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} 失敗（exit ${code}）\n${out.slice(-800)}`))));
  });
}

/* ---------- 更新前後要比對什麼 ----------
   這三項是「地圖壞掉」最常見的長相。門檻刻意抓寬 —— 誤擋一次頂多晚一週更新，
   放過一次錯的資料是帶看當天出事。 */
const COS = Math.cos(25 * Math.PI / 180);
const metersApart = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 111000 * COS);

function compare(before, after) {
  const problems = [];
  const notes = [];

  // ① 社區數：掉超過 5% 代表資料源出事（例如 Overpass 只回了一半）
  const b = before.pins.length;
  const a = after.pins.length;
  if (a < b * 0.95) problems.push(`社區數從 ${b} 掉到 ${a}（少了 ${b - a} 個）`);
  else if (a !== b) notes.push(`社區數 ${b} → ${a}`);

  // ② 定位精準度：門牌級佔比掉太多，代表門牌資料抓壞了
  const precise = (d) => d.pins.filter((p) => ['addr', 'addr-near', 'interp'].includes(p.conf)).length / (d.pins.length || 1);
  const pb = precise(before);
  const pa = precise(after);
  if (pa < pb - 0.1) problems.push(`門牌級定位從 ${(pb * 100).toFixed(0)}% 掉到 ${(pa * 100).toFixed(0)}%`);

  // ③ 位置跑掉：同一個社區移動超過 50 公尺。
  //    青埔一個街廓大約 100 公尺，跑 50 公尺就是走錯棟了。
  const byId = new Map(before.pins.map((p) => [p.id, p]));
  const moved = [];
  for (const p of after.pins) {
    const old = byId.get(p.id);
    if (!old) continue;
    const d = metersApart(old, p);
    if (d > 50) moved.push({ name: p.name, m: Math.round(d) });
  }
  moved.sort((x, y) => y.m - x.m);
  if (moved.length > 3) {
    problems.push(`有 ${moved.length} 個社區的位置跑掉超過 50 公尺：`
      + moved.slice(0, 5).map((m) => `${m.name} 移了 ${m.m}m`).join('、'));
  } else if (moved.length) {
    notes.push('位置有調整：' + moved.map((m) => `${m.name} ${m.m}m`).join('、'));
  }

  // 純粹給人看的變化
  const names = (d) => new Set(d.pins.map((p) => p.name));
  const nb = names(before);
  const na = names(after);
  const added = [...na].filter((n) => !nb.has(n));
  const gone = [...nb].filter((n) => !na.has(n));
  if (added.length) notes.push(`新增 ${added.length} 個社區：${added.slice(0, 8).join('、')}${added.length > 8 ? '…' : ''}`);
  if (gone.length) notes.push(`不見了 ${gone.length} 個：${gone.slice(0, 8).join('、')}${gone.length > 8 ? '…' : ''}`);

  return { problems, notes, added: added.length, gone: gone.length, moved: moved.length };
}

/* 推上線只 add 資料檔。
   工作目錄常常有別的對話視窗改到一半的程式，git add -A 會把半成品一起推給客戶。 */
function git(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} 失敗：${out.slice(-500)}`))));
  });
}

async function saveState(state) {
  await writeFile(STATE, JSON.stringify({ ...state, at: new Date().toISOString(), log }, null, 1), 'utf8');
}

async function main() {
  const started = Date.now();
  const before = existsSync(PINS) ? JSON.parse(await readFile(PINS, 'utf8')) : null;
  if (before) await copyFile(PINS, BACKUP);

  try {
    if (!SKIP_FETCH) {
      say('[1/6] 抓實價登錄（內政部每月更新一次）…');
      await run(join(COMM, 'build', 'fetch-build.mjs'), COMM);

      say('[2/6] 重抓 OSM 圖資（青埔的路、建物、門牌）…');
      await run(join(MAP, 'build', 'fetch-osm.mjs'), MAP, ['--force']);
    } else {
      say('[1-2/6] 跳過抓資料（--skip-fetch）');
    }

    say('[3/6] 重畫底圖…');
    await run(join(MAP, 'build', 'build-basemap.mjs'), MAP);

    say('[4/6] 社區定位…');
    const geo = await run(join(MAP, 'build', 'geocode-pins.mjs'), MAP);
    const m = geo.match(/全圖共 (\d+) 個社區/);
    if (m) say(`      → ${m[1]} 個社區`);

    say('[5/6] 路網圖（帶看的行車時間靠它）…');
    await run(join(MAP, 'build', 'build-roadgraph.mjs'), MAP);

    const after = JSON.parse(await readFile(PINS, 'utf8'));
    const diff = before ? compare(before, after) : { problems: [], notes: ['第一次跑，沒有可比的舊資料'] };

    if (diff.problems.length) {
      // 擋下來：還原舊的，不推上線
      if (before) await copyFile(BACKUP, PINS);
      say('');
      say('⚠ 更新後的資料不對勁，已經還原成舊的，沒有推上線：');
      diff.problems.forEach((p) => say('  ' + p));
      say('');
      say('要自己看的話：跑 node build/geocode-pins.mjs 再開地圖確認。');
      await saveState({ ok: false, blocked: true, problems: diff.problems, notes: diff.notes });
      process.exitCode = 2;
      return;
    }

    say('[6/6] 離線版與 QR…');
    await run(join(MAP, 'build', 'build-standalone.mjs'), MAP);
    await run(join(MAP, 'build', 'make-qr.mjs'), MAP);

    if (diff.notes.length) {
      say('');
      say('這次的變化：');
      diff.notes.forEach((n) => say('  ' + n));
    } else {
      say('');
      say('資料沒有變化。');
    }

    let pushed = false;
    const changed = diff.added || diff.gone || diff.moved || diff.notes.length;
    if (DRY) {
      say('（--dry：沒有推上線）');
    } else if (NO_PUSH) {
      say('（--no-push：本機更新完成，沒有推上線）');
    } else if (!changed) {
      say('沒有變化就不推，免得洗版控紀錄。');
    } else {
      const status = await git(['status', '--porcelain', 'tools/qingpu-map/data']);
      if (status.trim()) {
        await git(['add', 'tools/qingpu-map/data/pins.json', 'tools/qingpu-map/data/basemap.json',
          'tools/qingpu-map/data/basemap-lite.json', 'tools/qingpu-map/data/roadgraph.json']);
        const staged = await git(['diff', '--cached', '--name-only']);
        if (staged.trim()) {
          const summary = diff.notes.slice(0, 3).join('；') || '資料重跑';
          await git(['commit', '-m', `青埔地圖自動更新：${summary}`,
            '-m', 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>']);
          /* 別的對話視窗常常搶先推東西，本地一落後 push 就會被拒。
             先 rebase 再推一次 —— 這支只動 data 底下的資料檔，撞在一起的機率很低。 */
          try {
            await git(['push', 'origin', 'main']);
          } catch {
            say('推的時候發現遠端有新東西，先接上去再推一次…');
            await git(['pull', '--rebase', 'origin', 'main']);
            await git(['push', 'origin', 'main']);
          }
          pushed = true;
          say('已推上線，客戶端過幾分鐘就看得到。');
        }
      } else {
        say('資料檔沒有實際差異，不用推。');
      }
    }

    say(`完成，花了 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    await saveState({ ok: true, blocked: false, pushed, notes: diff.notes, problems: [] });
  } catch (err) {
    if (before && existsSync(BACKUP)) await copyFile(BACKUP, PINS);
    say('');
    say('✗ 更新失敗，已還原成舊資料：' + err.message);
    await saveState({ ok: false, blocked: false, error: err.message, problems: ['更新過程出錯：' + err.message] });
    process.exitCode = 1;
  }
}

main();
