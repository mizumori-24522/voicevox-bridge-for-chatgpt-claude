import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatObserver } from '../../src/observer';
import { ClaudeAdapter, claudeSite } from '../../src/sites/claude';
import { DEFAULT_SANITIZE_OPTIONS, extractSpeechText } from '../../src/speech-sanitizer';

/** Claude の読み飛ばし規則を入れた設定 */
const OPTS = { ...DEFAULT_SANITIZE_OPTIONS, site: claudeSite.sanitize };

/**
 * 実際の claude.ai (2026-10-03 時点) を写した最小構造。
 * [data-testid="assistant-message"][data-turn-key][data-is-streaming] の内側に
 * 進行表示（TurnStatus）と本文（Prose）が並び、その後ろにボタン列が続く。
 */
class FakeClaude {
  private turn = 0;
  constructor() {
    document.body.innerHTML = `<main><div role="feed" id="feed"></div>
      <div data-testid="chat-input" contenteditable="true" role="textbox"></div>
      <button data-testid="chat-input-send" type="button" aria-label="メッセージを送信"></button></main>`;
  }
  private get feed() {
    return document.getElementById('feed')!;
  }
  addUser(text: string): void {
    this.turn++;
    this.feed.insertAdjacentHTML(
      'beforeend',
      `<div data-testid="transcript-row" data-perf-row="human">
         <div data-cds="UserMessage" data-turn-key="t${this.turn}">
           <div data-testid="user-message">${text}</div>
         </div>
       </div>`,
    );
  }
  /** 回答の枠を足し、本文（Prose の中身）を書き込む要素を返す */
  addAssistant(key: string, opts: { streaming?: boolean; status?: string } = {}): HTMLElement {
    const status = opts.status
      ? `<div data-cds="TurnStatus" data-state="done"><bdi>${opts.status}</bdi>
           <span class="sr-only" role="status">${opts.status}</span></div>`
      : '';
    this.feed.insertAdjacentHTML(
      'beforeend',
      `<div data-testid="transcript-row" data-perf-row="assistant">
         <div data-testid="assistant-message" data-cds="AssistantMessage"
              data-turn-key="${key}" data-is-streaming="${opts.streaming ? 'true' : 'false'}">
           <h2 class="sr-only">Claudeが返答しました: 冒頭の文</h2>
           <div>${status}
             <div data-transcript-engine-root>
               <div data-cds="Prose"><div data-perf-reply-text></div></div>
             </div>
           </div>
           <div><div data-testid="message-actions" role="toolbar">
             <button type="button" aria-label="コピー">コピー</button>
           </div></div>
         </div>
       </div>`,
    );
    return this.message(key).querySelector('[data-perf-reply-text]') as HTMLElement;
  }
  message(key: string): HTMLElement {
    return this.feed.querySelector(`[data-turn-key="${key}"]`) as HTMLElement;
  }
  finish(key: string): void {
    this.message(key).setAttribute('data-is-streaming', 'false');
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
    onOpenChat: (content) => opened.push(extractSpeechText(content, OPTS)),
  });
  return { observer, chunks, opened, getStops: () => stops };
}

const pump = () => vi.advanceTimersByTime(200);
const settle = () => vi.advanceTimersByTime(1500);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    setTimeout(() => cb(0), 0);
    return 0;
  });
  history.pushState({}, '', '/new');
});

afterEach(() => {
  history.pushState({}, '', '/');
});

