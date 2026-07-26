import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import httpProxy from 'http-proxy'
import { createProjectRegistry, projectRegistryMiddleware } from './project-registry'
import { createProjectRunnerManager, projectRunnerMiddleware } from './project-runner'
import { automationControlPlaneMiddleware, createAutomationControlPlane } from './automation-control-plane'
import { DEFAULT_MODEL_PROFILE } from './model-profile'
import { inspectRuntimeModelAvailability } from './desktop/agent-runtime'
import { sessionCatalogMiddleware, sessionMediaMiddleware } from './session-catalog'
import { createTaskEventLedger, taskEventLedgerMiddleware } from './task-event-ledger'
import { createProviderRegistry } from './provider-registry'
import { createP2ControlPlane } from './p2-control-plane'

const bridgeEnabled = process.env.PERSONAL_AGENT_BRIDGE_ENABLED === '1'
const bridgeSecret = process.env.PERSONAL_AGENT_BRIDGE_SECRET
const bridgeTarget = process.env.PERSONAL_AGENT_BRIDGE_TARGET ?? 'ws://127.0.0.1:2419'
const workspace = process.env.PERSONAL_AGENT_WORKSPACE ?? ''
const modelProfile = process.env.PERSONAL_AGENT_MODEL_PROFILE ?? DEFAULT_MODEL_PROFILE
const projectsRoot = process.env.PERSONAL_AGENT_PROJECTS_ROOT ?? path.resolve(process.cwd(), '../.personal-grok/projects')
const projectRegistryPath = process.env.PERSONAL_AGENT_PROJECT_REGISTRY ?? path.resolve(process.cwd(), '../.personal-grok/webui/projects.json')
const projectRegistry = createProjectRegistry({ projectsRoot, registryPath: projectRegistryPath })
const grokHome = process.env.GROK_HOME ?? path.resolve(process.cwd(), '../.personal-grok')
const taskEventLedger = createTaskEventLedger({ storageDir: path.join(grokHome, 'task-events') })
// Dev previews expose the same control-plane API as desktop, but deliberately
// do not start its timer.  A browser preview must never enqueue real work just
// because Vite was opened while inspecting the UI.
const automationControlPlane = createAutomationControlPlane({
  storageDir: path.join(grokHome, 'p3'),
  legacyStatePath: process.env.PERSONAL_AGENT_AUTOMATIONS ?? path.resolve(process.cwd(), '../.personal-grok/webui/automations.json'),
  taskEventLedger,
  projectExists: async (projectId) => (await projectRegistry.list()).some((project) => project.id === projectId),
})
const modelAvailability = inspectRuntimeModelAvailability(grokHome)
const providerRegistry = createProviderRegistry({ statePath: path.join(grokHome, 'webui', 'providers.json') })
const p2ControlPlane = createP2ControlPlane({
  storageDir: path.join(grokHome, 'p2'),
  providerRegistry,
  taskEventLedger,
  getRuntimeModelAvailability: () => modelAvailability,
  projectExists: async (projectId) => (await projectRegistry.list()).some((project) => project.id === projectId),
  projectRules: async (projectId) => {
    if (!projectId) return []
    const project = (await projectRegistry.list()).find((entry) => entry.id === projectId)
    return project?.instructions ? [project.instructions] : []
  },
})
const runnerManager = createProjectRunnerManager({
  registry: projectRegistry,
  binaryPath: process.env.PERSONAL_AGENT_BINARY ?? '/tmp/grok-build-target/debug/xai-grok-pager',
  modelProfile,
  grokHome,
  logsRoot: path.join(grokHome, 'runners'),
})

const projectIdFromAcpPath = (value: string) => value.match(/^\/acp\/projects\/([0-9a-f-]+)/i)?.[1] ?? null
const projectWebSocketProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true })
const execFileAsync = promisify(execFile)
let projectDirectoryPickerActive = false

type PickerError = Error & { stderr?: string | Buffer }

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

const pickerWasCancelled = (error: unknown) => {
  const details = error instanceof Error
    ? `${error.message} ${String((error as PickerError).stderr ?? '')}`
    : String(error)
  return /\(-128\)|user canceled|用户取消/i.test(details)
}

