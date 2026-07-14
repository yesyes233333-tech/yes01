import os
import sys
import asyncio
import threading
import queue
import logging
import requests

# 確保本檔所在目錄在 import 路徑上 (環境可能啟用 PYTHONSAFEPATH)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv
from google import genai

import providers

# Load Env with override
load_dotenv(override=True)
# 有效金鑰解析：優先環境變數 GEMINI_API_KEY，其次 .env 的 GOOGLE_API_KEY
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if API_KEY:
    print(f"🔑 API Key loaded (starts with): {API_KEY[:6]}...")
else:
    print("❌ API Key NOT found! (set GEMINI_API_KEY or GOOGLE_API_KEY)")

# App Setup
app = Flask(__name__)
app.config['SECRET_KEY'] = 'gemini_secret!'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Gemini Live realtime 模型 (即時語音對話模式)
# gemini-3.5-live-translate-preview：3.5、專為即時翻譯設計，原生語音 AUDIO 輸出
# （若即時翻譯品質或行為異常，可回退 gemini-3.1-flash-live-preview）
LIVE_MODEL = "gemini-3.5-live-translate-preview"

# Session Storage: Key: sid, Value: GeminiSession
active_sessions = {}


class GeminiSession:
    """Gemini Live 即時語音串流 (招牌『即時模式』)。"""

    def __init__(self, sid, instructions, api_key=None):
        self.sid = sid
        self.instructions = instructions
        self.audio_in_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.thread = None
        self.client = genai.Client(api_key=(api_key or API_KEY), http_options={'api_version': 'v1alpha'})

    def start(self):
        self.thread = threading.Thread(target=self.run_loop)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def add_audio(self, audio_data):
        self.audio_in_queue.put(audio_data)

    def run_loop(self):
        asyncio.run(self.async_process())

    async def async_process(self):
        config = {
            "response_modalities": ["AUDIO"],           # 原生語音模型只支援 AUDIO
            "system_instruction": self.instructions,
            "output_audio_transcription": {},            # 同時取得字幕文字
        }
        try:
            async with self.client.aio.live.connect(model=LIVE_MODEL, config=config) as session:
                logger.info(f"Session {self.sid} connected to Gemini Live.")
                sender_task = asyncio.create_task(self.sender(session))
                receiver_task = asyncio.create_task(self.receiver(session))

                while not self.stop_event.is_set():
                    if receiver_task.done():
                        receiver_task = asyncio.create_task(self.receiver(session))
                    if sender_task.done() and not sender_task.cancelled():
                        exc = sender_task.exception() if not sender_task.cancelled() else None
                        if exc:
                            logger.error(f"Sender task died: {exc}")
                            sender_task = asyncio.create_task(self.sender(session))
                    await asyncio.sleep(0.1)

                sender_task.cancel()
                receiver_task.cancel()
        except Exception as e:
            logger.error(f"Gemini connection error: {e}")
            socketio.emit('error', {'msg': str(e)}, to=self.sid)

    async def sender(self, session):
        while True:
            try:
                if not self.audio_in_queue.empty():
                    chunk = self.audio_in_queue.get()
                    from google.genai.types import Blob
                    audio_blob = Blob(data=chunk, mime_type="audio/pcm")
                    await session.send_realtime_input(audio=audio_blob)
                else:
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Sender Error: {e}")
                await asyncio.sleep(0.1)

    async def receiver(self, session):
        try:
            async for response in session.receive():
                if self.stop_event.is_set():
                    break
                server_content = response.server_content
                if server_content is not None:
                    # 字幕（原生語音的逐字轉錄）
                    ot = getattr(server_content, 'output_transcription', None)
                    if ot is not None and getattr(ot, 'text', None):
                        socketio.emit('text_response', {'text': ot.text}, to=self.sid)
                    model_turn = server_content.model_turn
                    if model_turn is not None:
                        for part in model_turn.parts:
                            inline = getattr(part, 'inline_data', None)
                            if inline is not None and inline.data:
                                socketio.emit('audio_response', inline.data, to=self.sid)   # 24kHz PCM 語音
                            elif getattr(part, 'text', None):
                                socketio.emit('text_response', {'text': part.text}, to=self.sid)
                    if server_content.turn_complete:
                        socketio.emit('turn_complete', to=self.sid)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Receiver Error: {e}")
            socketio.emit('error', {'msg': str(e)}, to=self.sid)


