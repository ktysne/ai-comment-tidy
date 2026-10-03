# ai-comment-tidy

ソースコメントを「コメント記述ルール」に適合させるための道具 `comment-tidy` です。
Claude Code のフックから呼び出し、AI エージェントが書いたコメントを検査します。

道具は次の 2 つの役割を持ちます。

- **`lint`**:新しく書いたコメントを、編集の直後とコミットの直前に検査します。経緯や作業メモ、長すぎるコメント、チケット番号の無い TODO を、書いたその場で見つけます。
- **整理の回**:既存のリポジトリのコメントを束に分けて AI に整理させ、機械の検査とメインセッションの監査を経て取り込みます。開発中です(「開発状況」を参照)。

## 検査する 8 つの規則

| ID | 見つけるもの | 扱い |
|---|---|---|
| `length` | 1 か所のコメントが上限(既定 3 行)を超える | 確定 |
| `issue-ref` | Issue や PR の番号。TODO や `Tracking` と並んだ追跡先の番号は除く | 確定 |
| `date` | 日付 | 確定 |
| `separator` | 区切り線や、見出しを囲む罫線 | 確定 |
| `history` | 経緯の語(「以前は」「従来は」「当初」など) | 見直し候補 |
| `change-log` | 変更の記録(「修正した」「追加した」など) | 見直し候補 |
| `work-note` | 作業の意図、段階のラベル、手順の番号、レビューの出所 | 見直し候補 |
| `todo-no-ticket` | チケット番号の無い TODO、FIXME、HACK | 見直し候補 |

確定は、語や形だけで違反と決まるものです。
見直し候補は、語が当たっても違反とは限らないので、書き手が読み直して判断します。

対応する言語は次の 6 つで、拡張子で判定します。
対応していない言語のファイルは、何も報告せずに通します。

| 言語 | 拡張子 |
|---|---|
| C / C++ | `.h` `.hpp` `.hh` `.hxx` `.c` `.cc` `.cpp` `.cxx` `.inl` `.ipp` |
| C# | `.cs` |
| JavaScript | `.js` `.mjs` `.cjs` |
| TypeScript | `.ts` `.mts` `.cts` |
| CMake | `.cmake`、`CMakeLists.txt` |
| バッチファイル | `.bat` `.cmd` |

`.tsx` は JSX のテキストの扱いを決めるまで対象外です。

規則の詳細と対象から外すもの(ライセンス表記、`eslint-disable` のようなツールの注記など)は、[docs/design.md](docs/design.md)「編集時とコミット前の検査」にあります。

## この道具の考え方

コメントの規則を文章で AI に読ませるだけでは、破られても誰も気付けません。
規則のうち語や形で判定できる部分を機械で検査し、規則の文章は判断が要る部分だけにします。

報告するのは、比べる元(HEAD)に無かった違反だけです。
既存の違反まで報告すると、変更と関係のない既存コメントを同じ差分で直させることになるからです。
位置が動いただけのコメントは、新しい違反として扱いません。

検査そのものが失敗したとき(Git の失敗、字句解析の例外など)は、編集もコミットも止めません。
道具の不具合で作業が止まると、フックごと外されて検査が働かなくなるからです。

フックを 2 つに分けているのは、実装の多くが Codex などへの委譲で行われ、その編集が Claude Code の編集のフックを通らないためです。
コミットはメインセッションが行うので、コミット前の検査はどちらの経路の変更も拾えます。

## インストール

Node.js 20 以上が必要です。
実行時に依存するパッケージは無いので、`npm install` は不要です。

```bash
git clone https://github.com/ktysne/ai-comment-tidy.git
```

クローンした場所で `install-hooks` を実行し、Claude Code のユーザー設定(`~/.claude/settings.json`)にフックを登録します。

```bash
node bin/comment-tidy.js install-hooks --dry-run
```

```bash
node bin/comment-tidy.js install-hooks
```

`--dry-run` を付けると、書き込まずに変更予定と変更後の設定を表示します。
既存の設定とほかのフックは、順序を保ったまま残ります。
設定が変わるときは、同じフォルダーに `settings.json.bak-<日時>` の控えを作ります。

フックのコマンドには、Node.js の実行ファイルと `bin/comment-tidy.js` の絶対パスを記録します。
そのため、Node.js を入れ替えたときと、クローンした場所を移したときは、`install-hooks` を実行し直してください。
クローンした場所で別のブランチに切り替えると、そのブランチのコードがすべてのセッションのフックとして動きます。
手元で開発するときは、クローンした場所は main のまま使い、別の作業ツリーで作業してください。

外すときは `--remove` を付けます。この道具のフックだけを外します。

```bash
node bin/comment-tidy.js install-hooks --remove
```

設定先を変えるときは `--settings <path>` を指定します。

## 使い方

### フックから

登録した後は、意識しなくても次の 2 か所で検査が動きます。

