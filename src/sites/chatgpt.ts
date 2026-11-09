import { log, warn } from '../logger';
import type { AssistantMessage, Site, SiteAdapter } from './types';

/**
 * ChatGPT Web の DOM 依存を全てこのモジュールへ隔離する。
 * UI 変更時はここだけを直せばよい。生成CSSクラス名には依存しない。
 *
 * 2 世代の構造に対応している。新しいほうを優先して探す。
 *
 * ■ 2026-09-26 に実機で確認した構造（新）
 *   <div data-content-search-turn-key="<ターン>">        ← 最初は fallback-turn-N、後で UUID に差し替わる
 *     <div data-content-search-unit-key="<ターン>:0:user">           ← 幅いっぱい。添付画像はこの外（上）
 *       <div data-user-message-bubble="true">                       ← 吹き出し（右寄せ・overflow: hidden）
 *         <div class="whitespace-pre-wrap">                         ← 質問の本文
 *       （吹き出しの下に コピー・共有・編集 のボタン列）
 *     <div data-content-search-unit-key="<ターン>:2:assistant"
 *          data-chatgpt-search-message-ids="<回答ID> ...">
 *       <div data-chatgpt-selection-message-id="<回答ID>">
 *         <div data-markdown-text-style="assistant-message">  ← 本文
 *   旧来の data-turn / data-message-author-role は一切無い。
 *   質問側にはメッセージ ID が付いていない。
 *
 * ■ 2026-09-15 に確認した構造（旧）
 *   <section data-turn="assistant" data-turn-id="<uuid>">
 *     <div data-message-author-role="assistant" data-message-id="<uuid>">
 *       <div class="... markdown prose ...">
 */


type Role = 'assistant' | 'user';

const UNIT_SEL = '[data-content-search-unit-key]';
const TURN_SEL = '[data-turn]';
const TURN_FALLBACK_SEL = '[data-testid^="conversation-turn-"]';
const ASSISTANT_SEL = '[data-message-author-role="assistant"]';
const USER_SEL = '[data-message-author-role="user"]';
const USER_BUBBLE_SEL = '[data-user-message-bubble]';
const CONTENT_SELECTORS = [
  '[data-markdown-text-style="assistant-message"]',
  '.markdown',
  '[class*="markdown"]',
  '.prose',
  '[class*="prose"]',
];

/** 新構造の発言単位の役割。unit-key の末尾（…:assistant / …:user）で判定する */
function unitRole(el: Element): Role | null {
  const key = el.getAttribute('data-content-search-unit-key') ?? '';
  if (key.endsWith(':assistant')) return 'assistant';
  if (key.endsWith(':user')) return 'user';
  return null;
}

