'use strict';

// =============================================================================
// Memories — photo-to-video generator.
//
// Builds up in phases:
//   Step 1 (current): import → EXIF → HEIC decode → blur filter → thumbnail grid
//   Step 2: face-api quality scoring (smile + eyes open)
//   Step 3: dHash similarity grouping → best-of-group selection
//   Step 4: GPS clustering + timeline build + mode selection
//   Step 5: renderer (canvas Ken-Burns + blur-fill for aspect mismatch)
//   Step 6: audio + MediaRecorder export
// =============================================================================

const BLUR_REJECT_THRESHOLD = 60;        // Laplacian variance below this → blurry
const DARK_LUMA_THRESHOLD = 22;          // mean luminance (0-255) below = pocket/lens-cap
const FLAT_VARIANCE_THRESHOLD = 30;      // luminance variance below = nearly uniform (no content)
const VIDEO_MIN_DURATION_SEC = 1.5;      // shorter clips are likely accidental
const VIDEO_LONG_THRESHOLD_SEC = 60;     // longer videos skip frame analysis (seeking is slow)
const DHASH_HAMMING_THRESHOLD = 10;      // 0-64; lower = stricter similarity
const DEDUP_TIME_WINDOW_MS = 90 * 1000;  // similar shots must be < 90s apart
const GPS_CLUSTER_RADIUS_M = 200;        // photos closer than this merge into one cluster
const TITLE_CARD_SEC = 3.5;
const CLOSER_CARD_SEC = 2.5;
const PHOTO_MIN_SEC = 1.5;
const PHOTO_MAX_SEC = 6.0;
const PHOTO_DEFAULT_SEC = 3.0;
const XFADE_SEC = 0.5;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  photos: [],   // all decoded inputs (photos + videos), chronological
  groups: [],   // similarity groups [[photo,...], ...] (same chronology)
  loading: false,
  // The track that the most recent preview / autoPickBgmTrack actually
  // played; populateSettingsFromPlan reads this to commit '__auto__' →
  // explicit selection in the settings panel.
  lastUsedTrack: null,
};

// -----------------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------------
const dom = {
  dz: document.getElementById('dz'),
  fi: document.getElementById('fi'),
  loadProg: document.getElementById('loadProg'),
  loadProgText: document.getElementById('loadProgText'),
  loadProgBar: document.getElementById('loadProgBar'),
  reviewPanel: document.getElementById('reviewPanel'),
  reviewStats: document.getElementById('reviewStats'),
  settingsPanel: document.getElementById('settingsPanel'),
  modeGroup: document.getElementById('modeGroup'),
  countField: document.getElementById('countField'),
  secondsField: document.getElementById('secondsField'),
  bgmGroup: document.getElementById('bgmGroup'),
  catalogField: document.getElementById('catalogField'),
  catalogSelect: document.getElementById('catalogSelect'),
  catalogHint: document.getElementById('catalogHint'),
  uploadField: document.getElementById('uploadField'),
  bgmFile: document.getElementById('bgmFile'),
  previewBtn: document.getElementById('previewBtn'),
  exportBtn: document.getElementById('exportBtn'),
  stagePanel: document.getElementById('stagePanel'),
  stage: document.getElementById('stage'),
  stageOverlay: document.getElementById('stageOverlay'),
  stageStatus: document.getElementById('stageStatus'),
  renderProg: document.getElementById('renderProg'),
  renderProgText: document.getElementById('renderProgText'),
  renderProgBar: document.getElementById('renderProgBar'),
  output: document.getElementById('output'),
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function setLoadProgress(pct, text) {
  dom.loadProg.style.display = 'flex';
  dom.loadProgText.textContent = text;
  dom.loadProgBar.style.width = Math.round(pct) + '%';
}
function hideLoadProgress() {
  dom.loadProg.style.display = 'none';
}
// Wraps a promise with a timeout. Rejects with a descriptive error so a
// stuck file (HEIC decode hang, video that never fires loadedmetadata,
// network-stuck face-api weights, etc.) gets skipped instead of freezing
// the whole pipeline.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`タイムアウト (${label}, ${ms}ms)`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function fmtDate(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}
function nextId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}
function isHeic(file) {
  return /\.(heic|heif)$/i.test(file.name) ||
         file.type === 'image/heic' || file.type === 'image/heif' ||
         // some iOS exports come through with blank type
         (!file.type && /\.hei[cf]$/i.test(file.name));
}

// -----------------------------------------------------------------------------
// HEIC → JPEG (lazy — heic2any is large). Output is downscaled to bound the
// total RAM footprint: original 12-MP HEIC decodes to ~5 MB JPEG; on a
// 90-photo upload that's ~450 MB sitting in memory until the user finishes,
// which OOMs iOS Safari. 1800-px long side keeps export quality fine for
// 1080p output (~1.4× = 1512 px) at ~500 KB per photo.
// -----------------------------------------------------------------------------
const HEIC_OUT_MAX_DIM = 1800;

async function downsampleJpegBlob(blob, maxDim, quality = 0.88) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) <= maxDim) return blob;
    const scale = maxDim / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, cw, ch);
    return await new Promise((res, rej) => {
      c.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', quality);
    });
  } finally {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
}

async function decodableBlob(file) {
  if (!isHeic(file)) return file;
  if (typeof heic2any !== 'function') {
    throw new Error('HEIC変換ライブラリが読み込めませんでした (オフライン?)');
  }
  const raw = await withTimeout(
    heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }),
    20000,
    'HEIC ' + file.name);
  const heicJpeg = Array.isArray(raw) ? raw[0] : raw;
  // Downscale the heic2any output before we hand it back. Downstream code
  // keeps the returned blob alive (state.photos[i].decodedBlob) until the
  // user re-ingests, so this is the place to bound the memory cost.
  try {
    return await downsampleJpegBlob(heicJpeg, HEIC_OUT_MAX_DIM, 0.88);
  } catch (e) {
    // If downsample fails, fall back to the full-size blob (functional but
    // RAM-hungry). Better to render than to crash here.
    console.warn('HEIC downsample failed, keeping full size', e);
    return heicJpeg;
  }
}

// -----------------------------------------------------------------------------
// Decode to <img> and build small thumbnail canvas
// -----------------------------------------------------------------------------
async function decodeToImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return { img, url };
}

function downscaleToCanvas(img, maxDim) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// -----------------------------------------------------------------------------
// Blur detection — Laplacian variance on a centre crop of a downscaled copy.
// Higher variance = sharper edges = not blurry.
// The threshold BLUR_REJECT_THRESHOLD is empirical; tuned for 256px-long-edge
// downscaled greyscale. It'll be conservative enough to keep reasonable photos
// while catching obvious hand-shake shots.
// -----------------------------------------------------------------------------
// Mean + variance of luminance — used to spot lens-cap / pocket / blank-wall
// shots that should be rejected even when sharp.
function frameLumaStats(canvas) {
  const w = canvas.width, h = canvas.height;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  const mean = sum / n;
  return { mean, variance: sumSq / n - mean * mean };
}

// Build the "this photo/frame is unusable" reason, or null if acceptable.
function rejectionReason({ blurScore, lumaMean, lumaVar, durationSec, hasVideoStream }) {
  if (hasVideoStream === false) return '映像トラックなし';
  if (durationSec !== undefined && durationSec < VIDEO_MIN_DURATION_SEC) {
    return `短すぎ (${durationSec.toFixed(1)}s)`;
  }
  if (lumaMean < DARK_LUMA_THRESHOLD) return '暗すぎ (レンズカバー / ポケット撮影?)';
  if (lumaVar < FLAT_VARIANCE_THRESHOLD) return 'ほぼ単色 (内容なし?)';
  if (blurScore < BLUR_REJECT_THRESHOLD) return `ブレ (鮮明度 ${blurScore.toFixed(0)})`;
  return null;
}

function laplacianVariance(canvas) {
  const w = canvas.width, h = canvas.height;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let sum = 0, sum2 = 0, n = 0;
  // Avoid the 8-pixel border — cameras sometimes stamp sharp EXIF info there
  // which would skew the variance upward on any photo.
  for (let y = 8; y < h - 8; y++) {
    for (let x = 8; x < w - 8; x++) {
      const i = y * w + x;
      const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w];
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// -----------------------------------------------------------------------------
// Perceptual hash (dHash) — used to detect bursts / near-duplicate shots.
// 9x8 → 64 bits packed into two uint32 lanes for fast XOR + popcount.
// -----------------------------------------------------------------------------
function computeDHash(srcCanvas) {
  const TW = 9, TH = 8;
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  const cx = c.getContext('2d');
  cx.drawImage(srcCanvas, 0, 0, TW, TH);
  const data = cx.getImageData(0, 0, TW, TH).data;
  const gray = new Float32Array(TW * TH);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let lo = 0, hi = 0, bit = 0;
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW - 1; x++) {
      if (gray[y * TW + x] > gray[y * TW + x + 1]) {
        if (bit < 32) lo |= (1 << bit);
        else hi |= (1 << (bit - 32));
      }
      bit++;
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

function hammingDistance(a, b) {
  if (!a || !b) return 64;
  return popcount32(a.lo ^ b.lo) + popcount32(a.hi ^ b.hi);
}

// -----------------------------------------------------------------------------
// face-api.js — laze-loads weights from jsDelivr GitHub mirror.
// Score per photo is the *best* face's combined smile + eyes-open quality.
// -----------------------------------------------------------------------------
let faceApiPromise = null;
async function ensureFaceApi() {
  if (faceApiPromise) return faceApiPromise;
  if (typeof faceapi === 'undefined') {
    return Promise.reject(new Error('face-api.js library not loaded'));
  }
  const base = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
  faceApiPromise = (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(base);
    await faceapi.nets.faceLandmark68Net.loadFromUri(base);
    await faceapi.nets.faceExpressionNet.loadFromUri(base);
  })();
  return faceApiPromise;
}

function eyeAspectRatio(eye) {
  // Standard EAR: ratio of eye height to width. >0.22 ≈ open, <0.15 ≈ closed.
  const dy1 = Math.hypot(eye[1].x - eye[5].x, eye[1].y - eye[5].y);
  const dy2 = Math.hypot(eye[2].x - eye[4].x, eye[2].y - eye[4].y);
  const dx = Math.hypot(eye[0].x - eye[3].x, eye[0].y - eye[3].y);
  return (dy1 + dy2) / (2 * dx + 1e-6);
}

async function scoreFacesIn(canvas) {
  let detections;
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
    detections = await faceapi
      .detectAllFaces(canvas, opts)
      .withFaceLandmarks()
      .withFaceExpressions();
  } catch (_) {
    return { hasFaces: false, faceCount: 0, faceScore: 0, focalPoint: null };
  }
  if (!detections || !detections.length) {
    return { hasFaces: false, faceCount: 0, faceScore: 0, focalPoint: null };
  }
  let best = -Infinity, bestBox = null;
  for (const d of detections) {
    const exp = d.expressions || {};
    const happy = exp.happy || 0;
    const surprised = exp.surprised || 0;
    const neutral = exp.neutral || 0;
    const sad = exp.sad || 0;
    const fearful = exp.fearful || 0;
    const disgusted = exp.disgusted || 0;
    const angry = exp.angry || 0;
    const lm = d.landmarks;
    const ear = (eyeAspectRatio(lm.getLeftEye()) + eyeAspectRatio(lm.getRightEye())) / 2;
    const eyesOpen = Math.min(1, Math.max(0, (ear - 0.10) / 0.15));
    // Face is great if happy + eyes-open. Closed eyes / negative emotions hurt.
    const score =
        happy * 1.2
      + surprised * 0.25
      + neutral * 0.10
      - sad * 0.5
      - fearful * 0.4
      - disgusted * 0.5
      - angry * 0.5
      + eyesOpen * 0.5
      - (1 - eyesOpen) * 0.7;
    if (score > best) {
      best = score;
      bestBox = d.detection ? d.detection.box : null;
    }
  }
  let focalPoint = null;
  if (bestBox && canvas.width && canvas.height) {
    focalPoint = {
      x: Math.max(0.15, Math.min(0.85, (bestBox.x + bestBox.width / 2) / canvas.width)),
      y: Math.max(0.18, Math.min(0.82, (bestBox.y + bestBox.height / 2) / canvas.height)),
    };
  }
  return { hasFaces: true, faceCount: detections.length, faceScore: best, focalPoint };
}

// -----------------------------------------------------------------------------
// EXIF
// -----------------------------------------------------------------------------
async function parseExifSafe(blob) {
  try {
    return await exifr.parse(blob, {
      tiff: true,
      exif: true,
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'latitude', 'longitude'],
    });
  } catch (_) {
    return null;
  }
}
function exifTimestamp(exif, file) {
  const dt = exif && (exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate);
  if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
    return { ts: dt.getTime(), source: 'exif' };
  }
  // Fallback — file.lastModified is often the download/copy time, but better
  // than nothing. Mark its source so we can badge it in the UI.
  return { ts: file.lastModified || Date.now(), source: 'mtime' };
}
function exifGps(exif) {
  if (!exif) return null;
  const { latitude, longitude } = exif;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!isFinite(latitude) || !isFinite(longitude)) return null;
  return { lat: latitude, lng: longitude };
}

// -----------------------------------------------------------------------------
// Thumbnail data URL (small — for UI grid only)
// -----------------------------------------------------------------------------
function thumbDataUrl(img, maxSide = 220) {
  const c = downscaleToCanvas(img, maxSide);
  return c.toDataURL('image/jpeg', 0.8);
}

// -----------------------------------------------------------------------------
// Video helpers
// -----------------------------------------------------------------------------
function isVideo(file) {
  return (file.type && file.type.startsWith('video/')) ||
         /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
}

// Tear down a transient &lt;video&gt; element so its decoder slot is released
// — iOS Safari throttles after ~16 simultaneous video elements per page,
// so we don't want long ingest sessions piling decoders even briefly.
function teardownVideoElement(v) {
  try { v.pause(); } catch (_) {}
  try { v.removeAttribute('src'); v.load(); } catch (_) {}
}

function loadVideoMetadata(url) {
  return withTimeout(new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.src = url;
    const cleanup = () => teardownVideoElement(v);
    v.addEventListener('loadedmetadata', () => {
      const meta = {
        durationSec: isFinite(v.duration) ? v.duration : 0,
        width: v.videoWidth,
        height: v.videoHeight,
      };
      cleanup();
      resolve(meta);
    }, { once: true });
    v.addEventListener('error', () => {
      cleanup();
      reject(new Error('動画メタデータの読み込みに失敗しました'));
    }, { once: true });
  }), 10000, 'video metadata');
}

function extractVideoFrameAt(url, atSec, durationSec) {
  return withTimeout(new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.src = url;
    let done = false;
    const finish = (val) => {
      if (!done) { done = true; teardownVideoElement(v); resolve(val); }
    };
    const fail = (err) => {
      if (!done) { done = true; teardownVideoElement(v); reject(err); }
    };
    v.addEventListener('loadedmetadata', () => {
      const max = (durationSec || v.duration || 0.1) - 0.05;
      v.currentTime = Math.max(0, Math.min(max, atSec));
    }, { once: true });
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      try {
        c.getContext('2d').drawImage(v, 0, 0);
      } catch (e) {
        return fail(e);
      }
      c.toBlob((blob) => {
        if (!blob) return fail(new Error('フレーム書き出し失敗'));
        const imgUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          // Image keeps the bitmap data; the URL itself is no longer needed.
          try { URL.revokeObjectURL(imgUrl); } catch (_) {}
          finish(img);
        };
        img.onerror = () => {
          try { URL.revokeObjectURL(imgUrl); } catch (_) {}
          fail(new Error('frame conversion failed'));
        };
        img.src = imgUrl;
      }, 'image/jpeg', 0.9);
    }, { once: true });
    v.addEventListener('error', () => fail(new Error('動画フレームの抽出に失敗しました')), { once: true });
  }), 12000, 'video frame extract');
}

// Read the video's true creation_time via mp4box (mvhd box). Falls back to
// null when the lib isn't loaded, the file isn't an MP4 container, or the
// embedded date is the Apple zero-epoch (1904-01-01) which means "unset".
// Significantly more accurate than file.lastModified for clips that have
// been forwarded through messaging apps.
// Stream the MP4 in 256KB chunks instead of loading the entire file into
// RAM. mvhd/moov is usually within the first few MB even for "moov-at-end"
// recordings (iPhone exports moov-at-front by default). Stops as soon as
// onReady fires.
async function tryParseMp4Creation(file) {
  if (typeof MP4Box === 'undefined') return null;
  if (!file || !/(mp4|mov|m4v)$/i.test(file.name)) return null;
  return await withTimeout(new Promise((resolve) => {
    const mp4 = MP4Box.createFile();
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    mp4.onReady = (info) => {
      if (info && info.created instanceof Date) {
        const ms = info.created.getTime();
        if (ms > 631152000000) finish(ms);
        else finish(null);
      } else finish(null);
    };
    mp4.onError = () => finish(null);
    const CHUNK = 256 * 1024;
    let offset = 0;
    const total = file.size;
    const pump = async () => {
      try {
        while (!done && offset < total) {
          const slice = file.slice(offset, Math.min(total, offset + CHUNK));
          const ab = await slice.arrayBuffer();
          ab.fileStart = offset;
          const next = mp4.appendBuffer(ab);
          offset = next || (offset + ab.byteLength);
          // Yield to the event loop so onReady can fire.
          await new Promise(r => setTimeout(r, 0));
          // Cap at first ~32MB to avoid pathological moov-at-end seeks.
          if (offset > 32 * 1024 * 1024) break;
        }
        if (!done) {
          mp4.flush();
          // Last chance for onReady; fall through to null otherwise.
          setTimeout(() => finish(null), 100);
        }
      } catch (_) { finish(null); }
    };
    pump();
  }), 8000, 'mp4 metadata');
}

// -----------------------------------------------------------------------------
// Per-file processing — routes to image or video pipeline.
// -----------------------------------------------------------------------------
async function processFile(file) {
  if (isVideo(file)) return processVideo(file);
  return processImage(file);
}

