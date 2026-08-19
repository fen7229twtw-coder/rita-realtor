// 青埔地圖 — 共用設定
// 這裡的數字改了，fetch / build / geocode 三支都會跟著變，不要在別處硬填。

export const BBOX = {
  south: 24.9950,
  west: 121.1950,
  north: 25.0300,
  east: 121.2350,
};

// 門牌查詢用的放大範圍。
// 地圖只畫 BBOX 那塊（青埔核心，畫得夠大才看得清楚），但社區定位要看得更遠一點，
// 才分得出一個社區是「在圖框外」還是「OSM 查不到」——兩者處理方式完全不同：
// 框外的要列進「本圖範圍外」清單，查不到的才需要手動校正。
export const GEOCODE_BBOX = {
  south: 24.9600,
  west: 121.1600,
  north: 25.0500,
  east: 121.2500,
};

// Overpass 主站 + 備援。實測 overpass.kumi.systems 會 504，不要加回來。
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Overpass 不帶 User-Agent 會回 406，這行是必要的不是禮貌。
export const USER_AGENT = 'rita-qingpu-map/1.0 (local marketing map build; contact: fen7229.tw.tw@gmail.com)';

// 地圖畫布寬度（SVG 單位）。高度由內容實際長寬比推得，不硬填。
export const CANVAS_WIDTH = 1400;

export const bboxStr = () => `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

// 點是否落在 bbox 內。
// Overpass 的 out geom 會把「與 bbox 相交」的 way 整條回傳，國道與鐵路會拖出去好幾公里，
// 算範圍時一定要先濾掉界外的點，否則 bounding box 會被撐爛。
export const inBBox = (lon, lat) =>
  lat >= BBOX.south && lat <= BBOX.north && lon >= BBOX.west && lon <= BBOX.east;

export const geocodeBboxStr = () =>
  `${GEOCODE_BBOX.south},${GEOCODE_BBOX.west},${GEOCODE_BBOX.north},${GEOCODE_BBOX.east}`;
