const { existsSync } = require('node:fs')

const binaryPath = process.env.PERSONAL_AGENT_PACK_BINARY
if (!binaryPath || !existsSync(binaryPath)) {
  throw new Error('PERSONAL_AGENT_PACK_BINARY must point to a built xai-grok-pager executable')
}
module.exports = {
  appId: 'local.personal-agent.desktop',
  productName: 'RunBuild',
  asar: true,
  directories: { output: 'release' },
  afterPack: 'build/after-pack.cjs',
  afterSign: 'build/after-sign.cjs',
  files: ['dist/**/*', 'dist-desktop/**/*', 'package.json'],
  extraResources: [{ from: binaryPath, to: 'bin/xai-grok-pager' }],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    extendInfo: {
      NSMicrophoneUsageDescription: 'RunBuild 仅在你主动使用语音输入时访问麦克风，并将语音转换为当前任务文本。',
    },
    target: [{ target: 'dir', arch: ['arm64'] }],
  },
}
