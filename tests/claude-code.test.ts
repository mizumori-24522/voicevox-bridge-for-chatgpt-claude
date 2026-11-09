import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter, isClaudeCodePath } from '../src/sites/claude-code';
import { claudeSite } from '../src/sites/claude';
import { DEFAULT_SANITIZE_OPTIONS, extractSpeechText } from '../src/speech-sanitizer';
import { ChatObserver } from '../src/observer';
import { DEFAULT_CHUNKER_OPTIONS } from '../src/chunker';
import type { AssistantMessage, SiteAdapter } from '../src/sites/types';

// 2026-11-10 に claude.ai/code で確認した構造を、必要な所だけ写したもの
function humanRow(index: number, text: string): string {
  return `<div data-testid="transcript-row" data-index="${index}" data-perf-row="human">
    <div data-cds="UserMessage" data-turn-key="u${index}"><div data-testid="user-message"><p>${text}</p></div></div>
  </div>`;
}
function textRow(index: number, text: string): string {
  return `<div data-testid="transcript-row" data-index="${index}" data-perf-row="assistant">
    <div data-testid="assistant-message" data-cds="AssistantMessage" data-turn-key="t1">
      <h3>Claude の応答：${text}</h3>
      <div><div data-transcript-engine-root><div data-cds="Prose"><p>${text}</p></div></div></div>
      <div><div data-testid="message-actions" data-cds="MessageActions">コピー</div></div>
    </div>
  </div>`;
}
function toolRow(index: number, title: string): string {
  return `<div data-testid="transcript-row" data-index="${index}" data-perf-row="assistant">
    <div data-testid="assistant-message" data-cds="AssistantMessage" data-turn-key="t1">
      <div><div data-cds="TurnStatus" data-tool-anchor="toolu_1"><div data-cds-row-title="${title}">${title}</div>
        <span data-cds="DiffIndicator">+3 3件追加、0件削除</span></div></div>
    </div>
  </div>`;
}
function questionCardRow(index: number): string {
  return `<div data-testid="transcript-row" data-index="${index}" data-perf-row="assistant">
    <div data-testid="assistant-message" data-cds="AssistantMessage" data-turn-key="t1">
      <div data-item-key="m"><div data-tool-anchor="toolu_2"><div>ゴミ箱へ移してよいですか？</div><div>はい</div></div></div>
    </div>
  </div>`;
}
function render(rows: string, working = false): void {
  document.body.innerHTML = `<main><div role="feed"><div data-testid="transcript-rows">${rows}</div>
    <div data-testid="transcript-tail-chrome"><div data-cds="AssistantMessage" data-code-own-row>
      <div data-testid="code-working-line" data-turn-working="${working}"></div></div></div></div>
    <div data-cds="ChatComposer"><div data-testid="code-prompt-input" contenteditable="true" role="textbox"></div></div></main>`;
}
const speech = (el: Element): string =>
  extractSpeechText(el, { ...DEFAULT_SANITIZE_OPTIONS, site: claudeSite.sanitize });

beforeEach(() => {
  history.replaceState(null, '', '/code/session_abc');
});

describe('isClaudeCodePath / conversationKey', () => {
  it('tells the Code screen from the chat screen', () => {
    expect(isClaudeCodePath('/code')).toBe(true);
    expect(isClaudeCodePath('/code/session_014Xs')).toBe(true);
    expect(isClaudeCodePath('/new')).toBe(false);
    expect(isClaudeCodePath('/chat/abc')).toBe(false);
    expect(isClaudeCodePath('/codex')).toBe(false);
  });

  it('takes the session id from the URL', () => {
    const a = new ClaudeCodeAdapter();
    expect(a.conversationKey('/code/session_014XsYX5')).toBe('session_014XsYX5');
    expect(a.conversationKey('/code')).toBeNull();
    expect(a.conversationKey('/code/artifacts')).toBeNull();
  });
});

