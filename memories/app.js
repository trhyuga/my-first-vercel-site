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
const DHASH_HAMMING_THRESHOLD = 10;      // 0-64; lower = stricter similarity
const DEDUP_TIME_WINDOW_MS = 90 * 1000;  // similar shots must be < 90s apart

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
  const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  // heic2any returns a Blob or array of Blobs (for multi-image HEIC)
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
    return { hasFaces: false, faceCount: 0, faceScore: 0 };
  }
  if (!detections || !detections.length) {
    return { hasFaces: false, faceCount: 0, faceScore: 0 };
  }
  let best = -Infinity;
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
    if (score > best) best = score;
  }
  return { hasFaces: true, faceCount: detections.length, faceScore: best };
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
  return new Promise((resolve, reject) => {
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
  });
}

function extractVideoFrameAt(url, atSec, durationSec) {
  return new Promise((resolve, reject) => {
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
  });
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
  const dHash = computeDHash(analysisCanvas);

  // Face quality on a slightly larger canvas — TinyFaceDetector struggles
  // below ~480px when faces are small in the frame.
  const faceCanvas = downscaleToCanvas(img, 512);
  const face = await scoreFacesIn(faceCanvas);

  const w = img.naturalWidth, h = img.naturalHeight;
  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');

  const bad = blurScore < BLUR_REJECT_THRESHOLD;

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
    bad,
    badReason: bad ? `ブレ (鮮明度 ${blurScore.toFixed(0)})` : null,
  };
}

async function processVideo(file) {
  const url = URL.createObjectURL(file);
  const meta = await loadVideoMetadata(url);
  const dur = meta.durationSec || 0.001;

  // Simple heuristic: skip the (often unsteady) intro and treat ~30% in as
  // the highlight start. Audio-RMS analysis and face-api.js were dropped
  // here because they made long-video ingest unbearably slow for marginal
  // benefit; videos already always live in their own solo group.
  const highlightStartSec = dur * 0.30;

  // Sample a single frame just inside the highlight for the thumbnail and
  // blur check. No face scoring on videos.
  const frameAt = Math.max(0, Math.min(dur - 0.1, highlightStartSec + 0.4));
  const img = await extractVideoFrameAt(url, frameAt, dur);

  const thumb = thumbDataUrl(img, 220);
  const analysisCanvas = downscaleToCanvas(img, 256);
  const blurScore = laplacianVariance(analysisCanvas);

  const w = meta.width || img.naturalWidth;
  const h = meta.height || img.naturalHeight;
  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');
  const ts = file.lastModified || Date.now();
  const bad = blurScore < BLUR_REJECT_THRESHOLD;

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
    badReason: bad ? `ブレ (鮮明度 ${blurScore.toFixed(0)})` : null,
    // video-specific
    durationSec: dur,
    highlightStartSec,
    highlightSource: 'heuristic',
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
// Batch ingest
// -----------------------------------------------------------------------------
async function ingestFiles(files) {
  if (state.loading) return;
  state.loading = true;
  try {
    const accepted = files.filter(f =>
      (f.type && f.type.startsWith('image/')) || isHeic(f) || isVideo(f)
    );
    if (!accepted.length) {
      alert('画像・動画ファイルが見つかりませんでした。');
      return;
    }
    setLoadProgress(0, '🤖 顔解析モデルを準備中…');
    try {
      await ensureFaceApi();
    } catch (e) {
      console.warn('face-api unavailable — proceeding without face scoring', e);
    }
    setLoadProgress(1, `0 / ${accepted.length} 枚解析中…`);
    for (let i = 0; i < accepted.length; i++) {
      const f = accepted[i];
      try {
        const p = await processFile(f);
        state.photos.push(p);
      } catch (e) {
        console.warn('skipped file', f.name, e);
      }
      setLoadProgress(((i + 1) / accepted.length) * 100, `${i + 1} / ${accepted.length} 枚解析中…`);
    }
    state.photos.sort((a, b) => a.ts - b.ts);
    state.groups = groupSimilarPhotos(state.photos);
    hideLoadProgress();
    renderReview();
    dom.settingsPanel.style.display = 'flex';
  } finally {
    state.loading = false;
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

// When BGM is selected the per-photo seconds become an auto-derived value
// (BGM length / photo count). The actual computation happens at timeline-build
// time — this just locks the input + shows the user a hint.
function syncPerPhotoField() {
  const bgmKind = getCurrentBgmKind();
  const auto = bgmKind === 'catalog' || bgmKind === 'upload';
  const input = document.getElementById('perPhotoInput');
  const label = input ? input.previousElementSibling : null;
  if (!input) return;
  input.disabled = auto;
  input.style.opacity = auto ? '0.55' : '';
  if (label) {
    label.textContent = auto
      ? '1枚あたりの表示秒 (BGMから自動)'
      : '1枚あたりの表示秒';
  }
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
    syncPerPhotoField();
  });
  document.getElementById('orientation').addEventListener('change', () => {
    if (state.groups && state.groups.length) renderReview();
  });
  syncPerPhotoField();
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

  dom.previewBtn.addEventListener('click', () => {
    alert('プレビューは Step 5 で実装します。');
  });
  dom.exportBtn.addEventListener('click', () => {
    alert('書き出しは Step 6 で実装します。');
  });
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
bindDropzone();
bindSettings();
