import { loadSettings, saveSettings, type Settings } from './settings';
import { setDebug, log, warn, error } from './logger';
import { VoicevoxClient, flattenStyles, resolveStyle, describeError, type StyleOption } from './voicevox-client';
import { PlaybackQueue } from './playback-queue';
import { detectSite } from './sites';
import type { Site } from './sites/types';
import { ChatObserver } from './observer';
import { UiPanel } from './ui';
import { DEFAULT_SANITIZE_OPTIONS, extractSpeechText, type SanitizeOptions } from './speech-sanitizer';
import { SpeechChunker, type ChunkerOptions } from './chunker';
import { syncReadButtons, removeReadButtons, getSelectionFragment } from './message-actions';
import { ContinuousReader, mergeTurns, type ContinuousTurn } from './continuous-reader';
import { gmAvailable } from './http';
import { IconCache } from './icon-cache';

function main(site: Site): void {
  let settings: Settings = loadSettings();
  setDebug(settings.debug);

  const client = new VoicevoxClient(settings.engineOrigin);
  const adapter = site.createAdapter();
  const icons = new IconCache(client);
  let styleOptions: StyleOption[] = [];

  const queue = new PlaybackQueue({
    client,
    getStyleId: () => settings.styleId,
    getParams: () => ({
      speedScale: settings.speedScale,
      volumeScale: settings.volumeScale,
      pitchScale: settings.pitchScale,
      intonationScale: settings.intonationScale,
      prePhonemeLength: settings.prePhonemeLength,
      postPhonemeLength: settings.postPhonemeLength,
      pauseLengthScale: settings.pauseLengthScale,
    }),
    onError: (msg) => {
      // 合成に失敗したまま次の発言へ進み続けないよう、続けて読むのもやめる
      continuous.cancel();
      ui.setStatus(msg, true);
      if (msg.includes('接続')) void connect();
    },
    onStateChange: (s) => {
      ui.setPlayback(s);
      if (s.paused) ui.setStatus(`一時停止中（待ち ${s.queued}）`);
      else if (!s.speaking && s.queued === 0) ui.setStatus('');
      else ui.setStatus(`${s.speaking ? '読み上げ中' : '合成中'}（待ち ${s.queued}）`);
      if (s.idle) continuous.onIdle();
    },
  });

  const ui = new UiPanel(settings, {
    onToggleEnabled: (v) => {
      update({ enabled: v });
      if (!v) {
        stopSpeaking();
        removeReadButtons();
      }
    },
    onStop: () => stopSpeaking(),
    onTogglePause: () => (queue.snapshot.paused ? queue.resume() : queue.pause()),
    onReconnect: () => void connect(),
    onTestSpeak: () => queue.enqueue('ボイスボックス接続テストです。'),
    onSpeakSelection: () => speakSelection(),
    loadIcon: (styleId) => icons.icon(styleId),
    onChange: (patch) => update(patch),
  });

  const sanitizeOptions = (): SanitizeOptions => ({
    ...DEFAULT_SANITIZE_OPTIONS,
    urlMode: settings.urlMode,
    codeMode: settings.codeMode,
    tableMode: settings.tableMode,
    readSymbols: settings.readSymbols,
    site: site.sanitize,
  });
  const chunkerOptions = (): ChunkerOptions => ({
    minimumChunkLength: settings.minimumChunkLength,
    preferredChunkLength: settings.preferredChunkLength,
    maximumChunkLength: settings.maximumChunkLength,
  });

  /**
   * 指定した要素の内容を、今の設定で整形してから最初から読み上げる。
   * styleId を渡すと、その話者で読む（省略時は今選んでいる話者）。
   */
  function speakElement(el: Element, styleId?: number): void {
    stopSpeaking();
    if (!enqueueElement(el, styleId)) ui.setStatus('読み上げる内容がありません', true);
  }

  /** 今の読み上げを止めずに、要素の内容を列の後ろへ足す。読むものが無ければ false */
  function enqueueElement(el: Element, styleId?: number): boolean {
    const text = extractSpeechText(el, sanitizeOptions());
    if (!text) return false;
    const chunker = new SpeechChunker(chunkerOptions());
    chunker.append(text);
    const chunks = chunker.take(true);
    for (const c of chunks) queue.enqueue(c, styleId);
    return chunks.length > 0;
  }

  const contentOf = (t: ContinuousTurn): Element =>
    t.kind === 'answer' ? adapter.contentOfTurn(t.el) : adapter.contentOfUserTurn(t.el);

  /** 「ここから続けて読む」。押した回答から会話の最後まで順に読む */
  const continuous = new ContinuousReader({
    listTurns: () =>
      mergeTurns(adapter.assistantTurns(), settings.continuousReadsQuestions ? adapter.userTurns() : []),
    textOf: (t) => extractSpeechText(contentOf(t), sanitizeOptions()),
    speak: (t) => enqueueElement(contentOf(t), t.kind === 'question' ? questionStyleId() : undefined),
    isIdle: () => queue.snapshot.idle,
    reveal: (el, block) => el.scrollIntoView({ behavior: 'smooth', block }),
    isContiguous: (a, b) => adapter.isContiguous?.(a, b) ?? true,
    nudge: (el) => {
      // 発言を入れているスクロール枠を探して、半画面ぶん先へ送る
      let p = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(p).overflowY))) {
        p = p.parentElement;
      }
      p?.scrollBy({ top: p.clientHeight * 0.6 });
    },
    onFinish: (reason) => {
      if (reason === 'lost') ui.setStatus('続きの発言を見つけられませんでした', true);
    },
  });

  /** 自分の質問を読む声。選んでいない、または今のエンジンに無い話者なら回答と同じ声 */
  function questionStyleId(): number | undefined {
    const id = settings.questionStyleId;
    return id !== null && styleOptions.some((o) => o.styleId === id) ? id : undefined;
  }

  function speakSelection(): void {
    const fragment = getSelectionFragment();
    if (!fragment) {
      ui.setStatus('先に読みたい部分を選択してください', true);
      return;
    }
    const holder = document.createElement('div');
    holder.appendChild(fragment);
    speakElement(holder);
  }

  const observer = new ChatObserver({
    adapter,
    getEnabled: () => settings.enabled,
    getSanitizeOptions: sanitizeOptions,
    getChunkerOptions: chunkerOptions,
    onChunk: (text) => {
      if (!settings.enabled) return;
      queue.enqueue(text);
    },
    getReadOnOpen: () => settings.readOnOpen,
    onOpenChat: (content) => speakElement(content),
    onNewUserMessage: () => {
      if (settings.stopOnNewQuestion) stopSpeaking();
    },
    thinking: {
      getWaitSeconds: () => (settings.thinkingNotice ? settings.thinkingNoticeSeconds : null),
      // 続けて読んでいる最中は、発言と発言の間の一瞬の空きに割り込まない
      isSpeechIdle: () => queue.snapshot.idle && !continuous.active,
      onNotice: (count) => queue.enqueue(count === 1 ? '考え中です。' : 'まだ考えています。'),
    },
  });

  function stopSpeaking(): void {
    continuous.cancel();
    queue.stopAll();
    observer.resetBuffers();
    ui.setStatus('');
  }

  function update(patch: Partial<Settings>): void {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    setDebug(settings.debug);
    ui.setSettings(settings);
  }

  async function connect(): Promise<void> {
    ui.setConnection('connecting', '接続中…');
    try {
      const version = await client.version();
      const speakers = await client.speakers();
      styleOptions = flattenStyles(speakers);
      icons.setOptions(styleOptions);
      const chosen = resolveStyle(styleOptions, settings.styleId);
      ui.setSpeakers(styleOptions, chosen?.styleId ?? null);
      if (chosen && chosen.styleId !== settings.styleId) {
        update({ styleId: chosen.styleId, speakerLabel: chosen.label });
      } else {
        ui.setSettings(settings);
      }
      ui.setConnection('connected', `v${version}`);
      ui.setStatus(chosen ? '' : '話者が見つかりません', !chosen);
      log('VOICEVOX', 'connected', version, `${styleOptions.length} styles`);
    } catch (e) {
      warn('VOICEVOX', 'connect failed', e);
      ui.setConnection('disconnected', '未接続');
      ui.setStatus(`${describeError(e)}。VOICEVOXを起動してください`, true);
    }
  }

  ui.setSettings(settings);
  const probe = adapter.probe();
  if (!probe.ok) ui.setStatus(`${site.label}の画面を認識できません`, true);
  if (!gmAvailable()) {
    warn('Main', 'GM_xmlhttpRequest が使えません。fetch へフォールバックします（CORSに注意）');
  }

  observer.start();
  adapter.onSubmit(() => observer.notifySubmitted());
  void connect();

  // 過去の回答と質問へ「この回答を読む」「この質問を読む」ボタンを差し込む。
  // 会話は仮想化されるので、新しく現れたターンへ定期的に付け直す。
  window.setInterval(() => {
    try {
      ui.ensureMounted();
    } catch (e) {
      warn('UI', 'パネルの再設置に失敗', e);
    }
    if (!settings.enabled) return;
    try {
      syncReadButtons(
        adapter.assistantTurns(),
        'answer',
        (turn) => speakElement(adapter.contentOfTurn(turn)),
        site.readButtons,
      );
      syncReadButtons(
        adapter.assistantTurns(),
        'continue',
        (turn) => {
          stopSpeaking();
          continuous.start({ el: turn, kind: 'answer' });
        },
        site.readButtons,
      );
      syncReadButtons(
        adapter.userTurns(),
        'question',
        (turn) => speakElement(adapter.contentOfUserTurn(turn), questionStyleId()),
        site.readButtons,
      );
    } catch (e) {
      warn('UI', 'ボタン差し込みに失敗', e);
    }
  }, 1000);

  log('Main', `VOICEVOX Bridge started on ${site.label}`);
}

function boot(): void {
  const site = detectSite(location.hostname);
  if (!site) {
    warn('Main', '対象外のサイトです', location.hostname);
    return;
  }
  main(site);
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
  } else {
    boot();
  }
} catch (e) {
  // UserScript が壊れてもサイト本体の操作を妨げない
  error('Main', 'fatal', e);
}
