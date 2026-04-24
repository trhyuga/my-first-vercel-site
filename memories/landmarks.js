// Landmark dictionary — used to translate raw GPS coordinates into a memorable
// place name (テーマパーク・観光地等) for the video subtitles.
//
// Format:
//   { name: '東京ディズニーランド', short: 'ディズニーランド',
//     lat: 35.6329, lng: 139.8804, radius: 1500 }
//
// "radius" is the match radius in metres. A photo whose cluster centroid lies
// within this distance gets that landmark's name. Generous radii (1-2 km) are
// fine because clusters are usually small and the dictionary doesn't have
// tightly-packed entries.
//
// If no landmark matches, the app falls back to a Nominatim (OpenStreetMap)
// reverse-geocode lookup, then to a generic "エリア A" label.
//
// Coordinates are approximate but verified against general public knowledge;
// users who want pinpoint accuracy can edit this file.

window.LANDMARKS = [
  // 日本 — テーマパーク
  { name: '東京ディズニーランド',     short: 'ディズニーランド', lat: 35.6329, lng: 139.8804, radius: 1500 },
  { name: '東京ディズニーシー',       short: 'ディズニーシー',   lat: 35.6267, lng: 139.8851, radius: 1500 },
  { name: 'ユニバーサル・スタジオ・ジャパン', short: 'USJ',     lat: 34.6655, lng: 135.4323, radius: 1500 },
  { name: '富士急ハイランド',         short: '富士急',           lat: 35.4878, lng: 138.7806, radius: 1500 },
  { name: 'ナガシマスパーランド',     short: 'ナガシマ',         lat: 35.0297, lng: 136.7322, radius: 1500 },
  { name: 'よみうりランド',           short: 'よみうりランド',   lat: 35.6230, lng: 139.5183, radius: 1200 },
  { name: '横浜・八景島シーパラダイス', short: 'シーパラ',       lat: 35.3373, lng: 139.6442, radius: 1200 },
  { name: 'ハウステンボス',           short: 'ハウステンボス',   lat: 33.0851, lng: 129.7864, radius: 2000 },
  { name: '志摩スペイン村',           short: '志摩スペイン村',   lat: 34.3408, lng: 136.8800, radius: 1200 },
  { name: '東京サマーランド',         short: 'サマーランド',     lat: 35.7376, lng: 139.2280, radius: 1200 },

  // 日本 — 動物・水族館
  { name: '上野動物園',               short: '上野動物園',       lat: 35.7167, lng: 139.7714, radius: 800  },
  { name: '旭山動物園',               short: '旭山動物園',       lat: 43.7681, lng: 142.4811, radius: 1200 },
  { name: '沖縄美ら海水族館',         short: '美ら海水族館',     lat: 26.6943, lng: 127.8780, radius: 1500 },
  { name: '海遊館',                   short: '海遊館',           lat: 34.6545, lng: 135.4290, radius: 800  },
  { name: '葛西臨海水族園',           short: '葛西臨海水族園',   lat: 35.6402, lng: 139.8597, radius: 800  },

  // 日本 — 観光名所 (関東)
  { name: '東京タワー',               short: '東京タワー',       lat: 35.6586, lng: 139.7454, radius: 700  },
  { name: '東京スカイツリー',         short: 'スカイツリー',     lat: 35.7101, lng: 139.8107, radius: 700  },
  { name: '浅草寺',                   short: '浅草',             lat: 35.7148, lng: 139.7967, radius: 700  },
  { name: '渋谷スクランブル交差点',   short: '渋谷',             lat: 35.6595, lng: 139.7004, radius: 800  },
  { name: '原宿',                     short: '原宿',             lat: 35.6702, lng: 139.7027, radius: 700  },
  { name: '皇居',                     short: '皇居',             lat: 35.6852, lng: 139.7528, radius: 1200 },
  { name: '明治神宮',                 short: '明治神宮',         lat: 35.6764, lng: 139.6993, radius: 1200 },
  { name: 'お台場',                   short: 'お台場',           lat: 35.6304, lng: 139.7820, radius: 1500 },
  { name: '新宿御苑',                 short: '新宿御苑',         lat: 35.6852, lng: 139.7100, radius: 1000 },
  { name: '鎌倉大仏 (高徳院)',         short: '鎌倉',             lat: 35.3168, lng: 139.5358, radius: 1000 },
  { name: '江ノ島',                   short: '江ノ島',           lat: 35.3000, lng: 139.4814, radius: 1500 },
  { name: '箱根',                     short: '箱根',             lat: 35.2330, lng: 139.0240, radius: 5000 },
  { name: '富士山',                   short: '富士山',           lat: 35.3606, lng: 138.7274, radius: 8000 },
  { name: '日光東照宮',               short: '日光',             lat: 36.7580, lng: 139.5990, radius: 1500 },

  // 日本 — 観光名所 (関西)
  { name: '清水寺',                   short: '清水寺',           lat: 34.9949, lng: 135.7851, radius: 800  },
  { name: '伏見稲荷大社',             short: '伏見稲荷',         lat: 34.9671, lng: 135.7727, radius: 800  },
  { name: '金閣寺',                   short: '金閣寺',           lat: 35.0394, lng: 135.7292, radius: 800  },
  { name: '銀閣寺',                   short: '銀閣寺',           lat: 35.0270, lng: 135.7982, radius: 800  },
  { name: '嵐山',                     short: '嵐山',             lat: 35.0094, lng: 135.6671, radius: 1500 },
  { name: '東大寺・奈良公園',         short: '奈良',             lat: 34.6851, lng: 135.8430, radius: 2000 },
  { name: '大阪城',                   short: '大阪城',           lat: 34.6873, lng: 135.5262, radius: 1000 },
  { name: '通天閣・新世界',           short: '通天閣',           lat: 34.6525, lng: 135.5063, radius: 800  },
  { name: '神戸ハーバーランド',       short: '神戸',             lat: 34.6797, lng: 135.1830, radius: 1500 },
  { name: '姫路城',                   short: '姫路城',           lat: 34.8394, lng: 134.6939, radius: 800  },

  // 日本 — その他
  { name: '札幌時計台',               short: '札幌',             lat: 43.0628, lng: 141.3537, radius: 1500 },
  { name: '小樽運河',                 short: '小樽',             lat: 43.1932, lng: 140.9954, radius: 1000 },
  { name: '函館山',                   short: '函館',             lat: 41.7595, lng: 140.7041, radius: 2000 },
  { name: '仙台城跡',                 short: '仙台',             lat: 38.2520, lng: 140.8560, radius: 1500 },
  { name: '名古屋城',                 short: '名古屋',           lat: 35.1856, lng: 136.8997, radius: 1000 },
  { name: '熱海',                     short: '熱海',             lat: 35.0964, lng: 139.0760, radius: 3000 },
  { name: '伊勢神宮',                 short: '伊勢神宮',         lat: 34.4549, lng: 136.7256, radius: 1500 },
  { name: '出雲大社',                 short: '出雲大社',         lat: 35.4017, lng: 132.6856, radius: 800  },
  { name: '宮島・厳島神社',           short: '宮島',             lat: 34.2960, lng: 132.3198, radius: 1500 },
  { name: '原爆ドーム',               short: '広島',             lat: 34.3955, lng: 132.4536, radius: 1500 },
  { name: '道後温泉',                 short: '道後温泉',         lat: 33.8520, lng: 132.7860, radius: 800  },
  { name: '阿蘇山',                   short: '阿蘇',             lat: 32.8842, lng: 131.1040, radius: 5000 },
  { name: '別府温泉',                 short: '別府',             lat: 33.2802, lng: 131.4998, radius: 3000 },
  { name: '首里城',                   short: '首里城',           lat: 26.2173, lng: 127.7194, radius: 1000 },
  { name: '国際通り (那覇)',           short: '那覇・国際通り',   lat: 26.2147, lng: 127.6852, radius: 800  },

  // 海外 — ディズニー系
  { name: 'ディズニーランド (カリフォルニア)', short: 'カリフォルニア・ディズニー', lat: 33.8121, lng: -117.9190, radius: 2000 },
  { name: 'ウォルト・ディズニー・ワールド (フロリダ)', short: 'WDW',         lat: 28.3852, lng:  -81.5639, radius: 5000 },
  { name: 'ディズニーランド・パリ',     short: 'パリ・ディズニー', lat: 48.8722, lng:    2.7758, radius: 2000 },
  { name: '香港ディズニーランド',       short: '香港ディズニー',   lat: 22.3133, lng:  114.0394, radius: 2000 },
  { name: '上海ディズニーランド',       short: '上海ディズニー',   lat: 31.1448, lng:  121.6603, radius: 2500 },

  // 海外 — 主要都市の有名スポット
  { name: 'エッフェル塔',               short: 'エッフェル塔',     lat: 48.8584, lng:    2.2945, radius: 800  },
  { name: 'ルーブル美術館',             short: 'ルーブル',         lat: 48.8606, lng:    2.3376, radius: 800  },
  { name: 'タイムズスクエア',           short: 'タイムズスクエア', lat: 40.7580, lng:  -73.9855, radius: 600  },
  { name: '自由の女神',                 short: '自由の女神',       lat: 40.6892, lng:  -74.0445, radius: 800  },
  { name: 'グランドキャニオン',         short: 'グランドキャニオン', lat: 36.0544, lng: -112.1401, radius: 8000 },
  { name: 'ロンドン・ビッグベン',       short: 'ロンドン',         lat: 51.5007, lng:   -0.1246, radius: 1500 },
  { name: 'コロッセオ',                 short: 'ローマ',           lat: 41.8902, lng:   12.4922, radius: 1000 },
  { name: 'タージ・マハル',             short: 'タージマハル',     lat: 27.1751, lng:   78.0421, radius: 1000 },
  { name: 'マチュ・ピチュ',             short: 'マチュピチュ',     lat: -13.1631, lng: -72.5450, radius: 2000 },
  { name: 'シドニー・オペラハウス',     short: 'シドニー',         lat: -33.8568, lng: 151.2153, radius: 1000 },
  { name: '万里の長城 (八達嶺)',         short: '万里の長城',       lat: 40.3597, lng:  116.0166, radius: 3000 },
  { name: '台北101',                    short: '台北',             lat: 25.0339, lng:  121.5645, radius: 800  },
  { name: '九份',                       short: '九份',             lat: 25.1090, lng:  121.8443, radius: 1000 },
];
