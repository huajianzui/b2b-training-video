#!/usr/bin/env node
/**
 * 操作手册生成（Word）
 *
 * 输入：当前 YAML + output/manual/record/steps.json（正式录制的步骤和截图）
 * --rehearsal 使用 output/manual/rehearsal/steps.json，生成独立的演练手册
 * 输出：output/<手册标题>.docx
 *
 * 和视频出自同一份 script.yaml：场景 → 小节，旁白 → 说明，动作 → 编号步骤，断言 → 操作结果。
 * 系统改版后重跑一次，视频和手册一起更新，内容不会对不上。
 *
 * 用法：
 *   node manual.js <脚本.yaml> [--rehearsal]
 */

const CLI = require('./cli').readCli({
  usage: '用法：node manual.js [脚本.yaml] [--rehearsal]\n'
    + '  默认使用正式录制素材；--rehearsal 生成独立演练手册；--post 校验原录制来源后更正文案。',
  options: { rehearsal: { type: 'boolean' }, post: { type: 'boolean' } },
  validate: ({ values }) => { if (values.post && values.rehearsal) throw new Error('--post 只使用正式录制素材'); }
});

const fs = require('fs');
const path = require('path');
const { requireFrom } = require('./deps');
const { loadScript, DEFAULT_OUT: SCRIPT_JSON } = require('./script');
const { executionHash } = require('./requests');
const { acquireLock } = require('./lock');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, ShadingType, PageNumber, PageBreak, TableOfContents,
} = requireFrom('docx');

const HERE = __dirname;
const OUT = path.join(HERE, 'output');
const STAGE = CLI.values.rehearsal ? 'rehearsal' : 'record';
const STEPS_JSON = path.join(OUT, 'manual', STAGE, 'steps.json');

const FONT = { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei', cs: 'Microsoft YaHei' };
const ACCENT = '2F7FD0';
const GREY = '86909C';
const PAGE = { width: 11906, height: 16838, margin: 1440 };   // A4，四边 1 英寸
const IMG = { width: 600, height: 338 };                       // 内容区宽约 602px，截图 16:9

// ---------------------------------------------------------------- 文案

const bracket = (s) => '【' + s + '】';
const quote = (s) => '「' + s + '」';

/** 把一个动作写成手册里的一句话；返回 null 表示这一步不进手册（纯等待、跳转地址这类读者不需要的） */
function stepText(st) {
  const name = st.label || st.name || '';
  const N = name ? bracket(name) : '';
  switch (st.op) {
    case 'click': {
      const byKind = { button: '点击' + N + '按钮', menu: '点击菜单' + N, link: '点击' + N + '链接', tab: '切换到' + N + '标签页' };
      return (N && byKind[st.kind]) || '点击' + (N || '目标位置');
    }
    case 'fill': return '在' + N + '输入框中输入' + quote(st.text);
    case 'select': return '在' + N + '下拉框中选择' + quote(st.value);
    case 'hover': return null;
    case 'waitFor': return null;
    case 'press': return '按下键盘' + bracket(st.key) + '键';
    case 'goto': return null;
    case 'scroll': return st.y > 0 ? '向下滚动页面' : '向上滚动页面';
    case 'wait': return null;
    default: throw new Error('手册不认识的动作：' + st.op);
  }
}

function resultText(expects) {
  return expects.map((e) => {
    switch (e.kind) {
      case 'text': return '页面中显示' + quote(e.text);
      case 'visible': return '页面出现' + (e.name && e.name.length <= 12 ? bracket(e.name) : '对应内容');
      case 'hidden': return '窗口关闭';
      case 'disabled': return (e.name && e.name.length <= 12 ? bracket(e.name) : '对应控件') + '不可修改';
      case 'url': return '页面跳转到对应页面';
      default: throw new Error('手册不认识的断言：' + e.kind);
    }
  }).join('，') + '。';
}

// ---------------------------------------------------------------- 排版积木

const run = (text, opts = {}) => new TextRun(Object.assign({ text, font: FONT }, opts));
const para = (text, opts = {}) => new Paragraph(Object.assign({ spacing: { after: 120, line: 360 }, children: [run(text)] }, opts));
const heading = (text, level) => new Paragraph({ heading: level, children: [run(text)] });

function image(file, caption, figNo) {
  const abs = path.join(HERE, file);
  if (!fs.existsSync(abs)) return [];
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 60 },
      children: [new ImageRun({
        type: 'png',
        data: fs.readFileSync(abs),
        transformation: IMG,
        altText: { title: caption, description: caption, name: path.basename(file) },
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [run('图 ' + figNo + '  ' + caption, { size: 18, color: GREY })],
    }),
  ];
}

function tipBox(tips) {
  return tips.map((t, i) => new Paragraph({
    shading: { fill: 'FFF7E8', type: ShadingType.CLEAR },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'E8A33D', space: 8 } },
    spacing: { before: i === 0 ? 120 : 0, after: i === tips.length - 1 ? 240 : 0, line: 340 },
    indent: { left: 200, right: 200 },
    children: [run(i === 0 ? '提示：' : '', { bold: true, color: 'B4700D' }), run(t)],
  }));
}

// ---------------------------------------------------------------- 组装