describe('ClaudeAdapter', () => {
  it('finds the latest answer, its body and the conversation key', () => {
    const chat = new FakeClaude();
    chat.addUser('質問です');
    chat.addAssistant('t1-hub-reply').innerHTML = '<p>一つ目の回答です。</p>';
    chat.addUser('次の質問');
    chat.addAssistant('t2-hub-reply').innerHTML = '<p>二つ目の回答です。</p>';

    const adapter = new ClaudeAdapter();
    const latest = adapter.getLatestAssistantMessage()!;
    expect(latest.id).toBe('turn:t2-hub-reply');
    expect(extractSpeechText(latest.content, OPTS)).toBe('二つ目の回答です。');
    expect(adapter.assistantTurns()).toHaveLength(2);
    expect(adapter.getLatestUserMessageId()).toBe('user:次の質問');
    expect(adapter.probe().ok).toBe(true);

    expect(new ClaudeAdapter().conversationKey('/chat/e33616fe-d6dd')).toBe('e33616fe-d6dd');
    expect(new ClaudeAdapter().conversationKey('/new')).toBeNull();
    expect(new ClaudeAdapter().conversationKey('/recents')).toBeNull();
  });

  it('reads only the answer body, not the status line, heading or buttons', () => {
    const chat = new FakeClaude();
    chat.addUser('調べて');
    chat.addAssistant('t1-hub-reply', { status: 'ウェブを検索しました' }).innerHTML =
      '<p>本文です。<span data-not-prose><span><a href="https://example.com">example</a></span></span></p>' +
      '<div data-not-prose><div role="group" aria-label="pythonコード">' +
      '<div><div><button type="button" aria-label="クリップボードにコピー"></button>' +
      '<span role="status" class="sr-only"></span></div></div>' +
      '<div>python</div>' +
      '<div><pre><code>print("hello")</code></pre></div></div></div>' +
      '<p>続きです。</p>';

    const adapter = new ClaudeAdapter();
    const text = extractSpeechText(adapter.getLatestAssistantMessage()!.content, OPTS);
    expect(text).toBe('本文です。\nここにコードがあります。\n続きです。');
  });

  it('finds each question and reads only its text, not the attachments or the action row', () => {
    const chat = new FakeClaude();
    chat.addUser('<p>一つ目の質問です。</p>');
    chat.addAssistant('t1-hub-reply').innerHTML = '<p>回答です。</p>';
    chat.addUser('<p>二つ目の質問です。</p><p>https://example.com/very/long を見て。</p>');
    const second = document.querySelectorAll<HTMLElement>('[data-cds="UserMessage"]')[1];
    second.insertAdjacentHTML('afterbegin', '<div data-cds="MessageAttachments"><img alt="添付画像"></div>');
    second.insertAdjacentHTML(
      'beforeend',
      '<div data-cds="MessageActions"><span data-cds="RelativeTime">55分前</span><button type="button">コピー</button></div>',
    );

    const adapter = new ClaudeAdapter();
    const turns = adapter.userTurns();
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(second);
    expect(extractSpeechText(adapter.contentOfUserTurn(turns[0]), OPTS)).toBe('一つ目の質問です。');
    expect(extractSpeechText(adapter.contentOfUserTurn(turns[1]), OPTS)).toBe(
      '二つ目の質問です。\nリンクがあります。 を見て。',
    );
  });

  it('does not read the action bar when the answer has no body yet', () => {
    const chat = new FakeClaude();
    chat.addUser('質問');
    chat.addAssistant('t1-hub-reply');
    const turn = chat.message('t1-hub-reply');
    turn.querySelector('[data-transcript-engine-root]')!.parentElement!.remove();
    turn.querySelector('[data-testid="message-actions"]')!.setAttribute('data-cds', 'MessageActions');
    turn.querySelector('[data-testid="message-actions"]')!.insertAdjacentHTML('beforeend', '<span>今</span>');

    const adapter = new ClaudeAdapter();
    expect(extractSpeechText(adapter.contentOfTurn(turn), OPTS)).toBe('');
  });

  it('detects generation from the stop button before the body appears', () => {
    const chat = new FakeClaude();
    const adapter = new ClaudeAdapter();
    chat.addUser('質問');
    chat.addAssistant('t1-hub-reply').closest('[data-testid="assistant-message"]')!.removeAttribute('data-is-streaming');
    expect(adapter.isGenerating()).toBe(false);
    document.querySelector('[data-testid="chat-input-send"]')!.setAttribute('data-testid', 'chat-input-stop');
    expect(adapter.isGenerating()).toBe(true);
  });

  it('detects generation from data-is-streaming', () => {
    const chat = new FakeClaude();
    const adapter = new ClaudeAdapter();
    expect(adapter.isGenerating()).toBe(false);
    chat.addUser('質問');
    chat.addAssistant('t1-hub-reply', { streaming: true });
    expect(adapter.isGenerating()).toBe(true);
    chat.finish('t1-hub-reply');
    expect(adapter.isGenerating()).toBe(false);
  });
});

