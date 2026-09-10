# BadgeCore 音频转写脚本（本地 whisper，数据不出机）
# 用法: python transcribe.py <audio文件> [模型大小]
import os, sys
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")  # 国内镜像

from faster_whisper import WhisperModel

audio = sys.argv[1] if len(sys.argv) > 1 else ""
if not audio or not os.path.exists(audio):
    print("用法: python transcribe.py <音频文件> [small|base]"); sys.exit(1)
size = sys.argv[2] if len(sys.argv) > 2 else "small"

print(f"加载模型 {size}（首次运行会下载模型）...", flush=True)
model = WhisperModel(size, device="cpu", compute_type="int8")
print("转写中...", flush=True)
segments, info = model.transcribe(audio, language="zh", vad_filter=True,
                                  vad_parameters={"min_silence_duration_ms": 300})
print(f"\n===== 转写结果（{info.duration:.1f}s 音频）=====")
for seg in segments:
    print(f"[{seg.start:5.1f} - {seg.end:5.1f}] {seg.text.strip()}")
