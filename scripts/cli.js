'use strict';
const { parseArgs } = require('node:util');

function readCli({ usage, options = {}, maxPositionals = 1, validate }, args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage + '\n  --help / -h  显示帮助，不执行任务');
    process.exit(0);
  }
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (parsed.positionals.length > maxPositionals) throw new Error('位置参数过多；只能指定用法中的文件。');
    for (const [name, value] of Object.entries(parsed.values)) {
      if (options[name].type === 'string' && !value.trim()) throw new Error('--' + name + ' 缺少参数。');
    }
    if (validate) validate(parsed);
    return parsed;
  } catch (error) {
    const label = error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? '未知选项' : '参数错误';
    console.error('[' + label + '] ' + error.message + '\n使用 --help 查看用法。');
    process.exit(2);
  }
}

module.exports = { readCli };
