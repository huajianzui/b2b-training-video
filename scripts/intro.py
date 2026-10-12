"""
片头 / 片尾卡生成器 —— 合成开场白（标题卡 + AI 配音），并拼到正片前后

为什么不用录制的方式做片头：
    标题卡是「纯图形 + 精确时长」的场景，用 ffmpeg 滤镜直接合成，
    时长精确到帧、内容确定性输出；若用浏览器录制动画，又会引入录制起点
    与计时零点之间的 δ 偏移（正片踩过这个坑），且重跑一次结果可能不同。
    片头没有「真实界面」需要被拍摄，所以不需要录制。

最省事的用法（改文案不用碰代码）：
    1. 编辑 cards.json，填标题、副标题、开场白文字
    2. python intro.py --config cards.json --attach output/demo-voiced.mp4 \
           --out output/demo-final.mp4
    → 片头 + 正片 + 片尾一次拼好，最后自动校验容器元数据

只要片头卡：
    python intro.py --title "订单管理模块操作演示" --narration "本视频演示……"

只要片尾卡（配色与默认文案不同）：
    python intro.py --position outro --title "演示结束" \
        --narration "以上就是本次演示的全部内容。"

不带配音（纯静音卡）：
    python intro.py --title "……" --narration ""

参数说明：
    --title      主标题（自动按字数调整字号）
    --subtitle   副标题
    --footer     底部信息（如「共 18 步 · 约 33 秒」）
    --narration  开场白文字；传空字符串则不加配音
    --accent     主题色（品牌色），用于顶部条、分隔线、底部条
    --bg1/--bg2  背景渐变的两端颜色

拼接策略：
    默认重编码拼接，并在**接缝两侧**各加 0.6s 暗场过渡（第一段淡出到黑、
    后一段从黑淡入）。原因：正片开头是浏览器加载中的白屏，深色片头硬切过去
    会明显闪白；两侧都做才能同时覆盖「片头→正片」和「正片→片尾」两个方向。
    --transition cut 改为流复制拼接（无损、快，但接缝是硬切，无过渡）。
    无论哪种方式，产出后都会调用 tools/mp4info.js 校验容器元数据。
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# produce.js 会通过环境变量传入解析好的路径；单独运行时用 PATH 上的命令
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or ""
NODE_EXE = os.environ.get("NODE_EXE") or shutil.which("node") or ""


def usable(exe):
    return bool(exe) and Path(exe).exists()

FONT_BOLD = "assets/msyhbd.ttc"   # 微软雅黑 Bold，标题用
FONT_REG = "assets/msyh.ttc"      # 微软雅黑 Regular，正文用

SR = 24000        # 与正片一致：aac 24000Hz mono
FPS = 25          # 与正片一致
W, H = 1920, 1080
TIMESCALE = 12800  # 与 Playwright 录制产物一致，流复制拼接时时间基才对齐

TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")

DEFAULT_BG = ("0x0b1622", "0x17324f")
ACCENT_INTRO = "0x2f7fd0"
ACCENT_OUTRO = "0x4a7c59"

DEFAULT_NARRATION = {
    "intro": "本视频演示系统的完整操作流程，请跟随画面操作。",
    "outro": "以上就是本次演示的全部内容。",
}


def ff(args, capture=True, timeout=120):
    """带超时兜底的 ffmpeg 调用。

    为什么必须带 -nostdin 和超时：
      1. -nostdin：ffmpeg 默认会监听 stdin 的交互按键。脚本里调用时 stdin 是
         继承来的，加 -nostdin 是官方推荐做法，避免它去消费本不该碰的输入。
      2. 超时：实测在「后台任务」里运行 make.sh 时，拼接那一步的 ffmpeg 会偶发
         卡死（CPU 归零、11 分钟不产出，同一命令前台只要 6 秒）。超时后会强制
         终止子进程并返回非 0，由上层重试，而不是无限等下去。
    """
    cmd = [str(FFMPEG), "-nostdin"] + [str(a) for a in args]
    try:
        return subprocess.run(
            cmd,
            cwd=str(HERE),
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
            text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        out = e.stdout or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return subprocess.CompletedProcess(
            cmd, 3, out + f"\n[ff] ffmpeg 超过 {timeout}s 未完成，已强制终止")


def die(msg, out=None):
    if out:
        msg = msg + "\n" + "\n".join((out or "").strip().splitlines()[-18:])
    sys.exit(msg)


def duration_of(path):
    """ffmpeg-static 不含 ffprobe，用解一遍的方式取实际时长"""
    r = ff(["-i", path, "-f", "null", "-"], timeout=60)
    last = None
    for m in TIME_RE.finditer(r.stdout or ""):
        last = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return last


def esc(s):
    """转义 ffmpeg 滤镜表达式里的文本（值用单引号包裹，只需处理 \\ 和 '）"""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def title_size(title):
    """按字数自适应字号，避免长标题溢出画布"""
    n = len(title)
    if n <= 10:
        return 96
    if n <= 14:
        return 82
    if n <= 18:
        return 70
    if n <= 24:
        return 60
    return 52


