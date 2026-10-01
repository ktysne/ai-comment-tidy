# プロジェクトガイドライン

このファイルは AI コーディングエージェント向けの共通指示を記載する。

## このリポジトリが扱うもの

ソースコメントをグローバルの「コメント記述ルール」へ適合させる道具 `comment-tidy` を管理する。
束ごとに AI へ整理を任せる回の道具と、編集の直後とコミットの直前に新しいコメントを検査する `lint` の 2 つを持つ。
設計の正本は [docs/design.md](docs/design.md) で、実装の順序は同資料「実装の段階」にある。
作業の計画と引き継ぎは `docs/handover/` に置く。

## 言語

日本語を共通言語とする。応答、コミットメッセージ、Pull Request、Issue、ドキュメント、コードのコメントはすべて日本語で書く。
識別子は英語でよい。
文書を書く、または推敲するときは `/japanese-tech-writing` スキルの文章規範に従う。

## CLAUDE.md と AGENTS.md の同期

`CLAUDE.md` と `AGENTS.md` は同一内容を保つ。どちらか一方を変更した場合は、必ずもう一方にも同じ変更を反映する。
ただし「リモートセッション時の作業について」は Claude のサブエージェント運用を定めた節なので、`CLAUDE.md` にだけ置く。

## 実装の前提

- Node.js 20 以上、ESM。実行時の依存パッケージは持たない。テストは vitest、lint は eslint を devDependencies で使う。
- 入口は `bin/comment-tidy.js` の 1 つで、サブコマンドで分ける。
- git は `child_process.execFileSync` で、引数の配列を渡して呼ぶ。シェルの文字列を組み立てない。
- `tools/` は ai-cross-review からの取り込みで CommonJS である(`tools/package.json`)。道具本体のコードは `src/` に置く。

## 検証コマンド

```bash
npm run lint
npm test
```

## AI クロスレビュー

実装を一区切りしたら、`docs/cross-review.md` の手順で相互レビューを行う。
レビュー観点はリポジトリ直下の `.cross-review.md` にある。
`tools/cross-review*.js`、`docs/cross-review.md`、`.cross-review.example.md`、`.claude/skills/cross-review/SKILL.md` は upstream からの同期対象であり、直接編集せず `npm run sync` で更新する。