const isSameOriginPickerRequest = (request: IncomingMessage) => {
  const origin = request.headers.origin
  const host = request.headers.host
  if (!origin || !host) return false
  try { return new URL(origin).host === host } catch { return false }
}

const chooseMacProjectDirectory = async () => {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "选择项目文件夹")',
  ], { encoding: 'utf8', timeout: 300_000 })
  const rootPath = stdout.trim()
  if (!rootPath) throw new Error('没有返回所选文件夹')
  return rootPath
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'personal-agent-bridge-config',
      configureServer(server) {
        server.middlewares.use(projectRegistryMiddleware(projectRegistry))
        server.middlewares.use(sessionCatalogMiddleware({ grokHome, workspace, registry: projectRegistry }))
        server.middlewares.use(sessionMediaMiddleware({ grokHome, workspace, registry: projectRegistry }))
        server.middlewares.use(automationControlPlaneMiddleware(automationControlPlane))
        server.middlewares.use(taskEventLedgerMiddleware(taskEventLedger))
        server.middlewares.use(p2ControlPlane.middleware)
        server.middlewares.use(projectRunnerMiddleware(runnerManager))
        server.middlewares.use('/api/projects/pick-directory', async (request, response) => {
          if (request.method !== 'POST') {
            response.setHeader('allow', 'POST')
            sendJson(response, 405, { error: 'Method not allowed' })
            return
          }
          if (process.platform !== 'darwin') {
            sendJson(response, 501, { error: '当前系统不支持系统文件夹选择器' })
            return
          }
          if (!isSameOriginPickerRequest(request)) {
            sendJson(response, 403, { error: '仅允许当前本地预览发起文件夹选择' })
            return
          }
          if (projectDirectoryPickerActive) {
            sendJson(response, 409, { error: '文件夹选择器已打开' })
            return
          }
          projectDirectoryPickerActive = true
          try {
            const rootPath = await chooseMacProjectDirectory()
            sendJson(response, 200, { rootPath })
          } catch (error) {
            if (pickerWasCancelled(error)) sendJson(response, 200, { cancelled: true })
            else sendJson(response, 500, { error: error instanceof Error ? error.message : '无法打开文件夹选择器' })
          } finally {
            projectDirectoryPickerActive = false
          }
        })
        const upgradeProjectRunner = (request: Parameters<NonNullable<typeof server.httpServer>['emit']>[1], socket: Parameters<NonNullable<typeof server.httpServer>['emit']>[2], head: Parameters<NonNullable<typeof server.httpServer>['emit']>[3]) => {
          const projectId = projectIdFromAcpPath(request.url ?? '')
          if (!projectId) return
          const connection = runnerManager.connection(projectId)
          if (!connection) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
            return
          }
          request.url = `/ws?server-key=${encodeURIComponent(connection.secret)}`
          projectWebSocketProxy.ws(request, socket, head, { target: connection.target, ws: true, changeOrigin: true })
        }
        server.httpServer?.prependListener('upgrade', upgradeProjectRunner)
        server.httpServer?.once('close', () => {
          server.httpServer?.removeListener('upgrade', upgradeProjectRunner)
          void runnerManager.stopAll()
          projectWebSocketProxy.close()
        })
        server.middlewares.use('/api/bridge-config', async (_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            enabled: bridgeEnabled && Boolean(bridgeSecret),
            path: '/acp',
            workspace,
            modelProfile,
            modelAvailability,
            projectsRoot,
            projectRunnerEnabled: bridgeEnabled,
            runtimeMode: 'web',
            providerRegistry: await providerRegistry.snapshot(),
            providerHealth: await providerRegistry.health(modelAvailability),
          }))
        })
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  server: {
    proxy: bridgeEnabled && bridgeSecret
      ? {
          '/acp': {
            target: bridgeTarget,
            changeOrigin: true,
            ws: true,
            rewrite: () => `/ws?server-key=${encodeURIComponent(bridgeSecret)}`,
          },
        }
      : undefined,
  },
})
