import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContinuousReader, mergeTurns, type ContinuousTurn } from '../src/continuous-reader';
import { syncReadButtons } from '../src/message-actions';
import { rowsContiguous } from '../src/sites/claude-code';
import { ChatObserver } from '../src/observer';
import { DEFAULT_CHUNKER_OPTIONS } from '../src/chunker';
import { DEFAULT_SANITIZE_OPTIONS } from '../src/speech-sanitizer';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { SiteAdapter } from '../src/sites/types';

// --- ここから続けて読む ---

function conversation(...items: [kind: 'q' | 'a', text: string][]): void {
  document.body.innerHTML = items
    .map(([k, t]) => `<div class="${k === 'q' ? 'question' : 'answer'}">${t}</div>`)
    .join('');
}
const answers = () => Array.from(document.querySelectorAll<HTMLElement>('.answer'));
const questions = () => Array.from(document.querySelectorAll<HTMLElement>('.question'));

function setupReader(opts: { withQuestions: boolean }) {
  const spoken: string[] = [];
  const finished: string[] = [];
  let idle = true;
  const reader = new ContinuousReader({
    listTurns: () => mergeTurns(answers(), opts.withQuestions ? questions() : []),
    textOf: (t) => t.el.textContent ?? '',
    speak: (t) => {
      const text = (t.el.textContent ?? '').trim();
      if (!text) return false;
      spoken.push(`${t.kind}:${text}`);
      idle = false;
      return true;
    },
    isIdle: () => idle,
    reveal: () => {},
    onFinish: (r) => finished.push(r),
    settleMs: 10,
  });
  /** 今の発言を読み終えたことにする */
  const finishSpeaking = () => {
    idle = true;
    reader.onIdle();
    vi.advanceTimersByTime(20);
  };
  const first = (i: number): ContinuousTurn => ({ el: answers()[i], kind: 'answer' });
  return { reader, spoken, finished, finishSpeaking, first };
}

describe('ContinuousReader', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads from the chosen answer to the last one, answers only', () => {
    conversation(['q', 'Q1'], ['a', 'A1'], ['q', 'Q2'], ['a', 'A2'], ['q', 'Q3'], ['a', 'A3']);
    const { reader, spoken, finished, finishSpeaking, first } = setupReader({ withQuestions: false });
    reader.start(first(1));
    expect(spoken).toEqual(['answer:A2']);
    finishSpeaking();
    expect(spoken).toEqual(['answer:A2', 'answer:A3']);
    finishSpeaking();
    expect(finished).toEqual(['done']);
    expect(reader.active).toBe(false);
  });

  it('reads the questions in between when the setting is on', () => {
    conversation(['q', 'Q1'], ['a', 'A1'], ['q', 'Q2'], ['a', 'A2']);
    const { reader, spoken, finishSpeaking, first } = setupReader({ withQuestions: true });
    reader.start(first(0));
    finishSpeaking();
    finishSpeaking();
    expect(spoken).toEqual(['answer:A1', 'question:Q2', 'answer:A2']);
  });

  it('does not move on while something is still being read', () => {
    conversation(['a', 'A1'], ['a', 'A2']);
    const { reader, spoken, first } = setupReader({ withQuestions: false });
    reader.start(first(0));
    reader.onIdle(); // 列が空になったという知らせが来たが、実際はまだ読んでいる
    vi.advanceTimersByTime(20);
    expect(spoken).toEqual(['answer:A1']);
  });

  it('stops when cancelled, even in the middle of moving on', () => {
    conversation(['a', 'A1'], ['a', 'A2']);
    const { reader, spoken, first } = setupReader({ withQuestions: false });
    reader.start(first(0));
    reader.onIdle();
    reader.cancel();
    vi.advanceTimersByTime(20);
    expect(spoken).toEqual(['answer:A1']);
    expect(reader.active).toBe(false);
  });

  it('skips a turn that has nothing to read', () => {
    conversation(['a', 'A1'], ['a', ''], ['a', 'A3']);
    const { reader, spoken, finishSpeaking, first } = setupReader({ withQuestions: false });
    reader.start(first(0));
    finishSpeaking();
    vi.advanceTimersByTime(50);
    expect(spoken).toEqual(['answer:A1', 'answer:A3']);
  });

  it('finds its place again when the page re-creates the element', () => {
    conversation(['a', 'A1'], ['a', 'A2'], ['a', 'A3']);
    const { reader, spoken, finishSpeaking, first } = setupReader({ withQuestions: false });
    reader.start(first(1));
    conversation(['a', 'A1'], ['a', 'A2'], ['a', 'A3']); // 再描画で全部作り直された
    finishSpeaking();
    expect(spoken).toEqual(['answer:A2', 'answer:A3']);
  });

  it('reports "lost" when the current turn is gone', () => {
    conversation(['a', 'A1'], ['a', 'A2']);
    const { reader, finished, finishSpeaking, first } = setupReader({ withQuestions: false });
    reader.start(first(0));
    conversation(['a', 'べつの会話']);
    finishSpeaking();
    expect(finished).toEqual(['lost']);
  });
});

