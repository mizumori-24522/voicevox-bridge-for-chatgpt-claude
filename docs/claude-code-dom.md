# claude.ai/code の DOM 調査メモ

src/sites/claude-code.ts（案 A）を作るための下調べ。
実装時は、下のコメントをそのまま claude-code.ts の冒頭に置く想定で書いている。

```ts
/**
 * Claude Code Web（claude.ai/code）の DOM 依存を全てこのモジュールへ隔離する。
 * UI 変更時はここだけを直せばよい。生成CSSクラス名には依存しない。
 *
 * ■ 2026-11-10 に実機で確認した構造（通常チャットと同じ部品が多い）
 *   <div role="feed" data-perf-region="transcript">
 *     <div data-testid="transcript-rows">
 *       <div data-testid="transcript-row" data-perf-row="human|assistant"     ← 仮想化される行
 *            data-perf-row-streaming="false" [data-last-message="true"]>
 *         <div role="article"><div data-epitaxy-entry="<msg_… か uuid>">
 *           ── 質問の行 ──
 *           <h3>あなたの入力: …</h3>                                         ← 読み上げ用の見出し（読まない）
 *           <div data-cds="UserMessage" data-turn-key="<uuid>">
 *             <div data-cds="MessageAttachments">                            ← 添付画像（あれば）
 *             <div data-testid="user-message">                               ← 質問の本文
 *             <div data-testid="user-message-actions" data-cds="MessageActions">
 *           ── 回答の行 ──
 *           <div data-testid="assistant-message" data-cds="AssistantMessage"
 *                data-turn-key="<鍵>" [data-is-streaming="false"]>
 *             <h3>Claude の応答：…</h3>                                       ← 読み上げ用の見出し（読まない）
 *             <div>                                                          ← 本文の列
 *               <div data-cds="TurnStatus" data-tool-anchor="toolu_…">        ← ツール実行の行（読まない）
 *                 <div data-cds-row-title="実行しました コマンド">…
 *                 <span data-cds="DiffIndicator">+368 368件追加、0件削除</span> ← 差分の行数（読まない）
 *               <div data-cds="Banner">このステップにはご自身のコンピューターが必要です…</div>
 *                                                                            ← 案内の枠。本文の列の中にある（読まない）
 *               <div data-transcript-engine-root>
 *                 <div data-cds="Prose"><div data-alluvium="true"><p>…        ← 本文
 *             <div data-testid="message-actions" data-cds="MessageActions">  ← コピー等のボタン列
 *     <div data-testid="transcript-after-rows">                              ← 行の外。承認カードや進行表示
 *       <div data-testid="transcript-tail-chrome">
 *         <div data-cds="AssistantMessage" data-code-own-row>                ← testid の無い AssistantMessage（拾わない）
 *           <div data-cds="TurnStatus">                                      ← 実行中のツールの行がここへ移される
 *           <div data-testid="code-working-line" data-turn-working="true|false">
 *             <span role="status">処理中…</span>
 *   入力欄: <div data-testid="code-prompt-input" contenteditable="true" role="textbox"
 *               data-cds="Editor" aria-label="プロンプト">（親は data-cds="ChatComposer"）
 *   送信:   <button data-testid="code-prompt-send" aria-label="送信">（入力欄が空のときは出ない）
 *   停止:   <button data-testid="code-prompt-stop" aria-label="停止">（返答中だけ出る）
 *   会話の URL: /code/session_<英数字>（新規作成は /code）
 *
 * ■ 通常チャットとの大きな違い：1 回の返答が何行にも分かれる
 *   Claude Code の 1 回の返答は「文章の行」と「ツール実行の行」が交互に並び、
 *   それぞれが別の transcript-row / assistant-message になる。
 *   - Remote Control のセッションでは、1 回の返答の行がすべて同じ data-turn-key を持つ。
 *   - 古いクラウドのセッションでは、行ごとに data-turn-key="msg_…" が違い、
 *     1 行の中に TurnStatus と本文の両方が入っていた。
 *   どちらでも通用する区切りは「最後の質問の行より後ろにある回答の行すべて」。
 *   本文（Prose）を持たない行もある（ツールだけの行、確認の質問カードの行）。
 *   確認の質問カード（AskUserQuestion）は data-tool-anchor の枠だけで Prose が無い。
 *
 * ■ 生成中の見分け方
 *   - code-working-line の data-turn-working="true"（返答中ずっと true。ツールの合間も含む）
 *   - 停止ボタン code-prompt-stop がある
 *   - 通常チャットの data-is-streaming="true" は付かない。
 *     返答中の行には data-is-streaming 属性そのものが無く、終わった返答の最初の行だけ "false" が付いていた。
 *   - data-perf-row-streaming は返答中も "false" のままだった。
 */
```

## 2026-11-11 実装後に実機で確かめたこと

Remote Control のセッション（Chrome で開いた claude.ai/code）に、新しい読み上げの仕組みだけを差し込み、
読み上げに回す文章を記録して確かめた。

- 返答中の印（`data-turn-working="true"`）を見て、返答の頭から順に読み上げへ回せた。
- ツールの行（「実行しました」「Claude-in-chrome を使用しました」、差分の行数）は1つも混ざらなかった。
- ツールを動かしている間の休みのあとに出た文章も、続きから読めた。同じ文を二度読むことは無かった。
- 長い返答で質問の行が上へ流れて DOM から消えていても、同じ返答として扱えた。
- **Chrome に表示される途中経過の文章は、アプリ側で書かれた文章と言い回しが少し違うことがある**
  （要約されたような表示）。読み上げは Chrome の画面に出ている文章を読む。

## 確かめられなかったこと

- デスクトップアプリから新しい質問を送ったときに、Chrome 側で読み始めるか（次のやり取りで確かめる）。
- 実際の声での読み上げ（音を出す部分はチャット版と共通。新しい版を Tampermonkey に入れてから確かめる）。
- クラウドのセッションで、返答が流れている最中の動き（確かめたのは Remote Control のセッションだけ）。
- /code で送信した直後に URL が /code/session_… へ変わるタイミング。
- 差分を開いたときの中身。TurnStatus の中に出るはずなので、TurnStatus ごと読み飛ばせば足りる見込み。

## 1.0.0 までの版が /code で動いていた様子（実装前の記録）

detectSite は claude.ai をすべて Claude 用と判定するので、/code でもパネルが出て、
各行に「この回答を読む」「この質問を読む」ボタンが付いていた。
ただし conversationKey が /chat/ しか見ないので、自動の読み上げは始まらなかったはず。
feature/claude-code ブランチで、/code の画面は src/sites/claude-code.ts が読むようにした。