describe('ChatObserver on Claude', () => {
  it('streams a new answer once and only once', () => {
    const chat = new FakeClaude();
    const { observer, chunks } = makeObserver();
    observer.start();

    observer.notifySubmitted();
    chat.addUser('質問です');
    const body = chat.addAssistant('t1-hub-reply', { streaming: true });
    pump();

    body.innerHTML = '<p>ジャンプが放物線になるのは、重力を計算しているからです。</p>';
    pump();
    body.innerHTML =
      '<p>ジャンプが放物線になるのは、重力を計算しているからです。</p><p>つまり例えではなく、中身そのものです。</p>';
    pump();
    chat.finish('t1-hub-reply');
    settle();
    settle();

    expect(chunks.join('')).toBe(
      'ジャンプが放物線になるのは、重力を計算しているからです。つまり例えではなく、中身そのものです。',
    );
    observer.stop();
  });

  it('keeps reading when the answer continues after a search status', () => {
    const chat = new FakeClaude();
    const { observer, chunks } = makeObserver();
    observer.start();

    observer.notifySubmitted();
    chat.addUser('調べて');
    const body = chat.addAssistant('t1-hub-reply', { streaming: true, status: 'ウェブを検索しています' });
    pump();
    body.innerHTML = '<p>検索した結果をお伝えします。試験は年に二回あります。</p>';
    pump();
    chat.finish('t1-hub-reply');
    settle();
    settle();

    expect(chunks.join('')).toBe('検索した結果をお伝えします。試験は年に二回あります。');
    observer.stop();
  });

  it('does not read answers that were already there when the chat was opened', () => {
    history.pushState({}, '', '/chat/abc');
    const chat = new FakeClaude();
    const { observer, chunks } = makeObserver();
    observer.start();

    chat.addUser('前の質問');
    chat.addAssistant('t1-hub-reply').innerHTML = '<p>これは前からある回答です。読み上げてはいけません。</p>';
    pump();
    settle();
    settle();

    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('reads the latest answer on open when that setting is on', () => {
    history.pushState({}, '', '/chat/abc');
    const chat = new FakeClaude();
    chat.addUser('前の質問');
    chat.addAssistant('t1-hub-reply', { status: 'ウェブを検索しました' }).innerHTML =
      '<p>これは前からある回答です。</p>';
    const { observer, chunks, opened } = makeObserver(true);
    observer.start();

    pump();
    settle();
    settle();

    expect(opened).toEqual(['これは前からある回答です。']);
    expect(chunks).toEqual([]);
    observer.stop();
  });

  it('keeps the answer armed when a new chat gets its URL', () => {
    const chat = new FakeClaude();
    const { observer, chunks } = makeObserver();
    observer.start();

    observer.notifySubmitted();
    chat.addUser('最初の質問');
    history.pushState({}, '', '/chat/new-conversation-id');
    const body = chat.addAssistant('t1-hub-reply', { streaming: true });
    pump();
    body.innerHTML = '<p>新しい会話の最初の回答です。きちんと読み上げます。</p>';
    pump();
    chat.finish('t1-hub-reply');
    settle();
    settle();

    expect(chunks.join('')).toBe('新しい会話の最初の回答です。きちんと読み上げます。');
    observer.stop();
  });
});

describe('ClaudeAdapter.onSubmit', () => {
  const enter = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init });
  const composer = (text: string) => {
    new FakeClaude();
    const box = document.querySelector('[data-testid="chat-input"]') as HTMLElement;
    box.innerHTML = `<p>${text}</p>`;
    return box;
  };

  it('fires on Enter in the composer', () => {
    const box = composer('質問です');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    (box.firstElementChild as HTMLElement).dispatchEvent(enter());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores IME confirmation, Shift+Enter and an empty composer', () => {
    const box = composer('しつもん');
    const cb = vi.fn();
    new ClaudeAdapter().onSubmit(cb);
    box.dispatchEvent(enter({ isComposing: true }));
    box.dispatchEvent(enter({ shiftKey: true }));
    box.innerHTML = '<p><br></p>';
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
});