def check_fonts():
    missing = [f for f in (FONT_BOLD, FONT_REG) if not (HERE / f).exists()]
    if missing:
        die(
            "缺少字体文件：" + "、".join(missing) + "\n"
            "通过 node produce.js 运行会自动从 Windows 字体目录复制；其他系统把任一中文字体复制到 assets/ 并改成这两个文件名"
        )


# ---------------------------------------------------------------- 卡片合成

async def synth_tts(text, out_path, voice, rate, volume, pitch):
    import edge_tts

    for attempt in range(3):
        try:
            c = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
            await c.save(str(out_path))
            return
        except Exception as e:
            if attempt == 2:
                raise
            print("  配音合成重试（" + e.__class__.__name__ + "）")
            await asyncio.sleep(2)


def build_card_video(dur, title, subtitle, footer, accent, bg1, bg2,
                     watermark, out_path):
    """纯滤镜合成标题卡：渐变底 → 品牌条 → 文字（错峰淡入）→ 整体淡入淡出"""
    fs_title = title_size(title)

    chain = [
        f"drawbox=x=0:y=0:w={W}:h=6:color={accent}@0.95:t=fill",
        f"drawbox=x=0:y={H - 6}:w={W}:h=6:color={accent}@0.45:t=fill",
    ]

    if watermark:
        chain.append(
            "drawtext=fontfile=" + FONT_REG +
            ":text='" + esc(watermark) + "'"
            ":fontsize=26:fontcolor=white@0.22"
            ":x=w-text_w-48:y=h-text_h-46"
        )

    # 主标题：0.30s 起淡入
    chain.append(
        "drawtext=fontfile=" + FONT_BOLD +
        ":text='" + esc(title) + "'"
        f":fontsize={fs_title}:fontcolor=white"
        ":x=(w-text_w)/2:y=418"
        ":alpha='min(1,max(0,(t-0.30)/0.60))'"
    )

    # 分隔线：1.00s 起从中心向两侧展开
    line_w = 620
    grow = f"min({line_w}\\,{line_w}*max(0\\,min(1\\,(t-1.00)/0.70)))"
    chain.append(
        f"drawbox=x=(iw-{grow})/2:y=560:w={grow}:h=3:color={accent}:t=fill"
    )

    if subtitle:
        chain.append(
            "drawtext=fontfile=" + FONT_REG +
            ":text='" + esc(subtitle) + "'"
            ":fontsize=38:fontcolor=0xa8c8e8"
            ":x=(w-text_w)/2:y=598"
            ":alpha='min(1,max(0,(t-1.15)/0.60))'"
        )

    if footer:
        chain.append(
            "drawtext=fontfile=" + FONT_REG +
            ":text='" + esc(footer) + "'"
            ":fontsize=27:fontcolor=0x7fa2c4"
            ":x=(w-text_w)/2:y=948"
            ":alpha='min(1,max(0,(t-1.35)/0.60))'"
        )

    chain.append("format=yuv420p")
    chain.append("fade=t=in:st=0:d=0.55")
    chain.append(f"fade=t=out:st={dur - 0.55:.3f}:d=0.55")

    r = ff([
        "-y", "-hide_banner",
        "-f", "lavfi", "-i",
        f"gradients=s={W}x{H}:c0={bg1}:c1={bg2}:x0=0:y0=0:x1={W}:y1={H}"
        f":d={dur:.3f}:r={FPS}:speed=0.00001",
        "-vf", ",".join(chain),
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-video_track_timescale", str(TIMESCALE),
        "-an", out_path,
    ])
    if r.returncode != 0:
        die("合成标题卡失败：", r.stdout)