describe('ClaudeCodeAdapter: 1 回の返答をまとめる', () => {
  it('joins the text rows after the last question and skips tools, diffs, banners and question cards', () => {
    render(
      humanRow(1, '前の質問') +
        textRow(2, '前の返答です。') +
        humanRow(3, '準備をお願いします') +
        textRow(4, 'まず確かめます。') +
        toolRow(5, '実行しました コマンド') +
        questionCardRow(6) +
        textRow(7, '確かめ終わりました。'),
    );
    const msg = new ClaudeCodeAdapter().getLatestAssistantMessage()!;
    const text = speech(msg.content);
    expect(text).toContain('まず確かめます。');
    expect(text).toContain('確かめ終わりました。');
    expect(text.indexOf('まず')).toBeLessThan(text.indexOf('確かめ終わり'));
    expect(text).not.toContain('前の返答');
    expect(text).not.toContain('実行しました');
    expect(text).not.toContain('件追加');
    expect(text).not.toContain('ゴミ箱');
    expect(text).not.toContain('コピー');
    expect(text).not.toContain('Claude の応答');
  });

  it('skips the "needs your computer" banner inside the text column', () => {
    render(
      humanRow(1, '質問') +
        `<div data-testid="transcript-row" data-index="2" data-perf-row="assistant">
          <div data-testid="assistant-message" data-cds="AssistantMessage">
            <div><div data-cds="Banner">このステップにはご自身のコンピューターが必要です。</div>
            <div data-transcript-engine-root><div data-cds="Prose"><p>本文です。</p></div></div></div>
          </div></div>`,
    );
    expect(speech(new ClaudeCodeAdapter().getLatestAssistantMessage()!.content)).toBe('本文です。');
  });

  it('returns null until the first reply row appears after a new question', () => {
    render(humanRow(1, '質問') + textRow(2, '返答。') + humanRow(3, '次の質問'));
    expect(new ClaudeCodeAdapter().getLatestAssistantMessage()).toBeNull();
  });

  it('keeps the same id for the whole reply, and a new id for the next question', () => {
    const a = new ClaudeCodeAdapter();
    render(humanRow(3, 'Q') + textRow(4, 'A1。'));
    const id1 = a.getLatestAssistantMessage()!.id;
    render(humanRow(3, 'Q') + textRow(4, 'A1。') + toolRow(5, 'ツール') + textRow(6, 'A2。'));
    expect(a.getLatestAssistantMessage()!.id).toBe(id1);
    render(humanRow(3, 'Q') + textRow(4, 'A1。') + humanRow(7, 'Q2') + textRow(8, 'B1。'));
    expect(a.getLatestAssistantMessage()!.id).not.toBe(id1);
  });

  it('keeps rows that scrolled away (virtualized) so the reply does not lose its head', () => {
    const a = new ClaudeCodeAdapter();
    render(humanRow(3, 'Q') + textRow(4, '最初の報告です。') + toolRow(5, 'ツール'));
    const id = a.getLatestAssistantMessage()!.id;
    // 長い返答で、質問の行と最初の行が上へ流れて DOM から消えた
    render(toolRow(5, 'ツール') + textRow(6, '次の報告です。'));
    const msg = a.getLatestAssistantMessage()!;
    expect(msg.id).toBe(id);
    const text = speech(msg.content);
    expect(text).toContain('最初の報告です。');
    expect(text).toContain('次の報告です。');
    expect(text.indexOf('最初')).toBeLessThan(text.indexOf('次の'));
  });

  it('does not mix replies from different sessions', () => {
    const a = new ClaudeCodeAdapter();
    render(humanRow(3, 'Q') + textRow(4, 'セッション1。'));
    const id1 = a.getLatestAssistantMessage()!.id;
    history.replaceState(null, '', '/code/session_other');
    render(humanRow(3, 'Q') + textRow(4, 'セッション2。'));
    const msg = a.getLatestAssistantMessage()!;
    expect(msg.id).not.toBe(id1);
    expect(speech(msg.content)).toBe('セッション2。');
  });

  it('puts read buttons only on rows that have text', () => {
    render(humanRow(1, 'Q') + textRow(2, 'A。') + toolRow(3, 'ツール') + questionCardRow(4));
    expect(new ClaudeCodeAdapter().assistantTurns()).toHaveLength(1);
  });
});

describe('ClaudeCodeAdapter: 生成中と入力欄', () => {
  it('sees the working line and the stop button', () => {
    const a = new ClaudeCodeAdapter();
    render(humanRow(1, 'Q'), false);
    expect(a.isGenerating()).toBe(false);
    render(humanRow(1, 'Q'), true);
    expect(a.isGenerating()).toBe(true);
    render(humanRow(1, 'Q') + '<button data-testid="code-prompt-stop" aria-label="停止"></button>', false);
    expect(a.isGenerating()).toBe(true);
  });

  it('finds the prompt box and the latest question', () => {
    const a = new ClaudeCodeAdapter();
    render(humanRow(1, '一つ目') + textRow(2, 'A。') + humanRow(3, '二つ目'));
    expect(a.getComposer()?.getAttribute('data-testid')).toBe('code-prompt-input');
    expect(a.getLatestUserMessageId()).toBe('user:二つ目');
  });
});

