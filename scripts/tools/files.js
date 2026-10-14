'use strict';
const CLI = require.main === module ? require('../cli').readCli({
  usage: '用法：node tools/files.js add <本轮名称> <已准备好的文件>\n      node tools/files.js cleanup <本轮名称>\n只复制样本、清理本轮登记且内容未变的副本；原文件保留。',
  maxPositionals: 3,
  validate: ({ positionals: a }) => {
    if (!(a[0] === 'add' && a.length === 3 || a[0] === 'cleanup' && a.length === 2)) throw new Error('请使用 add 或 cleanup；用 --help 查看用法');
  }
}) : null;
const fs = require('fs'), path = require('path');
const { hash } = require('../uploads');
function location(base, run) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(run)) throw new Error('本轮名称只能包含字母、数字、横线和下划线');
  base = fs.realpathSync(base);
  const directory = path.join(base, 'output', 'temp-files', run);
  for (let p = directory; p !== base; p = path.dirname(p)) {
    if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('临时文件目录不能包含链接');
  }
  return { directory, manifest: path.join(directory, 'manifest.json') };
}
function read(manifest) {
  if (!fs.lstatSync(manifest).isFile() || fs.realpathSync(manifest) !== manifest) throw new Error('临时文件清单不能是链接或目录');
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (value.owner !== 'b2b-training-video' || value.version !== 1 || !Array.isArray(value.files)
    || value.files.some(f => !f || typeof f.name !== 'string' || !f.name || /[\\/\u0000]/.test(f.name)
      || ['.', '..', 'manifest.json'].includes(f.name.toLowerCase()) || path.basename(f.name) !== f.name
      || !/^[a-f0-9]{64}$/.test(f.hash) || !Number.isInteger(f.size) || f.size <= 0)
    || new Set(value.files.map(f => f.name.toLowerCase())).size !== value.files.length) {
    throw new Error('临时文件清单无效，拒绝清理');
  }
  return value;
}
function add(base, run, source) {
  const { directory, manifest } = location(base, run), name = path.basename(source);
  if (name.toLowerCase() === 'manifest.json' || !fs.statSync(source).isFile()) throw new Error('来源必须是普通样本文件');
  const bytes = fs.readFileSync(source), entry = { name, hash: hash(bytes), size: bytes.length };
  if (!bytes.length) throw new Error('样本文件不能为空');
  const value = fs.lstatSync(manifest, { throwIfNoEntry: false }) ? read(manifest) : { owner: 'b2b-training-video', version: 1, files: [] };
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    if (!value.files.some(f => f.name === name && f.hash === entry.hash) || fs.lstatSync(target).isSymbolicLink()
      || hash(fs.readFileSync(target)) !== entry.hash) throw new Error('同名文件已经存在，拒绝覆盖');
    return target;
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' }); value.files.push(entry);
  fs.writeFileSync(manifest, JSON.stringify(value, null, 2), 'utf8');
  return target;
}
function cleanup(base, run) {
  const { directory, manifest } = location(base, run), value = read(manifest);
  const targets = value.files.map(f => {
    const target = path.join(directory, f.name);
    if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target || hash(fs.readFileSync(target)) !== f.hash) {
      throw new Error('临时文件已变化，未删除任何文件：' + f.name);
    }
    return target;
  });
  for (const target of targets) fs.unlinkSync(target);
  fs.unlinkSync(manifest);
  const remaining = fs.readdirSync(directory);
  if (!remaining.length) fs.rmdirSync(directory);
  return { removed: targets.length, preserved: remaining };
}
module.exports = { add, cleanup };
if (CLI) {
  let release;
  try {
    const base = path.resolve(__dirname, '..'), [action, run, source] = CLI.positionals;
    location(base, run);
    release = require('../lock').acquireLock(path.join(base, 'output'));
    console.log(action === 'add' ? add(base, run, path.resolve(source)) : JSON.stringify(cleanup(base, run)));
  } catch (error) { console.error('[文件处理失败] ' + error.message); process.exitCode = 2; }
  finally { if (release) release(); }
}