/** 質問の同一性を本文で表す。新構造では質問に ID が無く、ターンの鍵も途中で差し替わるため */
function textKey(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class ChatGptAdapter implements SiteAdapter {
  /** 会話の URL は /c/<id>。新規チャット（/）は会話未確定なので null */
  conversationKey(pathname: string): string | null {
    const m = pathname.match(/\/c\/([^/]+)/);
    return m ? m[1] : null;
  }

  getObserverRoot(): HTMLElement {
    const main = document.querySelector('main');
    return (main as HTMLElement | null) ?? document.body;
  }

  /** 新構造の発言単位。無ければ空配列 */
  private units(role: Role): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(UNIT_SEL)).filter(
      (u) => unitRole(u) === role,
    );
  }

  /** assistant の発言を出現順に全部返す（任意の回答を指定して読ませる用） */
  assistantTurns(): HTMLElement[] {
    const units = this.units('assistant');
    if (units.length > 0) return units;
    return this.legacyTurns().filter(
      (t) =>
        t.getAttribute('data-turn') === 'assistant' ||
        (t.getAttribute('data-turn') === null && t.querySelector(ASSISTANT_SEL) !== null),
    );
  }

  /** 発言から本文要素を取り出す */
  contentOfTurn(turn: HTMLElement): Element {
    return this.findContentRoot(this.messageOf(turn, 'assistant'));
  }

  /** 質問の発言を出現順に全部返す（任意の質問を指定して読ませる用） */
  userTurns(): HTMLElement[] {
    const units = this.units('user');
    if (units.length > 0) return units;
    return Array.from(document.querySelectorAll<HTMLElement>(USER_SEL));
  }

  /** 質問の発言から本文要素を取り出す（添付やボタン列、吹き出しに足された時刻などは含めない） */
  contentOfUserTurn(turn: HTMLElement): Element {
    const bubble = turn.querySelector(USER_BUBBLE_SEL);
    return bubble?.querySelector('.whitespace-pre-wrap') ?? bubble ?? turn;
  }

  getLatestAssistantMessage(): AssistantMessage | null {
    const units = this.units('assistant');
    if (units.length > 0) {
      const unit = units[units.length - 1];
      return {
        id: this.unitMessageId(unit, units.length - 1),
        element: unit,
        content: this.findContentRoot(unit),
      };
    }

    const turn = this.lastLegacyTurn('assistant');
    if (!turn) return null;
    const message = this.messageOf(turn, 'assistant');
    return { id: this.legacyTurnId(turn, message), element: message, content: this.findContentRoot(message) };
  }

  getLatestUserMessageId(): string | null {
    const units = this.units('user');
    if (units.length > 0) {
      const text = textKey(units[units.length - 1]);
      return text ? `user:${text}` : null;
    }

    const turn = this.lastLegacyTurn('user');
    if (!turn) return null;
    return this.legacyTurnId(turn, this.messageOf(turn, 'user'));
  }

  /**
   * 新構造の回答 ID。メッセージ ID を最優先する。
   * ターンの鍵（unit-key）は fallback-turn-N → UUID と途中で変わるので使わない。
   */
  private unitMessageId(unit: HTMLElement, index: number): string {
    const ids = unit.getAttribute('data-chatgpt-search-message-ids')?.trim();
    if (ids) return `msg:${ids.split(/\s+/)[0]}`;
    const sel = unit.querySelector('[data-chatgpt-selection-message-id]');
    const selId = sel?.getAttribute('data-chatgpt-selection-message-id');
    if (selId) return `msg:${selId}`;
    return `${location.pathname}:assistant-${index}`;
  }

  private messageOf(turn: HTMLElement, role: Role): HTMLElement {
    const sel = role === 'assistant' ? ASSISTANT_SEL : USER_SEL;
    return turn.matches(sel) ? turn : (turn.querySelector<HTMLElement>(sel) ?? turn);
  }

  // ---- 旧構造 ----

  private legacyTurns(): HTMLElement[] {
    const byTurn = document.querySelectorAll<HTMLElement>(TURN_SEL);
    if (byTurn.length > 0) return Array.from(byTurn);
    return Array.from(document.querySelectorAll<HTMLElement>(TURN_FALLBACK_SEL));
  }

  private lastLegacyTurn(role: Role): HTMLElement | null {
    const turns = this.legacyTurns();
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const attr = t.getAttribute('data-turn');
      if (attr === role) return t;
      if (attr === null && t.querySelector(`[data-message-author-role="${role}"]`)) return t;
    }
    const sel = role === 'assistant' ? ASSISTANT_SEL : USER_SEL;
    const nodes = document.querySelectorAll<HTMLElement>(sel);
    return nodes.length > 0 ? nodes[nodes.length - 1] : null;
  }

  private legacyTurnId(turn: HTMLElement, message: HTMLElement): string {
    const turnId = turn.getAttribute('data-turn-id');
    if (turnId) return `turn:${turnId}`;
    const msgId = message.getAttribute('data-message-id');
    if (msgId) return `msg:${msgId}`;
    const testid = turn.getAttribute('data-testid');
    if (testid) return `${location.pathname}:${testid}`;
    return `${location.pathname}:idx-${this.legacyTurns().indexOf(turn)}`;
  }

  /** 本文（markdown レンダリング結果）のルート。無ければ要素自身。 */
  private findContentRoot(el: HTMLElement): Element {
    for (const sel of CONTENT_SELECTORS) {
      const hit = el.querySelector(sel);
      if (hit) return hit;
    }
    return el;
  }

  /**
   * 生成中かどうか。停止ボタン等が取れればそれを使うが、
   * ChatGPT の UI 変更で取れなくなる可能性が高いので、
   * observer 側の「本文が増え続けているか」判定と併用する前提。
   */
  isGenerating(): boolean {
    if (document.querySelector('[data-testid="stop-button"]')) return true;
    if (document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"]')) return true;
    if (document.querySelector('[class*="result-streaming"]')) return true;
    return false;
  }

  getComposer(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('[data-composer-body] [contenteditable="true"]') ??
      document.querySelector<HTMLElement>('#prompt-textarea') ??
      document.querySelector<HTMLElement>('form [contenteditable="true"]') ??
      document.querySelector<HTMLElement>('form textarea')
    );
  }

  /**
   * 質問の送信操作を検出する。「読み上げを解禁してよい」の一番確かな根拠。
   *
   * ChatGPT 側がイベントを止めても拾えるよう、capture で document に付ける。
   * 日本語入力の変換確定の Enter（isComposing）は送信ではないので除外する。
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
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
        if (!inComposer(e.target) || !hasText()) return;
        cb();
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('[data-testid="send-button"], button[aria-label*="送信"], button[aria-label*="Send"]')) {
          cb();
        }
      },
      true,
    );
  }

  probe(): { ok: boolean; detail: string } {
    const turns = document.querySelectorAll(UNIT_SEL).length + this.legacyTurns().length;
    const composer = this.getComposer() !== null;
    const ok = composer || turns > 0;
    const detail = `turns=${turns} composer=${composer}`;
    if (ok) log('ChatGPT', 'probe ok', detail);
    else warn('ChatGPT', 'DOM を認識できません', detail);
    return { ok, detail };
  }
}

/**
 * 質問のボタンを、ChatGPT 自身のボタン列（コピー・共有・編集）のすぐ左へ寄せる。
 * ボタン列の数や幅は変わりうるので、決め打ちにせず毎回測る。
 */
