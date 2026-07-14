"""
翻譯供應商抽象層 (Translation Provider Layer)
-------------------------------------------------
統一介面，讓前端可以自由切換：
  - "openai"：任何「OpenAI 相容」的服務 (OpenAI / Groq / DeepSeek / OpenRouter / Together / 本機 ...)
  - "gemini"：Google Gemini

前端只送 { provider, base_url, api_key, model, text, source, target }，
後端在這裡轉發給對應供應商，金鑰不會留在瀏覽器可被第三方讀取的地方 (由 Flask 代理，順便解 CORS)。
"""

import os
import json
import re
import base64
import requests

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"
# 多模態（圖片 / PDF）分析用模型：gemini-3.5-flash 為 GA 版，原生支援影像與 PDF
DEFAULT_VISION_MODEL = "gemini-3.5-flash"


def build_prompt(source: str, target: str):
    """產生翻譯用的 system 指令與使用者輸入包裝。"""
    if source and source.lower() == "auto":
        system = (
            "You are a professional real-time translation engine for a two-way conversation. "
            f"Detect the language of the input. If it is {target}, translate it into the other party's language; "
            f"otherwise translate it into {target}. "
            "Output ONLY the translated text — no explanations, no language labels, no quotation marks."
        )
    else:
        system = (
            f"You are a professional translation engine. Translate the text from {source} into {target}. "
            "Output ONLY the translated text — no explanations, no language labels, no quotation marks. "
            "Preserve the tone and meaning; make it sound natural to a native speaker."
        )
    return system


def translate_openai(base_url: str, api_key: str, model: str, system: str, text: str, timeout: int = 30) -> str:
    """呼叫 OpenAI 相容的 /chat/completions 端點。"""
    if not base_url:
        base_url = "https://api.openai.com/v1"
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # 注意：部分新模型（如 gpt-5.x）只支援預設 temperature，故不傳 temperature 參數
    payload = {
        "model": model or "gpt-5.5",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    }
    r = requests.post(url, headers=headers, json=payload, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"].strip()


def translate_gemini(api_key: str, model: str, system: str, text: str) -> str:
    """呼叫 Google Gemini 的 generate_content。"""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    resp = client.models.generate_content(
        model=model or DEFAULT_GEMINI_MODEL,
        contents=text,
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
        ),
    )
    return (resp.text or "").strip()


# =========================================================
# 多模態分析：拍照 / 上傳檔案 → 摘要 + 翻譯
# =========================================================

def _vision_system(target_name: str) -> str:
    """產生「摘要 + 翻譯」用的 system 指令，強制 JSON 輸出。"""
    return (
        "You are a visual & document translation assistant. "
        "The input may be a photo or file containing a menu, sign, form, article, or any text.\n"
        "Do the following:\n"
        "1. Read and understand all meaningful text and visual information in the input.\n"
        f"2. Write a concise, well-organized summary of the key points, written in {target_name}.\n"
        f"3. Provide a faithful, natural full translation of the text content into {target_name}.\n"
        'Respond with ONLY a JSON object of the exact shape '
        '{"summary": "...", "translation": "..."}. '
        "No markdown, no code fences, no extra commentary. "
        "If there is no readable text, explain that in the summary and use an empty string for translation."
    )


def _parse_json_result(raw: str) -> dict:
    """把 LLM 回傳解析成 {summary, translation}，容忍 code fence 或被截斷的 JSON。"""
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw).strip()
    try:
        obj = json.loads(raw)
        return {
            "summary": (obj.get("summary") or "").strip(),
            "translation": (obj.get("translation") or "").strip(),
        }
    except Exception:
        pass

    # 容忍截斷（超長文件可能超出輸出上限）：用正則救回 summary / translation 欄位
    def grab(key):
        m = re.search(r'"' + key + r'"\s*:\s*"((?:[^"\\]|\\.)*)', raw)
        if not m:
            return ""
        frag = m.group(1)
        try:
            return json.loads('"' + frag + '"')   # 還原 JSON 跳脫字元
        except Exception:
            return frag
    summary, translation = grab("summary"), grab("translation")
    if summary or translation:
        return {"summary": summary.strip(), "translation": translation.strip()}
    return {"summary": "", "translation": raw}


