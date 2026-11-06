# -*- coding: utf-8 -*-
"""LLM 网关调用（OpenAI 兼容，DeepSeek 等）：JSON 结构化输出 + 一次重试。

网关配置由 Node 侧随请求传入（gateway.json 不由 python 读取）。
"""
import json

_client_cache = {}


class SidecarError(Exception):
    def __init__(self, code: str, message: str, detail=None):
        super().__init__(message)
        self.code = code
        self.detail = detail


def _get_client(gateway: dict):
    from openai import OpenAI

    key = (gateway.get("base_url"), gateway.get("api_key"), gateway.get("timeout_sec", 120))
    if key in _client_cache:
        return _client_cache[key]
    client = OpenAI(
        api_key=key[1],
        base_url=key[0],
        timeout=key[2],
        max_retries=0,
    )
    _client_cache[key] = client
    return client


def llm(params: dict) -> dict:
    gateway = params.get("gateway") or {}
    if not gateway.get("base_url") or not gateway.get("api_key"):
        raise SidecarError("E_LLM_NO_CONFIG",
                           "未配置网关。请在设置页填写 base_url 与 api_key。")
    system = params.get("system") or ""
    user = params.get("user") or ""
    json_mode = bool(params.get("json_mode", True))
    temperature = params.get("temperature", 0.3)
    # deepseek-flash 等推理模型的思考也消耗输出 token，必须留足余量
    max_tokens = params.get("max_tokens", 3200)

    client = _get_client(gateway)

    def _call() -> str:
        kwargs = dict(
            model=gateway.get("model") or "deepseek-chat",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
        )
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = client.chat.completions.create(**kwargs)
        except Exception as e:
            msg = str(e)
            if "timeout" in msg.lower() or "timed out" in msg.lower():
                raise SidecarError("E_LLM_TIMEOUT", f"网关超时: {msg[:300]}")
            raise SidecarError("E_LLM_HTTP", f"网关请求失败: {msg[:300]}")
        return resp.choices[0].message.content or ""

    raw = _call()
    parsed = None
    if json_mode:
        for attempt in range(2):  # 一次重试
            try:
                parsed = json.loads(raw)
                break
            except json.JSONDecodeError:
                if attempt == 0:
                    raw = _call()
                else:
                    raise SidecarError(
                        "E_LLM_BAD_JSON",
                        "模型两次返回均非合法 JSON",
                        detail=raw[:2000],
                    )

    return {"content": raw, "parsed": parsed}