LEAD = 0.70  # 配音起点，留一点起拍


def build_card_audio(dur, narration, voice, rate, volume, pitch, out_wav, tmp_dir, tts=None):
    """音轨分两步拼：前置静音 → 配音 → 尾部静音，用 concat 保证时间戳单调干净。
    （正片旁白曾被 atempo + 同批混流写坏 edit list，这里从根上避开。）

    tts 传入已合成好的配音文件时直接复用，避免同一句话向 TTS 服务请求两遍。"""
    if narration:
        tts = Path(tts) if tts else Path(tmp_dir) / (Path(out_wav).stem + "_tts.mp3")
        if not tts.exists():
            asyncio.run(synth_tts(narration, tts, voice, rate, volume, pitch))
        n_dur = duration_of(tts)
        if n_dur is None:
            die("无法读取配音时长：" + str(tts))
        tail = max(dur - LEAD - n_dur, 0.05)
        inputs = [
            "-f", "lavfi", "-t", f"{LEAD:.4f}", "-i", f"anullsrc=r={SR}:cl=mono",
            "-i", str(tts),
            "-f", "lavfi", "-t", f"{tail:.4f}", "-i", f"anullsrc=r={SR}:cl=mono",
        ]
        chains = [
            f"[0:a]aformat=sample_rates={SR}:channel_layouts=mono:sample_fmts=fltp[s0]",
            f"[1:a]aformat=sample_rates={SR}:channel_layouts=mono:sample_fmts=fltp[a1]",
            f"[2:a]aformat=sample_rates={SR}:channel_layouts=mono:sample_fmts=fltp[s2]",
        ]
        fc = ";".join(chains) + ";[s0][a1][s2]concat=n=3:v=0:a=1[out]"
    else:
        inputs = ["-f", "lavfi", "-t", f"{dur:.4f}", "-i", f"anullsrc=r={SR}:cl=mono"]
        fc = f"[0:a]aformat=sample_rates={SR}:channel_layouts=mono:sample_fmts=fltp[out]"

    r = ff(inputs + ["-filter_complex", fc, "-map", "[out]",
                     "-c:a", "pcm_s16le", "-ar", str(SR), "-ac", "1",
                     "-t", f"{dur:.3f}", "-y", str(out_wav)])
    if r.returncode != 0:
        die("合成标题卡音轨失败：", r.stdout)


def mux_card(video, audio, out_path, dur):
    r = ff([
        "-y", "-hide_banner",
        "-i", str(video), "-i", str(audio),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "160k", "-ar", str(SR), "-ac", "1",
        "-t", f"{dur:.3f}",
        "-video_track_timescale", str(TIMESCALE),
        "-movflags", "+faststart",
        str(out_path),
    ])
    if r.returncode != 0:
        die("标题卡合流失败：", r.stdout)


def flow_stats():
    """从 flow.js 统计步骤数与字幕数，供卡片底部信息使用（避免手写数字与实际脱节）"""
    if not usable(NODE_EXE):
        return None, None
    code = (
        "const f=require('./flow.js');"
        "process.stdout.write(f.length+' '+f.filter(s=>s.type==='caption'&&s.text).length)"
    )
    r = subprocess.run([str(NODE_EXE), "-e", code], cwd=str(HERE),
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       text=True, encoding="utf-8", errors="replace")
    try:
        steps, caps = (r.stdout or "").split()
        return int(steps), int(caps)
    except Exception:
        return None, None


def fill_placeholders(text, common):
    """支持 footer 里写 {steps}（操作步数）、{duration}（正片秒数）、{captions}（讲解条数）"""
    if not text or "{" not in text:
        return text
    d = {
        "{steps}": str(common.get("steps") if common.get("steps") is not None else "—"),
        "{captions}": str(common.get("captions") if common.get("captions") is not None else "—"),
        "{duration}": (f"{common['video_dur']:.0f}"
                       if common.get("video_dur") else "—"),
    }
    for k, v in d.items():
        text = text.replace(k, v)
    return text


