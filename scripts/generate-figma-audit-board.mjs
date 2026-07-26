import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const auditDir = path.join(root, 'webui', 'audit');
const output = path.join(auditDir, 'stillpoint-interaction-audit-board.svg');

const steps = [
  {
    file: 'interaction-01-baseline.jpg',
    index: '01',
    title: '基线：失败反馈不够可见',
    severity: 'P1 · 高影响',
    severityColor: '#ef6b73',
    lines: [
      '问题：错误与运行结果被挤在消息流中，用户难以判断操作是否生效。',
      '风险：离线时输入框锁死，草稿无法保留；长回复会把输入区推离视野。',
      '判定：需要直接修复，不改变产品方向。',
    ],
  },
  {
    file: 'interaction-05-feedback-clean.jpg',
    index: '02',
    title: '即时反馈：状态与错误可感知',
    severity: '已修复 · Healthy',
    severityColor: '#45d3c1',
    lines: [
      '改动：增加可关闭的状态 / 错误提示，并通过 aria-live 对读屏播报。',
      '改动：Runner 离线时仍允许编辑和保留草稿，仅禁止真实发送。',
      '结果：操作反馈及时明确，失败原因不再依赖翻找历史消息。',
    ],
  },
  {
    file: 'interaction-04-optimized-panel.jpg',
    index: '03',
    title: '上下文面板：状态来源可追溯',
    severity: '已修复 · Healthy',
    severityColor: '#45d3c1',
    lines: [
      '改动：右侧面板持续展示最近活动、项目、工具与 ACP 运行信息。',
      '交互：Escape 关闭面板，关闭后焦点返回触发按钮，避免键盘迷失。',
      '原则：只呈现真实业务状态，不伪造模型、权限或运行结果。',
    ],
  },
  {
    file: 'interaction-06-jump-to-latest.jpg',
    index: '04',
    title: '长回复：阅读位置由用户掌控',
    severity: '已修复 · Healthy',
    severityColor: '#45d3c1',
    lines: [
      '改动：消息区独立滚动，输入框固定；用户上滑后停止强制跟随。',
      '反馈：有新内容时显示“回到最新”，点击后恢复自动跟随。',
      '结果：长任务输出不会抢夺阅读位置，也不会把输入区推离视野。',
    ],
  },
];

const escapeXml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const imageData = await Promise.all(
  steps.map(async (step) => ({
    ...step,
    data: (await readFile(path.join(auditDir, step.file))).toString('base64'),
  })),
);

const width = 3440;
const height = 1040;
const cardWidth = 640;
const screenshotHeight = 360;
const gap = 200;
const startX = 80;
const screenshotY = 184;
const noteY = 568;

const cards = imageData.map((step, index) => {
  const x = startX + index * (cardWidth + gap);
  const textX = x + 24;
  return `
    <g id="step-${step.index}">
      <rect x="${x}" y="${screenshotY}" width="${cardWidth}" height="${screenshotHeight}" rx="14" fill="#15181d" stroke="#343943" stroke-width="2"/>
      <clipPath id="clip-${step.index}"><rect x="${x}" y="${screenshotY}" width="${cardWidth}" height="${screenshotHeight}" rx="12"/></clipPath>
      <image x="${x}" y="${screenshotY}" width="${cardWidth}" height="${screenshotHeight}" href="data:image/jpeg;base64,${step.data}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip-${step.index})"/>
      <rect x="${x}" y="${noteY}" width="${cardWidth}" height="236" rx="16" fill="#191c22" stroke="#292e36"/>
      <text x="${textX}" y="${noteY + 38}" class="eyebrow" fill="#9298a1">STEP ${step.index}</text>
      <text x="${textX}" y="${noteY + 78}" class="card-title" fill="#f3f5f5">${escapeXml(step.title)}</text>
      <rect x="${textX}" y="${noteY + 96}" width="${step.index === '01' ? 118 : 152}" height="30" rx="15" fill="${step.severityColor}" fill-opacity="0.14" stroke="${step.severityColor}" stroke-opacity="0.55"/>
      <text x="${textX + 14}" y="${noteY + 117}" class="chip" fill="${step.severityColor}">${escapeXml(step.severity)}</text>
      <text x="${textX}" y="${noteY + 154}" class="body" fill="#d7dbdf">
        ${step.lines.map((line, lineIndex) => `<tspan x="${textX}" dy="${lineIndex === 0 ? 0 : 27}">${escapeXml(line)}</tspan>`).join('')}
      </text>
    </g>`;
}).join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: "PingFang SC", "SF Pro Display", "Helvetica Neue", sans-serif; }
    .title { font-size: 38px; font-weight: 600; letter-spacing: -0.5px; }
    .subtitle { font-size: 17px; font-weight: 400; }
    .eyebrow { font-size: 13px; font-weight: 600; letter-spacing: 1.4px; }
    .card-title { font-size: 23px; font-weight: 600; }
    .chip { font-size: 13px; font-weight: 600; }
    .body { font-size: 15px; font-weight: 400; }
    .summary-title { font-size: 18px; font-weight: 600; }
    .summary-body { font-size: 14px; font-weight: 400; }
  </style>
  <rect width="${width}" height="${height}" rx="28" fill="#101216"/>
  <text x="80" y="76" class="title" fill="#f3f5f5">Stillpoint 交互优化审查</text>
  <text x="80" y="112" class="subtitle" fill="#9298a1">真实页面状态 · 2026-07-22 · 不重画 UI，只记录问题、改动与验证</text>
  <line x1="80" y1="144" x2="3360" y2="144" stroke="#292e36"/>
  ${cards}
  <rect x="80" y="846" width="3280" height="132" rx="16" fill="#15181d" stroke="#292e36"/>
  <text x="108" y="882" class="summary-title" fill="#f3f5f5">验证结论</text>
  <text x="108" y="914" class="summary-body" fill="#d7dbdf">Registry 3/3 · Runner 1/1 · Web UI 构建通过 · 浏览器控制台 0 error / 0 warning</text>
  <text x="108" y="944" class="summary-body" fill="#9298a1">待产品确认：真实模型切换与权限授权端到端验证受 MIMO_API_KEY / DEEPSEEK_API_KEY 缺失阻塞；设置中心留到下一任务。</text>
</svg>`;

await writeFile(output, svg);
console.log(output);