# --- Flask Routes ---
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/health')
def health():
    return jsonify({
        "ok": True,
        "gemini_key": bool(API_KEY),
        "live_model": LIVE_MODEL,
    })


@app.route('/api/translate', methods=['POST'])
def api_translate():
    """通用翻譯端點：支援 OpenAI 相容 / Gemini。前端傳供應商設定，後端代理。"""
    data = request.get_json(force=True, silent=True) or {}
    result = providers.translate(data)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


# 上傳檔案翻譯：支援 圖片 / PDF / 純文字檔
MAX_FILE_BYTES = 15 * 1024 * 1024   # 15MB
IMAGE_EXTS = {'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif'}


def _provider_cfg(src):
    """從 request (json 或 form) 取出供應商設定；OpenAI 若前端未給，後備讀環境變數。"""
    provider = (src.get('provider') or 'gemini').lower()
    cfg = {
        'provider': provider,
        'base_url': src.get('base_url') or '',
        'api_key': src.get('api_key') or '',
        'model': src.get('model') or '',
    }
    if provider == 'openai':
        cfg['api_key'] = cfg['api_key'] or os.getenv('OPENAI_API_KEY', '')
        cfg['base_url'] = cfg['base_url'] or os.getenv('OPENAI_BASE_URL', '')
        cfg['model'] = cfg['model'] or os.getenv('OPENAI_MODEL', '')
    return cfg


