'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function normalizeFiles(files, base, recorded = []) {
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string' || !f)) throw new Error('upload.files 必须列出非空文件路径');
  const root = fs.realpathSync(base);
  return files.map(file => {
    const full = path.resolve(root, file);
    if (!inside(root, full)) throw new Error('上传文件须位于脚本目录内；请先复制获准样本：' + path.basename(file));
    const previous = recorded.find(f => f.path === full);
    if (previous) return { ...previous }; // 仅纯后期可传入录制时已绑定的文件摘要，不上传这些字节。
    const real = fs.realpathSync(full);
    if (real !== full || !inside(root, real) || !fs.lstatSync(full).isFile()) throw new Error('上传文件不能通过链接越界或指向目录');
    const bytes = fs.readFileSync(full);
    if (!bytes.length) throw new Error('上传文件为空：' + path.basename(full));
    return { path: real, hash: hash(bytes), size: bytes.length };
  });
}
function payloads(files) {
  const types = { '.txt': 'text/plain', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  return files.map(file => {
    if (fs.realpathSync(file.path) !== file.path || !fs.lstatSync(file.path).isFile()) throw new Error('上传文件路径已变化，请重新核对');
    const buffer = fs.readFileSync(file.path);
    if (buffer.length !== file.size || hash(buffer) !== file.hash) throw new Error('上传文件内容已变化，请重新核对并确认');
    return { name: path.basename(file.path), mimeType: types[path.extname(file.path).toLowerCase()] || 'application/octet-stream', buffer };
  });
}
const listUploads = script => script.scenes.flatMap(s => s.actions.flatMap(a => a.files || []));
module.exports = { normalizeFiles, payloads, listUploads, hash };
