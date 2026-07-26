import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const webuiRoot = path.resolve(import.meta.dirname, '..')
const sourceRoot = path.join(webuiRoot, 'src')
const modularRoots = ['components', 'features', 'lib']
const violations = []

const sourceFiles = async (root) => {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : []
  }))
  return nested.flat()
}

for (const rootName of modularRoots) {
  const root = path.join(sourceRoot, rootName)
  let files = []
  try { files = await sourceFiles(root) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const relative = path.relative(webuiRoot, file)
    if (/from\s+['"]@mantine\//.test(source)) {
      violations.push(`${relative}: modular code must not add Mantine imports`)
    }
    if (relative.startsWith('src/components/ui/') && /from\s+['"]@\/features\//.test(source)) {
      violations.push(`${relative}: UI primitives must not depend on feature modules`)
    }
    if (relative.startsWith('src/features/')) {
      const ownFeature = relative.split(path.sep)[2]
      for (const match of source.matchAll(/from\s+['"]@\/features\/([^/'"]+)/g)) {
        if (match[1] !== ownFeature) {
          violations.push(`${relative}: feature ${ownFeature} must not import feature ${match[1]}`)
        }
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(path.join(webuiRoot, 'package.json'), 'utf8'))
for (const dependency of ['@tailwindcss/vite', 'motion', 'tailwindcss']) {
  if (!packageJson.dependencies?.[dependency]) violations.push(`package.json: missing ${dependency}`)
}

const mainSource = await readFile(path.join(sourceRoot, 'main.tsx'), 'utf8')
if (!mainSource.includes("import './styles/aceternity.css'")) {
  violations.push('src/main.tsx: Aceternity theme bridge is not loaded')
}

if (violations.length) {
  console.error(`Frontend architecture contract failed:\n${violations.map((item) => `- ${item}`).join('\n')}`)
  process.exit(1)
}

console.log('Frontend architecture contract passed: Aceternity foundation and module boundaries are present.')