def _run_analyze(pc, target, force_gemini=False, **kw):
    """
    依供應商設定執行 providers.analyze，統一處理金鑰解析與錯誤。
    force_gemini=True 時（例如 PDF）強制走伺服器 Gemini 金鑰。
    回傳 (result_dict, status_code)。
    """
    provider = pc['provider']
    note = None
    if force_gemini and provider != 'gemini':
        provider = 'gemini'
        note = 'PDF 不支援所選供應商，已自動改用 Gemini 雲端辨識'

    try:
        if provider == 'openai':
            if not pc['api_key']:
                return {"ok": False, "error": "OpenAI 相容供應商需要 API Key（請到設定填入）"}, 400
            result = providers.analyze('openai', pc['api_key'], pc['model'], target,
                                       base_url=pc['base_url'], **kw)
        else:  # gemini
            key = (pc['api_key'] if pc['provider'] == 'gemini' else '') or API_KEY
            if not key:
                return {"ok": False, "error": "找不到 Gemini API Key"}, 400
            model = pc['model'] if pc['provider'] == 'gemini' else ''
            result = providers.analyze('gemini', key, model, target, **kw)
    except requests.HTTPError as e:
        body = ''
        try:
            body = e.response.text[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {e.response.status_code if e.response else '?'}: {body}"}, 400
    except Exception as e:
        logger.error(f"analyze error: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}, 400

    out = {"ok": True, **result}
    if note:
        out["note"] = note
    return out, 200


@app.route('/api/vision', methods=['POST'])
def api_vision():
    """相機拍照 → 摘要 + 翻譯。前端傳 base64 影像（可含 dataURL 前綴）+ 供應商設定。"""
    import base64 as _b64
    data = request.get_json(force=True, silent=True) or {}
    image_b64 = data.get('image') or ''
    target = data.get('target') or 'Traditional Chinese (Taiwan)'
    if not image_b64:
        return jsonify({"ok": False, "error": "no image"}), 400

    mime = 'image/jpeg'
    if image_b64.startswith('data:'):
        try:
            header, image_b64 = image_b64.split(',', 1)
            mime = header.split(':', 1)[1].split(';', 1)[0] or mime
        except Exception:
            pass
    try:
        raw = _b64.b64decode(image_b64)
    except Exception:
        return jsonify({"ok": False, "error": "影像解碼失敗"}), 400

    pc = _provider_cfg(data)
    result, status = _run_analyze(pc, target, file_bytes=raw, mime_type=mime)
    return jsonify(result), status


@app.route('/api/file', methods=['POST'])
def api_file():
    """上傳檔案 → 摘要 + 翻譯。支援 image/* 、application/pdf 、text/plain。PDF 一律走 Gemini。"""
    f = request.files.get('file')
    target = request.form.get('target') or 'Traditional Chinese (Taiwan)'
    if not f:
        return jsonify({"ok": False, "error": "no file"}), 400

    filename = f.filename or 'upload'
    raw = f.read()
    if not raw:
        return jsonify({"ok": False, "error": "空白檔案"}), 400
    if len(raw) > MAX_FILE_BYTES:
        return jsonify({"ok": False, "error": "檔案過大（上限 15MB）"}), 400

    mime = (f.mimetype or '').lower()
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    pc = _provider_cfg(request.form)

    if mime == 'text/plain' or ext in ('txt', 'md', 'csv'):
        text = raw.decode('utf-8', errors='replace')
        result, status = _run_analyze(pc, target, text=text)
    elif mime == 'application/pdf' or ext == 'pdf':
        # PDF 只有 Gemini 能原生讀取 → 強制回退 Gemini
        result, status = _run_analyze(pc, target, force_gemini=True,
                                      file_bytes=raw, mime_type='application/pdf')
    elif mime.startswith('image/') or ext in IMAGE_EXTS:
        if not mime.startswith('image/'):
            mime = 'image/jpeg'
        result, status = _run_analyze(pc, target, file_bytes=raw, mime_type=mime)
    else:
        return jsonify({"ok": False, "error": f"不支援的檔案類型：{mime or ext or '未知'}"}), 400

    if isinstance(result, dict):
        result.setdefault("filename", filename)
    return jsonify(result), status


# 天氣：Open-Meteo（免金鑰）。地名→經緯度→即時天氣＋帶傘建議
WMO_CODES = {
    0: "晴天 ☀️", 1: "大致晴朗 🌤️", 2: "部分多雲 ⛅", 3: "陰天 ☁️",
    45: "有霧 🌫️", 48: "凍霧 🌫️",
    51: "毛毛雨 🌦️", 53: "毛毛雨 🌦️", 55: "毛毛雨 🌦️",
    56: "凍雨 🌧️", 57: "凍雨 🌧️",
    61: "小雨 🌧️", 63: "中雨 🌧️", 65: "大雨 🌧️",
    66: "凍雨 🌧️", 67: "凍雨 🌧️",
    71: "小雪 🌨️", 73: "中雪 🌨️", 75: "大雪 🌨️", 77: "雪珠 🌨️",
    80: "陣雨 🌦️", 81: "陣雨 🌧️", 82: "強陣雨 ⛈️",
    85: "陣雪 🌨️", 86: "強陣雪 🌨️",
    95: "雷陣雨 ⛈️", 96: "雷雨伴冰雹 ⛈️", 99: "強雷雨冰雹 ⛈️",
}


# 常見旅遊地點（中文名 → 座標＋顯示名）：保證熱門地點精準，避免地理編碼誤配
COMMON_PLACES = {
    "台北": (25.033, 121.565, "台北，台灣"), "臺北": (25.033, 121.565, "台北，台灣"),
    "台中": (24.147, 120.673, "台中，台灣"), "台南": (22.999, 120.227, "台南，台灣"),
    "高雄": (22.627, 120.301, "高雄，台灣"), "花蓮": (23.991, 121.601, "花蓮，台灣"),
    "台東": (22.758, 121.144, "台東，台灣"), "墾丁": (21.947, 120.798, "墾丁，台灣"),
    "東京": (35.690, 139.692, "東京，日本"), "大阪": (34.694, 135.502, "大阪，日本"),
    "京都": (35.011, 135.768, "京都，日本"), "名古屋": (35.182, 136.906, "名古屋，日本"),
    "福岡": (33.590, 130.402, "福岡，日本"), "札幌": (43.062, 141.354, "札幌，日本"),
    "北海道": (43.062, 141.354, "北海道，日本"), "沖繩": (26.212, 127.681, "沖繩，日本"),
    "那霸": (26.212, 127.681, "那霸，日本"), "首爾": (37.567, 126.978, "首爾，韓國"),
    "釜山": (35.180, 129.075, "釜山，韓國"), "曼谷": (13.756, 100.502, "曼谷，泰國"),
    "清邁": (18.788, 98.985, "清邁，泰國"), "普吉島": (7.880, 98.392, "普吉島，泰國"),
    "新加坡": (1.352, 103.820, "新加坡"), "香港": (22.320, 114.170, "香港"),
    "澳門": (22.199, 113.544, "澳門"), "吉隆坡": (3.139, 101.687, "吉隆坡，馬來西亞"),
    "峇里島": (-8.409, 115.189, "峇里島，印尼"), "峴港": (16.055, 108.202, "峴港，越南"),
    "胡志明市": (10.823, 106.630, "胡志明市，越南"), "河內": (21.028, 105.834, "河內，越南"),
    "上海": (31.230, 121.474, "上海，中國"), "北京": (39.904, 116.407, "北京，中國"),
}


def _geocode(place):
    """中文地名 → (lat, lon, 顯示名)。內建常見地點 → Nominatim → Open-Meteo。查無回 None。"""
    key = place.strip()
    if key in COMMON_PLACES:
        lat, lon, name = COMMON_PLACES[key]
        return lat, lon, name
    # Nominatim（OpenStreetMap，免金鑰，中文支援佳；須帶 User-Agent）
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": place, "format": "json", "limit": 1, "accept-language": "zh-TW"},
                         headers={"User-Agent": "liang-translator/1.0 (travel weather)"}, timeout=10)
        d = r.json()
        if d:
            item = d[0]
            disp = item.get("display_name", place).split(",")
            name = disp[0].strip() + (("，" + disp[-1].strip()) if len(disp) > 1 else "")
            return float(item["lat"]), float(item["lon"]), name
    except Exception as e:
        logger.warning(f"nominatim failed: {e}")
    # Open-Meteo 地理編碼（備援）
    try:
        g = requests.get("https://geocoding-api.open-meteo.com/v1/search",
                         params={"name": place, "count": 1, "language": "zh"}, timeout=8).json()
        results = g.get("results") or []
        if results:
            loc = results[0]
            name = loc.get("name", place) + (("，" + loc["country"]) if loc.get("country") else "")
            return loc["latitude"], loc["longitude"], name
    except Exception as e:
        logger.warning(f"open-meteo geocode failed: {e}")
    return None


def _weather_advice(code, temp, pop):
    tips = []
    rainy = code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99) or (pop is not None and pop >= 50)
    if rainy:
        tips.append("☂️ 建議帶傘")
    if temp is not None:
        if temp >= 30:
            tips.append("🧴 高溫，注意防曬補水")
        elif temp <= 12:
            tips.append("🧥 偏冷，記得保暖")
    if not tips:
        tips.append("👍 天氣舒適，玩得開心")
    return "，".join(tips)