def make_card(position, spec, common, tmp_dir, out_dir):
    """生成一张卡（片头或片尾），返回文件路径"""
    title = spec.get("title") or ("操作演示" if position == "intro" else "演示结束")
    subtitle = spec.get("subtitle", "")
    footer = fill_placeholders(spec.get("footer", ""), common)
    narration = spec.get("narration", DEFAULT_NARRATION[position])
    spoken = spec.get("speech") or narration  # 按读音规则改写过的配音文本
    accent = spec.get("accent") or common["accent"] or (
        ACCENT_INTRO if position == "intro" else ACCENT_OUTRO)
    bg1 = spec.get("bg1", common["bg1"])
    bg2 = spec.get("bg2", common["bg2"])

    # 时长：优先用显式指定，否则按配音长度自动推算
    tts_reused = None
    if spec.get("duration"):
        dur, n_dur = float(spec["duration"]), None
    elif narration:
        tts_reused = tmp_dir / (position + "-tts.mp3")
        asyncio.run(synth_tts(spoken, tts_reused, common["voice"], common["rate"],
                              common["volume"], common["pitch"]))
        n_dur = duration_of(tts_reused)
        if n_dur is None:
            die("无法读取配音时长")
        min_dur = 5.0 if position == "intro" else 4.0
        dur = max(n_dur + LEAD + 1.0, min_dur)
    else:
        dur, n_dur = 4.0, None

    label = "片头" if position == "intro" else "片尾"
    print("-" * 68)
    print(label + "卡")
    print("  标题   : " + title)
    if subtitle:
        print("  副标题 : " + subtitle)
    if footer:
        print("  底部   : " + footer)
    print("  开场白 : " + (narration if narration else "（无配音）"))
    if n_dur is not None:
        print(f"  配音长 : {n_dur:.2f}s  → 卡片 {dur:.2f}s")
    else:
        print(f"  卡片长 : {dur:.2f}s")
    print("  配色   : " + bg1 + " → " + bg2 + "  主题色 " + accent)

    card_v = tmp_dir / (position + "-video.mp4")
    card_a = tmp_dir / (position + "-audio.wav")
    build_card_video(dur, title, subtitle, footer, accent, bg1, bg2,
                     common["watermark"], card_v)
    build_card_audio(dur, spoken, common["voice"], common["rate"],
                     common["volume"], common["pitch"], card_a, tmp_dir,
                     tts=tts_reused)

    card = out_dir / (position + "-card.mp4")
    mux_card(card_v, card_a, card, dur)
    print(f"  [完成] {card}  ({dur:.2f}s)")
    return card


# ---------------------------------------------------------------- 拼接

def concat_copy(segs, out_path):
    """concat 分流器 + 流复制：无损、快。要求各段时间基与编码参数一致。"""
    list_file = HERE / "output" / "_concat.txt"
    list_file.write_text(
        "".join("file '" + str(Path(s).resolve()).replace("\\", "/") + "'\n" for s in segs),
        "utf-8",
    )
    r = ff(["-y", "-hide_banner", "-f", "concat", "-safe", "0",
            "-i", str(list_file), "-c", "copy",
            "-movflags", "+faststart", str(out_path)])
    list_file.unlink(missing_ok=True)
    return r


def concat_multi(segs, out_path, fade=0.6):
    """重编码拼接，在接缝两侧各加 fade 时长的暗场过渡。

    两侧都做才能同时覆盖两个方向：
        片头场景：片头卡淡出 → 正片（加载白屏）淡入
        片尾场景：正片淡出   → 片尾卡淡入
    只处理第二段的话，片尾场景会漏掉正片结尾那一下硬切。
    """
    n = len(segs)
    durs = [duration_of(p) for p in segs]

    ins = []
    for p in segs:
        ins += ["-i", str(p)]

    vparts, aparts = [], []
    for i in range(n):
        v = f"[{i}:v]setsar=1,fps={FPS},format=yuv420p"
        a = f"[{i}:a]aformat=sample_rates={SR}:channel_layouts=mono"
        if fade > 0.001:
            if i > 0:
                v += f",fade=t=in:st=0:d={fade:.3f}"
                a += f",afade=t=in:st=0:d={min(fade, 0.4):.3f}"
            if i < n - 1 and durs[i]:
                st = max(durs[i] - fade, 0.0)
                v += f",fade=t=out:st={st:.3f}:d={fade:.3f}"
                a += f",afade=t=out:st={st:.3f}:d={min(fade, 0.4):.3f}"
        vparts.append(v + f"[v{i}]")
        aparts.append(a + f"[a{i}]")

    labels = "".join(f"[v{i}][a{i}]" for i in range(n))
    chain = ";".join(vparts + aparts) + ";" + labels + f"concat=n={n}:v=1:a=1[v][a]"

    r = ff(["-y", "-hide_banner"] + ins + [
        "-filter_complex", chain,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "160k", "-ar", str(SR), "-ac", "1",
        "-video_track_timescale", str(TIMESCALE),
        "-movflags", "+faststart",
        str(out_path),
    ])
    return r


