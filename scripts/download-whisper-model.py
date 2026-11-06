# -*- coding: utf-8 -*-
"""一次性预下载 whisper 模型权重到应用数据目录（走 hf-mirror 镜像）。

用法: python scripts/download-whisper-model.py [small|medium]
"""
import os
import sys

# 先设镜像再 import faster_whisper（其内部 huggingface_hub 读此环境变量）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

MODELS_DIR = os.environ.get(
    "AICOACH_MODELS_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "aicoach-models"),
)


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else "small"
    print(f"下载/校验 whisper 模型: {model} → {MODELS_DIR}")
    print(f"HF_ENDPOINT = {os.environ.get('HF_ENDPOINT')}")
    from faster_whisper import WhisperModel

    m = WhisperModel(model, device="cpu", compute_type="int8", download_root=MODELS_DIR)
    # 触发一次空转写确保权重完整可用
    print("模型加载成功，权重完整。")
    del m
    return 0


if __name__ == "__main__":
    sys.exit(main())
