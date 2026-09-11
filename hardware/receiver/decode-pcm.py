# 音频解码为讯飞 ASR 需要的原始 PCM（16kHz / 单声道 / s16le）
# 依赖 PyAV（faster-whisper 自带，无需额外安装）。用法: python decode-pcm.py <输入音频> <输出.pcm>
#
# 实现说明（PyAV 18 实测坑）：
# - 逐帧 resample 每帧都引入滤波器填充，小帧（512 样本）下失真严重 → 必须先拼接成单帧再重采样
# - planes[0] 缓冲区有对齐填充，长度 > 实际样本 → 必须按 frame.samples 截断
# - 末尾 resample(None) flush 出剩余的少量样本
import sys

import av
import numpy as np


def main():
    if len(sys.argv) != 3:
        print("用法: python decode-pcm.py <输入音频 ogg/wav/mp3> <输出.pcm>")
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]

    with av.open(src) as container:
        frames = [f for f in container.decode(audio=0)]
    if not frames:
        print(f"错误: {src} 中没有音频流")
        sys.exit(1)

    # 拼接成单个大帧再一次性重采样（避免逐帧填充累积）
    arr = np.concatenate([f.to_ndarray() for f in frames], axis=1)
    first = frames[0]
    big = av.AudioFrame.from_ndarray(arr, format=first.format.name, layout=first.layout.name)
    big.sample_rate = first.sample_rate

    rs = av.AudioResampler(format="s16", layout="mono", rate=16000)
    out_frames = []
    for batch in (rs.resample(big), rs.resample(None)):
        for f in batch if isinstance(batch, list) else [batch]:
            if f is not None:
                out_frames.append(f)

    total = 0
    with open(dst, "wb") as out:
        for f in out_frames:
            b = bytes(f.planes[0])[: f.samples * 2]  # s16/mono，截掉缓冲区对齐填充
            out.write(b)
            total += len(b)
    print(f"解码完成: {total} 字节 PCM = {total / 32000:.1f}s (16k/mono/s16le)")


if __name__ == "__main__":
    main()
