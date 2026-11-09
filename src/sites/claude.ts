import { log, warn } from '../logger';
import type { AssistantMessage, Site, SiteAdapter } from './types';

/**
 * Claude Web（claude.ai の通常チャット）の DOM 依存を全てこのモジュールへ隔離する。
 * UI 変更時はここだけを直せばよい。生成CSSクラス名には依存しない。
 *
 * ■ 2026-10-03 に実機で確認した構造
 *   <div role="feed">
 *     <div data-testid="transcript-row" data-perf-row="human|assistant">   ← 仮想化される行
 *       <div data-cds="UserMessage" data-turn-key="<ターン>">              ← 質問の枠（幅いっぱい・右寄せ）
 *         <div data-cds="MessageAttachments">                              ← 添付（あれば）
 *         <div>…<div data-testid="user-message">                           ← 吹き出しと質問の本文
 *         <div data-cds="MessageActions">                                  ← 時刻・編集・コピー
 *       <div data-testid="assistant-message" data-cds="AssistantMessage"
 *            data-turn-key="<ターン>-hub-reply" data-is-streaming="true|false">
 *         <h2 class="sr-only">Claudeが返答しました: …</h2>
 *         <div>                                                            ← 本文の列
 *           <div data-cds="TurnStatus">ウェブを検索しました</div>           ← 検索・思考の表示（読まない）
 *           <div data-transcript-engine-root>
 *             <div data-cds="Prose"><div data-perf-reply-text>             ← 本文
 *         <div><div data-testid="message-actions">                         ← コピー等のボタン列
 *   入力欄: <div data-testid="chat-input" contenteditable="true">
 *   送信:   <button data-testid="chat-input-send">（生成中は data-testid="chat-input-stop" に替わる）
 *   会話の URL: /chat/<uuid>（新規チャットは /new。送信した瞬間に /chat/<uuid> へ変わる）
 *
 * ■ 生成中の流れ（同日、実際に質問を送って記録）
 *   1. 送信直後: 回答の枠だけが現れる。data-is-streaming 属性はまだ無く、
 *      本文の列も無い（TurnStatus が pending）。停止ボタンは出ている。
 *   2. 本文が出始めると data-is-streaming="true" になり、本文の列が現れる。
 *   3. 終わると data-is-streaming="false"、停止ボタンが送信ボタンへ戻る。
 *   回答の data-turn-key は最初から最後まで変わらない。
 */


const ASSISTANT_SEL = '[data-testid="assistant-message"]';
const USER_SEL = '[data-testid="user-message"]';
const USER_TURN_SEL = '[data-cds="UserMessage"]';
const ENGINE_ROOT_SEL = '[data-transcript-engine-root]';
const CONTENT_SELECTORS = ['[data-cds="Prose"]', '[data-perf-reply-text]', '.standard-markdown'];
const COMPOSER_SELECTORS = [
  '[data-testid="chat-input"]',
  '[data-composer-editor]',
  '[contenteditable="true"][role="textbox"]',
];
const SEND_BUTTON_SEL =
  '[data-testid="chat-input-send"], button[aria-label*="メッセージを送信"], button[aria-label*="Send message"]';

export class ClaudeAdapter implements SiteAdapter {
  /** 会話の URL は /chat/<uuid>。新規チャット（/new）は会話未確定なので null */
  conversationKey(pathname: string): string | null {
    const m = pathname.match(/\/chat\/([^/]+)/);
    return m ? m[1] : null;
  }

  getObserverRoot(): HTMLElement {
    const main = document.querySelector('main');
    return (main as HTMLElement | null) ?? document.body;
  }