@app.route('/api/weather', methods=['POST'])
def api_weather():
    data = request.get_json(force=True, silent=True) or {}
    place = (data.get('place') or '').strip()
    lat = data.get('lat')
    lon = data.get('lon')
    name = place or "目前位置"
    try:
        # 有地名先地理編碼；否則用前端傳來的經緯度（目前位置）
        if place:
            geo = _geocode(place)
            if not geo:
                return jsonify({"ok": False, "error": f"找不到地點「{place}」"}), 400
            lat, lon, name = geo
        if lat is None or lon is None:
            return jsonify({"ok": False, "error": "缺少地點或座標"}), 400

        # 選填：若有 OpenWeatherMap 金鑰就改用 OWM（否則走免金鑰 Open-Meteo）
        owm_key = (data.get('owm_key') or '').strip()
        if owm_key:
            o = requests.get("https://api.openweathermap.org/data/2.5/weather", params={
                "lat": lat, "lon": lon, "appid": owm_key, "units": "metric", "lang": "zh_tw",
            }, timeout=8).json()
            if str(o.get("cod")) == "200":
                main = o.get("main") or {}
                wid = ((o.get("weather") or [{}])[0]).get("id", 800)
                desc = ((o.get("weather") or [{}])[0]).get("description", "—")
                raining = wid < 700
                temp = main.get("temp")
                return jsonify({
                    "ok": True, "place": name, "temp": temp,
                    "feels": main.get("feels_like"), "humidity": main.get("humidity"),
                    "desc": desc, "pop": None,
                    "hi": main.get("temp_max"), "lo": main.get("temp_min"),
                    "advice": _weather_advice(61 if raining else 0, temp, None),
                    "source": "owm",
                })
            # OWM 失敗就繼續走 Open-Meteo

        w = requests.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,precipitation",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "timezone": "auto", "forecast_days": 1,
        }, timeout=8).json()
        cur = w.get("current") or {}
        daily = w.get("daily") or {}
        code = cur.get("weather_code")
        temp = cur.get("temperature_2m")
        pop = (daily.get("precipitation_probability_max") or [None])[0]
        hi = (daily.get("temperature_2m_max") or [None])[0]
        lo = (daily.get("temperature_2m_min") or [None])[0]
        return jsonify({
            "ok": True, "place": name,
            "temp": temp, "feels": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"),
            "desc": WMO_CODES.get(code, "—"),
            "pop": pop, "hi": hi, "lo": lo,
            "advice": _weather_advice(code, temp, pop),
        })
    except Exception as e:
        logger.error(f"weather error: {e}")
        return jsonify({"ok": False, "error": f"天氣查詢失敗：{type(e).__name__}"}), 400