async function processImage(file) {
  const decoded = await decodableBlob(file);
  const { img, url } = await decodeToImage(decoded);
  const exif = await parseExifSafe(decoded);
  const { ts, source: tsSource } = exifTimestamp(exif, file);
  const gps = exifGps(exif);

  const thumb = thumbDataUrl(img, 220);
  const analysisCanvas = downscaleToCanvas(img, 256);
  const blurScore = laplacianVariance(analysisCanvas);
  const { mean: lumaMean, variance: lumaVar } = frameLumaStats(analysisCanvas);
  const dHash = computeDHash(analysisCanvas);

  // Face quality on a slightly larger canvas — TinyFaceDetector struggles
  // below ~480px when faces are small in the frame.
  const faceCanvas = downscaleToCanvas(img, 512);
  const face = await scoreFacesIn(faceCanvas);

  const w = img.naturalWidth, h = img.naturalHeight;
  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');

  const badReason = rejectionReason({ blurScore, lumaMean, lumaVar });
  const bad = !!badReason;
  // Photos that won't make the cut don't need the full-size object URL kept
  // around for the renderer — release it immediately to free RAM.
  if (bad) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }

  return {
    id: nextId(),
    file,
    sourceName: file.name,
    mime: decoded.type || file.type,
    kind: 'photo',
    decodedBlob: decoded,
    objectUrl: bad ? null : url,
    thumbUrl: thumb,
    width: w,
    height: h,
    orientation,
    ts,
    tsSource,
    gps,
    blurScore,
    dHash,
    hasFaces: face.hasFaces,
    faceCount: face.faceCount,
    faceScore: face.faceScore,
    focalPoint: face.focalPoint,
    bad,
    badReason,
  };
}

async function processVideo(file) {
  const url = URL.createObjectURL(file);
  const meta = await loadVideoMetadata(url);
  const dur = meta.durationSec || 0;
  const w = meta.width || 0;
  const h = meta.height || 0;
  const hasVideoStream = w > 0 && h > 0;

  // Simple heuristic: skip the (often unsteady) intro and treat ~30% in as
  // the highlight start. Audio-RMS analysis and face-api.js were dropped
  // here because they made long-video ingest unbearably slow for marginal
  // benefit; videos already always live in their own solo group.
  const highlightStartSec = Math.max(0, dur * 0.30);

  // For long videos, skip the seek+draw entirely — seeking deep into a long
  // file can stall ingest by several seconds. Pre-fill values so the rejection
  // checks pass naturally; long clips are usually intentional event recordings.
  // For zero-content / corrupt videos, also skip.
  let blurScore = 100, lumaMean = 128, lumaVar = 1000, thumb = '';
  let analysisSkipped = false;
  if (hasVideoStream && dur > 0.2 && dur < VIDEO_LONG_THRESHOLD_SEC) {
    try {
      const frameAt = Math.max(0, Math.min(dur - 0.1, highlightStartSec + 0.4));
      const img = await extractVideoFrameAt(url, frameAt, dur);
      thumb = thumbDataUrl(img, 220);
      const analysisCanvas = downscaleToCanvas(img, 256);
      blurScore = laplacianVariance(analysisCanvas);
      const stats = frameLumaStats(analysisCanvas);
      lumaMean = stats.mean;
      lumaVar = stats.variance;
    } catch (e) {
      // Seek/draw failure shouldn't kill the whole video — let it through.
      analysisSkipped = true;
    }
  } else if (dur >= VIDEO_LONG_THRESHOLD_SEC) {
    analysisSkipped = true;
  }

  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');
  // Prefer mp4box-extracted creation_time over file.lastModified when
  // available — survives forwarding through Messages / LINE / etc.
  const mp4Ts = await tryParseMp4Creation(file).catch(() => null);
  const ts = mp4Ts || file.lastModified || Date.now();
  const tsSource = mp4Ts ? 'mp4-creation' : 'mtime';
  const badReason = rejectionReason({
    blurScore, lumaMean, lumaVar,
    durationSec: dur,
    hasVideoStream,
  });
  const bad = !!badReason;
  // Same logic as processImage — rejected videos don't need their playable
  // object URL kept around.
  if (bad) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }

  return {
    id: nextId(),
    file,
    sourceName: file.name,
    mime: file.type || 'video/mp4',
    kind: 'video',
    decodedBlob: file,
    objectUrl: bad ? null : url,
    thumbUrl: thumb,
    width: w,
    height: h,
    orientation,
    ts,
    tsSource,
    gps: null,
    blurScore,
    dHash: null,
    hasFaces: false,
    faceCount: 0,
    faceScore: 0,
    bad,
    badReason,
    // video-specific
    durationSec: dur,
    highlightStartSec,
    highlightSource: 'heuristic',
    analysisSkipped,
  };
}

