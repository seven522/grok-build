import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const webuiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const [tokens, styles, main, html] = await Promise.all([
  readFile(resolve(webuiRoot, 'src/typography.css'), 'utf8'),
  readFile(resolve(webuiRoot, 'src/styles.css'), 'utf8'),
  readFile(resolve(webuiRoot, 'src/main.tsx'), 'utf8'),
  readFile(resolve(webuiRoot, 'index.html'), 'utf8'),
])

const failures = []

const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message)
}

const semanticTokens = [
  '--font-ui',
  '--font-mono',
  '--type-caption',
  '--type-label',
  '--type-body',
  '--type-body-lg',
  '--type-card-title',
  '--type-section-title',
  '--type-dialog-title',
  '--type-page-title',
  '--leading-ui',
  '--leading-body',
  '--leading-reading',
  '--leading-heading',
  '--weight-regular',
  '--weight-medium',
  '--weight-semibold',
  '--weight-bold',
]

for (const token of semanticTokens) {
  requireMatch(tokens, new RegExp(`${token.replaceAll('-', '\\-')}\\s*:`), `Missing typography token: ${token}`)
}

const findRawDeclarations = (property, allow = () => false) => {
  const pattern = new RegExp(`${property}\\s*:\\s*([^;}\\n]+)`, 'g')
  return [...styles.matchAll(pattern)]
    .map((match) => match[1].trim())
    .filter((value) => !allow(value))
}

const usesSemanticToken = (value) => value.includes('var(--') || ['inherit', 'initial', 'normal', 'unset', 'revert'].includes(value)

for (const property of ['font-size', 'font-weight', 'line-height']) {
  const raw = findRawDeclarations(property, usesSemanticToken)
  if (raw.length) failures.push(`${property} must use a semantic token: ${[...new Set(raw)].join(', ')}`)
}

const rawFontShorthand = [...styles.matchAll(/(?:^|[{;])\s*font\s*:\s*([^;}\n]+)/gm)]
  .map((match) => match[1].trim())
  .filter((value) => !['inherit', 'initial', 'unset', 'revert'].includes(value))
if (rawFontShorthand.length) failures.push(`Avoid font shorthand in component CSS: ${rawFontShorthand.join(', ')}`)

const rawMantineTypeProps = [...main.matchAll(/\b(?:fw|fz|lh)=\{([0-9.]+)\}/g)].map((match) => match[0])
if (rawMantineTypeProps.length) failures.push(`Mantine typography props must use semantic tokens or named sizes: ${[...new Set(rawMantineTypeProps)].join(', ')}`)

requireMatch(main, /import '\.\/typography\.css'/, 'main.tsx must import typography.css')
requireMatch(main, /fontFamily:\s*'var\(--font-ui\)'/, 'Mantine must use the shared UI font stack')
requireMatch(main, /fontSizes:\s*\{[\s\S]*?xs:\s*'var\(--type-caption\)'[\s\S]*?xl:\s*'var\(--type-card-title\)'/, 'Mantine font sizes must map to the semantic scale')
requireMatch(main, /headings:\s*\{[\s\S]*?h1:\s*\{\s*fontSize:\s*'var\(--type-page-title\)'/, 'Mantine headings must map to the semantic scale')
requireMatch(html, /<html\s+lang="zh-CN">/, 'index.html must declare the current document language')
requireMatch(tokens, /:lang\(zh-CN\)/, 'Simplified Chinese locale typography overrides are required')
requireMatch(tokens, /:lang\(zh-TW\)/, 'Traditional Chinese locale typography overrides are required')
requireMatch(tokens, /:lang\(ja\)/, 'Japanese locale typography overrides are required')
requireMatch(tokens, /:lang\(ko\)/, 'Korean locale typography overrides are required')

if (failures.length) {
  console.error('Typography contract failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Typography contract passed: semantic scale, Mantine mapping, and locale metadata are present.')
}
