/**
 * 极简 MP4 盒子解析 —— 查容器里各轨道声明的时长
 *
 * 用途：诊断「视频没声音」「进度条时长错乱」这类问题。
 * 音频轨的 mdhd 时长若远小于视频轨，播放器会认为该轨是空的并直接跳过，
 * 表现就是明明有音轨却听不到声音。
 *
 * 用法：node tools/mp4info.js 文件.mp4
 * 退出码：0 正常；2 音频轨异常
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/mp4info.js 文件.mp4');
  process.exit(1);
}
const buf = fs.readFileSync(file);

const rows = [];   // 扁平输出
const traks = [];  // 每条轨道一个 { handler, timescale, duration, edits }
let mvhd = null;

function readBoxes(start, end, path, trak) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let headerLen = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerLen || p + size > end + 1) break;

    const body = p + headerLen;
    const bodyEnd = p + size;
    const label = path + '/' + type;
    const version = buf[body];

    let nextTrak = trak;

    if (type === 'trak') {
      nextTrak = { handler: null, timescale: null, duration: null, edits: [] };
      traks.push(nextTrak);
    } else if (type === 'mvhd') {
      const ts = version === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12);
      const dur = version === 1
        ? Number(buf.readBigUInt64BE(body + 24))
        : buf.readUInt32BE(body + 16);
      mvhd = { timescale: ts, duration: dur, version };
      rows.push({ label, timescale: ts, duration: dur, sec: ts ? dur / ts : 0 });
    } else if (type === 'mdhd') {
      const ts = version === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12);
      const dur = version === 1
        ? Number(buf.readBigUInt64BE(body + 24))
        : buf.readUInt32BE(body + 16);
      if (trak) {
        trak.timescale = ts;
        trak.duration = dur;
      }
      rows.push({ label, timescale: ts, duration: dur, sec: ts ? dur / ts : 0 });
    } else if (type === 'hdlr') {
      const h = buf.toString('latin1', body + 8, body + 12);
      if (trak) trak.handler = h;
      rows.push({ label, handler: h });
    } else if (type === 'elst') {
      const count = buf.readUInt32BE(body + 4);
      const entries = [];
      for (let i = 0; i < count; i++) {
        const base = body + 8 + i * 12;
        if (base + 12 > bodyEnd) break;
        entries.push({
          segDuration: buf.readUInt32BE(base),
          mediaTime: buf.readInt32BE(base + 4),
          rate: buf.readInt32BE(base + 8) >> 16,
        });
      }
      if (trak) trak.edits = entries;
      rows.push({ label, edits: entries });
    }

    if (['moov', 'trak', 'mdia', 'edts', 'minf', 'stbl'].includes(type)) {
      readBoxes(body, bodyEnd, label, nextTrak);
    }
    p = bodyEnd;
  }
}

readBoxes(0, buf.length, '', null);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('盒子', 32) + pad('timescale', 12) + pad('duration', 18) + '秒');
console.log('-'.repeat(76));
for (const r of rows) {
  if (r.sec !== undefined) {
    console.log(pad(r.label, 32) + pad(r.timescale, 12) + pad(r.duration, 18) + r.sec.toFixed(3));
  } else if (r.handler) {
    const name = { vide: 'video(视频)', soun: 'sound(音频)' }[r.handler] || r.handler;
    console.log(pad(r.label, 32) + 'handler = ' + name);
  } else if (r.edits) {
    console.log(pad(r.label, 32) + 'edits = ' + JSON.stringify(r.edits));
  }
}

console.log('\n文件大小: ' + (buf.length / 1024).toFixed(0) + ' KB');

function secOf(t) {
  return t && t.timescale ? t.duration / t.timescale : null;
}
const vTrak = traks.find(t => t.handler === 'vide');
const aTrak = traks.find(t => t.handler === 'soun');
const vSec = secOf(vTrak);
const aSec = secOf(aTrak);

console.log('\n================ 判定 ================');
let bad = false;

if (mvhd) {
  const o = mvhd.duration / mvhd.timescale;
  const sane = o > 0.5 && o < 24 * 3600;
  if (!sane) bad = true;
  console.log('整体时长 : ' + o.toFixed(3) + 's   ' + (sane ? '正常' : '<< 异常，数值不可信（进度条会错乱）'));
}
if (vSec !== null) console.log('视频轨   : ' + vSec.toFixed(3) + 's');
if (aSec !== null) {
  const ratio = vSec ? aSec / vSec : 1;
  const ok = ratio > 0.9;
  if (!ok) bad = true;
  console.log(
    '音频轨   : ' + aSec.toFixed(3) + 's   ' +
    (ok ? '正常' : '<< 异常，远短于视频轨，播放器会跳过音轨（这就是“没声音”的原因）')
  );
  const weirdEdits = (aTrak.edits || []).some(e => e.rate !== 1);
  if (weirdEdits) {
    bad = true;
    console.log('音频编辑表: 速率异常 << 存在畸形 edit list');
  }
} else {
  console.log('音频轨   : 无（这是纯无声文件，不是故障）');
}

console.log(bad ? '\n结论：元数据有问题。' : '\n结论：元数据正常。');
if (bad) process.exitCode = 2;
