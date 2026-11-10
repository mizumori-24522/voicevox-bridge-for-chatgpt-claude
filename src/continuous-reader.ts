/**
 * 「ここから続けて読む」: 押した発言から会話の最後まで、順番に読み上げる。
 *
 * 会話は仮想化されていて、画面の外の発言は DOM に無いことがある。
 * そこで全部を先に集めるのではなく、1 つ読み終えるたびに
 * 「今の発言の次」を探して進む。読む発言へ画面を送るので、
 * 次の発言はそのつど描画される。
 */

export type ContinuousTurn = { el: HTMLElement; kind: 'answer' | 'question' };

export type ContinuousDeps = {
  /** 今 DOM にある、読む対象の発言を画面の順に返す */
  listTurns(): ContinuousTurn[];
  /** 発言の読み上げテキスト（発言を見失ったときの照合に使う） */
  textOf(turn: ContinuousTurn): string;
  /** 発言を読み上げの列へ入れる。読むものが無ければ false */
  speak(turn: ContinuousTurn): boolean;
  /** 読んでいる途中の文も、これから読む文も無いか */
  isIdle(): boolean;
  /** 発言を画面に出す。block は発言の頭（start）か末尾（end）のどちらを見せるか */
  reveal(el: HTMLElement, block: 'start' | 'end'): void;
  /** 最後まで読み終えた、または続きを見つけられずに終わった */
  onFinish(reason: 'done' | 'lost'): void;
  /**
   * 今の発言と次の発言の間に、まだ描画されていない発言が無いか。
   * 省略時は「無い」とみなす。
   */
  isContiguous?(a: HTMLElement, b: HTMLElement): boolean;
  /** 間が抜けているとき、続きを描画させるために画面を少し先へ送る */
  nudge?(el: HTMLElement): void;
  /** 次の発言を探す前に、描画を待つ時間（ms） */
  settleMs?: number;
};

/** 間の発言が描画されるのを、何回まで待ち直すか */
const MAX_GAP_RETRIES = 12;

const KEY_LENGTH = 200;

export class ContinuousReader {
  private current: { turn: ContinuousTurn; key: string } | null = null;
  /** cancel や start のたびに増やす。古い待ち時間の続きを捨てるため */
  private token = 0;
  private advancing = false;
  private gapRetries = 0;

  constructor(private deps: ContinuousDeps) {}

  get active(): boolean {
    return this.current !== null;
  }

  /** この発言から読み始める */
  start(turn: ContinuousTurn): void {
    this.token++;
    this.advancing = false;
    this.play(turn);
  }

  /** 止める（STOP・新しい質問・ほかの読み上げを始めたとき） */
  cancel(): void {
    this.token++;
    this.advancing = false;
    this.current = null;
  }

  /** 読み上げの列が空になったら呼ぶ。次の発言へ進む */
  onIdle(): void {
    if (!this.current || this.advancing) return;
    this.advancing = true;
    const el = this.current.turn.el;
    // 今の発言の末尾を見せると、すぐ後ろの発言が描画される
    if (el.isConnected) this.deps.reveal(el, 'end');
    this.advanceSoon();
  }

  private advanceSoon(): void {
    const token = this.token;
    setTimeout(() => {
      if (token !== this.token) return;
      if (!this.deps.isIdle()) {
        this.advancing = false;
        return;
      }
      const cur = this.current;
      const next = this.findNext();
      if (next === 'lost') return this.finish('lost');
      if (next === null) return this.finish('done');
      if (cur && cur.turn.el.isConnected && this.deps.isContiguous?.(cur.turn.el, next.el) === false) {
        // DOM の上では隣でも、間の発言がまだ描画されていない。飛ばさずに待つ
        if (++this.gapRetries > MAX_GAP_RETRIES) return this.finish('lost');
        this.deps.nudge?.(cur.turn.el);
        return this.advanceSoon();
      }
      this.advancing = false;
      this.play(next);
    }, this.deps.settleMs ?? 400);
  }

  private finish(reason: 'done' | 'lost'): void {
    this.advancing = false;
    this.current = null;
    this.deps.onFinish(reason);
  }

  private play(turn: ContinuousTurn): void {
    this.gapRetries = 0;
    this.current = { turn, key: this.deps.textOf(turn).slice(0, KEY_LENGTH) };
    this.deps.reveal(turn.el, 'start');
    if (!this.deps.speak(turn)) {
      // 読むものが無い発言（絵文字だけなど）は飛ばす
      const token = this.token;
      setTimeout(() => {
        if (token === this.token) this.onIdle();
      }, 0);
    }
  }

  private findNext(): ContinuousTurn | null | 'lost' {
    const cur = this.current;
    if (!cur) return null;
    const turns = this.deps.listTurns();
    let i = turns.findIndex((t) => t.el === cur.turn.el);
    if (i < 0 && cur.key) {
      // 再描画で要素が作り直された。同じ種類・同じ書き出しの発言を今の位置とみなす
      i = turns.findIndex((t) => t.kind === cur.turn.kind && this.deps.textOf(t).slice(0, KEY_LENGTH) === cur.key);
    }
    if (i < 0) return 'lost';
    return turns[i + 1] ?? null;
  }
}

/** 回答と質問を、画面に並んでいる順に 1 本にまとめる */
export function mergeTurns(answers: HTMLElement[], questions: HTMLElement[]): ContinuousTurn[] {
  const all: ContinuousTurn[] = [
    ...answers.map((el) => ({ el, kind: 'answer' as const })),
    ...questions.map((el) => ({ el, kind: 'question' as const })),
  ];
  return all.sort((a, b) =>
    a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}
