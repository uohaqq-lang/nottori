'use strict';
/* 仮の駅の表（主要駅だけ）。あとで全国の駅データに差し替える。
   緯度・経度はおおよその値。画面には駅名しか出さない。 */
const STATIONS = [
  ['札幌', 43.0687, 141.3508],
  ['仙台', 38.2601, 140.8823],
  ['新潟', 37.9122, 139.0613],
  ['大宮', 35.9064, 139.6239],
  ['池袋', 35.7295, 139.7109],
  ['上野', 35.7138, 139.7773],
  ['新宿', 35.6896, 139.7006],
  ['東京', 35.6812, 139.7671],
  ['渋谷', 35.6580, 139.7016],
  ['品川', 35.6285, 139.7388],
  ['千葉', 35.6130, 140.1133],
  ['横浜', 35.4660, 139.6223],
  ['静岡', 34.9718, 138.3890],
  ['金沢', 36.5781, 136.6478],
  ['名古屋', 35.1709, 136.8815],
  ['京都', 34.9858, 135.7588],
  ['大阪', 34.7025, 135.4959],
  ['三ノ宮', 34.6946, 135.1955],
  ['岡山', 34.6664, 133.9180],
  ['広島', 34.3976, 132.4754],
  ['博多', 33.5902, 130.4207],
  ['鹿児島中央', 31.5839, 130.5414],
  ['県庁前', 26.2149, 127.6792]
];

/* 「遠い都道府県」の候補。上から順に、遊ぶ人から300km以上離れた最初のものを使う。 */
const FAR_PREFS = [
  ['大阪府', 34.6863, 135.5200],
  ['福岡県', 33.6064, 130.4183],
  ['北海道', 43.0642, 141.3469]
];

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* 一番近い駅の名前を返す（端末の中だけで計算する） */
function nearestStation(lat, lon) {
  let best = null, bestD = Infinity;
  const list = (typeof STATIONS_ALL !== 'undefined' && STATIONS_ALL.length) ? STATIONS_ALL : STATIONS;
  for (const [name, a, b] of list) {
    const d = distKm(lat, lon, a, b);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

function farPrefecture(lat, lon) {
  if (typeof lat !== 'number') return FAR_PREFS[0][0];
  for (const [name, a, b] of FAR_PREFS) {
    if (distKm(lat, lon, a, b) >= 300) return name;
  }
  return FAR_PREFS[0][0];
}
