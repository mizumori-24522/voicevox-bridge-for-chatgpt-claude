import type { AssistantMessage, SiteAdapter } from './types';

/**
 * 同じサイトの中で、画面（URL）によって DOM の読み方を切り替える。
 *
 * claude.ai では、左上のボタンでチャット（/new, /chat/…）と Claude Code（/code…）を
 * ページを読み直さずに行き来できる。起動したときの画面で部品を決めてしまうと、
 * 切り替えたあとに読めなくなるので、呼ばれるたびに今の URL で選ぶ。
 */
export class SwitchAdapter implements SiteAdapter {
  constructor(
    private normal: SiteAdapter,
    private alt: SiteAdapter,
    private useAlt: (pathname: string) => boolean,
  ) {}

  private get current(): SiteAdapter {
    return this.useAlt(location.pathname) ? this.alt : this.normal;
  }

  get resumesAfterPause(): boolean {
    return this.current.resumesAfterPause === true;
  }

  getObserverRoot(): HTMLElement {
    return this.current.getObserverRoot();
  }
  assistantTurns(): HTMLElement[] {
    return this.current.assistantTurns();
  }
  contentOfTurn(turn: HTMLElement): Element {
    return this.current.contentOfTurn(turn);
  }
  userTurns(): HTMLElement[] {
    return this.current.userTurns();
  }
  contentOfUserTurn(turn: HTMLElement): Element {
    return this.current.contentOfUserTurn(turn);
  }
  getLatestAssistantMessage(): AssistantMessage | null {
    return this.current.getLatestAssistantMessage();
  }
  getLatestUserMessageId(): string | null {
    return this.current.getLatestUserMessageId();
  }
  isGenerating(): boolean {
    return this.current.isGenerating();
  }
  getComposer(): HTMLElement | null {
    return this.current.getComposer();
  }
  /** どちらの画面の送信も拾えるよう、両方に付けておく（各部品が自分の入力欄だけを見る） */
  onSubmit(cb: () => void): void {
    this.normal.onSubmit(cb);
    this.alt.onSubmit(cb);
  }
  conversationKey(pathname: string): string | null {
    return (this.useAlt(pathname) ? this.alt : this.normal).conversationKey(pathname);
  }
  probe(): { ok: boolean; detail: string } {
    return this.current.probe();
  }
  isContiguous(a: HTMLElement, b: HTMLElement): boolean {
    return this.current.isContiguous?.(a, b) ?? true;
  }
}