// -----------------------------------------------------------------------------
// Similarity grouping + best-of-group selection
// -----------------------------------------------------------------------------
function groupSimilarPhotos(photos) {
  // Adaptive thresholds based on upload size. With few photos every shot
  // matters, so we keep them all (no merging). With a big dump we tighten
  // to be more aggressive about pulling near-duplicates into one rep.
  //   ≤12 photos: no dedup at all
  //   13-30:      hamming ≤ 12, time window 150s
  //   31-80:      hamming ≤ 16, time window 300s
  //   >80:        hamming ≤ 18, time window 600s
  const total = photos.filter(p => p.kind !== 'video').length;
  let hammingMax, timeWindow;
  if (total <= 12)      { hammingMax = -1;  timeWindow = 0;       }
  else if (total <= 30) { hammingMax = 12;  timeWindow = 150_000; }
  else if (total <= 80) { hammingMax = 16;  timeWindow = 300_000; }
  else                  { hammingMax = 18;  timeWindow = 600_000; }

  const groups = [];
  for (const p of photos) {
    if (p.kind === 'video' || !p.dHash || hammingMax < 0) {
      groups.push([p]);
      continue;
    }
    let placed = false;
    for (const g of groups) {
      const head = g[0];
      if (head.kind === 'video' || !head.dHash) continue;
      if (Math.abs(p.ts - head.ts) > timeWindow) continue;
      if (hammingDistance(head.dHash, p.dHash) <= hammingMax) {
        g.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([p]);
  }
  for (const g of groups) g.sort((a, b) => a.ts - b.ts);
  groups.sort((a, b) => a[0].ts - b[0].ts);
  return groups;
}

function pickBestOfGroup(group, prefOrientation) {
  if (group.length === 1) return group[0];
  let best = group[0], bestScore = -Infinity;
  for (const p of group) {
    let score = 0;
    if (p.bad) score -= 5;             // blurry photos demoted hard
    if (p.faceScore !== undefined) score += p.faceScore * 1.4;
    score += Math.log10(Math.max(1, p.blurScore)) * 0.5;
    if (p.orientation === prefOrientation) score += 0.6;
    else if (p.orientation === 'square') score += 0.1;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function getOutputOrientation() {
  const sel = document.getElementById('orientation');
  if (!sel) return 'portrait';
  const v = sel.value;
  return v === 'landscape' || v === 'square' ? v : 'portrait';
}

// -----------------------------------------------------------------------------
// GPS clustering + landmark name resolution
// -----------------------------------------------------------------------------
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(φ1) * Math.cos(φ2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function clusterByGps(items, radiusM = GPS_CLUSTER_RADIUS_M) {
  // Greedy clustering with running centroid. Items missing GPS are kept apart
  // (each becomes its own singleton "no-gps" cluster) so they interleave by
  // time without forcing them to merge with anyone.
  const clusters = [];
  let noGpsCounter = 0;
  for (const p of items) {
    if (!p.gps) {
      clusters.push({
        id: `nogps_${noGpsCounter++}`,
        lat: null, lng: null,
        items: [p],
        landmark: null,
        label: null,
        hasGps: false,
      });
      continue;
    }
    let placed = null, placedDist = Infinity;
    for (const c of clusters) {
      if (!c.hasGps) continue;
      const d = haversineMeters(c, p.gps);
      if (d <= radiusM && d < placedDist) {
        placed = c; placedDist = d;
      }
    }
    if (placed) {
      placed.items.push(p);
      const n = placed.items.length;
      placed.lat = (placed.lat * (n - 1) + p.gps.lat) / n;
      placed.lng = (placed.lng * (n - 1) + p.gps.lng) / n;
    } else {
      clusters.push({
        id: `gps_${clusters.length}`,
        lat: p.gps.lat, lng: p.gps.lng,
        items: [p],
        landmark: null,
        label: null,
        hasGps: true,
      });
    }
  }
  return clusters;
}

function resolveLandmark(cluster) {
  if (!cluster.hasGps) return null;
  const list = window.LANDMARKS || [];
  let best = null, bestSlack = Infinity;
  for (const lm of list) {
    const d = haversineMeters({ lat: cluster.lat, lng: cluster.lng }, { lat: lm.lat, lng: lm.lng });
    if (d <= lm.radius) {
      // Prefer the landmark whose radius is *most* exceeded (i.e. clearest match).
      const slack = lm.radius - d;
      if (slack < bestSlack) { bestSlack = slack; best = lm; }
    }
  }
  return best;
}

// Allow Japanese (kana/kanji/CJK punctuation) + ASCII Latin. Anything else
// (Hangul, Thai, Arabic, Cyrillic, …) gets rejected so the title stays in
// the script the user can read.
const JA_LATIN_RE = /^[ -~　-〿぀-ゟ゠-ヿ一-鿿㐀-䶿＀-￯\s·・「」『』〜～\-—–'']+$/;
function isJaOrLatin(s) {
  if (!s) return false;
  return JA_LATIN_RE.test(s);
}

// Soft fallback when a cluster doesn't match any curated landmark. Throttled
// to one request per ~1.1s as Nominatim's usage policy requires; failures are
// silent. Tries `ja` first; if any field comes back in a non-ja/latin script,
// re-queries with `en` and merges (preferring ja when both are usable).
async function tryFetchNominatim(lat, lng, lang) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=${lang}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address || {};
    const nameCandidates = [
      a.tourism, a.attraction, a.amusement_park,
      a.suburb, a.neighbourhood,
      a.city_district, a.town, a.village, a.city,
      a.county,
    ].filter(Boolean);
    return {
      name: nameCandidates[0] || data.display_name || null,
      country: a.country || null,
      countryCode: a.country_code || null,
      state: stripPrefectureSuffix(a.state || a.province || null),
    };
  } catch (_) { return null; }
}

function allFieldsJaOrLatin(r) {
  if (!r) return false;
  return [r.name, r.country, r.state].filter(Boolean).every(isJaOrLatin);
}
function mergePreferJa(ja, en) {
  if (!ja) return en || null;
  if (!en) return ja;
  return {
    name: isJaOrLatin(ja.name) ? ja.name : en.name,
    country: isJaOrLatin(ja.country) ? ja.country : en.country,
    countryCode: ja.countryCode || en.countryCode,
    state: isJaOrLatin(ja.state) ? ja.state : en.state,
  };
}

let nominatimQueue = Promise.resolve();
function reverseGeocodeNominatim(lat, lng) {
  const job = nominatimQueue.then(async () => {
    const ja = await tryFetchNominatim(lat, lng, 'ja');
    if (allFieldsJaOrLatin(ja)) return ja;
    // ja result has Hangul/Thai/etc. → also fetch en and merge
    const en = await tryFetchNominatim(lat, lng, 'en');
    return mergePreferJa(ja, en);
  });
  // 2.2s spacing covers the ja+en pair within Nominatim's 1 req/sec rule.
  nominatimQueue = job.then(() => new Promise(r => setTimeout(r, 2200)));
  return job;
}

// Strips Japanese prefecture suffixes from a state name so titles read
// cleanly: "京都府" → "京都", "東京都" → "東京", "宮城県" → "宮城".
// 北海道 is a single irreducible name (its 道 suffix is part of the name,
// not a removable prefecture marker like 府/都/県), so it's left alone.
function stripPrefectureSuffix(s) {
  if (!s) return s;
  if (s === '北海道' || /北海道$/.test(s)) return '北海道';
  return s.replace(/\s*Prefecture\s*$/i, '').replace(/(府|都|県)$/, '');
}

// Quick country guess for clusters matched by the curated landmark dictionary
// (which doesn't carry country info itself). Most landmarks are JP-domestic;
// the worldwide entries we hardcoded fall in known coordinate boxes.
function guessCountryFromCoords(lat, lng) {
  if (lat > 23 && lat < 46 && lng > 122 && lng < 147) return { country: '日本', cc: 'jp' };
  if (lat > 24 && lat < 49 && lng > -125 && lng < -66) return { country: 'United States', cc: 'us' };
  // Italy first — France's box would otherwise capture the Alps stretch
  // (lat 45-47, lng 6-10) that's actually Italian territory. Italy is the
  // tighter match by latitude; France grabs the rest west of lng 6.
  if (lat > 36 && lat < 47 && lng > 6 && lng < 19) return { country: 'Italy', cc: 'it' };
  if (lat > 41 && lat < 51 && lng > -5 && lng < 6) return { country: 'France', cc: 'fr' };
  if (lat > 49 && lat < 60 && lng > -8 && lng < 2) return { country: 'United Kingdom', cc: 'gb' };
  if (lat > 21 && lat < 23 && lng > 113 && lng < 115) return { country: '香港', cc: 'hk' };
  if (lat > 30 && lat < 32 && lng > 121 && lng < 122) return { country: '中国', cc: 'cn' };
  if (lat > 21 && lat < 26 && lng > 119 && lng < 122) return { country: '台湾', cc: 'tw' };
  if (lat < -10 && lng > 110 && lng < 155) return { country: 'Australia', cc: 'au' };
  if (lat < -3 && lat > -25 && lng > -85 && lng < -30) return { country: 'Peru', cc: 'pe' };
  return null;
}

async function nameClusters(clusters, useNominatim = true) {
  // Pass 1: landmark dictionary (instant)
  for (const c of clusters) {
    const lm = resolveLandmark(c);
    if (lm) {
      c.landmark = lm;
      c.label = lm.short || lm.name;
      const guess = guessCountryFromCoords(c.lat, c.lng);
      if (guess) {
        c.country = guess.country;
        c.countryCode = guess.cc;
      }
    }
  }
  // Pass 2: Nominatim reverse-geocode for unmatched clusters with GPS, also
  // pulls country + state for clusters that already had a landmark name.
  if (useNominatim) {
    const pending = clusters.filter(c => c.hasGps && (!c.label || !c.country || !c.state));
    for (const c of pending) {
      const r = await reverseGeocodeNominatim(c.lat, c.lng);
      if (!r) continue;
      if (!c.label && r.name) c.label = r.name;
      if (!c.country && r.country) c.country = r.country;
      if (!c.countryCode && r.countryCode) c.countryCode = r.countryCode;
      if (!c.state && r.state) c.state = r.state;
    }
  }
  // Pass 3: generic fallback for unnamed GPS clusters. Only increment the
  // alphabet for clusters we actually label so the visible sequence is
  // always A, B, C, ... (no gaps from skipped no-GPS clusters).
  let alpha = 0;
  for (const c of clusters) {
    if (!c.label && c.hasGps) {
      c.label = `エリア ${String.fromCharCode(65 + alpha)}`;
      alpha++;
    }
  }
}

// "2024年12月" / "2024年12月 – 2025年1月" — high-level period label for the
// title card. More forgiving than the chapter date format which uses
// specific days (we want the title to stay short and readable).
function fmtTitleYearMonth(timestamps) {
  const ymonths = [...new Set(timestamps.map(ts => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }))].sort();
  if (!ymonths.length) return '';
  const fmt = (s) => {
    const [y, m] = s.split('-');
    return `${y}年${parseInt(m, 10)}月`;
  };
  if (ymonths.length === 1) return fmt(ymonths[0]);
  // Multi-month span: omit the year on the back end when both months
  // share a year ("2024年8月 – 9月"). Cross-year ranges keep both years
  // ("2024年12月 – 2025年1月").
  const [y1, m1] = ymonths[0].split('-');
  const [y2, m2] = ymonths[ymonths.length - 1].split('-');
  if (y1 === y2) return `${y1}年${parseInt(m1, 10)}月 – ${parseInt(m2, 10)}月`;
  return `${fmt(ymonths[0])} – ${fmt(ymonths[ymonths.length - 1])}`;
}

// Generates a list of suggested titles based on cluster country/state info
// and the trip's date range. Used to populate the title <select>.
function generateTitleCandidates(clusters, timestamps) {
  const ymd = fmtTitleYearMonth(timestamps);
  const out = new Set();
  const withGps = (clusters || []).filter(c => c.hasGps);
  const countries = [...new Set(withGps.map(c => c.country).filter(Boolean))];
  const prefs = [...new Set(withGps.map(c => c.state).filter(Boolean))];
  const isDomesticJp = countries.length === 1 && (countries[0] === '日本' || countries[0] === 'Japan');

  if (isDomesticJp) {
    if (prefs.length === 1) {
      out.add(`${prefs[0]} ${ymd}`);
      out.add(`${prefs[0]}旅行 ${ymd}`);
    } else if (prefs.length >= 2 && prefs.length <= 3) {
      out.add(`${prefs.join(' · ')} ${ymd}`);
    } else if (prefs.length > 3) {
      out.add(`${prefs.slice(0, 2).join(' · ')} ほか ${ymd}`);
    }
    const lmCluster = withGps.find(c => c.landmark);
    if (lmCluster) out.add(`${lmCluster.landmark.short || lmCluster.landmark.name} ${ymd}`);
  } else if (countries.length === 1) {
    out.add(`${countries[0]} ${ymd}`);
    if (prefs.length === 1) out.add(`${prefs[0]}, ${countries[0]} ${ymd}`);
  } else if (countries.length > 1) {
    out.add(`${countries.slice(0, 3).join(' · ')} ${ymd}`);
    if (countries.length === 2) out.add(`${countries.join(' & ')} ${ymd}`);
  }
  // Generic fallbacks
  out.add(`Memories ${ymd}`);
  out.add(`思い出 ${ymd}`);
  return [...out].filter(Boolean).slice(0, 8);
}

// Picks the "best" auto title from the candidate list (first non-generic).
function pickAutoTitle(candidates) {
  if (!candidates || !candidates.length) return 'Memories';
  for (const c of candidates) {
    if (!/^Memories /.test(c) && !/^思い出 /.test(c)) return c;
  }
  return candidates[0];
}

// -----------------------------------------------------------------------------
// Mode-based selection
// -----------------------------------------------------------------------------
function repScore(p) {
  let s = 0;
  if (p.bad) s -= 5;
  if (p.faceScore !== undefined) s += p.faceScore * 1.4;
  s += Math.log10(Math.max(1, p.blurScore)) * 0.5;
  return s;
}

function diversifyAcrossClusters(reps, n) {
  // Round-robin top-scored picks across clusters so a single dense location
  // doesn't dominate the recommended cut.
  const byCluster = new Map();
  for (const r of reps) {
    const cid = r.clusterId || 'solo';
    if (!byCluster.has(cid)) byCluster.set(cid, []);
    byCluster.get(cid).push(r);
  }
  for (const list of byCluster.values()) list.sort((a, b) => repScore(b) - repScore(a));
  const queues = [...byCluster.values()];
  const picked = [];
  while (picked.length < n) {
    let progress = false;
    for (const q of queues) {
      if (q.length && picked.length < n) {
        picked.push(q.shift());
        progress = true;
      }
    }
    if (!progress) break;
  }
  return picked;
}

function selectByMode(reps, mode, opts) {
  // reps already filtered to non-bad + assigned a clusterId
  const usable = reps.filter(r => !r.bad);
  if (mode === 'all-unique') return usable.slice();
  if (mode === 'recommended') {
    const n = recommendedCount(usable.length, opts);
    return diversifyAcrossClusters(usable, n);
  }
  if (mode === 'count') {
    const n = Math.max(3, Math.min(usable.length, opts.count || 15));
    return diversifyAcrossClusters(usable, n);
  }
  if (mode === 'seconds') {
    // Density-bounded: at least PHOTO_MIN_SEC per slide. Pick top-by-score
    // diversified across clusters.
    const slots = Math.max(3, Math.floor(opts.seconds / PHOTO_MIN_SEC));
    const n = Math.min(usable.length, slots);
    return diversifyAcrossClusters(usable, n);
  }
  return usable.slice();
}

// Adaptive picker for the おすすめ厳選 mode. Considers the upload count and,
// when BGM is set, the song's mood (slow/medium/fast — derived from catalog
// tags) and length so the count matches the music feel.
function recommendedCount(usableCount, opts) {
  if (!usableCount) return 0;
  // User policy: keep at least 80% of what made it through dedup + bad
  // filtering. We may shrink per-photo seconds (planPerPhotoSec clamps to
  // PHOTO_MIN_SEC) but we don't drop content if we don't have to.
  const minKeep = Math.max(4, Math.ceil(usableCount * 0.80));
  if (opts.bgmDurationSec) {
    const tempo = opts.bgmTempo || 'medium';
    const targetPer = tempo === 'fast' ? 2.2 : tempo === 'slow' ? 4.5 : 3.0;
    const body = Math.max(10, opts.bgmDurationSec - TITLE_CARD_SEC - CLOSER_CARD_SEC);
    const desired = Math.round(body / targetPer);
    // BGM-fit pacing OR 80%-floor, whichever keeps more material.
    return Math.max(minKeep, Math.min(usableCount, desired));
  }
  // No BGM — keep almost everything; 80% floor for any size, light cap so
  // 200-photo dumps don't produce 10-minute videos. Cap raised to 120 so
  // 100-photo uploads pass through entirely.
  if (usableCount <= 30) return usableCount;
  return Math.max(minKeep, Math.min(usableCount, 120));
}

// -----------------------------------------------------------------------------
// Timeline construction
// -----------------------------------------------------------------------------
function ymdString(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtJpDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtTitleDateRange(timestamps) {
  const ymds = [...new Set(timestamps.map(ymdString))].sort();
  if (!ymds.length) return '';
  if (ymds.length === 1) {
    const [y, m, d] = ymds[0].split('-');
    return `${y}.${m}.${d}`;
  }
  const [y1, m1, d1] = ymds[0].split('-');
  const [y2, m2, d2] = ymds[ymds.length - 1].split('-');
  if (y1 === y2 && m1 === m2) return `${y1}.${m1}.${d1} – ${d2}`;
  if (y1 === y2) return `${y1}.${m1}.${d1} – ${m2}.${d2}`;
  return `${y1}.${m1}.${d1} – ${y2}.${m2}.${d2}`;
}
function fmtLocationSummary(clusters) {
  const labels = clusters.map(c => c.label).filter(Boolean);
  const u = [...new Set(labels)];
  if (!u.length) return '';
  if (u.length === 1) return u[0];
  if (u.length <= 3) return u.join(' / ');
  return `${u.slice(0, 2).join(' / ')} ほか`;
}

function orderForTimeline(selected, _clusters) {
  // Strict chronological. The user's latest direction was 「日程や時間帯の括り
  // の順で出してくれたらオーケー。画像と動画が順番に入り乱れても問題ない」
  // — so videos slot in by their actual timestamp instead of getting deferred
  // to the end of a same-location cluster's run. Cluster-change still drives
  // the chapter-label overlays inside buildTimeline, so a revisit naturally
  // gets a fresh "📍 location" label.
  return selected.slice().sort((a, b) => a.ts - b.ts);
}

function distinctDays(items) {
  return [...new Set(items.map(p => ymdString(p.ts)))];
}

// Per-photo seconds is fully auto — never user-controlled. Three sources:
//   1. BGM track length / count  (when BGM is set)
//   2. Total seconds / count     (when mode=seconds)
//   3. Density curve from count  (default fallback — fewer photos = linger longer)
function planPerPhotoSec(itemCount, opts) {
  const clamp = (s) => Math.max(PHOTO_MIN_SEC, Math.min(PHOTO_MAX_SEC, s));
  if (opts.bgmDurationSec) {
    const bodyTarget = Math.max(itemCount * PHOTO_MIN_SEC,
                                opts.bgmDurationSec - TITLE_CARD_SEC - CLOSER_CARD_SEC);
    const per = clamp(bodyTarget / itemCount);
    return { perPhotoSec: per, totalSec: TITLE_CARD_SEC + per * itemCount + CLOSER_CARD_SEC };
  }
  if (opts.mode === 'seconds') {
    const bodySec = Math.max(PHOTO_MIN_SEC * itemCount,
                             (opts.seconds || 30) - TITLE_CARD_SEC - CLOSER_CARD_SEC);
    const per = clamp(bodySec / itemCount);
    return { perPhotoSec: per, totalSec: TITLE_CARD_SEC + per * itemCount + CLOSER_CARD_SEC };
  }
  // Density curve: 1-6 photos → 4.5s, 7-15 → ~3.5s, 16-30 → 3.0s, 31+ → 2.5s.
  let per = PHOTO_DEFAULT_SEC;
  if (itemCount <= 6) per = 4.5;
  else if (itemCount <= 15) per = 3.5;
  else if (itemCount <= 30) per = 3.0;
  else per = 2.5;
  per = clamp(per);
  return { perPhotoSec: per, totalSec: TITLE_CARD_SEC + per * itemCount + CLOSER_CARD_SEC };
}

function pickLayout(item, outputOrientation) {
  const outAR = outputOrientation === 'landscape' ? 16 / 9
              : outputOrientation === 'square'   ? 1
              : 9 / 16;
  const itemAR = item.width && item.height ? item.width / item.height : outAR;
  if (Math.abs(itemAR - outAR) / outAR < 0.15) return 'cover-kenburns';
  // Square output never uses blur-fill / stack-pair / video-band — every
  // mismatched item just zooms to fill (smart-crop), per user direction.
  if (outputOrientation === 'square') return 'smart-crop';
  // Videos can't pre-bake a blurred background (frame is constantly
  // changing). For now they always smart-crop — video-band layout (video
  // centred + photo borders) lands in the next sub-step.
  if (item.kind === 'video') return 'smart-crop';
  // Photos — content-based decision (no idx rotation):
  //   • clear face subject → smart-crop (zoom in on the person)
  //   • multi-person group → smart-crop (frames the people)
  //   • wide landscape without faces → blur-fill (preserves composition)
  //   • portrait orientation in landscape output → smart-crop
  if (item.hasFaces && item.faceScore > 0.15) return 'smart-crop';
  if (item.faceCount > 1) return 'smart-crop';
  if (item.orientation === 'portrait' && outputOrientation === 'landscape') return 'smart-crop';
  // Wide panorama-ish landscape with no faces in portrait output → mirror
  // -extend looks dramatic (sky/water/scenery), better than another blur-fill.
  if (itemAR > 1.9 && outputOrientation === 'portrait') return 'mirror-extend';
  return 'blur-fill';
}

function makeKenburnsParams(idx) {
  // Deterministic per-clip params so re-renders don't shimmer.
  // Pseudo-random from index (avoids Math.random in render loop).
  const r1 = ((idx * 9301 + 49297) % 233280) / 233280;
  const r2 = ((idx * 5417 + 12345) % 233280) / 233280;
  return {
    panAxis: r1 < 0.5 ? 'x' : 'y',
    panSign: r2 < 0.5 ? -1 : 1,
    startZoom: 1.00,
    endZoom: 1.08,
    panAmount: 0.05,
  };
}

function buildTimeline(orderedItems, allClusters, opts) {
  const { perPhotoSec, totalSec } = planPerPhotoSec(orderedItems.length, opts);
  const timeline = [];

  // --- Title card ---
  const usedClusters = [...new Set(orderedItems.map(p => p.clusterId).filter(Boolean))]
    .map(cid => allClusters.find(c => c.id === cid))
    .filter(Boolean);
  const locLabel = fmtLocationSummary(usedClusters);
  // Subtitle = specific date range; the big title above it is filled in by
  // resolveTitle() in buildPlan (place + 年月 / user override / custom).
  const dateRangeLabel = fmtTitleDateRange(orderedItems.map(p => p.ts));
  timeline.push({
    kind: 'title',
    durationSec: TITLE_CARD_SEC,
    title: 'Memories', // overwritten in buildPlan via resolveTitle()
    subtitle: locLabel ? `${locLabel} · ${dateRangeLabel}` : dateRangeLabel,
  });

  // --- Body clips with day/location chapter overlays ---
  let lastDay = null, lastClusterId = null;
  const days = distinctDays(orderedItems);
  const showDayLabel = days.length > 1; // single-day trip → date is on the title card only
  for (const item of orderedItems) {
    const overlays = [];
    const day = ymdString(item.ts);
    const cid = item.clusterId || null;
    const cluster = allClusters.find(c => c.id === cid);

    const dayChanged = day !== lastDay;
    const locChanged = cid !== lastClusterId && cluster && cluster.label;

    if (opts.subtitlesOn) {
      if (dayChanged && showDayLabel) {
        overlays.push({
          kind: 'date',
          text: fmtJpDate(item.ts),
          enterAt: 0.25, holdUntil: perPhotoSec - 0.25, fadeMs: 350,
        });
      }
      if (locChanged) {
        overlays.push({
          kind: 'location',
          text: '📍 ' + cluster.label,
          enterAt: 0.45, holdUntil: perPhotoSec - 0.4, fadeMs: 400,
        });
      }
    }

    timeline.push({
      kind: item.kind === 'video' ? 'video' : 'photo',
      photoId: item.id,
      ref: item,
      durationSec: perPhotoSec,
      layout: pickLayout(item, opts.orientation),
      kenburns: makeKenburnsParams(timeline.length),
      overlays,
    });

    lastDay = day;
    if (cluster && cluster.label) lastClusterId = cid;
  }

  // --- Closer --- title overwritten in buildPlan to mirror the resolved
  // opening title; subtitle stays "Memories" by default unless overridden.
  timeline.push({
    kind: 'closer',
    durationSec: CLOSER_CARD_SEC,
    title: locLabel || dateRangeLabel || '',
    subtitle: 'Memories',
  });

  // Cumulative startSec
  let t = 0;
  for (const c of timeline) {
    c.startSec = t;
    t += c.durationSec;
  }

  return { timeline, totalSec, perPhotoSec, days, clusters: usedClusters };
}

// Pulls together everything: groups → reps → cluster → name → select → order
// → timeline → post-process merges. Async because of Nominatim. Returns the
// final plan ready for the renderer.
async function buildPlan(opts) {
  const prefOri = opts.orientation;
  // Cache cluster naming across previews (Nominatim is rate-limited so
  // re-running it on every Preview click is wasteful) — keyed on
  // orientation since rep selection depends on it.
  let reps, clusters;
  if (state.namedClusters && state.cachedReps && state.cachedOri === prefOri) {
    reps = state.cachedReps;
    clusters = state.namedClusters;
  } else {
    reps = state.groups.map(g => pickBestOfGroup(g, prefOri));
    clusters = clusterByGps(reps);
    for (const c of clusters) for (const p of c.items) p.clusterId = c.id;
    await nameClusters(clusters, opts.useNominatim !== false);
    state.cachedReps = reps;
    state.namedClusters = clusters;
    state.cachedOri = prefOri;
    state.titleCandidates = generateTitleCandidates(clusters, reps.map(p => p.ts));
    populateTitleSelect();
  }
  const selected = selectByMode(reps, opts.mode, opts);
  const ordered = orderForTimeline(selected, clusters);
  const built = buildTimeline(ordered, clusters, opts);
  // Title card — uses the settings-panel title state. resolveTitle() returns
  // the user's __custom__ string when chosen, else the auto-generated one.
  const titleStr = resolveTitle(opts);
  if (built.timeline[0] && built.timeline[0].kind === 'title') {
    if (titleStr) built.timeline[0].title = titleStr;
    if (opts.titleMode === '__custom__' && opts.titleSubtitleCustom) {
      built.timeline[0].subtitle = opts.titleSubtitleCustom;
    }
  }

  // Closer card — closerCustom is the BIG line ("Memories"-slot),
  // closerSubtitleCustom is the small caption above it. In __auto__ the
  // big line mirrors the resolved title.
  const lastClip = built.timeline[built.timeline.length - 1];
  if (lastClip && lastClip.kind === 'closer') {
    let closerMain = null, closerCaption = null;
    if (opts.closerMode === '__custom__') {
      // Empty input reverts to the resolved-title fallback so clearing the
      // field doesn't leave the closer card with no big line.
      closerMain    = opts.closerCustom || titleStr || null;
      closerCaption = opts.closerSubtitleCustom || null;
    } else if (titleStr) {
      closerMain = titleStr;
    }
    if (closerMain != null) lastClip.subtitle = closerMain;
    if (closerCaption != null) lastClip.title = closerCaption;
  }
  // Post-process passes (run order matters):
  //   1. mergeStackPairs — pair consecutive landscape photos in portrait out
  //   2. mergeVideoBands — wrap landscape videos with photo borders in
  //      portrait out, sourcing borders from photos already in the timeline
  // Re-time cumulative startSec + totalSec afterwards because durations may
  // change.
  let merged = mergeStackPairs(built.timeline, opts);
  merged = mergeVideoBands(merged, opts);
  let t = 0;
  for (const c of merged) { c.startSec = t; t += c.durationSec; }
  return { ordered, ...built, timeline: merged, totalSec: t };
}

// In portrait output, wrap landscape video clips with two still photo
// borders top/bottom. Borders are pulled from any photos already in the
// timeline (the same photo may appear as a main clip elsewhere — that's
// stylistically fine for memory videos and avoids dropping content).
function mergeVideoBands(timeline, opts) {
  if (opts.orientation !== 'portrait') return timeline;
  // Borders are sourced from photo refs that share the video's chapter
  // (same day; clusterId match preferred). Falling back to any photo in
  // the same day. With strict-chronological ordering a global round-robin
  // produced borders from minutes / hours away — bad chapter cohesion.
  const photoRefs = [];
  for (const c of timeline) {
    if (c.kind !== 'photo') continue;
    if (c.refs) for (const r of c.refs) photoRefs.push(r);
    else if (c.ref) photoRefs.push(c.ref);
  }
  if (photoRefs.length < 2) return timeline;
  const sameDay = (a, b) => ymdString(a.ts) === ymdString(b.ts);
  const sameCluster = (a, b) => (a.clusterId || null) === (b.clusterId || null);
  const findBorders = (videoRef) => {
    // Prefer same-cluster, then same-day, then anything. Pick two distinct refs.
    const tiers = [
      photoRefs.filter(r => sameCluster(r, videoRef)),
      photoRefs.filter(r => sameDay(r, videoRef)),
      photoRefs,
    ];
    for (const tier of tiers) {
      if (tier.length >= 2) return [tier[0], tier[1]];
    }
    return null;
  };
  return timeline.map(clip => {
    if (clip.kind !== 'video' || !clip.ref) return clip;
    const ar = clip.ref.width / Math.max(1, clip.ref.height);
    if (ar < 1.3) return clip; // not strongly landscape — keep smart-crop
    const borders = findBorders(clip.ref);
    if (!borders) return clip;
    return {
      ...clip,
      layout: 'video-band',
      borderRefs: borders,
    };
  });
}

// Merge two consecutive landscape-photo clips (both with mismatched aspect
// in portrait output) into a single stack-pair clip showing both photos
// stacked top/bottom. Each pair gets 1.5× the per-photo duration so the
// viewer has time to take in both, while keeping the overall video close
// to the planned length.
function mergeStackPairs(timeline, opts) {
  if (opts.orientation !== 'portrait') return timeline;
  const out = [];
  let i = 0;
  while (i < timeline.length) {
    const a = timeline[i];
    const b = i + 1 < timeline.length ? timeline[i + 1] : null;
    const eligible = (clip) =>
      clip && clip.kind === 'photo' && clip.layout !== 'cover-kenburns'
      && clip.ref && clip.ref.orientation === 'landscape';
    // Only merge when a and b share the same chapter (cluster + day). At a
    // chapter boundary b carries fresh date/location overlays we mustn't
    // drop; leaving b as its own clip preserves the chapter label.
    const sameChapter = (x, y) => {
      if (!x || !y || !x.ref || !y.ref) return false;
      const sameCluster = (x.ref.clusterId || null) === (y.ref.clusterId || null);
      const sameDay = ymdString(x.ref.ts) === ymdString(y.ref.ts);
      return sameCluster && sameDay;
    };
    if (eligible(a) && eligible(b) && sameChapter(a, b)) {
      out.push({
        kind: 'photo',
        photoId: a.photoId, // reuse for asset map keying
        ref: a.ref,
        refs: [a.ref, b.ref],
        durationSec: Math.min(PHOTO_MAX_SEC, a.durationSec * 1.5),
        layout: 'stack-pair',
        kenburns: a.kenburns,
        kenburnsList: [a.kenburns, b.kenburns],
        // Same chapter guaranteed above, so a's overlays cover both halves.
        overlays: a.overlays || [],
      });
      i += 2;
      continue;
    }
    out.push(a);
    i++;
  }
  return out;
}

// =============================================================================
// Step 5a — Renderer (canvas frame loop, photos with cover-kenburns,
// title/closer cards). Subtitles, blur-fill, video playback, transitions
// land in the next sub-steps.
// =============================================================================

function canvasDimsFor(orientation, resolutionShortSide, mode, opts, itemCount) {
  if (mode === 'preview') {
    // Match canvas internal size to the bitmap budget so drawImage runs
    // 1:1 (no upscale-blur). Falls from 540 → 170 long side as item count
    // grows; on-screen <canvas> CSS-stretches to fit the stage panel.
    const longSide = getRenderBitmapMaxDim(opts || {}, 'preview', itemCount || 0);
    const shortSide = Math.round(longSide * 9 / 16);
    if (orientation === 'square') return [longSide, longSide];
    if (orientation === 'landscape') return [longSide, shortSide];
    return [shortSide, longSide]; // portrait
  }
  const r = parseInt(resolutionShortSide, 10) || 720;
  if (orientation === 'square') return [r, r];
  const long = Math.round(r * 16 / 9);
  if (orientation === 'landscape') return [long, r];
  return [r, long];
}

function applyStageOrientation(orientation) {
  const wrap = dom.stage.parentElement;
  wrap.classList.remove('landscape', 'square');
  if (orientation === 'landscape') wrap.classList.add('landscape');
  else if (orientation === 'square') wrap.classList.add('square');
}

// smoothstep — eases in and out for natural Ken-Burns motion
function easeInOut(t) { return t * t * (3 - 2 * t); }

// Decode a photo ref to an ImageBitmap that's no larger than `maxDim` along
// its long side. Without this, decoding 30+ full-resolution iPhone photos
// (each ~24 MP) blows past mobile RAM caps and the browser tab crashes
// during preview. Preview uses a smaller cap than export so iOS Safari
// can hold the working set in RAM; export re-decodes at full size.
async function decodeBitmapForRender(ref, maxDim = 1600) {
  const src = ref.decodedBlob || ref.file;
  const w = ref.width || 0, h = ref.height || 0;
  if (w && h && (w > maxDim || h > maxDim)) {
    const scale = maxDim / Math.max(w, h);
    try {
      return await createImageBitmap(src, {
        resizeWidth: Math.round(w * scale),
        resizeHeight: Math.round(h * scale),
        resizeQuality: 'high',
      });
    } catch (_) {
      // Older browsers may not support resize options — fall through.
    }
    // Fallback: Image → canvas at target size → ImageBitmap. Reliable
    // across iOS Safari versions where createImageBitmap resize options
    // are silently ignored.
    const url = URL.createObjectURL(src);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, cw, ch);
      return await createImageBitmap(c);
    } finally {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
  }
  return await createImageBitmap(src);
}

// Different working-set bitmap budget for preview vs export. Preview is
// aggressive — iOS Safari has ~250MB usable RAM and the whole timeline's
// bitmaps live in memory at once.
function getRenderBitmapMaxDim(opts, mode, itemCount) {
  const res = parseInt(opts && opts.resolution, 10) || 720;
  const canvasLong = Math.round(res * 16 / 9);
  if (mode === 'export') {
    return Math.min(2400, Math.round(canvasLong * 1.4));
  }
  // Preview: drops fast as the upload grows. Each bitmap is ~ (dim/1000)^2 ×
  // 4MB raw, so a 100-item set at 200 long side is ~16 MB total — comfortably
  // inside iOS Safari's ceiling even with video element decoders alongside.
  const n = itemCount || 0;
  if (n <=   8) return 540;
  if (n <=  20) return 432;
  if (n <=  40) return 340;
  if (n <=  80) return 260;
  if (n <= 120) return 200;
  return 170;
}

function previewQualityReduced(opts, itemCount) {
  // Only flag when the cap drops far enough to be visibly chunky. Below
  // ~360 long side the preview noticeably softens; above that it's still
  // crisp on a phone screen and the banner just adds noise.
  return getRenderBitmapMaxDim(opts, 'preview', itemCount) < 360;
}

async function preloadAssets(plan, opts, mode, onProgress) {
  const itemCount = plan.timeline.filter(c => c.kind === 'photo' || c.kind === 'video').length;
  const maxDim = getRenderBitmapMaxDim(opts, mode, itemCount);
  // Border bitmaps in video-band slots are smaller on screen — smaller cap.
  const borderMaxDim = Math.max(480, Math.round(maxDim * 0.7));
  const assets = new Map();
  let i = 0;
  for (const clip of plan.timeline) {
    i++;
    if (clip.kind === 'photo' && clip.layout === 'stack-pair') {
      try {
        const refs = clip.refs || [clip.ref];
        // Sequential decode (not Promise.all) so peak memory stays bounded
        // — two big bitmaps in flight at once was tipping iOS over.
        const bms = [];
        for (const r of refs) {
          bms.push(await withTimeout(decodeBitmapForRender(r, maxDim), 12000, r.sourceName));
        }
        assets.set(clip.photoId, { kind: 'stack-pair', bitmaps: bms });
      } catch (e) {
        console.warn('stack-pair preload failed', e);
        assets.set(clip.photoId, { kind: 'photo-failed' });
      }
    } else if (clip.kind === 'photo') {
      try {
        const bm = await withTimeout(decodeBitmapForRender(clip.ref, maxDim), 12000, clip.ref.sourceName);
        assets.set(clip.photoId, { kind: 'photo', bitmap: bm });
      } catch (e) {
        console.warn('preload failed', clip.ref.sourceName, e);
        assets.set(clip.photoId, { kind: 'photo-failed' });
      }
    } else if (clip.kind === 'video') {
      try {
        const v = document.createElement('video');
        v.src = clip.ref.objectUrl;
        v.muted = true;             // step 6 will route audio through Web Audio
        v.playsInline = true;
        v.preload = 'auto';
        v.crossOrigin = 'anonymous';
        // Generous timeouts on the FIRST preview after a heavy upload —
        // iOS Safari sometimes serialises video decoder warm-ups so the
        // first &lt;video&gt; takes a noticeable while to fire loadedmetadata
        // even on a fast device.
        await withTimeout(new Promise((res, rej) => {
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('video load')), { once: true });
        }), 25000, 'preload ' + clip.ref.sourceName);
        // Skip the pre-seek warm-up entirely in preview mode — the &lt;video&gt;
        // will seek + paint when its clip activates. A few frames of
        // black at clip start is preferable to blocking the whole preload
        // pipeline behind 5+ video seeks.
        if (mode !== 'preview') {
          try {
            await withTimeout(new Promise((res) => {
              v.addEventListener('seeked', res, { once: true });
              v.currentTime = clip.ref.highlightStartSec || 0;
            }), 8000, 'preseek ' + clip.ref.sourceName);
          } catch (_) { /* non-fatal */ }
        }
        // For video-band, also decode the two border photos.
        let borderBitmaps = null;
        if (clip.layout === 'video-band' && clip.borderRefs && clip.borderRefs.length >= 2) {
          try {
            const list = [];
            for (const r of clip.borderRefs.slice(0, 2)) {
              list.push(await withTimeout(decodeBitmapForRender(r, borderMaxDim), 8000, r.sourceName));
            }
            borderBitmaps = list;
          } catch (_) { borderBitmaps = null; }
        }
        assets.set(clip.photoId, {
          kind: 'video', element: v, playing: false,
          startSec: clip.ref.highlightStartSec || 0,
          borderBitmaps,
        });
      } catch (e) {
        console.warn('video preload failed', clip.ref.sourceName, e);
        assets.set(clip.photoId, { kind: 'video-failed' });
      }
    }
    if (onProgress) onProgress(i / plan.timeline.length);
  }
  return assets;
}

