"""成品字幕按正片在视频中的起点偏移，保留正片 SRT 供续跑使用。"""
import math
import re

STAMP = r"\d{2,}:[0-5]\d:[0-5]\d,\d{3}"
CUE = re.compile(rf"({STAMP})(\s+-->\s+)({STAMP})([ \t].*)?")


def format_ms(ms):
    if not isinstance(ms, int) or ms < 0:
        raise ValueError("字幕时间必须为非负整数毫秒")
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def parse_ms(stamp):
    h, m, s, ms = map(int, re.split("[:,]", stamp))
    return ((h * 60 + m) * 60 + s) * 1000 + ms


def shift_srt(text, offset):
    if not math.isfinite(offset) or offset < 0:
        raise ValueError("片头偏移必须为有限的非负秒数")
    if not text.strip():
        return text
    offset_ms = round(offset * 1000)
    separator = "\r\n" if "\r\n" in text else "\n"
    shifted = []
    for block in re.split(r"\r?\n[ \t]*\r?\n", text.strip()):
        lines = block.splitlines()
        cue = CUE.fullmatch(lines[1]) if len(lines) >= 3 else None
        if not lines[0].isdigit() or int(lines[0]) < 1 or not cue:
            raise ValueError("SRT 片段缺少序号、有效时间行或字幕文本")
        start, end = parse_ms(cue[1]), parse_ms(cue[3])
        if end <= start:
            raise ValueError("SRT 结束时间必须晚于开始时间")
        lines[1] = format_ms(start + offset_ms) + cue[2] + format_ms(end + offset_ms) + (cue[4] or "")
        shifted.append(separator.join(lines))
    if offset_ms == 0:
        return text
    return (separator * 2).join(shifted) + (separator if text.endswith("\n") else "")
