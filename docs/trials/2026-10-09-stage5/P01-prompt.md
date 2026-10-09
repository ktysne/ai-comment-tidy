## 位置づけ
新規の作業である。

## 目的
コメントを、コメント記述ルールの量と置き場所の規定に合わせて減らす。
コードだけでは読み取れない前提、制約、理由を残し、それ以外を削るか縮める。

## 落とさないもの
- ライセンス表示と移植の約束を残す。
- テストの入力値の根拠を残す。
- 契約の語の主語、順序、条件を変えない。
- 共通規約の正本と、その適用範囲を残す。
次の情報は、1 行へ縮めてでも必ず残す。

- 破ると静かに壊れる不変条件(スレッドの制約、呼び出し順、寿命、所有権、再入の禁止)。
- 外部 API、OS、ライブラリの癖と、回避を削除できる条件。
- 一見不要に見える処理を残す理由(消すと起きることを 1 文で)。
- 一見あるべきガードが無い理由。
- 互換の制約(旧形式のデータ、旧キー、版の番号の意味)。版ごとの変更の列挙は資料へ移す候補にする。
- 名前で表せない単位、座標系、値域、0 や空の意味。
- 数値の根拠(なぜその値か)。値そのものの繰り返しは消す。
- 仕様の正本(資料の節)への参照。

## 作業ディレクトリ
D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/worktrees/parallel/P01

## 必ず読むもの
- C:/Users/mss02968/.claude/skills/comment-writing/SKILL.md
- D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/criteria-parallel.md

## 担当ファイルの状態
- src/crlf/retry.js: 基準; 3行を超えるブロック: 1-6

## 禁止事項
- 変えてよいのはコメントだけである。コードのトークン(識別子、リテラル、記号)と文字列リテラルは 1 つも変えない。テストの名前を表す文字列も含む。
- 命名の変更、定数化、関数分割でコメントを不要にする案は実施せず、候補として報告する。
- 設計資料は変更しない。資料へ移すべき内容は報告する。
- ライセンス表記、ツールが解釈する注記(警告の抑制など)、書式整形ツールが付ける閉じ括弧の注記、引数の注記(`/*name*/ value`)は変えない。
- 行末、BOM、末尾の改行は変えない。
担当ファイル以外は変更しない。

## 検証
作業の後に次のコマンドで検査する。検査を実行できなければ、その理由を報告する。
```powershell
& 'D:/Program Files/nodejs/node.exe' 'D:/Desktop/Develop/ai-comment-tidy-stage5/bin/comment-tidy.js' 'check' '--offline' '--repo' 'D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/worktrees/parallel/P01' '--base-dir' 'D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/work/parallel/base/P01' '--hashes' 'D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/work/parallel/base/P01.hashes.json' '--config' 'D:/Desktop/Develop/ai-comment-tidy/.cross-review/stage5-repo/.comment-tidy/config.json' '--files' 'src/crlf/retry.js'
```

## 報告
「あなたの判断が必要なこと」「やったこと」「見つけた未対応の問題」の3つの見出しで報告する。
「やったこと」の最後に、次の形の JSON を1つ置く。候補が無ければ空の配列とする。
lines は基準の行番号で書く。各候補は file、lines、summary を持つ。
```json
{
  "docsCandidates": [],
  "needsDecision": [],
  "codeImprovements": []
}
```
