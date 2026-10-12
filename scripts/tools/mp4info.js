'use strict';
/** 校验本工具生成的非分片 MP4；--decode 实际解码，--require-audio 要求音轨。 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function inspectMp4(buf, { requireAudio = false } = {}) {
  if (!buf.length) throw new Error('MP4 文件为空');
  const tracks = [], rows = [];
  let movie, moov = 0, ftyp = 0, payload = 0;
  function parse(start, end, { parent = '', track } = {}) {
    let at = start;
    while (at < end) {
      if (end - at < 8) throw new Error('MP4 盒子头被截断：' + parent);
      let size = buf.readUInt32BE(at), header = 8;
      const type = buf.toString('latin1', at + 4, at + 8), label = parent + '/' + type;
      if (size === 1) {
        if (end - at < 16) throw new Error('扩展盒子头被截断：' + label);
        size = Number(buf.readBigUInt64BE(at + 8)); header = 16;
      } else if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || size > end - at) throw new Error('MP4 盒子越界或被截断：' + label);
      const body = at + header, stop = at + size;
      const need = (bytes) => { if (stop - body < bytes) throw new Error('MP4 必要字段被截断：' + label); };
      const clock = (minimum) => {
        need(1);
        const version = buf[body];
        if (![0, 1].includes(version)) throw new Error('不支持的 MP4 时钟版本：' + label);
        need(minimum[version]);
        const timescale = buf.readUInt32BE(body + (version === 1 ? 20 : 12));
        const duration = version === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 16);
        if (!timescale || !duration || !Number.isSafeInteger(duration)) throw new Error('MP4 时长或时间基无效：' + label);
        rows.push({ label, timescale, duration, sec: duration / timescale });
        return { timescale, duration };
      };
      if (type === 'ftyp' && !parent) { need(8); ftyp++; }
      else if (type === 'mdat' && !parent) payload += size - header;
      else if (type === 'moov') {
        if (parent || ++moov > 1) throw new Error('MP4 moov 结构不合法');
        parse(body, stop, { parent: label });
      } else if (type === 'trak' && parent === '/moov') {
        const next = { edits: [] }; tracks.push(next); parse(body, stop, { parent: label, track: next });
      } else if (type === 'mvhd' && parent === '/moov') {
        if (movie) throw new Error('MP4 包含重复 mvhd');
        movie = clock([100, 112]);
      } else if (type === 'mdhd' && parent === '/moov/trak/mdia') {
        if (track.timescale) throw new Error('MP4 包含重复 mdhd');
        Object.assign(track, clock([24, 36]));
      } else if (type === 'hdlr' && parent === '/moov/trak/mdia') {
        need(24);
        if (track.handler) throw new Error('MP4 包含重复 hdlr');
        track.handler = buf.toString('latin1', body + 8, body + 12);
      } else if (type === 'elst' && parent === '/moov/trak/edts') {
        need(8);
        const version = buf[body], entrySize = version === 1 ? 20 : 12;
        if (![0, 1].includes(version)) throw new Error('不支持的 MP4 编辑表版本');
        const count = buf.readUInt32BE(body + 4);
        need(8 + count * entrySize);
        for (let i = 0; i < count; i++) track.edits.push(buf.readInt32BE(body + 8 + i * entrySize + entrySize - 4));
      } else if ((['mdia', 'edts'].includes(type) && parent === '/moov/trak')
        || (type === 'minf' && parent === '/moov/trak/mdia') || (type === 'stbl' && parent === '/moov/trak/mdia/minf')) {
        parse(body, stop, { parent: label, track });
      }
      at = stop;
    }
  }
  parse(0, buf.length);
  if (!ftyp || !moov || !movie || !payload) throw new Error('MP4 缺少 ftyp、moov/mvhd 或非空 mdat');
  const duration = movie.duration / movie.timescale;
  // 沿用原校验器的成片时长范围。
  if (!(duration > 0.5 && duration < 24 * 3600)) throw new Error('MP4 整体时长异常');
  const video = tracks.find((t) => t.handler === 'vide'), audio = tracks.find((t) => t.handler === 'soun');
  for (const t of tracks.filter((t) => ['vide', 'soun'].includes(t.handler))) {
    if (!t.timescale || !t.duration) throw new Error('MP4 轨道缺少有效时长');
    if (t.edits.some((rate) => rate !== 65536)) throw new Error('MP4 编辑表速率异常');
  }
  if (!video || !video.timescale || !video.duration) throw new Error('MP4 缺少有效视频轨');
  if (requireAudio && !audio) throw new Error('MP4 缺少必需的音轨');
  const videoDuration = video.duration / video.timescale, audioDuration = audio ? audio.duration / audio.timescale : null;
  if (audio && !(audioDuration / videoDuration > 0.9)) throw new Error('MP4 音轨远短于视频轨');
  return { duration, videoDuration, audioDuration, tracks, rows };
}

function decode(file, requireAudio) {
  const { ffmpegPath } = require('../deps');
  const args = ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', requireAudio ? '0:a:0' : '0:a?', '-f', 'null', '-'];
  const result = spawnSync(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('ffmpeg 解码校验失败：' + (result.error?.message || result.stderr || result.stdout || '进程退出 ' + result.status));
}

function main(argv) {
  const [file, ...flags] = argv;
  if (!file || flags.some((f) => !['--require-audio', '--decode', '--json'].includes(f))) throw new Error('用法：node tools/mp4info.js 文件.mp4 [--require-audio] [--decode] [--json]');
  const requireAudio = flags.includes('--require-audio');
  const metadata = inspectMp4(fs.readFileSync(file), { requireAudio });
  if (flags.includes('--decode')) decode(file, requireAudio);
  if (flags.includes('--json')) console.log(JSON.stringify(metadata));
  else {
    for (const row of metadata.rows) console.log(row.label + '  ' + row.sec.toFixed(3) + 's');
    console.log('视频轨：' + metadata.videoDuration.toFixed(3) + 's');
    console.log(metadata.audioDuration === null ? '音频轨：无（未要求音轨）' : '音频轨：' + metadata.audioDuration.toFixed(3) + 's');
    console.log(flags.includes('--decode') ? '结论：元数据与实际解码正常。' : '结论：元数据正常（未执行解码）。');
  }
}

module.exports = { inspectMp4 };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error('[MP4 校验失败] ' + error.message); process.exitCode = 2; }
}