function clearCanvas(ctx, w, h, fill = '#000') {
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
}

// Pre-bake a blurred zoom-fill copy of the source image per (asset, output
// dims) — ctx.filter blur applied per frame is too expensive at 30 fps for
// even a few photos in flight. Cached on the asset record.
function getBlurredFill(asset, canvasW, canvasH) {
  const key = `${canvasW}x${canvasH}`;
  if (asset.blurredKey === key && asset.blurred) return asset.blurred;
  const c = document.createElement('canvas');
  c.width = canvasW;
  c.height = canvasH;
  const cx = c.getContext('2d');
  const bgZoom = 1.10;
  const srcW = asset.bitmap.width, srcH = asset.bitmap.height;
  const bgScale = Math.max(canvasW / srcW, canvasH / srcH) * bgZoom;
  const bgW = srcW * bgScale, bgH = srcH * bgScale;
  // Aggressive blur — user wanted the back side "as blurred as possible"
  // for blur-fill / two-photo overlap layouts. brightness 0.45 darkens it
  // so the sharp foreground reads stronger.
  cx.filter = 'blur(54px) brightness(0.45) saturate(1.20)';
  cx.drawImage(asset.bitmap, (canvasW - bgW) / 2, (canvasH - bgH) / 2, bgW, bgH);
  // Add a faint dark vignette so the foreground reads more strongly
  cx.filter = 'none';
  const vignette = cx.createRadialGradient(
    canvasW / 2, canvasH / 2, Math.min(canvasW, canvasH) * 0.35,
    canvasW / 2, canvasH / 2, Math.max(canvasW, canvasH) * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  cx.fillStyle = vignette;
  cx.fillRect(0, 0, canvasW, canvasH);
  asset.blurred = c;
  asset.blurredKey = key;
  return c;
}

function drawBlurFill(ctx, canvasW, canvasH, asset, t, kb) {
  const tEased = easeInOut(t);

  // Background — pre-baked, sized exactly to canvas. Drawn STATIC: drifting
  // it exposed a black canvas edge on the trailing side. Motion comes from
  // the foreground Ken-Burns instead, which is plenty.
  const bg = getBlurredFill(asset, canvasW, canvasH);
  ctx.drawImage(bg, 0, 0);

  // Foreground — scale-to-fit with subtle Ken-Burns zoom-pan
  const srcW = asset.bitmap.width, srcH = asset.bitmap.height;
  const fgZoom = kb.startZoom + (kb.endZoom - kb.startZoom) * tEased;
  const fgScale = Math.min(canvasW / srcW, canvasH / srcH) * fgZoom;
  const fgW = srcW * fgScale, fgH = srcH * fgScale;
  let dx = (canvasW - fgW) / 2;
  let dy = (canvasH - fgH) / 2;
  // Pan the foreground only along the axis that has slack so it stays inside
  const slackX = Math.max(0, fgW - canvasW);
  const slackY = Math.max(0, fgH - canvasH);
  const pan = kb.panSign * kb.panAmount * tEased;
  if (kb.panAxis === 'x' && slackX > 0) dx += slackX * pan;
  else if (kb.panAxis === 'y' && slackY > 0) dy += slackY * pan;
  ctx.drawImage(asset.bitmap, dx, dy, fgW, fgH);
}

// Smart-crop: aggressive cover-zoom that biases the visible window toward
// the subject. Uses the photo's faceapi-detected focal point if present;
// otherwise centres slightly above the middle (people are usually upper-half).
// This is the alternative to blur-fill for aspect mismatch — it loses some
// edges but fills the screen and keeps motion natural.
function drawSmartCrop(ctx, canvasW, canvasH, source, srcW, srcH, focalPoint, t, kb) {
  const tEased = easeInOut(t);
  const startZoom = 1.04;
  const endZoom = 1.18;
  const zoom = startZoom + (endZoom - startZoom) * tEased;
  const baseScale = Math.max(canvasW / srcW, canvasH / srcH);
  const scale = baseScale * zoom;
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const fx = (focalPoint && focalPoint.x) || 0.5;
  const fy = (focalPoint && focalPoint.y) || 0.42;
  let dx = fx * canvasW - fx * drawW;
  let dy = fy * canvasH - fy * drawH;
  const slackX = drawW - canvasW;
  const slackY = drawH - canvasH;
  const pan = kb.panSign * 0.05 * tEased;
  if (kb.panAxis === 'x' && slackX > 0) dx += slackX * pan;
  else if (kb.panAxis === 'y' && slackY > 0) dy += slackY * pan;
  dx = Math.min(0, Math.max(canvasW - drawW, dx));
  dy = Math.min(0, Math.max(canvasH - drawH, dy));
  ctx.drawImage(source, dx, dy, drawW, drawH);
}

// Mirror-extend: scenic landscape in portrait output. The seam direction
// matters — a real water reflection has the *closest* edges meeting at the
// seam (top of photo touches top of upper reflection, bottom of photo
// touches bottom of lower reflection). Achieved by translating the canvas
// to the seam line first, scaling y by -1, then drawing the image at its
// natural offset *as if the seam were the original anchor*.
function drawMirrorExtend(ctx, canvasW, canvasH, asset, t, kb) {
  const srcW = asset.bitmap.width, srcH = asset.bitmap.height;
  const tEased = easeInOut(t);
  const zoom = 1.0 + 0.05 * tEased;
  const scale = (canvasW / srcW) * zoom;
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (canvasW - drawW) / 2;
  const dy = (canvasH - drawH) / 2;
  const driftY = (kb && kb.panSign ? kb.panSign : 1) * (canvasH * 0.02) * tEased;
  ctx.save();
  ctx.translate(0, driftY);
  // Top reflection — mirror around the line y=dy (the original's top edge).
  // After translate(dx, dy) + scale(1,-1), drawing at (0, 0, drawW, drawH)
  // places the image flipped, covering y ∈ [dy − drawH, dy]. The pixel at
  // local source y=0 (top of photo) lands at canvas y=dy (touching the
  // original's top), and source y=drawH (bottom) lands at canvas y=dy−drawH.
  // That's exactly what we want: the seam reads "top edge mirrored to top".
  if (dy > 0) {
    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(1, -1);
    ctx.drawImage(asset.bitmap, 0, 0, drawW, drawH);
    ctx.restore();
  }
  // Original
  ctx.drawImage(asset.bitmap, dx, dy, drawW, drawH);
  // Bottom reflection — mirror around the line y=dy+drawH (original's bottom
  // edge). translate(dx, dy+drawH) puts origin at the seam; scale(1,-1)
  // flips. drawImage with negative y (-drawH..0) so source y=drawH (bottom
  // of photo) sits at the seam after the flip.
  if (dy + drawH < canvasH) {
    ctx.save();
    ctx.translate(dx, dy + drawH);
    ctx.scale(1, -1);
    ctx.drawImage(asset.bitmap, 0, -drawH, drawW, drawH);
    ctx.restore();
  }
  ctx.restore();
  // Vignette to fade reflections at the very edges
  const grad = ctx.createLinearGradient(0, 0, 0, canvasH);
  grad.addColorStop(0,    'rgba(0,0,0,0.55)');
  grad.addColorStop(0.18, 'rgba(0,0,0,0)');
  grad.addColorStop(0.82, 'rgba(0,0,0,0)');
  grad.addColorStop(1,    'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvasW, canvasH);
}

// Generic "scale-to-cover and pan inside a sub-rect of the canvas" helper.
// Used by stack-pair and video-band layouts. Source can be ImageBitmap or
// HTMLVideoElement (drawImage handles either).
function drawCoverIntoSlot(ctx, x, y, slotW, slotH, source, srcW, srcH, t, kb) {
  if (!srcW) srcW = source.width || source.naturalWidth || source.videoWidth || 0;
  if (!srcH) srcH = source.height || source.naturalHeight || source.videoHeight || 0;
  if (!srcW || !srcH) return;
  const tEased = easeInOut(t);
  const startZoom = (kb && kb.startZoom) || 1.00;
  const endZoom   = (kb && kb.endZoom)   || 1.06;
  const zoom = startZoom + (endZoom - startZoom) * tEased;
  const baseScale = Math.max(slotW / srcW, slotH / srcH);
  const scale = baseScale * zoom;
  const drawW = srcW * scale, drawH = srcH * scale;
  let dx = x + (slotW - drawW) / 2;
  let dy = y + (slotH - drawH) / 2;
  const slackX = drawW - slotW, slackY = drawH - slotH;
  const pan = (kb && kb.panSign ? kb.panSign : 1) * (kb && kb.panAmount ? kb.panAmount : 0.04) * tEased;
  if (kb && kb.panAxis === 'x' && slackX > 0) dx += slackX * pan;
  else if (slackY > 0)                         dy += slackY * pan;
  dx = Math.min(x, Math.max(x + slotW - drawW, dx));
  dy = Math.min(y, Math.max(y + slotH - drawH, dy));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, slotW, slotH);
  ctx.clip();
  ctx.drawImage(source, dx, dy, drawW, drawH);
  ctx.restore();
}

// Landscape video centred in a 50%-tall band, with two still photos as
// frame-decoration top and bottom. Borders pan slowly so they don't feel
// frozen against the moving centre.
function drawVideoBand(ctx, canvasW, canvasH, videoEl, srcW, srcH, borderBitmaps, t, kb) {
  // Video band centred at 50% of canvas height; photo borders fill the
  // remaining top/bottom. NO gaps — borders butt directly against the
  // band. Top border height = floor((canvasH - bandH)/2), bottom border
  // takes the rest so an odd remainder doesn't leave a 1px gap at the
  // very bottom seam.
  const bandH = Math.round(canvasH * 0.50);
  const borderTopH = Math.floor((canvasH - bandH) / 2);
  const bandY = borderTopH;
  const bandBottomY = bandY + bandH;
  const borderBottomH = canvasH - bandBottomY;
  if (borderBitmaps && borderBitmaps[0]) {
    drawCoverIntoSlot(ctx, 0, 0, canvasW, borderTopH,
      borderBitmaps[0], borderBitmaps[0].width, borderBitmaps[0].height,
      t, makeKenburnsParams(0));
  }
  if (borderBitmaps && borderBitmaps[1]) {
    drawCoverIntoSlot(ctx, 0, bandBottomY, canvasW, borderBottomH,
      borderBitmaps[1], borderBitmaps[1].width, borderBitmaps[1].height,
      t, makeKenburnsParams(1));
  }
  drawCoverIntoSlot(ctx, 0, bandY, canvasW, bandH, videoEl, srcW, srcH, t, kb);
  // Hairline accents along both seams (matches stack-pair style)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, Math.round(canvasH * 0.0015));
  ctx.beginPath();
  ctx.moveTo(0, bandY);        ctx.lineTo(canvasW, bandY);
  ctx.moveTo(0, bandBottomY);  ctx.lineTo(canvasW, bandBottomY);
  ctx.stroke();
  ctx.restore();
}

// Two photos stacked top/bottom with a slight overlap (no black gap) and a
// diagonal seam between them. Each half is a clip-path polygon, with the
// photo cover-filled into a slightly oversized slot so it covers the
// overlap area too. Slope direction picked from the first kenburns param.
function drawStackPair(ctx, canvasW, canvasH, bitmaps, t, kbList) {
  const halfH = Math.floor(canvasH / 2);
  const skew = Math.round(canvasH * 0.04);          // diagonal slant magnitude
  const overlap = Math.max(skew, Math.round(canvasH * 0.030)); // safety margin
  const slopeDir = (kbList && kbList[0] && kbList[0].panSign < 0) ? -1 : 1;
  const seamLeft  = halfH - slopeDir * (skew / 2);
  const seamRight = halfH + slopeDir * (skew / 2);

  // --- Top photo: clip to area above the diagonal ---
  if (bitmaps[0]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(canvasW, 0);
    ctx.lineTo(canvasW, seamRight + 1);  // +1 to avoid hairline gap from anti-alias
    ctx.lineTo(0, seamLeft + 1);
    ctx.closePath();
    ctx.clip();
    drawCoverIntoSlot(ctx, 0, 0, canvasW, halfH + overlap,
      bitmaps[0], bitmaps[0].width, bitmaps[0].height,
      t, kbList && kbList[0]);
    ctx.restore();
  }
  // --- Bottom photo: clip to area below the diagonal ---
  if (bitmaps[1]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, seamLeft);
    ctx.lineTo(canvasW, seamRight);
    ctx.lineTo(canvasW, canvasH);
    ctx.lineTo(0, canvasH);
    ctx.closePath();
    ctx.clip();
    drawCoverIntoSlot(ctx, 0, halfH - overlap, canvasW, halfH + overlap,
      bitmaps[1], bitmaps[1].width, bitmaps[1].height,
      t, kbList && kbList[1]);
    ctx.restore();
  }
  // --- Hairline accent along the diagonal seam for crisp definition ---
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = Math.max(1, Math.round(canvasH * 0.0015));
  ctx.beginPath();
  ctx.moveTo(0, seamLeft);
  ctx.lineTo(canvasW, seamRight);
  ctx.stroke();
  ctx.restore();
}

