'use strict';
// 更新工具代码，用户的 YAML、产物、依赖及字体保留在原处。
const fs = require('node:fs');
const path = require('node:path');

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function installRuntime(source, destination) {
  source = fs.realpathSync(source); destination = path.resolve(destination);
  let ancestor = destination;
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('目标符号链接没有有效目录，拒绝写入。');
    missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
  }
  const target = path.join(fs.realpathSync(ancestor), ...missing);
  if (inside(source, target) || inside(target, source)) throw new Error('工具源目录与安装目录不能相同或互相嵌套。');
  destination = target;
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory()) throw new Error('安装目标不是目录。');
    if (fs.readdirSync(destination).length) {
      const pkg = path.join(destination, 'package.json');
      if (!fs.existsSync(pkg) || fs.lstatSync(pkg).isSymbolicLink() || JSON.parse(fs.readFileSync(pkg, 'utf8')).name !== 'b2b-training-video') {
        throw new Error('非空目标目录不是培训工具目录，拒绝覆盖。');
      }
    }
    if (fs.existsSync(path.join(destination, 'output', '.produce.lock'))) throw new Error('工具目录仍有执行锁，请结束任务并核对锁后再升级。');
  }
  const files = ['package.json', 'requirements.txt'];
  function collect(rel) {
    const full = path.join(source, rel), info = fs.lstatSync(full);
    if (info.isSymbolicLink()) throw new Error('工具源文件不能使用符号链接：' + rel);
    if (info.isDirectory()) for (const item of fs.readdirSync(full)) collect(path.join(rel, item));
    else if (info.isFile()) files.push(rel);
    else throw new Error('工具源文件类型不受支持：' + rel);
  }
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (/\.(js|cjs|py)$/.test(item.name)) collect(item.name);
  }
  for (const dir of ['adapters', 'app', 'prompts', 'tools', 'demo']) collect(dir);
  const entries = files.map(rel => ({ rel, source: rel }));
  entries.push({ rel: 'script.yaml', source: 'script.yaml', preserve: true },
    { rel: path.join('examples', 'script.yaml'), source: 'script.yaml', preserve: true, relocateDemo: true },
    { rel: path.join('examples', 'authenticated.yaml'), source: path.join('examples', 'authenticated.yaml'), preserve: true });
  // 写入之前检查所有覆盖路径，防止目标子目录链接把写入引到其他位置。
  for (const { rel, source: sourceRel } of entries) {
    const file = path.join(destination, rel);
    for (let current = file; current !== destination; current = path.dirname(current)) {
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('安装目标包含符号链接，拒绝覆盖：' + rel);
    }
    const sourceFile = path.join(source, sourceRel);
    for (let current = sourceFile; current !== source; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('工具源文件不能使用符号链接：' + sourceRel);
    }
    if (!fs.statSync(sourceFile).isFile()) throw new Error('缺少常规工具源文件：' + sourceRel);
    if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error('工具目标文件被目录占用：' + rel);
  }
  for (const { rel, source: sourceRel, preserve, relocateDemo } of entries) {
    const file = path.join(destination, rel);
    if (preserve && fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sourceFile = path.join(source, sourceRel);
    if (relocateDemo) fs.writeFileSync(file, fs.readFileSync(sourceFile, 'utf8').replace('url: ./demo/demo.html', 'url: ../demo/demo.html'), 'utf8');
    else fs.copyFileSync(sourceFile, file);
  }
  return destination;
}

module.exports = { installRuntime };
if (require.main === module) {
  if (process.argv.length !== 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('用法：node install-runtime.js <工具目录>\n更新工具代码；保留已有 YAML、output、node_modules 和 assets。');
    process.exitCode = process.argv.length === 3 ? 0 : 2;
  } else {
    try { console.log('工具包已更新：' + installRuntime(__dirname, process.argv[2])); }
    catch (error) { console.error('[安装失败] ' + error.message); process.exitCode = 2; }
  }
}
