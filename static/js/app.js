/* =========================================================
   亮言 · 即時翻譯  —  前端主程式
   模式：單人 (逐句 STT / Gemini Live 即時) + 面對面 (上下對開翻轉)
   後端：/api/translate 代理 (Gemini / OpenAI 相容)
   ========================================================= */

// ---------- 語言清單 ----------
// name: 給 LLM 的目標語言描述；label: UI 顯示；bcp: STT/TTS 用的 BCP-47
const LANGS = [
    { id: 'zh-TW', name: 'Traditional Chinese (Taiwan)', label: 'CHT-台灣繁體', bcp: 'zh-TW' },
    { id: 'zh-HK', name: 'Traditional Chinese (Hong Kong)', label: 'CHT-香港繁中', bcp: 'zh-HK' },
    { id: 'zh-CN', name: 'Simplified Chinese', label: 'CHS-簡體中文', bcp: 'zh-CN' },
    { id: 'ja',    name: 'Japanese', label: 'Japanese-日本語', bcp: 'ja-JP' },
    { id: 'en',    name: 'English', label: 'English-美語(美)', bcp: 'en-US' },
    { id: 'ko',    name: 'Korean', label: 'Korean-한국어', bcp: 'ko-KR' },
    { id: 'th',    name: 'Thai', label: 'Thai-泰語', bcp: 'th-TH' },
    { id: 'tr',    name: 'Turkish', label: 'Turkish-土耳其語', bcp: 'tr-TR' },
    { id: 'my',    name: 'Burmese', label: 'Burmese-緬甸語', bcp: 'my-MM' },
    { id: 'vi',    name: 'Vietnamese', label: 'Vietnam-越南語', bcp: 'vi-VN' },
    { id: 'id',    name: 'Indonesian', label: 'Indonesia-印尼語', bcp: 'id-ID' },
    { id: 'ms',    name: 'Malay', label: 'Malay-馬來語', bcp: 'ms-MY' },
    { id: 'km',    name: 'Khmer', label: 'Khmer-高棉文', bcp: 'km-KH' },
    { id: 'fr',    name: 'French', label: 'French-法語', bcp: 'fr-FR' },
    { id: 'de',    name: 'German', label: 'German-德語', bcp: 'de-DE' },
    { id: 'es',    name: 'Spanish', label: 'Spanish-西班牙語', bcp: 'es-ES' },
    { id: 'it',    name: 'Italian', label: 'Italian-義大利語', bcp: 'it-IT' },
    { id: 'ru',    name: 'Russian', label: 'Russian-俄語', bcp: 'ru-RU' },
];
const byId = id => LANGS.find(l => l.id === id) || LANGS[0];

// ---------- 設定 ----------
const DEFAULT_CFG = {
    provider: 'gemini', baseurl: 'https://api.openai.com/v1', apikey: '', model: '',
    geminikey: '', tavilykey: '', owmkey: '',          // 集中管理的第三方金鑰（皆選填）
    rate: 1, autospeak: true,
    theme: 'purple',                                   // 背景風格主題（設定面板可換）
    s_langA: 'zh-TW', s_langB: 'en',
    f_langTop: 'en', f_langBottom: 'zh-TW',
    cur_from: 'JPY', cur_to: 'TWD', cur_amount: '1',   // 匯率換算：預設日圓→台幣
    wx_place: '',                                       // 天氣：上次查詢地點
};
function loadCfg() {
    try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('liang_cfg') || '{}') }; }
    catch { return { ...DEFAULT_CFG }; }
}
function saveCfg(c) { localStorage.setItem('liang_cfg', JSON.stringify(c)); }
let cfg = loadCfg();

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const statusDot = $('statusDot');

// ---------- Toast ----------
let toastTimer;
function toast(msg, isError = true) {
    const t = $('toast');
    t.textContent = msg;
    t.style.background = isError ? 'var(--danger)' : 'var(--ok)';
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- 供應商設定（拍照/檔案與文字翻譯共用邏輯）----------
// Gemini 一律用伺服器內建金鑰；OpenAI 相容才送使用者金鑰/網址
function providerBody() {
    const isOpenai = cfg.provider === 'openai';
    let model = cfg.model || '';
    if (!isOpenai && model && !model.startsWith('gemini')) model = '';   // 避免模型名跨供應商誤送
    return {
        provider: cfg.provider,
        base_url: isOpenai ? cfg.baseurl : '',
        // OpenAI 用 OpenAI 金鑰；Gemini 用「選填的 Gemini 覆蓋金鑰」（留空後端自動用伺服器內建）
        api_key: isOpenai ? cfg.apikey : (cfg.geminikey || ''),
        model,
    };
}

// ---------- 翻譯 API ----------
async function translate(text, sourceLangId, targetLangId) {
    const src = byId(sourceLangId), tgt = byId(targetLangId);
    // 只在 OpenAI 相容時送使用者金鑰/網址；Gemini 一律用伺服器內建金鑰
    const isOpenai = cfg.provider === 'openai';
    let model = cfg.model || '';
    // 避免把 OpenAI 模型名誤送給 Gemini（反之亦然）
    if (!isOpenai && model && !model.startsWith('gemini')) model = '';
    const body = {
        provider: cfg.provider,
        text,
        source: src.name,
        target: tgt.name,
        base_url: isOpenai ? cfg.baseurl : '',
        api_key: isOpenai ? cfg.apikey : '',
        model: model,
    };
    const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '翻譯失敗');
    return data.translation;
}