function drawCoverKenburns(ctx, canvasW, canvasH, source, srcW, srcH, t, kb) {
  const tEased = easeInOut(t);
  const zoom = kb.startZoom + (kb.endZoom - kb.startZoom) * tEased;
  const baseScale = Math.max(canvasW / srcW, canvasH / srcH);
  const scale = baseScale * zoom;
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  // Centre + small directional pan inside the cropped area.
  const slackX = drawW - canvasW;
  const slackY = drawH - canvasH;
  let dx = -slackX / 2;
  let dy = -slackY / 2;
  const pan = kb.panSign * kb.panAmount * tEased;
  if (kb.panAxis === 'x') dx += slackX * pan;
  else                     dy += slackY * pan;
  ctx.drawImage(source, dx, dy, drawW, drawH);
}

function drawCardBackground(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e293b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function fontStack() {
  return '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", Arial, sans-serif';
}
// Title-card display font — serif for that "memorial film" look. Browsers
// fall back per-character so Latin renders as Playfair Display and Japanese
// as Shippori Mincho.
function titleFontStack() {
  return '"Playfair Display", "Shippori Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif';
}

// Iteratively shrink a single-line title until it fits within `maxW`. If
// even at `minSize` the text won't fit, splits at the best CJK/space
// separator near the middle for two-line layout.
function fitOrWrapTitle(ctx, text, weight, stack, maxW, idealSize, minSize) {
  if (!text) return { lines: [''], size: idealSize };
  let size = idealSize;
  const setFont = (s) => { ctx.font = `${weight} ${s}px ${stack}`; };
  setFont(size);
  let textW = ctx.measureText(text).width;
  while (textW > maxW && size > minSize) {
    size = Math.max(minSize, Math.floor(size * 0.93));
    setFont(size);
    textW = ctx.measureText(text).width;
  }
  if (textW <= maxW) return { lines: [text], size };
  // Still too wide at minSize — split into two lines.
  const split = bestSplit(text);
  // Reset to ideal size for two-line layout (each line shorter)
  size = idealSize;
  setFont(size);
  let maxLineW = Math.max(...split.map(l => ctx.measureText(l).width));
  while (maxLineW > maxW && size > minSize) {
    size = Math.max(minSize, Math.floor(size * 0.93));
    setFont(size);
    maxLineW = Math.max(...split.map(l => ctx.measureText(l).width));
  }
  return { lines: split, size };
}

function bestSplit(text) {
  // Prefer splitting at composite separators near the middle. Fall back to
  // a Japanese-aware boundary (年/月/日, comma, etc.) before slicing
  // mid-character.
  const seps = [' · ', '・', ' & ', ' – ', ' - ', ' ', '、', '，', ','];
  // After a year/month/day suffix is also a clean break.
  const tailBreaks = ['年', '月', '日'];
  const mid = text.length / 2;
  let bestIdx = -1, bestSep = '', bestDist = Infinity;
  // Pass 1: real separators (consumed in the split).
  for (const sep of seps) {
    let from = 0;
    while (from < text.length) {
      const i = text.indexOf(sep, from);
      if (i < 0) break;
      const d = Math.abs(i - mid);
      if (d < bestDist) { bestDist = d; bestIdx = i; bestSep = sep; }
      from = i + sep.length;
    }
  }
  if (bestIdx >= 0) {
    return [text.slice(0, bestIdx).trim(), text.slice(bestIdx + bestSep.length).trim()];
  }
  // Pass 2: split AFTER a Japanese tail char (年/月/日) — produces e.g.
  // "東京旅行 2024年" / "8月" instead of mid-character chops.
  let bestTail = -1, bestTailDist = Infinity;
  for (let i = 0; i < text.length - 1; i++) {
    if (tailBreaks.includes(text[i])) {
      const d = Math.abs((i + 1) - mid);
      if (d < bestTailDist) { bestTailDist = d; bestTail = i + 1; }
    }
  }
  if (bestTail > 0) {
    return [text.slice(0, bestTail).trim(), text.slice(bestTail).trim()];
  }
  // Last resort — hard mid-character break.
  const m = Math.floor(text.length / 2);
  return [text.slice(0, m).trim(), text.slice(m).trim()];
}

function drawTitleCard(ctx, w, h, clip, localT) {
  drawCardBackground(ctx, w, h);
  // Internal fade in/out — multiplied with whatever globalAlpha the renderer
  // already set for crossfade.
  const fadeIn = 0.5, fadeOut = 1.0;
  const dur = clip.durationSec;
  let alpha;
  if (localT < fadeIn) alpha = localT / fadeIn;
  else if (localT > dur - fadeOut) alpha = Math.max(0, (dur - localT) / fadeOut);
  else alpha = 1;

  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(255,255,255,0.18)';
  ctx.shadowBlur = Math.round(h * 0.012);
  // Auto-fit title — shrink, then fall through to 2-line wrap for very long
  // titles. maxW reserves ~7% margin on each side so the text doesn't kiss
  // the canvas edge.
  const idealSize = Math.max(48, Math.round(h * 0.078));
  const minSize   = Math.max(28, Math.round(h * 0.044));
  const maxW = w * 0.80;
  const fit = fitOrWrapTitle(ctx, clip.title || '', '800', titleFontStack(), maxW, idealSize, minSize);
  ctx.font = `800 ${fit.size}px ${titleFontStack()}`;
  ctx.textBaseline = 'middle';
  const lineH = fit.size * 1.15;
  // Bottom of the title block sits just above the accent rule (at h*0.50).
  const blockBottom = h * 0.50 - h * 0.005;
  for (let i = 0; i < fit.lines.length; i++) {
    const ly = blockBottom - (fit.lines.length - 1 - i) * lineH - lineH * 0.5;
    ctx.fillText(fit.lines[i], w / 2, ly);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  // Hairline accent under the title
  const accentW = Math.round(h * 0.05);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(w / 2 - accentW / 2, h * 0.50 + h * 0.002, accentW, Math.max(1, Math.round(h * 0.0015)));
  if (clip.subtitle) {
    const subIdeal = Math.max(20, Math.round(h * 0.028));
    const subMin   = Math.max(14, Math.round(h * 0.020));
    const subFit = fitOrWrapTitle(ctx, clip.subtitle, '400', fontStack(), w * 0.86, subIdeal, subMin);
    ctx.font = `400 ${subFit.size}px ${fontStack()}`;
    ctx.fillStyle = '#cbd5e1';
    ctx.textBaseline = 'top';
    const lineH = subFit.size * 1.20;
    const top = h * 0.50 + h * 0.018;
    for (let i = 0; i < subFit.lines.length; i++) {
      ctx.fillText(subFit.lines[i], w / 2, top + i * lineH);
    }
  }
  ctx.restore();
}

function drawCloserCard(ctx, w, h, clip, localT) {
  drawCardBackground(ctx, w, h);
  const fadeIn = 0.5, fadeOut = 1.0;
  const dur = clip.durationSec;
  let alpha;
  if (localT < fadeIn) alpha = localT / fadeIn;
  else if (localT > dur - fadeOut) alpha = Math.max(0, (dur - localT) / fadeOut);
  else alpha = 1;
  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
  ctx.textAlign = 'center';
  const maxW = w * 0.80;

  // Top line — small caption (auto-fits / wraps within frame)
  const captionIdeal = Math.max(20, Math.round(h * 0.028));
  const captionMin   = Math.max(14, Math.round(h * 0.020));
  const captionFit = fitOrWrapTitle(ctx, clip.title || '', '400', fontStack(), maxW, captionIdeal, captionMin);
  ctx.font = `400 ${captionFit.size}px ${fontStack()}`;
  ctx.fillStyle = '#cbd5e1';
  ctx.textBaseline = 'middle';
  const capLineH = captionFit.size * 1.2;
  const capBottom = h * 0.5 - h * 0.015;
  for (let i = 0; i < captionFit.lines.length; i++) {
    const ly = capBottom - (captionFit.lines.length - 1 - i) * capLineH - capLineH * 0.5;
    ctx.fillText(captionFit.lines[i], w / 2, ly);
  }

  // Bottom line — main title ("Memories" or override)
  const titleIdeal = Math.max(36, Math.round(h * 0.05));
  const titleMin   = Math.max(22, Math.round(h * 0.034));
  const titleFit = fitOrWrapTitle(ctx, clip.subtitle || 'Memories', '700', titleFontStack(), maxW, titleIdeal, titleMin);
  ctx.font = `700 ${titleFit.size}px ${titleFontStack()}`;
  ctx.fillStyle = '#fff';
  const titleLineH = titleFit.size * 1.15;
  const titleTop = h * 0.5 + h * 0.012;
  for (let i = 0; i < titleFit.lines.length; i++) {
    const ly = titleTop + (i + 0.5) * titleLineH;
    ctx.fillText(titleFit.lines[i], w / 2, ly);
  }
  ctx.restore();
}

// Rounded-rect path helper (no Path2D dependency for older WebViews).
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

// Date / location chapter overlays. Date sits near the top, location near
// the bottom so they don't collide when both fire on the same clip. Timing
// uses each overlay's own enterAt / holdUntil (in clip-local seconds).
function drawOverlay(ctx, w, h, ovl, localT) {
  const fadeSec = (ovl.fadeMs || 350) / 1000;
  let alpha;
  if (localT < ovl.enterAt) return;
  if (localT < ovl.enterAt + fadeSec) alpha = (localT - ovl.enterAt) / fadeSec;
  else if (localT < ovl.holdUntil) alpha = 1;
  else if (localT < ovl.holdUntil + fadeSec) alpha = 1 - (localT - ovl.holdUntil) / fadeSec;
  else return;
  alpha = Math.max(0, Math.min(1, alpha));
  if (alpha <= 0) return;

  const text = ovl.text || '';
  const fontSize = Math.max(20, Math.round(h * 0.032));
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `700 ${fontSize}px ${fontStack()}`;
  ctx.textBaseline = 'middle';
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.4;
  const metrics = ctx.measureText(text);
  const boxW = metrics.width + padX * 2;
  const boxH = fontSize + padY * 2;
  const boxX = (w - boxW) / 2;
  const boxY = ovl.kind === 'date' ? Math.round(h * 0.06)
                                   : Math.round(h * 0.86 - boxH);
  // Slight drop shadow for legibility on busy backgrounds
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = 'rgba(15,23,42,0.55)';
  roundRect(ctx, boxX, boxY, boxW, boxH, boxH * 0.45);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, boxY + boxH / 2);
  ctx.restore();
}

class Renderer {
  constructor(canvas, plan, opts, mixer = null, mode = 'preview') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plan = plan;
    this.opts = opts;
    this.mixer = mixer;
    this.mode = mode; // 'preview' | 'export' — drives bitmap size budget
    this.assets = null;
    this.running = false;
    this.startWallTime = 0;
    this.afHandle = 0;
  }

  setupCanvas() {
    const itemCount = this.plan.timeline.filter(c =>
      c.kind === 'photo' || c.kind === 'video').length;
    const [w, h] = canvasDimsFor(
      this.opts.orientation, this.opts.resolution, this.mode, this.opts, itemCount);
    this.canvas.width = w;
    this.canvas.height = h;
    applyStageOrientation(this.opts.orientation);
  }

  async preload(onProgress) {
    // Wait for the display-font CSS to finish loading so the title card
    // doesn't briefly render in a fallback font.
    if (document.fonts && document.fonts.ready) {
      try { await withTimeout(document.fonts.ready, 4000, 'fonts'); } catch (_) {}
    }
    this.assets = await preloadAssets(this.plan, this.opts, this.mode, onProgress);
    if (this.mixer) {
      for (const clip of this.plan.timeline) {
        if (clip.kind !== 'video') continue;
        const a = this.assets.get(clip.photoId);
        if (a && a.kind === 'video' && a.element) {
          this.mixer.attachVideo(clip.photoId, a.element);
        }
      }
    }
  }

  renderFrame(elapsedSec) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    clearCanvas(ctx, w, h, '#000');

    const active = this.findActive(elapsedSec);
    // activeIds is the *set of clip ids in the render window* (alpha > 0 OR
    // alpha = 0 doesn't matter — being in the window means the video should
    // be playing so audio aligns with the eventual visible frame).
    const activeIds = new Set(active.map(({ clip }) => clip.photoId));

    // Lifecycle: pause videos that just left the active set + tell the
    // mixer to fade their audio back out (which also unducks the BGM).
    if (this.assets) {
      for (const [id, asset] of this.assets) {
        if (asset.kind === 'video' && asset.playing && !activeIds.has(id)) {
          try { asset.element.pause(); } catch (_) {}
          asset.playing = false;
          if (this.mixer) this.mixer.deactivateVideo(id);
        }
      }
    }

    // Activate any video clip that just entered its render window — must
    // happen even if alpha is 0 on this exact frame (xfade-in start), so
    // the video isn't paused for the full crossfade window.
    for (const { clip } of active) {
      if (clip.kind !== 'video') continue;
      const asset = this.assets.get(clip.photoId);
      if (!asset || asset.kind !== 'video' || asset.playing) continue;
      // Seek to the chosen highlight BEFORE play(); preview mode skips
      // the pre-seek warm-up to keep first-load fast, so this is where
      // the actual seek happens. The first few frames may show t=0
      // while the seek completes — acceptable trade for a preview that
      // actually loads.
      try {
        const startSec = clip.ref.highlightStartSec || 0;
        if (Math.abs((asset.element.currentTime || 0) - startSec) > 0.05) {
          asset.element.currentTime = startSec;
        }
      } catch (_) {}
      asset.playing = true;
      asset.element.play().catch((e) => {
        console.warn('video play rejected', e);
        // Allow a retry on the next render tick rather than freezing.
        asset.playing = false;
      });
      if (this.mixer) this.mixer.activateVideo(clip.photoId);
    }

    // Draw all clips with positive alpha. Render order = timeline order.
    for (const { clip, alpha } of active) {
      if (alpha <= 0) continue;
      const localT = elapsedSec - clip.startSec;
      ctx.save();
      ctx.globalAlpha = alpha;
      this.drawClip(clip, localT);
      ctx.restore();
    }
  }

  findActive(t) {
    const half = XFADE_SEC / 2;
    const out = [];
    const tl = this.plan.timeline;
    for (let i = 0; i < tl.length; i++) {
      const clip = tl[i];
      const isFirst = i === 0;
      const isLast = i === tl.length - 1;
      const renderStart = clip.startSec - (isFirst ? 0 : half);
      const clipEnd = clip.startSec + clip.durationSec;
      const renderEnd = clipEnd + (isLast ? 0 : half);
      if (t < renderStart || t >= renderEnd) continue;
      let alpha = 1;
      if (!isFirst && t < clip.startSec + half) {
        alpha = (t - (clip.startSec - half)) / XFADE_SEC;
      }
      if (!isLast && t > clipEnd - half) {
        alpha = Math.min(alpha, ((clipEnd + half) - t) / XFADE_SEC);
      }
      out.push({ clip, alpha: Math.max(0, Math.min(1, alpha)) });
    }
    return out;
  }

  drawClip(clip, localT) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    if (clip.kind === 'title') {
      drawTitleCard(ctx, w, h, clip, localT);
      return;
    }
    if (clip.kind === 'closer') {
      drawCloserCard(ctx, w, h, clip, localT);
      return;
    }
    const asset = this.assets.get(clip.photoId);
    if (!asset) return;
    const t = clip.durationSec ? Math.min(1, localT / clip.durationSec) : 0;
    const kb = clip.kenburns || makeKenburnsParams(0);
    if (asset.kind === 'stack-pair') {
      drawStackPair(ctx, w, h, asset.bitmaps, t, clip.kenburnsList);
    } else if (asset.kind === 'photo') {
      if (clip.layout === 'blur-fill') {
        drawBlurFill(ctx, w, h, asset, t, kb);
      } else if (clip.layout === 'smart-crop') {
        drawSmartCrop(ctx, w, h, asset.bitmap, asset.bitmap.width, asset.bitmap.height,
                      clip.ref.focalPoint, t, kb);
      } else if (clip.layout === 'mirror-extend') {
        drawMirrorExtend(ctx, w, h, asset, t, kb);
      } else {
        drawCoverKenburns(ctx, w, h, asset.bitmap, asset.bitmap.width, asset.bitmap.height, t, kb);
      }
    } else if (asset.kind === 'video') {
      const v = asset.element;
      const srcW = v.videoWidth || 1, srcH = v.videoHeight || 1;
      if (clip.layout === 'video-band' && asset.borderBitmaps) {
        drawVideoBand(ctx, w, h, v, srcW, srcH, asset.borderBitmaps, t, kb);
      } else if (clip.layout === 'smart-crop') {
        drawSmartCrop(ctx, w, h, v, srcW, srcH, clip.ref.focalPoint, t, kb);
      } else {
        drawCoverKenburns(ctx, w, h, v, srcW, srcH, t, kb);
      }
    } else if (asset.kind === 'photo-failed' || asset.kind === 'video-failed') {
      drawCardBackground(ctx, w, h);
      ctx.save();
      ctx.fillStyle = '#94a3b8';
      ctx.font = `400 ${Math.round(h * 0.025)}px ${fontStack()}`;
      ctx.textAlign = 'center';
      ctx.fillText(asset.kind === 'video-failed' ? '🚫 動画読み込み失敗' : '🚫 写真読み込み失敗',
                   w / 2, h / 2);
      ctx.restore();
    }
    // Subtitles / chapter labels — draw on top of the photo within the same
    // clip-alpha context so they fade with the crossfade.
    if (clip.overlays && clip.overlays.length) {
      for (const ovl of clip.overlays) drawOverlay(ctx, w, h, ovl, localT);
    }
  }

  async play(onProgress) {
    if (!this.assets) throw new Error('renderer not preloaded');
    this.running = true;
    this.startWallTime = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (!this.running) {
          // External stop — fire onProgress(1) so the export bar doesn't
          // freeze short of 100% on early termination.
          if (onProgress) onProgress(1);
          resolve();
          return;
        }
        const elapsed = (performance.now() - this.startWallTime) / 1000;
        if (elapsed >= this.plan.totalSec) {
          this.running = false;
          // Render the final frame at totalSec − epsilon (the closer card's
          // last in-window frame) instead of clearing to black, otherwise
          // MediaRecorder captures a black tail when it picks up the last
          // canvas update before stop().
          this.renderFrame(Math.max(0, this.plan.totalSec - 0.001));
          if (onProgress) onProgress(1);
          resolve();
          return;
        }
        this.renderFrame(elapsed);
        if (onProgress) onProgress(elapsed / this.plan.totalSec);
        this.afHandle = requestAnimationFrame(tick);
      };
      this.afHandle = requestAnimationFrame(tick);
    });
  }

  stop() {
    this.running = false;
    if (this.afHandle) cancelAnimationFrame(this.afHandle);
  }

  dispose() {
    this.stop();
    if (this.assets) {
      for (const a of this.assets.values()) {
        if (a.kind === 'photo' && a.bitmap && typeof a.bitmap.close === 'function') {
          try { a.bitmap.close(); } catch (_) {}
        }
        // Drop the cached blurred-fill canvas too — it's full-canvas-size
        // per photo and accumulates across previews if not freed.
        if (a.blurred) { a.blurred = null; a.blurredKey = null; }
        if (a.kind === 'stack-pair' && a.bitmaps) {
          for (const bm of a.bitmaps) {
            if (bm && typeof bm.close === 'function') {
              try { bm.close(); } catch (_) {}
            }
          }
        }
        if (a.kind === 'video') {
          if (a.element) {
            try { a.element.pause(); } catch (_) {}
            try { a.element.removeAttribute('src'); a.element.load(); } catch (_) {}
          }
          if (a.borderBitmaps) {
            for (const bm of a.borderBitmaps) {
              if (bm && typeof bm.close === 'function') {
                try { bm.close(); } catch (_) {}
              }
            }
          }
        }
      }
    }
    this.assets = null;
  }
}