# 匯率換算：免金鑰。主用 open.er-api.com（含 TWD 等多幣別），備援 frankfurter.app（歐洲央行）
@app.route('/api/currency', methods=['POST'])
def api_currency():
    data = request.get_json(force=True, silent=True) or {}
    base = (data.get('base') or 'USD').upper()
    target = (data.get('target') or 'TWD').upper()
    try:
        amount = float(data.get('amount', 1) or 1)
    except (TypeError, ValueError):
        amount = 1.0

    if base == target:
        return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                        "rate": 1.0, "result": amount, "date": "", "source": "same"})

    # 主：open.er-api.com（免金鑰，幣別多，含 TWD）
    try:
        r = requests.get(f"https://open.er-api.com/v6/latest/{base}", timeout=8)
        r.raise_for_status()
        d = r.json()
        rate = (d.get("rates") or {}).get(target)
        if rate:
            return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                            "rate": rate, "result": amount * rate,
                            "date": d.get("time_last_update_utc", ""), "source": "er-api"})
    except Exception as e:
        logger.warning(f"currency er-api failed: {e}")

    # 備援：frankfurter.app（歐洲央行，無 TWD 等部分亞幣）
    try:
        r = requests.get("https://api.frankfurter.app/latest",
                         params={"from": base, "to": target}, timeout=8)
        r.raise_for_status()
        d = r.json()
        rate = (d.get("rates") or {}).get(target)
        if rate:
            return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                            "rate": rate, "result": amount * rate,
                            "date": d.get("date", ""), "source": "frankfurter"})
    except Exception as e:
        logger.warning(f"currency frankfurter failed: {e}")

    return jsonify({"ok": False, "error": f"查不到 {base}→{target} 匯率（請確認幣別代碼）"}), 400


# 旅遊問答／助手：可選 Tavily 上網 + 走設定供應商的 LLM 回答
def _tavily_search(key, query, max_results=5):
    r = requests.post("https://api.tavily.com/search", json={
        "api_key": key, "query": query, "max_results": max_results,
        "include_answer": True, "search_depth": "basic",
    }, timeout=20)
    r.raise_for_status()
    return r.json()


@app.route('/api/ask', methods=['POST'])
def api_ask():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get('question') or '').strip()
    if not question:
        return jsonify({"ok": False, "error": "請輸入問題"}), 400
    target = data.get('target') or 'Traditional Chinese (Taiwan)'
    pc = _provider_cfg(data)
    tavily_key = (data.get('tavily_key') or os.getenv('TAVILY_API_KEY') or '').strip()

    # 1) 有 Tavily 金鑰才上網查；失敗或額度爆掉就略過，改用 AI 自身知識
    context, sources, searched, search_note = "", [], False, ""
    if tavily_key:
        try:
            d = _tavily_search(tavily_key, question)
            results = d.get("results") or []
            if d.get("answer"):
                context += f"Web summary: {d['answer']}\n"
            for it in results:
                context += f"- {it.get('title','')}: {it.get('content','')}\n"
                sources.append({"title": it.get("title", ""), "url": it.get("url", "")})
            searched = bool(results or d.get("answer"))
        except Exception as e:
            logger.warning(f"tavily failed: {e}")
            search_note = "（即時搜尋暫時無法使用，改用 AI 既有知識回答）"

    # 2) 交給 LLM 回答（走設定的供應商）
    system = (
        "You are a helpful, concise travel assistant. "
        f"Answer the user's question in {target}. "
        "If web search context is provided, prefer those up-to-date facts and be specific; "
        "otherwise answer from your own knowledge and flag uncertainty for time-sensitive details. "
        "Use short paragraphs or bullet points when helpful."
    )
    user = question if not context else f"Question: {question}\n\nWeb search context:\n{context}"
    try:
        if pc['provider'] == 'openai':
            if not pc['api_key']:
                return jsonify({"ok": False, "error": "OpenAI 相容供應商需要 API Key（請到設定填入）"}), 400
            answer = providers.generate('openai', pc['api_key'], pc['model'], pc['base_url'], system, user)
        else:
            key = pc['api_key'] or API_KEY
            if not key:
                return jsonify({"ok": False, "error": "找不到 Gemini API Key"}), 400
            answer = providers.generate('gemini', key, pc['model'], '', system, user)
    except requests.HTTPError as e:
        body = ''
        try:
            body = e.response.text[:300]
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"HTTP {e.response.status_code if e.response else '?'}: {body}"}), 400
    except Exception as e:
        logger.error(f"ask error: {e}")
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"}), 400

    return jsonify({"ok": True, "answer": (answer or "") + (("\n\n" + search_note) if search_note else ""),
                    "sources": sources, "searched": searched})