// ---------- TTS ----------
const synth = window.speechSynthesis;
// 瀏覽器內建朗讀（依賴手機語音包）；onEnd 於念完或出錯時回呼
function browserSpeak(text, bcp, onEnd = null) {
    if (!synth || !text) { onEnd?.(); return; }
    try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = bcp;
        u.rate = parseFloat(cfg.rate) || 1;
        const voices = synth.getVoices();
        const prefix = bcp.split('-')[0];
        const v = voices.find(x => x.lang === bcp) || voices.find(x => x.lang.startsWith(prefix));
        if (v) u.voice = v;
        u.onend = () => onEnd?.();
        u.onerror = () => onEnd?.();
        synth.speak(u);
    } catch (e) { console.warn('TTS error', e); onEnd?.(); }
}
// 主朗讀：優先用雲端 Gemini TTS（任何語言都有聲音，免裝手機語音包），失敗才用瀏覽器
// force=true 無視自動朗讀設定（手動朗讀鈕）；onEnd 於播放結束回呼（供「停止」鈕重置狀態）
async function speak(text, bcp, force = false, onEnd = null) {
    if ((!cfg.autospeak && !force) || !text) { onEnd?.(); return; }
    // 先中斷前一句尚在播放或排隊的語音，確保只念最新這一句。
    // 否則雲端 TTS 會依 nextTime 一段段往後排，把之前累積的語音接連重播，聽起來像重複、延遲。
    stopAllAudio();
    try {
        const res = await fetch('/api/tts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, gemini_key: cfg.geminikey || '' })
        });
        if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf && buf.byteLength > 44) { onAllAudioEnd = onEnd; playLiveAudio(buf); return; }
        }
    } catch (e) { console.warn('雲端 TTS 失敗，改用瀏覽器', e); }
    browserSpeak(text, bcp, onEnd);   // 後備
}
// 在使用者點擊當下解鎖音訊（手機／iOS 要求音訊須由手勢啟動，否則靜音）
function ensureAudioUnlocked() {
    try {
        if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        if (playCtx.state === 'suspended') playCtx.resume();
    } catch (e) { /* ignore */ }
}
// 停止所有朗讀（雲端 Web Audio + 瀏覽器 TTS）
function stopAllAudio() {
    audioSources.forEach(s => { try { s.onended = null; s.stop(); } catch (e) {} });
    audioSources = [];
    nextTime = 0;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    const cb = onAllAudioEnd; onAllAudioEnd = null; cb?.();
}
if (synth) synth.onvoiceschanged = () => synth.getVoices();

// ---------- STT (Web Speech API) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function sttSupported() { return !!SR; }

// 手機（Android/Chrome）的國語辨識常回傳簡體字，即使 lang 設 zh-TW 也一樣。
// 這裡用 OpenCC 把辨識結果轉回繁體；OpenCC 未載入時原字輸出，不影響其他語言。
let _s2t = null, _s2tReady = false;
function toTraditional(text) {
    if (!text) return text;
    try {
        if (!_s2tReady) { _s2tReady = true; if (window.OpenCC) _s2t = window.OpenCC.Converter({ from: 'cn', to: 'tw' }); }
        return _s2t ? _s2t(text) : text;
    } catch (e) { return text; }
}
// 只有辨識語言為繁體中文時才需要轉換
function convForBcp(bcp, text) {
    return (bcp === 'zh-TW' || bcp === 'zh-HK') ? toTraditional(text) : text;
}

