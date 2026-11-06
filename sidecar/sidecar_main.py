# -*- coding: utf-8 -*-
"""AI面试模拟舱 Python 边车：stdin/stdout 按行 JSON 协议。

请求:  {"id": "...", "cmd": "tts|asr|asr_preload|asr_unload|llm|ping|status|shutdown", "params": {...}}
成功:  {"id": "...", "ok": true, "result": {...}}
失败:  {"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}

纪律：stdout 只输出协议行；一切日志走 stderr。
"""
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from tts_service import tts  # noqa: E402
from asr_service import asr, asr_preload, asr_unload, asr_status  # noqa: E402
from llm_service import llm  # noqa: E402

_START_TS = time.time()
_out_lock = threading.Lock()
# tts/llm 并发池；asr 走专用单线程（模型互斥）
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sidecar")
_asr_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")


def log(msg: str) -> None:
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


def write_response(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def dispatch(cmd: str, params: dict):
    """同步执行；由调用方决定跑在哪个线程池。"""
    if cmd == "ping":
        return {"version": "1.0.0", "uptime_s": round(time.time() - _START_TS, 1)}
    if cmd == "status":
        st = asr_status()
        return st
    if cmd == "tts":
        return tts(params)
    if cmd == "asr":
        return asr(params)
    if cmd == "asr_preload":
        return asr_preload(params)
    if cmd == "asr_unload":
        return asr_unload()
    if cmd == "llm":
        return llm(params)
    raise KeyError(cmd)


def handle_line(raw: str) -> None:
    raw = raw.strip()
    if not raw:
        return
    try:
        req = json.loads(raw)
        rid = req.get("id", "?")
        cmd = req.get("cmd", "")
        params = req.get("params") or {}
    except Exception as e:
        write_response({"id": "?", "ok": False,
                        "error": {"code": "E_INVALID_PARAMS", "message": f"请求解析失败: {e}"}})
        return

    if cmd == "shutdown":
        write_response({"id": rid, "ok": True, "result": {}})
        log("收到 shutdown，退出")
        # 主线程阻塞在 stdin 读，必须硬退出（stdout 已随 write_response 刷出）
        import os
        threading.Timer(0.2, os._exit, args=(0,)).start()
        return

    def run():
        try:
            result = dispatch(cmd, params)
            write_response({"id": rid, "ok": True, "result": result})
        except KeyError:
            write_response({"id": rid, "ok": False,
                            "error": {"code": "E_UNSUPPORTED_CMD", "message": f"未知命令 {cmd}"}})
        except Exception as e:  # 业务层抛出的已分类错误
            code = getattr(e, "code", None) or "E_INTERNAL"
            write_response({"id": rid, "ok": False,
                            "error": {"code": code, "message": str(e)}})
            log(f"cmd={cmd} 失败: {code}: {e}")

    # asr 族单线程串行；其余进并发池
    if cmd.startswith("asr"):
        _asr_pool.submit(run)
    else:
        _pool.submit(run)


def main() -> None:
    log("边车启动，等待命令…")
    for line in sys.stdin:
        handle_line(line)
    log("stdin 关闭，退出")
    sys.exit(0)


if __name__ == "__main__":
    main()