describe('ContinuousReader と仮想化', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 会話の上のほうを見ていても、最後の行は DOM に残っている画面を模す
  function rows(...indexes: number[]): void {
    document.body.innerHTML = indexes
      .map((i) => `<div data-testid="transcript-row" data-index="${i}"><div class="answer">A${i}</div></div>`)
      .join('');
  }

  function setupGap(opts: { fillOnNudge: boolean }) {
    const spoken: string[] = [];
    const finished: string[] = [];
    let idle = true;
    let nudges = 0;
    const reader = new ContinuousReader({
      listTurns: () => mergeTurns(answers(), []),
      textOf: (t) => t.el.textContent ?? '',
      speak: (t) => {
        spoken.push(t.el.textContent ?? '');
        idle = false;
        return true;
      },
      isIdle: () => idle,
      reveal: () => {},
      isContiguous: rowsContiguous,
      nudge: () => {
        nudges++;
        if (!opts.fillOnNudge) return;
        // 画面を送ったら、間の行が描画された（読んでいる行の要素はそのまま）
        for (const i of [3, 2]) {
          const row = document.createElement('div');
          row.setAttribute('data-testid', 'transcript-row');
          row.setAttribute('data-index', String(i));
          row.innerHTML = `<div class="answer">A${i}</div>`;
          document.querySelector('[data-index="1"]')!.after(row);
        }
      },
      onFinish: (r) => finished.push(r),
      settleMs: 10,
    });
    const finishSpeaking = () => {
      idle = true;
      reader.onIdle();
      vi.advanceTimersByTime(25);
    };
    return { reader, spoken, finished, finishSpeaking, nudges: () => nudges };
  }

  it('waits for the rows in between instead of jumping to the last one', () => {
    rows(1, 9);
    const { reader, spoken, finishSpeaking, nudges } = setupGap({ fillOnNudge: true });
    reader.start({ el: answers()[0], kind: 'answer' });
    finishSpeaking();
    expect(nudges()).toBe(1);
    expect(spoken).toEqual(['A1', 'A2']);
  });

  it('gives up with "lost" rather than skipping, when the rows never appear', () => {
    rows(1, 9);
    const { reader, spoken, finished, finishSpeaking } = setupGap({ fillOnNudge: false });
    reader.start({ el: answers()[0], kind: 'answer' });
    finishSpeaking();
    vi.advanceTimersByTime(500);
    expect(spoken).toEqual(['A1']);
    expect(finished).toEqual(['lost']);
    expect(reader.active).toBe(false);
  });
});

describe('rowsContiguous', () => {
  const row = (i: number) => document.querySelector<HTMLElement>(`[data-index="${i}"] .answer`)!;
  it('is true only when every row number in between is in the DOM', () => {
    document.body.innerHTML = [1, 2, 3, 9]
      .map((i) => `<div data-testid="transcript-row" data-index="${i}"><div class="answer">A${i}</div></div>`)
      .join('');
    expect(rowsContiguous(row(1), row(2))).toBe(true);
    expect(rowsContiguous(row(1), row(3))).toBe(true);
    expect(rowsContiguous(row(3), row(9))).toBe(false);
  });
  it('assumes no gap when rows have no numbers', () => {
    document.body.innerHTML = '<div class="answer">A</div><div class="answer">B</div>';
    const [a, b] = Array.from(document.querySelectorAll<HTMLElement>('.answer'));
    expect(rowsContiguous(a, b)).toBe(true);
  });
});

describe('「続けて読む」ボタン', () => {
  it('adds its own button next to the answer button, once', () => {
    conversation(['a', 'A1'], ['a', 'A2']);
    const layout = { css: '' };
    const started: HTMLElement[] = [];
    for (let i = 0; i < 2; i++) {
      syncReadButtons(answers(), 'answer', () => {}, layout);
      syncReadButtons(answers(), 'continue', (t) => started.push(t), layout);
    }
    const first = answers()[0];
    expect(first.querySelectorAll('[data-cvb-read-btn="answer"]')).toHaveLength(1);
    expect(first.querySelectorAll('[data-cvb-read-btn="continue"]')).toHaveLength(1);
    first.querySelector<HTMLElement>('[data-cvb-read-btn="continue"]')!.click();
    expect(started).toEqual([first]);
  });
});