class Recognizer {
    constructor({ bcp, onInterim, onDone, onState }) {
        this.bcp = bcp; this.onInterim = onInterim; this.onDone = onDone; this.onState = onState;
        this.active = false; this.rec = null; this.buffer = '';
    }
    start() {
        if (!SR) { toast('此瀏覽器不支援語音辨識，請改用文字輸入'); return; }
        if (this.active) { this.stop(); return; }   // 再點一下 = 停止並翻譯
        this.buffer = '';                            // 開始新的一段，清空累積
        const rec = new SR();
        rec.lang = this.bcp;
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                // 已確定的句段累積起來，但先不翻譯；只有停止時才整段送出
                // 繁中辨識先轉回繁體，避免手機回傳簡體字
                if (r.isFinal) this.buffer += convForBcp(this.bcp, r[0].transcript);
                else interim += convForBcp(this.bcp, r[0].transcript);
            }
            // 即時顯示逐字稿（已確定 + 正在辨識），讓使用者看到自己講到哪
            const shown = (this.buffer + interim).trim();
            if (shown) this.onInterim?.(shown);
        };
        rec.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') toast('麥克風權限被拒絕，請允許後重試');
            else toast('語音辨識錯誤：' + e.error);
        };
        rec.onend = () => {
            if (this.active) { try { rec.start(); } catch {} }  // 自動續聽
            else this.onState?.(false);
        };
        this.rec = rec;
        this.active = true;
        try { rec.start(); this.onState?.(true); } catch (e) { toast('無法啟動麥克風'); this.active = false; }
    }
    stop() {
        this.active = false;
        if (this.rec) { try { this.rec.stop(); } catch {} }
        this.onState?.(false);
        const text = this.buffer.trim();   // 講完了，整段一次交出去翻譯
        this.buffer = '';
        if (text) this.onDone?.(text);
    }
}

// ---------- 歷史 ----------
function pushHistory(src, dst) {
    const h = JSON.parse(localStorage.getItem('liang_hist') || '[]');
    h.unshift({ src, dst, t: Date.now() });
    localStorage.setItem('liang_hist', JSON.stringify(h.slice(0, 100)));
}
function renderHistory() {
    const list = $('historyList');
    const h = JSON.parse(localStorage.getItem('liang_hist') || '[]');
    if (!h.length) { list.innerHTML = '<div class="history-empty">尚無紀錄</div>'; return; }
    list.innerHTML = h.map(x =>
        `<div class="history-item"><div class="src">${escapeHtml(x.src)}</div><div class="dst">${escapeHtml(x.dst)}</div></div>`
    ).join('');
}
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---------- 填充語言下拉 ----------
function fillSelect(sel, selectedId) {
    sel.innerHTML = LANGS.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
    sel.value = selectedId;
}
function initSelects() {
    fillSelect($('s_langA'), cfg.s_langA);
    fillSelect($('s_langB'), cfg.s_langB);
    fillSelect($('f_langTop'), cfg.f_langTop);
    fillSelect($('f_langBottom'), cfg.f_langBottom);
}

/* =========================================================
   單人模式
   ========================================================= */
const sResult = $('s_result');
function setResult(box, text, interim = false) {
    box.classList.add('active');
    box.innerHTML = interim
        ? `<span class="interim">${escapeHtml(text)}</span>`
        : escapeHtml(text);
}

// 文字翻譯
$('s_text').addEventListener('input', (e) => { $('s_count').textContent = `${e.target.value.length}/200`; });
$('s_send').addEventListener('click', async () => {
    const text = $('s_text').value.trim();
    if (!text) return;
    const a = $('s_langA').value, b = $('s_langB').value;
    try {
        setResult(sResult, '翻譯中…', true);
        const out = await translate(text, a, b);
        setResult(sResult, out);
        speak(out, byId(b).bcp);
        pushHistory(text, out);
    } catch (e) { toast(e.message); setResult(sResult, '（翻譯失敗）'); }
});

// 對調語言
$('s_swap').addEventListener('click', () => {
    const a = $('s_langA').value; $('s_langA').value = $('s_langB').value; $('s_langB').value = a;
    cfg.s_langA = $('s_langA').value; cfg.s_langB = $('s_langB').value; saveCfg(cfg);
});
$('s_langA').addEventListener('change', () => { cfg.s_langA = $('s_langA').value; saveCfg(cfg); });
$('s_langB').addEventListener('change', () => { cfg.s_langB = $('s_langB').value; saveCfg(cfg); });

// 單人麥克風：依引擎切換
function currentEngine() { return document.querySelector('input[name=engine]:checked').value; }

const sRecognizer = new Recognizer({
    bcp: byId(cfg.s_langA).bcp,
    onInterim: (t) => setResult(sResult, t, true),
    onDone: async (t) => {
        // 使用者按停後才會進來：麥克風已停，整段一次翻譯（朗讀也不會被辨識佔用）
        const a = $('s_langA').value, b = $('s_langB').value;
        try {
            setResult(sResult, '翻譯中…', true);
            const out = await translate(t, a, b);
            setResult(sResult, out);
            speak(out, byId(b).bcp);
            pushHistory(t, out);
        } catch (e) { toast(e.message); setResult(sResult, '（翻譯失敗）'); }
    },
    onState: (on) => toggleMic($('s_mic'), on),
});

