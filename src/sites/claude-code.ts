import { log, warn } from '../logger';
import type { AssistantMessage, SiteAdapter } from './types';

/**
 * Claude Code Web（claude.ai/code）の DOM 依存を全てこのモジュールへ隔離する。
 * UI 変更時はここだけを直せばよい。生成CSSクラス名には依存しない。
 *
 * ■ 2026-11-10 に実機で確認した構造（通常チャットと同じ部品が多い）
 *   <div role="feed" data-perf-region="transcript">
 *     <div data-testid="transcript-rows">
 *       <div data-testid="transcript-row" data-index="<行番号>"               ← 仮想化される行
 *            data-perf-row="human|assistant">
 *         ── 質問の行 ──
 *         <div data-cds="UserMessage" data-turn-key="<uuid>">
 *           <div data-testid="user-message">                                ← 質問の本文
 *         ── 回答の行 ──
 *         <div data-testid="assistant-message" data-cds="AssistantMessage" data-turn-key="<鍵>">
 *           <h3>Claude の応答：…</h3>                                        ← 読み上げ用の見出し（列の外）
 *           <div>                                                           ← 本文の列
 *             <div data-cds="TurnStatus" data-tool-anchor="toolu_…">         ← ツール実行の行（読まない）
 *               <span data-cds="DiffIndicator">+368 368件追加、0件削除</span> ← 差分の行数（読まない）
 *             <div data-cds="Banner">このステップにはご自身のコンピューターが必要です…</div>（読まない）
 *             <div data-transcript-engine-root>
 *               <div data-cds="Prose">…                                     ← 本文
 *           <div data-testid="message-actions" data-cds="MessageActions">
 *     <div data-testid="transcript-tail-chrome">
 *       <div data-cds="AssistantMessage" data-code-own-row>                 ← testid の無い AssistantMessage（拾わない）
 *         <div data-testid="code-working-line" data-turn-working="true|false">
 *   入力欄: <div data-testid="code-prompt-input" contenteditable="true" role="textbox">
 *   送信:   <button data-testid="code-prompt-send">（入力欄が空のときは出ない）
 *   停止:   <button data-testid="code-prompt-stop">（返答中だけ出る）
 *   会話の URL: /code/session_<英数字>（新規作成は /code）
 *
 * ■ 通常チャットとの大きな違い：1 回の返答が何行にも分かれる
 *   「文章の行」と「ツール実行の行」が交互に並び、それぞれが別の assistant-message になる。
 *   Remote Control のセッションでは全部の行が同じ data-turn-key を持ち、
 *   古いクラウドのセッションでは行ごとに違っていた。
 *   どちらでも通用する区切りとして「最後の質問の行より後ろの回答の行すべて」を 1 つの返答とみなし、
 *   各行の本文の列を順につないだものを、共通部分へ 1 つの本文として渡す。
 *   確認の質問カード（AskUserQuestion）の行には本文の列が無いので、自然に入らない。
 *
 * ■ 生成中の見分け方
 *   code-working-line の data-turn-working="true"、または停止ボタン。
 *   通常チャットの data-is-streaming="true" は付かない。
 *
 * 詳しい調査記録は docs/claude-code-dom.md。
 */

const ROW_SEL = '[data-testid="transcript-row"]';
const ASSISTANT_SEL = '[data-testid="assistant-message"]';
const USER_SEL = '[data-testid="user-message"]';
const USER_TURN_SEL = '[data-cds="UserMessage"]';
const ENGINE_ROOT_SEL = '[data-transcript-engine-root]';
const COMPOSER_SELECTORS = [
  '[data-testid="code-prompt-input"]',
  '[data-cds="ChatComposer"] [contenteditable="true"]',
];
const SEND_BUTTON_SEL = '[data-testid="code-prompt-send"]';
const STOP_BUTTON_SEL = '[data-testid="code-prompt-stop"]';
const WORKING_SEL = '[data-testid="code-working-line"][data-turn-working="true"]';

/** claude.ai の中で、Claude Code の画面かどうか */
export function isClaudeCodePath(pathname: string): boolean {
  return pathname === '/code' || pathname.startsWith('/code/');
}

function isHumanRow(row: HTMLElement): boolean {
  const kind = row.getAttribute('data-perf-row');
  if (kind) return kind === 'human';
  return row.querySelector(USER_SEL) !== null;
}

