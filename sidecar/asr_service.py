# -*- coding: utf-8 -*-
"""faster-whisper 本地转写：模型懒加载、常驻、专用单线程调用（由主循环保证）。"""
import os
import time

_model = None  # 常驻模型实例
_model_name = None
_loaded_s = None

# small+领域热词已纠正大部分专有名词错误（实测），且降频 CPU 下实时率仍 ~0.3；
# medium 更准但慢（正常频率约 2-3 分钟/段，降频下 8-10 分钟）——经设置页按需切换
DEFAULT_MODEL = os.environ.get("AICOACH_WHISPER_MODEL", "small")

# 领域热词：油气压裂行业专名，纠正同音字（识别时加权）。可按自己的目标单位自行增删。
# 注意：initial_prompt + hotwords 的总 token 数必须远小于 whisper 448 窗口，留足解码空间，
# 否则 ctranslate2 报 "The maximum decoding length must be > 0"。中文约 1.5 token/字，两段合计控制在 120 字内。
HOTWORDS_ZH = (
    "压裂施工 泵注程序 压裂指挥 支撑剂 裂缝导流能力 体积压裂 储层增产 "
    "石油与天然气工程 傅里叶神经算子 页岩油 煤层气 致密油气 玛湖 吉木萨尔 苏里格 "
    "长庆油田 克拉玛依 数值模拟 代理模型 停泵 泵压"
)


class SidecarError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _models_root() -> str:
    root = os.environ.get("AICOACH_MODELS_DIR", "")
    return root if root else os.path.join(os.path.expanduser("~"), ".cache", "aicoach-models")


def _load(model_name: str):
    global _model, _model_name, _loaded_s
    if _model is not None and _model_name == model_name:
        return _model
    t0 = time.time()
    # 模型已在本地缓存时强制离线：跳过 huggingface_hub 联网校验（代理环境下会慢重试挂死）
    cache_marker = os.path.join(_models_root(), f"models--Systran--faster-whisper-{model_name}")
    if os.path.isdir(cache_marker):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        from faster_whisper import WhisperModel

        _model = WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            download_root=_models_root(),
        )
    except Exception as e:
        raise SidecarError(
            "E_ASR_MODEL_LOAD",
            f"whisper 模型加载失败: {e}。"
            f"若为下载问题，先运行 scripts/download-whisper-model.py（走 hf-mirror 镜像）。",
        )
    _model_name = model_name
    _loaded_s = round(time.time() - t0, 1)
    return _model


def asr_preload(params: dict) -> dict:
    name = params.get("model") or DEFAULT_MODEL
    _load(name)
    return asr_status()


def asr_unload() -> dict:
    global _model, _model_name
    _model = None
    _model_name = None
    return {"loaded": False}


def asr_status() -> dict:
    return {
        "whisper_loaded": _model is not None,
        "whisper_model": _model_name,
        "load_s": _loaded_s,
    }


def asr(params: dict) -> dict:
    audio_path = params.get("audio_path") or ""
    if not audio_path or not os.path.exists(audio_path):
        raise SidecarError("E_AUDIO_NOT_FOUND", f"音频不存在: {audio_path}")

    language = params.get("language") or "zh"
    model_name = params.get("model") or DEFAULT_MODEL
    initial_prompt = params.get("initial_prompt")

    m = _load(model_name)

    prompt = initial_prompt
    hotwords = None
    beam = 5
    if language == "zh":
        prompt = prompt or "以下是中文普通话的油气行业面试回答，请正确转写专业名词。"
        hotwords = HOTWORDS_ZH

    t0 = time.time()
    try:
        kwargs = dict(
            language=language,
            initial_prompt=prompt,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 700},
            beam_size=beam,
        )
        if hotwords:
            kwargs["hotwords"] = hotwords
        segments_iter, info = m.transcribe(audio_path, **kwargs)
        segments = []
        for seg in segments_iter:
            segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2),
                             "text": seg.text.strip()})
        text = "".join(s["text"] for s in segments)
    except Exception as e:
        raise SidecarError("E_ASR_INFER", f"转写失败: {e}")

    duration_s = round(getattr(info, "duration", 0.0), 1)
    infer_s = round(time.time() - t0, 1)
    rtf = round(infer_s / duration_s, 2) if duration_s > 0 else None
    return {
        "text": text,
        "segments": segments,
        "duration_s": duration_s,
        "infer_s": infer_s,
        "rtf": rtf,
    }