function toggleMic(btn, on) {
    btn.classList.toggle('listening', on);
    const lbl = btn.querySelector('.mic-label');
    if (lbl) lbl.textContent = on ? '🎙️ 說話中…說完再點一下翻譯' : '點一下開始說話';
}

$('s_mic').addEventListener('click', () => {
    if (currentEngine() === 'live') { toggleLive(); return; }
    sRecognizer.bcp = byId($('s_langA').value).bcp;
    sRecognizer.start();
});

/* =========================================================
   Gemini Live 即時模式 (socket 串流)
   ========================================================= */
// socket.io 由 CDN 載入；若載入失敗，仍要保證「文字/逐句」功能可用
let socket = null;
try {
    if (typeof io === 'function') {
        socket = io({ transports: ['websocket', 'polling'] });
        socket.on('connect', () => statusDot.classList.add('connected'));
        socket.on('disconnect', () => { statusDot.classList.remove('connected'); if (liveOn) stopLive(); });
        socket.on('error', (d) => toast('伺服器：' + (d.msg || 'error')));
    } else {
        console.warn('socket.io 未載入，Gemini Live 即時模式停用');
    }
} catch (e) { console.warn('socket.io init 失敗', e); }

let liveOn = false, audioCtx, liveProcessor, liveInput, liveStream;
let livePending = '';
if (socket) {
    socket.on('text_response', (d) => { if (d.text) { livePending += d.text; setResult(sResult, livePending); } });
    socket.on('turn_complete', () => {
        // 即時模式由 Gemini 直接吐語音（audio_response 播放），不需再用瀏覽器 TTS，避免雙重朗讀
        if (livePending.trim()) pushHistory('(即時語音)', livePending.trim());
        livePending = '';
    });
    socket.on('audio_response', (data) => { playLiveAudio(data); });
}

// 播放 Gemini Live 原生語音 (24kHz PCM 16-bit)
let playCtx = null, nextTime = 0;
let audioSources = [];      // 進行中的 Web Audio 節點（供停止用）
let onAllAudioEnd = null;   // 全部播放結束時的回呼（供「停止」鈕重置狀態）
function playLiveAudio(data) {
    try {
        if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        if (playCtx.state === 'suspended') playCtx.resume();   // 手機須解鎖後才有聲音
        const int16 = new Int16Array(data);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        const buf = playCtx.createBuffer(1, f32.length, 24000);
        buf.getChannelData(0).set(f32);
        const src = playCtx.createBufferSource();
        src.buffer = buf; src.connect(playCtx.destination);
        const now = playCtx.currentTime;
        if (nextTime < now) nextTime = now;
        src.start(nextTime); nextTime += buf.duration;
        audioSources.push(src);
        src.onended = () => {
            audioSources = audioSources.filter(s => s !== src);
            if (audioSources.length === 0) { const cb = onAllAudioEnd; onAllAudioEnd = null; cb?.(); }
        };
    } catch (e) { console.warn('play audio error', e); }
}

async function toggleLive() { liveOn ? stopLive() : startLive(); }