/** 行の並び順を表す番号。仮想化で行が出入りしても変わらない */
function rowIndex(row: HTMLElement): number | null {
  const v = row.getAttribute('data-index') ?? row.getAttribute('data-rs-index');
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * a の行から b の行までの間に、DOM に無い行（仮想化でまだ描画されていない行）が無いか。
 * 行には通し番号（data-index）が付いているので、番号が 1 つずつ続いているかで判断する。
 * この画面は、会話の上のほうを見ているときも最後の数行を DOM に残すので、
 * DOM の上で隣り合っていても、実際には何十行も離れていることがある。
 */
export function rowsContiguous(a: HTMLElement, b: HTMLElement): boolean {
  const rowA = a.closest<HTMLElement>(ROW_SEL);
  const rowB = b.closest<HTMLElement>(ROW_SEL);
  if (!rowA || !rowB) return true;
  const from = rowIndex(rowA);
  const to = rowIndex(rowB);
  if (from === null || to === null || to <= from) return true;
  const present = new Set<number>();
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(ROW_SEL))) {
    const i = rowIndex(row);
    if (i !== null) present.add(i);
  }
  for (let i = from + 1; i < to; i++) if (!present.has(i)) return false;
  return true;
}

export class ClaudeCodeAdapter implements SiteAdapter {
  /** ツールを動かしている間は本文が長く止まり、そのあと同じ返答の続きが伸びる */
  readonly resumesAfterPause = true;

  /**
   * 今の返答の、行ごとの本文の写し。
   * 長い返答では、上へ流れた行が仮想化で DOM から消える。消えた行の本文も
   * 写しで持ち続けないと、本文が頭から欠けて「書き換わった」ように見えてしまう。
   */
  private cache: { key: string; parts: Map<number, Element> } | null = null;
  /** 最後に見えた質問の行の番号。質問の行が上へ流れて消えても、同じ返答だと分かるように */
  private lastAnchor: { path: string; anchor: string } | null = null;

  /** 会話の URL は /code/session_<英数字>。新規作成（/code）は会話未確定なので null */
  conversationKey(pathname: string): string | null {
    const m = pathname.match(/^\/code\/(session_[^/]+)/);
    return m ? m[1] : null;
  }

  getObserverRoot(): HTMLElement {
    const main = document.querySelector('main');
    return (main as HTMLElement | null) ?? document.body;
  }

