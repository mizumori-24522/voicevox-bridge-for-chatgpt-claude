import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncReadButtons, removeReadButtons } from '../../src/message-actions';
import { claudeSite } from '../../src/sites/claude';

const LAYOUT = claudeSite.readButtons;

const BTN = '[data-cvb-read-btn]';

function turns(n: number): HTMLElement[] {
  document.body.innerHTML = Array.from({ length: n }, (_, i) => `<div class="turn" id="t${i}"><p>本文</p></div>`).join('');
  return Array.from(document.querySelectorAll<HTMLElement>('.turn'));
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('syncReadButtons', () => {
  it('adds one button per turn and stays idempotent', () => {
    const list = turns(2);
    syncReadButtons(list, 'answer', () => {}, LAYOUT);
    syncReadButtons(list, 'answer', () => {}, LAYOUT);
    expect(document.querySelectorAll(BTN)).toHaveLength(2);
    expect(document.querySelectorAll('#cvb-actions-style')).toHaveLength(1);
  });

  it('labels answers and questions differently and puts them on opposite sides', () => {
    const [answer, question] = turns(2);
    syncReadButtons([answer], 'answer', () => {}, LAYOUT);
    syncReadButtons([question], 'question', () => {}, LAYOUT);
    expect(answer.querySelector(BTN)!.textContent).toBe('🔊 この回答を読む');
    expect(answer.querySelector(BTN)!.getAttribute('data-cvb-read-btn')).toBe('answer');
    expect(question.querySelector(BTN)!.textContent).toBe('🔊 この質問を読む');
    expect(question.querySelector(BTN)!.getAttribute('data-cvb-read-btn')).toBe('question');

    // 本文に重ねない：枠の上の空きに出し、回答は左・質問は右
    const css = document.getElementById('cvb-actions-style')!.textContent!;
    expect(css).toMatch(/\[data-cvb-read-btn\]\s*\{[^}]*top:\s*-24px/);
    expect(css).toMatch(/\[data-cvb-read-btn="answer"\]\s*\{\s*left:\s*0/);
    expect(css).toMatch(/\[data-cvb-read-btn="question"\]\s*\{\s*right:\s*0/);
  });

  it('calls back with the turn that was clicked', () => {
    const list = turns(2);
    const onRead = vi.fn();
    syncReadButtons(list, 'question', onRead, LAYOUT);
    list[1].querySelector<HTMLElement>(BTN)!.click();
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledWith(list[1]);
  });

  it('puts the button back when the site re-renders the turn and drops it', () => {
    const list = turns(1);
    syncReadButtons(list, 'answer', () => {}, LAYOUT);
    list[0].querySelector(BTN)!.remove();
    syncReadButtons(list, 'answer', () => {}, LAYOUT);
    expect(list[0].querySelectorAll(BTN)).toHaveLength(1);
  });

  it('removeReadButtons clears everything', () => {
    const list = turns(2);
    syncReadButtons(list, 'answer', () => {}, LAYOUT);
    removeReadButtons();
    expect(document.querySelectorAll(BTN)).toHaveLength(0);
    expect(document.querySelectorAll('[data-cvb-actions]')).toHaveLength(0);
  });
});