async function startLive() {
    if (!socket) { toast('即時模式需要伺服器連線 (socket.io 未載入)'); return; }
    try {
        liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        liveInput = audioCtx.createMediaStreamSource(liveStream);
        liveProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
        liveInput.connect(liveProcessor);
        liveProcessor.connect(audioCtx.destination);
        const targetRate = 16000;
        liveProcessor.onaudioprocess = (e) => {
            if (!liveOn) return;
            const input = e.inputBuffer.getChannelData(0);
            const rate = audioCtx.sampleRate;
            const step = rate / targetRate;
            const len = Math.floor(input.length / step);
            const pcm = new Int16Array(len);
            for (let i = 0; i < len; i++) {
                let s = Math.max(-1, Math.min(1, input[Math.floor(i * step)] || 0));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            socket.emit('audio_in', pcm.buffer);
        };
        socket.emit('start_session', {
            langA: byId($('s_langA').value).name, langB: byId($('s_langB').value).name,
            gemini_key: cfg.geminikey || '',
        });
        liveOn = true; toggleMic($('s_mic'), true);
        setResult(sResult, '即時聆聽中…', true);
    } catch (e) { toast('無法啟動麥克風：' + e.name); }
}
function stopLive() {
    liveOn = false; toggleMic($('s_mic'), false);
    if (liveProcessor) { liveProcessor.disconnect(); liveProcessor = null; }
    if (liveInput) { liveInput.disconnect(); liveInput = null; }
    if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
    if (socket) socket.emit('stop_session');
}

/* =========================================================
   面對面模式
   ========================================================= */
function makeFaceSide(langSelId, resultBoxId, micBtnId, getTargetId) {
    const box = $(resultBoxId), btn = $(micBtnId);
    const rec = new Recognizer({
        bcp: byId($(langSelId).value).bcp,
        onInterim: (t) => setResult(box, t, true),
        onDone: async (t) => {
            // 講完按停才會進來：麥克風已停，整段一次翻譯
            const src = $(langSelId).value, tgt = getTargetId();
            try {
                const out = await translate(t, src, tgt);
                // 顯示在「對面那一側」的框
                const otherBox = (resultBoxId === 'f_resultBottom') ? $('f_resultTop') : $('f_resultBottom');
                setResult(otherBox, out);
                speak(out, byId(tgt).bcp);
                pushHistory(t, out);
            } catch (e) { toast(e.message); }
        },
        onState: (on) => btn.classList.toggle('listening', on),
    });
    btn.addEventListener('click', () => { rec.bcp = byId($(langSelId).value).bcp; rec.start(); });
    return rec;
}
// 下方(你)講 bottom 語言 → 翻成 top 語言，顯示在 top(翻轉給對面看)
makeFaceSide('f_langBottom', 'f_resultBottom', 'f_micBottom', () => $('f_langTop').value);
// 上方(對面)講 top 語言 → 翻成 bottom 語言，顯示在 bottom
makeFaceSide('f_langTop', 'f_resultTop', 'f_micTop', () => $('f_langBottom').value);
$('f_langTop').addEventListener('change', () => { cfg.f_langTop = $('f_langTop').value; saveCfg(cfg); });
$('f_langBottom').addEventListener('change', () => { cfg.f_langBottom = $('f_langBottom').value; saveCfg(cfg); });

/* =========================================================
   模式切換
   ========================================================= */
let mode = 'single';
$('modeBtn').addEventListener('click', () => {
    if (liveOn) stopLive();
    mode = mode === 'single' ? 'face' : 'single';
    $('singleView').classList.toggle('hidden', mode !== 'single');
    $('faceView').classList.toggle('hidden', mode !== 'face');
    $('modeBtn').textContent = mode === 'single' ? '👤 單人' : '👥 面對面';
});

/* =========================================================
   設定 Modal
   ========================================================= */
// 套用背景風格：把主題名寫到 <body data-theme>，CSS 依此覆蓋配色變數
function applyTheme(t) { document.body.dataset.theme = t || 'purple'; }

function openSettings() {
    $('cfg_theme').value = cfg.theme || 'purple';
    $('cfg_provider').value = cfg.provider;
    $('cfg_baseurl').value = cfg.baseurl;
    $('cfg_apikey').value = cfg.apikey;
    $('cfg_model').value = cfg.model;
    $('cfg_geminikey').value = cfg.geminikey || '';
    $('cfg_tavilykey').value = cfg.tavilykey || '';
    $('cfg_owmkey').value = cfg.owmkey || '';
    $('cfg_rate').value = cfg.rate;
    $('cfg_autospeak').checked = cfg.autospeak;
    toggleOpenaiFields();
    $('settingsModal').classList.remove('hidden');
}
function toggleOpenaiFields() {
    $('openaiFields').style.display = $('cfg_provider').value === 'openai' ? 'block' : 'none';
}
$('cfg_provider').addEventListener('change', toggleOpenaiFields);
// 選了主題立刻預覽（尚未儲存）
$('cfg_theme').addEventListener('change', () => applyTheme($('cfg_theme').value));
$('settingsBtn').addEventListener('click', openSettings);
// 取消：還原成已儲存的主題（撤銷剛才的即時預覽）
$('cfg_cancel').addEventListener('click', () => { applyTheme(cfg.theme); $('settingsModal').classList.add('hidden'); });
$('cfg_save').addEventListener('click', () => {
    cfg.provider = $('cfg_provider').value;
    cfg.baseurl = $('cfg_baseurl').value.trim();
    cfg.apikey = $('cfg_apikey').value.trim();
    cfg.model = $('cfg_model').value.trim();
    cfg.geminikey = $('cfg_geminikey').value.trim();
    cfg.tavilykey = $('cfg_tavilykey').value.trim();
    cfg.owmkey = $('cfg_owmkey').value.trim();
    cfg.rate = $('cfg_rate').value;
    cfg.autospeak = $('cfg_autospeak').checked;
    cfg.theme = $('cfg_theme').value;
    applyTheme(cfg.theme);
    saveCfg(cfg);
    $('settingsModal').classList.add('hidden');
    toast('已儲存設定', false);
});

/* =========================================================
   歷史 Modal
   ========================================================= */
$('historyBtn').addEventListener('click', () => { renderHistory(); $('historyModal').classList.remove('hidden'); });
$('hist_close').addEventListener('click', () => $('historyModal').classList.add('hidden'));
$('hist_clear').addEventListener('click', () => { localStorage.removeItem('liang_hist'); renderHistory(); });

/* =========================================================
   拍照翻譯 / 上傳檔案翻譯 (摘要 + 翻譯)
   後端一律走 Gemini 雲端多模態，忽略 OpenAI 設定
   ========================================================= */
const visionModal = $('visionModal');
let lastVisionText = '';   // 供「朗讀」按鈕使用

// 相機影像 client 端縮圖：省流量、加速雲端辨識（Gemini 最佳邊長約 1568px）
function fileToDownscaledDataURL(file, maxDim = 1568, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片讀取失敗')); };
        img.src = url;
    });
}
function dataURLToBlob(dataURL) {
    const [head, b64] = dataURL.split(',');
    const mime = (head.match(/data:(.*?);/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function openVision(title) {
    stopAllAudio(); setVisionSpeakBtn(false);   // 開新的一張前，先停掉上一段朗讀
    $('visionTitle').textContent = title;
    $('visionResult').classList.add('hidden');
    $('visionSummary').textContent = '';
    $('visionTranslation').textContent = '';
    $('visionStatus').textContent = '';
    const prev = $('visionPreview'); prev.classList.add('hidden'); prev.innerHTML = '';
    lastVisionText = '';
    visionModal.classList.remove('hidden');
}
function renderVision(result) {
    $('visionStatus').textContent = result.note ? ('ℹ️ ' + result.note) : '';
    const summary = (result.summary || '').trim();
    const translation = (result.translation || '').trim();
    $('visionSummary').textContent = summary || '（無摘要）';
    $('visionTranslation').textContent = translation || '（無可翻譯文字）';
    $('visionResult').classList.remove('hidden');
    lastVisionText = translation || summary;
    if (translation || summary) {
        pushHistory('（拍照／檔案）', (summary ? summary + '\n' : '') + translation);
    }
}

// --- 相機拍照 ---
$('s_camera').addEventListener('click', () => $('cameraInput').click());
$('cameraInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                         // 允許再次拍同一來源
    if (!file) return;
    openVision('📷 拍照翻譯');
    try {
        $('visionStatus').textContent = '影像處理中…';
        const dataURL = await fileToDownscaledDataURL(file);
        $('visionPreview').innerHTML = `<img src="${dataURL}" alt="preview">`;
        $('visionPreview').classList.remove('hidden');
        $('visionStatus').textContent = '雲端辨識與翻譯中…（約數秒）';
        const target = byId($('vision_target').value).name;
        const res = await fetch('/api/vision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataURL, target, ...providerBody() }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '辨識失敗');
        renderVision(data);
    } catch (err) { $('visionStatus').textContent = '❌ ' + err.message; toast(err.message); }
});

// --- 上傳檔案（圖片 / PDF / 文字檔）---
$('s_file').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    openVision('📎 檔案翻譯');
    try {
        const fd = new FormData();
        fd.append('target', byId($('vision_target').value).name);
        const pb = providerBody();
        Object.keys(pb).forEach(k => fd.append(k, pb[k]));
        if (file.type.startsWith('image/')) {
            // 圖片先縮圖再上傳，並顯示預覽
            const dataURL = await fileToDownscaledDataURL(file);
            $('visionPreview').innerHTML = `<img src="${dataURL}" alt="preview">`;
            $('visionPreview').classList.remove('hidden');
            fd.append('file', dataURLToBlob(dataURL), 'upload.jpg');
        } else {
            $('visionPreview').innerHTML = `<div class="file-chip">📄 ${escapeHtml(file.name)}</div>`;
            $('visionPreview').classList.remove('hidden');
            fd.append('file', file);
        }
        $('visionStatus').textContent = '上傳與翻譯中…（檔案越大越久）';
        const res = await fetch('/api/file', { method: 'POST', body: fd });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '翻譯失敗');
        renderVision(data);
    } catch (err) { $('visionStatus').textContent = '❌ ' + err.message; toast(err.message); }
});

