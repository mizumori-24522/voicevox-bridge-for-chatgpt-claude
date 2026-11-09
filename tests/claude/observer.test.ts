import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatObserver } from '../../src/observer';
import { ClaudeAdapter, claudeSite } from '../../src/sites/claude';
import { DEFAULT_SANITIZE_OPTIONS } from '../../src/speech-sanitizer';

/** Claude の読み飛ばし規則を入れた設定 */
const OPTS = { ...DEFAULT_SANITIZE_OPTIONS, site: claudeSite.sanitize };

/** 回答 1 つ分。実際の claude.ai (2026-10-03 時点) を写した最小構造。 */
function assistantHtml(id: string, body = ''): string {
  return `<div data-testid="transcript-row" data-perf-row="assistant">
     <div data-testid="assistant-message" data-cds="AssistantMessage"
          data-turn-key="${id}" data-is-streaming="false">
       <h2 class="sr-only">Claudeが返答しました:</h2>
       <div>
         <div data-transcript-engine-root>
           <div data-cds="Prose"><div data-perf-reply-text>${body}</div></div>
         </div>
       </div>
     </div>
   </div>`;
}

function userHtml(key: string, text: string): string {
  return `<div data-testid="transcript-row" data-perf-row="human">
     <div data-cds="UserMessage" data-turn-key="${key}">
       <div data-testid="user-message">${text}</div>
     </div>
   </div>`;
}

class FakeChat {
  private turn = 0;
  constructor() {
    document.body.innerHTML = '<main id="main"></main>';
  }
  private get main() {
    return document.getElementById('main')!;
  }
  addUser(text: string): void {
    this.turn++;
    this.main.insertAdjacentHTML('beforeend', userHtml(`u${this.turn}`, text));
  }
  /** 回答の枠を足し、本文を書き込む要素を返す */
  addAssistant(id: string): HTMLElement {
    this.turn++;
    this.main.insertAdjacentHTML('beforeend', assistantHtml(id));
    return this.main.querySelector(`[data-turn-key="${id}"] [data-perf-reply-text]`) as HTMLElement;
  }
  /** 画面外へスクロールした行が仮想化で DOM から落ちる挙動 */
  virtualize(id: string): void {
    this.main.querySelector(`[data-turn-key="${id}"]`)?.closest('[data-testid="transcript-row"]')?.remove();
  }
  startGenerating(): void {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="chat-input-stop" id="stopbtn"></button>',
    );
  }
  stopGenerating(): void {
    document.getElementById('stopbtn')?.remove();
  }
}

/** 起動後に会話がまとめて描画される（リロード直後）状況 */
class FakeChat2 {
  renderExistingAnswer(html: string): void {
    document.getElementById('main')!.insertAdjacentHTML('beforeend', assistantHtml('existing', html));
  }
}

function makeObserver(readOnOpen = false) {
  const chunks: string[] = [];
  const opened: string[] = [];
  let stops = 0;
  const observer = new ChatObserver({
    adapter: new ClaudeAdapter(),
    getEnabled: () => true,
    getSanitizeOptions: () => OPTS,
    getChunkerOptions: () => ({
      minimumChunkLength: 10,
      preferredChunkLength: 40,
      maximumChunkLength: 60,
    }),
    onChunk: (t) => chunks.push(t),
    onNewUserMessage: () => stops++,
    getReadOnOpen: () => readOnOpen,
    onOpenChat: (content) => opened.push((content.textContent ?? '').trim()),
  });
  return { observer, chunks, opened, getStops: () => stops };
}

/** MutationObserver/rAF を待たず、内部ポーリング相当を直接叩く */
const pump = () => vi.advanceTimersByTime(200);
/** 本文の増加が止まって「生成完了」と判定されるまで進める */
const settle = () => vi.advanceTimersByTime(1500);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    setTimeout(() => cb(0), 0);
    return 0;
  });
});