describe('設定の既定値', () => {
  it('reads answers only, and announces thinking after 10 seconds', () => {
    expect(DEFAULT_SETTINGS.continuousReadsQuestions).toBe(false);
    expect(DEFAULT_SETTINGS.thinkingNotice).toBe(true);
    expect(DEFAULT_SETTINGS.thinkingNoticeSeconds).toBe(10);
  });
});

// --- 長考の知らせ ---

type State = { id: string | null; html: string; generating: boolean; user: string | null };

function adapterOf(state: State): SiteAdapter {
  return {
    getObserverRoot: () => document.body,
    assistantTurns: () => [],
    contentOfTurn: (t) => t,
    userTurns: () => [],
    contentOfUserTurn: (t) => t,
    getLatestAssistantMessage: () => {
      if (state.id === null) return null;
      const el = document.createElement('div');
      el.innerHTML = state.html;
      return { id: state.id, element: el, content: el };
    },
    getLatestUserMessageId: () => state.user,
    isGenerating: () => state.generating,
    getComposer: () => null,
    onSubmit: () => {},
    conversationKey: () => 'c1',
    probe: () => ({ ok: true, detail: '' }),
  };
}

describe('長考の知らせ', () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  function setup(state: State, opts: { wait?: number | null; enabled?: boolean } = {}) {
    const notices: number[] = [];
    const chunks: string[] = [];
    const speech = { idle: true };
    const wait = opts.wait === undefined ? 10 : opts.wait;
    const obs = new ChatObserver({
      adapter: adapterOf(state),
      getEnabled: () => opts.enabled ?? true,
      getSanitizeOptions: () => DEFAULT_SANITIZE_OPTIONS,
      getChunkerOptions: () => ({ ...DEFAULT_CHUNKER_OPTIONS, minimumChunkLength: 1 }),
      onChunk: (t) => chunks.push(t),
      onNewUserMessage: () => {},
      getReadOnOpen: () => false,
      onOpenChat: () => {},
      thinking: {
        getWaitSeconds: () => wait,
        isSpeechIdle: () => speech.idle,
        onNotice: (n) => notices.push(n),
      },
    });
    /** 1 秒刻みで seconds 秒ぶん進める */
    const run = (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        (obs as unknown as { tick(): void }).tick();
      }
    };
    return { notices, chunks, speech, run };
  }
  const thinking = (): State => ({ id: null, html: '', generating: true, user: 'user:Q' });

  it('says so once after the wait, then repeats with longer and longer gaps', () => {
    const { notices, run } = setup(thinking());
    run(9);
    expect(notices).toEqual([]);
    run(3);
    expect(notices).toEqual([1]);
    run(25);
    expect(notices).toEqual([1]); // 2 回目は 30 秒あと
    run(8);
    expect(notices).toEqual([1, 2]);
    run(55);
    expect(notices).toEqual([1, 2]); // 3 回目は 60 秒あと
    run(8);
    expect(notices).toEqual([1, 2, 3]);
  });

  it('stays silent when nothing is being generated', () => {
    const { notices, run } = setup({ ...thinking(), generating: false });
    run(60);
    expect(notices).toEqual([]);
  });

  it('stays silent when the setting is off, or reading is off', () => {
    const off = setup(thinking(), { wait: null });
    off.run(60);
    expect(off.notices).toEqual([]);
    const disabled = setup(thinking(), { enabled: false });
    disabled.run(60);
    expect(disabled.notices).toEqual([]);
  });

  it('does not talk over the reading, and counts again after it ends', () => {
    const { notices, speech, run } = setup(thinking());
    speech.idle = false;
    run(30);
    expect(notices).toEqual([]);
    speech.idle = true;
    run(9);
    expect(notices).toEqual([]);
    run(3);
    expect(notices).toEqual([1]);
  });

  it('starts over from the first notice once new text has arrived', () => {
    const state = thinking();
    const { notices, chunks, run } = setup(state);
    run(12);
    expect(notices).toEqual([1]);
    state.id = 'r1';
    state.html = '<p>わかりました。</p>';
    run(2);
    expect(chunks.join('')).toContain('わかりました。');
    // また長く止まった（ツールを動かしている、など）。30 秒ではなく 10 秒でもう一度知らせる
    run(12);
    expect(notices).toEqual([1, 1]);
  });

  it('stops when the reply ends', () => {
    const state = thinking();
    const { notices, run } = setup(state);
    run(12);
    state.generating = false;
    run(120);
    expect(notices).toEqual([1]);
  });
});
