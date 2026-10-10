# AI-Gateway

[English](README.md) · [简体中文](README_CN.md)

AI-Gateway は [Sub2API](https://github.com/Wei-Shaw/sub2api) を基にしたソース配布です。Go API ゲートウェイ、Vue 管理画面、アカウント・グループ・API キー管理、画像・動画タスクの実装を含みます。ソース、ロックファイル、テスト、合成フィクスチャ、設定例を収録しています。

このスナップショットは Sub2API の基盤と、本プロジェクトによる Studio/BFF、メディアタスク、管理機能の統合および関連テストの変更を含みます。上流ファイルの修正と追加ファイルの両方があり、全ソースが独自の著作物という意味ではありません。

## ビルドとテスト

CI のバージョンは Go `1.27.0`、Node.js `24.21.0`、pnpm `9.15.9` です。依存関係は `backend/go.mod`、`frontend/package.json` とロックファイルを参照してください。

```sh
pnpm --dir frontend install --frozen-lockfile
make build
make test-frontend
make -C backend test-unit
make -C backend test-integration
```

フロントエンドは `backend/internal/web/dist` に生成されます。統合テストでは一時的な PostgreSQL/Redis コンテナ、メディアテストでは ffmpeg/ffprobe が必要な場合があります。テストはローカルの合成入力を使用し、本番や供給者の認証情報を必要としません。

ルートの `Dockerfile` はソースからアプリケーションをビルドします。[デプロイ手順](deploy/README.md)も参照してください。デプロイ時は対象ソースから作成したイメージを指定してください。上流の既定イメージはこの配布の成果物ではありません。実際の認証情報は非公開の実行時設定に保存します。

[非同期画像](docs/ASYNC_IMAGE_TASKS.md)、[支払い設定](docs/PAYMENT.md)、[プラグイン](docs/PLUGIN_DEVELOPMENT.md)、[ローカルメディアテスト](tools/phase5-media-e2e/README.md)の文書を収録しています。サンプルの価格やアカウント ID は実際のサービス条件ではありません。

## ライセンスと帰属

既存の [GNU LGPL v3.0](LICENSE)（またはそれ以降）、[上流の貢献者契約](CLA.md)、ソース内の著作権表示を保持しています。Sub2API の作者と貢献者への帰属を保持します。上流の開発・スポンサー情報は [Sub2API](https://github.com/Wei-Shaw/sub2api) を参照してください。

Copyright (c) 2026 Wesley Liddick
