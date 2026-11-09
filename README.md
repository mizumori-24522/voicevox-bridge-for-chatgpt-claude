# VOICEVOX Bridge for ChatGPT & Claude

ChatGPT Web（chatgpt.com）と Claude Web（claude.ai のチャットと、Claude Code の claude.ai/code）の回答を、**生成の途中から VOICEVOX の好きなキャラクターの声で**読み上げる、Chrome 用の UserScript（Tampermonkey）です。

1本のスクリプトで両方のサイトに対応します。開いているサイトを見分けて、そのサイト用の読み取り方に切り替えます。

![Claude の画面。右下に VOICEVOX パネル、その左に話者を選ぶメニューが開いている](docs/claude-panel.png)

> **非公式ツールです。** OpenAI・Anthropic・VOICEVOX とは関係ありません。
> 以前の [chatgpt-voicevox-bridge](https://github.com/mizumori-24522/chatgpt-voicevox-bridge) と [claude-voicevox-bridge](https://github.com/mizumori-24522/claude-voicevox-bridge) を1つにまとめたものです。

## できること

- **回答が出始めた瞬間から読み上げ**：全文がそろうのを待たず、書かれた順に読みます
- **キャラクターとスタイルを顔アイコンで選べる**：最近使った5つと★お気に入りが一番上に並びます
- **自分の質問は別の声で読める**：回答と質問に違うキャラクターを割り当てられます
- **一時停止して続きから読める**：「⏸ 一時停止」し、「▶ 再開」で止めた位置から続けます
- **過去の発言を読み直せる**：発言にマウスを乗せると出る「🔊 この回答を読む」「🔊 この質問を読む」から。ドラッグで選んだ部分だけ読むこともできます
- **コード・表・URL は読み方を選べる**：「ここにコードがあります」と伝えるだけにする、など
- **会話を外部に送らない**：API キーは不要で、通信先は開いているサイト自身と手元の VOICEVOX だけです

## 導入

必要なものは、Chrome 系ブラウザ、[Tampermonkey](https://www.tampermonkey.net/)、[VOICEVOX](https://voicevox.hiroshiba.jp/)（アプリまたは Engine 単体）です。macOS で確認しています。

1. **VOICEVOX を起動する**
2. **Chrome に Tampermonkey を入れ**、`chrome://extensions` の「詳細」で **「ユーザー スクリプトを許可する」を ON** にする
3. **次の URL を Chrome で開き**、出てきた画面で「インストール」を押す

   ```
   https://raw.githubusercontent.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude/main/dist/voicevox-bridge.user.js
   ```

4. **https://chatgpt.com か https://claude.ai を開く**。右下のパネルの ● が緑になり、`v0.xx.x` と出れば接続成功です
5. 話者を選び、「詳細設定 → テスト発声」で音が出ることを確認する

- **更新**：新しい版は Tampermonkey が自動で取り込みます（既定で 1 日 1 回確認）。すぐ欲しいときは、Tampermonkey のダッシュボードの「ユーティリティ」→「インストール済みスクリプトの更新を確認」
- **対象**：Chrome で開いたチャット画面と、claude.ai/code（Claude Code の Web 版）です。各デスクトップアプリ版では動きません
- **Claude Code で使うとき**：Claude Code の返答は、Claude が話しかけてくる文章だけを読み、コマンドの実行や差分の表示は読み飛ばします。デスクトップアプリでやり取りしながら、Chrome で同じセッションの claude.ai/code を開いておくと、Chrome 側が新しい返答を読み上げます（Chrome の一覧に並ぶクラウドと Remote Control のセッションが対象。ローカルのセッションは Chrome に出ないので読めません）
- **設定**：サイトごとに別々に保存されます（ChatGPT と Claude で違う声にできます）

### 以前の2本から移るとき

1. 上の手順でこのスクリプトを入れる
2. Tampermonkey で **「ChatGPT → VOICEVOX Bridge」と「Claude → VOICEVOX Bridge」をオフ**にする（両方オンのままだと二重に読みます）
3. 両方のサイトで読み上げられることを確かめたら、古い2本は削除して構いません

話者や速さなどの設定は、以前と同じ保存場所（サイトごとの `localStorage`）を使うので、そのまま引き継がれます。

## 使い方

### パネル

| 項目 | 内容 |
| --- | --- |
| ● | VOICEVOX との接続状態（緑=接続中 / 黄=試行中 / 灰=未接続）。見出しを押すとパネルを畳めます |
| 話者 | 回答を読む声 |
| 質問 | 自分の質問を読む声。選ばなければ回答と同じ声 |
| 話速 / 音量 / 文間 | 速さ、大きさ、文と文の間の無音の長さ（箇条書きの切り替わりの速さに効きます） |
| 🔊 ON | 読み上げの有効・無効 |
| ⏸ 一時停止 / ▶ 再開 | 今の文の途中で止め、再開すると止めた位置から続きを読む。止めている間に届いた続きも貯めておく |
| ■ STOP | 今の読み上げをやめる（待っている分も捨てる） |
| 🔈 選択した部分を読む | ドラッグで選んだ範囲だけを読む |
| 詳細設定 | コード・URL・表の読み方、ファイル名の記号（`_ - . /`）を読むか、チャットを開いたら最新の回答を読むか、新しい質問で読み上げを止めるか、デバッグログ、テスト発声、再接続 |

### 話者を選ぶメニュー

「話者」または「質問」を押すと開きます。左のキャラクターにマウスを乗せると、右にスタイル（ノーマル・ささやき など）が出ます。上の欄に文字を入れると絞り込めます。

- **最近使った**：最近選んだ5つ。押すとその場で決定
- **★ お気に入り**：キャラクターの行の右端の ☆ を押すと、ここに固定されます
- **すべてのキャラ**：それ以外の全員。見出しを押すと畳めるので、畳んでおけばよく使う話者だけが並びます

### 過去の発言を読む

発言にマウスを乗せると「🔊 この回答を読む」「🔊 この質問を読む」が出ます。置き場所は、本文やサイト自身のボタン列と重ならないよう、サイトごとに変えてあります。

| サイト | 回答のボタン | 質問のボタン |
| --- | --- | --- |
| Claude | 回答の左上 | 吹き出しの右上 |
| ChatGPT | 回答の上の中央 | 吹き出しの下、コピー・編集ボタンのすぐ左 |

### 読み方を直したいとき

VOICEVOX 本体の **「読み方＆アクセント辞書」** がそのまま効きます。`NVIDIA → エヌビディア` のように登録すれば、次の読み上げから反映されます。

## 困ったとき

| 症状 | 対処 |
| --- | --- |
| ● が灰色（未接続） | VOICEVOX を起動してから、詳細設定の「再接続」 |
| 「再生がブロックされました」 | ページを一度クリックしてから質問し直す（ブラウザの自動再生制限のため） |
| 同じ文を二重に読む | 古い「ChatGPT → / Claude → VOICEVOX Bridge」がオンのままでないか確認する |
| 読み上げが始まらない | パネルが 🔊 ON か確認する |
| パネルが出ない | Tampermonkey でスクリプトが有効か確認する |
| 途中で止まる | 詳細設定の「デバッグログ」を ON にし、Console の `[Observer]` のログを添えて [Issues](https://github.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude/issues) へ |

## プライバシー

通信先は開いているサイト自身と、手元の VOICEVOX（`127.0.0.1:50021`）だけです。解析・ログ送信・読み上げた文章の保存はしません。設定はブラウザの `localStorage`（キー `cvb.settings.v2`）に入ります。

## 今後の予定

| 状態 | 内容 |
| --- | --- |
| 実装予定 | **キーボードの ⏯ キーで一時停止・再開**：Mac の ⏯ キーや AirPods のタップでも操作できるようにする |
| 実装予定 | **一文戻る・一文飛ばす**：パネルに ⏮ ⏭ を足し、聞き逃した文をもう一度読む・長い箇条書きを飛ばす |
| 検討中 | **選んだ位置から最後まで読む**：回答の途中の文から、回答の終わりまで続けて読む |
| 検討中 | **読んでいる文に色を付ける**：今どの文を読んでいるかを、画面上で薄く色付けする |
| 候補 | **入力を始めたら自動で一時停止**：次の質問を話し始めたとき、読み上げの声をマイクが拾わないようにする（音声入力アプリの入力の仕方を調べてから） |
| 候補 | **送った質問も読む**：質問を送った瞬間に、質問用の声で自分の質問を読む（オン／オフで切り替え） |

## 開発者向け

```bash
npm install
npm test            # 単体テスト（vitest）
npm run typecheck
npm run build       # dist/voicevox-bridge.user.js を作る
npm run release     # テスト → 版上げ（1.0.0 → 1.1.0）→ ビルド
npm run release:patch   # 修正だけのとき（1.0.0 → 1.0.1）
```

Tampermonkey は `@version` が上がったときだけ更新を取り込みます。配るときは `release` のあと、`dist/` ごとコミットして push します。

### 構成

サイトごとに違うのは `src/sites/` の中だけです。新しい機能は、たいてい共通部分に1回書けば両方のサイトに効きます。

```
src/
  main.ts                 起動。ホスト名からサイトを選び、共通部分を組み立てる
  sites/
    types.ts              サイト部品の約束事（SiteAdapter など）
    index.ts              detectSite(): claude.ai → Claude、chatgpt.com → ChatGPT
    claude.ts             Claude の DOM の読み方、読み飛ばす部品、ボタンの置き場所
    claude-code.ts        Claude Code（claude.ai/code）の DOM の読み方。1回の返答が何行にも分かれるのをまとめる
    switch-adapter.ts     claude.ai の中で、チャットと /code を URL で切り替える
    chatgpt.ts            ChatGPT の DOM の読み方、ボタンの置き場所
  observer.ts ほか        共通部分
tests/
  claude/  chatgpt/       サイトごとのテスト（実物の DOM を写した最小構造）
  *.test.ts               共通部分のテスト
```

<details>
<summary>モジュールの役割</summary>

| モジュール | 役割 |
| --- | --- |
| `sites/claude.ts` / `sites/chatgpt.ts` | サイトの DOM 依存を全部ここへ隔離。サイトの UI が変わったらここだけ直す |
| `observer.ts` | MutationObserver + 200ms ポーリング。mutation を直接 TTS へ流さない |
| `text-diff.ts` | 「消費済み文字数」を持ち、再描画されても同じ文章を二度読まない |
| `chunker.ts` | `。！？` と改行を境界に、35〜180 文字の自然な単位へ切り出す |
| `speech-sanitizer.ts` | DOM 構造を根拠に、コード・表・URL・出典を処理。サイト固有の読み飛ばしは `sites/` から受け取る |
| `voicevox-client.ts` | `/version` `/speakers` `/audio_query` `/synthesis` |
| `playback-queue.ts` | 合成と再生を分け、喋りながら次を先読み合成する。チャンクごとに話者を指定できる |
| `ui.ts` | Shadow DOM のフローティングパネル（サイトの CSS と干渉しない） |
| `voice-picker.ts` | キャラクター → スタイルの2段メニュー |
| `icon-cache.ts` | 顔アイコンを必要な分だけ取り、同じものは二度取らない |
| `message-actions.ts` | 各回答・各質問へ読み上げボタンを差し込む。位置は `sites/` が決める |

</details>

<details>
<summary>読み上げの細かい挙動</summary>

- Markdown をテキストとして解釈するのではなく、サイトが描画済みの DOM（`<pre>` `<table>` `<a>` など）を見て判定する。生成途中の未閉じコードフェンスに強い。
- 再生中に次のチャンクを先読み合成する（2つ先まで）。再生は常に1本だけで、音声は重ならない。
- チャンク前後の無音は VOICEVOX の既定より短くしてある（`prePhonemeLength=0.0` / `postPhonemeLength=0.05` / `pauseLengthScale=0.9`）。パネルの「文間」は `postPhonemeLength`。
- コードブロックは、罫線で描いた図なら「ここに図があります」、そうでなければ「ここにコードがあります」。既定では1つの回答につき最初の1回だけ知らせる。
- 絵文字は読み上げ前に取り除く。
- 生成中の判定は停止ボタンに依存しきらない。本文の増加が 1.2 秒止まったら完了とみなして残りを読む。
- 開き直しただけの回答は逐次読み上げしない。会話が仮想化されていて、出現だけでは新規と区別できないため、次のいずれかを観測したときだけ読む：送信操作（Enter / 送信ボタン。変換確定の Enter は除く）、同じ会話の中で質問が増えた、生成中。

</details>

<details>
<summary>実測した Claude の DOM（2026-10-03）</summary>

```html
<div data-testid="transcript-row" data-perf-row="human|assistant">   ← 仮想化される行
  <div data-cds="UserMessage"><div data-testid="user-message">…質問…</div></div>
  <div data-testid="assistant-message" data-turn-key="<uuid>-hub-reply"
       data-is-streaming="true|false">
    <h2 class="sr-only">Claudeが返答しました: …</h2>
    <div>
      <div data-cds="TurnStatus">ウェブを検索しました</div>            ← 読まない
      <div data-transcript-engine-root>
        <div data-cds="Prose"><div data-perf-reply-text>…本文…</div></div>
    <div><div data-testid="message-actions">…</div></div>              ← 読まない
```

- 回答の同一性は `data-turn-key`（生成の最初から最後まで変わらない）。質問は本文で同一性を見る
- 送信直後は回答の枠だけが現れ、`data-is-streaming` も本文もまだ無い。生成中の判定は停止ボタン `[data-testid="chat-input-stop"]` と `data-is-streaming="true"` の両方を見る
- 入力欄は `[data-testid="chat-input"]`、送信ボタンは `[data-testid="chat-input-send"]`
- 会話の URL は `/chat/<uuid>`。新規チャット（`/new`）は、送信した瞬間に `/chat/<uuid>` へ変わる
- Web 検索の出典チップは `span[data-not-prose]`、コード枠は `div[role="group"]`（言語名のラベル付き）。出典と言語名は読まない

</details>

<details>
<summary>実測した ChatGPT の DOM（2026-09-26）</summary>

2026-09 下旬に構造が丸ごと変わり、旧来の `data-turn` / `data-message-author-role` が消えた。

```html
<div data-content-search-turn-key="fallback-turn-0">   ← 後で UUID に差し替わる
  <div data-content-search-unit-key="fallback-turn-0:0:user">…質問…</div>
  <div data-content-search-unit-key="fallback-turn-0:2:assistant"
       data-chatgpt-search-message-ids="<回答ID>">
    <div data-markdown-text-style="assistant-message">  ← 本文
```

- 回答の同一性は `data-chatgpt-search-message-ids`（ターンの鍵は途中で変わるので使わない）
- 質問にはメッセージ ID が無いので、本文で同一性を見る
- 入力欄は `[data-composer-body] [contenteditable]`、送信ボタンは `aria-label="送信"`
- アダプタは旧構造にもフォールバックする

</details>

<details>
<summary>実測した ChatGPT の DOM（2026-09-15 / GPT-6 世代 UI）</summary>

```html
<section data-turn="assistant" data-turn-id="<uuid>"
         data-testid="conversation-turn-10">
  <div data-message-author-role="assistant" data-message-id="<uuid>">
    <div class="... markdown prose ...">  ← 本文
```

- 会話は**仮想化**されており、画面外のターンでは内側の `[data-message-author-role]` が DOM から消える。外側の `section[data-turn]` は残るので、そちらを一次の拠り所にしている。
- メッセージ同一性は `data-turn-id`（UUID）→ `data-message-id` の順で採用。
- Web検索の出典は `[data-testid="webpage-citation-pill"]` なので読み上げから除外。

</details>

<details>
<summary>VOICEVOX との通信</summary>

各サイトから `http://127.0.0.1:50021` への直接の `fetch` や `<img>` は、CORS / Private Network Access で止まることがある。そのため通信は Tampermonkey の `GM_xmlhttpRequest` 経由で行い、許可する先は `@connect 127.0.0.1` と `@connect localhost` だけにしている。

顔アイコンは `/speaker_info` を `resource_format=url` で呼んで URL だけ受け取り、表示するものだけバイト列で取って `blob:` URL にしている（既定のままだと、サンプル音声まで同梱されて 1 キャラ 5MB を超える）。

</details>

<details>
<summary>ビルドのたびに入れ直したくない場合</summary>

Tampermonkey のスクリプトを殻だけにして、手元のビルド成果物を直接読ませます。`chrome://extensions` の Tampermonkey で **「ファイルの URL へのアクセスを許可する」を ON** にすると、以後は `npm run build` してページを再読み込みするだけで反映されます。

```js
// ==UserScript==
// @name         VOICEVOX Bridge for ChatGPT & Claude (dev)
// @match        https://claude.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @require      file:///Users/<ユーザー名>/voicevox-bridge-for-chatgpt-claude/dist/voicevox-bridge.user.js
// ==/UserScript==
```

</details>

ChatGPT 版の最初の設計メモは [docs/PLAN-chatgpt.md](docs/PLAN-chatgpt.md) に残してあります。

## クレジット

- 音声合成：[VOICEVOX](https://voicevox.hiroshiba.jp/)
- 画像に写っているキャラクター（VOICEVOX:東北きりたん、VOICEVOX:中国うさぎ ほか）の画像・音声の権利は、それぞれの権利者に帰属します。読み上げた音声を公開・配布するときは、各キャラクターの利用規約に従ってクレジットを表記してください。