let activeRenderer = null;

// =============================================================================
// Step 6 — Audio mixer (BGM + per-video element). Wraps a single AudioContext
// created from the Preview/Export user gesture (required by iOS Safari).
// Each video element gets its own MediaElementSource → per-clip GainNode so
// the BGM can duck during video clips and unduck after.
// =============================================================================

const VIDEO_DUCK_LEVEL = 1.00;     // no ducking — BGM plays full volume even during video clips
const DUCK_RAMP_SEC = 0.30;
const UNDUCK_RAMP_SEC = 0.40;

// Procedural BGM presets — Web Audio chord-progression engine. Each preset
// is a 4-chord cycle (Pachelbel / 6-4-1-5 etc.) with one chord per
// progression slot. Note frequencies are equal-tempered values for the
// named chord, listed bass-to-top.
const SYNTH_PRESETS = {
  warm: {
    // I → V → vi → IV (C → G → Am → F) — uplifting / hopeful
    progression: [
      [130.81, 196.00, 261.63, 329.63, 392.00], // C2-G3-C4-E4-G4
      [196.00, 246.94, 293.66, 392.00, 493.88], // G2-B3-D4-G4-B4
      [220.00, 261.63, 329.63, 440.00, 523.25], // A2-C4-E4-A4-C5
      [174.61, 220.00, 261.63, 349.23, 440.00], // F2-A3-C4-F4-A4
    ],
    chordSec: 4.5, melodyRate: 0.5, cutoff: 1500,
  },
  memorial: {
    // vi → IV → I → V (Am → F → C → G) — reflective / nostalgic resolution
    progression: [
      [220.00, 261.63, 329.63, 440.00, 523.25],
      [174.61, 220.00, 261.63, 349.23, 440.00],
      [130.81, 196.00, 261.63, 329.63, 392.00],
      [196.00, 246.94, 293.66, 392.00, 493.88],
    ],
    chordSec: 5.0, melodyRate: 0.6, cutoff: 1300,
  },
  nostalgic: {
    // i → VII → VI → V (Am → G → F → E) — descending / wistful
    progression: [
      [220.00, 261.63, 329.63, 440.00, 523.25],
      [196.00, 246.94, 293.66, 392.00, 493.88],
      [174.61, 220.00, 261.63, 349.23, 440.00],
      [164.81, 207.65, 246.94, 329.63, 415.30], // E2-G#3-B3-E4-G#4
    ],
    chordSec: 4.5, melodyRate: 0.55, cutoff: 1200,
  },
  bright: {
    // I → IV → vi → V (G → C → Em → D) — pop-uplifting
    progression: [
      [196.00, 246.94, 293.66, 392.00, 493.88],
      [130.81, 196.00, 261.63, 329.63, 392.00],
      [164.81, 246.94, 329.63, 415.30, 493.88], // E2-B3-E4-G#4-B4
      [146.83, 220.00, 293.66, 369.99, 440.00], // D2-A3-D4-F#4-A4
    ],
    chordSec: 3.5, melodyRate: 0.4, cutoff: 1800,
  },
  gentle: {
    // i → III → VII → iv (Am → C → G → Dm) — folk-style
    progression: [
      [220.00, 261.63, 329.63, 440.00, 523.25],
      [130.81, 196.00, 261.63, 329.63, 392.00],
      [196.00, 246.94, 293.66, 392.00, 493.88],
      [146.83, 220.00, 293.66, 349.23, 440.00], // D2-A3-D4-F4-A4
    ],
    chordSec: 5.0, melodyRate: 0.65, cutoff: 1100,
  },
};

// Generates BGM in real time from a SYNTH_PRESETS preset. Pipeline:
//   bass + pad (sawtooth+filter+LFO) + melody (detuned-piano arpeggio)
//   → notesGain → [dry + delay-feedback reverb] → output → ducking gain
// Output gain is what AudioMixer treats as bgmGain so video ducking just
// works for free.
class SynthSource {
  constructor(ctx, presetName, totalSec) {
    this.ctx = ctx;
    this.preset = SYNTH_PRESETS[presetName] || SYNTH_PRESETS.warm;
    this.totalSec = Math.max(8, totalSec);
    this.nodes = [];
    // Master envelope target
    this.notesGain = ctx.createGain();
    this.notesGain.gain.value = 0;
    // Output (= mixer's bgmGain)
    this.output = ctx.createGain();
    this.output.gain.value = 1.0;
    // Feedback-delay reverb (3-tap stereo with light feedback). Cheap,
    // sounds way better than a dry mix on memorial-piano timbre.
    this.delayL = ctx.createDelay(2);
    this.delayR = ctx.createDelay(2);
    this.delayL.delayTime.value = 0.21;
    this.delayR.delayTime.value = 0.27;
    this.fbL = ctx.createGain(); this.fbL.gain.value = 0.38;
    this.fbR = ctx.createGain(); this.fbR.gain.value = 0.38;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.32;
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    this.notesGain.connect(splitter);
    splitter.connect(this.delayL, 0);
    splitter.connect(this.delayR, 1);
    this.delayL.connect(this.fbL).connect(this.delayR);
    this.delayR.connect(this.fbR).connect(this.delayL);
    this.delayL.connect(merger, 0, 0);
    this.delayR.connect(merger, 0, 1);
    merger.connect(this.wet).connect(this.output);
    this.notesGain.connect(this.output); // dry
    this.nodes.push(splitter, merger);
  }

  // Detuned-pair "piano" note. Two oscillators (triangle + sine octaved
  // unison) with an exponential decay envelope, low-pass filtered, panned.
  schedulePiano(t, freq, dur, gain, pan) {
    const ctx = this.ctx;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = pan || 0;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0005, gain * 0.4), t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3200;
    filter.Q.value = 0.4;
    env.connect(filter);
    if (panner) filter.connect(panner).connect(this.notesGain);
    else        filter.connect(this.notesGain);
    // Two oscillators detuned for richness
    const types = ['triangle', 'sine'];
    const detunes = [0, +6]; // cents
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = types[i];
      osc.frequency.value = freq;
      osc.detune.value = detunes[i];
      const sub = ctx.createGain();
      sub.gain.value = i === 0 ? 0.65 : 0.35;
      osc.connect(sub).connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      this.nodes.push(osc, sub);
    }
    this.nodes.push(env, filter);
    if (panner) this.nodes.push(panner);
  }

  // Sustained pad / bass voice. Sawtooth through a low-pass with a slow
  // LFO on cutoff for a breathing, warm pad timbre.
  schedulePad(t, freq, dur, gain, pan) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = this.preset.cutoff;
    filter.Q.value = 0.6;
    const env = ctx.createGain();
    const fadeIn = Math.min(0.6, dur * 0.25);
    const fadeOut = Math.min(0.8, dur * 0.30);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + fadeIn);
    env.gain.setValueAtTime(gain, t + dur - fadeOut);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = pan || 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 280;
    lfo.connect(lfoG).connect(filter.frequency);
    osc.connect(filter).connect(env);
    if (panner) env.connect(panner).connect(this.notesGain);
    else        env.connect(this.notesGain);
    osc.start(t);
    osc.stop(t + dur + 0.1);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
    this.nodes.push(osc, filter, env, lfo, lfoG);
    if (panner) this.nodes.push(panner);
  }

  start() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = this.totalSec;
    const p = this.preset;
    // Master ADSR
    const sustainEnd = Math.max(2.5, dur - 1.8);
    this.notesGain.gain.setValueAtTime(0, t0);
    this.notesGain.gain.linearRampToValueAtTime(0.65, t0 + 1.8);
    this.notesGain.gain.setValueAtTime(0.65, t0 + sustainEnd);
    this.notesGain.gain.linearRampToValueAtTime(0, t0 + dur);

    const numChords = Math.ceil(dur / p.chordSec) + 1;
    for (let i = 0; i < numChords; i++) {
      const ct = t0 + i * p.chordSec;
      if (ct >= t0 + dur) break;
      const chord = p.progression[i % p.progression.length];
      const chordEnd = Math.min(t0 + dur, ct + p.chordSec + 0.4);
      const chordHold = chordEnd - ct;
      // Bass = lowest chord tone
      this.schedulePad(ct, chord[0], chordHold, 0.10, 0);
      // Pad = mid voicing, two notes, panned slightly
      if (chord.length >= 3) {
        this.schedulePad(ct, chord[1], chordHold, 0.045, -0.25);
        this.schedulePad(ct, chord[2], chordHold, 0.045, +0.25);
      }
      // Melody = detuned-piano arpeggio over chord upper voices.
      // Pattern: 1 - 5 - 3 - 5 - 1↑ - 5 - 3 - 5 (Canon-ish)
      const upper = chord.slice(2); // skip bass + tenor
      if (upper.length === 0) continue;
      const pattern = [0, 2, 1, 2, 0, 2, 1, 2];
      let nt = ct + 0.05;
      let k = 0;
      while (nt < chordEnd - 0.1) {
        const idx = pattern[k % pattern.length] % upper.length;
        const noteFreq = upper[idx];
        const noteDur = Math.min(p.melodyRate * 1.6, chordEnd - nt);
        const pan = ((k % 4) / 3.5 - 0.43) * 0.5;
        this.schedulePiano(nt, noteFreq, noteDur, 0.22, pan);
        nt += p.melodyRate;
        k++;
      }
    }
  }

  stop() {
    // Ramp the master to silence over 50ms so disconnect() doesn't click.
    try {
      const t0 = this.ctx.currentTime;
      this.notesGain.gain.cancelScheduledValues(t0);
      this.notesGain.gain.setValueAtTime(this.notesGain.gain.value, t0);
      this.notesGain.gain.linearRampToValueAtTime(0, t0 + 0.05);
    } catch (_) {}
    for (const n of this.nodes) {
      try { if (n.stop) n.stop(); } catch (_) {}
      try { n.disconnect(); } catch (_) {}
    }
    this.nodes = [];
  }
}

class AudioMixer {
  constructor(externalCtx) {
    if (externalCtx) {
      this.ctx = externalCtx;
      this.ownsCtx = false;
    } else {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.ownsCtx = true;
    }
    this.dest = this.ctx.createMediaStreamDestination(); // for MediaRecorder
    this.bgmBuffer = null;
    this.bgmSource = null;
    this.bgmGain = null;
    this.bgmFadeOutAtSec = null;
    this.videoGains = new Map();
    this.activeVideoCount = 0;
  }

  // Loads + connects the BGM source. `source` is a Blob (uploaded BGM), a
  // URL string (external track), or an object { kind:'synth', preset } for
  // the built-in procedural BGM. Schedules a fade-out so the track ends
  // gracefully even if its endCue doesn't fall on the timeline end.
  //
  // For URL/Blob sources we now decode into an AudioBuffer and play via
  // BufferSource instead of HTMLAudioElement → MediaElementSource.
  // HTMLMediaElement audio routing on iOS Safari has a long-running quirk
  // where another media element's playback (e.g. our video clips) can
  // briefly suspend the BGM &lt;audio&gt;'s output channel. BufferSource is
  // pure Web Audio so it mixes cleanly with video MediaElementSource at
  // the destination — BGM keeps playing through every video clip without
  // ducking or interruption.
  async setupBgm(source, totalSec, fadeOutSec = 1.5) {
    if (source && typeof source === 'object' && source.kind === 'synth') {
      this.synth = new SynthSource(this.ctx, source.preset, totalSec);
      this.bgmGain = this.synth.output;
      this.bgmGain.connect(this.dest);
      this.bgmGain.connect(this.ctx.destination);
      this.bgmFadeOutAtSec = null; // SynthSource handles its own envelope
      return;
    }
    const blobOrUrl = source;
    // Fetch raw bytes (Blob.arrayBuffer for uploads, fetch() for catalog URLs).
    let arrayBuf;
    if (blobOrUrl instanceof Blob) {
      arrayBuf = await blobOrUrl.arrayBuffer();
    } else {
      const res = await withTimeout(fetch(blobOrUrl), 30000, 'BGM fetch');
      if (!res.ok) throw new Error('BGM fetch failed: ' + res.status);
      arrayBuf = await res.arrayBuffer();
    }
    // Decode → AudioBuffer. decodeAudioData has a one-shot promise form on
    // modern browsers; older Safari uses the callback form so wrap both.
    const audioBuf = await new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(arrayBuf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    this.bgmBuffer = audioBuf;
    const gain = this.ctx.createGain();
    gain.gain.value = 1.0;
    gain.connect(this.dest);
    gain.connect(this.ctx.destination);
    this.bgmGain = gain;
    // Fade against the SHORTER of the timeline length and the BGM track's
    // actual duration. BufferSource doesn't loop and fading after the
    // buffer has ended is silent — schedule the ramp before the audio
    // actually stops so the user hears a fade-out instead of an abrupt cut.
    const playableSec = Math.min(totalSec, audioBuf.duration);
    this.bgmFadeOutAtSec = Math.max(0, playableSec - fadeOutSec);
  }

  // Connect a video element's audio through a per-clip gain. Video stays
  // silent (gain 0) until activateVideo() is called.
  attachVideo(clipId, videoEl) {
    if (this.videoGains.has(clipId)) return;
    let src;
    try { src = this.ctx.createMediaElementSource(videoEl); }
    catch (_) { return; } // already attached or not supported
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(this.dest);
    gain.connect(this.ctx.destination);
    videoEl.muted = false; // routed through Web Audio now
    this.videoGains.set(clipId, gain);
  }

  async start() {
    // iOS Safari may have suspended the context — try to resume so the
    // synth + BGM actually make it to the speakers. Belt-and-braces;
    // we already resume in the click handler too.
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
    if (this.synth) this.synth.start();
    if (this.bgmBuffer && this.bgmGain) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.bgmBuffer;
      src.connect(this.bgmGain);
      src.start(0);
      this.bgmSource = src;
    }
    if (this.bgmGain && this.bgmFadeOutAtSec != null) {
      const t0 = this.ctx.currentTime;
      this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, t0 + this.bgmFadeOutAtSec - 0.05);
      this.bgmGain.gain.linearRampToValueAtTime(0, t0 + this.bgmFadeOutAtSec + 1.0);
    }
  }

  activateVideo(clipId) {
    const g = this.videoGains.get(clipId);
    if (g) {
      const t0 = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.linearRampToValueAtTime(1.0, t0 + 0.15);
    }
    this.activeVideoCount = Math.max(0, this.activeVideoCount) + 1;
    // Only touch BGM gain when ducking actually does something — at level
    // 1.0 the cancelScheduledValues call would wipe the long-tail BGM
    // fade-out scheduled in start() for nothing.
    if (this.activeVideoCount === 1 && VIDEO_DUCK_LEVEL < 0.99) this.duckBgm();
  }
  deactivateVideo(clipId) {
    const g = this.videoGains.get(clipId);
    if (g) {
      const t0 = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.linearRampToValueAtTime(0, t0 + 0.20);
    }
    this.activeVideoCount = Math.max(0, this.activeVideoCount - 1);
    if (this.activeVideoCount === 0 && VIDEO_DUCK_LEVEL < 0.99) this.unduckBgm();
  }
  duckBgm() {
    if (!this.bgmGain) return;
    const t0 = this.ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t0);
    this.bgmGain.gain.linearRampToValueAtTime(VIDEO_DUCK_LEVEL, t0 + DUCK_RAMP_SEC);
  }
  unduckBgm() {
    if (!this.bgmGain) return;
    const t0 = this.ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t0);
    this.bgmGain.gain.linearRampToValueAtTime(1.0, t0 + UNDUCK_RAMP_SEC);
  }

  destroy() {
    if (this.synth) {
      try { this.synth.stop(); } catch (_) {}
    }
    if (this.bgmSource) {
      try { this.bgmSource.stop(); } catch (_) {}
      try { this.bgmSource.disconnect(); } catch (_) {}
      this.bgmSource = null;
    }
    this.bgmBuffer = null;
    // Only close the AudioContext when we created it ourselves. An
    // externally-passed ctx (created in the click-handler gesture stack)
    // belongs to the caller and may be reused on the next preview.
    if (this.ownsCtx && this.ctx && this.ctx.state !== 'closed') {
      try { this.ctx.close(); } catch (_) {}
    }
  }
}

