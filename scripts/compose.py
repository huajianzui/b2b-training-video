"""
后期合成：旁白音轨 + 烧录字幕 + 合流

输入：output/raw.webm、output/session.json（场景在视频里的时刻）、output/tts/manifest.json
输出：output/subs.srt（软字幕，可单独交付）、output/demo-voiced.mp4

旁白按场景的 audioAt 摆放。录制时每个场景都等旁白念完才结束，所以句子之间不会重叠，
也不需要 atempo 加速。

两步走（见 voiceover.py 顶部的踩坑记录）：先单独渲染一条连续音轨，再与视频合流，
否则 ffmpeg 可能写出损坏的 edit list，播放器会跳过音轨。

用法：
    python compose.py [--bgm music.mp3] [--bgm-volume 0.1]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from subtitles import format_ms

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
# produce.js 通过环境变量传入解析好的路径；单独运行时用 PATH 上的 ffmpeg
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
SR = 24000
SUB_MAX_CHARS = 22
SUB_STYLE = ",".join([
    "FontName=Microsoft YaHei", "FontSize=13", "PrimaryColour=&H00FFFFFF",
    "BorderStyle=3", "OutlineColour=&H66000000", "Outline=6", "Shadow=0",
    "Alignment=2", "MarginV=22",
])


def ff(args, cwd=None):
    r = subprocess.run([str(FFMPEG), "-hide_banner", "-y"] + args, cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        tail = "\n".join((r.stdout or "").strip().splitlines()[-15:])
        sys.exit("ffmpeg 失败：\n" + tail)
    return r


# ---------------------------------------------------------------- 字幕

def split_sentences(text):
    """先按句末标点断句，过长的句子再按逗号顿号切，保证一行放得下"""
    parts = [p for p in re.split(r"(?<=[。！？；!?;])", text) if p.strip()]
    out = []
    for p in parts:
        p = p.strip()
        while len(p) > SUB_MAX_CHARS:
            cut = max((m.end() for m in re.finditer(r"[，、,：:]", p[:SUB_MAX_CHARS + 1])), default=SUB_MAX_CHARS)
            out.append(p[:cut])
            p = p[cut:].strip()
        if p:
            out.append(p)
    return [re.sub(r"[，。；,;]$", "", s) for s in out]


def ts(sec):
    return format_ms(int(round(sec * 1000)))


def build_srt(cues):
    """cues: [(起, 止, 文本)]，同一句旁白按字数比例分配时长"""
    lines = []
    n = 0
    for start, dur, text in cues:
        pieces = split_sentences(text)
        total = sum(len(p) for p in pieces) or 1
        t = start
        for p in pieces:
            d = dur * len(p) / total
            n += 1
            lines += [str(n), f"{ts(t)} --> {ts(t + d)}", p, ""]
            t += d
    return "\n".join(lines)


# ---------------------------------------------------------------- 音轨

def render_voice(cues, clips, video_dur, out_wav):
    inputs, chains, labels = [], [], []

    def add(src_args, label_prefix):
        idx = len(labels)
        inputs.extend(src_args)
        chains.append(f"[{idx}:a]aformat=sample_rates={SR}:channel_layouts=mono:sample_fmts=fltp[{label_prefix}{idx}]")
        labels.append(f"[{label_prefix}{idx}]")

    def silence(sec):
        add(["-f", "lavfi", "-t", f"{sec:.4f}", "-i", f"anullsrc=r={SR}:cl=mono"], "s")

    cursor = 0.0
    for (start, dur, _), clip in zip(cues, clips):
        gap = start - cursor
        if gap < -0.05:
            print(f"  ⚠ 旁白重叠 {-gap:.2f}s（录制节奏异常），顺延处理")
        if gap > 0.001:
            silence(gap)
        add(["-i", str(clip)], "a")
        cursor = max(cursor, start) + dur
    if video_dur - cursor > 0.001:
        silence(video_dur - cursor)

    graph = ";".join(chains) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    ff(inputs + ["-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", str(SR), "-ac", "1", str(out_wav)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bgm", default=None)
    ap.add_argument("--bgm-volume", type=float, default=0.10)
    args = ap.parse_args()

    script = json.loads((OUT / "script.json").read_text("utf-8"))
    session = json.loads((OUT / "session.json").read_text("utf-8"))
    manifest = json.loads((OUT / "tts" / "manifest.json").read_text("utf-8"))
    narr = {s["id"]: s["narration"] for s in script["scenes"]}
    video_dur = session["duration"]

    cues, clips = [], []
    for s in session["scenes"]:
        if not narr.get(s["id"]):
            continue
        m = manifest["scenes"][s["id"]]
        cues.append((s["audioAt"], m["dur"], narr[s["id"]]))
        clips.append(HERE / m["file"])
    print(f"正片 {video_dur:.1f}s，旁白 {len(cues)} 句")

    srt = OUT / "subs.srt"
    srt.write_text(build_srt(cues), "utf-8")
    print("字幕：" + str(srt.relative_to(HERE)))

    print("第一步：转码并烧录字幕...")
    silent = OUT / "demo-silent.mp4"
    # subtitles 滤镜里的 Windows 盘符路径很难转义，切到 output 目录用相对路径
    vf = f"subtitles=subs.srt:fontsdir=../assets:force_style='{SUB_STYLE}'"
    ff(["-i", "raw.webm", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", silent.name], cwd=str(OUT))

    print("第二步：渲染旁白音轨...")
    voice = OUT / "voice.wav"
    render_voice(cues, clips, video_dur, voice)

    print("第三步：合流...")
    out = OUT / "demo-voiced.mp4"
    a = ["-i", str(silent), "-i", str(voice)]
    if args.bgm:
        a += ["-i", args.bgm, "-filter_complex",
              f"[2:a]volume={args.bgm_volume},aformat=sample_rates={SR}:channel_layouts=mono[b];"
              f"[1:a][b]amix=inputs=2:normalize=0:duration=first[aout]",
              "-map", "0:v", "-map", "[aout]"]
    else:
        a += ["-map", "0:v", "-map", "1:a"]
    ff(a + ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", str(SR), "-ac", "1",
            "-t", f"{video_dur:.3f}", "-movflags", "+faststart", str(out)])
    voice.unlink(missing_ok=True)

    print(f"[完成] {out.relative_to(HERE)}  ({out.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