def join(segs, out_path, transition, fade):
    out_path = Path(out_path)
    # 拼接前先删掉旧产物。两个原因，都是踩过的坑：
    #   1. ffmpeg 在输出文件已存在时会**询问是否覆盖**。脚本环境下 stdin 无法应答，
    #      轻则阻塞数分钟（曾挂 11 分钟），重则直接拒绝写入。
    #   2. 更危险的是：写不进去时 ffmpeg 可能仍返回成功，后续「片长核对」读到的是
    #      上一轮的旧文件，于是校验全部通过、交付出去的却是过期成片。
    # 删掉旧文件后，任何写失败都会立刻暴露成「文件不存在」。
    out_path.unlink(missing_ok=True)

    if transition == "cut":
        r = concat_copy(segs, out_path)
        if r.returncode == 0 and out_path.exists():
            print("  流复制拼接成功（无损）")
            return True
        print("  流复制拼接失败，降级为重编码拼接...")

    # 实测拼接只需数秒。若 ffmpeg 在后台任务环境里偶发卡死，超时后重试一次；
    # 连续两次超时才判定失败，避免白等十几分钟。
    for attempt in range(2):
        print(f"  重编码拼接，接缝加 {fade:.2f}s 暗场过渡（两侧各一段）..."
              if attempt == 0 else "  首次超时，重试一次...")
        r = concat_multi(segs, out_path, fade=(fade if transition != "cut" else 0.0))
        if out_path.exists() and out_path.stat().st_size > 0:
            return True
        if r.returncode != 3:      # 3 = 本脚本的「ffmpeg 超时」标记
            die("拼接失败：", r.stdout)

    die("拼接连续两次超时。该命令前台执行通常只需数秒，"
        "大概率是运行环境问题（后台任务里 ffmpeg 偶发挂起）——"
        "把命令放到前台重跑一次即可。", r.stdout)


