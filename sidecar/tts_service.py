# -*- coding: utf-8 -*-
"""edge-tts 出题语音；按文本哈希缓存，命中不重调。"""
import hashlib
import os

import edge_tts


class SidecarError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _sapi_fallback(text: str, wav_path: str) -> str:
    """Windows System.Speech 离线合成兜底（Huihui 中文语音），返回 wav 路径。"""
    import base64
    import subprocess

    safe_text = text.replace("'@", "")
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {};"
        "$s.Rate = 2;"
        "$s.SetOutputToWaveFile('" + os.path.abspath(wav_path).replace("'", "") + "');"
        "$t = @'\n" + safe_text + "\n'@;"
        "$s.Speak($t); $s.Dispose()"
    )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    subprocess.run(
        ["powershell", "-NoProfile", "-EncodedCommand", encoded],
        check=True,
        timeout=90,
        capture_output=True,
    )
    return wav_path


def tts(params: dict) -> dict:
    text = (params.get("text") or "").strip()
    if not text:
        raise SidecarError("E_TTS_INVALID_TEXT", "TTS 文本为空")
    voice = params.get("voice") or "zh-CN-XiaoxiaoNeural"
    rate = params.get("rate") or "+8%"
    out_dir = params.get("out_dir") or "."
    os.makedirs(out_dir, exist_ok=True)

    digest = hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()[:16]
    path = os.path.join(out_dir, f"tts-{digest}.mp3")
    wav_path = os.path.join(out_dir, f"tts-{digest}-sapi.wav")

    if os.path.exists(path) and os.path.getsize(path) > 0:
        return {"audio_path": path, "cached": True}
    if os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
        return {"audio_path": wav_path, "cached": True, "fallback": "sapi"}

    import asyncio

    async def _gen():
        com = edge_tts.Communicate(text, voice, rate=rate)
        await com.save(path)

    try:
        asyncio.run(_gen())
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise RuntimeError("生成文件为空")
        return {"audio_path": path, "cached": False}
    except Exception as e:
        # 在线语音不可用 → 离线 SAPI 兜底（不阻塞面试流程）
        try:
            _sapi_fallback(text, wav_path)
            return {"audio_path": wav_path, "cached": False, "fallback": "sapi"}
        except Exception as e2:
            raise SidecarError(
                "E_TTS_NETWORK",
                f"edge-tts 失败: {str(e)[:150]}；本地语音兜底也失败: {str(e2)[:150]}。"
                "TTS 不可用不影响流程，界面将以文字题干继续。",
            )