describe('ChatObserver', () => {
  it('streams chunks once and only once', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();

    chat.addUser('質問です');
    chat.startGenerating();
    const content = chat.addAssistant('a1');

    content.innerHTML = '<p>ジャンクションとは、魔法を能力値に装備する仕組みです。</p>';
    pump();
    // 同じ本文を何度観測しても増えない
    pump();
    pump();
    expect(chunks).toEqual(['ジャンクションとは、魔法を能力値に装備する仕組みです。']);

    content.innerHTML =
      '<p>ジャンクションとは、魔法を能力値に装備する仕組みです。たとえば力にファイガを装備します。</p>';
    pump();
    chat.stopGenerating();
    settle();

    expect(chunks).toEqual([
      'ジャンクションとは、魔法を能力値に装備する仕組みです。',
      'たとえば力にファイガを装備します。',
    ]);
    observer.stop();
  });

  it('does not read messages that already existed at startup', () => {
    const chat = new FakeChat();
    const content = chat.addAssistant('old');
    content.innerHTML =
      '<p>これは起動前からある古い回答です。読んではいけません。仮想化されていても読んではいけません。</p>';

    const { observer, chunks } = makeObserver();
    observer.start();
    pump();
    settle();
    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('does not read an existing answer that renders after startup (page reload)', () => {
    // リロード直後は main が空で、会話は少し遅れて描画される。
    // これを「新しい回答」と誤認して読み上げてしまうバグの回帰テスト。
    new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    const chat2 = new FakeChat2();
    chat2.renderExistingAnswer(
      '<p>開いただけの過去の回答です。ページ描画が遅れただけで、新規生成ではありません。</p>',
    );
    pump();
    settle();

    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('fires onNewUserMessage when a follow-up question is sent', () => {
    const chat = new FakeChat();
    chat.addUser('前の質問');
    const { observer, getStops } = makeObserver();
    observer.start();
    pump();
    expect(getStops()).toBe(0);

    chat.addUser('新しい質問');
    pump();
    expect(getStops()).toBe(1);
    pump();
    expect(getStops()).toBe(1);
    observer.stop();
  });

  it('does not treat a question rendered on page load as a new one', () => {
    const chat = new FakeChat();
    const { observer, getStops } = makeObserver();
    observer.start();
    pump();
    chat.addUser('描画が遅れただけの過去の質問');
    pump();
    expect(getStops()).toBe(0);
    observer.stop();
  });

  it('fires onNewUserMessage on submit', () => {
    new FakeChat();
    const { observer, getStops } = makeObserver();
    observer.start();
    observer.notifySubmitted();
    expect(getStops()).toBe(1);
    observer.stop();
  });

  it('skips code blocks but keeps the surrounding prose', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();

    chat.startGenerating();
    const content = chat.addAssistant('a2');
    content.innerHTML =
      '<p>次のように書きます。</p><pre><code>const answer = 42;</code></pre><p>これで動作します。</p>';
    pump();
    chat.stopGenerating();
    settle();

    const all = chunks.join(' ');
    expect(all).not.toContain('const answer');
    expect(all).toContain('ここにコードがあります。');
    expect(all).toContain('これで動作します。');
    observer.stop();
  });

  it('does not read when a reload renders both the question and the answer late', () => {
    // 実機で起きたバグ: リロード直後は main が空で、少し遅れて
    // 「過去の質問」と「過去の回答」がまとめて描画される。
    // 過去の質問の出現を「今、質問が送られた」と誤認して読み上げていた。
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    chat.addUser('VoiceVoxテスト用に短く返答してください');
    const c = chat.addAssistant('past');
    c.innerHTML = '<p>もちろんです。VOICEVOXの音声テスト、こちらは正常に返答中です。</p>';
    pump();
    settle();

    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('does not read when navigating to another chat in the sidebar', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    // SPA 遷移: URL が変わって別の会話がまとめて描画される
    history.pushState({}, '', '/chat/other-chat');
    document.getElementById('main')!.innerHTML = '';
    chat.addUser('別の会話の質問');
    const c = chat.addAssistant('other');
    c.innerHTML = '<p>別の会話の、前からある回答です。読んではいけません。</p>';
    pump();
    settle();

    expect(chunks).toEqual([]);
    observer.stop();
    history.pushState({}, '', '/');
  });

  it('reads the answer after a question is submitted in a brand-new chat', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    // 新規チャットでは送信前に既知の質問が無い。送信操作そのものを根拠にする。
    observer.notifySubmitted();
    history.pushState({}, '', '/chat/new-chat');
    chat.addUser('はじめての質問');
    pump();
    const c = chat.addAssistant('first');
    c.innerHTML = '<p>はじめての回答です。これは読むべきです。</p>';
    pump();
    settle();

    expect(chunks.join(' ')).toContain('これは読むべきです。');
    observer.stop();
    history.pushState({}, '', '/');
  });

  it('reads the answer to a follow-up question in an open chat', () => {
    const chat = new FakeChat();
    chat.addUser('前の質問');
    chat.addAssistant('prev').innerHTML = '<p>前の回答です。これは読まない。</p>';

    const { observer, chunks } = makeObserver();
    observer.start();
    pump();
    settle();
    expect(chunks).toEqual([]);

    // 送信検出が取れなくても、同じ会話に質問が増えたことで分かる
    chat.addUser('次の質問');
    pump();
    const c = chat.addAssistant('next');
    c.innerHTML = '<p>次の回答です。これは読むべきです。</p>';
    pump();
    settle();

    expect(chunks.join(' ')).toContain('これは読むべきです。');
    expect(chunks.join(' ')).not.toContain('これは読まない');
    observer.stop();
  });

  it('does not keep reading later chats after one answer (armed is consumed)', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    chat.addUser('質問');
    pump();
    chat.addAssistant('a').innerHTML = '<p>今の質問への回答です。読む。</p>';
    pump();
    settle();
    const n = chunks.length;
    expect(n).toBeGreaterThan(0);

    // 別の会話へ移動 → そこの最新回答は読まない
    history.pushState({}, '', '/chat/elsewhere');
    document.getElementById('main')!.innerHTML = '';
    chat.addUser('よその質問');
    chat.addAssistant('b').innerHTML = '<p>よその会話の前からある回答です。読まない。</p>';
    pump();
    settle();

    expect(chunks.length).toBe(n);
    observer.stop();
    history.pushState({}, '', '/');
  });

  it('still reads a genuinely new answer that grows from empty', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    // 生成中フラグは取れないが、質問は送られている = 本物の新規回答
    observer.notifySubmitted();
    chat.addUser('新しい質問');
    pump();
    const content = chat.addAssistant('fresh');
    content.innerHTML = '<p>新しい</p>';
    pump();
    content.innerHTML = '<p>新しい回答が少しずつ伸びてきています。これは読むべきです。</p>';
    pump();
    settle();

    expect(chunks.join(' ')).toContain('これは読むべきです。');
    observer.stop();
  });

  it('finishes reading even when the stop button is never detected', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();

    // startGenerating() を呼ばない = 生成中フラグが一切取れないケース
    observer.notifySubmitted();
    chat.addUser('質問です');
    pump();
    const content = chat.addAssistant('a3');
    content.innerHTML = '<p>停止ボタンが取れなくても最後まで読み切ります。</p>';
    pump();
    settle();

    expect(chunks.join(' ')).toContain('停止ボタンが取れなくても最後まで読み切ります。');
    observer.stop();
  });

  it('survives virtualization dropping an older turn', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();

    chat.startGenerating();
    const c1 = chat.addAssistant('a1');
    c1.innerHTML = '<p>最初の回答です。ここまでが一つ目です。</p>';
    pump();
    chat.stopGenerating();
    settle();
    const afterFirst = chunks.length;

    // 画面外になった古いターンの中身が DOM から消える
    chat.virtualize('a1');
    pump();
    settle();
    expect(chunks.length).toBe(afterFirst);
    observer.stop();
  });

  it('starts a fresh buffer for the next assistant message', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();

    chat.startGenerating();
    const c1 = chat.addAssistant('a1');
    c1.innerHTML = '<p>一つ目の回答です。これで終わりです。</p>';
    pump();
    chat.stopGenerating();
    settle();
    const afterFirst = chunks.length;

    chat.addUser('二つ目の質問');
    chat.startGenerating();
    const c2 = chat.addAssistant('a2');
    c2.innerHTML = '<p>二つ目の回答です。まったく別の内容です。</p>';
    pump();
    chat.stopGenerating();
    settle();

    const second = chunks.slice(afterFirst).join(' ');
    expect(second).toContain('二つ目の回答です。');
    expect(second).not.toContain('一つ目の回答');
    observer.stop();
  });
});

