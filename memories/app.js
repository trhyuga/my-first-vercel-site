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

const BLUR_REJECT_THRESHOLD = 60; // Laplacian variance below this → blurry

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  /**
   * photos: Array<{
   *   id, file, sourceName, mime,
   *   decodedBlob,              // post-HEIC JPEG blob (or original)
   *   objectUrl,                // for <img src>
   *   thumbUrl,                 // smaller data URL for grid
   *   width, height,            // original pixel dims
   *   orientation,              // 'landscape'|'portrait'|'square'
   *   ts,                       // ms epoch, EXIF DateTimeOriginal (fallback: file.lastModified)
   *   tsSource,                 // 'exif'|'mtime'
   *   gps,                      // { lat, lng } | null
   *   blurScore,                // Laplacian variance — higher = sharper
   *   bad,                      // true if excluded
   *   badReason,                // string
   *   manualOverride,           // user forced include/exclude
   * }>
   */
  photos: [],
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
  thumbs: document.getElementById('thumbs'),
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
// Per-photo processing: produces all non-face-non-dup metadata.
// -----------------------------------------------------------------------------
async function processFile(file) {
  const decoded = await decodableBlob(file);
  const { img, url } = await decodeToImage(decoded);
  const exif = await parseExifSafe(decoded);
  const { ts, source: tsSource } = exifTimestamp(exif, file);
  const gps = exifGps(exif);

  const thumb = thumbDataUrl(img, 220);
  const analysisCanvas = downscaleToCanvas(img, 256);
  const blurScore = laplacianVariance(analysisCanvas);

  const w = img.naturalWidth, h = img.naturalHeight;
  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');

  const bad = blurScore < BLUR_REJECT_THRESHOLD;

  return {
    id: nextId(),
    file,
    sourceName: file.name,
    mime: decoded.type || file.type,
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
    bad,
    badReason: bad ? `ブレ (鮮明度 ${blurScore.toFixed(0)})` : null,
    manualOverride: null,
  };
}

// -----------------------------------------------------------------------------
// Batch ingest
// -----------------------------------------------------------------------------
async function ingestFiles(files) {
  if (state.loading) return;
  state.loading = true;
  try {
    const accepted = files.filter(f => f.type.startsWith('image/') || isHeic(f));
    if (!accepted.length) {
      alert('画像ファイルが見つかりませんでした。');
      return;
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
    // Stable sort by timestamp
    state.photos.sort((a, b) => a.ts - b.ts);
    hideLoadProgress();
    renderReview();
    dom.settingsPanel.style.display = 'flex';
  } finally {
    state.loading = false;
  }
}

// -----------------------------------------------------------------------------
// Review grid
// -----------------------------------------------------------------------------
function classifyPhoto(p) {
  // manual override wins
  if (p.manualOverride === 'on') return 'on';
  if (p.manualOverride === 'off') return 'bad';
  if (p.bad) return 'bad';
  return 'on';
}

function renderReview() {
  dom.reviewPanel.style.display = 'flex';
  const counts = { on: 0, bad: 0 };
  const frag = document.createDocumentFragment();

  for (const p of state.photos) {
    const cls = classifyPhoto(p);
    counts[cls]++;

    const el = document.createElement('div');
    el.className = 'thumb ' + cls;
    el.title = [
      p.sourceName,
      fmtDate(p.ts) + (p.tsSource === 'mtime' ? ' (EXIFなし)' : ''),
      p.gps ? `GPS: ${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}` : 'GPSなし',
      p.badReason ? `除外: ${p.badReason}` : '',
    ].filter(Boolean).join('\n');
    el.dataset.id = p.id;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.thumbUrl;
    el.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = fmtDate(p.ts).slice(5); // MM-DD HH:MM
    el.appendChild(badge);

    const stateEl = document.createElement('span');
    stateEl.className = 'state';
    stateEl.textContent = cls === 'on' ? '✅' : '❌';
    el.appendChild(stateEl);

    el.addEventListener('click', () => toggleManual(p.id));
    frag.appendChild(el);
  }

  dom.thumbs.innerHTML = '';
  dom.thumbs.appendChild(frag);

  const total = state.photos.length;
  dom.reviewStats.textContent =
    `${total}枚 — ✅${counts.on} / ❌${counts.bad}`;
}

function toggleManual(id) {
  const p = state.photos.find(x => x.id === id);
  if (!p) return;
  const cur = classifyPhoto(p);
  if (cur === 'on') p.manualOverride = 'off';
  else p.manualOverride = 'on';
  renderReview();
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
// Settings UI (wired up in later steps — for now, show/hide conditional fields)
// -----------------------------------------------------------------------------
function bindSettings() {
  dom.modeGroup.addEventListener('change', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    dom.countField.style.display = (mode === 'count') ? '' : 'none';
    dom.secondsField.style.display = (mode === 'seconds') ? '' : 'none';
  });
  dom.bgmGroup.addEventListener('change', () => {
    const bgm = document.querySelector('input[name="bgm"]:checked').value;
    dom.catalogField.style.display = (bgm === 'catalog') ? '' : 'none';
    dom.uploadField.style.display = (bgm === 'upload') ? '' : 'none';
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