  /** 本文を持つ回答の行を出現順に全部返す（ツールだけの行には読むものが無い） */
  assistantTurns(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_SEL)).filter(
      (turn) => turn.querySelector(ENGINE_ROOT_SEL) !== null,
    );
  }

  /** 回答の行から本文の列を取り出す。列の中のツール表示などは sanitize 側で読み飛ばす */
  contentOfTurn(turn: HTMLElement): Element {
    return this.columnOf(turn) ?? turn;
  }

  userTurns(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(USER_SEL)).map(
      (body) => body.closest<HTMLElement>(USER_TURN_SEL) ?? body,
    );
  }

  contentOfUserTurn(turn: HTMLElement): Element {
    return turn.matches(USER_SEL) ? turn : (turn.querySelector(USER_SEL) ?? turn);
  }

  /**
   * 最後の質問より後ろの回答の行すべてを、1 つの返答として返す。
   * content は各行の本文の列の写しを順につないだ、DOM に置かれていない要素。
   */
  getLatestAssistantMessage(): AssistantMessage | null {
    const reply = this.collectReply();
    if (!reply || reply.rows.length === 0) return null;

    if (this.cache?.key !== reply.key) this.cache = { key: reply.key, parts: new Map() };
    const parts = this.cache.parts;
    reply.rows.forEach((row, i) => {
      const turn = row.querySelector<HTMLElement>(ASSISTANT_SEL);
      const column = turn ? this.columnOf(turn) : null;
      if (!column) return;
      // 行番号が無い構造では、見えている順番で代用する（仮想化への強さは落ちる）
      parts.set(rowIndex(row) ?? i, column.cloneNode(true) as Element);
    });

    const content = document.createElement('div');
    for (const k of Array.from(parts.keys()).sort((a, b) => a - b)) {
      content.appendChild(parts.get(k)!.cloneNode(true));
    }
    const last = reply.rows[reply.rows.length - 1];
    return {
      id: reply.key,
      element: last.querySelector<HTMLElement>(ASSISTANT_SEL) ?? last,
      content,
    };
  }

  /** 質問の同一性は本文で表す（claude.ts と同じ理由） */
  getLatestUserMessageId(): string | null {
    const users = document.querySelectorAll<HTMLElement>(USER_SEL);
    if (users.length === 0) return null;
    const text = (users[users.length - 1].textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return text ? `user:${text}` : null;
  }

  /** ツールを動かしている間も「返答中」として扱われる */
  isGenerating(): boolean {
    return document.querySelector(WORKING_SEL) !== null || document.querySelector(STOP_BUTTON_SEL) !== null;
  }

  getComposer(): HTMLElement | null {
    for (const sel of COMPOSER_SELECTORS) {
      const hit = document.querySelector<HTMLElement>(sel);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Chrome の入力欄から送ったときの検出。
   * デスクトップアプリから送った質問は、ここではなく observer の
   * 「質問の行が増えた」「生成中になった」で拾う。
   */
  onSubmit(cb: () => void): void {
    const inComposer = (t: EventTarget | null): boolean => {
      if (!(t instanceof Element)) return false;
      const composer = this.getComposer();
      return composer !== null && (composer === t || composer.contains(t));
    };
    const hasText = (): boolean => (this.getComposer()?.textContent ?? '').trim().length > 0;

    document.addEventListener(
      'keydown',
      (e) => {
        if (!isClaudeCodePath(location.pathname)) return;
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
        if (!inComposer(e.target) || !hasText()) return;
        cb();
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        if (!isClaudeCodePath(location.pathname)) return;
        const t = e.target;
        if (t instanceof Element && t.closest(SEND_BUTTON_SEL)) cb();
      },
      true,
    );
  }

  isContiguous(a: HTMLElement, b: HTMLElement): boolean {
    return rowsContiguous(a, b);
  }

  probe(): { ok: boolean; detail: string } {
    const rows = document.querySelectorAll(ROW_SEL).length;
    const composer = this.getComposer() !== null;
    const ok = composer || rows > 0;
    const detail = `rows=${rows} composer=${composer}`;
    if (ok) log('ClaudeCode', 'probe ok', detail);
    else warn('ClaudeCode', 'DOM を認識できません', detail);
    return { ok, detail };
  }

  private columnOf(turn: HTMLElement): Element | null {
    const column = turn.querySelector(ENGINE_ROOT_SEL)?.parentElement;
    return column && column !== turn ? column : null;
  }

  /**
   * 最後の質問の行より後ろにある回答の行を集める。
   * key は「どの会話の、どの質問への返答か」。質問の行が見えなくなっても、
   * 直前に見えていた質問の番号を使い続ける。
   */
  private collectReply(): { key: string; rows: HTMLElement[] } | null {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SEL));
    if (rows.length === 0) return null;
    const path = location.pathname;

    let lastHuman = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isHumanRow(rows[i])) {
        lastHuman = i;
        break;
      }
    }

    let anchor: string;
    if (lastHuman >= 0) {
      const human = rows[lastHuman];
      const idx = rowIndex(human);
      anchor = idx !== null ? `row${idx}` : `q:${(human.textContent ?? '').trim().slice(0, 80)}`;
      this.lastAnchor = { path, anchor };
    } else {
      anchor = this.lastAnchor?.path === path ? this.lastAnchor.anchor : 'top';
    }

    const replyRows = rows.slice(lastHuman + 1).filter((r) => !isHumanRow(r) && r.querySelector(ASSISTANT_SEL));
    return { key: `code:${path}:${anchor}`, rows: replyRows };
  }
}

/** Claude Code の画面だけにある、本文ではない部品 */
export function isClaudeCodeChrome(el: Element): boolean {
  const cds = el.getAttribute('data-cds');
  if (cds === 'TurnStatus' || cds === 'MessageActions' || cds === 'Banner' || cds === 'DiffIndicator') return true;
  // ツールに結びついた表示（実行の行・確認の質問カードなど）
  if (el.hasAttribute('data-tool-anchor')) return true;
  return el.tagName === 'SPAN' && el.hasAttribute('data-not-prose');
}