def verify(path):
    """调用项目里的容器元数据校验器"""
    if not usable(NODE_EXE):
        print("  （找不到 node，跳过元数据校验）")
        return True
    try:
        r = subprocess.run(
            [str(NODE_EXE), str(HERE / "tools" / "mp4info.js"), str(path)],
            cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except subprocess.TimeoutExpired:
        print("  （校验器超时，跳过）")
        return True
    print((r.stdout or "").rstrip())
    return r.returncode == 0


# ---------------------------------------------------------------- 入口

def spec_from_args(args):
    return {
        "title": args.title,
        "subtitle": args.subtitle,
        "footer": args.footer,
        "narration": args.narration if args.narration is not None else None,
        "duration": args.duration,
        "accent": args.accent,
        "bg1": args.bg1,
        "bg2": args.bg2,
    }


def normalize_argv(argv):
    """把 `--rate -6%` 合并成 `--rate=-6%`；argparse 会把带负号的值当成选项名而报错。"""
    known = {"--rate", "--volume", "--pitch"}
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in known and i + 1 < len(argv) and argv[i + 1].startswith("-"):
            out.append(a + "=" + argv[i + 1])
            i += 2
            continue
        out.append(a)
        i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None, help="卡片配置文件（如 cards.json）")
    ap.add_argument("--position", choices=["intro", "outro"], default="intro")
    ap.add_argument("--title", default="操作演示")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--footer", default="")
    ap.add_argument("--narration", default=None, help="开场白；传空字符串则不加配音")
    ap.add_argument("--duration", type=float, default=None,
                    help="卡片时长，默认按配音长度自动算")
    ap.add_argument("--voice", default="zh-CN-YunxiNeural")
    ap.add_argument("--rate", default="-6%")
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--accent", default=None)
    ap.add_argument("--bg1", default=DEFAULT_BG[0])
    ap.add_argument("--bg2", default=DEFAULT_BG[1])
    ap.add_argument("--watermark", default="", help="角标文字，如公司名")
    ap.add_argument("--attach", default=None,
                    help="要拼接的正片（片头拼在其前，片尾拼在其后）")
    ap.add_argument("--out", default=None)
    ap.add_argument("--transition", choices=["cut", "fade"], default="fade",
                    help="cut 流复制无损；fade 重编码并加暗场过渡（默认）")
    ap.add_argument("--fade", type=float, default=0.6, help="暗场过渡时长（秒）")
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--steps", type=int, default=None, help="footer 里 {steps} 的值，不传则从 flow.js 统计")
    ap.add_argument("--captions", type=int, default=None, help="footer 里 {captions} 的值，不传则从 flow.js 统计")
    args = ap.parse_args(normalize_argv(sys.argv[1:]))

    if not usable(FFMPEG):
        die("找不到 ffmpeg：请通过 node produce.js 运行，或设置环境变量 FFMPEG 指向 ffmpeg 可执行文件")
    check_fonts()

    out_dir = HERE / "output"
    out_dir.mkdir(exist_ok=True)
    tmp_dir = out_dir / "_cards_tmp"
    shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    steps, captions = (args.steps, args.captions) if args.steps is not None else flow_stats()
    common = {
        "voice": args.voice,
        "rate": args.rate,
        "volume": args.volume,
        "pitch": args.pitch,
        "accent": args.accent,
        "bg1": args.bg1,
        "bg2": args.bg2,
        "watermark": args.watermark,
        "steps": steps,
        "captions": captions,
        "video_dur": duration_of(args.attach) if args.attach and Path(args.attach).exists() else None,
    }

    print("=" * 68)
    print("片头 / 片尾卡生成" + ("（配置：" + args.config + "）" if args.config else ""))
    print("=" * 68)

    segs = []
    cards = []

    if args.config:
        cfg = json.loads(Path(args.config).read_text("utf-8"))
        for k in ("voice", "rate", "volume", "pitch", "accent", "bg1", "bg2", "watermark"):
            if k in cfg:
                common[k] = cfg[k]
        intro_spec = cfg.get("intro")
        outro_spec = cfg.get("outro")
        if intro_spec:
            c = make_card("intro", intro_spec, common, tmp_dir, out_dir)
            cards.append(c)
            segs.append(c)
        if args.attach:
            segs.append(Path(args.attach))
        if outro_spec:
            c = make_card("outro", outro_spec, common, tmp_dir, out_dir)
            cards.append(c)
            segs.append(c)
    else:
        spec = spec_from_args(args)
        c = make_card(args.position, spec, common, tmp_dir, out_dir)
        cards.append(c)
        if args.attach:
            if args.position == "intro":
                segs = [c, Path(args.attach)]
            else:
                segs = [Path(args.attach), c]
        else:
            segs = [c]

    # ---------- 拼接 ----------
    final = None
    if len(segs) > 1:
        if not all(Path(s).exists() for s in segs):
            die("找不到要拼接的文件：" + "、".join(str(s) for s in segs if not Path(s).exists()))
        out_path = Path(args.out) if args.out else (out_dir / "demo-final.mp4")

        print("-" * 68)
        print("拼接：" + " + ".join(Path(s).name for s in segs))
        join(segs, out_path, args.transition, args.fade)

        total = duration_of(out_path)
        expect = sum(duration_of(s) or 0 for s in segs)
        print(f"  片长核对：期望 {expect:.2f}s ／ 实际 {total if total else 0:.2f}s")
        if total is None or abs(total - expect) > 0.35:
            print("  时长偏差过大，改用重编码拼接...")
            out_path.unlink(missing_ok=True)
            r = concat_multi(segs, out_path,
                             fade=(args.fade if args.transition != "cut" else 0.0))
            if r.returncode != 0 or not out_path.exists():
                die("重编码拼接失败：", r.stdout)
            total = duration_of(out_path)
            print(f"  重编码后片长：{total:.2f}s")
        final = out_path
    else:
        if args.out:
            shutil.copyfile(cards[0], args.out)
            final = Path(args.out)
        else:
            final = cards[0]

    shutil.rmtree(tmp_dir, ignore_errors=True)

    print()
    print("=" * 68)
    if not args.no_verify:
        print("容器元数据校验（音频轨异常会让播放器直接跳过音轨）")
        print("=" * 68)
        verify(final)
    else:
        print("成品：" + str(final))
        print("=" * 68)


if __name__ == "__main__":
    main()
