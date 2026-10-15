/* 공용 유틸: 알림음, 탭 제목, 데스크톱 알림, 포맷터 */
(function (global) {
  'use strict';

  // ── 알림음 ────────────────────────────────────────────────────────────────
  // 오디오 파일 없이 합성한다. 브라우저 자동재생 정책 때문에 사용자의 첫
  // 클릭 시점에 unlock()을 반드시 한 번 호출해야 한다.
  let ctx = null;

  // 각 음색은 [주파수, 시작시각(초), 길이(초), 파형, 세기] 목록이다.
  const KITS = {
    bell:   { name: '종소리',   notes: [[784, 0, .18, 'sine', 1], [988, .11, .3, 'sine', .9]] },
    chime:  { name: '차임',     notes: [[523, 0, .16, 'triangle', 1], [659, .1, .16, 'triangle', 1], [784, .2, .32, 'triangle', .9]] },
    drop:   { name: '물방울',   notes: [[1100, 0, .16, 'sine', 1, 380]] },
    knock:  { name: '노크',     notes: [[190, 0, .07, 'square', .55], [170, .13, .09, 'square', .5]] },
    pulse:  { name: '펄스',     notes: [[440, 0, .06, 'square', .5], [440, .1, .06, 'square', .5], [440, .2, .06, 'square', .5]] },
    harp:   { name: '하프',     notes: [[523, 0, .5, 'sine', .7], [659, .06, .5, 'sine', .7], [784, .12, .5, 'sine', .7], [1047, .18, .6, 'sine', .6]] },
    low:    { name: '낮은음',   notes: [[220, 0, .28, 'sine', 1], [165, .12, .34, 'sine', .8]] },
    alert:  { name: '경보',     notes: [[880, 0, .1, 'sawtooth', .5], [660, .12, .1, 'sawtooth', .5], [880, .24, .16, 'sawtooth', .5]] },
    send:   { name: '보내기',   notes: [[660, 0, .12, 'sine', .6]] },
    // 정답을 맞혔을 때. 다른 알림과 확실히 구분되도록 올라가는 세 음.
    verdict: { name: '정답',     notes: [[659, 0, .14, 'triangle', 1], [880, .1, .14, 'triangle', 1],
                                        [1318, .2, .42, 'triangle', .95]] },
  };
  const KIT_KEYS = Object.keys(KITS).filter((k) => k !== 'send' && k !== 'verdict');
  const STORE_KEY = 'mm.sound';
  const CUSTOM_KEY = 'mm.sound.custom';   // 직접 올린 소리 (이 브라우저에만)
  const CUSTOM_MAX = 1024 * 1024;         // 1MB

  let master = null;                      // 볼륨 조절 지점
  let customBuffer = null;                // 디코딩된 커스텀 사운드
  let customName = '';

  // 서버의 public/assets/sounds 에 넣어 둔 소리. 이 서버를 쓰는 모두가 같이 쓴다.
  let presetSounds = [];
  const presetBuffers = new Map();        // url -> AudioBuffer
  const PRESET = 'p:';                    // 음색 id 앞에 붙는 표시
  const presetUrl = (id) => id.slice(PRESET.length);

  /** 기본 제공 소리를 한 번 받아 둔다 (없으면 조용히 넘어간다). */
  async function fetchPresets() {
    try {
      const r = await fetch('/api/presets');
      if (!r.ok) return { sounds: [], emojis: [] };
      return await r.json();
    } catch { return { sounds: [], emojis: [] }; }
  }

  /** 소리 파일을 받아 디코딩해 둔다. */
  async function loadPresetBuffer(url) {
    if (presetBuffers.has(url)) return presetBuffers.get(url);
    if (!ctx) return null;
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      presetBuffers.set(url, decoded);
      return decoded;
    } catch { return null; }
  }

  /** 오디오 그래프: 소리 → master → 리미터 → 스피커.
   *  리미터를 두면 볼륨을 1 이상으로 올려도 깨지지 않고 커진다. */
  function chain() {
    if (!ctx) return null;
    if (!master) {
      master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-8, ctx.currentTime);
      limiter.knee.setValueAtTime(6, ctx.currentTime);
      limiter.ratio.setValueAtTime(12, ctx.currentTime);
      limiter.attack.setValueAtTime(0.002, ctx.currentTime);
      limiter.release.setValueAtTime(0.15, ctx.currentTime);
      master.connect(limiter).connect(ctx.destination);
    }
    master.gain.setValueAtTime(Sound.volume, ctx.currentTime);
    return master;
  }

  const Sound = {
    enabled: true,
    kit: 'bell',
    volume: 1.0,                 // 0 ~ 3 (1을 넘으면 리미터가 받쳐준다)
    customName: '',
    get list() {
      return KIT_KEYS.map((k) => ({ id: k, name: KITS[k].name }))
        .concat(presetSounds.map((s) => ({ id: PRESET + s.url, name: s.name, preset: true })));
    },

    /** 서버에 깔아 둔 기본 소리 목록을 읽어 온다. */
    async loadPresets() {
      const data = await fetchPresets();
      presetSounds = data.sounds || [];
      emojiPresets = data.emojis || [];
      return presetSounds;
    },
    presetList() { return presetSounds.slice(); },

    load() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        if (saved.kit && (KITS[saved.kit] || saved.kit.startsWith(PRESET) || saved.kit === 'custom')) this.kit = saved.kit;
        if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled;
        if (typeof saved.volume === 'number') this.volume = Math.min(Math.max(saved.volume, 0), 3);
      } catch { /* 저장값이 깨졌으면 기본값으로 */ }
      try {
        const raw = localStorage.getItem(CUSTOM_KEY);
        if (raw) {
          const c = JSON.parse(raw);
          // 소리 데이터 없이 이름만 남은 항목은 버린다.
          if (!c || typeof c.data !== 'string' || c.data.length < 100) throw new Error('broken');
          this.customName = customName = c.name || '내 소리';
        }
      } catch {
        try { localStorage.removeItem(CUSTOM_KEY); } catch { }
        this.customName = customName = '';
      }
      if (this.kit === 'custom' && !this.hasCustom()) this.kit = 'bell';
      return this;
    },

    /** 알림음 설정을 처음 상태로 되돌린다 (새 방을 시작할 때). */
    reset() {
      try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(CUSTOM_KEY); } catch { }
      customBuffer = null;
      this.customName = customName = '';
      this.enabled = true;
      this.kit = 'bell';
      this.volume = 1.0;
      if (master && ctx) master.gain.setValueAtTime(this.volume, ctx.currentTime);
    },
    save() {
      try {
        localStorage.setItem(STORE_KEY,
          JSON.stringify({ kit: this.kit, enabled: this.enabled, volume: this.volume }));
      } catch { }
    },
    setKit(id) {
      if (KITS[id] || id.startsWith(PRESET) || id === 'custom') { this.kit = id; this.save(); }
    },
    setVolume(v) {
      this.volume = Math.min(Math.max(Number(v) || 0, 0), 3);
      if (master && ctx) master.gain.setValueAtTime(this.volume, ctx.currentTime);
      this.save();
    },
    hasCustom() { return !!(customBuffer || localStorage.getItem(CUSTOM_KEY)); },

    /** 사용자가 고른 오디오 파일을 알림음으로 등록한다 (이 브라우저에만 저장). */
    async setCustomFile(file) {
      if (!file) return;
      if (file.size > CUSTOM_MAX) throw new Error('1MB 이하 파일만 등록할 수 있습니다');
      const buf = await file.arrayBuffer();
      this.unlock();
      if (!ctx) throw new Error('브라우저가 오디오를 지원하지 않습니다');
      customBuffer = await ctx.decodeAudioData(buf.slice(0));
      customName = this.customName = file.name;
      // base64로 저장해 두면 다음에 열 때도 그대로 쓴다.
      // 한 번에 펼치면 큰 파일에서 호출 스택이 넘치므로 조각내서 바꾼다.
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const b64 = btoa(bin);
      try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify({ name: file.name, data: b64 }));
      } catch {
        throw new Error('저장 공간이 부족합니다. 더 작은 파일을 써 주세요');
      }
      this.kit = 'custom';
      this.save();
    },

    /** 저장해 둔 커스텀 사운드를 디코딩한다 (첫 재생 전에 한 번). */
    async loadCustom() {
      if (customBuffer || !ctx) return;
      let raw;
      try { raw = localStorage.getItem(CUSTOM_KEY); } catch { return; }
      if (!raw) return;
      try {
        const c = JSON.parse(raw);
        const bin = atob(c.data);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        customBuffer = await ctx.decodeAudioData(arr.buffer);
        customName = this.customName = c.name;
      } catch {
        // 재생할 수 없는 저장값이면 목록에 이름만 남지 않게 지운다.
        this.clearCustom();
        document.querySelectorAll('select[data-soundkit]').forEach((s) => paintKitOptions(s));
      }
    },

    clearCustom() {
      customBuffer = null;
      customName = this.customName = '';
      try { localStorage.removeItem(CUSTOM_KEY); } catch { }
      if (this.kit === 'custom') this.kit = 'bell';
      this.save();
    },
    toggle() { this.enabled = !this.enabled; this.save(); return this.enabled; },

    unlock() {
      if (ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    },

    /** kind: 'recv'(설정된 음색) | 'send' | 음색 id를 직접 지정해 미리듣기 */
    play(kind) {
      if (!ctx) return;
      if (kind !== 'send' && kind !== 'recv' && !this.enabled) return;
      if (kind === 'recv' && !this.enabled) return;
      if (kind === 'send' && !this.enabled) return;
      if (ctx.state === 'suspended') ctx.resume();

      const out = chain();
      if (!out) return;
      const key = kind === 'send' ? 'send'
        : (KITS[kind] || String(kind || '').startsWith(PRESET) ? kind : this.kit);

      // 서버에 깔아 둔 소리 파일
      if (typeof key === 'string' && key.startsWith(PRESET)) {
        if (this.volume <= 0) return;
        const url = presetUrl(key);
        const buf = presetBuffers.get(url);
        const start = (b) => {
          if (!b) return;
          const src = ctx.createBufferSource();
          src.buffer = b;
          src.connect(out);
          src.start();
        };
        // 아직 안 받아왔으면 받아서 바로 울린다 (다음부터는 즉시 울린다).
        if (buf) start(buf); else loadPresetBuffer(url).then(start);
        return;
      }

      // 직접 등록한 소리는 그대로 재생한다.
      if (key !== 'send' && this.kit === 'custom' && !KITS[kind]) {
        if (!customBuffer) { this.loadCustom(); return; }
        const src = ctx.createBufferSource();
        src.buffer = customBuffer;
        src.connect(out);
        src.start();
        return;
      }

      const kit = KITS[key] || KITS.bell;
      const t0 = ctx.currentTime;

      if (this.volume <= 0) return;
      for (const [freq, at, dur, wave, gainScale, glideTo] of kit.notes) {
        const t = t0 + at;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave || 'sine';
        osc.frequency.setValueAtTime(freq, t);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
        // 예전 기본값(0.16)은 너무 작았다. 볼륨 1에서 확실히 들리도록 올린다.
        // 크기는 master에서 한 번에 조절한다. 여기서는 음색 사이 균형만 잡는다.
        const peak = Math.max(0.0002, 0.9 * (gainScale ?? 1));
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(out);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
    },

    /** 설정 화면에서 음색을 눌러볼 때 (켜짐/꺼짐과 무관하게 들려준다) */
    preview(id) {
      this.unlock();
      const was = this.enabled;
      this.enabled = true;
      this.play(id);
      this.enabled = was;
    },
  }.load();

  // ── 탭 제목 깜빡임 ────────────────────────────────────────────────────────
  const Title = {
    base: document.title,
    count: 0,
    timer: null,
    flip: false,
    setBase(t) { this.base = t; this.render(); },
    bump() {
      this.count++;
      if (!this.timer) {
        this.timer = setInterval(() => { this.flip = !this.flip; this.render(); }, 900);
      }
      this.render();
    },
    clear() {
      this.count = 0;
      if (this.timer) clearInterval(this.timer);
      this.timer = null; this.flip = false;
      this.render();
    },
    render() {
      document.title = this.count > 0
        ? (this.flip ? `💬 새 메시지 (${this.count})` : `(${this.count}) ${this.base}`)
        : this.base;
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) Title.clear();
  });

  // ── 데스크톱 알림 ─────────────────────────────────────────────────────────
  // 윈도우 알림 창은 쓰지 않는다 (알림음과 탭 제목 표시로 충분하다).
  const Desktop = {
    ask() { },
    show() { },
  };

  /** 새 메시지가 도착했을 때의 표준 반응 */
  function alertIncoming(title, body, tag) {
    Sound.play('recv');
    if (document.hidden) { Title.bump(); Desktop.show(title, body, tag); }
  }

  // ── 대화에 붙이는 표시 ────────────────────────────────────────────────────
  // 기본은 네 가지. 서버 public/assets/emoji 에 이미지를 넣으면 함께 나온다.
  const DEFAULT_MARKS = ['\u2705', '\u2b55', '\u274c', '\u2753'];
  let emojiPresets = [];
  const IMG = 'img:';

  const markImgUrl = (mark) => '/assets/emoji/' + encodeURIComponent(mark.slice(IMG.length));

  /** 표시 하나를 화면에 그릴 조각. 이미지 표시도 같은 자리에 들어간다. */
  function markHtml(mark) {
    return String(mark).startsWith(IMG)
      ? `<img class="rmimg" src="${markImgUrl(mark)}" alt="">`
      : esc(mark);
  }

  /** 지금 쓸 수 있는 표시 목록 */
  function markList() {
    return DEFAULT_MARKS.concat(emojiPresets.map((e) => IMG + e.id.split(':').slice(1).join(':')));
  }

  /** 말풍선 아래에 붙는 표시 줄. myActor 가 누른 것은 표시가 도드라진다. */
  function reactionsHtml(reactions, myActor) {
    const list = reactions || [];
    const chips = list.map((r) => {
      const mine = (r.actors || []).includes(myActor) ? ' on' : '';
      const who = (r.names || []).join(', ');
      return `<button class="rxchip${mine}" data-mark="${esc(r.emoji)}" title="${esc(who)}">` +
             `${markHtml(r.emoji)}<span class="n">${(r.actors || []).length}</span></button>`;
    }).join('');
    // 표시가 하나도 없으면 자리를 차지하지 않는다 (마우스를 올렸을 때만 펴진다).
    return `<span class="rx${chips ? '' : ' rx-none'}">${chips}` +
           '<button class="rxadd" title="표시 추가">+</button></span>';
  }

  /**
   * 표시 줄을 눌렀을 때의 동작을 붙인다.
   *  onToggle(messageId, mark) — 서버에 보낼 일을 맡는다.
   */
  function mountReactions(container, { onToggle }) {
    let menu = null;
    const closeMenu = () => { menu?.remove(); menu = null; };
    document.addEventListener('click', (e) => {
      if (menu && !menu.contains(e.target) && !e.target.classList?.contains('rxadd')) closeMenu();
    });

    container.addEventListener('click', (e) => {
      const chip = e.target.closest?.('.rxchip');
      if (chip && container.contains(chip)) {
        const id = chip.closest('.msg')?.dataset.id;
        if (id) onToggle(id, chip.dataset.mark);
        return;
      }
      if (!e.target.classList?.contains('rxadd')) return;

      const msgId = e.target.closest('.msg')?.dataset.id;
      if (!msgId) return;
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'rxmenu';
      menu.innerHTML = markList()
        .map((m) => `<button data-mark="${esc(m)}">${markHtml(m)}</button>`).join('');
      document.body.appendChild(menu);

      const r = e.target.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;

      menu.addEventListener('click', (ev) => {
        const mark = ev.target.closest('button')?.dataset.mark;
        if (mark) onToggle(msgId, mark);
        closeMenu();
      });
    });
  }

  // ── 모듈 패널 ─────────────────────────────────────────────────────────────
  // 모듈 화면은 /modules/<모듈id>.<gm|player>.js 에 있다. 방에서 켜진 모듈의
  // 파일만 불러와 탭과 패널을 만든다. 꺼져 있으면 파일을 아예 받지 않는다.
  //
  // 모듈이 `attachTo: '다른모듈id'` 를 적으면 **자기 탭을 만들지 않고** 그 모듈 화면에
  // 얹힌다 (확장 모듈). 얹히는 자리와 도구는 주인 모듈이 정해서 넘겨준다.
  const panelDefs = new Map();

  const Panels = {
    /** 모듈 파일이 자기 화면을 등록할 때 부른다. */
    define(def) {
      if (def && def.id) panelDefs.set(`${def.id}:${def.side || 'gm'}`, def);
    },

    /** 이 모듈에 얹히기로 한 확장들 (주인 모듈이 부른다). */
    attached(hostId, side = 'gm') {
      return [...panelDefs.values()].filter((d) => d.attachTo === hostId && (d.side || 'gm') === side);
    },

    /**
     * 켜진 모듈의 화면을 불러 붙인다.
     *   ids     — 켜진 모듈 id 목록
     *   side    — 'gm' | 'player'
     *   tabsEl  — 탭 버튼을 넣을 곳,  panelsEl — 패널을 넣을 곳
     *   attr    — 탭/패널을 잇는 속성 이름 ('rtab'/'rpanel' 또는 'ptab'/'ppane')
     *   ctx     — 모듈에 넘길 도구 모음
     */
    async load(ids, { side = 'gm', tabsEl, panelsEl, tabAttr, panelAttr, paneClass = 'panel', ctx }) {
      // 1) 파일을 모두 먼저 받는다.
      //    확장 모듈이 주인 모듈보다 늦게 등록되면 얹힐 기회를 놓치기 때문이다.
      for (const id of ids || []) {
        if (panelDefs.has(`${id}:${side}`)) continue;
        try {
          await new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = `/modules/${id}.${side}.js`;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`${id} 화면을 불러오지 못했습니다`));
            document.head.appendChild(el);
          });
        } catch (e) {
          console.warn('[모듈]', e.message);      // 그 모듈만 빠지고 나머지는 그대로 쓴다
        }
      }

      // 2) 자기 탭을 가진 모듈만 탭과 패널을 만든다.
      for (const id of ids || []) {
        const def = panelDefs.get(`${id}:${side}`);
        if (!def || def.attachTo || !tabsEl || !panelsEl) continue;

        try {
          const btn = document.createElement('button');
          btn.dataset[tabAttr] = id;
          btn.textContent = def.label || id;
          tabsEl.appendChild(btn);

          const panel = document.createElement('div');
          panel.className = `${paneClass} hidden`;
          panel.dataset[panelAttr] = id;
          panel.id = `panel-${id}`;
          panelsEl.appendChild(panel);

          def.mount?.(panel, ctx);
        } catch (e) {
          console.warn(`[모듈] ${id} 화면 오류 —`, e.message);
        }
      }
    },
  };

  // ── 탭 정리 · 창 분할 ─────────────────────────────────────────────────────
  // 탭이 많아지면 줄이 길어진다. 안 쓰는 탭은 ✕ 로 접어두고, ＋ 로 다시 꺼낸다.
  // ▥ 로 탭 하나를 옆(또는 위아래)에 붙여 두 화면을 같이 볼 수 있다.
  // 끌어서 순서도 바꿀 수 있다. 정한 것은 이 브라우저에 남는다.
  //
  // 어떤 패널을 보여줄지는 **여기서만** 정한다. 화면 파일(gm.js·room.js)이나
  // 모듈이 각자 숨기고 보이면 분할이 곧바로 깨지기 때문이다.
  // 패널은 id 를 알지 못한 채 data-속성으로만 찾으므로, 나중에 모듈이
  // 탭을 더해도 이 함수는 손댈 곳이 없다.
  function mountTabs(tabsEl, { key, tabAttr = 'rtab', panelAttr = 'rpanel', keep = [], onShow } = {}) {
    if (!tabsEl || tabsEl.dataset.tabsMounted) return null;
    tabsEl.dataset.tabsMounted = '1';

    const store = `mm.tabs.${key}`;
    let state = { hidden: [], order: [], split: null, dir: '', ratio: 0.5 };
    try { state = { ...state, ...JSON.parse(localStorage.getItem(store) || '{}') }; } catch { }
    const save = () => { try { localStorage.setItem(store, JSON.stringify(state)); } catch { } };

    // 탭뿐 아니라 '내보내기·도움말' 같은 단추도 같이 접고 옮길 수 있게 한다.
    const tabs = () => [...tabsEl.querySelectorAll(`[data-${tabAttr}], [data-tabitem]`)];
    const idOf = (btn) => btn.dataset[tabAttr] || `act:${btn.dataset.tabitem}`;
    const labelOf = (id) => {
      const btn = tabs().find((b) => idOf(b) === id);
      return btn ? btn.textContent.replace('✕', '').trim() : id;
    };
    const panels = () => [...document.querySelectorAll(`[data-${panelAttr}]`)];
    const panelOf = (id) => panels().find((p) => p.dataset[panelAttr] === id);
    const realTabs = () => tabs().filter((b) => b.dataset[tabAttr]);
    const shownTabs = () => realTabs().filter((b) => !state.hidden.includes(idOf(b)));
    const activeId = () => {
      const on = realTabs().find((b) => b.classList.contains('on'));
      return on ? idOf(on) : null;
    };

    // 패널을 상자 하나에 모은다 — 분할할 때 둘을 나란히 두기 위해서다.
    // 모듈 화면이 나중에 붙어도 상자 안으로 저절로 들어온다.
    const box = document.createElement('div');
    box.className = 'panebox';
    const grip = document.createElement('div');          // 가운데 경계선 (끌어서 비율 조절)
    grip.className = 'panedrag';

    // 옆으로 떼어낸 탭이 들어앉는 칸. 위에 이름표와 ✕ 가 붙고,
    // 그동안 그 탭은 탭 줄에서 빠진다 (같은 것이 두 군데 보이지 않게).
    const slot = document.createElement('div');
    slot.className = 'paneslot';
    slot.innerHTML = '<div class="paneslot-head"><span class="nm"></span>'
      + '<button class="slotx" title="한 화면으로 되돌리기">✕</button></div>';
    const slotName = slot.querySelector('.nm');
    slot.addEventListener('click', (e) => {
      if (!e.target.closest('.slotx')) return;
      setLayout({ main: activeId(), side: null });
    });
    /** 가로로 나눌지 위아래로 나눌지. 정해 둔 것이 없으면 폭을 보고 고른다. */
    const dirNow = () => state.dir || ((box.clientWidth || 0) >= 560 ? 'row' : 'col');
    const clamp = (v) => Math.min(0.8, Math.max(0.2, v));

    /** 두 패널이 나눠 갖는 몫. 경계선을 끄는 동안에는 이것만 다시 그린다. */
    function applyRatio(mainId) {
      const r = clamp(state.ratio || 0.5);
      const a = panelOf(mainId);
      if (a) a.style.flex = `${r} 1 0`;
      slot.style.flex = `${1 - r} 1 0`;
    }

    /** 지금 무엇을 보여줄지 정한다. 패널의 hidden 을 건드리는 곳은 여기뿐이다. */
    function paintPanels() {
      const mainId = activeId();
      const sideId = state.split && state.split !== mainId
        && panelOf(state.split) && !state.hidden.includes(state.split)
        ? state.split : null;

      for (const p of panels()) {
        const id = p.dataset[panelAttr];
        p.classList.toggle('hidden', !(id === mainId || id === sideId));
        if (!sideId) p.style.flex = '';
      }
      box.classList.toggle('split', !!sideId);
      box.classList.toggle('col', dirNow() === 'col');

      if (sideId) {
        const a = panelOf(mainId), b = panelOf(sideId);
        slotName.textContent = labelOf(sideId);
        slot.appendChild(b);                       // 떼어낸 화면은 이름표 아래에 들어간다
        box.insertBefore(a, box.firstChild);
        box.insertBefore(grip, a.nextSibling);
        box.insertBefore(slot, grip.nextSibling);
        b.style.flex = '';                         // 비율은 칸이 들고 있다
        applyRatio(mainId);
      } else {
        // 떼어냈던 화면을 제자리로 돌려놓는다.
        for (const p of [...slot.children]) if (p.dataset[panelAttr]) box.appendChild(p);
        grip.remove();
        slot.remove();
      }
      // 떼어낸 탭은 탭 줄에서 잠시 빠진다 (✕ 를 누르면 돌아온다).
      for (const b of realTabs()) b.classList.toggle('torn', !!sideId && idOf(b) === sideId);
    }

    /** 무엇을 주 화면으로, 무엇을 옆에 둘지 한 번에 정한다. */
    function setLayout({ main, side, dir }) {
      const btn = realTabs().find((b) => idOf(b) === main);
      if (!btn) return;
      if (dir) state.dir = dir;
      state.split = side && side !== main ? side : null;
      for (const b of realTabs()) b.classList.toggle('on', b === btn);
      save();
      paintPanels();
      onShow?.(main);
    }

    /** 탭을 고른다. 옆에 붙여 둔 탭을 고르면 둘의 자리가 바뀐다. */
    function activate(btn) {
      if (!btn?.dataset[tabAttr]) return;
      const id = idOf(btn);
      setLayout({ main: id, side: state.split === id ? activeId() : state.split });
    }

    /** ＋ · ▥ 단추 (필요할 때만 보인다) */
    const mkBtn = (cls, text, title) => {
      let el = tabsEl.querySelector(`.${cls}`);
      if (!el) {
        el = document.createElement('button');
        el.className = cls;
        el.textContent = text;
        el.title = title;
        tabsEl.appendChild(el);
      }
      return el;
    };
    const more = mkBtn('tabmore', '＋', '접어 둔 탭 다시 꺼내기');
    const splitBtn = mkBtn('tabsplit', '▥', '탭 하나를 옆에 붙여 같이 보기');

    // 목록 창 — ＋ 와 ▥ 가 함께 쓴다.
    const menu = document.createElement('div');
    menu.className = 'tabpick hidden';
    tabsEl.appendChild(menu);
    let acts = [];
    const menuOpen = () => !menu.classList.contains('hidden');
    const closeMenu = () => menu.classList.add('hidden');
    function openMenu(items) {
      acts = items;
      menu.innerHTML = items.map((it, i) =>
        `<button type="button" data-menu="${i}" class="${it.cls || ''}">${esc(it.label)}</button>`).join('');
      menu.classList.remove('hidden');
    }

    /** ＋ — 접어 둔 탭 목록 */
    const hiddenMenu = () => {
      const items = state.hidden.map((id) => ({
        label: labelOf(id),
        run: () => {
          state.hidden = state.hidden.filter((x) => x !== id);
          save(); apply();
          // 꺼낸 탭을 바로 열어 준다 (단추는 자리만 되찾는다).
          const btn = tabs().find((b) => idOf(b) === id && b.dataset[tabAttr]);
          if (btn) activate(btn);
        },
      }));
      if (items.length > 1) {
        items.push({ label: '전부 꺼내기', cls: 'all', run: () => { state.hidden = []; save(); apply(); } });
      }
      return items;
    };

    /** ▥ — 같이 볼 탭 고르기 */
    const splitMenu = () => {
      const items = [];
      const mainId = activeId();
      for (const b of shownTabs()) {
        const id = idOf(b);
        if (id === mainId || id === state.split) continue;
        items.push({
          label: `${labelOf(id)} 같이 보기`,
          run: () => { state.split = id; save(); paintPanels(); },
        });
      }
      if (state.split) {
        items.push({
          label: dirNow() === 'row' ? '⇅ 위아래로 놓기' : '⇄ 좌우로 놓기', cls: 'all',
          run: () => { state.dir = dirNow() === 'row' ? 'col' : 'row'; save(); paintPanels(); },
        });
        items.push({
          label: '✕ 한 화면으로 되돌리기', cls: 'all',
          run: () => { state.split = null; save(); paintPanels(); },
        });
      }
      if (items.length === 0) items.push({ label: '같이 볼 탭이 없습니다', cls: 'all', run: () => { } });
      return items;
    };

    function apply() {
      // 저장해 둔 순서대로 다시 늘어놓는다 (새로 생긴 탭은 뒤에 남는다).
      for (const id of state.order) {
        const btn = tabs().find((b) => idOf(b) === id);
        if (btn) tabsEl.insertBefore(btn, more);
      }
      for (const btn of tabs()) {
        const id = idOf(btn);
        const off = state.hidden.includes(id);
        btn.classList.toggle('hidden', off);
        if (off && btn.classList.contains('on')) {
          btn.classList.remove('on');
          const first = shownTabs()[0];
          if (first) activate(first);
        }
        // 닫기 단추는 한 번만 붙인다
        if (!btn.querySelector('.tabx') && !keep.includes(id)) {
          const x = document.createElement('span');
          x.className = 'tabx';
          x.title = '이 탭 접어두기';
          x.textContent = '✕';
          btn.appendChild(x);
        }
        btn.draggable = !off;
      }
      // 접어 둔 탭은 옆에 붙여 둘 수 없다 (다시 꺼냈을 때 혼자 되살아나지 않게 지운다).
      if (state.split && state.hidden.includes(state.split)) { state.split = null; save(); }

      more.classList.toggle('hidden', state.hidden.length === 0);
      more.textContent = `＋${state.hidden.length}`;
      splitBtn.classList.toggle('hidden', shownTabs().length < 2);
      splitBtn.classList.toggle('on', !!state.split);
      closeMenu();
      // 마지막 하나는 닫을 수 없게 (아무 탭도 없으면 화면이 비어 버린다)
      tabsEl.classList.toggle('one-left', shownTabs().length <= 1);
      paintPanels();
    }

    tabsEl.addEventListener('click', (e) => {
      const x = e.target.closest('.tabx');
      if (x) {
        e.stopPropagation();
        const btn = x.closest(`[data-${tabAttr}], [data-tabitem]`);
        const id = idOf(btn);
        // 화면을 여는 '진짜 탭'이 하나는 남아 있어야 한다.
        // 단추(내보내기·도움말)는 화면을 차지하지 않으므로 이 제한을 받지 않는다.
        if (btn.dataset[tabAttr] && shownTabs().length <= 1) {
          return toast('마지막 탭은 접을 수 없습니다', true);
        }
        state.hidden = [...new Set([...state.hidden, id])];
        save(); apply();
        return;
      }

      const pick = e.target.closest('[data-menu]');
      if (pick) {
        e.stopPropagation();
        const run = acts[Number(pick.dataset.menu)]?.run;
        closeMenu();
        run?.();
        return;
      }

      const opener = e.target.closest('.tabmore, .tabsplit');
      if (opener) {
        e.stopPropagation();
        const want = opener.classList.contains('tabmore') ? 'more' : 'split';
        if (menuOpen() && menu.dataset.from === want) return closeMenu();
        menu.dataset.from = want;
        openMenu(want === 'more' ? hiddenMenu() : splitMenu());
        return;
      }

      // 탭 고르기 — 화면 파일이 아니라 여기서 받는다 (분할 상태를 지켜야 한다).
      const tab = e.target.closest(`[data-${tabAttr}]`);
      if (tab) activate(tab);
    }, true);

    // 딴 데를 누르거나 Esc 를 치면 목록을 닫는다.
    document.addEventListener('click', (e) => {
      if (menuOpen() && !e.target.closest('.tabpick, .tabmore, .tabsplit')) closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

    // 경계선을 끌어 두 화면의 비율을 조절한다.
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const mainId = activeId(), sideId = state.split;
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = box.getBoundingClientRect();
        state.ratio = clamp(dirNow() === 'row'
          ? (ev.clientX - r.left) / r.width
          : (ev.clientY - r.top) / r.height);
        applyRatio(mainId, sideId);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        save();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });

    // 창 크기가 바뀌면 가로·세로가 저절로 뒤집힐 수 있다 (직접 정해 두지 않았을 때).
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (state.dir || !state.split) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(paintPanels, 120);
    });

    // 끌어서 순서 바꾸기
    let dragging = null;
    tabsEl.addEventListener('dragstart', (e) => {
      const btn = e.target.closest(`[data-${tabAttr}], [data-tabitem]`);
      if (!btn) return;
      dragging = btn;
      btn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', idOf(btn)); } catch { }
    });
    tabsEl.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest(`[data-${tabAttr}], [data-tabitem]`);
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      tabsEl.insertBefore(dragging, after ? over.nextSibling : over);
    });
    // 탭을 화면 위로 끌어다 놓으면 그 자리에 나눠 붙는다.
    // 어느 쪽에 놓느냐로 좌우·위아래와 앞뒤가 정해진다 (가운데에서 먼 쪽이 이긴다).
    const cue = document.createElement('div');
    cue.className = 'dropcue';
    box.appendChild(cue);

    const zoneAt = (e) => {
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      const row = Math.abs(dx) >= Math.abs(dy);
      return { dir: row ? 'row' : 'col', first: row ? dx < 0 : dy < 0 };
    };

    const showCue = (z) => {
      const half = z.dir === 'row'
        ? { left: z.first ? '0' : '50%', top: '0', width: '50%', height: '100%' }
        : { left: '0', top: z.first ? '0' : '50%', width: '100%', height: '50%' };
      Object.assign(cue.style, half);
      cue.classList.add('on');
    };
    const hideCue = () => cue.classList.remove('on');

    box.addEventListener('dragover', (e) => {
      if (!dragging?.dataset[tabAttr]) return;       // 단추(내보내기 등)는 나눌 화면이 없다
      const z = zoneAt(e);
      if (!z) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showCue(z);
    });
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget)) hideCue();
    });
    box.addEventListener('drop', (e) => {
      hideCue();
      if (!dragging?.dataset[tabAttr]) return;
      e.preventDefault();
      e.stopPropagation();
      const z = zoneAt(e);
      const id = idOf(dragging);
      const mainNow = activeId();
      // 끌어온 탭을 앞(왼쪽·위)에 둘지 뒤에 둘지
      const main = z.first ? id : (id === mainNow ? state.split : mainNow);
      const side = z.first ? (id === mainNow ? state.split : mainNow) : id;
      endDrag();
      if (main && side && main !== side) setLayout({ main, side, dir: z.dir });
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      state.order = tabs().map(idOf);
      save();
    };
    tabsEl.addEventListener('dragend', endDrag);
    tabsEl.addEventListener('drop', (e) => { e.preventDefault(); endDrag(); });

    // 패널을 상자에 담는다. 모듈 화면이 나중에 붙어도 저절로 따라 들어온다.
    const home = panels()[0]?.parentElement || null;
    if (home) {
      home.insertBefore(box, panels()[0]);
      const adopt = () => {
        let moved = false;
        for (const p of panels()) {
          if (p.parentElement === box || p.parentElement === slot) continue;   // 떼어낸 칸도 제자리다
          box.appendChild(p);
          moved = true;
        }
        if (moved) paintPanels();
      };
      adopt();
      new MutationObserver(adopt).observe(home, { childList: true });
    }

    apply();
    return { refresh: apply };
  }

  /** 이미지 붙여넣기(Ctrl+V). 클립보드의 파일을 그대로 넘겨준다. */
  function onPasteFiles(el, cb) {
    el.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean)
        .map((f) => {
          if (f.name && f.name !== 'image.png') return f;
          const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
          return new File([f], `\ubd99\uc5ec\ub123\uae30-${stamp}.${ext}`, { type: f.type });
        });
      if (files.length) { e.preventDefault(); cb(files); }
    });
  }

  /**
   * 알림음 선택 UI를 붙인다.
   * selectEl — 음색 목록, btnEl — 켜기/끄기, volumeEl — 크기(0~300%)
   */
  const CUSTOM_PICK = '__pick';

  function paintKitOptions(selectEl) {
    const opts = Sound.list.map((s) =>
      `<option value="${esc(s.id)}">${s.preset ? '\ud83d\udcc1 ' : ''}${esc(s.name)}</option>`);
    if (Sound.hasCustom()) {
      opts.push(`<option value="custom">${esc(Sound.customName || '내 소리')}</option>`);
    }
    opts.push(`<option value="${CUSTOM_PICK}">＋ 소리 파일 등록…</option>`);
    selectEl.innerHTML = opts.join('');
    selectEl.value = Sound.kit;
    if (!selectEl.value) selectEl.value = 'bell';
  }

  function mountSoundPicker(selectEl, btnEl, volumeEl) {
    if (selectEl) {
      selectEl.dataset.soundkit = '1';
      paintKitOptions(selectEl);
      Sound.loadCustom();

      // 파일 고르기용 입력은 화면에 두지 않고 만들어 쓴다.
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'audio/*';
      picker.style.display = 'none';
      document.body.appendChild(picker);

      picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.value = '';
        if (!file) { selectEl.value = Sound.kit; return; }
        try {
          await Sound.setCustomFile(file);
          paintKitOptions(selectEl);
          selectEl.value = 'custom';
          toast(`알림음을 "${file.name}"으로 바꿨습니다`);
          Sound.preview('custom');
        } catch (e) {
          toast(e.message, true);
          selectEl.value = Sound.kit;
        }
      });

      selectEl.addEventListener('change', () => {
        if (selectEl.value === CUSTOM_PICK) { picker.click(); return; }
        Sound.setKit(selectEl.value);
        Sound.preview(selectEl.value);   // 고른 소리를 바로 들려준다
      });
    }

    if (volumeEl) {
      const paintVol = () => {
        const pct = Math.round(Sound.volume * 100);
        volumeEl.title = `알림음 크기 ${pct}%` + (pct > 100 ? ' (증폭)' : '');
      };
      volumeEl.min = '0';
      volumeEl.max = '300';
      volumeEl.step = '10';
      volumeEl.value = String(Math.round(Sound.volume * 100));
      paintVol();
      let previewTimer = null;
      volumeEl.addEventListener('input', () => {
        Sound.setVolume(Number(volumeEl.value) / 100);
        paintVol();
        // 끌고 있는 동안 계속 울리지 않도록 잠깐 멈춘 뒤에 들려준다.
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => Sound.preview(Sound.kit), 250);
      });
    }

    if (btnEl) {
      const paint = () => { btnEl.textContent = Sound.enabled ? '🔔' : '🔕'; };
      paint();
      btnEl.addEventListener('click', () => {
        Sound.unlock();
        const on = Sound.toggle();
        paint();
        toast(on ? '알림음 켜짐' : '알림음 꺼짐');
        if (on) Sound.play('recv');
      });
    }
  }

  /**
   * 목록 안 항목을 끌어서 순서를 바꿀 수 있게 한다.
   * container 안에서 itemSel에 맞는 요소들이 대상이며, 놓을 때마다
   * onOrder(정렬된 data-id 배열)를 부른다.
   */
  function makeSortable(container, itemSel, onOrder) {
    let dragging = null;

    container.addEventListener('dragstart', (e) => {
      const item = e.target.closest(itemSel);
      if (!item || !container.contains(item)) return;
      dragging = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox는 데이터가 없으면 드래그를 시작하지 않는다.
      try { e.dataTransfer.setData('text/plain', item.dataset.id || ''); } catch { }
    });

    container.addEventListener('dragend', () => {
      if (dragging) dragging.classList.remove('dragging');
      dragging = null;
      [...container.children].forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    });

    container.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest(itemSel);
      [...container.querySelectorAll(itemSel)].forEach((c) => c.classList.remove('drop-before', 'drop-after'));
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      over.classList.add(after ? 'drop-after' : 'drop-before');
    });

    container.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest(itemSel);
      [...container.querySelectorAll(itemSel)].forEach((c) => c.classList.remove('drop-before', 'drop-after'));
      if (over && over !== dragging) {
        const rect = over.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        over.parentNode.insertBefore(dragging, after ? over.nextSibling : over);
      }
      const ids = [...container.querySelectorAll(itemSel)].map((c) => c.dataset.id).filter(Boolean);
      onOrder(ids);
    });
  }

  /**
   * 즐겨찾기. 이 브라우저에만 저장되고 다른 사람에게는 보이지 않는다.
   * 메시지가 지워질 수 있으므로 표시에 필요한 내용을 그때 함께 담아둔다.
   */
  function bookmarks(storeKey) {
    let items = [];
    try { items = JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch { items = []; }

    const save = () => {
      try { localStorage.setItem(storeKey, JSON.stringify(items)); } catch { }
    };

    return {
      list: () => items.slice().sort((a, b) => b.createdAt - a.createdAt),
      has: (id) => items.some((x) => x.id === id),
      count: () => items.length,
      toggle(msg, extra = {}) {
        const i = items.findIndex((x) => x.id === msg.id);
        if (i >= 0) { items.splice(i, 1); save(); return false; }
        items.push({
          id: msg.id,
          threadId: msg.threadId || null,
          senderName: msg.senderName || null,
          body: msg.body || null,
          file: msg.file || null,
          kind: msg.kind || 'text',
          createdAt: msg.createdAt,
          ...extra,
        });
        save();
        return true;
      },
      remove(id) {
        const i = items.findIndex((x) => x.id === id);
        if (i >= 0) { items.splice(i, 1); save(); }
      },
    };
  }

  /**
   * 대화창에 파일을 끌어다 놓으면 바로 보내게 한다.
   * zoneEl 위에 안내 덮개를 띄우고, 놓으면 onFiles(File[])를 부른다.
   * label()이 문자열을 돌려주면 그 문구를 보여주고, null이면 못 받는 상태로 막는다.
   */
  function makeDropzone(zoneEl, onFiles, label) {
    const veil = document.createElement('div');
    veil.className = 'dropveil';
    veil.innerHTML = '<div class="dropveil-box"><div class="dropveil-ico">📎</div>' +
                     '<div class="dropveil-msg"></div></div>';
    // 대화 목록은 innerHTML로 통째로 다시 그려지므로 덮개가 함께 지워진다.
    // 필요할 때마다 다시 붙인다.
    const attach = () => { if (!veil.isConnected) zoneEl.appendChild(veil); };
    attach();

    let depth = 0;                       // 자식 요소를 지날 때마다 이벤트가 겹쳐 들어온다
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

    const show = () => {
      attach();
      const msg = label ? label() : '여기에 놓으면 바로 보냅니다';
      veil.querySelector('.dropveil-msg').textContent = msg || '지금은 파일을 보낼 수 없습니다';
      veil.classList.toggle('blocked', !msg);
      veil.classList.add('on');
    };
    const hide = () => { depth = 0; veil.classList.remove('on'); };

    // 드롭존이 겹쳐 있으면 **안쪽이 이긴다.**
    // (카드 그림 자리에 놓은 파일이 바깥 대화창까지 올라가면 안 된다.)
    zoneEl.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth++;
      show();
    });
    zoneEl.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    zoneEl.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth--;
      if (depth <= 0) hide();
    });
    zoneEl.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
      // 폴더를 통째로 놓는 자리(AI 보조)는 두 번째 인자로 원본을 받아 하위 파일까지 훑는다.
      const files = [...(e.dataTransfer.files || [])];
      if (files.length || e.dataTransfer.items?.length) onFiles(files, e.dataTransfer);
    });
  }


  /**
   * 끌어다 놓은 것에서 **폴더 안쪽까지** 파일을 꺼낸다.
   * 돌려주는 줄마다 `{ file, path }` — path 는 놓은 폴더 안에서의 경로다.
   * 폴더를 지원하지 않는 브라우저에서는 놓인 파일만 그대로 돌려준다.
   */
  async function filesFromDrop(dt, { max = 500 } = {}) {
    const out = [];
    const items = [...(dt?.items || [])];
    const roots = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (!roots.length) {
      return [...(dt?.files || [])].map((file) => ({ file, path: file.name }));
    }

    const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
    const readAll = (reader) => new Promise((res, rej) => {
      const acc = [];
      const step = () => reader.readEntries((batch) => {
        if (!batch.length) return res(acc);
        acc.push(...batch);
        step();                                  // 한 번에 100개씩만 오므로 빌 때까지 부른다
      }, rej);
      step();
    });

    const walk = async (entry, prefix) => {
      if (out.length >= max) return;
      const here = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile) {
        try { out.push({ file: await fileOf(entry), path: here }); } catch { /* 못 읽는 것은 건너뛴다 */ }
        return;
      }
      if (!entry.isDirectory) return;
      const kids = await readAll(entry.createReader());
      for (const k of kids) await walk(k, here);
    };

    for (const r of roots) await walk(r, '');
    return out;
  }

  /**
   * 이름 색 고르개. 네모를 누르면 색판이 열리고, ✕ 로 색을 없앤다.
   * 색을 끄는 동안 계속 저장하지 않도록 잠깐 모았다 보낸다.
   *
   *  host  : 고르개를 담을 자리
   *  value : 지금 색 (#rrggbb 또는 빈 값)
   *  save  : 색이 정해지면 부른다 (빈 문자열이면 '색 없음')
   */
  function mountColorPick(host, { value, save }) {
    host.classList.add('colpick');
    host.innerHTML = '<input type="color" class="cp" title="이름 색">'
      + '<button class="ghost cpx" title="색 없애기">✕</button>';
    const input = host.querySelector('.cp');
    const paint = (v) => {
      input.value = v || '#8ab4f8';
      host.classList.toggle('none', !v);
    };
    paint(value);

    let timer = null;
    input.addEventListener('input', () => {
      host.classList.remove('none');
      clearTimeout(timer);
      timer = setTimeout(() => save(input.value), 250);
    });
    host.querySelector('.cpx').addEventListener('click', () => { paint(''); save(''); });
    return { set: paint };
  }

  // 창 밖으로 벗어난 파일을 브라우저가 열어버리지 않도록 막는다.
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    }));

  /**
   * 두 패널 사이에 끌 수 있는 경계선을 만든다.
   * panelEl의 너비를 저장하고, 버튼으로 접었다 펼 수 있게 한다.
   *
   *  side  : 'left'  — 경계선이 패널 오른쪽 (사이드바)
   *          'right' — 경계선이 패널 왼쪽 (자료함)
   *  key   : 저장 키
   *  toggleEl : 접기/펴기 버튼 (선택)
   */
  function makeResizable(panelEl, { side, key, min = 180, max = 620, toggleEl, onToggle } = {}) {
    const WKEY = `mm.w.${key}`;
    const CKEY = `mm.c.${key}`;
    // 최대 폭을 함수로 줄 수 있다 — 창 크기에 따라 달라져야 하는 패널이 있다
    // (TRPG 무대처럼 화면을 크게 쓰고 싶은 경우).
    const maxOf = () => (typeof max === 'function' ? max() : max);

    const applyWidth = (w) => {
      panelEl.style.width = w + 'px';
      panelEl.style.flex = `0 0 ${w}px`;
    };

    // 저장된 값이 있을 때만 인라인으로 덮어쓴다. 없으면 CSS 기본 폭을 그대로 둔다.
    let width = 0;
    try {
      const saved = Number(localStorage.getItem(WKEY));
      if (saved >= min && saved <= maxOf()) { width = saved; applyWidth(width); }
    } catch { }
    if (!width) width = Math.round(panelEl.getBoundingClientRect().width) || min;

    const setCollapsed = (on, remember = true) => {
      panelEl.classList.toggle('collapsed', on);
      if (toggleEl) {
        toggleEl.textContent = on
          ? (side === 'left' ? '▶' : '◀')
          : (side === 'left' ? '◀' : '▶');
        toggleEl.title = on ? '펼치기' : '접기';
      }
      if (remember) { try { localStorage.setItem(CKEY, on ? '1' : '0'); } catch { } }
      if (onToggle) onToggle(on);
    };

    let startCollapsed = false;
    try { startCollapsed = localStorage.getItem(CKEY) === '1'; } catch { }
    setCollapsed(startCollapsed, false);

    // ── 경계선 ──
    const bar = document.createElement('div');
    bar.className = 'resizer resizer-' + side;
    bar.title = '끌어서 너비 조절 (더블클릭하면 접기)';
    panelEl.appendChild(bar);

    let dragging = false;
    bar.addEventListener('mousedown', (e) => {
      if (panelEl.classList.contains('collapsed')) return;
      dragging = true;
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = panelEl.getBoundingClientRect();
      const w = side === 'left' ? e.clientX - rect.left : rect.right - e.clientX;
      width = Math.min(Math.max(Math.round(w), min), maxOf());
      applyWidth(width);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      try { localStorage.setItem(WKEY, String(width)); } catch { }
    });
    bar.addEventListener('dblclick', () => setCollapsed(!panelEl.classList.contains('collapsed')));

    if (toggleEl) {
      toggleEl.addEventListener('click', (e) => {
        e.preventDefault();
        setCollapsed(!panelEl.classList.contains('collapsed'));
      });
    }
    /** 밖에서 폭을 정한다 (저장까지). 모듈이 「넓게 보기」를 만들 때 쓴다. */
    const setWidth = (w) => {
      width = Math.min(Math.max(Math.round(w), min), maxOf());
      applyWidth(width);
      try { localStorage.setItem(WKEY, String(width)); } catch { }
      return width;
    };

    return {
      setCollapsed,
      setWidth,
      get width() { return width; },
      isCollapsed: () => panelEl.classList.contains('collapsed'),
    };
  }

  /**
   * 서버가 준 타이머 상태를 화면에 계속 그려준다.
   * 남은 시간은 endsAt으로 각자 계산하므로 초 단위 통신이 필요 없다.
   * 0에 닿으면 onDone()을 한 번만 부른다.
   */
  function mountTimer(el, { onDone, keepVisible = false } = {}) {
    let state = { exists: false };
    let firedFor = null;                 // 같은 타이머로 두 번 울리지 않게

    const fmt = (ms) => {
      const t = Math.max(0, Math.ceil(ms / 1000));
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
    };

    const left = () => (state.running ? state.endsAt - Date.now() : (state.remainingMs ?? 0));

    function paint() {
      // GM 화면은 타이머가 없어도 조작부가 보여야 하므로 숨기지 않는다.
      if (!state.exists) {
        el.classList.toggle('hidden', !keepVisible);
        el.classList.remove('running', 'over', 'warn');
        if (keepVisible) {
          el.querySelector('.tm-time').textContent = '--:--';
          el.querySelector('.tm-label').textContent = '시간을 정하고 시작을 누르세요';
        }
        return;
      }
      el.classList.remove('hidden');
      const ms = left();
      const over = ms <= 0;
      el.classList.toggle('running', !!state.running && !over);
      el.classList.toggle('over', over);
      el.classList.toggle('warn', !over && state.running && ms <= 30_000);
      el.querySelector('.tm-time').textContent = over ? '0:00' : fmt(ms);
      el.querySelector('.tm-label').textContent = state.label || '';

      if (over && state.running && firedFor !== state.endsAt) {
        firedFor = state.endsAt;
        onDone?.(state);
      }
    }

    setInterval(paint, 250);

    return {
      set(next) {
        state = next || { exists: false };
        if (!state.running) firedFor = null;
        paint();
      },
      get() { return state; },
    };
  }

  // ── 이미지 확대 보기 ──────────────────────────────────────────────────────
  let lightboxEl = null;
  function openLightbox(url, name) {
    if (!lightboxEl) {
      lightboxEl = document.createElement('div');
      lightboxEl.className = 'lightbox';
      lightboxEl.innerHTML =
        '<img alt=""><div class="lb-bar"><span class="lb-name"></span>' +
        '<a class="lb-dl" download target="_blank" rel="noopener">내려받기</a>' +
        '<button class="lb-close" title="닫기">✕</button></div>';
      document.body.appendChild(lightboxEl);
      // 사진 자체를 누른 게 아니면 닫는다.
      lightboxEl.addEventListener('click', (e) => {
        if (e.target.tagName !== 'IMG' || e.target.closest('.lb-bar')) closeLightbox();
      });
    }
    lightboxEl.querySelector('img').src = url;
    lightboxEl.querySelector('.lb-name').textContent = name || '';
    const dl = lightboxEl.querySelector('.lb-dl');
    dl.href = url + (url.includes('?') ? '&' : '?') + 'dl=1';
    lightboxEl.classList.add('open');
    document.addEventListener('keydown', escClose);
  }
  function closeLightbox() {
    if (lightboxEl) lightboxEl.classList.remove('open');
    document.removeEventListener('keydown', escClose);
  }
  const escClose = (e) => { if (e.key === 'Escape') closeLightbox(); };

  /** 말풍선 영역에 이미지 클릭 → 확대를 붙인다. */
  function enableLightbox(container) {
    container.addEventListener('click', (e) => {
      const img = e.target.closest('img[data-full]');
      if (!img) return;
      e.preventDefault();
      openLightbox(img.dataset.full, img.dataset.name || '');
    });
  }

  /**
   * 글자를 클립보드에 복사한다.
   *
   * navigator.clipboard 는 HTTPS(또는 localhost)에서만 쓸 수 있다.
   * NAS를 http://192.168.x.x 로 열면 그 API가 아예 없으므로,
   * 없을 때는 예전 방식(임시 입력칸 + execCommand)으로 대신한다.
   */
  async function copyText(text) {
    try {
      if (global.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 권한 거부 등 — 아래 방식으로 다시 해본다 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  /** 복사하고 결과를 알려준다. 실패하면 직접 긁어 복사하라고 안내한다. */
  async function copyAndTell(text, what = '복사했습니다') {
    const ok = await copyText(text);
    toast(ok ? what : '복사할 수 없습니다 — 주소를 직접 긁어서 복사해 주세요', !ok);
    return ok;
  }

  // ── 포맷 ──────────────────────────────────────────────────────────────────
  const two = (n) => String(n).padStart(2, '0');
  function timeOf(ts) {
    const d = new Date(ts);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  function dateTimeOf(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  function sizeOf(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function iconFor(mime) {
    if (mime === 'application/pdf') return '📕';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('audio/')) return '🎵';
    return '📄';
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 토스트 ────────────────────────────────────────────────────────────────
  let toastEl = null, toastTimer = null;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast' + (isError ? ' err' : ''); }, 2600);
  }

  // ── fetch 래퍼 ────────────────────────────────────────────────────────────
  async function api(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const opts = { method, headers: { ...headers } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }

  /** textarea 높이를 내용에 맞춘다 */
  function autoGrow(el, max = 160) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
  }

  /**
   * **링크를 만들 때 쓰는 주소.**
   *
   * 브라우저 주소창(`location.origin`)을 그대로 쓰면, GM 이 `localhost` 로 열어 둔 채 방을 만들었을 때
   * 플레이어에게 `localhost` 링크가 나간다 — 남의 컴퓨터에서는 열리지 않는 링크다.
   * 그래서 서버가 아는 공개 주소(터널 주소 등)를 먼저 쓴다. 모르면 주소창 그대로.
   */
  let publicOrigin = null;
  const origin = () => publicOrigin || location.origin;
  const setOrigin = (u) => { publicOrigin = u || null; };

  // 첫 화면·방 화면이 어차피 부르는 길이라 왕복이 늘지 않는다.
  api('/api/config').then((c) => setOrigin(c && c.publicUrl)).catch(() => { /* 모르면 주소창 그대로 */ });

  global.MM = { origin, setOrigin, Sound, Title, Desktop, alertIncoming, mountSoundPicker, Panels, mountTabs, reactionsHtml, mountReactions, markHtml, markList, onPasteFiles, makeSortable, makeDropzone, filesFromDrop, makeResizable, mountColorPick, bookmarks, mountTimer, copyText, copyAndTell, enableLightbox, openLightbox, timeOf, dateTimeOf, sizeOf, iconFor, esc, toast, api, autoGrow };
})(window);