def _analyze_gemini(api_key: str, model: str, system: str,
                    text: str, file_bytes: bytes, mime_type: str) -> str:
    """Gemini 多模態：圖片 / PDF 原生讀取，回傳原始 JSON 字串。"""
    from google import genai
    from google.genai import types

    if model and not model.startswith("gemini"):
        model = ""   # 避免把 OpenAI 模型名誤送給 Gemini

    client = genai.Client(api_key=api_key)
    parts = []
    if file_bytes is not None:
        parts.append(types.Part.from_bytes(data=file_bytes, mime_type=mime_type or "application/octet-stream"))
    if text:
        parts.append(text)
    if not parts:
        return ""

    resp = client.models.generate_content(
        model=model or DEFAULT_VISION_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
            response_mime_type="application/json",
            max_output_tokens=8192,
            # 關閉 thinking：OCR/摘要/翻譯不需推理，且能避免思考 token 吃掉輸出額度導致 JSON 被截斷
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    return resp.text or ""


def _analyze_openai(base_url: str, api_key: str, model: str, system: str,
                    text: str, file_bytes: bytes, mime_type: str, timeout: int = 90) -> str:
    """OpenAI 相容多模態（vision）：圖片以 data URL 塞進 content，回傳原始 JSON 字串。"""
    if not base_url:
        base_url = "https://api.openai.com/v1"
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    content = []
    if text:
        content.append({"type": "text", "text": text})
    if file_bytes is not None:
        b64 = base64.b64encode(file_bytes).decode()
        data_url = f"data:{mime_type or 'image/jpeg'};base64,{b64}"
        content.append({"type": "image_url", "image_url": {"url": data_url}})
    if not content:
        content = [{"type": "text", "text": ""}]

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # 不傳 temperature / max_tokens：盡量相容各家 (OpenAI/Groq/DeepSeek/OpenRouter…)；截斷由解析器容錯
    payload = {
        "model": model or "gpt-5.5",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
    }
    r = requests.post(url, headers=headers, json=payload, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"] or ""


def analyze(provider: str, api_key: str, model: str, target_name: str,
            base_url: str = "", text: str = None,
            file_bytes: bytes = None, mime_type: str = None) -> dict:
    """
    多模態分析 → {summary, translation}，依 provider 走 Gemini 或 OpenAI 相容。
      - file_bytes + mime_type：圖片 (或 PDF，僅 Gemini 支援原生讀取)
      - text：純文字內容
    """
    system = _vision_system(target_name)
    provider = (provider or "gemini").lower()
    if provider == "openai":
        raw = _analyze_openai(base_url, api_key, model, system, text, file_bytes, mime_type)
    else:
        raw = _analyze_gemini(api_key, model, system, text, file_bytes, mime_type)
    return _parse_json_result(raw)


def generate(provider: str, api_key: str, model: str, base_url: str, system: str, user: str) -> str:
    """通用單輪生成（system + user → text），依 provider 分派。供旅遊問答等使用。"""
    provider = (provider or "gemini").lower()
    if provider == "openai":
        return translate_openai(base_url, api_key, model, system, user, timeout=45)
    if model and not model.startswith("gemini"):
        model = ""
    return translate_gemini(api_key, model, system, user)


def translate(data: dict) -> dict:
    """
    主入口。data 需含：
      provider: "openai" | "gemini"
      text:     要翻譯的文字
      source:   來源語言 (英文名，或 "auto")
      target:   目標語言 (英文名)
      base_url / api_key / model：供應商設定 (openai 必填 key；gemini 可用伺服器 .env 的 key 當後備)
    回傳 { ok, translation } 或 { ok:false, error }
    """
    provider = (data.get("provider") or "gemini").lower()
    text = (data.get("text") or "").strip()
    source = data.get("source") or "auto"
    target = data.get("target") or "English"

    if not text:
        return {"ok": False, "error": "empty text"}

    system = build_prompt(source, target)

    try:
        if provider == "openai":
            # 前端未給金鑰時，後備讀伺服器環境變數（讓「伺服器共用 OpenAI 金鑰」成立；有給就照舊）
            api_key = data.get("api_key") or os.getenv("OPENAI_API_KEY") or ""
            if not api_key:
                return {"ok": False, "error": "OpenAI 相容供應商需要 API Key"}
            out = translate_openai(
                base_url=data.get("base_url", "") or os.getenv("OPENAI_BASE_URL", ""),
                api_key=api_key,
                model=data.get("model", "") or os.getenv("OPENAI_MODEL", ""),
                system=system,
                text=text,
            )
        else:  # gemini
            api_key = data.get("api_key") or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
            if not api_key:
                return {"ok": False, "error": "找不到 Gemini API Key（.env 或設定皆無）"}
            out = translate_gemini(
                api_key=api_key,
                model=data.get("model", ""),
                system=system,
                text=text,
            )
        return {"ok": True, "translation": out, "provider": provider}
    except requests.HTTPError as e:
        body = ""
        try:
            body = e.response.text[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {e.response.status_code if e.response else '?'}: {body}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
