"""
旁白先行：在录制之前把每个场景的旁白合成好，并量出时长

输入：output/script.json
输出：output/tts/manifest.json  { "scenes": { "<场景id>": { "file": ..., "dur": 秒 } } }

录制器按这些时长控制每个场景停留多久，所以配音不需要再被压缩加速。
合成结果按（音色, 语速, 文本）缓存在 output/tts-cache，改版重跑时文案没变的句子直接复用。

用法：
    python tts.py
"""

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
CACHE = OUT / "tts-cache"
# produce.js 通过环境变量传入解析好的路径；单独运行时用 PATH 上的 ffmpeg
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")


def duration_of(path):
    r = subprocess.run([str(FFMPEG), "-nostdin", "-xerror", "-i", str(path), "-f", "null", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       encoding="utf-8", errors="replace")
    last = None
    for m in TIME_RE.finditer(r.stdout or ""):
        last = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return last if r.returncode == 0 and last is not None and last > 0 else None


async def synth(text, target, voice, rate):
    import edge_tts
    tmp = target.with_suffix(".part")
    tries = 6
    for attempt in range(tries):
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(tmp))
            tmp.replace(target)
            return
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"    重试（{e.__class__.__name__}）")
            await asyncio.sleep(2 * (attempt + 1))


async def main():
    script = json.loads((OUT / "script.json").read_text("utf-8"))
    voice, rate = script["voice"], script["rate"]
    CACHE.mkdir(parents=True, exist_ok=True)

    manifest = {"voice": voice, "rate": rate, "scenes": {}}
    todo = [s for s in script["scenes"] if s["narration"]]
    print(f"共 {len(todo)} 句旁白，音色 {voice}，语速 {rate}")

    hits = 0
    for s in todo:
        spoken = s.get("speech") or s["narration"]  # 按读音规则改写过的配音文本，字幕仍用 narration
        key = hashlib.sha1(f"{voice}|{rate}|{spoken}".encode("utf-8")).hexdigest()[:16]
        clip = CACHE / f"{key}.mp3"
        if clip.exists():
            hits += 1
            mark = "缓存"
        else:
            await synth(spoken, clip, voice, rate)
            mark = "合成"
        dur = duration_of(clip)
        if dur is None:
            sys.exit(f"读不到时长：{clip}")
        manifest["scenes"][s["id"]] = {"file": str(clip.relative_to(HERE)).replace("\\", "/"), "dur": round(dur, 3), "speech": spoken}
        print(f"  [{mark}] {s['id']}  {dur:5.2f}s  {spoken}")

    (OUT / "tts").mkdir(parents=True, exist_ok=True)
    (OUT / "tts" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(f"完成：{len(todo) - hits} 句新合成，{hits} 句复用缓存")


if __name__ == "__main__":
    asyncio.run(main())
