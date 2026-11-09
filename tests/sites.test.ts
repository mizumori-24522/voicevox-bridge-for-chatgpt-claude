import { describe, it, expect } from 'vitest';
import { detectSite } from '../src/sites';
import { claudeSite } from '../src/sites/claude';
import { chatgptSite } from '../src/sites/chatgpt';
import { DEFAULT_SANITIZE_OPTIONS, extractSpeechText } from '../src/speech-sanitizer';

describe('detectSite', () => {
  it('picks the site from the hostname', () => {
    expect(detectSite('claude.ai')?.id).toBe('claude');
    expect(detectSite('chatgpt.com')?.id).toBe('chatgpt');
    expect(detectSite('chat.openai.com')?.id).toBe('chatgpt');
  });

  it('returns null for other sites', () => {
    expect(detectSite('example.com')).toBeNull();
    expect(detectSite('claude.ai.example.com')).toBeNull();
  });
});

describe('サイトごとの読み飛ばし規則', () => {
  const html =
    '<div data-cds="TurnStatus">ウェブを検索しました</div><p>本文です。<span data-not-prose>example.com</span></p>';

  it('skips Claude-only parts on Claude', () => {
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(extractSpeechText(el, { ...DEFAULT_SANITIZE_OPTIONS, site: claudeSite.sanitize })).toBe('本文です。');
  });

  it('does not apply the Claude rules on ChatGPT', () => {
    const el = document.createElement('div');
    el.innerHTML = html;
    const text = extractSpeechText(el, { ...DEFAULT_SANITIZE_OPTIONS, site: chatgptSite.sanitize });
    expect(text).toContain('ウェブを検索しました');
    expect(text).toContain('example.com');
  });

  it('reads only the code inside a Claude code frame, not its language label', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>前</p><div role="group"><div>python</div><pre><code>print(1)</code></pre></div><p>後</p>';
    const text = extractSpeechText(el, { ...DEFAULT_SANITIZE_OPTIONS, site: claudeSite.sanitize });
    expect(text).not.toContain('python');
    expect(text).toContain('ここにコードがあります。');
  });
});