  /** assistant の発言を出現順に全部返す（任意の回答を指定して読ませる用） */
  assistantTurns(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_SEL));
  }

  /**
   * 本文の列を返す。検索や思考を挟んで本文が複数に分かれても続けて読めるよう、
   * 本文 1 つではなく、それらを束ねている列を優先する。
   * 列の中の検索・思考の表示（TurnStatus）は speech-sanitizer 側で読み飛ばす。
   */
  contentOfTurn(turn: HTMLElement): Element {
    const column = turn.querySelector(ENGINE_ROOT_SEL)?.parentElement;
    if (column && column !== turn) return column;
    for (const sel of CONTENT_SELECTORS) {
      const hit = turn.querySelector(sel);
      if (hit) return hit;
    }
    return turn;
  }

  /**
   * 質問の発言を出現順に全部返す（任意の質問を指定して読ませる用）。
   * 吹き出しと Claude のボタン列を束ねている枠を返す。見つからなければ本文そのもの。
   */
  userTurns(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(USER_SEL)).map(
      (body) => body.closest<HTMLElement>(USER_TURN_SEL) ?? body,
    );
  }

  /** 質問の発言から本文要素を取り出す（添付やボタン列は含めない） */
  contentOfUserTurn(turn: HTMLElement): Element {
    return turn.matches(USER_SEL) ? turn : (turn.querySelector(USER_SEL) ?? turn);
  }

  getLatestAssistantMessage(): AssistantMessage | null {
    const turns = this.assistantTurns();
    if (turns.length === 0) return null;
    const turn = turns[turns.length - 1];
    const key = turn.getAttribute('data-turn-key');
    return {
      id: key ? `turn:${key}` : `${location.pathname}:assistant-${turns.length - 1}`,
      element: turn,
      content: this.contentOfTurn(turn),
    };
  }

  /**
   * 質問の同一性は本文で表す。ターンの鍵は送信直後に差し替わる可能性があり、
   * 差し替えを「新しい質問」と取り違えると読み上げを止めてしまうため。
   */
  getLatestUserMessageId(): string | null {
    const users = document.querySelectorAll<HTMLElement>(USER_SEL);
    if (users.length === 0) return null;
    const text = (users[users.length - 1].textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return text ? `user:${text}` : null;
  }

  /**
   * 生成中かどうか。取れなくなっても、observer 側の
   * 「本文が増え続けているか」判定で読み上げは続く。
   */
  isGenerating(): boolean {
    if (document.querySelector('[data-testid="chat-input-stop"]')) return true;
    if (document.querySelector(`${ASSISTANT_SEL}[data-is-streaming="true"]`)) return true;
    if (document.querySelector('[data-testid="transcript-row"][data-perf-row-streaming="true"]')) return true;
    return false;
  }

  getComposer(): HTMLElement | null {
    for (const sel of COMPOSER_SELECTORS) {
      const hit = document.querySelector<HTMLElement>(sel);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 質問の送信操作を検出する。「読み上げを解禁してよい」の一番確かな根拠。
   *
   * Claude 側がイベントを止めても拾えるよう、capture で document に付ける。
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
        if (t.closest(SEND_BUTTON_SEL)) cb();
      },
      true,
    );
  }

  probe(): { ok: boolean; detail: string } {
    const turns = document.querySelectorAll(`${ASSISTANT_SEL}, ${USER_SEL}`).length;
    const composer = this.getComposer() !== null;
    const ok = composer || turns > 0;
    const detail = `turns=${turns} composer=${composer}`;
    if (ok) log('Claude', 'probe ok', detail);
    else warn('Claude', 'DOM を認識できません', detail);
    return { ok, detail };
  }
}

/**
 * Claude の回答に付く、本文ではない部品。
 * - 「ウェブを検索しました」「思考中」などの進行表示と、コピー等のボタン列（時刻の表示を含む）
 * - 出典チップ。本文の途中に <span data-not-prose> でサイト名が差し込まれる。
 *   コードの枠も data-not-prose を持つが、そちらは <div> なので巻き込まない
 */
function isClaudeChrome(el: Element): boolean {
  const cds = el.getAttribute('data-cds');
  if (cds === 'TurnStatus' || cds === 'MessageActions') return true;
  return el.tagName === 'SPAN' && el.hasAttribute('data-not-prose');
}

export const claudeSite: Site = {
  id: 'claude',
  label: 'Claude',
  createAdapter: () => new ClaudeAdapter(),
  sanitize: {
    skip: isClaudeChrome,
    // Claude のコード枠。言語名のラベル（python など）を読まないよう、中の pre だけを扱う
    isCodeFrame: (el) =>
      el.tagName !== 'PRE' && el.getAttribute('role') === 'group' && el.querySelector('pre') !== null,
  },
  readButtons: {
    // 発言の「上の空き」に出す。回答は左寄せ・質問は右寄せなので、回答は左上、質問は右上。
    // こうすると Claude 自身のボタン列（回答は左下、質問は右下）とも重ならない。
    css: `
[data-cvb-read-btn] { top: -24px; }
[data-cvb-read-btn="answer"] { left: 0; }
[data-cvb-read-btn="question"] { right: 0; }
/* ボタンは発言の枠の外にあるので、発言からボタンへマウスを動かす途中で消えないよう隙間を埋める */
[data-cvb-read-btn]::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 4px; }
`,
  },
};