| 場面 | Claude Code のイベント | 違反があったとき |
|---|---|---|
| Edit、Write でファイルを編集した直後 | `PostToolUse` | 今回の編集が触れた行の違反を Claude へ返す |
| `git commit` を実行する直前 | `PreToolUse`(Bash、PowerShell) | 確定の違反があればコミットを止める。見直し候補だけなら知らせてコミットを通す |

コミット前の検査は、`git commit -a`、`git commit <path>`、先行する `git add` などのコマンドの形から、コミットに入る範囲を推定して調べます。

### 手で

```bash
node bin/comment-tidy.js lint --changed
```

| 引数 | 調べるもの |
|---|---|
| `<ファイル...>` | 指定したファイル(作業ツリーと HEAD を比べる) |
| `--changed` | HEAD から変わったファイルと、未追跡のファイル |
| `--staged` | ステージした内容(インデックスと HEAD を比べる) |
| `--repo <dir>` | 対象のリポジトリ。省略するとカレントディレクトリを含むリポジトリ |

違反が無ければ何も表示しません。
終了コードは、0 が違反なしか見直し候補だけ、1 が確定の違反あり、2 が引数の誤りか検査の失敗です。

### 集計

作業ツリーの集計を JSON に保存し、領域ごとの要約を表示します。

```bash
node bin/comment-tidy.js stats --repo <dir> --out current.json
```

保存した JSON は `--compare` で領域ごとと全体の表にできます。

```bash
node bin/comment-tidy.js stats --compare before=before.json after=current.json
```

### 束の変更を検査する

`check` は、担当ファイルのコードが基準と同じこと、担当外のファイルに変更が無いこと、コメントの行数と行末が規則に合うことを検査します。

Git を使う場合は基準コミットを指定します。

```bash
node bin/comment-tidy.js check --repo <作業ツリー> --base <コミット> --files src/a.cpp src/b.js
```

実行者の sandbox から検査するときは、基準の写しとハッシュ一覧を指定します。
この経路は Git や子プロセスを起動しません。

```bash
node bin/comment-tidy.js check --offline --repo <作業ツリー> --base-dir <基準の写し> --hashes <ハッシュ一覧> --files src/a.cpp src/b.js
```

行幅と資料の参照は警告として報告し、終了コードは不合格が 1 件以上なら 1、検査に通れば 0、引数や設定の誤りなら 2 です。
Git を使う経路では、`--out <ファイル>` を指定すると検査結果を JSON で保存します。

### リポジトリごとの設定

設定ファイルが無いリポジトリでも、既定値で動きます。
既定では `third_party`、`node_modules`、`vendor`、`build`、`dist` の下と、Git が無視するファイルを調べません。

検査を止めるときや、誤って当たる語を外すときは、対象のリポジトリに `.comment-tidy/config.json` を置きます。

```json
{
  "maxCommentLines": 3,
  "scope": { "exclude": ["generated"] },
  "lint": {
    "enabled": true,
    "allow": [{ "pattern": "前回の保存", "reason": "実行時の状態を指す語" }]
  }
}
```

コードの中に抑制の印を書く仕組みはありません。
誤って当たる語は、理由とともに `lint.allow` に足します。

## 開発状況

[docs/design.md](docs/design.md)「実装の段階」の順に作っています。

| 段階 | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | 済み |
| 1a | 字句解析、`lint`、フックの入口、`install-hooks` | 済み |
| 1b | `stats`(集計)と `check`(コメント以外が変わっていないことの検査) | 1b-1 済み、1b-2 済み |
| 2〜9 | 設定と束、実行と取り込み、監査、仕上げの道具、スキルと資料、試行 | 未着手 |

整理の回のコマンド(`init`、`plan`、`run`、`apply` など)は、まだありません。
作業の計画と引き継ぎは [docs/handover/](docs/handover/) にあります。

## 開発

テストと lint には、Node.js 22.12 以上が必要です(vitest と eslint が求めるため)。

```bash
npm ci
```

```bash
npm run lint
```

```bash
npm test
```

変更の後の相互レビューの手順は [docs/cross-review.md](docs/cross-review.md) にあります。

## リポジトリの構成

```
bin/comment-tidy.js   入口(サブコマンドで分ける)
src/
├── cli.js            サブコマンドの振り分け
├── lex/              言語ごとの字句解析
├── comment-blocks.js コメントのブロックと行数の数え方
├── docs-refs.js      資料の参照と見出しの照合
├── check/            束の変更、コメント、行末、行幅の検査
├── lint/             lint の規則、報告の絞り込み、フックの入口、設定の読み込み
├── snapshot/         Git、作業ツリー、写しの読み取り
└── install-hooks.js  フックの登録と削除
tests/                vitest のテスト
docs/
├── design.md         設計の正本
├── cross-review.md   相互レビューの手順
└── handover/         作業の計画と引き継ぎ
tools/                ai-cross-review から取り込んだ相互レビューの道具
```
