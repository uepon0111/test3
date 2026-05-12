# Sonora — 音楽プレイヤー

ブラウザで動作する音楽プレイヤーです。  
MP3 / M4A / WAV / FLAC / OGG に対応し、Google Drive との同期をサポートします。

## セットアップ

### 1. リポジトリの準備

```bash
git clone https://github.com/uepon0111/Music-Player.git
cd Music-Player
```

### 2. GitHub Pages を有効化

1. GitHub リポジトリの **Settings → Pages** を開く
2. **Source** を `GitHub Actions` に設定する
3. `main` ブランチへの push で自動デプロイされます

### 3. Google Drive 連携の設定

#### Google Cloud Console の設定

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択（または新規作成）
3. **APIとサービス → ライブラリ** から以下を有効化:
   - **Google Drive API**
   - **Google Identity Services**
4. **APIとサービス → 認証情報** → **認証情報を作成 → OAuth 2.0 クライアント ID**
   - アプリケーションの種類: **ウェブ アプリケーション**
   - 承認済みの JavaScript 生成元に追加:
     ```
     https://uepon0111.github.io
     http://localhost
     ```
   - 承認済みのリダイレクト URI: （不要、GIS は不要）
5. 生成された **クライアント ID** をコピー

#### `js/drive.js` の編集

```js
// drive.js の先頭付近
const CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
//                  ↑ ここを実際のクライアントIDに置き換える
```

### 4. デプロイ

```bash
git add .
git commit -m "Initial deploy"
git push origin main
```

GitHub Actions が自動的に実行され、数分後に以下のURLで公開されます:  
`https://uepon0111.github.io/Music-Player/`

---

## ファイル構成

```
Music-Player/
├── index.html              # メインHTML + CSS
├── 404.html                # SPA用リダイレクト
├── js/
│   ├── storage.js          # IndexedDB ラッパー
│   ├── player.js           # 音声再生エンジン
│   ├── drive.js            # Google Drive 連携
│   ├── ui.js               # UI描画・仮想スクロール
│   └── app.js              # メインロジック統合
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Actions ワークフロー
```

## 主な機能

- **音声ファイル管理**: MP3/M4A/WAV/FLAC/OGG に対応、ドラッグ&ドロップで追加
- **プレイリスト**: 複数プレイリスト作成、手動並び替え、シャッフル/リピート
- **Google Drive 同期**: 異なる端末間でデータを共有、削除も伝播
- **ログ**: 再生時間統計、グラフ、カレンダー表示
- **情報編集**: タイトル/アーティスト/サムネイル/投稿日/タグの編集
- **タグ管理**: 色付きタグの作成・並び替え
- **レスポンシブ**: PC/タブレット（横）、スマートフォン（縦）対応

## キーボードショートカット

| キー | 動作 |
|------|------|
| `Space` | 再生/停止 |
| `Alt + →` | 次の曲 |
| `Alt + ←` | 前の曲 |
| `M` | ミュート切替 |
| `Esc` | モーダルを閉じる |