function build(script, material) {
  const byId = Object.fromEntries(material.scenes.map((s) => [s.id, s]));
  const m = script.manual;
  const numbering = [{
    reference: 'bullets',
    levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
  }];
  let fig = 0;

  const cover = [
    new Paragraph({ spacing: { before: 3600 }, children: [] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 }, children: [run(m.title, { size: 52, bold: true })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACCENT, space: 12 } },
      indent: { left: 2400, right: 2400 },
      children: [],
    }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 360 },
      children: [run((script.intro && script.intro.subtitle) || m.audience || '', { size: 28, color: GREY })] }),
    new Paragraph({ spacing: { before: 4800 }, children: [] }),
    ...(m.version ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('版本：' + m.version, { color: GREY })] })] : []),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [run('生成日期：' + new Date().toLocaleDateString('zh-CN'), { color: GREY })] }),
    ...(script.watermark ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [run(script.watermark, { color: GREY })] })] : []),
  ];

  const body = [
    new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [new PageBreak()] }),
    heading('1 概述', HeadingLevel.HEADING_1),
  ];
  const overview = m.overview || (script.intro && script.intro.narration);
  if (overview) body.push(para(overview));
  if (m.audience) body.push(para('适用对象：' + m.audience));
  const shared = script.features ? script.features.shared : [];
  if (shared.length) {
    body.push(para('本手册只介绍本模块特有的操作。' + shared.map((f) => quote(f.name)).join('、')
      + '等通用操作的方法与系统其他页面相同，请参阅《' + script.sharedGuide + '》。'));
  }
  if (m.prerequisites.length) {
    body.push(heading('1.1 前置条件', HeadingLevel.HEADING_2));
    for (const p of m.prerequisites) body.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { line: 360 }, children: [run(p)] }));
  }

  body.push(heading('2 操作步骤', HeadingLevel.HEADING_1));
  script.scenes.forEach((scene, i) => {
    const mat = byId[scene.id] || { steps: [], result: null };
    body.push(heading('2.' + (i + 1) + ' ' + (scene.name || '步骤 ' + (i + 1)), HeadingLevel.HEADING_2));
    const desc = scene.doc.text || scene.narration;
    if (desc) body.push(para(desc));

    // 每个场景单独一套编号，从 1 重新开始
    const ref = 'steps-' + scene.id;
    numbering.push({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
    });
    for (const st of mat.steps) {
      const text = stepText(st);
      if (!text) continue;
      body.push(new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { before: 120, after: 60, line: 360 }, children: [run(text)] }));
      if (st.shot) body.push(...image(st.shot, text, ++fig));
    }

    if (mat.result) {
      body.push(new Paragraph({ spacing: { before: 120, after: 60, line: 360 },
        children: [run('操作结果：', { bold: true, color: ACCENT }), run(scene.doc.result || resultText(mat.result.expects))] }));
      body.push(...image(mat.result.shot, (scene.name || '') + '完成后的界面', ++fig));
    }
    if (scene.doc.tips.length) body.push(...tipBox(scene.doc.tips));
  });

  if (m.notes.length) {
    body.push(heading('3 补充说明', HeadingLevel.HEADING_1));
    for (const n of m.notes) body.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { line: 360 }, children: [run(n)] }));
  }

  const pageProps = {
    page: {
      size: { width: PAGE.width, height: PAGE.height },
      margin: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
    },
  };

  return new Document({
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, font: FONT },
          paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, font: FONT },
          paragraph: { spacing: { before: 300, after: 160 }, outlineLevel: 1 } },
      ],
    },
    numbering: { config: numbering },
    sections: [
      { properties: pageProps, children: cover },
      {
        properties: pageProps,
        headers: {
          default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
            children: [run(m.title, { size: 18, color: GREY })] })] }),
        },
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
            run('第 ', { size: 18, color: GREY }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY, font: FONT }),
            run(' 页', { size: 18, color: GREY }),
          ] })] }),
        },
        children: body,
      },
    ],
  });
}

async function main() {
  const source = CLI.positionals[0]
    || (fs.existsSync(SCRIPT_JSON) && JSON.parse(fs.readFileSync(SCRIPT_JSON, 'utf8')).source);
  if (!source) throw new Error('缺少 YAML 来源；请运行 node manual.js <脚本.yaml>。');
  const script = loadScript(path.resolve(HERE, source), { stage: STAGE });
  const release = acquireLock(OUT); process.once('exit', release);
  if (!fs.existsSync(STEPS_JSON)) throw new Error('缺少 ' + STAGE + ' 手册素材，请运行对应阶段的 play.js <脚本.yaml> --shots。');
  const material = JSON.parse(fs.readFileSync(STEPS_JSON, 'utf8'));
  const expected = CLI.values.post ? require('./pipeline').verifyCapture(OUT, script).execution : executionHash(script);
  if (material.stage !== STAGE || material.input !== expected) throw new Error('手册素材与当前脚本或执行阶段不匹配，请重新执行对应的 play.js --shots。');
  for (const s of material.scenes) for (const shot of [...s.steps.map((st) => st.shot), s.result && s.result.shot].filter(Boolean)) {
    const full = path.resolve(HERE, shot), relative = path.relative(path.dirname(STEPS_JSON), full);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(full)) throw new Error('手册截图缺失或不属于当前阶段：' + shot);
  }

  const name = script.manual.title.replace(/[\\/:*?"<>|]/g, '_').trim() + (STAGE === 'rehearsal' ? '（演练）' : '');
  if (STAGE === 'rehearsal') script.manual = { ...script.manual, title: name,
    notes: ['本文件来自演练分支；正式交付请使用正式录制后生成的操作手册。', ...script.manual.notes] };
  const file = path.join(OUT, name + '.docx');
  fs.writeFileSync(file, await Packer.toBuffer(build(script, material)));

  const steps = material.scenes.reduce((n, s) => n + s.steps.filter((st) => stepText(st)).length, 0);
  console.log('[完成] ' + path.relative(HERE, file) + '（' + script.scenes.length + ' 节，' + steps + ' 个步骤）');
}

main().catch((e) => {
  console.error('[手册生成失败] ' + e.message);
  process.exit(1);
});
