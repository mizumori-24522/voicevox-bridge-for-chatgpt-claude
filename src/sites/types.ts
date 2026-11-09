/**
 * サイト（ChatGPT / Claude）ごとに違う部分の約束事。
 * 共通部分（observer・読み上げ・パネル）はこの型だけを見て動く。
 */

export type AssistantMessage = {
  id: string;
  element: HTMLElement;
  content: Element;
};

/** 画面の DOM を読むための部品。サイトの DOM 依存はすべてここへ隔離する */
export interface SiteAdapter {
  getObserverRoot(): HTMLElement;
  /** assistant の発言を出現順に全部返す */
  assistantTurns(): HTMLElement[];
  /** 回答の発言から本文要素を取り出す */
  contentOfTurn(turn: HTMLElement): Element;
  /** 質問の発言を出現順に全部返す */
  userTurns(): HTMLElement[];
  /** 質問の発言から本文要素を取り出す */
  contentOfUserTurn(turn: HTMLElement): Element;
  getLatestAssistantMessage(): AssistantMessage | null;
  getLatestUserMessageId(): string | null;
  isGenerating(): boolean;
  getComposer(): HTMLElement | null;
  /** 質問の送信操作を検出する */
  onSubmit(cb: () => void): void;
  /** URL から会話 ID を取り出す。新規チャットなど会話未確定なら null */
  conversationKey(pathname: string): string | null;
  probe(): { ok: boolean; detail: string };
}

/** 本文から読み上げテキストを取り出すときの、サイト固有の決まり */
export type SiteSanitizeRules = {
  /** 本文ではない部品（進行表示・ボタン列・出典チップなど）なら true */
  skip(el: Element): boolean;
  /**
   * コード枠（言語名のラベルと pre を束ねた枠）なら true。
   * true のときは中の pre だけを読む。
   */
  isCodeFrame(el: Element): boolean;
};

/** 「この回答を読む」「この質問を読む」ボタンの置き場所 */
export type ReadButtonLayout = {
  /** ボタンの位置だけを決める CSS。見た目の共通部分は message-actions 側にある */
  css: string;
  /** 質問ボタンの位置を毎回測って合わせる（必要なサイトだけ） */
  alignQuestion?(turn: HTMLElement, btn: HTMLElement): void;
};

export type SiteId = 'claude' | 'chatgpt';

export type Site = {
  id: SiteId;
  /** 画面やログに出す名前 */
  label: string;
  createAdapter(): SiteAdapter;
  sanitize: SiteSanitizeRules;
  readButtons: ReadButtonLayout;
};