describe('ChatObserver: 回答ターンの ID 差し替え', () => {
  /** 回答ターンの ID を付け替える（仮の枠 → 本物の ID に置き換わる挙動） */
  function swapAssistantId(from: string, to: string): HTMLElement {
    const msg = document.querySelector(`[data-turn-key="${from}"]`)!;
    msg.setAttribute('data-turn-key', to);
    return msg.querySelector('[data-perf-reply-text]') as HTMLElement;
  }

  it('keeps reading when the answer turn changes its id mid-stream', () => {
    const chat = new FakeChat();
    chat.addUser('前の質問');
    chat.addAssistant('prev').innerHTML = '<p>前の回答です。これは読まない。</p>';
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();
    settle();

    observer.notifySubmitted();
    chat.addUser('次の質問');
    pump();
    const c = chat.addAssistant('placeholder');
    c.innerHTML = '<p>一文目の回答です。</p>';
    pump();
    const c2 = swapAssistantId('placeholder', 'real');
    c2.innerHTML = '<p>一文目の回答です。二文目もちゃんと読みます。</p>';
    pump();
    settle();

    const all = chunks.join(' ');
    expect(all).toContain('一文目の回答です。');
    expect(all).toContain('二文目もちゃんと読みます。');
    // 差し替えで頭から読み直さない
    expect(all.split('一文目の回答です。').length - 1).toBe(1);
    expect(all).not.toContain('これは読まない');
    observer.stop();
  });

  it('keeps reading in a brand-new chat when the URL is confirmed and the turn is re-mounted', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    chat.addUser('はじめての質問');
    pump();
    const c = chat.addAssistant('tmp');
    c.innerHTML = '<p>最初の文です。</p>';
    pump();

    // URL が /chat/... に確定し、会話が本物の ID で描き直される
    history.pushState({}, '', '/chat/confirmed');
    document.getElementById('main')!.innerHTML = '';
    chat.addUser('はじめての質問');
    chat.addAssistant('server').innerHTML = '<p>最初の文です。続きの文も読みます。</p>';
    pump();
    settle();

    const all = chunks.join(' ');
    expect(all).toContain('続きの文も読みます。');
    expect(all.split('最初の文です。').length - 1).toBe(1);
    observer.stop();
    history.pushState({}, '', '/');
  });

  it('still reads when the answer text starts after a long thinking pause', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    chat.addUser('考える質問');
    pump();
    const c = chat.addAssistant('think');
    pump();
    // 本文が出るまで数秒かかる（思考中）
    vi.advanceTimersByTime(5000);
    swapAssistantId('think', 'answer').innerHTML = '<p>考えた末の回答です。</p>';
    void c;
    pump();
    settle();

    expect(chunks.join(' ')).toContain('考えた末の回答です。');
    observer.stop();
  });

  it('does not re-read from the top after a momentary empty render', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    chat.addUser('質問');
    pump();
    const c = chat.addAssistant('flicker');
    c.innerHTML = '<p>ちらつく前の文です。</p>';
    pump();
    c.innerHTML = '';
    pump();
    c.innerHTML = '<p>ちらつく前の文です。その後の文です。</p>';
    pump();
    settle();

    const all = chunks.join(' ');
    expect(all.split('ちらつく前の文です。').length - 1).toBe(1);
    expect(all).toContain('その後の文です。');
    observer.stop();
  });

  it('does not read another chat opened right after submitting', () => {
    history.pushState({}, '', '/chat/current');
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    history.pushState({}, '', '/chat/somewhere-else');
    chat.addUser('よその質問');
    chat.addAssistant('elsewhere').innerHTML = '<p>よその会話の前からある回答です。</p>';
    pump();
    settle();

    expect(chunks).toEqual([]);
    observer.stop();
    history.pushState({}, '', '/');
  });
});

