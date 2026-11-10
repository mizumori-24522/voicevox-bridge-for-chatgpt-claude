// ==UserScript==
// @name         VOICEVOX Bridge for ChatGPT & Claude
// @namespace    local.voicevox-bridge-for-chatgpt-claude
// @version      1.2.0
// @author       mizumori-24522
// @description  ChatGPT Web と Claude Web（Claude Code の claude.ai/code も）の回答を VOICEVOX で逐次読み上げする
// @homepageURL  https://github.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude
// @supportURL   https://github.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude/issues
// @downloadURL  https://raw.githubusercontent.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude/main/dist/voicevox-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/mizumori-24522/voicevox-bridge-for-chatgpt-claude/main/dist/voicevox-bridge.user.js
// @match        https://claude.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    styleId: null,
    speakerLabel: "",
    questionStyleId: null,
    recentStyleIds: [],
    favoriteSpeakers: [],
    collapsedPickerGroups: [],
    speedScale: 1.15,
    volumeScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    prePhonemeLength: 0,
    postPhonemeLength: 0.05,
    pauseLengthScale: 0.9,
    urlMode: "announce",
    codeMode: "announce-once",
    tableMode: "announce",
    readSymbols: false,
    readOnOpen: true,
    stopOnNewQuestion: true,
    continuousReadsQuestions: false,
    thinkingNotice: true,
    thinkingNoticeSeconds: 10,
    engineOrigin: "http://127.0.0.1:50021",
    debug: false,
    minimumChunkLength: 35,
    preferredChunkLength: 110,
    maximumChunkLength: 180
  };
  const KEY = "cvb.settings.v2";
  const LEGACY_KEY = "cvb.settings.v1";
  function migrate(old) {
    const next = { ...old };
    if (next.codeMode === "announce") next.codeMode = "announce-once";
    return next;
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const migrated = migrate(JSON.parse(legacy));
        const settings = { ...DEFAULT_SETTINGS, ...migrated };
        saveSettings(settings);
        return settings;
      }
      return { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
    }
  }
  let debugEnabled = false;
  function setDebug(v) {
    debugEnabled = v;
  }
  function log(tag, ...args) {
    if (!debugEnabled) return;
    console.log(`[${tag}]`, ...args);
  }
  function warn(tag, ...args) {
    console.warn(`[${tag}]`, ...args);
  }
  function error(tag, ...args) {
    console.error(`[${tag}]`, ...args);
  }
  class HttpError extends Error {
    constructor(status, url, body) {
      super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
      this.status = status;
      this.url = url;
      this.body = body;
      this.name = "HttpError";
    }
  }
  class NetworkError extends Error {
    constructor(message) {
      super(message);
      this.name = "NetworkError";
    }
  }
  class AbortError extends Error {
    constructor() {
      super("aborted");
      this.name = "AbortError";
    }
  }
  function gmAvailable() {
    return typeof GM_xmlhttpRequest === "function";
  }
  async function request(opts) {
    if (gmAvailable()) return gmRequest(opts);
    return fetchRequest(opts);
  }
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      var _a, _b;
      if ((_a = opts.signal) == null ? void 0 : _a.aborted) return reject(new AbortError());
      const headers = {};
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      const handle = GM_xmlhttpRequest({
        method: opts.method,
        url: opts.url,
        headers,
        data: opts.body,
        responseType: opts.responseType === "arraybuffer" ? "arraybuffer" : "text",
        timeout: opts.timeoutMs ?? 3e4,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            reject(new HttpError(r.status, opts.url, r.responseText ?? ""));
            return;
          }
          if (opts.responseType === "arraybuffer") {
            resolve(r.response);
          } else {
            resolve(r.responseText);
          }
        },
        onerror: () => reject(new NetworkError(`接続失敗: ${opts.url}`)),
        ontimeout: () => reject(new NetworkError(`タイムアウト: ${opts.url}`)),
        onabort: () => reject(new AbortError())
      });
      (_b = opts.signal) == null ? void 0 : _b.addEventListener("abort", () => handle.abort(), { once: true });
    });
  }
  async function fetchRequest(opts) {
    var _a, _b;
    const controller = new AbortController();
    (_a = opts.signal) == null ? void 0 : _a.addEventListener("abort", () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3e4);
    try {
      const res = await fetch(opts.url, {
        method: opts.method,
        body: opts.body,
        headers: opts.contentType ? { "Content-Type": opts.contentType } : void 0,
        signal: controller.signal
      });
      if (!res.ok) throw new HttpError(res.status, opts.url, await res.text().catch(() => ""));
      return opts.responseType === "arraybuffer" ? await res.arrayBuffer() : await res.text();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if ((_b = opts.signal) == null ? void 0 : _b.aborted) throw new AbortError();
      if (e instanceof DOMException && e.name === "AbortError") throw new NetworkError("タイムアウト");
      throw new NetworkError(`接続失敗: ${opts.url} (${String(e)})`);
    } finally {
      clearTimeout(timer);
    }
  }
  class VoicevoxClient {
    constructor(origin) {
      this.origin = origin;
    }
    setOrigin(origin) {
      this.origin = origin.replace(/\/+$/, "");
    }
    getOrigin() {
      return this.origin;
    }
    async version() {
      const text = await request({
        method: "GET",
        url: `${this.origin}/version`,
        responseType: "text",
        timeoutMs: 4e3
      });
      return text.replace(/^"|"$/g, "").trim();
    }
    async speakers() {
      const text = await request({
        method: "GET",
        url: `${this.origin}/speakers`,
        responseType: "text",
        timeoutMs: 8e3
      });
      return JSON.parse(text);
    }
    /**
     * キャラクター画像の情報。
     *
     * 既定のままだとサンプル音声まで base64 で同梱され 1 キャラ 5MB 超になるため、
     * resource_format=url で URL だけ受け取る。古いエンジンが未対応なら base64 で取り直す。
     */
    async speakerInfo(speakerUuid) {
      const base = `${this.origin}/speaker_info?speaker_uuid=${encodeURIComponent(speakerUuid)}`;
      let text;
      try {
        text = await request({
          method: "GET",
          url: `${base}&resource_format=url`,
          responseType: "text",
          timeoutMs: 8e3
        });
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 422) throw e;
        text = await request({ method: "GET", url: base, responseType: "text", timeoutMs: 2e4 });
      }
      const raw = JSON.parse(text);
      return {
        portrait: raw.portrait,
        styleIcons: new Map(raw.style_infos.map((s) => [s.id, s.icon]))
      };
    }
    /**
     * 画像リソースを <img> で表示できる URL に変換する。
     *
     * claude.ai や chatgpt.com のページから http://127.0.0.1 の画像は直接読めない
     * （Private Network Access で止まる）ため、バイト列を取ってきて blob: にする。
     */
    async imageUrl(resource) {
      if (!/^https?:\/\//.test(resource)) return `data:image/png;base64,${resource}`;
      if (!resource.startsWith(`${this.origin}/`)) throw new Error(`unexpected resource origin: ${resource}`);
      const bytes = await request({
        method: "GET",
        url: resource,
        responseType: "arraybuffer",
        timeoutMs: 8e3
      });
      return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    }
    /** WAV の ArrayBuffer を返す。abort されたら AbortError を投げる。 */
    async synthesize(text, styleId, params, signal) {
      const queryText = await request({
        method: "POST",
        url: `${this.origin}/audio_query?speaker=${styleId}&text=${encodeURIComponent(text)}`,
        responseType: "text",
        timeoutMs: 2e4,
        signal
      });
      const query = JSON.parse(queryText);
      for (const [key, value] of Object.entries(params)) {
        if (key in query) query[key] = value;
      }
      log("VOICEVOX", "synthesis", { styleId, len: text.length });
      return await request({
        method: "POST",
        url: `${this.origin}/synthesis?speaker=${styleId}`,
        body: JSON.stringify(query),
        contentType: "application/json",
        responseType: "arraybuffer",
        timeoutMs: 6e4,
        signal
      });
    }
  }
  function flattenStyles(speakers) {
    const out = [];
    for (const sp of speakers) {
      for (const st of sp.styles) {
        out.push({
          styleId: st.id,
          speakerName: sp.name,
          speakerUuid: sp.speaker_uuid,
          styleName: st.name,
          label: `${sp.name} / ${st.name}`
        });
      }
    }
    return out;
  }
  function resolveStyle(options, savedStyleId, preferredSpeakerNames = ["中国うさぎ"]) {
    if (options.length === 0) return null;
    if (savedStyleId !== null) {
      const hit = options.find((o) => o.styleId === savedStyleId);
      if (hit) return hit;
    }
    for (const name of preferredSpeakerNames) {
      const hit = options.find((o) => o.speakerName === name && o.styleName === "ノーマル");
      if (hit) return hit;
      const any = options.find((o) => o.speakerName === name);
      if (any) return any;
    }
    return options[0];
  }
  function describeError(e) {
    if (e instanceof AbortError) return "中断しました";
    if (e instanceof NetworkError) return "VOICEVOXへ接続できません";
    if (e instanceof HttpError) {
      if (e.status === 422) return "音声合成に失敗しました（話者IDが不正の可能性）";
      return `VOICEVOXエラー (HTTP ${e.status})`;
    }
    return "不明なエラー";
  }
  const LOOKAHEAD = 2;
  const WAIT_TIMEOUT_MS = 150;
  class PlaybackQueue {
    constructor(deps) {
      this.deps = deps;
      this.textQueue = [];
      this.audioQueue = [];
      this.synthRunning = false;
      this.playRunning = false;
      this.currentAudio = null;
      this.currentUrl = null;
      this.finishCurrent = null;
      this.paused = false;
      this.abortController = null;
      this.waiters = [];
      this.generation = 0;
    }
    /** styleId を渡すと、そのチャンクだけ指定の話者で読む（省略時は今選んでいる話者） */
    enqueue(text, styleId) {
      const t = text.trim();
      if (!t) return;
      this.textQueue.push({ text: t, styleId });
      log("Playback", "enqueue", t.slice(0, 40));
      this.notify();
      this.emit();
      void this.synthLoop();
      void this.playLoop();
    }
    /**
     * 一時停止。今の文はその場で止め、続きは resume まで流さない。
     * 止めている間に増えた文（生成中の回答の続きなど）も貯めておき、再開したら続けて読む。
     * 何も読んでいないときは何もしない。止めたまま忘れて、次の回答が黙ってしまうのを防ぐため。
     */
    pause() {
      var _a;
      if (this.paused || this.isIdle()) return;
      this.paused = true;
      (_a = this.currentAudio) == null ? void 0 : _a.pause();
      log("Playback", "pause");
      this.emit();
    }
    /** 一時停止を解いて、止めた位置から続きを読む */
    resume() {
      if (!this.paused) return;
      this.paused = false;
      log("Playback", "resume");
      const audio = this.currentAudio;
      if (audio) {
        audio.play().catch((e) => {
          var _a;
          if (this.paused || this.currentAudio !== audio) return;
          warn("Playback", "resume rejected", e);
          this.deps.onError("再生がブロックされました。ページを一度クリックしてください");
          (_a = this.finishCurrent) == null ? void 0 : _a.call(this);
        });
      }
      this.notify();
      this.emit();
      void this.playLoop();
    }
    /** 止める・読み直す・新しい質問では、一時停止も解く（新しく読むものが黙らないように） */
    stopAll() {
      var _a;
      this.generation++;
      this.paused = false;
      this.textQueue = [];
      this.audioQueue = [];
      (_a = this.abortController) == null ? void 0 : _a.abort();
      this.abortController = null;
      this.teardownAudio();
      this.synthRunning = false;
      this.playRunning = false;
      this.notify();
      log("Playback", "stopAll");
      this.emit();
    }
    get snapshot() {
      return {
        queued: this.textQueue.length + this.audioQueue.length,
        speaking: this.currentAudio !== null,
        paused: this.paused,
        idle: this.isIdle()
      };
    }
    isIdle() {
      return this.currentAudio === null && !this.synthRunning && !this.playRunning && this.textQueue.length === 0 && this.audioQueue.length === 0;
    }
    emit() {
      this.deps.onStateChange(this.snapshot);
    }
    notify() {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
    wait() {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        this.waiters.push(finish);
        setTimeout(finish, WAIT_TIMEOUT_MS);
      });
    }
    teardownAudio() {
      if (this.currentAudio) {
        this.currentAudio.onended = null;
        this.currentAudio.onerror = null;
        this.currentAudio.pause();
        this.currentAudio.src = "";
        this.currentAudio = null;
      }
      this.finishCurrent = null;
      if (this.currentUrl) {
        URL.revokeObjectURL(this.currentUrl);
        this.currentUrl = null;
      }
    }
    /** 先読みしながらテキストを音声へ変換し続ける */
    async synthLoop() {
      if (this.synthRunning) return;
      this.synthRunning = true;
      const gen = this.generation;
      try {
        while (gen === this.generation) {
          if (this.textQueue.length === 0) break;
          if (this.audioQueue.length >= LOOKAHEAD) {
            await this.wait();
            continue;
          }
          const styleId = this.textQueue[0].styleId ?? this.deps.getStyleId();
          if (styleId === null) {
            this.deps.onError("話者が選択されていません");
            this.textQueue = [];
            break;
          }
          const { text } = this.textQueue.shift();
          this.abortController = new AbortController();
          try {
            const wav = await this.deps.client.synthesize(
              text,
              styleId,
              this.deps.getParams(),
              this.abortController.signal
            );
            if (gen !== this.generation) break;
            this.audioQueue.push(wav);
            this.notify();
            this.emit();
            void this.playLoop();
          } catch (e) {
            if (e instanceof AbortError || gen !== this.generation) break;
            warn("Playback", "synthesis failed", e);
            this.deps.onError(describeError(e));
            this.textQueue = [];
            break;
          } finally {
            this.abortController = null;
          }
        }
      } finally {
        this.synthRunning = false;
        this.notify();
        this.emit();
        if (gen === this.generation && this.textQueue.length > 0) void this.synthLoop();
      }
    }
    /** 合成済みの音声を 1 本ずつ順番に再生し続ける */
    async playLoop() {
      if (this.playRunning) return;
      this.playRunning = true;
      const gen = this.generation;
      try {
        while (gen === this.generation) {
          if (this.paused) {
            await this.wait();
            continue;
          }
          if (this.audioQueue.length === 0) {
            if (!this.synthRunning && this.textQueue.length === 0) break;
            await this.wait();
            continue;
          }
          const wav = this.audioQueue.shift();
          this.notify();
          this.emit();
          await this.play(wav, gen);
        }
      } finally {
        this.playRunning = false;
        this.emit();
        if (gen === this.generation && this.audioQueue.length > 0) void this.playLoop();
      }
    }
    play(wav, gen) {
      return new Promise((resolve) => {
        if (gen !== this.generation) return resolve();
        const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        const audio = new Audio(url);
        this.currentAudio = audio;
        this.currentUrl = url;
        this.emit();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (this.currentAudio === audio) this.teardownAudio();
          else URL.revokeObjectURL(url);
          this.notify();
          this.emit();
          resolve();
        };
        this.finishCurrent = finish;
        audio.onended = finish;
        audio.onerror = () => {
          warn("Playback", "audio playback failed");
          this.deps.onError("音声の再生に失敗しました");
          finish();
        };
        audio.play().catch((e) => {
          if (this.paused && this.currentAudio === audio) return;
          warn("Playback", "play() rejected", e);
          this.deps.onError("再生がブロックされました。ページを一度クリックしてください");
          finish();
        });
      });
    }
  }
  const UNIT_SEL = "[data-content-search-unit-key]";
  const TURN_SEL = "[data-turn]";
  const TURN_FALLBACK_SEL = '[data-testid^="conversation-turn-"]';
  const ASSISTANT_SEL$2 = '[data-message-author-role="assistant"]';
  const USER_SEL$2 = '[data-message-author-role="user"]';
  const USER_BUBBLE_SEL = "[data-user-message-bubble]";
  const CONTENT_SELECTORS$1 = [
    '[data-markdown-text-style="assistant-message"]',
    ".markdown",
    '[class*="markdown"]',
    ".prose",
    '[class*="prose"]'
  ];
  function unitRole(el) {
    const key = el.getAttribute("data-content-search-unit-key") ?? "";
    if (key.endsWith(":assistant")) return "assistant";
    if (key.endsWith(":user")) return "user";
    return null;
  }
  function textKey(el) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  }
  class ChatGptAdapter {
    /** 会話の URL は /c/<id>。新規チャット（/）は会話未確定なので null */
    conversationKey(pathname) {
      const m = pathname.match(/\/c\/([^/]+)/);
      return m ? m[1] : null;
    }
    getObserverRoot() {
      const main2 = document.querySelector("main");
      return main2 ?? document.body;
    }
    /** 新構造の発言単位。無ければ空配列 */
    units(role) {
      return Array.from(document.querySelectorAll(UNIT_SEL)).filter(
        (u) => unitRole(u) === role
      );
    }
    /** assistant の発言を出現順に全部返す（任意の回答を指定して読ませる用） */
    assistantTurns() {
      const units = this.units("assistant");
      if (units.length > 0) return units;
      return this.legacyTurns().filter(
        (t) => t.getAttribute("data-turn") === "assistant" || t.getAttribute("data-turn") === null && t.querySelector(ASSISTANT_SEL$2) !== null
      );
    }
    /** 発言から本文要素を取り出す */
    contentOfTurn(turn) {
      return this.findContentRoot(this.messageOf(turn, "assistant"));
    }
    /** 質問の発言を出現順に全部返す（任意の質問を指定して読ませる用） */
    userTurns() {
      const units = this.units("user");
      if (units.length > 0) return units;
      return Array.from(document.querySelectorAll(USER_SEL$2));
    }
    /** 質問の発言から本文要素を取り出す（添付やボタン列、吹き出しに足された時刻などは含めない） */
    contentOfUserTurn(turn) {
      const bubble = turn.querySelector(USER_BUBBLE_SEL);
      return (bubble == null ? void 0 : bubble.querySelector(".whitespace-pre-wrap")) ?? bubble ?? turn;
    }
    getLatestAssistantMessage() {
      const units = this.units("assistant");
      if (units.length > 0) {
        const unit = units[units.length - 1];
        return {
          id: this.unitMessageId(unit, units.length - 1),
          element: unit,
          content: this.findContentRoot(unit)
        };
      }
      const turn = this.lastLegacyTurn("assistant");
      if (!turn) return null;
      const message = this.messageOf(turn, "assistant");
      return { id: this.legacyTurnId(turn, message), element: message, content: this.findContentRoot(message) };
    }
    getLatestUserMessageId() {
      const units = this.units("user");
      if (units.length > 0) {
        const text = textKey(units[units.length - 1]);
        return text ? `user:${text}` : null;
      }
      const turn = this.lastLegacyTurn("user");
      if (!turn) return null;
      return this.legacyTurnId(turn, this.messageOf(turn, "user"));
    }
    /**
     * 新構造の回答 ID。メッセージ ID を最優先する。
     * ターンの鍵（unit-key）は fallback-turn-N → UUID と途中で変わるので使わない。
     */
    unitMessageId(unit, index) {
      var _a;
      const ids = (_a = unit.getAttribute("data-chatgpt-search-message-ids")) == null ? void 0 : _a.trim();
      if (ids) return `msg:${ids.split(/\s+/)[0]}`;
      const sel = unit.querySelector("[data-chatgpt-selection-message-id]");
      const selId = sel == null ? void 0 : sel.getAttribute("data-chatgpt-selection-message-id");
      if (selId) return `msg:${selId}`;
      return `${location.pathname}:assistant-${index}`;
    }
    messageOf(turn, role) {
      const sel = role === "assistant" ? ASSISTANT_SEL$2 : USER_SEL$2;
      return turn.matches(sel) ? turn : turn.querySelector(sel) ?? turn;
    }
    // ---- 旧構造 ----
    legacyTurns() {
      const byTurn = document.querySelectorAll(TURN_SEL);
      if (byTurn.length > 0) return Array.from(byTurn);
      return Array.from(document.querySelectorAll(TURN_FALLBACK_SEL));
    }
    lastLegacyTurn(role) {
      const turns = this.legacyTurns();
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        const attr = t.getAttribute("data-turn");
        if (attr === role) return t;
        if (attr === null && t.querySelector(`[data-message-author-role="${role}"]`)) return t;
      }
      const sel = role === "assistant" ? ASSISTANT_SEL$2 : USER_SEL$2;
      const nodes = document.querySelectorAll(sel);
      return nodes.length > 0 ? nodes[nodes.length - 1] : null;
    }
    legacyTurnId(turn, message) {
      const turnId = turn.getAttribute("data-turn-id");
      if (turnId) return `turn:${turnId}`;
      const msgId = message.getAttribute("data-message-id");
      if (msgId) return `msg:${msgId}`;
      const testid = turn.getAttribute("data-testid");
      if (testid) return `${location.pathname}:${testid}`;
      return `${location.pathname}:idx-${this.legacyTurns().indexOf(turn)}`;
    }
    /** 本文（markdown レンダリング結果）のルート。無ければ要素自身。 */
    findContentRoot(el) {
      for (const sel of CONTENT_SELECTORS$1) {
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
    isGenerating() {
      if (document.querySelector('[data-testid="stop-button"]')) return true;
      if (document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"]')) return true;
      if (document.querySelector('[class*="result-streaming"]')) return true;
      return false;
    }
    getComposer() {
      return document.querySelector('[data-composer-body] [contenteditable="true"]') ?? document.querySelector("#prompt-textarea") ?? document.querySelector('form [contenteditable="true"]') ?? document.querySelector("form textarea");
    }
    /**
     * 質問の送信操作を検出する。「読み上げを解禁してよい」の一番確かな根拠。
     *
     * ChatGPT 側がイベントを止めても拾えるよう、capture で document に付ける。
     * 日本語入力の変換確定の Enter（isComposing）は送信ではないので除外する。
     */
    onSubmit(cb) {
      const inComposer = (t) => {
        if (!(t instanceof Element)) return false;
        const composer = this.getComposer();
        return composer !== null && (composer === t || composer.contains(t));
      };
      const hasText = () => {
        var _a;
        return (((_a = this.getComposer()) == null ? void 0 : _a.textContent) ?? "").trim().length > 0;
      };
      document.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
          if (!inComposer(e.target) || !hasText()) return;
          cb();
        },
        true
      );
      document.addEventListener(
        "click",
        (e) => {
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (t.closest('[data-testid="send-button"], button[aria-label*="送信"], button[aria-label*="Send"]')) {
            cb();
          }
        },
        true
      );
    }
    probe() {
      const turns = document.querySelectorAll(UNIT_SEL).length + this.legacyTurns().length;
      const composer = this.getComposer() !== null;
      const ok = composer || turns > 0;
      const detail = `turns=${turns} composer=${composer}`;
      if (ok) log("ChatGPT", "probe ok", detail);
      else warn("ChatGPT", "DOM を認識できません", detail);
      return { ok, detail };
    }
  }
  function alignQuestionButton(turn, btn) {
    const natives = Array.from(turn.querySelectorAll("button")).filter((b) => b !== btn && b.closest("[data-user-message-bubble]") === null).map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
    if (natives.length === 0) return;
    const box = turn.getBoundingClientRect();
    const left = Math.min(...natives.map((r) => r.left));
    const row = natives[0];
    btn.style.right = `${Math.round(box.right - left + 6)}px`;
    btn.style.bottom = `${Math.round(box.bottom - row.bottom + (row.height - btn.offsetHeight) / 2)}px`;
  }
  const chatgptSite = {
    id: "chatgpt",
    label: "ChatGPT",
    createAdapter: () => new ChatGptAdapter(),
    sanitize: {
      skip: () => false,
      isCodeFrame: () => false
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
      alignQuestion: alignQuestionButton
    }
  };
  const ROW_SEL = '[data-testid="transcript-row"]';
  const ASSISTANT_SEL$1 = '[data-testid="assistant-message"]';
  const USER_SEL$1 = '[data-testid="user-message"]';
  const USER_TURN_SEL$1 = '[data-cds="UserMessage"]';
  const ENGINE_ROOT_SEL$1 = "[data-transcript-engine-root]";
  const COMPOSER_SELECTORS$1 = [
    '[data-testid="code-prompt-input"]',
    '[data-cds="ChatComposer"] [contenteditable="true"]'
  ];
  const SEND_BUTTON_SEL$1 = '[data-testid="code-prompt-send"]';
  const STOP_BUTTON_SEL = '[data-testid="code-prompt-stop"]';
  const WORKING_SEL = '[data-testid="code-working-line"][data-turn-working="true"]';
  function isClaudeCodePath(pathname) {
    return pathname === "/code" || pathname.startsWith("/code/");
  }
  function isHumanRow(row) {
    const kind = row.getAttribute("data-perf-row");
    if (kind) return kind === "human";
    return row.querySelector(USER_SEL$1) !== null;
  }
  function rowIndex(row) {
    const v = row.getAttribute("data-index") ?? row.getAttribute("data-rs-index");
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function rowsContiguous(a, b) {
    const rowA = a.closest(ROW_SEL);
    const rowB = b.closest(ROW_SEL);
    if (!rowA || !rowB) return true;
    const from = rowIndex(rowA);
    const to = rowIndex(rowB);
    if (from === null || to === null || to <= from) return true;
    const present = /* @__PURE__ */ new Set();
    for (const row of Array.from(document.querySelectorAll(ROW_SEL))) {
      const i = rowIndex(row);
      if (i !== null) present.add(i);
    }
    for (let i = from + 1; i < to; i++) if (!present.has(i)) return false;
    return true;
  }
  class ClaudeCodeAdapter {
    constructor() {
      this.resumesAfterPause = true;
      this.cache = null;
      this.lastAnchor = null;
    }
    /** 会話の URL は /code/session_<英数字>。新規作成（/code）は会話未確定なので null */
    conversationKey(pathname) {
      const m = pathname.match(/^\/code\/(session_[^/]+)/);
      return m ? m[1] : null;
    }
    getObserverRoot() {
      const main2 = document.querySelector("main");
      return main2 ?? document.body;
    }
    /** 本文を持つ回答の行を出現順に全部返す（ツールだけの行には読むものが無い） */
    assistantTurns() {
      return Array.from(document.querySelectorAll(ASSISTANT_SEL$1)).filter(
        (turn) => turn.querySelector(ENGINE_ROOT_SEL$1) !== null
      );
    }
    /** 回答の行から本文の列を取り出す。列の中のツール表示などは sanitize 側で読み飛ばす */
    contentOfTurn(turn) {
      return this.columnOf(turn) ?? turn;
    }
    userTurns() {
      return Array.from(document.querySelectorAll(USER_SEL$1)).map(
        (body) => body.closest(USER_TURN_SEL$1) ?? body
      );
    }
    contentOfUserTurn(turn) {
      return turn.matches(USER_SEL$1) ? turn : turn.querySelector(USER_SEL$1) ?? turn;
    }
    /**
     * 最後の質問より後ろの回答の行すべてを、1 つの返答として返す。
     * content は各行の本文の列の写しを順につないだ、DOM に置かれていない要素。
     */
    getLatestAssistantMessage() {
      var _a;
      const reply = this.collectReply();
      if (!reply || reply.rows.length === 0) return null;
      if (((_a = this.cache) == null ? void 0 : _a.key) !== reply.key) this.cache = { key: reply.key, parts: /* @__PURE__ */ new Map() };
      const parts = this.cache.parts;
      reply.rows.forEach((row, i) => {
        const turn = row.querySelector(ASSISTANT_SEL$1);
        const column = turn ? this.columnOf(turn) : null;
        if (!column) return;
        parts.set(rowIndex(row) ?? i, column.cloneNode(true));
      });
      const content = document.createElement("div");
      for (const k of Array.from(parts.keys()).sort((a, b) => a - b)) {
        content.appendChild(parts.get(k).cloneNode(true));
      }
      const last = reply.rows[reply.rows.length - 1];
      return {
        id: reply.key,
        element: last.querySelector(ASSISTANT_SEL$1) ?? last,
        content
      };
    }
    /** 質問の同一性は本文で表す（claude.ts と同じ理由） */
    getLatestUserMessageId() {
      const users = document.querySelectorAll(USER_SEL$1);
      if (users.length === 0) return null;
      const text = (users[users.length - 1].textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      return text ? `user:${text}` : null;
    }
    /** ツールを動かしている間も「返答中」として扱われる */
    isGenerating() {
      return document.querySelector(WORKING_SEL) !== null || document.querySelector(STOP_BUTTON_SEL) !== null;
    }
    getComposer() {
      for (const sel of COMPOSER_SELECTORS$1) {
        const hit = document.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    }
    /**
     * Chrome の入力欄から送ったときの検出。
     * デスクトップアプリから送った質問は、ここではなく observer の
     * 「質問の行が増えた」「生成中になった」で拾う。
     */
    onSubmit(cb) {
      const inComposer = (t) => {
        if (!(t instanceof Element)) return false;
        const composer = this.getComposer();
        return composer !== null && (composer === t || composer.contains(t));
      };
      const hasText = () => {
        var _a;
        return (((_a = this.getComposer()) == null ? void 0 : _a.textContent) ?? "").trim().length > 0;
      };
      document.addEventListener(
        "keydown",
        (e) => {
          if (!isClaudeCodePath(location.pathname)) return;
          if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
          if (!inComposer(e.target) || !hasText()) return;
          cb();
        },
        true
      );
      document.addEventListener(
        "click",
        (e) => {
          if (!isClaudeCodePath(location.pathname)) return;
          const t = e.target;
          if (t instanceof Element && t.closest(SEND_BUTTON_SEL$1)) cb();
        },
        true
      );
    }
    isContiguous(a, b) {
      return rowsContiguous(a, b);
    }
    probe() {
      const rows = document.querySelectorAll(ROW_SEL).length;
      const composer = this.getComposer() !== null;
      const ok = composer || rows > 0;
      const detail = `rows=${rows} composer=${composer}`;
      if (ok) log("ClaudeCode", "probe ok", detail);
      else warn("ClaudeCode", "DOM を認識できません", detail);
      return { ok, detail };
    }
    columnOf(turn) {
      var _a;
      const column = (_a = turn.querySelector(ENGINE_ROOT_SEL$1)) == null ? void 0 : _a.parentElement;
      return column && column !== turn ? column : null;
    }
    /**
     * 最後の質問の行より後ろにある回答の行を集める。
     * key は「どの会話の、どの質問への返答か」。質問の行が見えなくなっても、
     * 直前に見えていた質問の番号を使い続ける。
     */
    collectReply() {
      var _a;
      const rows = Array.from(document.querySelectorAll(ROW_SEL));
      if (rows.length === 0) return null;
      const path = location.pathname;
      let lastHuman = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (isHumanRow(rows[i])) {
          lastHuman = i;
          break;
        }
      }
      let anchor;
      if (lastHuman >= 0) {
        const human = rows[lastHuman];
        const idx = rowIndex(human);
        anchor = idx !== null ? `row${idx}` : `q:${(human.textContent ?? "").trim().slice(0, 80)}`;
        this.lastAnchor = { path, anchor };
      } else {
        anchor = ((_a = this.lastAnchor) == null ? void 0 : _a.path) === path ? this.lastAnchor.anchor : "top";
      }
      const replyRows = rows.slice(lastHuman + 1).filter((r) => !isHumanRow(r) && r.querySelector(ASSISTANT_SEL$1));
      return { key: `code:${path}:${anchor}`, rows: replyRows };
    }
  }
  function isClaudeCodeChrome(el) {
    const cds = el.getAttribute("data-cds");
    if (cds === "TurnStatus" || cds === "MessageActions" || cds === "Banner" || cds === "DiffIndicator") return true;
    if (el.hasAttribute("data-tool-anchor")) return true;
    return el.tagName === "SPAN" && el.hasAttribute("data-not-prose");
  }
  class SwitchAdapter {
    constructor(normal, alt, useAlt) {
      this.normal = normal;
      this.alt = alt;
      this.useAlt = useAlt;
    }
    get current() {
      return this.useAlt(location.pathname) ? this.alt : this.normal;
    }
    get resumesAfterPause() {
      return this.current.resumesAfterPause === true;
    }
    getObserverRoot() {
      return this.current.getObserverRoot();
    }
    assistantTurns() {
      return this.current.assistantTurns();
    }
    contentOfTurn(turn) {
      return this.current.contentOfTurn(turn);
    }
    userTurns() {
      return this.current.userTurns();
    }
    contentOfUserTurn(turn) {
      return this.current.contentOfUserTurn(turn);
    }
    getLatestAssistantMessage() {
      return this.current.getLatestAssistantMessage();
    }
    getLatestUserMessageId() {
      return this.current.getLatestUserMessageId();
    }
    isGenerating() {
      return this.current.isGenerating();
    }
    getComposer() {
      return this.current.getComposer();
    }
    /** どちらの画面の送信も拾えるよう、両方に付けておく（各部品が自分の入力欄だけを見る） */
    onSubmit(cb) {
      this.normal.onSubmit(cb);
      this.alt.onSubmit(cb);
    }
    conversationKey(pathname) {
      return (this.useAlt(pathname) ? this.alt : this.normal).conversationKey(pathname);
    }
    probe() {
      return this.current.probe();
    }
    isContiguous(a, b) {
      var _a, _b;
      return ((_b = (_a = this.current).isContiguous) == null ? void 0 : _b.call(_a, a, b)) ?? true;
    }
  }
  const ASSISTANT_SEL = '[data-testid="assistant-message"]';
  const USER_SEL = '[data-testid="user-message"]';
  const USER_TURN_SEL = '[data-cds="UserMessage"]';
  const ENGINE_ROOT_SEL = "[data-transcript-engine-root]";
  const CONTENT_SELECTORS = ['[data-cds="Prose"]', "[data-perf-reply-text]", ".standard-markdown"];
  const COMPOSER_SELECTORS = [
    '[data-testid="chat-input"]',
    "[data-composer-editor]",
    '[contenteditable="true"][role="textbox"]'
  ];
  const SEND_BUTTON_SEL = '[data-testid="chat-input-send"], button[aria-label*="メッセージを送信"], button[aria-label*="Send message"]';
  class ClaudeAdapter {
    /** 会話の URL は /chat/<uuid>。新規チャット（/new）は会話未確定なので null */
    conversationKey(pathname) {
      const m = pathname.match(/\/chat\/([^/]+)/);
      return m ? m[1] : null;
    }
    getObserverRoot() {
      const main2 = document.querySelector("main");
      return main2 ?? document.body;
    }
    /** assistant の発言を出現順に全部返す（任意の回答を指定して読ませる用） */
    assistantTurns() {
      return Array.from(document.querySelectorAll(ASSISTANT_SEL));
    }
    /**
     * 本文の列を返す。検索や思考を挟んで本文が複数に分かれても続けて読めるよう、
     * 本文 1 つではなく、それらを束ねている列を優先する。
     * 列の中の検索・思考の表示（TurnStatus）は speech-sanitizer 側で読み飛ばす。
     */
    contentOfTurn(turn) {
      var _a;
      const column = (_a = turn.querySelector(ENGINE_ROOT_SEL)) == null ? void 0 : _a.parentElement;
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
    userTurns() {
      return Array.from(document.querySelectorAll(USER_SEL)).map(
        (body) => body.closest(USER_TURN_SEL) ?? body
      );
    }
    /** 質問の発言から本文要素を取り出す（添付やボタン列は含めない） */
    contentOfUserTurn(turn) {
      return turn.matches(USER_SEL) ? turn : turn.querySelector(USER_SEL) ?? turn;
    }
    getLatestAssistantMessage() {
      const turns = this.assistantTurns();
      if (turns.length === 0) return null;
      const turn = turns[turns.length - 1];
      const key = turn.getAttribute("data-turn-key");
      return {
        id: key ? `turn:${key}` : `${location.pathname}:assistant-${turns.length - 1}`,
        element: turn,
        content: this.contentOfTurn(turn)
      };
    }
    /**
     * 質問の同一性は本文で表す。ターンの鍵は送信直後に差し替わる可能性があり、
     * 差し替えを「新しい質問」と取り違えると読み上げを止めてしまうため。
     */
    getLatestUserMessageId() {
      const users = document.querySelectorAll(USER_SEL);
      if (users.length === 0) return null;
      const text = (users[users.length - 1].textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      return text ? `user:${text}` : null;
    }
    /**
     * 生成中かどうか。取れなくなっても、observer 側の
     * 「本文が増え続けているか」判定で読み上げは続く。
     */
    isGenerating() {
      if (document.querySelector('[data-testid="chat-input-stop"]')) return true;
      if (document.querySelector(`${ASSISTANT_SEL}[data-is-streaming="true"]`)) return true;
      if (document.querySelector('[data-testid="transcript-row"][data-perf-row-streaming="true"]')) return true;
      return false;
    }
    getComposer() {
      for (const sel of COMPOSER_SELECTORS) {
        const hit = document.querySelector(sel);
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
    onSubmit(cb) {
      const inComposer = (t) => {
        if (!(t instanceof Element)) return false;
        const composer = this.getComposer();
        return composer !== null && (composer === t || composer.contains(t));
      };
      const hasText = () => {
        var _a;
        return (((_a = this.getComposer()) == null ? void 0 : _a.textContent) ?? "").trim().length > 0;
      };
      document.addEventListener(
        "keydown",
        (e) => {
          if (isClaudeCodePath(location.pathname)) return;
          if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
          if (!inComposer(e.target) || !hasText()) return;
          cb();
        },
        true
      );
      document.addEventListener(
        "click",
        (e) => {
          if (isClaudeCodePath(location.pathname)) return;
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (t.closest(SEND_BUTTON_SEL)) cb();
        },
        true
      );
    }
    /** チャットの行も Claude Code と同じ仕組み（transcript-row と通し番号）で並んでいる */
    isContiguous(a, b) {
      return rowsContiguous(a, b);
    }
    probe() {
      const turns = document.querySelectorAll(`${ASSISTANT_SEL}, ${USER_SEL}`).length;
      const composer = this.getComposer() !== null;
      const ok = composer || turns > 0;
      const detail = `turns=${turns} composer=${composer}`;
      if (ok) log("Claude", "probe ok", detail);
      else warn("Claude", "DOM を認識できません", detail);
      return { ok, detail };
    }
  }
  function isClaudeChrome(el) {
    const cds = el.getAttribute("data-cds");
    if (cds === "TurnStatus" || cds === "MessageActions") return true;
    return el.tagName === "SPAN" && el.hasAttribute("data-not-prose");
  }
  const claudeSite = {
    id: "claude",
    label: "Claude",
    // チャットと Claude Code（/code）は同じ claude.ai の中で行き来できるので、URL を見て切り替える
    createAdapter: () => new SwitchAdapter(new ClaudeAdapter(), new ClaudeCodeAdapter(), isClaudeCodePath),
    sanitize: {
      skip: (el) => isClaudeCodePath(location.pathname) ? isClaudeCodeChrome(el) : isClaudeChrome(el),
      // Claude のコード枠。言語名のラベル（python など）を読まないよう、中の pre だけを扱う
      isCodeFrame: (el) => el.tagName !== "PRE" && el.getAttribute("role") === "group" && el.querySelector("pre") !== null
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
`
    }
  };
  function detectSite(hostname) {
    if (hostname === "claude.ai") return claudeSite;
    if (hostname === "chatgpt.com" || hostname === "chat.openai.com") return chatgptSite;
    return null;
  }
  function commonPrefixLength(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }
  class StreamTracker {
    constructor() {
      this.lastText = "";
      this.consumed = 0;
    }
    /** 現在の本文全体を渡すと、新しく増えた分だけを返す。 */
    push(fullText) {
      if (fullText === this.lastText) return "";
      if (fullText.startsWith(this.lastText)) {
        const delta = fullText.slice(this.consumed);
        this.lastText = fullText;
        this.consumed = fullText.length;
        return delta;
      }
      const common = commonPrefixLength(this.lastText, fullText);
      this.lastText = fullText;
      if (common >= this.consumed) {
        const delta = fullText.slice(this.consumed);
        this.consumed = fullText.length;
        return delta;
      }
      this.consumed = fullText.length;
      return "";
    }
    /** 直近に観測した本文全体 */
    get text() {
      return this.lastText;
    }
    get consumedLength() {
      return this.consumed;
    }
    reset() {
      this.lastText = "";
      this.consumed = 0;
    }
  }
  const HARD_BOUNDARY = /[。．.！!？?\n]/;
  const SOFT_BOUNDARY = /[、，,；;：:）)」』】　 ]/;
  const TRAILING = /[」』）)】"'…。！？!?]/;
  function hasSpeakableContent(text) {
    return /[\p{L}\p{N}]/u.test(text);
  }
  class SpeechChunker {
    constructor(opts) {
      this.opts = opts;
      this.buffer = "";
    }
    setOptions(opts) {
      this.opts = opts;
    }
    append(text) {
      this.buffer += text;
    }
    get pending() {
      return this.buffer;
    }
    clear() {
      this.buffer = "";
    }
    /**
     * 切り出せるチャンクを全て返す。
     * final=true なら残り全部を吐き出す（生成完了時）。
     */
    take(final) {
      const out = [];
      for (; ; ) {
        const cut = this.findCut(final);
        if (cut <= 0) break;
        const raw = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut);
        const cleaned = raw.trim();
        if (cleaned && hasSpeakableContent(cleaned)) out.push(cleaned);
      }
      if (final) {
        const rest = this.buffer.trim();
        this.buffer = "";
        if (rest && hasSpeakableContent(rest)) out.push(rest);
      }
      return out;
    }
    /** 切り出し位置（exclusive index）。0 ならまだ切れない。 */
    findCut(final) {
      const { minimumChunkLength, maximumChunkLength } = this.opts;
      const buf = this.buffer;
      if (buf.length === 0) return 0;
      if (!final && buf.length < minimumChunkLength) return 0;
      const limit = Math.min(buf.length, maximumChunkLength);
      for (let i = minimumChunkLength - 1; i < limit; i++) {
        if (HARD_BOUNDARY.test(buf[i])) {
          let end = i + 1;
          while (end < buf.length && TRAILING.test(buf[end])) end++;
          if (!final && end >= buf.length && /[！？!?]$/.test(buf)) return 0;
          return end;
        }
      }
      if (buf.length < maximumChunkLength) return 0;
      for (let i = limit - 1; i >= minimumChunkLength; i--) {
        if (SOFT_BOUNDARY.test(buf[i])) return i + 1;
      }
      return maximumChunkLength;
    }
  }
  const DEFAULT_SANITIZE_OPTIONS = {
    urlMode: "announce",
    codeMode: "announce-once",
    tableMode: "announce",
    inlineCodeMaxLength: 24,
    readSymbols: false
  };
  const SYMBOL_WORDS = {
    _: " アンダーバー ",
    "-": " ハイフン ",
    ".": " ドット ",
    "/": " スラッシュ ",
    ":": " コロン ",
    "+": " プラス ",
    "#": " シャープ ",
    "@": " アット ",
    "~": " チルダ ",
    "*": " アスタリスク "
  };
  function expandSymbols(text) {
    const TOKEN = /[A-Za-z0-9]+(?:[_\-./:+#@~*][A-Za-z0-9]+)+/g;
    return text.replace(TOKEN, (token) => {
      if (!/[A-Za-z]/.test(token)) return token;
      return token.replace(/[_\-./:+#@~*]/g, (sym) => SYMBOL_WORDS[sym] ?? sym);
    });
  }
  const URL_RE = /https?:\/\/[^\s<>"'）)」』】]+/g;
  const BLOCK_TAGS = /* @__PURE__ */ new Set([
    "P",
    "DIV",
    "LI",
    "BR",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "UL",
    "OL",
    "TR",
    "HR",
    "SECTION",
    "ARTICLE"
  ]);
  function extractSpeechText(root, opts) {
    const parts = [];
    walk(root, opts, parts, { blocks: 0 });
    return normalizeWhitespace(parts.join(""));
  }
  function walk(node, opts, out, state) {
    var _a, _b;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = replaceUrls(node.nodeValue ?? "", opts.urlMode);
      out.push(opts.readSymbols ? expandSymbols(t) : t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (isHidden(el) || isCitation(el) || ((_a = opts.site) == null ? void 0 : _a.skip(el))) return;
    if ((_b = opts.site) == null ? void 0 : _b.isCodeFrame(el)) {
      for (const pre of Array.from(el.querySelectorAll("pre"))) walk(pre, opts, out, state);
      return;
    }
    if (tag === "PRE") {
      if (opts.codeMode === "read") {
        out.push(`
${el.textContent ?? ""}
`);
        return;
      }
      state.blocks++;
      if (opts.codeMode === "skip") return;
      if (opts.codeMode === "announce-once" && state.blocks > 1) return;
      out.push(isDiagram(el.textContent ?? "") ? "\nここに図があります。\n" : "\nここにコードがあります。\n");
      return;
    }
    if (tag === "TABLE") {
      if (opts.tableMode === "skip") return;
      if (opts.tableMode === "announce") {
        out.push("\n表があります。\n");
        return;
      }
    }
    if (tag === "CODE" && el.closest("pre") === null) {
      const t = (el.textContent ?? "").trim();
      if (t.length > opts.inlineCodeMaxLength) {
        out.push("コード");
        return;
      }
      out.push(opts.readSymbols ? expandSymbols(t) : t);
      return;
    }
    if (tag === "A") {
      const text = (el.textContent ?? "").trim();
      const href = el.getAttribute("href") ?? "";
      const textIsUrl = /^https?:\/\//.test(text);
      if (textIsUrl || text.length === 0) {
        out.push(linkPlaceholder(opts.urlMode, href));
      } else {
        const t = replaceUrls(text, opts.urlMode);
        out.push(opts.readSymbols ? expandSymbols(t) : t);
      }
      return;
    }
    if (tag === "IMG" || tag === "SVG" || tag === "BUTTON" || tag === "SCRIPT" || tag === "STYLE") return;
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push("\n");
    for (const child of Array.from(el.childNodes)) walk(child, opts, out, state);
    if (isBlock) out.push("\n");
  }
  function isDiagram(text) {
    const body = text.replace(/\s/g, "");
    if (body.length === 0) return false;
    const boxChars = (body.match(/[|｜│─━┃┌┐└┘├┤┬┴┼＋+\-=_*▲▼◀▶←→↑↓]/g) ?? []).length;
    return boxChars / body.length >= 0.3;
  }
  function isHidden(el) {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    const cls = el.getAttribute("class") ?? "";
    return /\bsr-only\b|\bvisually-hidden\b/.test(cls);
  }
  function isCitation(el) {
    const tag = el.tagName;
    if (tag === "SUP") return true;
    const testid = el.getAttribute("data-testid") ?? "";
    if (/citation|sources|search-result|turn-source/i.test(testid)) return true;
    if (el.hasAttribute("data-citation")) return true;
    return false;
  }
  function linkPlaceholder(mode, href) {
    if (mode === "skip") return "";
    if (mode === "read") return href;
    return "リンクがあります。";
  }
  function replaceUrls(text, mode) {
    if (mode === "read") return text;
    return text.replace(URL_RE, mode === "skip" ? "" : "リンクがあります。");
  }
  const DECORATION_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;
  function stripDecorations(text) {
    return text.replace(DECORATION_RE, "");
  }
  function normalizeWhitespace(text) {
    return stripDecorations(text).replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").replace(/^\s+|\s+$/g, "");
  }
  const TICK_MS = 200;
  const SETTLE_MS = 1200;
  const OPEN_STABLE_MS = 1e3;
  const OPEN_GIVE_UP_MS = 15e3;
  const OPEN_RENDER_GUARD_MS = 3e3;
  const THINKING_REPEAT_FACTORS = [3, 6, 12];
  class ChatObserver {
    constructor(deps) {
      this.deps = deps;
      this.mo = null;
      this.timer = null;
      this.scheduled = false;
      this.currentMessageId = null;
      this.tracker = new StreamTracker();
      this.lastUserMessageId = null;
      this.lastDeltaAt = 0;
      this.armed = false;
      this.live = false;
      this.finished = false;
      this.spokeThisMessage = false;
      this.conversationPath = location.pathname;
      this.openPending = null;
      this.openedAt = 0;
      this.quietSince = null;
      this.thinkingNotices = 0;
      this.chunker = new SpeechChunker(deps.getChunkerOptions());
    }
    /** 入力欄での送信操作を検出したときに呼ぶ */
    notifySubmitted() {
      this.openPending = null;
      this.armed = true;
      this.live = false;
      log("Observer", "送信を検出");
      this.deps.onNewUserMessage();
    }
    start() {
      const root = this.deps.adapter.getObserverRoot();
      this.lastUserMessageId = this.deps.adapter.getLatestUserMessageId();
      if (this.deps.adapter.conversationKey(location.pathname) !== null) this.beginOpen();
      this.mo = new MutationObserver(() => this.schedule());
      this.mo.observe(root, { childList: true, subtree: true, characterData: true });
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
      log("Observer", "started");
    }
    stop() {
      var _a;
      (_a = this.mo) == null ? void 0 : _a.disconnect();
      this.mo = null;
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
    }
    /** 読み上げ中断時に、未確定バッファも破棄する */
    resetBuffers() {
      this.chunker.clear();
    }
    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        this.tick();
      });
    }
    extract(content) {
      return extractSpeechText(content, this.deps.getSanitizeOptions());
    }
    tick() {
      const adapter = this.deps.adapter;
      if (location.pathname !== this.conversationPath) {
        const prevKey = this.deps.adapter.conversationKey(this.conversationPath);
        this.conversationPath = location.pathname;
        this.lastUserMessageId = null;
        if (prevKey !== null && prevKey !== this.deps.adapter.conversationKey(location.pathname)) {
          this.armed = false;
          this.live = false;
          this.beginOpen();
          log("Observer", "会話が切り替わった", location.pathname);
        } else if (prevKey === null && !this.armed) {
          this.beginOpen();
          log("Observer", "会話を開いた", location.pathname);
        } else {
          log("Observer", "新規チャットの URL が確定", location.pathname);
        }
      }
      const userId = adapter.getLatestUserMessageId();
      if (userId !== null && userId !== this.lastUserMessageId) {
        const known = this.lastUserMessageId !== null;
        const rendering = Date.now() - this.openedAt < OPEN_RENDER_GUARD_MS;
        this.lastUserMessageId = userId;
        if (known && !rendering) {
          this.armed = true;
          this.live = false;
          this.openPending = null;
          log("Observer", "new user message", userId);
          this.deps.onNewUserMessage();
        } else {
          log("Observer", "既存の質問を基準として記録", userId);
        }
      }
      const generating = adapter.isGenerating();
      if (generating) this.armed = true;
      this.checkThinking(generating);
      const latest = adapter.getLatestAssistantMessage();
      this.checkOpenRead(latest, generating);
      if (!latest) return;
      if (latest.id !== this.currentMessageId) {
        const prevId = this.currentMessageId;
        this.currentMessageId = latest.id;
        if (this.live && this.isContinuation(this.extract(latest.content))) {
          log("Observer", "回答の ID が差し替わった（続きから読む）", prevId, "→", latest.id);
        } else {
          this.beginMessage(latest);
          if (!this.live) return;
        }
      }
      if (!this.deps.getEnabled()) {
        this.tracker.push(this.extract(latest.content));
        this.chunker.clear();
        return;
      }
      const text = this.extract(latest.content);
      if (text === "" && this.tracker.consumedLength > 0) return;
      const delta = this.tracker.push(text);
      const resumable = adapter.resumesAfterPause === true;
      if (!this.live) {
        if (!delta) return;
        if (resumable) {
          if (!this.spokeThisMessage && !generating) return;
          this.finished = false;
          log("Observer", this.spokeThisMessage ? "休みのあと返答の続きが出たので読む" : "生成中の返答が伸びたので読み始める", latest.id);
        } else {
          if (this.finished) return;
          log("Observer", "取り込み済みの回答が伸びたので読み始める", latest.id);
        }
        this.live = true;
      }
      this.spokeThisMessage = true;
      this.chunker.setOptions(this.deps.getChunkerOptions());
      if (delta) {
        this.chunker.append(delta);
        this.lastDeltaAt = Date.now();
        this.resetThinking();
      }
      const settled = Date.now() - this.lastDeltaAt >= SETTLE_MS;
      const done = !generating && settled;
      const chunks = this.chunker.take(done || resumable && settled);
      for (const c of chunks) {
        log("Chunker", "chunk", c);
        this.deps.onChunk(c);
      }
      if (done && this.tracker.consumedLength > 0) {
        this.live = false;
        this.finished = true;
        log("Observer", "回答を読み切った", latest.id);
      }
    }
    resetThinking() {
      this.quietSince = null;
      this.thinkingNotices = 0;
    }
    /**
     * 返答中なのに、文章も読み上げも無い時間が続いたら知らせる。
     * 1 回目は設定の秒数で、そのあとは間を空けながら繰り返す。
     */
    checkThinking(generating) {
      const t = this.deps.thinking;
      if (!t) return;
      const wait = t.getWaitSeconds();
      if (wait === null || !generating || !this.deps.getEnabled()) return this.resetThinking();
      const now = Date.now();
      if (!t.isSpeechIdle()) {
        this.quietSince = null;
        return;
      }
      if (this.quietSince === null) {
        this.quietSince = now;
        return;
      }
      const n = this.thinkingNotices;
      const factor = n === 0 ? 1 : THINKING_REPEAT_FACTORS[Math.min(n - 1, THINKING_REPEAT_FACTORS.length - 1)];
      if (now - this.quietSince < wait * factor * 1e3) return;
      this.thinkingNotices = n + 1;
      this.quietSince = null;
      log("Observer", "長考の知らせ", this.thinkingNotices);
      t.onNotice(this.thinkingNotices);
    }
    beginOpen() {
      const now = Date.now();
      this.openedAt = now;
      this.openPending = { since: now, candidateId: null, candidateSince: now };
    }
    /**
     * チャットを開いた直後なら、表示が落ち着くのを待って最新の回答を頭から読む。
     * 生成中の回答は通常の逐次読み上げに任せるので、ここでは扱わない。
     */
    checkOpenRead(latest, generating) {
      const p = this.openPending;
      if (!p) return;
      const now = Date.now();
      if (!this.deps.getReadOnOpen() || !this.deps.getEnabled() || generating || this.armed) {
        this.openPending = null;
        return;
      }
      if (now - p.since > OPEN_GIVE_UP_MS) {
        this.openPending = null;
        return;
      }
      if (!latest) return;
      if (latest.id !== p.candidateId) {
        p.candidateId = latest.id;
        p.candidateSince = now;
        return;
      }
      if (now - p.candidateSince < OPEN_STABLE_MS) return;
      if (!this.extract(latest.content)) return;
      this.openPending = null;
      log("Observer", "チャットを開いたので最新の回答を読む", latest.id);
      this.deps.onOpenChat(latest.content);
    }
    /** 差し替え後の本文が、今読んでいる本文の続きとみなせるか */
    isContinuation(text) {
      const tracked = this.tracker.text;
      return text === "" || text.startsWith(tracked) || tracked.startsWith(text);
    }
    /** 別の回答に切り替わった。解禁されていれば読み始め、そうでなければ黙って取り込む。 */
    beginMessage(latest) {
      this.finished = false;
      this.spokeThisMessage = false;
      this.tracker.reset();
      this.chunker.clear();
      this.lastDeltaAt = Date.now();
      if (!this.armed) {
        this.live = false;
        this.tracker.push(this.extract(latest.content));
        log("Observer", "既存の回答として無言で取り込み", latest.id);
        return;
      }
      log("Observer", "new assistant message", latest.id);
      this.armed = false;
      this.live = true;
    }
  }
  const RECENT_LIMIT = 5;
  function pushRecent(list, styleId, limit = RECENT_LIMIT) {
    return [styleId, ...list.filter((id) => id !== styleId)].slice(0, limit);
  }
  const PICKER_CSS = `
.voice { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border: 1px solid #ccc; border-radius: 10px; background: transparent; }
.voice:hover { background: rgba(127,127,127,.08); }
.voice .face { width: 40px; height: 40px; }
.voice .who { flex: 1; min-width: 0; line-height: 1.25; }
.voice .who b { display: block; font-size: 13px; }
.voice .who span { font-size: 11px; opacity: .75; }
.voice .caret { opacity: .6; }
.voice.compact { gap: 6px; padding: 3px 6px; border-radius: 8px; }
.voice.compact .face { width: 24px; height: 24px; border-radius: 6px; }
.voice.compact .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice.compact .who b { display: inline; font-size: 12px; margin-right: 4px; }
.voice.compact .face:not([src]) { display: none; }
.face { flex: none; width: 28px; height: 28px; border-radius: 8px; object-fit: cover;
  background: rgba(127,127,127,.15); }

.picker { position: fixed; right: 284px; bottom: 16px; z-index: 2147483001;
  width: min(460px, calc(100vw - 300px));
  /* 区分を畳んだときは中身に合わせて縮む。広がるのは最大 480px まで */
  max-height: min(480px, calc(100vh - 32px));
  display: flex; flex-direction: column; overflow: hidden;
  background: #fff; color: #1b1b1b; border: 1px solid #d5d5d5; border-radius: 12px;
  box-shadow: 0 10px 32px rgba(0,0,0,.22); }
.picker[hidden] { display: none; }
@media (max-width: 760px) {
  .picker { right: 16px; width: calc(100vw - 32px); }
}
.picker-head { padding: 8px; border-bottom: 1px solid rgba(128,128,128,.25); }
.search { width: 100%; box-sizing: border-box; font: inherit; padding: 5px 8px;
  border: 1px solid #ccc; border-radius: 8px; }
.cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
.col { overflow-y: auto; padding: 4px; }
.col + .col { border-left: 1px solid rgba(128,128,128,.25); }
.item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 6px;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border: 0; border-radius: 8px; background: transparent; }
.item:hover, .item.active { background: rgba(127,127,127,.14); }
.item.current { font-weight: 600; }
.item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .count, .item .check { flex: none; font-size: 11px; opacity: .6; }
.empty { padding: 12px; font-size: 12px; opacity: .6; }
.group { display: flex; align-items: center; gap: 4px; width: 100%; padding: 8px 6px 3px;
  font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-align: left;
  color: inherit; opacity: .55; border: 0; background: transparent; cursor: pointer; }
.group:hover { opacity: .9; }
.group:first-child { padding-top: 2px; }
.group .arrow { display: inline-block; width: 10px; transition: transform .12s ease; }
.group.collapsed .arrow { transform: rotate(-90deg); }
.group .n { font-weight: 400; opacity: .8; }
.item .sub { flex: none; max-width: 45%; font-size: 11px; opacity: .6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.star { flex: none; width: 18px; text-align: center; font-size: 13px; line-height: 1;
  opacity: 0; color: #d4a017; cursor: pointer; }
.item:hover .star, .star.on { opacity: 1; }
.star:not(.on) { color: inherit; }
.item:hover .star:not(.on) { opacity: .45; }
.star:hover { opacity: 1 !important; transform: scale(1.15); }

@media (prefers-color-scheme: dark) {
  .picker { background: #202123; color: #ececec; border-color: #3a3a3a; }
  .voice { border-color: #4a4a4a; }
  .search { background: #2b2c2f; color: #ececec; border-color: #4a4a4a; }
}
`;
  class VoicePicker {
    constructor(deps) {
      this.deps = deps;
      this.characters = [];
      this.selectedId = null;
      this.activeChar = null;
      this.recent = [];
      this.favorites = [];
      this.collapsed = [];
      this.trigger = document.createElement("button");
      this.trigger.className = deps.compact ? "voice compact" : "voice";
      this.trigger.type = "button";
      this.trigger.innerHTML = `
      <img class="face" alt="">
      <span class="who"><b>話者を取得中…</b><span></span></span>
      <span class="caret">▾</span>`;
      this.trigger.addEventListener("click", () => this.toggle());
      this.panel = document.createElement("div");
      this.panel.className = "picker";
      this.panel.hidden = true;
      this.panel.innerHTML = `
      <div class="picker-head">
        <input class="search" type="search" placeholder="キャラ名・スタイルで絞り込み（例: ささやき）">
      </div>
      <div class="cols"><div class="col chars"></div><div class="col styles"></div></div>`;
      this.search = this.panel.querySelector(".search");
      this.charCol = this.panel.querySelector(".chars");
      this.styleCol = this.panel.querySelector(".styles");
      this.search.addEventListener("input", () => this.renderCharacters());
      this.search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
      document.addEventListener(
        "mousedown",
        (e) => {
          if (this.panel.hidden) return;
          if (!e.composedPath().includes(this.deps.host)) this.close();
        },
        true
      );
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !this.panel.hidden) this.close();
      });
      this.deps.root.appendChild(this.panel);
    }
    /** パネル内に置くボタン */
    get element() {
      return this.trigger;
    }
    setOptions(options, selectedId) {
      const byUuid = /* @__PURE__ */ new Map();
      for (const o of options) {
        let c = byUuid.get(o.speakerUuid);
        if (!c) {
          c = { name: o.speakerName, uuid: o.speakerUuid, styles: [] };
          byUuid.set(o.speakerUuid, c);
        }
        c.styles.push(o);
      }
      this.characters = Array.from(byUuid.values());
      this.setSelected(selectedId);
    }
    /** 「最近使った」（スタイル ID）・「お気に入り」（キャラの UUID）・畳んでいる区分を渡す */
    setPrefs(recent, favorites, collapsed = []) {
      this.recent = recent;
      this.favorites = favorites;
      this.collapsed = collapsed;
      if (!this.panel.hidden) this.renderCharacters();
    }
    setSelected(styleId) {
      this.selectedId = styleId;
      const opt = this.find(styleId);
      const face = this.trigger.querySelector(".face");
      const name = this.trigger.querySelector(".who b");
      const style = this.trigger.querySelector(".who span");
      if (!opt) {
        name.textContent = this.characters.length ? this.deps.emptyLabel ?? "話者を選んでください" : "話者なし";
        style.textContent = "";
        face.removeAttribute("src");
        return;
      }
      name.textContent = opt.speakerName;
      style.textContent = opt.styleName;
      this.setIcon(face, opt.styleId);
    }
    find(styleId) {
      if (styleId === null) return void 0;
      for (const c of this.characters) {
        const hit = c.styles.find((s) => s.styleId === styleId);
        if (hit) return hit;
      }
      return void 0;
    }
    toggle() {
      if (this.panel.hidden) this.open();
      else this.close();
    }
    open() {
      var _a, _b, _c;
      if (this.characters.length === 0) return;
      (_b = (_a = this.deps).onOpen) == null ? void 0 : _b.call(_a);
      this.panel.hidden = false;
      this.search.value = "";
      this.activeChar = ((_c = this.find(this.selectedId)) == null ? void 0 : _c.speakerUuid) ?? this.characters[0].uuid;
      this.renderCharacters();
      this.charCol.scrollTop = 0;
      this.search.focus();
    }
    close() {
      this.panel.hidden = true;
    }
    matches(c, q) {
      if (!q) return c.styles;
      if (c.name.includes(q)) return c.styles;
      const styles = c.styles.filter((s) => s.styleName.includes(q));
      return styles.length ? styles : null;
    }
    /** 今使っているスタイルを先頭にした「最近使った」の中身 */
    recentOptions() {
      const ids = this.selectedId === null ? this.recent : pushRecent(this.recent, this.selectedId);
      return ids.map((id) => this.find(id)).filter((o) => o !== void 0);
    }
    renderCharacters() {
      const q = this.search.value.trim();
      this.charCol.textContent = "";
      const visible = this.characters.filter((c) => this.matches(c, q) !== null);
      if (visible.length === 0) {
        this.charCol.innerHTML = '<div class="empty">見つかりません</div>';
        this.styleCol.textContent = "";
        return;
      }
      if (!visible.some((c) => c.uuid === this.activeChar)) this.activeChar = visible[0].uuid;
      if (q) {
        for (const c of visible) this.charCol.appendChild(this.characterRow(c, q));
      } else {
        const recent = this.recentOptions();
        if (recent.length > 0) {
          this.charCol.appendChild(this.groupTitle("recent", "最近使った", recent.length));
          if (!this.isCollapsed("recent")) {
            for (const o of recent) this.charCol.appendChild(this.recentRow(o));
          }
        }
        const favs = this.favorites.map((uuid) => this.characters.find((c) => c.uuid === uuid)).filter((c) => c !== void 0);
        if (favs.length > 0) {
          this.charCol.appendChild(this.groupTitle("favorites", "★ お気に入り", favs.length));
          if (!this.isCollapsed("favorites")) {
            for (const c of favs) this.charCol.appendChild(this.characterRow(c, q));
          }
        }
        const rest = this.characters.filter((c) => !this.favorites.includes(c.uuid));
        this.charCol.appendChild(this.groupTitle("all", "すべてのキャラ", rest.length));
        if (!this.isCollapsed("all")) {
          for (const c of rest) this.charCol.appendChild(this.characterRow(c, q));
        }
      }
      const active = visible.find((c) => c.uuid === this.activeChar);
      this.renderStyles(active, q);
    }
    isCollapsed(group) {
      return this.collapsed.includes(group);
    }
    /** 区分の見出し。押すとその区分を畳む／開く */
    groupTitle(group, text, count) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "group";
      el.dataset.group = group;
      const collapsed = this.isCollapsed(group);
      el.classList.toggle("collapsed", collapsed);
      el.setAttribute("aria-expanded", String(!collapsed));
      el.innerHTML = `<span class="arrow">▾</span><span class="t"></span><span class="n"></span>`;
      el.querySelector(".t").textContent = text;
      el.querySelector(".n").textContent = collapsed ? `（${count}）` : "";
      el.addEventListener("click", () => this.toggleGroup(group));
      return el;
    }
    toggleGroup(group) {
      this.collapsed = this.isCollapsed(group) ? this.collapsed.filter((g) => g !== group) : [...this.collapsed, group];
      const scroll = this.charCol.scrollTop;
      this.renderCharacters();
      this.charCol.scrollTop = scroll;
      this.deps.onCollapsedChange(this.collapsed);
    }
    /** 左の列を「このキャラが選ばれている」表示にし、右にスタイルを出す */
    activate(c, row, q) {
      this.charCol.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
      row.classList.add("active");
      if (this.activeChar === c.uuid) return;
      this.activeChar = c.uuid;
      this.renderStyles(c, q);
    }
    /** 「最近使った」の行。スタイル単位で、押せばその場で決定 */
    recentRow(o) {
      const c = this.characters.find((ch) => ch.uuid === o.speakerUuid);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "item";
      btn.dataset.kind = "recent";
      btn.dataset.styleId = String(o.styleId);
      if (o.styleId === this.selectedId) btn.classList.add("current");
      btn.innerHTML = `<img class="face" alt=""><span class="label"></span><span class="sub"></span>`;
      btn.querySelector(".label").textContent = o.speakerName;
      btn.querySelector(".sub").textContent = o.styleName;
      this.setIcon(btn.querySelector(".face"), o.styleId);
      btn.addEventListener("mouseenter", () => this.activate(c, btn, ""));
      btn.addEventListener("focus", () => this.activate(c, btn, ""));
      btn.addEventListener("click", () => this.choose(o));
      return btn;
    }
    /** キャラの行。乗せると右にスタイル、☆ でお気に入りの付け外し */
    characterRow(c, q) {
      const current = this.find(this.selectedId);
      const fav = this.favorites.includes(c.uuid);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "item";
      btn.dataset.kind = "char";
      btn.dataset.uuid = c.uuid;
      if (c.uuid === this.activeChar) btn.classList.add("active");
      if ((current == null ? void 0 : current.speakerUuid) === c.uuid) btn.classList.add("current");
      btn.innerHTML = `<img class="face" alt=""><span class="label"></span><span class="count"></span><span class="star" data-star role="button"></span>`;
      btn.querySelector(".label").textContent = c.name;
      btn.querySelector(".count").textContent = c.styles.length > 1 ? `${c.styles.length} ›` : "";
      const star = btn.querySelector(".star");
      star.textContent = fav ? "★" : "☆";
      star.classList.toggle("on", fav);
      star.title = fav ? "お気に入りから外す" : "お気に入りに追加";
      this.setIcon(btn.querySelector(".face"), c.styles[0].styleId);
      btn.addEventListener("mouseenter", () => this.activate(c, btn, q));
      btn.addEventListener("focus", () => this.activate(c, btn, q));
      btn.addEventListener("click", (e) => {
        if (e.target.closest("[data-star]")) {
          e.preventDefault();
          this.toggleFavorite(c.uuid);
          return;
        }
        this.activate(c, btn, q);
        if (c.styles.length === 1) this.choose(c.styles[0]);
      });
      return btn;
    }
    toggleFavorite(uuid) {
      const next = this.favorites.includes(uuid) ? this.favorites.filter((u) => u !== uuid) : [...this.favorites, uuid];
      this.favorites = next;
      const scroll = this.charCol.scrollTop;
      this.renderCharacters();
      this.charCol.scrollTop = scroll;
      this.deps.onFavoritesChange(next);
    }
    renderStyles(c, q) {
      this.styleCol.textContent = "";
      const styles = this.matches(c, q) ?? c.styles;
      for (const s of styles) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "item";
        if (s.styleId === this.selectedId) btn.classList.add("current");
        btn.innerHTML = `<img class="face" alt=""><span class="label"></span><span class="check"></span>`;
        btn.querySelector(".label").textContent = s.styleName;
        btn.querySelector(".check").textContent = s.styleId === this.selectedId ? "✓" : "";
        this.setIcon(btn.querySelector(".face"), s.styleId);
        btn.addEventListener("click", () => this.choose(s));
        this.styleCol.appendChild(btn);
      }
    }
    choose(opt) {
      this.close();
      this.setSelected(opt.styleId);
      this.deps.onSelect(opt);
    }
    setIcon(img, styleId) {
      img.dataset.styleId = String(styleId);
      void this.deps.loadIcon(styleId).then((url) => {
        if (url && img.dataset.styleId === String(styleId)) img.src = url;
      });
    }
  }
  const CSS = `
:host { all: initial; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 260px; font: 12px/1.5 -apple-system, "Hiragino Sans", sans-serif;
  color: #1b1b1b; background: #fff; border: 1px solid #d5d5d5;
  border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden;
}
.head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
  border-bottom: 1px solid rgba(128,128,128,.25); cursor: pointer; }
.title { font-weight: 600; flex: 1; }
.panel.mini { width: auto; }
.panel.mini .head { border-bottom: none; padding: 6px 12px; }
.panel.mini .title { flex: none; }
.panel.mini #conn { display: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #999; flex: none; }
.dot.connected { background: #22c55e; }
.dot.connecting { background: #eab308; }
.dot.disconnected { background: #9ca3af; }
.body { padding: 8px 10px; display: grid; gap: 7px; }
.body.hidden { display: none; }
.row { display: flex; align-items: center; gap: 6px; }
.row > label { flex: none; opacity: .8; }
.slot { flex: 1; min-width: 0; }
select, input[type=number] { flex: 1; min-width: 0; font: inherit; padding: 2px 4px;
  border: 1px solid #ccc; border-radius: 6px; background: #fff; color: inherit; }
input[type=range] { flex: 1; min-width: 0; }
.btn { flex: 1; font: inherit; padding: 4px 6px; border: 1px solid #ccc;
  border-radius: 7px; background: #f6f6f6; cursor: pointer; color: inherit; }
.btn:hover { filter: brightness(.96); }
.btn.on { background: #22c55e; border-color: #22c55e; color: #fff; }
.btn.stop { background: #ef4444; border-color: #ef4444; color: #fff; }
.btn.paused { background: #f59e0b; border-color: #f59e0b; color: #fff; }
.btn.fit { flex: none; }
.btn:disabled { opacity: .45; cursor: default; filter: none; }
.status { font-size: 11px; opacity: .8; min-height: 15px; }
.status.err { color: #ef4444; opacity: 1; }
.val { flex: none; width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
details summary { cursor: pointer; opacity: .8; font-size: 11px; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 11px; }

/* ダーク配色は必ず最後に置く。前に置くと通常の指定に上書きされ、白地に白文字になる */
@media (prefers-color-scheme: dark) {
  .panel { color: #ececec; background: #202123; border-color: #3a3a3a; }
  select, input[type=number] { color: #ececec; background: #2b2c2f; border-color: #4a4a4a; }
  .btn { background: #2b2c2f; border-color: #4a4a4a; color: #ececec; }
  .btn.on { background: #22c55e; border-color: #22c55e; color: #fff; }
  .btn.stop { background: #ef4444; border-color: #ef4444; color: #fff; }
  .btn.paused { background: #f59e0b; border-color: #f59e0b; color: #fff; }
}
`;
  class UiPanel {
    constructor(settings, cb) {
      this.settings = settings;
      this.cb = cb;
      this.collapsed = false;
      this.host = document.createElement("div");
      this.host.id = "voicevox-bridge-root";
      this.root = this.host.attachShadow({ mode: "open" });
      this.render();
      document.body.appendChild(this.host);
    }
    render() {
      const style = document.createElement("style");
      style.textContent = CSS + PICKER_CSS;
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `
      <div class="head" part="head">
        <span class="dot disconnected" id="dot"></span>
        <span class="title">VOICEVOX</span>
        <span id="conn" style="font-size:11px;opacity:.75">未接続</span>
      </div>
      <div class="body" id="body">
        <div class="row" id="voiceSlot"></div>
        <div class="row" title="自分の質問を「🔊 この質問を読む」で読むときの声">
          <label>質問</label>
          <div class="slot" id="questionVoiceSlot"></div>
        </div>
        <div class="row">
          <label>話速</label>
          <input type="range" id="speed" min="0.5" max="2" step="0.05">
          <span class="val" id="speedVal"></span>
        </div>
        <div class="row">
          <label>音量</label>
          <input type="range" id="volume" min="0" max="2" step="0.05">
          <span class="val" id="volumeVal"></span>
        </div>
        <div class="row" title="文と文の間の無音。小さいほど箇条書きの移りが速くなります">
          <label>文間</label>
          <input type="range" id="gap" min="0" max="0.3" step="0.01">
          <span class="val" id="gapVal"></span>
        </div>
        <div class="row">
          <button class="btn fit" id="toggle">🔊 ON</button>
          <button class="btn" id="pause" disabled title="今の文で止め、続きは「再開」で読みます">⏸ 一時停止</button>
          <button class="btn stop" id="stop">■ STOP</button>
        </div>
        <div class="row">
          <button class="btn" id="speakSel" title="ページ上で選択した部分だけを読み上げます">
            🔈 選択した部分を読む
          </button>
        </div>
        <div class="status" id="status"></div>
        <details>
          <summary>詳細設定</summary>
          <div class="body" style="padding:6px 0 0">
            <div class="row"><label>コード</label>
              <select id="codeMode">
                <option value="skip">読まない</option>
                <option value="announce-once">最初の1回だけ伝える</option>
                <option value="announce">毎回あることを伝える</option>
                <option value="read">読む</option>
              </select></div>
            <div class="row"><label>URL</label>
              <select id="urlMode">
                <option value="skip">読まない</option>
                <option value="announce">あることだけ伝える</option>
                <option value="read">読む</option>
              </select></div>
            <div class="row"><label>表</label>
              <select id="tableMode">
                <option value="skip">読まない</option>
                <option value="announce">あることだけ伝える</option>
                <option value="read">読む</option>
              </select></div>
            <label class="chk" title="ファイル名やパスの中の _ - . / を読み上げます">
              <input type="checkbox" id="readSymbols">記号を読む（_ - . /）</label>
            <label class="chk"><input type="checkbox" id="readOnOpen">チャットを開いたら最新の回答を読む</label>
            <label class="chk"><input type="checkbox" id="stopOnNew">新しい質問で読み上げ停止</label>
            <label class="chk" title="「▶ ここから続けて読む」のとき、間の質問も質問用の声で読みます">
              <input type="checkbox" id="contQuestions">続けて読むとき、質問も読む</label>
            <label class="chk" title="返答中に文章がしばらく出てこないとき、声で知らせます">
              <input type="checkbox" id="thinking">長考中は「考え中です」と知らせる</label>
            <div class="row"><label title="文章が止まってから「考え中です」と言うまでの秒数">考え中</label>
              <input type="number" id="thinkingSec" min="3" max="120" step="1" style="flex:none;width:52px">
              <span style="font-size:11px">秒たったら知らせる</span></div>
            <label class="chk"><input type="checkbox" id="debug">デバッグログ</label>
            <div class="row">
              <button class="btn" id="test">テスト発声</button>
              <button class="btn" id="reconnect">再接続</button>
            </div>
          </div>
        </details>
      </div>`;
      this.root.append(style, panel);
      const q = (id) => this.root.getElementById(id);
      this.el = {
        dot: q("dot"),
        conn: q("conn"),
        body: q("body"),
        voiceSlot: q("voiceSlot"),
        questionVoiceSlot: q("questionVoiceSlot"),
        speed: q("speed"),
        speedVal: q("speedVal"),
        volume: q("volume"),
        volumeVal: q("volumeVal"),
        gap: q("gap"),
        gapVal: q("gapVal"),
        toggle: q("toggle"),
        pause: q("pause"),
        stop: q("stop"),
        status: q("status"),
        codeMode: q("codeMode"),
        urlMode: q("urlMode"),
        tableMode: q("tableMode"),
        stopOnNew: q("stopOnNew"),
        debug: q("debug"),
        readSymbols: q("readSymbols"),
        readOnOpen: q("readOnOpen"),
        contQuestions: q("contQuestions"),
        thinking: q("thinking"),
        thinkingSec: q("thinkingSec"),
        test: q("test"),
        reconnect: q("reconnect"),
        speakSel: q("speakSel")
      };
      this.root.querySelector(".head").addEventListener("click", () => {
        this.collapsed = !this.collapsed;
        this.el.body.classList.toggle("hidden", this.collapsed);
        panel.classList.toggle("mini", this.collapsed);
        this.picker.close();
        this.questionPicker.close();
      });
      this.el.toggle.addEventListener("click", () => this.cb.onToggleEnabled(!this.settings.enabled));
      this.el.stop.addEventListener("click", () => this.cb.onStop());
      this.el.pause.addEventListener("click", () => this.cb.onTogglePause());
      this.el.test.addEventListener("click", () => this.cb.onTestSpeak());
      this.el.speakSel.addEventListener("mousedown", (e) => e.preventDefault());
      this.el.speakSel.addEventListener("click", () => this.cb.onSpeakSelection());
      this.el.reconnect.addEventListener("click", () => this.cb.onReconnect());
      this.picker = new VoicePicker({
        root: this.root,
        host: this.host,
        loadIcon: this.cb.loadIcon,
        onSelect: (opt) => this.cb.onChange({
          styleId: opt.styleId,
          speakerLabel: opt.label,
          recentStyleIds: pushRecent(this.settings.recentStyleIds, opt.styleId)
        }),
        onFavoritesChange: (favoriteSpeakers) => this.cb.onChange({ favoriteSpeakers }),
        onCollapsedChange: (collapsedPickerGroups) => this.cb.onChange({ collapsedPickerGroups }),
        onOpen: () => this.questionPicker.close()
      });
      this.el.voiceSlot.appendChild(this.picker.element);
      this.questionPicker = new VoicePicker({
        root: this.root,
        host: this.host,
        loadIcon: this.cb.loadIcon,
        compact: true,
        emptyLabel: "回答と同じ声",
        onSelect: (opt) => this.cb.onChange({
          questionStyleId: opt.styleId,
          recentStyleIds: pushRecent(this.settings.recentStyleIds, opt.styleId)
        }),
        onFavoritesChange: (favoriteSpeakers) => this.cb.onChange({ favoriteSpeakers }),
        onCollapsedChange: (collapsedPickerGroups) => this.cb.onChange({ collapsedPickerGroups }),
        onOpen: () => this.picker.close()
      });
      this.el.questionVoiceSlot.appendChild(this.questionPicker.element);
      const range = (key, input, out) => {
        input.addEventListener("input", () => {
          const v = Number(input.value);
          out.textContent = v.toFixed(2);
          this.cb.onChange({ [key]: v });
        });
      };
      range("speedScale", this.el.speed, this.el.speedVal);
      range("volumeScale", this.el.volume, this.el.volumeVal);
      this.el.gap.addEventListener("input", () => {
        const v = Number(this.el.gap.value);
        this.el.gapVal.textContent = v.toFixed(2);
        this.cb.onChange({ postPhonemeLength: v });
      });
      for (const key of ["codeMode", "urlMode", "tableMode"]) {
        this.el[key].addEventListener("change", (e) => {
          this.cb.onChange({ [key]: e.target.value });
        });
      }
      this.el.readOnOpen.addEventListener("change", (e) => {
        this.cb.onChange({ readOnOpen: e.target.checked });
      });
      this.el.readSymbols.addEventListener("change", (e) => {
        this.cb.onChange({ readSymbols: e.target.checked });
      });
      this.el.stopOnNew.addEventListener("change", (e) => {
        this.cb.onChange({ stopOnNewQuestion: e.target.checked });
      });
      this.el.contQuestions.addEventListener("change", (e) => {
        this.cb.onChange({ continuousReadsQuestions: e.target.checked });
      });
      this.el.thinking.addEventListener("change", (e) => {
        this.cb.onChange({ thinkingNotice: e.target.checked });
      });
      this.el.thinkingSec.addEventListener("change", (e) => {
        const v = Math.round(Number(e.target.value));
        if (!Number.isFinite(v)) return;
        this.cb.onChange({ thinkingNoticeSeconds: Math.min(120, Math.max(3, v)) });
      });
      this.el.debug.addEventListener("change", (e) => {
        this.cb.onChange({ debug: e.target.checked });
      });
    }
    setSettings(s) {
      this.settings = s;
      this.el.speed.value = String(s.speedScale);
      this.el.speedVal.textContent = s.speedScale.toFixed(2);
      this.el.volume.value = String(s.volumeScale);
      this.el.volumeVal.textContent = s.volumeScale.toFixed(2);
      this.el.gap.value = String(s.postPhonemeLength);
      this.el.gapVal.textContent = s.postPhonemeLength.toFixed(2);
      this.el.codeMode.value = s.codeMode;
      this.el.urlMode.value = s.urlMode;
      this.el.tableMode.value = s.tableMode;
      this.el.readSymbols.checked = s.readSymbols;
      this.el.readOnOpen.checked = s.readOnOpen;
      this.el.stopOnNew.checked = s.stopOnNewQuestion;
      this.el.contQuestions.checked = s.continuousReadsQuestions;
      this.el.thinking.checked = s.thinkingNotice;
      this.el.thinkingSec.value = String(s.thinkingNoticeSeconds);
      this.el.thinkingSec.disabled = !s.thinkingNotice;
      this.el.debug.checked = s.debug;
      this.el.toggle.textContent = s.enabled ? "🔊 ON" : "🔇 OFF";
      this.el.toggle.classList.toggle("on", s.enabled);
      this.picker.setPrefs(s.recentStyleIds, s.favoriteSpeakers, s.collapsedPickerGroups);
      this.picker.setSelected(s.styleId);
      this.questionPicker.setPrefs(s.recentStyleIds, s.favoriteSpeakers, s.collapsedPickerGroups);
      this.questionPicker.setSelected(s.questionStyleId);
    }
    setSpeakers(options, selectedId) {
      this.picker.setOptions(options, selectedId);
      this.questionPicker.setOptions(options, this.settings.questionStyleId);
    }
    /** 再生の状態に合わせて一時停止ボタンを切り替える。読むものが無いときは押せない */
    setPlayback(s) {
      const btn = this.el.pause;
      btn.textContent = s.paused ? "▶ 再開" : "⏸ 一時停止";
      btn.classList.toggle("paused", s.paused);
      btn.disabled = s.idle && !s.paused;
    }
    setConnection(state, text) {
      this.el.dot.className = `dot ${state}`;
      this.el.conn.textContent = text;
      this.el.conn.parentElement.title = `VOICEVOX ${text}`;
    }
    setStatus(text, isError = false) {
      this.el.status.textContent = text;
      this.el.status.classList.toggle("err", isError);
    }
    /**
     * ChatGPT も Claude も SPA なので、ページ遷移で body ごと作り直されると
     * パネルが DOM から外れて消える。外れていたら付け直す。
     */
    ensureMounted() {
      if (!document.body.contains(this.host)) {
        document.body.appendChild(this.host);
      }
    }
    destroy() {
      this.host.remove();
    }
  }
  const BTN_ATTR = "data-cvb-read-btn";
  const MARK_ATTR = "data-cvb-actions";
  const STYLE_ID = "cvb-actions-style";
  const LABELS = {
    answer: "🔊 この回答を読む",
    question: "🔊 この質問を読む",
    continue: "▶ ここから続けて読む"
  };
  const TITLES = {
    continue: "この回答から会話の最後まで、順番に読み上げます"
  };
  const CONTINUE_GAP = 6;
  const BASE_CSS = `
[${BTN_ATTR}] {
  position: absolute; z-index: 50;
  box-sizing: border-box; height: 22px; padding: 0 8px;
  display: inline-flex; align-items: center; white-space: nowrap;
  font: 11px/1 -apple-system, "Hiragino Sans", sans-serif;
  border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(128,128,128,.45);
  background: rgba(127,127,127,.15); color: inherit;
  opacity: 0; transition: opacity .12s ease;
}
[${MARK_ATTR}]:hover > [${BTN_ATTR}],
[${BTN_ATTR}]:focus-visible { opacity: 1; }
[${BTN_ATTR}]:hover { background: rgba(34,197,94,.25); border-color: rgba(34,197,94,.7); }
/* 回答のボタンの位置が測れないときの置き場所。測れたら alignContinue が上書きする */
[${BTN_ATTR}="continue"] { top: -24px; left: 124px; }
`;
  function alignContinue(turn, btn) {
    const answer = turn.querySelector(`:scope > [${BTN_ATTR}="answer"]`);
    if (!answer) return;
    const a = answer.getBoundingClientRect();
    if (a.width === 0) return;
    const t = turn.getBoundingClientRect();
    btn.style.left = `${Math.round(a.right - t.left - turn.clientLeft + CONTINUE_GAP)}px`;
    btn.style.top = `${Math.round(a.top - t.top - turn.clientTop)}px`;
    btn.style.right = "auto";
    btn.style.bottom = "auto";
    btn.style.transform = "none";
  }
  function ensureStyle(layout) {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = BASE_CSS + layout.css;
    document.head.appendChild(style);
  }
  function syncReadButtons(turns, kind, onRead, layout) {
    ensureStyle(layout);
    const align = kind === "question" ? layout.alignQuestion : kind === "continue" ? alignContinue : void 0;
    for (const turn of turns) {
      const existing = turn.querySelector(`:scope > [${BTN_ATTR}="${kind}"]`);
      if (existing) {
        align == null ? void 0 : align(turn, existing);
        continue;
      }
      turn.setAttribute(MARK_ATTR, "");
      if (getComputedStyle(turn).position === "static") turn.style.position = "relative";
      const btn = document.createElement("button");
      btn.setAttribute(BTN_ATTR, kind);
      btn.type = "button";
      btn.textContent = LABELS[kind];
      if (TITLES[kind]) btn.title = TITLES[kind];
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onRead(turn);
      });
      turn.appendChild(btn);
      align == null ? void 0 : align(turn, btn);
    }
  }
  function removeReadButtons() {
    document.querySelectorAll(`[${BTN_ATTR}]`).forEach((b) => b.remove());
    document.querySelectorAll(`[${MARK_ATTR}]`).forEach((t) => t.removeAttribute(MARK_ATTR));
  }
  function getSelectionFragment() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0).cloneContents();
  }
  const MAX_GAP_RETRIES = 12;
  const KEY_LENGTH = 200;
  class ContinuousReader {
    constructor(deps) {
      this.deps = deps;
      this.current = null;
      this.token = 0;
      this.advancing = false;
      this.gapRetries = 0;
    }
    get active() {
      return this.current !== null;
    }
    /** この発言から読み始める */
    start(turn) {
      this.token++;
      this.advancing = false;
      this.play(turn);
    }
    /** 止める（STOP・新しい質問・ほかの読み上げを始めたとき） */
    cancel() {
      this.token++;
      this.advancing = false;
      this.current = null;
    }
    /** 読み上げの列が空になったら呼ぶ。次の発言へ進む */
    onIdle() {
      if (!this.current || this.advancing) return;
      this.advancing = true;
      const el = this.current.turn.el;
      if (el.isConnected) this.deps.reveal(el, "end");
      this.advanceSoon();
    }
    advanceSoon() {
      const token = this.token;
      setTimeout(() => {
        var _a, _b, _c, _d;
        if (token !== this.token) return;
        if (!this.deps.isIdle()) {
          this.advancing = false;
          return;
        }
        const cur = this.current;
        const next = this.findNext();
        if (next === "lost") return this.finish("lost");
        if (next === null) return this.finish("done");
        if (cur && cur.turn.el.isConnected && ((_b = (_a = this.deps).isContiguous) == null ? void 0 : _b.call(_a, cur.turn.el, next.el)) === false) {
          if (++this.gapRetries > MAX_GAP_RETRIES) return this.finish("lost");
          (_d = (_c = this.deps).nudge) == null ? void 0 : _d.call(_c, cur.turn.el);
          return this.advanceSoon();
        }
        this.advancing = false;
        this.play(next);
      }, this.deps.settleMs ?? 400);
    }
    finish(reason) {
      this.advancing = false;
      this.current = null;
      this.deps.onFinish(reason);
    }
    play(turn) {
      this.gapRetries = 0;
      this.current = { turn, key: this.deps.textOf(turn).slice(0, KEY_LENGTH) };
      this.deps.reveal(turn.el, "start");
      if (!this.deps.speak(turn)) {
        const token = this.token;
        setTimeout(() => {
          if (token === this.token) this.onIdle();
        }, 0);
      }
    }
    findNext() {
      const cur = this.current;
      if (!cur) return null;
      const turns = this.deps.listTurns();
      let i = turns.findIndex((t) => t.el === cur.turn.el);
      if (i < 0 && cur.key) {
        i = turns.findIndex((t) => t.kind === cur.turn.kind && this.deps.textOf(t).slice(0, KEY_LENGTH) === cur.key);
      }
      if (i < 0) return "lost";
      return turns[i + 1] ?? null;
    }
  }
  function mergeTurns(answers, questions) {
    const all = [
      ...answers.map((el) => ({ el, kind: "answer" })),
      ...questions.map((el) => ({ el, kind: "question" }))
    ];
    return all.sort(
      (a, b) => a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
  }
  class IconCache {
    constructor(client) {
      this.client = client;
      this.infos = /* @__PURE__ */ new Map();
      this.icons = /* @__PURE__ */ new Map();
      this.byStyle = /* @__PURE__ */ new Map();
    }
    setOptions(options) {
      this.byStyle = new Map(options.map((o) => [o.styleId, o]));
    }
    /** スタイルの顔アイコン（表示用 URL）。取れなければ null。 */
    icon(styleId) {
      const cached = this.icons.get(styleId);
      if (cached) return cached;
      const job = (async () => {
        const opt = this.byStyle.get(styleId);
        if (!opt) return null;
        const info = await this.info(opt.speakerUuid);
        const resource = info == null ? void 0 : info.styleIcons.get(styleId);
        if (!resource) return null;
        try {
          return await this.client.imageUrl(resource);
        } catch (e) {
          warn("UI", "アイコン取得に失敗", styleId, e);
          return null;
        }
      })();
      this.icons.set(styleId, job);
      return job;
    }
    info(uuid) {
      const cached = this.infos.get(uuid);
      if (cached) return cached;
      const job = this.client.speakerInfo(uuid).catch((e) => {
        warn("UI", "speaker_info 取得に失敗", uuid, e);
        this.infos.delete(uuid);
        return null;
      });
      this.infos.set(uuid, job);
      return job;
    }
  }
  function main(site) {
    let settings = loadSettings();
    setDebug(settings.debug);
    const client = new VoicevoxClient(settings.engineOrigin);
    const adapter = site.createAdapter();
    const icons = new IconCache(client);
    let styleOptions = [];
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
        pauseLengthScale: settings.pauseLengthScale
      }),
      onError: (msg) => {
        continuous.cancel();
        ui.setStatus(msg, true);
        if (msg.includes("接続")) void connect();
      },
      onStateChange: (s) => {
        ui.setPlayback(s);
        if (s.paused) ui.setStatus(`一時停止中（待ち ${s.queued}）`);
        else if (!s.speaking && s.queued === 0) ui.setStatus("");
        else ui.setStatus(`${s.speaking ? "読み上げ中" : "合成中"}（待ち ${s.queued}）`);
        if (s.idle) continuous.onIdle();
      }
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
      onTogglePause: () => queue.snapshot.paused ? queue.resume() : queue.pause(),
      onReconnect: () => void connect(),
      onTestSpeak: () => queue.enqueue("ボイスボックス接続テストです。"),
      onSpeakSelection: () => speakSelection(),
      loadIcon: (styleId) => icons.icon(styleId),
      onChange: (patch) => update(patch)
    });
    const sanitizeOptions = () => ({
      ...DEFAULT_SANITIZE_OPTIONS,
      urlMode: settings.urlMode,
      codeMode: settings.codeMode,
      tableMode: settings.tableMode,
      readSymbols: settings.readSymbols,
      site: site.sanitize
    });
    const chunkerOptions = () => ({
      minimumChunkLength: settings.minimumChunkLength,
      preferredChunkLength: settings.preferredChunkLength,
      maximumChunkLength: settings.maximumChunkLength
    });
    function speakElement(el, styleId) {
      stopSpeaking();
      if (!enqueueElement(el, styleId)) ui.setStatus("読み上げる内容がありません", true);
    }
    function enqueueElement(el, styleId) {
      const text = extractSpeechText(el, sanitizeOptions());
      if (!text) return false;
      const chunker = new SpeechChunker(chunkerOptions());
      chunker.append(text);
      const chunks = chunker.take(true);
      for (const c of chunks) queue.enqueue(c, styleId);
      return chunks.length > 0;
    }
    const contentOf = (t) => t.kind === "answer" ? adapter.contentOfTurn(t.el) : adapter.contentOfUserTurn(t.el);
    const continuous = new ContinuousReader({
      listTurns: () => mergeTurns(adapter.assistantTurns(), settings.continuousReadsQuestions ? adapter.userTurns() : []),
      textOf: (t) => extractSpeechText(contentOf(t), sanitizeOptions()),
      speak: (t) => enqueueElement(contentOf(t), t.kind === "question" ? questionStyleId() : void 0),
      isIdle: () => queue.snapshot.idle,
      reveal: (el, block) => el.scrollIntoView({ behavior: "smooth", block }),
      isContiguous: (a, b) => {
        var _a;
        return ((_a = adapter.isContiguous) == null ? void 0 : _a.call(adapter, a, b)) ?? true;
      },
      nudge: (el) => {
        let p = el.parentElement;
        while (p && !(p.scrollHeight > p.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(p).overflowY))) {
          p = p.parentElement;
        }
        p == null ? void 0 : p.scrollBy({ top: p.clientHeight * 0.6 });
      },
      onFinish: (reason) => {
        if (reason === "lost") ui.setStatus("続きの発言を見つけられませんでした", true);
      }
    });
    function questionStyleId() {
      const id = settings.questionStyleId;
      return id !== null && styleOptions.some((o) => o.styleId === id) ? id : void 0;
    }
    function speakSelection() {
      const fragment = getSelectionFragment();
      if (!fragment) {
        ui.setStatus("先に読みたい部分を選択してください", true);
        return;
      }
      const holder = document.createElement("div");
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
        getWaitSeconds: () => settings.thinkingNotice ? settings.thinkingNoticeSeconds : null,
        // 続けて読んでいる最中は、発言と発言の間の一瞬の空きに割り込まない
        isSpeechIdle: () => queue.snapshot.idle && !continuous.active,
        onNotice: (count) => queue.enqueue(count === 1 ? "考え中です。" : "まだ考えています。")
      }
    });
    function stopSpeaking() {
      continuous.cancel();
      queue.stopAll();
      observer.resetBuffers();
      ui.setStatus("");
    }
    function update(patch) {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      setDebug(settings.debug);
      ui.setSettings(settings);
    }
    async function connect() {
      ui.setConnection("connecting", "接続中…");
      try {
        const version = await client.version();
        const speakers = await client.speakers();
        styleOptions = flattenStyles(speakers);
        icons.setOptions(styleOptions);
        const chosen = resolveStyle(styleOptions, settings.styleId);
        ui.setSpeakers(styleOptions, (chosen == null ? void 0 : chosen.styleId) ?? null);
        if (chosen && chosen.styleId !== settings.styleId) {
          update({ styleId: chosen.styleId, speakerLabel: chosen.label });
        } else {
          ui.setSettings(settings);
        }
        ui.setConnection("connected", `v${version}`);
        ui.setStatus(chosen ? "" : "話者が見つかりません", !chosen);
        log("VOICEVOX", "connected", version, `${styleOptions.length} styles`);
      } catch (e) {
        warn("VOICEVOX", "connect failed", e);
        ui.setConnection("disconnected", "未接続");
        ui.setStatus(`${describeError(e)}。VOICEVOXを起動してください`, true);
      }
    }
    ui.setSettings(settings);
    const probe = adapter.probe();
    if (!probe.ok) ui.setStatus(`${site.label}の画面を認識できません`, true);
    if (!gmAvailable()) {
      warn("Main", "GM_xmlhttpRequest が使えません。fetch へフォールバックします（CORSに注意）");
    }
    observer.start();
    adapter.onSubmit(() => observer.notifySubmitted());
    void connect();
    window.setInterval(() => {
      try {
        ui.ensureMounted();
      } catch (e) {
        warn("UI", "パネルの再設置に失敗", e);
      }
      if (!settings.enabled) return;
      try {
        syncReadButtons(
          adapter.assistantTurns(),
          "answer",
          (turn) => speakElement(adapter.contentOfTurn(turn)),
          site.readButtons
        );
        syncReadButtons(
          adapter.assistantTurns(),
          "continue",
          (turn) => {
            stopSpeaking();
            continuous.start({ el: turn, kind: "answer" });
          },
          site.readButtons
        );
        syncReadButtons(
          adapter.userTurns(),
          "question",
          (turn) => speakElement(adapter.contentOfUserTurn(turn), questionStyleId()),
          site.readButtons
        );
      } catch (e) {
        warn("UI", "ボタン差し込みに失敗", e);
      }
    }, 1e3);
    log("Main", `VOICEVOX Bridge started on ${site.label}`);
  }
  function boot() {
    const site = detectSite(location.hostname);
    if (!site) {
      warn("Main", "対象外のサイトです", location.hostname);
      return;
    }
    main(site);
  }
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
    } else {
      boot();
    }
  } catch (e) {
    error("Main", "fatal", e);
  }

})();