// 朗讀鈕：可切換 —— 沒在念就開始念，念的過程中變「⏹ 停止」，可隨時中斷
let visionSpeaking = false;
function setVisionSpeakBtn(on) {
    visionSpeaking = on;
    $('vision_speak').textContent = on ? '⏹ 停止' : '🔊 朗讀';
}
$('vision_speak').addEventListener('click', () => {
    if (visionSpeaking) { stopAllAudio(); return; }   // 念到一半按 = 停止
    if (!lastVisionText) { toast('沒有可朗讀的內容'); return; }
    ensureAudioUnlocked();                              // 手機須在點擊當下解鎖音訊
    setVisionSpeakBtn(true);
    // 手動朗讀，不受自動朗讀設定影響；播放結束（自然念完或被停止）時把鈕還原
    speak(lastVisionText, byId($('vision_target').value).bcp, true, () => setVisionSpeakBtn(false));
});
$('vision_close').addEventListener('click', () => {
    stopAllAudio();                                    // 關閉同時停掉雲端與瀏覽器語音
    setVisionSpeakBtn(false);
    visionModal.classList.add('hidden');
});

/* =========================================================
   匯率換算（免金鑰：後端代理 ER-API / Frankfurter）
   ========================================================= */
const CURRENCIES = [
    { code: 'TWD', label: 'TWD 台幣' },
    { code: 'USD', label: 'USD 美元' },
    { code: 'JPY', label: 'JPY 日圓' },
    { code: 'KRW', label: 'KRW 韓元' },
    { code: 'CNY', label: 'CNY 人民幣' },
    { code: 'HKD', label: 'HKD 港幣' },
    { code: 'EUR', label: 'EUR 歐元' },
    { code: 'GBP', label: 'GBP 英鎊' },
    { code: 'THB', label: 'THB 泰銖' },
    { code: 'SGD', label: 'SGD 新加坡幣' },
    { code: 'MYR', label: 'MYR 馬來幣' },
    { code: 'VND', label: 'VND 越南盾' },
    { code: 'IDR', label: 'IDR 印尼盾' },
    { code: 'PHP', label: 'PHP 披索' },
    { code: 'AUD', label: 'AUD 澳幣' },
    { code: 'CAD', label: 'CAD 加幣' },
];
function fillCur(sel, code) {
    sel.innerHTML = CURRENCIES.map(c => `<option value="${c.code}">${c.label}</option>`).join('');
    sel.value = code;
}
function fmtMoney(n) {
    if (!isFinite(n)) return '—';
    const dp = Math.abs(n) >= 100 ? 2 : 4;   // 大額 2 位、小額 4 位
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function persistCur() {
    cfg.cur_from = $('cur_from').value;
    cfg.cur_to = $('cur_to').value;
    cfg.cur_amount = $('cur_amount').value;
    saveCfg(cfg);
}
let curTimer = null;
async function doConvert() {
    const amount = parseFloat($('cur_amount').value);
    const from = $('cur_from').value, to = $('cur_to').value;
    if (!isFinite(amount)) { $('cur_result').textContent = '請輸入金額'; $('cur_rate').textContent = ''; return; }
    $('cur_result').textContent = '換算中…';
    try {
        const res = await fetch('/api/currency', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base: from, target: to, amount }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        $('cur_result').textContent = `${fmtMoney(amount)} ${from} = ${fmtMoney(d.result)} ${to}`;
        const when = (d.date || '').replace(' (UTC)', '').slice(0, 16);
        $('cur_rate').textContent = `1 ${from} ≈ ${fmtMoney(d.rate)} ${to}` + (when ? `　·　${when}` : '');
    } catch (e) { $('cur_result').textContent = '—'; toast(e.message); }
}
function scheduleConvert() { clearTimeout(curTimer); curTimer = setTimeout(doConvert, 350); }

$('s_currency').addEventListener('click', () => {
    fillCur($('cur_from'), cfg.cur_from);
    fillCur($('cur_to'), cfg.cur_to);
    $('cur_amount').value = cfg.cur_amount || '1';
    $('currencyModal').classList.remove('hidden');
    doConvert();
});
$('cur_swap').addEventListener('click', () => {
    const a = $('cur_from').value; $('cur_from').value = $('cur_to').value; $('cur_to').value = a;
    persistCur(); doConvert();
});
$('cur_from').addEventListener('change', () => { persistCur(); doConvert(); });
$('cur_to').addEventListener('change', () => { persistCur(); doConvert(); });
$('cur_amount').addEventListener('input', () => { persistCur(); scheduleConvert(); });
$('cur_convert').addEventListener('click', doConvert);
$('cur_close').addEventListener('click', () => $('currencyModal').classList.add('hidden'));

/* =========================================================
   天氣（Open-Meteo，免金鑰；填了 OWM 金鑰後端可改用 OpenWeatherMap）
   ========================================================= */
async function fetchWeather(payload) {
    $('wx_result').classList.add('hidden');
    $('wx_status').textContent = '查詢中…';
    try {
        const res = await fetch('/api/weather', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, owm_key: cfg.owmkey || '' }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        const rows = [
            `<div class="wx-place">${escapeHtml(d.place)}</div>`,
            `<div class="wx-temp">${Math.round(d.temp)}°C　${escapeHtml(d.desc)}</div>`,
            `<div class="wx-sub">體感 ${Math.round(d.feels)}°C · 濕度 ${d.humidity}%` +
                (d.hi != null ? ` · 高${Math.round(d.hi)}° 低${Math.round(d.lo)}°` : '') +
                (d.pop != null ? ` · 降雨 ${d.pop}%` : '') + `</div>`,
            `<div class="wx-advice">${escapeHtml(d.advice)}</div>`,
        ];
        $('wx_result').innerHTML = rows.join('');
        $('wx_result').classList.remove('hidden');
        $('wx_status').textContent = '';
    } catch (e) { $('wx_status').textContent = '❌ ' + e.message; }
}
$('s_weather').addEventListener('click', () => {
    $('wx_place').value = cfg.wx_place || '';
    $('wx_result').classList.add('hidden');
    $('wx_status').textContent = '';
    $('weatherModal').classList.remove('hidden');
    if (cfg.wx_place) fetchWeather({ place: cfg.wx_place });
});
$('wx_go').addEventListener('click', () => {
    const p = $('wx_place').value.trim();
    if (!p) { $('wx_status').textContent = '請輸入地點'; return; }
    cfg.wx_place = p; saveCfg(cfg);
    fetchWeather({ place: p });
});
$('wx_place').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wx_go').click(); });
$('wx_geo').addEventListener('click', () => {
    if (!navigator.geolocation) { $('wx_status').textContent = '此裝置不支援定位'; return; }
    $('wx_status').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
        (pos) => fetchWeather({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => { $('wx_status').textContent = '無法取得位置（請允許定位權限）'; }
    );
});
$('wx_close').addEventListener('click', () => $('weatherModal').classList.add('hidden'));

/* =========================================================
   旅遊助手問答（可選 Tavily 上網 + 設定的供應商）
   ========================================================= */
let lastAskText = '';
let askSpeaking = false;
function setAskSpeakBtn(on) { askSpeaking = on; $('ask_speak').textContent = on ? '⏹ 停止' : '🔊 朗讀'; }
async function doAsk() {
    const q = $('ask_q').value.trim();
    if (!q) { $('ask_status').textContent = '請輸入問題'; return; }
    $('ask_answer').classList.add('hidden');
    $('ask_sources').innerHTML = '';
    $('ask_status').textContent = (cfg.tavilykey ? '上網查詢並' : 'AI ') + '思考中…';
    try {
        const res = await fetch('/api/ask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: q,
                target: byId(cfg.s_langA).name,      // 用你的語言回答
                tavily_key: cfg.tavilykey || '',
                ...providerBody(),
            }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        $('ask_status').textContent = d.searched ? '🌐 已參考即時搜尋' : '';
        $('ask_answer').textContent = d.answer || '（無回覆）';
        $('ask_answer').classList.remove('hidden');
        lastAskText = d.answer || '';
        if (Array.isArray(d.sources) && d.sources.length) {
            $('ask_sources').innerHTML = '<div class="src-title">來源</div>' + d.sources.map(s =>
                `<a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a>`
            ).join('');
        }
        if (q && lastAskText) pushHistory('（助手）' + q, lastAskText);
    } catch (e) { $('ask_status').textContent = '❌ ' + e.message; toast(e.message); }
}
$('s_ask').addEventListener('click', () => {
    setAskSpeakBtn(false);
    $('askModal').classList.remove('hidden');
});
$('ask_go').addEventListener('click', doAsk);
$('ask_speak').addEventListener('click', () => {
    if (askSpeaking) { stopAllAudio(); return; }
    if (!lastAskText) { toast('沒有可朗讀的內容'); return; }
    ensureAudioUnlocked();
    setAskSpeakBtn(true);
    speak(lastAskText, byId(cfg.s_langA).bcp, true, () => setAskSpeakBtn(false));
});
$('ask_close').addEventListener('click', () => { stopAllAudio(); setAskSpeakBtn(false); $('askModal').classList.add('hidden'); });

/* =========================================================
   啟動
   ========================================================= */
applyTheme(cfg.theme);                          // 套用上次選的背景風格
fillSelect($('vision_target'), cfg.s_langA);   // 拍照/檔案：預設翻成你的語言
initSelects();
if (!sttSupported()) {
    console.warn('本瀏覽器不支援 Web Speech API，語音辨識不可用（可改用文字或 Gemini Live）');
}
// 註冊 Service Worker (PWA)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW 註冊失敗', e));
}