# 雲端 TTS：用 Gemini 原生語音朗讀「任何語言」，不依賴手機內建語音包
# 用帳號可用的最新 TTS 模型（2.5 preview 已偏舊，改用 3.1）
TTS_MODEL = "gemini-3.1-flash-tts-preview"


@app.route('/api/tts', methods=['POST'])
def api_tts():
    from flask import Response
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get('text') or '').strip()
    if not text:
        return ('', 204)
    key = (data.get('gemini_key') or '').strip() or API_KEY   # 選填覆蓋，留空用伺服器內建
    if not key:
        return jsonify({'error': 'no gemini key'}), 400

    from google.genai import types
    client = genai.Client(api_key=key)
    cfg = types.GenerateContentConfig(
        response_modalities=['AUDIO'],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name='Kore')
            )
        ),
    )
    # 預覽版 TTS 模型偶爾會「吐文字而非音訊」導致 400 → 重試最多 3 次
    last_err = 'unknown'
    for _attempt in range(3):
        try:
            resp = client.models.generate_content(model=TTS_MODEL, contents=text, config=cfg)
            for part in resp.candidates[0].content.parts:
                inline = getattr(part, 'inline_data', None)
                if inline is not None and inline.data:
                    return Response(inline.data, mimetype='application/octet-stream')  # 24kHz 16-bit PCM
            last_err = 'model returned text instead of audio'
        except Exception as e:
            last_err = str(e)
    logger.error(f"TTS failed after retries: {last_err}")
    return jsonify({'error': last_err}), 400


# PWA：manifest 與 service worker 需從根路徑提供
@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json', mimetype='application/manifest+json')


@app.route('/sw.js')
def service_worker():
    resp = send_from_directory('static', 'sw.js', mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp


# --- SocketIO Events (Gemini Live 即時模式) ---
@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].stop()
        del active_sessions[sid]
    logger.info(f"Client disconnected: {sid}")


@socketio.on('start_session')
def handle_start(data):
    sid = request.sid
    langA = data.get('langA', 'Chinese')
    langB = data.get('langB', 'English')
    user_key = (data.get('gemini_key') or '').strip() or None   # 選填覆蓋，留空用伺服器內建
    instruction = (
        f"You are a real-time voice translator. Your ONLY job is to translate speech.\n"
        f"- When you hear {langA}, translate it to {langB} and reply in {langB}.\n"
        f"- When you hear {langB}, translate it to {langA} and reply in {langA}.\n"
        f"Rules: Output ONLY the translation. No greeting or explanation. Speak naturally."
    )
    logger.info(f"Starting Live session: {langA} <-> {langB}")
    if sid in active_sessions:
        active_sessions[sid].stop()
    session = GeminiSession(sid, instruction, api_key=user_key)
    active_sessions[sid] = session
    session.start()
    emit('status', {'msg': 'Session Started'})


@socketio.on('stop_session')
def handle_stop():
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].stop()
        del active_sessions[sid]


@socketio.on('audio_in')
def handle_audio(data):
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].add_audio(data)


if __name__ == '__main__':
    if not API_KEY:
        print("⚠️  無 Gemini 金鑰：即時模式與 Gemini 翻譯將無法使用，但 OpenAI 相容供應商仍可用。")
    port = int(os.getenv('PORT', '5001'))          # 雲端平台會用 PORT 環境變數指定埠號
    debug = os.getenv('FLASK_DEBUG', '0') == '1'    # 公開部署預設關閉 debug
    print(f"🚀 Starting Flask Server on port {port} (debug={debug})")
    socketio.run(app, host='0.0.0.0', port=port, debug=debug, allow_unsafe_werkzeug=True)
