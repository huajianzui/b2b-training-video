'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeFiles, payloads, hash } = require('../uploads');
const { add, cleanup } = require('../tools/files');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-files-')), root = path.join(temp, 'runtime');
  fs.mkdirSync(root); const source = path.join(temp, '培训样本.txt'); fs.writeFileSync(source, '仅本轮使用的培训数据');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, source };
}
test('上传绑定真实文件字节，文件改变时停止；越界、空文件及目录链接拒绝', t => {
  const f = fixture(t), file = add(f.root, 'rehearsal', f.source);
  const approved = normalizeFiles([file], f.root);
  assert.equal(payloads(approved)[0].buffer.toString(), fs.readFileSync(f.source, 'utf8'));
  fs.writeFileSync(file, '后来替换的内容'); assert.throws(() => payloads(approved), /内容已变化/);
  assert.throws(() => normalizeFiles([f.source], f.root), /脚本目录/);
  assert.throws(() => normalizeFiles([], f.root), /非空/);
  fs.writeFileSync(file, ''); assert.throws(() => normalizeFiles([file], f.root), /为空/);
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.temp, link, 'junction');
  assert.throws(() => normalizeFiles([path.join(link, path.basename(f.source))], f.root), /链接/);
});
test('本轮清理只删除登记副本，原文件和未知文件保留，纯后期能读原文件摘要', t => {
  const f = fixture(t), original = fs.readFileSync(f.source), file = add(f.root, 'record', f.source);
  assert.equal(add(f.root, 'record', f.source), file);
  const saved = normalizeFiles([file], f.root), unknown = path.join(path.dirname(file), '人工文件.txt'); fs.writeFileSync(unknown, '保留');
  const result = cleanup(f.root, 'record'); assert.deepEqual(result, { removed: 1, preserved: ['人工文件.txt'] });
  assert.deepEqual(fs.readFileSync(f.source), original); assert.equal(fs.readFileSync(unknown, 'utf8'), '保留');
  assert.equal(fs.existsSync(file), false); assert.deepEqual(normalizeFiles([file], f.root, saved), saved);
  assert.throws(() => normalizeFiles([file], f.root), /ENOENT/);
});
test('任一副本被改动时整批拒绝清理，保留全部文件；不覆盖现有文件', t => {
  const f = fixture(t), first = add(f.root, 'record', f.source), other = path.join(f.temp, '另一个.txt'); fs.writeFileSync(other, '第二份');
  const second = add(f.root, 'record', other); fs.writeFileSync(second, '用户改过');
  assert.throws(() => cleanup(f.root, 'record'), /未删除任何文件/);
  assert.ok(fs.existsSync(first)); assert.equal(fs.readFileSync(second, 'utf8'), '用户改过');
  assert.throws(() => add(f.root, 'record', other), /拒绝覆盖/);
});
test('伪造清单、大小写重复、保留文件名以及链接目录均不能触发清理或覆盖', t => {
  const f = fixture(t), file = add(f.root, 'record', f.source), manifest = path.join(path.dirname(file), 'manifest.json');
  const original = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const files of [[...original.files, { ...original.files[0], name: original.files[0].name.toUpperCase() }],
    [{ name: '..', size: 1, hash: hash('x') }], [{ name: 'MANIFEST.JSON', size: 1, hash: hash('x') }]]) {
    fs.writeFileSync(manifest, JSON.stringify({ ...original, files }));
    assert.throws(() => cleanup(f.root, 'record'), /清单无效/); assert.ok(fs.existsSync(file));
  }
  const reserved = path.join(f.temp, 'MANIFEST.JSON'); fs.writeFileSync(reserved, '原文');
  assert.throws(() => add(f.root, 'other', reserved), /普通样本/);
  assert.throws(() => add(f.root, '../outside', f.source), /本轮名称/);
  const link = path.join(f.root, 'output', 'temp-files', 'linked'); fs.symlinkSync(f.temp, link, 'junction');
  assert.throws(() => add(f.root, 'linked', f.source), /不能包含链接/);
  assert.throws(() => cleanup(f.root, 'linked'), /不能包含链接/);
  assert.equal(fs.readFileSync(reserved, 'utf8'), '原文');
});