describe('ClaudeAdapter.onSubmit', () => {
  function composer(text: string) {
    document.body.innerHTML = `<main><div data-testid="chat-input" contenteditable="true" role="textbox"><p>${text}</p></div>
      <button data-testid="chat-input-send" type="button" aria-label="メッセージを送信"></button></main>`;
    return document.querySelector('[data-testid="chat-input"]') as HTMLElement;
  }
  const enter = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init });

  it('fires on Enter in the composer', () => {
    const box = composer('質問です');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    box.dispatchEvent(enter());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores Enter that confirms a Japanese IME conversion', () => {
    const box = composer('しつもん');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    box.dispatchEvent(enter({ isComposing: true }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores Shift+Enter (newline) and an empty composer', () => {
    const box = composer('質問');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    box.dispatchEvent(enter({ shiftKey: true }));
    box.textContent = '';
    box.dispatchEvent(enter());
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires on the send button', () => {
    composer('質問');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    (document.querySelector('[data-testid="chat-input-send"]') as HTMLElement).click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores Enter typed outside the composer', () => {
    composer('質問');
    const other = document.createElement('input');
    document.body.appendChild(other);
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    other.dispatchEvent(enter());
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('回答の ID が後から付く場合', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="main"></main>';
  });

  it('starts reading even if the turn key only appears after streaming starts', () => {
    const chat = new FakeChat();
    const { observer, chunks } = makeObserver();
    observer.start();
    pump();

    observer.notifySubmitted();
    chat.addUser('質問');
    const body = chat.addAssistant('pending');
    const msg = body.closest('[data-testid="assistant-message"]')!;
    msg.removeAttribute('data-turn-key');
    body.innerHTML = '<p>最初はIDがありません。</p>';
    pump();
    msg.setAttribute('data-turn-key', 'late-id');
    body.innerHTML = '<p>最初はIDがありません。あとからIDが付きます。</p>';
    pump();
    settle();

    const all = chunks.join(' ');
    expect(all).toContain('あとからIDが付きます。');
    expect(all.match(/最初はIDがありません。/g)?.length).toBe(1);
    observer.stop();
  });
});

describe('チャットを開いたら最新の回答を読む', () => {
  function turn(key: string, answerId: string, text: string) {
    document.getElementById('main')!.insertAdjacentHTML(
      'beforeend',
      userHtml(key, `質問 ${key}`) + assistantHtml(answerId, `<p>${text}</p>`),
    );
  }

  beforeEach(() => {
    document.body.innerHTML = '<main id="main"></main>';
    history.pushState({}, '', '/chat/chat-a');
  });

  it('reads the latest answer once the page settles', () => {
    turn('t1', 'a1', '古いほうの回答です。');
    turn('t2', 'a2', '最新の回答です。');
    const { observer, opened, chunks } = makeObserver(true);
    observer.start();
    pump();
    settle();
    pump();
    expect(opened).toEqual(['最新の回答です。']);
    // 逐次読み上げ側では二重に読まない
    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('waits for virtualized rendering instead of reading an older answer first', () => {
    const { observer, opened } = makeObserver(true);
    observer.start();
    turn('t1', 'a1', '先に描画された古い回答です。');
    pump();
    // 1 秒経たないうちに、本当の最新が描画される
    turn('t2', 'a2', '本当の最新の回答です。');
    pump();
    settle();
    pump();
    expect(opened).toEqual(['本当の最新の回答です。']);
    observer.stop();
  });

  it('reads again when switching to another chat', () => {
    turn('t1', 'a1', 'Aの回答です。');
    const { observer, opened } = makeObserver(true);
    observer.start();
    pump();
    settle();
    pump();

    history.pushState({}, '', '/chat/chat-b');
    document.getElementById('main')!.innerHTML = '';
    turn('u1', 'b1', 'Bの回答です。');
    pump();
    settle();
    pump();
    expect(opened).toEqual(['Aの回答です。', 'Bの回答です。']);
    observer.stop();
  });

  it('does nothing when the setting is off', () => {
    turn('t1', 'a1', '読まない回答です。');
    const { observer, opened, chunks } = makeObserver(false);
    observer.start();
    pump();
    settle();
    pump();
    expect(opened).toEqual([]);
    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('gives way to a question sent right after opening', () => {
    turn('t1', 'a1', '開いた直後の回答です。');
    const { observer, opened } = makeObserver(true);
    observer.start();
    pump();
    observer.notifySubmitted();
    settle();
    pump();
    expect(opened).toEqual([]);
    observer.stop();
  });

  it('does not read on the new-chat screen', () => {
    history.pushState({}, '', '/');
    const { observer, opened } = makeObserver(true);
    observer.start();
    pump();
    settle();
    pump();
    expect(opened).toEqual([]);
    observer.stop();
  });
});
