/* 最小可用的 QR Code 編碼器（byte 模式、EC 等級 M、版本 1-6）。
 *
 * 為什麼自己寫：印在 A2 海報上的 QR 掃不出來 = 整批輸出報廢，
 * 所以不能用「大概對」的東西，也不想為了一張圖多裝一包相依套件
 * （中控台那套零依賴的原則，這裡沿用）。
 *
 * 正確性靠 verify.mjs 的往返解碼驗證：把產生的矩陣反著讀回來，
 * 解遮罩、抽碼字、驗 Reed-Solomon syndrome、還原文字，比對是否等於原字串。
 */

/* ══════════ Galois Field GF(256) ══════════ */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // QR 用的本原多項式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 產生生成多項式 g(x) = ∏(x - α^i) */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

/* ══════════ 版本表（只做 EC 等級 M） ══════════
 * [ 每塊的 EC 碼字數, 群組1塊數, 群組1每塊資料碼字, 群組2塊數, 群組2每塊資料碼字 ] */
const EC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
};
/** 對齊圖樣中心座標 */
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

const dataCapacity = (v) => {
  const [, g1, c1, g2, c2] = EC_M[v];
  return g1 * c1 + g2 * c2;
};

/* ══════════ 位元串 ══════════ */
class Bits {
  constructor() { this.bits = []; }
  push(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
}

/* ══════════ 主編碼 ══════════ */
export function encode(text) {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 6; v++) {
    // 4 位模式 + 8 位長度（版本 1-9）+ 資料
    if (4 + 8 + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error(`字串太長（${bytes.length} bytes），版本 1-6 放不下`);

  const [ecLen, g1, c1, g2, c2] = EC_M[version];
  const totalData = dataCapacity(version);

  /* --- 資料位元 --- */
  const bs = new Bits();
  bs.push(0b0100, 4);                 // byte 模式
  bs.push(bytes.length, 8);           // 長度（版本 1-9 是 8 位）
  for (const b of bytes) bs.push(b, 8);

  const cap = totalData * 8;
  bs.push(0, Math.min(4, cap - bs.length));          // 終止符
  while (bs.length % 8) bs.bits.push(0);             // 補到整位元組
  const pad = [0xec, 0x11];
  for (let i = 0; bs.length < cap; i++) bs.push(pad[i % 2], 8);

  const dataCw = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bs.bits[i * 8 + j];
    dataCw[i] = byte;
  }

  /* --- 分塊 + RS --- */
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) { blocks.push(dataCw.slice(off, off + c1)); off += c1; }
  for (let i = 0; i < g2; i++) { blocks.push(dataCw.slice(off, off + c2)); off += c2; }
  const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

  /* --- 交錯 --- */
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }

  return { version, codewords: Uint8Array.from(out), matrix: buildMatrix(version, out) };
}

/* ══════════ 矩陣 ══════════ */
function buildMatrix(version, codewords) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

  /* 定位圖樣 + 分隔線 */
  const finder = (R, C) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = R + r;
        const cc = C + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setF(rr, cc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  /* 對齊圖樣 */
  const coords = ALIGN[version];
  for (const r of coords) {
    for (const c of coords) {
      // 跟三個定位圖樣重疊的位置要跳過
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setF(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }

  /* 時序圖樣 */
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) setF(6, i, on);
    if (!reserved[i][6]) setF(i, 6, on);
  }

  /* 固定的深色模組 */
  setF(size - 8, 8, 1);

  /* 格式資訊區先佔位 */
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; }
    if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (!reserved[size - 1 - i][8]) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }

  /* 資料填入：由右下起，每兩欄一組蛇行 */
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let bi = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                          // 時序欄跳過
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        m[row][c] = bi < bits.length ? bits[bi++] : 0;
      }
    }
    upward = !upward;
  }

  /* 選遮罩：8 種都試，取懲罰分最低的 */
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(m, reserved, mask, size);
    placeFormat(cand, size, mask);
    const score = penalty(cand, size);
    if (!best || score < best.score) best = { score, mask, matrix: cand };
  }
  return best.matrix;
}

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

function applyMask(m, reserved, mask, size) {
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (MASK_FN[mask](r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

/** 格式資訊：EC 等級 M(00) + 遮罩，BCH(15,5) 編碼後再與遮罩字串 XOR */
function placeFormat(m, size, mask) {
  const data = (0b00 << 3) | mask;              // M 的等級位元是 00
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (i + 10)) & 1) bch ^= 0b10100110111 << i;
  }
  const fmt = ((data << 10) | bch) ^ 0b101010000010010;

  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    // 左上
    if (i < 6) m[8][i] = bit;
    else if (i === 6) m[8][7] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[7][8] = bit;
    else m[14 - i][8] = bit;
    // 右上 / 左下
    if (i < 8) m[size - 1 - i][8] = bit;
    else m[8][size - 15 + i] = bit;
  }
  m[size - 8][8] = 1;                            // 固定深色模組
}

/** 標準的四項懲罰規則，用來挑最好認的遮罩 */
function penalty(m, size) {
  let p = 0;

  // 規則 1：同色連續 5 個以上
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((r) => r[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run++; }
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
  }
  // 規則 2：2x2 同色
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
  }
  // 規則 3：類似定位圖樣的序列
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hit = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((r) => r[i])]) {
      for (let j = 0; j + 11 <= size; j++) {
        if (hit(line, j, pat1) || hit(line, j, pat2)) p += 40;
      }
    }
  }
  // 規則 4：深色比例偏離 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return p;
}

/* ══════════ 輸出 SVG ══════════ */
export function toSVG(matrix, { quiet = 4, dark = '#0B2E20', light = '#FFFFFF' } = {}) {
  const size = matrix.length;
  const total = size + quiet * 2;
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path d="${d}" fill="${dark}"/>`
    + `</svg>`;
}
