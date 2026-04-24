// Curated royalty-free BGM catalog for the memory-video tool.
//
// Each entry:
//   {
//     id:           string  stable identifier (kebab-case)
//     title:        string  display title
//     artist:       string  composer / artist
//     url:          string  direct mp3/ogg/m4a URL — MUST be CORS-enabled
//                           so the AudioContext can decode and MediaRecorder
//                           can capture the stream.
//     license:      string  short license note (e.g. "Pixabay Content License")
//     source:       string  origin site
//     durationSec:  number  total track length in seconds
//     endCueSec:    number? optional — seconds where the track reaches a
//                           natural musical close (final cadence / resolved
//                           tail). The exporter tries to land the last clip
//                           on this point. If omitted, the exporter fades
//                           out instead.
//     tags:         string[] mood keywords: "memorial" "emotional" "piano"
//                            "calm" "uplifting" "family" "warm" etc.
//   }
//
// The catalog ships empty on purpose — I won't fabricate third-party URLs.
// Populate this list with tracks you personally verified (Pixabay Music's
// CC-friendly catalog, Internet Archive's CC0 collection, etc.), then the
// "推奨BGM" option becomes available automatically in the UI.
//
// Example (replace with a real verified URL):
// window.MUSIC_CATALOG = [
//   {
//     id: 'warm-piano-01',
//     title: 'Warm Piano Reflection',
//     artist: 'Unknown Artist',
//     url: 'https://example.com/path/to/track.mp3',
//     license: 'Pixabay Content License',
//     source: 'Pixabay',
//     durationSec: 138,
//     endCueSec: 132,
//     tags: ['piano', 'memorial', 'warm'],
//   },
// ];

window.MUSIC_CATALOG = [];