function alignQuestionButton(turn: HTMLElement, btn: HTMLElement): void {
  const natives = Array.from(turn.querySelectorAll('button'))
    .filter((b) => b !== btn && b.closest('[data-user-message-bubble]') === null)
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0);
  if (natives.length === 0) return;
  const box = turn.getBoundingClientRect();
  const left = Math.min(...natives.map((r) => r.left));
  const row = natives[0];
  btn.style.right = `${Math.round(box.right - left + 6)}px`;
  btn.style.bottom = `${Math.round(box.bottom - row.bottom + (row.height - btn.offsetHeight) / 2)}px`;
}

export const chatgptSite: Site = {
  id: 'chatgpt',
  label: 'ChatGPT',
  createAdapter: () => new ChatGptAdapter(),
  sanitize: {
    skip: () => false,
    isCodeFrame: () => false,
  },
  readButtons: {
    // 回答: 回答のすぐ上の空きの中央。左には「◯秒考えました」などの表示、
    //   右には直前の質問のボタン列（コピー・編集）が来るので、どちらも避ける
    // 質問: 吹き出しの下、ChatGPT 自身のボタン列のすぐ左。
    //   吹き出しは overflow: hidden で、上には添付画像が来るので、そこには置けない
    // 位置は 2026-10-04 に実物の chatgpt.com で確かめた。
    css: `
[data-cvb-read-btn="answer"] { top: -24px; left: 50%; transform: translateX(-50%); }
/* ChatGPT のボタン列の位置が測れないときの置き場所。測れたら alignQuestionButton が上書きする */
[data-cvb-read-btn="question"] { bottom: 5px; right: 104px; }
/* 回答のボタンは枠の外にあるので、回答からボタンへマウスを動かす途中で消えないよう隙間を埋める */
[data-cvb-read-btn="answer"]::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 4px; }
`,
    alignQuestion: alignQuestionButton,
  },
};
