#!/usr/bin/env bash
# Fetch the PaddleOCR mobile ONNX models + Japanese character dictionary
# this folder's index.html expects when running the multi-engine OCR
# merge. Run once locally; commit the resulting files alongside
# index.html so Vercel serves them as same-origin static assets.
#
# Usage:  bash update-paddle-ocr.sh
# Result: writes
#   ./paddle-ocr-det.onnx       — DBNet text detection (~3-5 MB)
#   ./paddle-ocr-rec.onnx       — CRNN+CTC recognition,  Japanese (~10 MB)
#   ./paddle-ocr-dict.txt       — UTF-8 char-per-line dictionary (~50 KB)
#
# When these files exist, the OCR page detects them and runs PaddleOCR
# in parallel with Tesseract on each page. The variant with highest
# mean confidence wins for that page. Without them, Tesseract still
# runs alone — the loader fails gracefully.
#
# Source URLs below pull pre-converted ONNX builds from RapidAI / the
# RapidOCR project (community-maintained, stable versions tracked).
# If a URL ever 404s, swap it for a fresh release at
#   https://github.com/RapidAI/RapidOCR/releases
# any release that exposes japan_PP-OCRv4_rec_*.onnx works here.

set -euo pipefail

cd "$(dirname "$0")"

DET_URL="${PADDLE_DET_URL:-https://github.com/RapidAI/RapidOCR/releases/download/v1.4.0/ch_PP-OCRv4_det_infer.onnx}"
REC_URL="${PADDLE_REC_URL:-https://github.com/RapidAI/RapidOCR/releases/download/v1.4.0/japan_PP-OCRv4_rec_infer.onnx}"
DICT_URL="${PADDLE_DICT_URL:-https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/dict/japan_dict.txt}"

fetch() {
  local url="$1" out="$2"
  echo "→ $url"
  local tmp; tmp="$(mktemp)"
  curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"
  local size
  size=$(stat -c%s "$tmp" 2>/dev/null || stat -f%z "$tmp")
  if [ "$size" -lt 1000 ]; then
    echo "✗ $out: download too small ($size bytes); aborting"
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$out"
  echo "✓ wrote $out ($(numfmt --to=iec --suffix=B "$size" 2>/dev/null || echo "$size bytes"))"
}

fetch "$DET_URL"  paddle-ocr-det.onnx
fetch "$REC_URL"  paddle-ocr-rec.onnx
fetch "$DICT_URL" paddle-ocr-dict.txt

echo
echo "Done. Stage and commit:"
echo "  git add paddle-ocr-det.onnx paddle-ocr-rec.onnx paddle-ocr-dict.txt"
echo "  git commit -m 'pdf/ocr: add PaddleOCR mobile models'"
echo "  git push"
