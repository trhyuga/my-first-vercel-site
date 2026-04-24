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
// HEIC → JPEG (lazy — heic2any is large)
// -----------------------------------------------------------------------------
async function decodableBlob(file) {
  if (!isHeic(file)) return file;
  if (typeof heic2any !== 'function') {
    throw new Error('HEIC変換ライブラリが読み込めませんでした (オフライン?)');
  }
  const result = await withTimeout(
    heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }),
    20000,
    'HEIC ' + file.name);
  return Array.isArray(result) ? result[0] : result;
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
  c.getContext('2d').drawImage(srcCanvas, 0, 0, TW, TH);
  const data = c.getContext('2d').getImageData(0, 0, TW, TH).data;
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

function loadVideoMetadata(url) {
  return withTimeout(new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      resolve({
        durationSec: isFinite(v.duration) ? v.duration : 0,
        width: v.videoWidth,
        height: v.videoHeight,
      });
    }, { once: true });
    v.addEventListener('error', () => reject(new Error('動画メタデータの読み込みに失敗しました')), { once: true });
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
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const fail = (err) => { if (!done) { done = true; reject(err); } };
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
        img.onload = () => finish(img);
        img.onerror = () => fail(new Error('frame conversion failed'));
        img.src = imgUrl;
      }, 'image/jpeg', 0.9);
    }, { once: true });
    v.addEventListener('error', () => fail(new Error('動画フレームの抽出に失敗しました')), { once: true });
  }), 12000, 'video frame extract');
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

  return {
    id: nextId(),
    file,
    sourceName: file.name,
    mime: decoded.type || file.type,
    kind: 'photo',
    decodedBlob: decoded,
    objectUrl: url,
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
  const ts = file.lastModified || Date.now();
  const badReason = rejectionReason({
    blurScore, lumaMean, lumaVar,
    durationSec: dur,
    hasVideoStream,
  });
  const bad = !!badReason;

  return {
    id: nextId(),
    file,
    sourceName: file.name,
    mime: file.type || 'video/mp4',
    kind: 'video',
    decodedBlob: file,
    objectUrl: url,
    thumbUrl: thumb,
    width: w,
    height: h,
    orientation,
    ts,
    tsSource: 'mtime',
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
  // Photos within DEDUP_TIME_WINDOW_MS AND with hamming(dHash) <=
  // DHASH_HAMMING_THRESHOLD form a group. Videos are always solo (one group
  // each) — they never merge with photos or with each other.
  const groups = [];
  for (const p of photos) {
    if (p.kind === 'video' || !p.dHash) {
      groups.push([p]);
      continue;
    }
    let placed = false;
    for (const g of groups) {
      const head = g[0];
      if (head.kind === 'video' || !head.dHash) continue;
      const dt = Math.abs(p.ts - head.ts);
      if (dt > DEDUP_TIME_WINDOW_MS) continue;
      if (hammingDistance(head.dHash, p.dHash) <= DHASH_HAMMING_THRESHOLD) {
        g.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([p]);
  }
  // Sort each group oldest-first (stable for picker)
  for (const g of groups) g.sort((a, b) => a.ts - b.ts);
  // Sort groups by their head's timestamp
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

// Soft fallback when a cluster doesn't match any curated landmark. Throttled
// to one request per ~1.1s as Nominatim's usage policy requires; failures are
// silent (network down, CORS blocked, rate-limited — we just skip).
let nominatimQueue = Promise.resolve();
function reverseGeocodeNominatim(lat, lng) {
  const job = nominatimQueue.then(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=ja`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        // The Referer header that the browser sends is what Nominatim's
        // anti-abuse filter uses to identify our app.
      });
      if (!res.ok) return null;
      const data = await res.json();
      const a = data.address || {};
      const candidates = [
        a.tourism, a.attraction, a.amusement_park,
        a.suburb, a.neighbourhood,
        a.city_district, a.town, a.village, a.city,
        a.county, a.state, a.country,
      ].filter(Boolean);
      return candidates[0] || data.display_name || null;
    } catch (_) { return null; }
  });
  // Pace subsequent requests regardless of success/failure.
  nominatimQueue = job.then(() => new Promise(r => setTimeout(r, 1100)));
  return job;
}

async function nameClusters(clusters, useNominatim = true) {
  // Pass 1: landmark dictionary (instant)
  for (const c of clusters) {
    const lm = resolveLandmark(c);
    if (lm) {
      c.landmark = lm;
      c.label = lm.short || lm.name;
    }
  }
  // Pass 2: Nominatim reverse-geocode for unmatched clusters with GPS
  if (useNominatim) {
    const pending = clusters.filter(c => c.hasGps && !c.label);
    for (const c of pending) {
      const name = await reverseGeocodeNominatim(c.lat, c.lng);
      if (name) c.label = name;
    }
  }
  // Pass 3: assign generic labels to the rest (keeps GPS-less clusters
  // distinguishable in the chapter strip without misleading names).
  let alpha = 0;
  for (const c of clusters) {
    if (!c.label) {
      if (c.hasGps) c.label = `エリア ${String.fromCharCode(65 + alpha)}`;
      // For no-GPS singletons we DON'T assign a label — they don't show as
      // a distinct chapter, just inherit context from the surrounding photos.
      alpha++;
    }
  }
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
  if (opts.bgmDurationSec) {
    const tempo = opts.bgmTempo || 'medium';
    const targetPer = tempo === 'fast' ? 2.2 : tempo === 'slow' ? 4.5 : 3.0;
    const body = Math.max(10, opts.bgmDurationSec - TITLE_CARD_SEC - CLOSER_CARD_SEC);
    return Math.max(4, Math.min(usableCount, Math.round(body / targetPer)));
  }
  // No BGM — scale loosely with the upload size, capped so the result stays
  // watchable. The breakpoints are tuned for "memory video" length feel
  // (~3s/slide → 30-90s output for 10-30 photos, etc.).
  if (usableCount <= 12) return usableCount;
  if (usableCount <= 30) return Math.round(8 + usableCount * 0.45);
  if (usableCount <= 100) return Math.round(20 + (usableCount - 30) * 0.18);
  return Math.min(40, Math.round(33 + (usableCount - 100) * 0.04));
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

function orderForTimeline(selected, clusters) {
  // Keep same-cluster items contiguous, ordered by the cluster's earliest
  // timestamp; within a cluster, oldest first. This matches the user's rule:
  // "同じ場所だと判断できるものはなるべく固めて順に配置".
  const cidOf = (p) => p.clusterId || 'solo';
  const byCid = new Map();
  for (const p of selected) {
    const k = cidOf(p);
    if (!byCid.has(k)) byCid.set(k, []);
    byCid.get(k).push(p);
  }
  for (const list of byCid.values()) list.sort((a, b) => a.ts - b.ts);
  const cidOrder = [...byCid.entries()]
    .sort((a, b) => a[1][0].ts - b[1][0].ts)
    .map(([k]) => k);
  return cidOrder.flatMap(k => byCid.get(k));
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

function pickLayout(item, outputOrientation, idx) {
  const outAR = outputOrientation === 'landscape' ? 16 / 9
              : outputOrientation === 'square'   ? 1
              : 9 / 16;
  const itemAR = item.width && item.height ? item.width / item.height : outAR;
  if (Math.abs(itemAR - outAR) / outAR < 0.15) return 'cover-kenburns';
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
  const dateLabel = fmtTitleDateRange(orderedItems.map(p => p.ts));
  const usedClusters = [...new Set(orderedItems.map(p => p.clusterId).filter(Boolean))]
    .map(cid => allClusters.find(c => c.id === cid))
    .filter(Boolean);
  const locLabel = fmtLocationSummary(usedClusters);
  timeline.push({
    kind: 'title',
    durationSec: TITLE_CARD_SEC,
    title: dateLabel || 'Memories',
    subtitle: locLabel || null,
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
      layout: pickLayout(item, opts.orientation, timeline.length),
      kenburns: makeKenburnsParams(timeline.length),
      overlays,
    });

    lastDay = day;
    if (cluster && cluster.label) lastClusterId = cid;
  }

  // --- Closer ---
  timeline.push({
    kind: 'closer',
    durationSec: CLOSER_CARD_SEC,
    title: locLabel || dateLabel,
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
// → timeline. Async because of Nominatim. Returns the final plan.
async function buildPlan(opts) {
  const prefOri = opts.orientation;
  // Pick rep from each similarity group and tag each photo with its rep.
  const reps = state.groups.map(g => pickBestOfGroup(g, prefOri));
  // Cluster reps by GPS; tag each rep with clusterId.
  const clusters = clusterByGps(reps);
  for (const c of clusters) for (const p of c.items) p.clusterId = c.id;
  await nameClusters(clusters, /*useNominatim*/ opts.useNominatim !== false);
  // Selection mode → ordered list
  const selected = selectByMode(reps, opts.mode, opts);
  const ordered = orderForTimeline(selected, clusters);
  return { ordered, ...buildTimeline(ordered, clusters, opts) };
}

// =============================================================================
// Step 5a — Renderer (canvas frame loop, photos with cover-kenburns,
// title/closer cards). Subtitles, blur-fill, video playback, transitions
// land in the next sub-steps.
// =============================================================================

function canvasDimsFor(orientation, resolutionShortSide) {
  const r = parseInt(resolutionShortSide, 10) || 720;
  if (orientation === 'square') return [r, r];
  const long = Math.round(r * 16 / 9);
  if (orientation === 'landscape') return [long, r];
  return [r, long]; // portrait default
}

function applyStageOrientation(orientation) {
  const wrap = dom.stage.parentElement;
  wrap.classList.remove('landscape', 'square');
  if (orientation === 'landscape') wrap.classList.add('landscape');
  else if (orientation === 'square') wrap.classList.add('square');
}

// smoothstep — eases in and out for natural Ken-Burns motion
function easeInOut(t) { return t * t * (3 - 2 * t); }

async function preloadAssets(plan, onProgress) {
  const assets = new Map();
  let i = 0;
  for (const clip of plan.timeline) {
    i++;
    if (clip.kind === 'photo') {
      try {
        const src = clip.ref.decodedBlob || clip.ref.file;
        const bm = await withTimeout(createImageBitmap(src), 8000, clip.ref.sourceName);
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
        await withTimeout(new Promise((res, rej) => {
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('video load')), { once: true });
        }), 10000, 'preload ' + clip.ref.sourceName);
        // Pre-seek to the highlight start so the very first frame after
        // activation is the right one.
        try {
          await withTimeout(new Promise((res) => {
            v.addEventListener('seeked', res, { once: true });
            v.currentTime = clip.ref.highlightStartSec || 0;
          }), 4000, 'preseek ' + clip.ref.sourceName);
        } catch (_) { /* non-fatal */ }
        assets.set(clip.photoId, {
          kind: 'video', element: v, playing: false,
          startSec: clip.ref.highlightStartSec || 0,
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
  cx.filter = 'blur(36px) brightness(0.55) saturate(1.15)';
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

  // Background — pre-baked
  const bg = getBlurredFill(asset, canvasW, canvasH);
  // Slow drift of the background to add motion without re-blurring
  const drift = 0.04 * tEased;
  const driftX = kb.panAxis === 'x' ? kb.panSign * drift * canvasW : 0;
  const driftY = kb.panAxis === 'y' ? kb.panSign * drift * canvasH : 0;
  ctx.drawImage(bg, driftX, driftY);

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
  const titleSize = Math.max(40, Math.round(h * 0.06));
  ctx.font = `700 ${titleSize}px ${fontStack()}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(clip.title || '', w / 2, h * 0.5 - h * 0.005);
  if (clip.subtitle) {
    const subSize = Math.max(20, Math.round(h * 0.028));
    ctx.font = `400 ${subSize}px ${fontStack()}`;
    ctx.fillStyle = '#cbd5e1';
    ctx.textBaseline = 'top';
    ctx.fillText(clip.subtitle, w / 2, h * 0.5 + h * 0.015);
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
  ctx.fillStyle = '#cbd5e1';
  const subSize = Math.max(20, Math.round(h * 0.028));
  ctx.font = `400 ${subSize}px ${fontStack()}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(clip.title || '', w / 2, h * 0.5 - h * 0.005);
  ctx.fillStyle = '#fff';
  const titleSize = Math.max(36, Math.round(h * 0.05));
  ctx.font = `700 ${titleSize}px ${fontStack()}`;
  ctx.textBaseline = 'top';
  ctx.fillText(clip.subtitle || 'Memories', w / 2, h * 0.5 + h * 0.015);
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
  constructor(canvas, plan, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plan = plan;
    this.opts = opts;
    this.assets = null;
    this.running = false;
    this.startWallTime = 0;
    this.afHandle = 0;
  }

  setupCanvas() {
    const [w, h] = canvasDimsFor(this.opts.orientation, this.opts.resolution);
    this.canvas.width = w;
    this.canvas.height = h;
    applyStageOrientation(this.opts.orientation);
  }

  async preload(onProgress) {
    this.assets = await preloadAssets(this.plan, onProgress);
  }

  renderFrame(elapsedSec) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    clearCanvas(ctx, w, h, '#000');

    const active = this.findActive(elapsedSec);
    const activeIds = new Set(active.map(({ clip }) => clip.photoId));

    // Lifecycle: pause videos that just left the active set, fast-rewind for
    // possible re-entry on loop replay.
    if (this.assets) {
      for (const [id, asset] of this.assets) {
        if (asset.kind === 'video' && asset.playing && !activeIds.has(id)) {
          try { asset.element.pause(); } catch (_) {}
          asset.playing = false;
        }
      }
    }

    for (const { clip, alpha } of active) {
      if (alpha <= 0) continue;
      // Activate any video clip that just entered.
      if (clip.kind === 'video') {
        const asset = this.assets.get(clip.photoId);
        if (asset && asset.kind === 'video' && !asset.playing) {
          asset.element.muted = true; // Step 6 routes audio through Web Audio
          asset.element.play().catch(() => {});
          asset.playing = true;
        }
      }
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
    if (asset.kind === 'photo') {
      if (clip.layout === 'blur-fill') {
        drawBlurFill(ctx, w, h, asset, t, kb);
      } else if (clip.layout === 'smart-crop') {
        drawSmartCrop(ctx, w, h, asset.bitmap, asset.bitmap.width, asset.bitmap.height,
                      clip.ref.focalPoint, t, kb);
      } else {
        drawCoverKenburns(ctx, w, h, asset.bitmap, asset.bitmap.width, asset.bitmap.height, t, kb);
      }
    } else if (asset.kind === 'video') {
      const v = asset.element;
      const srcW = v.videoWidth || 1, srcH = v.videoHeight || 1;
      if (clip.layout === 'smart-crop') {
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
        if (!this.running) { resolve(); return; }
        const elapsed = (performance.now() - this.startWallTime) / 1000;
        if (elapsed >= this.plan.totalSec) {
          this.running = false;
          // Final black frame
          clearCanvas(this.ctx, this.canvas.width, this.canvas.height, '#000');
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
        if (a.kind === 'video' && a.element) {
          try { a.element.pause(); } catch (_) {}
          try { a.element.removeAttribute('src'); a.element.load(); } catch (_) {}
        }
      }
    }
    this.assets = null;
  }
}

let activeRenderer = null;

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

async function ingestFiles(files) {
  if (state.loading) return;
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
      try {
        if (!isVideo(f)) await faceReady;
        // 25s hard cap per file. Photos with HEIC + face-scan take ~3-5s
        // typically; videos with frame extract ~1-2s. A file that exceeds
        // this is almost certainly stuck — skip and move on.
        const p = await withTimeout(processFile(f), 25000, f.name);
        state.photos.push(p);
      } catch (e) {
        console.warn('skipped file', f.name, e);
      }
      setLoadProgress(((i + 1) / total) * 100,
        `${i + 1} / ${total} 件解析中… (${i < photosOnly.length ? '写真' : '動画'})`);
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
    for (const m of g) m.isRep = (m === rep);
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
    if (state.groups && state.groups.length) renderReview();
  });
  // populate catalog
  const catalog = (window.MUSIC_CATALOG || []);
  dom.catalogSelect.innerHTML = '';
  for (const track of catalog) {
    const opt = document.createElement('option');
    opt.value = track.id;
    opt.textContent = `${track.title} — ${track.artist}`;
    dom.catalogSelect.appendChild(opt);
  }
  const catalogRadio = document.getElementById('bgmCatalogRadio');
  if (!catalog.length) {
    catalogRadio.disabled = true;
    const label = catalogRadio.closest('label');
    if (label) label.style.opacity = '0.5';
    dom.catalogHint.textContent = '推奨曲リストは現在空です (music.js に追加で有効化)。手持ちのBGMをアップロードしてください。';
  } else {
    dom.catalogHint.textContent = `${catalog.length}曲の中から、写真の雰囲気に合いそうなものを自動選曲します。`;
  }

  dom.previewBtn.addEventListener('click', onPreview);
  dom.exportBtn.addEventListener('click', () => {
    alert('書き出しは Step 6 で実装します。');
  });
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
  return (window.MUSIC_CATALOG || []).find(t => t.id === sel.value) || null;
}

function bgmTempoFromTags(tags) {
  if (!tags || !tags.length) return 'medium';
  const j = tags.join(' ').toLowerCase();
  if (/(uplifting|happy|energetic|joyful|fast|upbeat|cheerful|dance|pop)/.test(j)) return 'fast';
  if (/(calm|memorial|emotional|piano|warm|slow|nostalgic|melancholy|reflective|tender|ambient)/.test(j)) return 'slow';
  return 'medium';
}

function readPlanOpts() {
  const track = getSelectedCatalogTrack();
  return {
    orientation: getOutputOrientation(),
    resolution: document.getElementById('resolution').value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    count: parseInt(document.getElementById('countInput').value, 10) || 15,
    seconds: parseInt(document.getElementById('secondsInput').value, 10) || 30,
    bgmDurationSec: track ? track.durationSec : null,
    bgmTempo: track ? bgmTempoFromTags(track.tags) : 'medium',
    subtitlesOn: document.getElementById('subtitles').value !== 'off',
    useNominatim: true,
  };
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
  dom.previewBtn.disabled = true;
  const orig = dom.previewBtn.textContent;
  dom.previewBtn.textContent = '構成中…';
  try {
    const opts = readPlanOpts();
    const plan = await buildPlan(opts);
    renderPlanSummary(plan);

    dom.stagePanel.style.display = 'flex';
    dom.stageStatus.textContent = '🖼 アセット読み込み中…';
    dom.stageOverlay.classList.remove('hidden');

    const renderer = new Renderer(dom.stage, plan, opts);
    renderer.setupCanvas();
    activeRenderer = renderer;

    dom.previewBtn.textContent = '🖼 読込中…';
    await renderer.preload((p) => {
      dom.stageStatus.textContent = `🖼 ${Math.round(p * 100)}% 読込中…`;
    });

    dom.stageOverlay.classList.add('hidden');
    dom.previewBtn.textContent = '▶ 再生中…';
    await renderer.play();
    dom.stageOverlay.classList.remove('hidden');
    dom.stageStatus.textContent = '⏸ プレビュー終了';
  } catch (e) {
    console.error(e);
    showError('プレビューエラー: ' + (e.message || e));
  } finally {
    dom.previewBtn.disabled = false;
    dom.previewBtn.textContent = orig;
  }
}

function showError(msg) {
  dom.output.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'alert error';
  div.textContent = msg;
  dom.output.appendChild(div);
}

function renderPlanSummary(plan) {
  dom.stagePanel.style.display = 'flex';
  dom.output.innerHTML = '';
  const { timeline, totalSec, perPhotoSec, days, clusters } = plan;
  const photoCount = timeline.filter(c => c.kind === 'photo').length;
  const videoCount = timeline.filter(c => c.kind === 'video').length;

  const wrap = document.createElement('div');
  wrap.className = 'alert success';
  const lines = [
    `🎬 構成完了 — 全 ${totalSec.toFixed(1)} 秒 / 1枚あたり ${perPhotoSec.toFixed(2)} 秒`,
    `タイトル: ${timeline[0].title}${timeline[0].subtitle ? ' / ' + timeline[0].subtitle : ''}`,
    `章 (日付/場所の切替): ${days.length}日 × ${clusters.length || 'GPSなし'}場所`,
    `内訳: 写真 ${photoCount} / 動画 ${videoCount}`,
  ];
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

  dom.stageStatus.textContent = '⏸ Step 5 で実映像のプレビュー実装予定';
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
bindDropzone();
bindSettings();
