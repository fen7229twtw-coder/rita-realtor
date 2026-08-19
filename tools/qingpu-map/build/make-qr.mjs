/* 產生 LINE 的 QR，並用「反著讀回來」的方式驗證正確性。
 * 用法： node build/make-qr.mjs
 *
 * 印在 A2 海報上的 QR 掃不出來 = 整批輸出報廢，所以一定要驗過才出檔：
 * 從矩陣把資料讀回來 → 解遮罩 → 抽碼字 → 驗 Reed-Solomon → 還原文字 → 比對原字串。
 * 對不上就不寫檔。
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, toSVG } from './qr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '..', '..', 'assets');

const TARGET = 'https://line.me/ti/p/~ritahaiao';

/* ══════════ 反向解碼（驗證用） ══════════ */

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

/** 重建「哪些格子是功能圖樣」的遮罩表，跟編碼端必須完全一致 */
function reservedMap(version) {
  const size = version * 4 + 17;
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };

  for (const [R, C] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(R + r, C + c);
  }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  mark(size - 8, 8);
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  return res;
}

/** 從格式資訊區把遮罩編號讀回來 */
function readMask(m, size) {
  let fmt = 0;
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = m[8][i];
    else if (i === 6) bit = m[8][7];
    else if (i === 7) bit = m[8][8];
    else if (i === 8) bit = m[7][8];
    else bit = m[14 - i][8];
    fmt |= bit << i;
  }
  const unmasked = fmt ^ 0b101010000010010;
  return (unmasked >> 10) & 0b111;
}

function readCodewords(m, version) {
  const size = version * 4 + 17;
  const res = reservedMap(version);
  const mask = readMask(m, size);

  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (res[row][c]) continue;
        let v = m[row][c];
        if (MASK_FN[mask](row, c)) v ^= 1;      // 解遮罩
        bits.push(v);
      }
    }
    upward = !upward;
  }

  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  return { codewords: cw, mask };
}

/* GF(256) —— 驗 syndrome 用 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** syndrome 全為 0 代表這串碼字沒有錯誤 —— 等於驗證了 RS 編碼是對的 */
function syndromesZero(block, ecLen) {
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    for (const b of block) s = gfMul(s, EXP[i]) ^ b;
    if (s !== 0) return false;
  }
  return true;
}

const EC_M = { 1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 32], 5: [24, 2, 43], 6: [16, 4, 27] };

function decode(matrix, version) {
  const [ecLen, blocks, perBlock] = EC_M[version];
  const { codewords, mask } = readCodewords(matrix, version);

  const totalData = blocks * perBlock;
  // 反交錯
  const dataBlocks = Array.from({ length: blocks }, () => []);
  let idx = 0;
  for (let i = 0; i < perBlock; i++) {
    for (let b = 0; b < blocks; b++) dataBlocks[b].push(codewords[idx++]);
  }
  const ecBlocks = Array.from({ length: blocks }, () => []);
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < blocks; b++) ecBlocks[b].push(codewords[idx++]);
  }

  const rsOk = dataBlocks.every((d, i) => syndromesZero([...d, ...ecBlocks[i]], ecLen));

  // 取回位元流讀出文字
  const flat = [];
  for (const b of dataBlocks) flat.push(...b);
  const bits = [];
  for (const cw of flat.slice(0, totalData)) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits.shift(); return v; };
  const mode = take(4);
  if (mode !== 0b0100) return { rsOk, mask, text: null, err: `模式不是 byte（讀到 ${mode.toString(2)}）` };
  const len = take(8);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return { rsOk, mask, text: new TextDecoder().decode(Uint8Array.from(bytes)) };
}

/* ══════════ 主程式 ══════════ */
async function main() {
  const { version, matrix } = encode(TARGET);
  const size = matrix.length;

  console.log(`編碼：${TARGET}`);
  console.log(`版本 ${version}（${size}×${size} 模組）、EC 等級 M（可容忍約 15% 破損）\n`);

  const got = decode(matrix, version);
  const checks = [
    ['Reed-Solomon syndrome 全為 0', got.rsOk],
    ['解碼後文字與原字串一致', got.text === TARGET],
    ['三個定位圖樣正確', matrix[0][0] === 1 && matrix[0][6] === 1 && matrix[6][0] === 1 && matrix[1][1] === 0],
    ['時序圖樣正確', matrix[6][8] === 1 && matrix[6][9] === 0 && matrix[8][6] === 1],
    ['固定深色模組存在', matrix[size - 8][8] === 1],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allOk = false;
  }
  if (got.text !== TARGET) console.log(`\n  讀回來的是：${JSON.stringify(got.text)}${got.err ? '（' + got.err + '）' : ''}`);

  if (!allOk) {
    console.error('\n驗證沒過，不產生檔案。掃不出來的 QR 印上去等於整批報廢。');
    process.exit(1);
  }

  const svg = toSVG(matrix);
  const file = join(ASSETS, 'qr-line.svg');
  await writeFile(file, svg, 'utf8');
  console.log(`\n驗證全部通過 → 已寫入 assets/qr-line.svg（${(svg.length / 1024).toFixed(1)} KB，向量檔，放多大都不糊）`);
}

main().catch((err) => { console.error('失敗：', err.stack); process.exit(1); });
