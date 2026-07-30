# 引き継ぎメモ（TR-Labo / my-first-vercel-site）

最終更新: 2026-07-30 / ブランチ運用: `main` に直接コミット＆push（Vercel が main をデプロイ）

## リポジトリ概要
- 静的サイト（各ツールは `<tool>/index.html` の単体HTML、外部CDNのライブラリを利用）
- PDF系ツールは `pdf/` 配下。共通処理は `pdf/shared.js` / `pdf/shared.css`
  - `PDFApp` に `safeFilename, download, bindDropzone, showError, clearBox, refuseIfEncrypted, appendPrintButton, setupPdfJs, renderPageToCanvas, fmtSize` などをエクスポート
  - `safeFilename(name, fallback, maxBytes=200)`: UTF-8バイト長で切り詰め（b970df0で文字数→バイト数基準に変更済）
  - pdf.js は `window.pdfjsLib`、worker は `setupPdfJs()` で設定。CDN: `pdfjs-dist@3.11.174/legacy/build/`

## このセッションでやったこと（すべて main に push 済み）

### 1. URL短縮ツール `shorten/index.html`（コミット 8ecb261）
- 症状: 「頻繁にエラーで使えない」
- 原因: `fetch`(is.gdはCORS不可でほぼ毎回失敗)→`.catch`でJSONP、の二重リクエストで自らレート制限(errorcode 3)を踏んでいた＋is.gd単一依存
- 対処:
  - CORS fetch を廃止し **JSONP一本化**
  - **3段フォールバック `is.gd → v.gd → spoo.me`**（ユーザー指定の C→A→B 順）。`PROVIDERS` 配列で順序管理。spoo.me は独立系のCORS POST
  - タイムアウト 12s→8s、エラー種別(timeout/network/api)を区別して日本語表示、フォールバック時はどのサービスで短縮したかトースト表示
- 注意: この環境からは is.gd 等へegress不可のため**実API疎通は未確認**。実ブラウザでの動作確認は要ユーザー。
- ※ セッション中に linter/ユーザーが shorten/index.html を微修正（theme-color 等のメタ追加）済み。HEADに取り込まれている。

### 2. PDF分割 パス長エラー修正 `pdf/split/index.html`（コミット 481375c）
- 症状: オフィスステーションの長い名前PDFを「1ページずつZIP」分割→解凍時「パスが長すぎて開けません」
- 原因: ZIP名・内部フォルダ・各ページ名で同じ長い元名が3重連結し MAX_PATH(260) 超過（実例 元名67字→フルパス281字）
- 対処: ZIP内を **フォルダ廃止＋短い連番名**に。ZIP名も60字上限（`pathSafeBase(name, max)` 追加）。→ フルパス281→120字

### 3. PDF分割 宛名で命名 `pdf/split/index.html`（コミット fc5f445 = 最新）
- 要望: 分割後の各PDFを、そのページの宛名「◯◯様」の名前にしたい（理想）。ダメなら連番。
- 実装:
  - 「1ページずつZIP」時に**命名モード選択**を表示（`input[name="naming"]` = `name`(既定) / `seq`）
  - pdf.js でページのテキスト抽出 → `pageToLines()` がy座標で行復元 → `findAddressee()` が「◯◯様」を検出
  - 除外: `NAME_STOP`（お客/皆/各位/御中/人事/総務…）、複合語（様式/仕様/同様等）は「様の直後が行末/空白/句読点」条件で回避
  - 出力: `山田太郎.pdf`、同名は `_2`/`_3`、読み取れなければ `page_NNN.pdf` フォールバック、40字上限
  - 日本語名の先頭に混入した英数字コードは除去（外国人名は保持）
  - 処理後に「宛名で命名 N件 / 連番 M件」を `.success` で表示
- 単体テスト14ケース全PASS（node で正規表現ロジックを検証済）
- **未確認/リスク**: 実物PDFでの抽出精度は未検証。宛名が**画像化**されている（テキストでない）場合は読めない→OCR対応が別途必要。縦書きや「殿」表記など別パターンなら `ADDRESSEE_RE`/`NAME_STOP` の調整が必要。

## 検証手段の注意
- この環境はブラウザ実行・外部egressに制約。検証は主に **node で inline `<script>` を `vm.Script` に通す構文チェック**＋**ロジックの単体移植テスト**で実施。実ブラウザ/実API/実PDFでの最終確認はユーザー側。
- ローカル配信確認は `python3 -m http.server <port>` で HTTP 200 と要素存在を grep 確認。

## 次にありそうなタスク
- 宛名抽出が実PDFで外す場合の正規表現チューニング（ユーザーに実際の「◯○様」の記載形式を確認）
- 宛名が画像の場合の OCR 連携（tesseract 等、`pdf/ocr/` に既存OCR実装あり＝流用検討）
- URL短縮の実ブラウザ動作確認後の微調整（プロバイダ順・除外など）

## ブランチ状態
- `main` と `claude/new-service-design-2l290o`（designated）はどちらも origin/main = fc5f445 に一致
- 途中、`git checkout main` がサイレント失敗して designated ブランチの古いベースにコミットしてしまう事故があったが是正済。**コミット前に必ず `git status` でブランチ/ツリー状態を確認**すること。
