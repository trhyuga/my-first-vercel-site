// Built-in BGM catalog. Files live under ./assets/music/ and are served as
// static assets by Vercel/whatever host. Each track was uploaded by the user
// and licence-cleared on their end. Durations probed via mutagen.
//
// Each entry:
//   id          stable identifier (kebab-case)
//   title       display title
//   artist      composer / source label
//   url         path relative to /memories/index.html (URL-encoded)
//   durationSec total track length, in seconds
//   endCueSec   optional — seconds where the track reaches a clean cadence.
//               Omitted here; AudioMixer's tail fade-out handles closes.
//   tags        mood keywords; autoPickBgmTrack scores against these.

window.MUSIC_CATALOG = [
  // --- ~30s shorts (use for tiny photo counts) ---
  {
    id: 'a-quiet-departure', title: '静かな旅立ち',
    artist: 'asset', url: './assets/music/A_Quiet_Departure.mp3',
    durationSec: 30.77, tags: ['calm', 'memorial', 'short', 'piano'],
  },
  {
    id: 'before-leaves-turn', title: '紅葉の前に',
    artist: 'asset', url: './assets/music/Before_the_Leaves_Turn.mp3',
    durationSec: 30.77, tags: ['nostalgic', 'tender', 'short'],
  },
  {
    id: 'letters-to-shore', title: '海辺への手紙',
    artist: 'asset', url: './assets/music/Letters_to_the_Shore.mp3',
    durationSec: 30.77, tags: ['calm', 'tender', 'short', 'emotional'],
  },
  {
    id: 'summers-last-afternoon', title: '夏の最後の午後',
    artist: 'asset', url: './assets/music/Summer%E2%80%99s_Last_Afternoon.mp3',
    durationSec: 30.77, tags: ['nostalgic', 'warm', 'short'],
  },
  {
    id: 'light-on-the-porch', title: '玄関先の光',
    artist: 'asset', url: './assets/music/The_Light_on_the_Porch.mp3',
    durationSec: 28.76, tags: ['warm', 'tender', 'short', 'gentle'],
  },
  {
    id: 'memories-rest', title: '思い出のある場所',
    artist: 'asset', url: './assets/music/Where_the_Memories_Rest.mp3',
    durationSec: 30.77, tags: ['memorial', 'calm', 'short', 'reflective'],
  },

  // --- ~55-90s mid-length ---
  {
    id: 'beyond-finish-line', title: 'ゴールの先へ',
    artist: 'asset', url: './assets/music/Beyond_the_Finish_Line.mp3',
    durationSec: 57.16, tags: ['uplifting', 'memorial', 'cheerful'],
  },
  {
    id: 'climbing-metropolis', title: '都会を登る',
    artist: 'asset', url: './assets/music/Climbing_the_Metropolis.mp3',
    durationSec: 86.67, tags: ['uplifting', 'urban', 'cheerful'],
  },
  {
    id: 'crossing-intersection', title: '交差点を渡って',
    artist: 'asset', url: './assets/music/Crossing_the_Intersection.mp3',
    durationSec: 58.28, tags: ['urban', 'reflective'],
  },
  {
    id: 'sunlight-through-glass', title: '窓越しの陽射し',
    artist: 'asset', url: './assets/music/Sunlight_Through_Glass.mp3',
    durationSec: 56.29, tags: ['warm', 'calm', 'tender'],
  },
  {
    id: 'sunlight-floorboards', title: '床に差す陽光',
    artist: 'asset', url: './assets/music/Sunlight_on_the_Floorboards.mp3',
    durationSec: 57.78, tags: ['warm', 'nostalgic', 'tender'],
  },
  {
    id: 'sunlight-on-lens', title: 'レンズに差す光',
    artist: 'asset', url: './assets/music/Sunlight_on_the_Lens.mp3',
    durationSec: 57.05, tags: ['warm', 'gentle', 'memorial'],
  },
  {
    id: 'tokyo-afternoon-light', title: '東京の午後の光',
    artist: 'asset', url: './assets/music/Tokyo_Afternoon_Light.mp3',
    durationSec: 57.10, tags: ['urban', 'warm', 'reflective'],
  },
  {
    id: 'kinen', title: '記念',
    artist: 'asset', url: './assets/music/kinen.mp3',
    durationSec: 58.04, tags: ['memorial', 'emotional', 'piano'],
  },
  {
    id: 'quiet-walk-home', title: '静かな帰り道',
    artist: 'asset', url: './assets/music/A_Quiet_Walk_Home.mp3',
    durationSec: 88.89, tags: ['calm', 'nostalgic', 'reflective'],
  },
  {
    id: 'long-walk-home', title: '長い帰り道',
    artist: 'asset', url: './assets/music/The_Long_Walk_Home.mp3',
    durationSec: 89.86, tags: ['nostalgic', 'memorial', 'reflective'],
  },
  {
    id: 'last-corner', title: '最後の角を曲がって',
    artist: 'asset', url: './assets/music/Turning_the_Last_Corner.mp3',
    durationSec: 88.79, tags: ['nostalgic', 'memorial', 'tender'],
  },

  // --- ~150-175s long-form ---
  {
    id: 'final-turn-of-page', title: '最後のページ',
    artist: 'asset', url: './assets/music/The_Final_Turn_of_the_Page.mp3',
    durationSec: 147.93, tags: ['memorial', 'emotional', 'reflective'],
  },
  {
    id: 'turn-of-page', title: 'ページをめくって',
    artist: 'asset', url: './assets/music/The_Turn_of_a_Page.mp3',
    durationSec: 147.77, tags: ['reflective', 'tender', 'piano'],
  },
  {
    id: 'turning-final-page', title: '最後のページをめくる',
    artist: 'asset', url: './assets/music/Turning_the_Final_Page.mp3',
    durationSec: 147.93, tags: ['memorial', 'emotional', 'piano'],
  },
  {
    id: 'climbing-golden-ridge', title: '黄金の尾根',
    artist: 'asset', url: './assets/music/Climbing_the_Golden_Ridge.mp3',
    durationSec: 174.26, tags: ['uplifting', 'adventure', 'cheerful'],
  },
  {
    id: 'where-path-bends', title: '道の曲がり角で',
    artist: 'asset', url: './assets/music/Where_the_Path_Bends.mp3',
    durationSec: 175.44, tags: ['reflective', 'memorial', 'emotional'],
  },
];