// -----------------------------------------------------------------------------
// Batch ingest
// -----------------------------------------------------------------------------
function setSettingsBusy(busy) {
  for (const b of [dom.previewBtn, dom.exportBtn]) {
    if (!b) continue;
    if (busy) {
      if (!b.dataset.origText) b.dataset.origText = b.textContent;
      b.textContent = '⏳ 解析中…';
      b.disabled = true;
    } else {
      if (b.dataset.origText) {
        b.textContent = b.dataset.origText;
        delete b.dataset.origText;
      }
      b.disabled = false;
    }
  }
}

// Release every object URL we hold on to in state.photos so successive
// ingests / page lifetimes don't accumulate leaks.
function releaseStatePhotoUrls() {
  if (!state.photos) return;
  for (const p of state.photos) {
    if (p && p.objectUrl) {
      try { URL.revokeObjectURL(p.objectUrl); } catch (_) {}
      p.objectUrl = null;
    }
  }
}

async function ingestFiles(files) {
  if (state.loading) return;
  // FRESH ingest replaces the previous batch — release any object URLs
  // we held, dispose any active renderer (so its bitmaps + video elements
  // are freed), and clear photos/groups. Without this every drop
  // accumulated, leaking the previous batch's RAM and mixing timelines.
  if (activeRenderer) {
    try { activeRenderer.dispose(); } catch (_) {}
    activeRenderer = null;
  }
  releaseStatePhotoUrls();
  state.photos = [];
  state.groups = [];
  if (dom.stagePanel) dom.stagePanel.style.display = 'none';
  // New batch invalidates cached cluster naming + title candidates, and
  // resets title/closer dropdowns to __auto__ so the next preview rebuilds
  // them from the freshly-analysed clusters instead of carrying a stale
  // custom string from the previous upload.
  state.namedClusters = null;
  state.cachedReps = null;
  state.titleCandidates = [];
  for (const sel of ['titleSelect', 'closerSelect']) {
    const el = document.getElementById(sel);
    if (el) { el.value = '__auto__'; el.style.display = ''; }
  }
  for (const id of ['titleCustom', 'titleSubtitleCustom', 'closerCustom', 'closerSubtitleCustom']) {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.style.display = 'none'; el.style.marginTop = '0.4rem'; }
  }
  const accepted = files.filter(f =>
    (f.type && f.type.startsWith('image/')) || isHeic(f) || isVideo(f)
  );
  if (!accepted.length) {
    alert('画像・動画ファイルが見つかりませんでした。');
    return;
  }
  state.loading = true;
  // Pop the settings panel up immediately so the user can start tweaking
  // mode/orientation/BGM while the photos analyse in the background.
  dom.settingsPanel.style.display = 'flex';
  setSettingsBusy(true);
  // Immediate feedback so the user knows the drop registered. iOS-side
  // HEIC→JPEG conversion + iCloud download can stall things between the
  // file picker and the first decode tick — without this the page looks
  // frozen.
  setLoadProgress(0, `📥 ${accepted.length}件 受け取り — 解析準備中…`);

  // Kick off the face-api model load in parallel — bounded so a stalled
  // CDN request doesn't freeze the whole pipeline. If it fails we keep
  // going without face scoring.
  const faceReady = withTimeout(ensureFaceApi(), 30000, 'face-api models')
    .catch((e) => {
      console.warn('face-api unavailable — proceeding without face scoring', e);
    });

  try {
    // Process photos first (cheap), videos last (potentially slow).
    const photosOnly = accepted.filter(f => !isVideo(f));
    const videosOnly = accepted.filter(f => isVideo(f));
    const queue = [...photosOnly, ...videosOnly];
    const total = queue.length;
    setLoadProgress(1, `0 / ${total} 件解析中…`);

    for (let i = 0; i < queue.length; i++) {
      const f = queue[i];
      const wasVideo = isVideo(f);
      try {
        if (!wasVideo) await faceReady;
        // 25s hard cap per file. Photos with HEIC + face-scan take ~3-5s
        // typically; videos with frame extract ~1-2s. A file that exceeds
        // this is almost certainly stuck — skip and move on.
        const p = await withTimeout(processFile(f), 25000, f.name);
        state.photos.push(p);
      } catch (e) {
        console.warn('skipped file', f.name, e);
      }
      setLoadProgress(((i + 1) / total) * 100,
        `${i + 1} / ${total} 件解析中… (${wasVideo ? '動画' : '写真'})`);
    }
    state.photos.sort((a, b) => a.ts - b.ts);
    state.groups = groupSimilarPhotos(state.photos);
    hideLoadProgress();
    renderReview();
  } finally {
    state.loading = false;
    setSettingsBusy(false);
  }
}

// -----------------------------------------------------------------------------
// Review summary — no thumbnail grid. The dedup / best-pick logic still runs
// (its result feeds the timeline), but the user sees only a one-line summary
// of what was loaded.
// -----------------------------------------------------------------------------
function renderReview() {
  dom.reviewPanel.style.display = 'flex';
  const prefOri = getOutputOrientation();
  const groups = state.groups || [];

  let kept = 0, dropped = 0, duplicatesMerged = 0, withFaces = 0, videos = 0;
  for (const g of groups) {
    const rep = pickBestOfGroup(g, prefOri);
    // (m.isRep was removed — it was set on every member but never read.)
    if (rep.bad) dropped++; else kept++;
    duplicatesMerged += (g.length - 1);
    if (rep.hasFaces) withFaces++;
    if (rep.kind === 'video') videos++;
  }

  const total = state.photos.length;
  const parts = [
    `${total}件 (写真+動画)`,
    `採用${kept}`,
    dropped ? `ブレ等で除外${dropped}` : null,
    duplicatesMerged ? `似たもの${duplicatesMerged}枚を統合` : null,
    videos ? `動画${videos}` : null,
    withFaces ? `笑顔/人物${withFaces}` : null,
  ].filter(Boolean);
  dom.reviewStats.textContent = parts.join(' / ');
}

// -----------------------------------------------------------------------------
// Dropzone wiring
// -----------------------------------------------------------------------------
function bindDropzone() {
  dom.dz.addEventListener('click', () => dom.fi.click());
  dom.fi.addEventListener('change', () => {
    if (dom.fi.files && dom.fi.files.length) {
      ingestFiles([...dom.fi.files]);
    }
    dom.fi.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => {
    dom.dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dom.dz.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dom.dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dom.dz.classList.remove('drag');
    });
  });
  dom.dz.addEventListener('drop', (e) => {
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (files.length) ingestFiles(files);
  });
}

// -----------------------------------------------------------------------------
// Settings UI
// -----------------------------------------------------------------------------
function getCurrentBgmKind() {
  const r = document.querySelector('input[name="bgm"]:checked');
  return r ? r.value : 'none';
}

function bindSettings() {
  dom.modeGroup.addEventListener('change', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    dom.countField.style.display = (mode === 'count') ? '' : 'none';
    dom.secondsField.style.display = (mode === 'seconds') ? '' : 'none';
  });
  dom.bgmGroup.addEventListener('change', () => {
    const bgm = getCurrentBgmKind();
    dom.catalogField.style.display = (bgm === 'catalog') ? '' : 'none';
    dom.uploadField.style.display = (bgm === 'upload') ? '' : 'none';
  });
  document.getElementById('orientation').addEventListener('change', () => {
    // Cluster naming depends on rep choice which depends on orientation,
    // so invalidate the cache so titles regenerate on the next preview.
    state.namedClusters = null;
    state.cachedReps = null;
    if (state.groups && state.groups.length) renderReview();
  });
  const titleSel = document.getElementById('titleSelect');
  const titleCustom = document.getElementById('titleCustom');
  const titleSubtitleCustom = document.getElementById('titleSubtitleCustom');
  if (titleSel) {
    titleSel.addEventListener('change', () => {
      const showCustom = titleSel.value === '__custom__';
      titleCustom.style.display = showCustom ? '' : 'none';
      titleSubtitleCustom.style.display = showCustom ? '' : 'none';
    });
  }
  const closerSel = document.getElementById('closerSelect');
  const closerCustom = document.getElementById('closerCustom');
  const closerSubtitleCustom = document.getElementById('closerSubtitleCustom');
  if (closerSel) {
    closerSel.addEventListener('change', () => {
      const showCustom = closerSel.value === '__custom__';
      closerCustom.style.display = showCustom ? '' : 'none';
      closerSubtitleCustom.style.display = showCustom ? '' : 'none';
    });
  }
  // Catalog audition button — plays/stops the currently-selected track so
  // the user can sample BGM choices before committing.
  bindCatalogAudition();
  // populate catalog
  const catalog = (window.MUSIC_CATALOG || []);
  dom.catalogSelect.innerHTML = '';
  if (catalog.length) {
    const auto = document.createElement('option');
    auto.value = '__auto__';
    auto.textContent = '🪄 自動選曲 (枚数とムードから最適化)';
    auto.selected = true;
    dom.catalogSelect.appendChild(auto);
  }
  for (const track of catalog) {
    const opt = document.createElement('option');
    opt.value = track.id;
    const lenStr = track.durationSec ? ` · ${Math.round(track.durationSec)}s` : '';
    opt.textContent = `${track.title} — ${track.artist}${lenStr}`;
    dom.catalogSelect.appendChild(opt);
  }
  const catalogRadio = document.getElementById('bgmCatalogRadio');
  if (!catalog.length) {
    // Stay selectable so the user isn't blocked — when picked but the
    // catalog is empty, the BGM source resolves to null and the export
    // proceeds silently.
    dom.catalogHint.textContent = '推奨曲は現在準備中。選んでもBGMなしで書き出されます (手持ちBGMはアップロードを使ってください)。';
  } else {
    dom.catalogHint.innerHTML = `${catalog.length}曲の中から、長さ・ムードに合うものを自動で選びます。<br>手持ちのBGMを使いたい場合は <b>「📁 自分のBGMを使う」</b> から mp3/m4a をアップロードしてください。`;
  }

  dom.previewBtn.addEventListener('click', onPreview);
  dom.exportBtn.addEventListener('click', onExport);
}

// -----------------------------------------------------------------------------
// Plan inspector — Step 4 deliverable. Shows what the renderer will play
// without actually rendering yet. Replaced by the real preview in Step 5.
// -----------------------------------------------------------------------------
function getSelectedCatalogTrack() {
  const radio = document.querySelector('input[name="bgm"]:checked');
  if (!radio || radio.value !== 'catalog') return null;
  const sel = document.getElementById('catalogSelect');
  if (!sel || !sel.value) return null;
  if (sel.value === '__auto__') {
    return autoPickBgmTrack(estimateTargetSec(), 'auto', window.MUSIC_CATALOG || []);
  }
  return (window.MUSIC_CATALOG || []).find(t => t.id === sel.value) || null;
}

function bgmTempoFromTags(tags) {
  if (!tags || !tags.length) return 'medium';
  const j = tags.join(' ').toLowerCase();
  if (/(uplifting|happy|energetic|joyful|fast|upbeat|cheerful|dance|pop)/.test(j)) return 'fast';
  if (/(calm|memorial|emotional|piano|warm|slow|nostalgic|melancholy|reflective|tender|ambient)/.test(j)) return 'slow';
  return 'medium';
}

// Best-fit track selection. Considers rough target length (photos × default
// per-photo + intro/outro), preferred mood, and the track's endCueSec for
// clean endings. Short tracks are kept eligible for low-photo-count cases.
function autoPickBgmTrack(targetSec, preferredMood, catalog) {
  if (!catalog || !catalog.length) return null;
  let best = null, bestScore = -Infinity;
  for (const t of catalog) {
    if (!t.durationSec) continue;
    const tempo = bgmTempoFromTags(t.tags);
    let score = 0;
    // Length fit
    const overhead = t.durationSec - targetSec;
    if (overhead < -15) score -= 12;            // way too short, would loop
    else if (overhead < -5) score -= 6;         // somewhat short, awkward
    else if (overhead <= 0) score += 2;         // slightly short — fades nicely
    else if (overhead <= 30) score += 4;        // ideal
    else score -= overhead * 0.05;              // too long
    // End cue near target → clean musical ending
    if (t.endCueSec && Math.abs(t.endCueSec - targetSec) < 4) score += 3;
    // Mood preference
    if (preferredMood && preferredMood !== 'auto' && tempo === preferredMood) score += 1.5;
    // For low-photo-count target (< 35s) prefer short tracks
    if (targetSec < 35 && t.durationSec < 90) score += 1.5;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Quick target-length estimate without rebuilding the timeline. Used by the
// auto-pick to choose a sensibly-sized track before the plan is computed.
function estimateTargetSec() {
  if (!state.groups || !state.groups.length) return 30;
  const usable = state.groups
    .map(g => pickBestOfGroup(g, getOutputOrientation()))
    .filter(p => !p.bad).length;
  // Mirror the density curve in planPerPhotoSec so the estimate matches
  // what the timeline would actually produce.
  let per = PHOTO_DEFAULT_SEC;
  if (usable <= 6) per = 4.5;
  else if (usable <= 15) per = 3.5;
  else if (usable <= 30) per = 3.0;
  else per = 2.5;
  return TITLE_CARD_SEC + per * usable + CLOSER_CARD_SEC;
}

function readPlanOpts() {
  const track = getSelectedCatalogTrack();
  const $ = (id) => document.getElementById(id);
  const titleSel = $('titleSelect');
  const closerSel = $('closerSelect');
  return {
    orientation: getOutputOrientation(),
    resolution: $('resolution').value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    count: parseInt($('countInput').value, 10) || 15,
    seconds: parseInt($('secondsInput').value, 10) || 30,
    bgmDurationSec: track ? track.durationSec : null,
    bgmTempo: track ? bgmTempoFromTags(track.tags) : 'medium',
    subtitlesOn: $('subtitles').value !== 'off',
    titleMode: titleSel ? titleSel.value : '__auto__',
    titleCustom: $('titleCustom') ? ($('titleCustom').value || '').trim() : '',
    titleSubtitleCustom: $('titleSubtitleCustom') ? ($('titleSubtitleCustom').value || '').trim() : '',
    closerMode: closerSel ? closerSel.value : '__auto__',
    closerCustom: $('closerCustom') ? ($('closerCustom').value || '').trim() : '',
    closerSubtitleCustom: $('closerSubtitleCustom') ? ($('closerSubtitleCustom').value || '').trim() : '',
    useNominatim: true,
  };
}

let auditionAudio = null;
function stopAudition() {
  if (auditionAudio) {
    try { auditionAudio.pause(); } catch (_) {}
    try { auditionAudio.removeAttribute('src'); auditionAudio.load(); } catch (_) {}
    auditionAudio = null;
  }
  const btn = document.getElementById('catalogAudition');
  if (btn) btn.textContent = '▶';
}

function bindCatalogAudition() {
  const btn = document.getElementById('catalogAudition');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Toggle: if something's playing, stop it.
    if (auditionAudio) { stopAudition(); return; }
    // Always unlock + stop any leftover playback first.
    unlockHtmlAudioPlayback();
    stopAudition();

    // For __auto__, sample the track that auto-pick would currently choose
    // so the user actually hears what they'd get.
    let track = getSelectedCatalogTrack();
    if (!track) {
      track = autoPickBgmTrack(estimateTargetSec(), 'auto', window.MUSIC_CATALOG || [])
           || (window.MUSIC_CATALOG || [])[0];
    }
    if (!track || !track.url) {
      alert('再生できる曲がありません');
      return;
    }
    const a = new Audio();
    a.src = track.url;
    a.preload = 'auto';
    a.addEventListener('ended', stopAudition, { once: true });
    a.addEventListener('error', () => { stopAudition(); alert('再生エラー'); }, { once: true });
    a.play().then(() => {
      btn.textContent = '⏸';
      auditionAudio = a;
    }).catch(() => stopAudition());
  });
  // Stop on dropdown change so we don't bleed two tracks.
  const sel = document.getElementById('catalogSelect');
  if (sel) sel.addEventListener('change', stopAudition);
}