describe('claude.ai の中での切り替え', () => {
  it('uses the chat reader on chat pages and the Code reader on /code', () => {
    const adapter = claudeSite.createAdapter();
    history.replaceState(null, '', '/chat/abc');
    expect(adapter.conversationKey(location.pathname)).toBe('abc');
    expect(adapter.resumesAfterPause).toBe(false);
    history.replaceState(null, '', '/code/session_x');
    expect(adapter.conversationKey(location.pathname)).toBe('session_x');
    expect(adapter.resumesAfterPause).toBe(true);
  });
});

// --- observer: ツールの間の休みをはさんでも続きを読む ---

type FakeState = { id: string | null; html: string; generating: boolean; user: string | null };

function fakeAdapter(state: FakeState, resumable: boolean): SiteAdapter {
  return {
    resumesAfterPause: resumable,
    getObserverRoot: () => document.body,
    assistantTurns: () => [],
    contentOfTurn: (t) => t,
    userTurns: () => [],
    contentOfUserTurn: (t) => t,
    getLatestAssistantMessage: (): AssistantMessage | null => {
      if (state.id === null) return null;
      const el = document.createElement('div');
      el.innerHTML = state.html;
      return { id: state.id, element: el, content: el };
    },
    getLatestUserMessageId: () => state.user,
    isGenerating: () => state.generating,
    getComposer: () => null,
    onSubmit: () => {},
    conversationKey: () => 'session_x',
    probe: () => ({ ok: true, detail: '' }),
  };
}

describe('ChatObserver と休みのある返答', () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  function setup(state: FakeState, resumable: boolean) {
    const chunks: string[] = [];
    const obs = new ChatObserver({
      adapter: fakeAdapter(state, resumable),
      getEnabled: () => true,
      getSanitizeOptions: () => DEFAULT_SANITIZE_OPTIONS,
      getChunkerOptions: () => ({ ...DEFAULT_CHUNKER_OPTIONS, minimumChunkLength: 1 }),
      onChunk: (t) => chunks.push(t),
      onNewUserMessage: () => {},
      getReadOnOpen: () => false,
      onOpenChat: () => {},
    });
    const tick = (ms = 200) => {
      now += ms;
      (obs as unknown as { tick(): void }).tick();
    };
    return { obs, chunks, tick };
  }

  it('reads the next text after a long tool pause, without re-reading', () => {
    const state: FakeState = { id: null, html: '', generating: false, user: 'user:前' };
    const { chunks, tick } = setup(state, true);
    tick();
    // アプリから質問が送られ、返答が始まる
    state.user = 'user:準備して';
    state.generating = true;
    tick();
    state.id = 'r1';
    state.html = '<p>まず確かめます。</p>';
    tick();
    // ツールを動かしている間に、生成中の印が一瞬消えた（読み切った扱いになる）
    state.generating = false;
    tick(1500);
    tick(200);
    // 続きの文章が出た
    state.generating = true;
    state.html = '<p>まず確かめます。</p><p>確かめ終わりました。</p>';
    tick();
    state.generating = false;
    tick(1500);
    tick(200);
    const all = chunks.join('');
    expect(all).toContain('まず確かめます。');
    expect(all).toContain('確かめ終わりました。');
    expect(all.match(/まず確かめます/g)).toHaveLength(1);
  });

  it('reads an unfinished sentence when the text stops while tools run', () => {
    const state: FakeState = { id: null, html: '', generating: true, user: 'user:前' };
    const { chunks, tick } = setup(state, true);
    tick();
    state.user = 'user:次';
    tick();
    state.id = 'r1';
    state.html = '<p>次の手順を確認します：</p>';
    tick();
    tick(1500); // まだ生成中（ツール実行中）だが、本文は止まった
    expect(chunks.join('')).toContain('次の手順を確認します');
  });

  it('does not read a reply that only grew because the page was opened', () => {
    const state: FakeState = { id: 'r1', html: '<p>前からある返答。</p>', generating: false, user: 'user:前' };
    const { chunks, tick } = setup(state, true);
    tick();
    state.html = '<p>前からある返答。</p><p>描画で増えた行。</p>';
    tick();
    tick(1500);
    expect(chunks).toHaveLength(0);
  });

  it('keeps the chat behaviour: a finished reply that grows is not re-opened', () => {
    const state: FakeState = { id: null, html: '', generating: false, user: 'user:前' };
    const { chunks, tick } = setup(state, false);
    tick();
    state.user = 'user:質問';
    state.generating = true;
    tick();
    state.id = 'r1';
    state.html = '<p>回答です。</p>';
    tick();
    state.generating = false;
    tick(1500);
    tick();
    const before = chunks.length;
    state.html = '<p>回答です。</p><p>再描画で増えた。</p>';
    tick();
    tick(1500);
    expect(chunks.length).toBe(before);
  });
});
