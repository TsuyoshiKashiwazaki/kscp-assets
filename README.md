# kscp-assets

Kashiwazaki SEO ControlPanel が参照するデータ配信用リポジトリ。

- `manifest.json` — 全 `wp-` プラグイン/テーマの最新版情報をまとめた単一ファイル。
  GitHub Actions（`.github/workflows/generate-manifest.yml`）が **4 時間ごとに自動生成・更新** します。
- `tools/generate-manifest.mjs` — 生成スクリプト。

配信 URL: `https://raw.githubusercontent.com/TsuyoshiKashiwazaki/kscp-assets/main/manifest.json`

手動で即時更新する場合は Actions タブ → **Generate manifest** → **Run workflow**。
認証は GitHub Actions の自動トークンを使うため、追加設定は不要です。