function resolveTitle(opts) {
  // __custom__ + non-empty input → use it.
  // __custom__ + EMPTY input → fall back to auto so the user clearing
  // the field reverts to the auto-generated title (was previously
  // returning the literal string "__custom__").
  if (opts.titleMode === '__custom__') {
    if (opts.titleCustom) return opts.titleCustom;
    return pickAutoTitle(state.titleCandidates || []);
  }
  if (opts.titleMode === '__auto__' || !opts.titleMode) {
    return pickAutoTitle(state.titleCandidates || []);
  }
  // Otherwise titleMode is the candidate string itself.
  return opts.titleMode;
}

function populateTitleSelect() {
  const sel = document.getElementById('titleSelect');
  if (!sel) return;
  const cands = state.titleCandidates || [];
  const prevValue = sel.value;
  // Reset options
  sel.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = '__auto__';
  const auto = pickAutoTitle(cands);
  optAuto.textContent = auto ? `🪄 お任せ (${auto})` : '🪄 お任せ';
  sel.appendChild(optAuto);
  for (const c of cands) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  const optCustom = document.createElement('option');
  optCustom.value = '__custom__';
  optCustom.textContent = '✏️ カスタム入力';
  sel.appendChild(optCustom);
  // Restore previous selection if still valid
  if (prevValue && [...sel.options].some(o => o.value === prevValue)) {
    sel.value = prevValue;
  } else {
    sel.value = '__auto__';
  }
}

// Resolve the BGM source to a Blob/URL to feed AudioMixer.setupBgm. Returns
// null when no BGM is configured. Catalog tracks are fetched via the network
// (must be CORS-enabled) — the catalog ships empty so this only runs once
// real entries are populated.
async function resolveBgmSource() {
  const radio = document.querySelector('input[name="bgm"]:checked');
  if (!radio || radio.value === 'none') return null;
  if (radio.value === 'upload') {
    const f = dom.bgmFile.files && dom.bgmFile.files[0];
    if (!f) return null;
    return f;
  }
  if (radio.value === 'catalog') {
    const track = getSelectedCatalogTrack();
    if (!track) return null;
    if (track.kind === 'synth') return { kind: 'synth', preset: track.preset };
    if (track.url) return track.url;
    return null;
  }
  return null;
}

// Synchronously create + resume an AudioContext from inside a click handler
// stack so iOS Safari accepts it. Anything async/awaited *before* this would
// disconnect the gesture context and leave the AudioContext permanently
// suspended (silent BGM, silent canvas-routed video audio). Also plays a
// 1-sample silent buffer to fully unlock the audio subsystem — iOS often
// requires *actual playback* to have happened in the gesture stack before
// later play() calls (synth oscillators / video <audio>) actually emit
// sound.
function preWarmAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    // Touch the destination with a 1-sample silent buffer so iOS marks
    // the context as "user-initiated playback has occurred".
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    return ctx;
  } catch (_) { return null; }
}

// Prime HTMLAudioElement playback on iOS Safari. Even with the AudioContext
// resumed from the gesture stack, an &lt;audio&gt; element created later (after
// awaits) is gated separately — iOS won't autoplay it. Creating + briefly
// playing a tiny silent WAV from the gesture stack unlocks the page's
// HTMLMediaElement playback session for the rest of its lifetime, so the
// BGM &lt;audio&gt; in setupBgm can play() cleanly first time round.
function unlockHtmlAudioPlayback() {
  try {
    const a = new Audio();
    a.preload = 'auto';
    a.muted = true;
    // Minimal valid WAV (44-byte header + 0 sample bytes) data URL.
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { try { a.pause(); } catch (_) {} }).catch(() => {});
    }
  } catch (_) {}
}

async function setupRendererForPlay(opts, plan, audioCtx, mode = 'preview') {
  // The AudioContext must be created (and resumed) from the user gesture
  // stack on iOS Safari. The caller hands one in that was constructed
  // synchronously inside the click handler.
  let mixer = null;
  try {
    mixer = new AudioMixer(audioCtx);
    const bgmSrc = await resolveBgmSource();
    if (bgmSrc) {
      try {
        await mixer.setupBgm(bgmSrc, plan.totalSec, 1.5);
      } catch (e) {
        // Surface to the user too (was silently warning to console, leaving
        // the user wondering why the BGM never started).
        console.warn('BGM setup failed', e);
        const note = document.getElementById('previewQualityNote');
        if (note) {
          note.style.display = '';
          note.innerHTML = '⚠️ BGMの読み込みに失敗しました。BGMなしで再生します。';
        }
      }
    }
  } catch (e) {
    console.warn('AudioContext unavailable', e);
    mixer = null;
  }
  const renderer = new Renderer(dom.stage, plan, opts, mixer, mode);
  renderer.setupCanvas();
  return { renderer, mixer };
}

// MediaRecorder MIME picking — MP4 strongly preferred (saves to iOS Photos
// app via the share sheet). Falls back to WebM (Chrome/Firefox desktop).
function pickRecorderMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; }
    catch (_) {}
  }
  return '';
}

function showRenderProgress(pct, text) {
  dom.renderProg.style.display = 'flex';
  dom.renderProgText.textContent = text;
  dom.renderProgBar.style.width = Math.round(pct * 100) + '%';
}
function hideRenderProgress() {
  dom.renderProg.style.display = 'none';
}

async function exportVideo(renderer, mixer, totalSec) {
  const stream = renderer.canvas.captureStream(30);
  if (mixer && mixer.dest && mixer.dest.stream) {
    for (const track of mixer.dest.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }
  const mime = pickRecorderMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? {
      mimeType: mime,
      videoBitsPerSecond: 5_000_000,
    } : undefined);
  } catch (e) {
    throw new Error('この端末は動画書き出しに対応していません: ' + (e.message || e));
  }
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => recorder.addEventListener('stop', res, { once: true }));
  recorder.start(1000);
  if (mixer) mixer.start();
  await renderer.play((p) => {
    showRenderProgress(p, `🎬 書き出し中… ${Math.round(p * 100)}% (${(p * totalSec).toFixed(1)} / ${totalSec.toFixed(1)}s)`);
  });
  // Give the recorder a moment to flush the final frame's data.
  await new Promise(r => setTimeout(r, 200));
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: mime || (chunks[0] && chunks[0].type) || 'video/webm' });
}

function showOutput(blob) {
  dom.output.innerHTML = '';
  const url = URL.createObjectURL(blob);
  const isMp4 = (blob.type || '').includes('mp4');

  const wrap = document.createElement('div');
  wrap.className = 'alert success';
  wrap.innerHTML = `<div>🎉 書き出し完了 (${(blob.size / (1024 * 1024)).toFixed(1)} MB · ${isMp4 ? 'MP4' : 'WebM'})</div>`;
  dom.output.appendChild(wrap);

  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;
  dom.output.appendChild(video);

  const a = document.createElement('a');
  a.href = url;
  a.download = `memories.${isMp4 ? 'mp4' : 'webm'}`;
  a.className = 'download-link';
  a.textContent = `📥 ダウンロード (.${isMp4 ? 'mp4' : 'webm'})`;
  dom.output.appendChild(a);

  const hint = document.createElement('p');
  hint.className = 'hint';
  if (isMp4) {
    hint.innerHTML = '📱 <b>iPhone</b>: ダウンロードして Files / 「ファイル」アプリで開き、共有 → 「ビデオを保存」で写真アプリに追加できます。';
  } else {
    hint.innerHTML = '⚠️ MP4書き出しに対応していない端末でした。WebMはPC・Androidの動画プレイヤーで再生できます。iPhone「写真」に入れたい場合は別端末でMP4化してください。';
  }
  dom.output.appendChild(hint);
}

async function onExport() {
  if (!state.groups || !state.groups.length) {
    alert('先に写真を読み込んでください');
    return;
  }
  if (activeRenderer) {
    activeRenderer.dispose();
    activeRenderer = null;
  }
  // Sync audio warmup BEFORE any await — required for iOS Safari to allow
  // BGM and synth playback. preWarmAudioContext handles WebAudio;
  // unlockHtmlAudioPlayback unlocks HTMLAudioElement playback for the
  // BGM &lt;audio&gt; that gets created later in setupBgm.
  unlockHtmlAudioPlayback();
  const audioCtx = preWarmAudioContext();
  dom.exportBtn.disabled = true;
  dom.previewBtn.disabled = true;
  const orig = dom.exportBtn.textContent;
  dom.exportBtn.textContent = '構成中…';
  let mixerToDispose = null;
  try {
    const opts = readPlanOpts();
    const plan = await buildPlan(opts);
    renderPlanSummary(plan);

    dom.stagePanel.style.display = 'flex';
    dom.stageStatus.textContent = '🖼 アセット読み込み中…';
    dom.stageOverlay.classList.remove('hidden');

    const { renderer, mixer } = await setupRendererForPlay(opts, plan, audioCtx, 'export');
    activeRenderer = renderer;
    mixerToDispose = mixer;

    dom.exportBtn.textContent = '🖼 読込中…';
    await renderer.preload((p) => {
      dom.stageStatus.textContent = `🖼 ${Math.round(p * 100)}% 読込中…`;
    });

    dom.stageOverlay.classList.add('hidden');
    dom.exportBtn.textContent = '🎬 書き出し中…';
    showRenderProgress(0, '🎬 0% (0.0 / ' + plan.totalSec.toFixed(1) + 's)');
    const blob = await exportVideo(renderer, mixer, plan.totalSec);
    hideRenderProgress();
    showOutput(blob);
    dom.stageStatus.textContent = '✅ 書き出し完了';
  } catch (e) {
    console.error(e);
    hideRenderProgress();
    showError('書き出しエラー: ' + (e.message || e));
  } finally {
    dom.exportBtn.disabled = false;
    dom.previewBtn.disabled = false;
    dom.exportBtn.textContent = orig;
    if (mixerToDispose) mixerToDispose.destroy();
    if (activeRenderer) {
      try { activeRenderer.dispose(); } catch (_) {}
      activeRenderer = null;
    }
  }
}

async function onPreview() {
  if (!state.groups || !state.groups.length) {
    alert('先に写真を読み込んでください');
    return;
  }
  if (activeRenderer) {
    activeRenderer.dispose();
    activeRenderer = null;
  }
  // Sync audio warmup BEFORE any await — required for iOS Safari to allow
  // BGM and synth playback. preWarmAudioContext handles WebAudio;
  // unlockHtmlAudioPlayback unlocks HTMLAudioElement playback for the
  // BGM &lt;audio&gt; that gets created later in setupBgm.
  unlockHtmlAudioPlayback();
  const audioCtx = preWarmAudioContext();
  dom.previewBtn.disabled = true;
  dom.exportBtn.disabled = true;
  const orig = dom.previewBtn.textContent;
  dom.previewBtn.textContent = '構成中…';
  let mixerToDispose = null;
  try {
    const opts = readPlanOpts();
    const plan = await buildPlan(opts);
    renderPlanSummary(plan);

    dom.stagePanel.style.display = 'flex';
    dom.stageStatus.textContent = '🖼 アセット読み込み中…';
    dom.stageOverlay.classList.remove('hidden');
    // Bring the preview into view — the stage is now above settings, so
    // smooth-scroll to it and the user sees what's happening.
    // 'auto' (instant) — 'smooth' was racing with the preload-overlay
    // → preview-start handoff and sometimes left the user halfway between
    // panels.
    try { dom.stagePanel.scrollIntoView({ behavior: 'auto', block: 'start' }); } catch (_) {}
    // Preview-quality disclaimer if memory budget kicked in.
    const itemCount = plan.timeline.filter(c => c.kind === 'photo' || c.kind === 'video').length;
    const note = document.getElementById('previewQualityNote');
    if (note) note.style.display = previewQualityReduced(opts, itemCount) ? '' : 'none';

    const { renderer, mixer } = await setupRendererForPlay(opts, plan, audioCtx, 'preview');
    activeRenderer = renderer;
    mixerToDispose = mixer;

    dom.previewBtn.textContent = '🖼 読込中…';
    await renderer.preload((p) => {
      dom.stageStatus.textContent = `🖼 ${Math.round(p * 100)}% 読込中…`;
    });

    dom.stageOverlay.classList.add('hidden');
    dom.previewBtn.textContent = '▶ 再生中…';
    if (mixer) await mixer.start();
    await renderer.play();
    dom.stageOverlay.classList.remove('hidden');
    dom.stageStatus.textContent = '⏸ プレビュー終了';
  } catch (e) {
    console.error(e);
    showError('プレビューエラー: ' + (e.message || e));
  } finally {
    dom.previewBtn.disabled = false;
    dom.exportBtn.disabled = false;
    dom.previewBtn.textContent = orig;
    if (mixerToDispose) mixerToDispose.destroy();
    if (activeRenderer) {
      try { activeRenderer.dispose(); } catch (_) {}
      activeRenderer = null;
    }
  }
}

function showError(msg) {
  dom.output.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'alert error';
  div.textContent = msg;
  dom.output.appendChild(div);
}

// After every preview, copy the resolved title / subtitle / closer texts
// into the settings panel and flip the title/closer mode to '__custom__'
// so the user can edit them in place and re-preview. The settings panel
// is the *only* edit surface — there is no separate quick-edit panel.
function populateSettingsFromPlan(plan) {
  const titleClip = plan.timeline[0];
  const closerClip = plan.timeline[plan.timeline.length - 1];

  // After the first preview the auto/custom selector is redundant — the
  // input fields below are visible and editable. Hide the selects, fill
  // the inputs with the resolved values; on next preview readPlanOpts
  // sees titleMode='__custom__' + non-empty titleCustom and uses them.
  const titleSel = document.getElementById('titleSelect');
  const titleCustom = document.getElementById('titleCustom');
  const titleSubtitleCustom = document.getElementById('titleSubtitleCustom');
  if (titleSel && titleClip) {
    titleSel.value = '__custom__';
    titleSel.style.display = 'none';
    if (titleCustom) {
      titleCustom.value = titleClip.title || '';
      titleCustom.style.display = '';
      titleCustom.style.marginTop = '0';
    }
    if (titleSubtitleCustom) {
      titleSubtitleCustom.value = titleClip.subtitle || '';
      titleSubtitleCustom.style.display = '';
    }
  }

  const closerSel = document.getElementById('closerSelect');
  const closerCustom = document.getElementById('closerCustom');
  const closerSubtitleCustom = document.getElementById('closerSubtitleCustom');
  if (closerSel && closerClip && closerClip.kind === 'closer') {
    closerSel.value = '__custom__';
    closerSel.style.display = 'none';
    if (closerCustom) {
      closerCustom.value = closerClip.subtitle || '';
      closerCustom.style.display = '';
      closerCustom.style.marginTop = '0';
    }
    if (closerSubtitleCustom) {
      closerSubtitleCustom.value = closerClip.title || '';
      closerSubtitleCustom.style.display = '';
    }
  }

  // BGM dropdown — if user picked '🪄 自動選曲', commit the actual chosen
  // track to the dropdown so the next preview is deterministic and the
  // user sees what's playing. Manual catalog picks + upload + none are
  // left untouched.
  const bgmRadio = document.querySelector('input[name="bgm"]:checked');
  if (bgmRadio && bgmRadio.value === 'catalog') {
    const sel = document.getElementById('catalogSelect');
    if (sel && sel.value === '__auto__' && state.lastUsedTrack && state.lastUsedTrack.id) {
      sel.value = state.lastUsedTrack.id;
    }
  }
}

function renderPlanSummary(plan) {
  dom.stagePanel.style.display = 'flex';
  dom.output.innerHTML = '';
  const { timeline, totalSec, perPhotoSec, days, clusters } = plan;
  const photoCount = timeline.filter(c => c.kind === 'photo').length;
  const videoCount = timeline.filter(c => c.kind === 'video').length;

  const wrap = document.createElement('div');
  wrap.className = 'alert success';
  const track = getSelectedCatalogTrack();
  state.lastUsedTrack = track;
  populateSettingsFromPlan(plan);
  const lines = [
    `🎬 構成完了 — 全 ${totalSec.toFixed(1)} 秒 / 1枚あたり ${perPhotoSec.toFixed(2)} 秒`,
    `タイトル: ${timeline[0].title}${timeline[0].subtitle ? ' / ' + timeline[0].subtitle : ''}`,
    `章 (日付/場所の切替): ${days.length}日 × ${clusters.length || 'GPSなし'}場所`,
    `内訳: 写真 ${photoCount} / 動画 ${videoCount}`,
  ];
  if (track) {
    lines.push(`🎵 BGM: ${track.title} — ${track.artist} (${Math.round(track.durationSec)}秒)`);
  }
  if (clusters.length) {
    const labels = clusters.map(c => c.label).filter(Boolean);
    if (labels.length) lines.push('場所: ' + labels.join(' → '));
  }
  wrap.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  dom.output.appendChild(wrap);

  const detail = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'タイムライン詳細';
  detail.appendChild(sum);
  const ul = document.createElement('ul');
  ul.style.cssText = 'font-size:0.78rem;line-height:1.55;padding-left:1.2em;color:#475569;';
  for (const c of timeline) {
    const li = document.createElement('li');
    if (c.kind === 'title' || c.kind === 'closer') {
      li.textContent = `[${c.kind}] ${c.startSec.toFixed(1)}s — ${c.title}${c.subtitle ? ' / ' + c.subtitle : ''}`;
    } else {
      const d = fmtDate(c.ref.ts).slice(0, 10);
      const ovl = c.overlays.map(o => o.text).join(' + ') || '—';
      li.textContent = `[${c.kind}] ${c.startSec.toFixed(1)}s ${c.layout} ${d} ${ovl}`;
    }
    ul.appendChild(li);
  }
  detail.appendChild(ul);
  dom.output.appendChild(detail);
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
bindDropzone();
bindSettings();
window.addEventListener('beforeunload', () => {
  releaseStatePhotoUrls();
  if (activeRenderer) try { activeRenderer.dispose(); } catch (_) {}
});
