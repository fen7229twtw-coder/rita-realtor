/**
 * 591 物件搜尋 Proxy
 *
 * 為什麼需要這支：591 的 BFF API 完全沒有回 CORS 標頭，
 * 瀏覽器直接打一定被擋。所以由 Netlify 這端代打，再把結果轉給前端。
 *
 * 只讀 591 公開的在售列表，不登入、不送出任何東西、不碰個資。
 * 沿用 realtor-competitor-board 的節制原則：每頁 30 筆、最多翻 4 頁、
 * 頁與頁之間停 350ms、有速率限制，不做大量批次抓取。
 */

const BFF = 'https://bff-house.591.com.tw/v1/web/sale/list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 允許呼叫的來源：她的 Netlify 站台與 GitHub Pages 官網 */
const ALLOWED = [
  'https://fen7229twtw-coder.github.io'
];
function corsHeaders(origin){
  const h = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=120'
  };
  /* 同站（Netlify 自己）不帶 Origin，或在白名單內才給 */
  if(origin && (ALLOWED.includes(origin) || /\.netlify\.app$/.test(new URL(origin).hostname))){
    h['Access-Control-Allow-Origin'] = origin;
  }else if(!origin){
    h['Access-Control-Allow-Origin'] = '*';
  }
  return h;
}

/* 粗略速率限制：同一 IP 每分鐘最多 20 次。
   函式冷啟動會清空，這只是擋住失控的迴圈，不是嚴謹防護。 */
const hits = new Map();
function rateLimited(ip){
  const now = Date.now();
  const win = 60_000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if(hits.size > 500) hits.clear();
  return arr.length > 20;
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: Object.assign({'Content-Type':'application/json; charset=utf-8'}, corsHeaders(origin))
});

export default async (req) => {
  const origin = req.headers.get('origin') || '';

  if(req.method === 'OPTIONS'){
    return new Response(null, {status:204, headers:corsHeaders(origin)});
  }
  if(req.method !== 'GET'){
    return json({ok:false, error:'只接受 GET'}, 405, origin);
  }

  const ip = req.headers.get('x-nf-client-connection-ip') ||
             req.headers.get('x-forwarded-for') || 'unknown';
  if(rateLimited(ip)){
    return json({ok:false, error:'查詢太頻繁，請等一分鐘再試'}, 429, origin);
  }

  const u = new URL(req.url);
  const keywords = (u.searchParams.get('q') || '').trim();
  const regionId = Number(u.searchParams.get('regionId')) || 6;   /* 預設桃園市 */
  const rooms    = u.searchParams.get('rooms')  || '';
  const minPrice = u.searchParams.get('minPrice') || '';
  const maxPrice = u.searchParams.get('maxPrice') || '';

  if(!keywords){
    return json({ok:false, error:'請輸入社區名、路段或關鍵字'}, 400, origin);
  }
  if(keywords.length > 40){
    return json({ok:false, error:'關鍵字太長'}, 400, origin);
  }

  /* 只轉發白名單參數，避免變成任意 591 代理。
     實測：房數要用 pattern（multiRoom/room 都會被 591 忽略）；
     總價則沒有任何參數對關鍵字搜尋有效，只能抓回來自己篩。 */
  const qs = new URLSearchParams({
    type: '2',
    regionId: String(regionId),
    keywords,
    totalRows: '30'
  });
  if(rooms) qs.set('pattern', rooms);

  /* 掃整個區域再篩價格時，一頁 30 筆根本不夠篩，所以允許翻頁。
     上限 4 頁、每頁之間停 350ms —— 沿用競品戰情室的節制原則，不做大量批次抓取。 */
  const maxPages = Math.min(Math.max(Number(u.searchParams.get('pages')) || 1, 1), 4);

  try{
    const list = [];
    for(let pg = 0; pg < maxPages; pg++){
      qs.set('firstRow', String(pg * 30));
      const r = await fetch(`${BFF}?${qs}`, {
        headers: { 'User-Agent': UA, device: 'pc' }
      });
      if(!r.ok){
        if(pg === 0) return json({ok:false, error:`591 回應異常（HTTP ${r.status}）`}, 502, origin);
        break;                        /* 後面幾頁失敗就用已經拿到的 */
      }
      const data = await r.json();
      const page = data?.data?.house_list || [];
      if(!page.length) break;
      list.push(...page);
      if(page.length < 30) break;     /* 已經是最後一頁 */
      if(pg < maxPages - 1) await sleep(350);
    }
    const fetched = list.length;

    /* 總價在這裡篩：591 的關鍵字搜尋不吃價格參數，只能抓回來自己篩 */
    let out = list;
    const lo = Number(minPrice), hi = Number(maxPrice);
    const hasLo = Number.isFinite(lo) && lo > 0, hasHi = Number.isFinite(hi) && hi > 0;
    if(hasLo || hasHi){
      out = out.filter(h => {
        const v = Number(h.price);
        if(!Number.isFinite(v)) return false;
        if(hasLo && v < lo) return false;
        if(hasHi && v > hi) return false;
        return true;
      });
    }

    return json({
      ok: true,
      fetched,                      /* 591 這批回了幾筆 */
      priceFiltered: out.length !== fetched,
      count: out.length,
      houses: out.map(shape)
    }, 200, origin);
  }catch(e){
    return json({ok:false, error:'連不上 591：' + e.message}, 502, origin);
  }
};

/* 只挑配案會用到的欄位回前端，其餘（影片、頭像、VIP 標記等）一律不傳 */
function shape(h){
  return {
    houseid: h.houseid,
    title: h.title || '',
    community: h.community_name || '',
    section: h.section_name || '',
    address: h.address || '',
    shape: h.shape_name || '',
    room: String(h.room ?? ''),
    floor: String(h.floor ?? ''),
    age: h.houseage ?? null,
    area: h.area ?? null,
    mainarea: h.mainarea ?? null,
    price: h.price ?? null,
    unitPrice: String(h.unitprice ?? ''),
    hasCarport: h.has_carport === 1,
    cartmodel: h.cartmodel || '',
    photo: h.photo_url || '',
    views: h.browsenum ?? 0,
    isDownPrice: h.is_down_price === 1,
    /* 刊登房仲：只給她自己判斷是否同業合作用，前端不會出現在客戶報告 */
    linkman: h.linkman || '',
    url: `https://sale.591.com.tw/home/house/detail/2/${h.houseid}.html`
  };
}

export const config = { path: '/api/591-search' };
