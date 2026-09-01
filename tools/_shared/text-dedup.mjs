/* ===================================================================
   text-dedup.mjs — 中文標題去重（時事貼文與青埔監看共用）
   ------------------------------------------------------------------
   本來只寫在 tools/news-post/build/score.mjs 裡，青埔監看也要用，
   所以抽出來。**同一份規則只能有一份** —— 這裡面的門檻與坑
   是量出來、也踩出來的，散成兩份的話修好一邊另一邊會繼續錯。

   ── 為什麼不比字串 ────────────────────────────────
   同一件事各報下的標題差很多：
     「7月新承做房貸增逾百億創1年新高」
     「五大銀行新增房貸衝近700億」
   比字串完全比不出來。改成比「相鄰兩個中文字」的重疊率才抓得住。
   中文沒有空格、斷詞要字典，但同一件事的不同標題一定共用大量字對
   （「房貸」「銀行」「新高」），所以字對比對不需要字典而且快。

   ── 三個踩過的坑（改之前先看）──────────────────────
   ① 要跟組裡「任何一則」比，不是只跟代表比。
      A 像 B、B 像 C 但 A 不像 C 是常態，只跟代表比同一件事會裂成三組。
   ② 貪婪分群不會事後合併已經建立的群，分完要再掃一遍（mergeGroups）。
   ③ 邊掃邊 splice 會索引錯位，被刪那格後面整組會被跳過。
      要先記 dead 集合，掃完再一次過濾。
=================================================================== */

/**
 * 兩則標題要多像才算同一件事。
 * 這個數字是量出來的不是猜的：實測同一事件的不同報導落在 0.36~0.42，
 * 不同事件最高只到 0.14。取 0.30，兩邊都留了餘裕。
 */
export const SAME_STORY = 0.30;

/**
 * 把標題切成「相鄰兩個中文字」的集合，外加數字＋單位。
 *
 * 數字＋單位當成一個 token（「700億」「7月」「3.2%」），
 * 那是同一則新聞最不會被改掉的部分。
 */
export function shingles(title) {
  const t = String(title || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　「」『』【】《》〈〉（）()\[\]"'!！?？,，.。、:：;；\-－—…～~|｜+＋]/g, '');
  const set = new Set();
  for (const m of t.matchAll(/\d+(?:\.\d+)?(?:億|萬|千|%|％|成|倍|月|年|日|波|家|戶|坪|元|人|次)/g)) {
    set.add(m[0]);
  }
  const zh = t.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < zh.length - 1; i++) set.add(zh.slice(i, i + 2));
  return set;
}

/** 兩個集合的重疊率（交集 ÷ 較小的那個）。 */
export function overlap(a, b) {
  if (!a?.size || !b?.size) return 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const x of s) if (l.has(x)) hit++;
  return hit / s.size;
}

/**
 * 把「新的＋舊的」再清一次重複。
 *
 * 為什麼一定要有這一支：feed 滾動保留 N 天，**舊的分群結果不會因為
 * 新一輪合併而消失**。昨天某則自己成一群，今天更多家報同一件事被併成
 * 一群了 —— 但昨天那則還躺在 feed 裡，畫面上同一個題目就佔兩格。
 * 用 id 比對只擋得掉「標題一模一樣」的。
 * **任何「保留 N 天 + 自動分群」的系統都會踩到這個。**
 *
 * @param {object[]} list 每則要有 title；可有 score、cats
 * @param {object} opt
 * @param {(keep:object, drop:object)=>void} [opt.onMerge] 被丟掉那則的標記要怎麼搬到留下來的那則
 * @param {(a:object,b:object)=>boolean} [opt.canPair] 額外的護欄（例如分類要有交集）
 */
export function dedupe(list, opt = {}) {
  const { onMerge, canPair } = opt;
  const items = list.map((x) => ({ x, sh: shingles(x.title) }));
  /* 分數高的當留下來的那個。沒有分數就照原順序。 */
  items.sort((a, b) => (b.x.score || 0) - (a.x.score || 0));

  const dead = new Set();          // 先記，掃完再一次過濾（坑 ③）
  for (let i = 0; i < items.length; i++) {
    if (dead.has(i)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (dead.has(j)) continue;
      if (canPair && !canPair(items[i].x, items[j].x)) continue;
      if (overlap(items[i].sh, items[j].sh) < SAME_STORY) continue;
      dead.add(j);
      onMerge?.(items[i].x, items[j].x);
    }
  }
  return items.filter((_, i) => !dead.has(i)).map((o) => o.x);
}
