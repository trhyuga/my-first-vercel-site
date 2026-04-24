// Built-in BGM catalog. Tracks with kind:'synth' are generated procedurally
// at render time (Web Audio chord pad + arpeggio) — no external CDN, works
// offline, ships with the page. URLs would need a verified CDN and CORS
// support; we don't fabricate any here.
//
// Each entry:
//   id, title, artist, kind ('synth'), preset (key into SYNTH_PRESETS),
//   durationSec (target running time before the master fade-out),
//   tags (mood keywords for auto-pick).

window.MUSIC_CATALOG = [
  {
    id: 'warm-memories',
    title: '温かい思い出',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'warm',
    durationSec: 90,
    tags: ['warm', 'memorial', 'emotional', 'piano'],
  },
  {
    id: 'reflective',
    title: '静かな振り返り',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'memorial',
    durationSec: 110,
    tags: ['memorial', 'calm', 'reflective', 'piano'],
  },
  {
    id: 'nostalgic-evening',
    title: 'なつかしい夕方',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'nostalgic',
    durationSec: 90,
    tags: ['nostalgic', 'tender', 'calm', 'emotional'],
  },
  {
    id: 'bright-day',
    title: '晴れた一日',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'bright',
    durationSec: 60,
    tags: ['uplifting', 'cheerful', 'happy', 'bright'],
  },
  {
    id: 'gentle-pad',
    title: 'やさしいパッド',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'gentle',
    durationSec: 75,
    tags: ['calm', 'tender', 'ambient'],
  },
  {
    id: 'short-warm',
    title: '短編・温かい',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'warm',
    durationSec: 30,
    tags: ['warm', 'memorial', 'short'],
  },
  {
    id: 'short-bright',
    title: '短編・はずむ',
    artist: '内蔵シンセ',
    kind: 'synth',
    preset: 'bright',
    durationSec: 24,
    tags: ['uplifting', 'happy', 'short'],
  },
];
