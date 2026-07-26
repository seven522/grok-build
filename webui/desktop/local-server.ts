import { createReadStream, existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import httpProxy from 'http-proxy'
import { createProjectRegistry, projectRegistryMiddleware } from '../project-registry.ts'
import { createProjectRunnerManager, projectRunnerMiddleware } from '../project-runner.ts'
import { automationControlPlaneMiddleware, createAutomationControlPlane } from '../automation-control-plane.ts'
import { resolveAgentRuntimeEnvironment, type RuntimeModelAvailability } from './agent-runtime.ts'
import { sessionCatalogMiddleware, sessionMediaMiddleware } from '../session-catalog.ts'
import { createSidebarPreferencesStore, sidebarPreferencesMiddleware } from '../sidebar-preferences.ts'
import { createTaskEventLedger, taskEventLedgerMiddleware } from '../task-event-ledger.ts'
import { TaskWorkspaceConflictError, TaskWorkspaceNotFoundError, createTaskWorkspaceStore, taskWorkspaceMiddleware } from '../task-workspace-store.ts'
import { createProviderRegistry } from '../provider-registry.ts'
import { createP2ControlPlane } from '../p2-control-plane.ts'

type RootConnection = { target: string; secret: string } | null

export type DesktopRuntimeState = 'starting' | 'listening' | 'failed'

export type DesktopInitializationSnapshot = {
  state: 'starting' | 'ready' | 'degraded'
  steps: Array<{
    id: 'workspace' | 'workbench' | 'agent'
    label: string
    state: 'pending' | 'running' | 'ready' | 'warning'
    detail?: string
  }>
}

export type LocalServerOptions = {
  distDir: string
  workspace: string
  modelProfile: string
  projectsRoot: string
  registryPath: string
  preferencesPath: string
  grokHome: string
  binaryPath: string
  authFallbackPaths?: string[]
  getAgentEnvironment?: () => NodeJS.ProcessEnv
  getRootConnection: () => RootConnection
  getRuntimeState: () => DesktopRuntimeState
  getRuntimeError: () => string | undefined
  getModelAvailability: () => RuntimeModelAvailability[]
  getInitializationSnapshot: () => DesktopInitializationSnapshot
  selectProjectDirectory?: () => Promise<string | null>
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const desktopSessionCookieName = 'runbuild_desktop_session'

const hasDesktopSession = (request: IncomingMessage, token: string) => (request.headers.cookie ?? '')
  .split(';')
  .map((entry) => entry.trim())
  .some((entry) => entry === `${desktopSessionCookieName}=${token}`)

const runMiddleware = (
  middleware: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void | Promise<void>,
  request: IncomingMessage,
  response: ServerResponse,
) => new Promise<boolean>((resolve, reject) => {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    resolve(true)
  }
  const next = (error?: unknown) => {
    if (settled) return
    settled = true
    response.off('finish', finish)
    if (error) reject(error)
    else resolve(false)
  }
  response.once('finish', finish)
  try {
    void Promise.resolve(middleware(request, response, next)).catch(next)
  } catch (error) {
    next(error)
  }
})

const staticPath = (distDir: string, requestPath: string) => {
  let decoded = '/'
  try { decoded = decodeURIComponent(requestPath) } catch { return null }
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = path.resolve(distDir, requested)
  const relative = path.relative(distDir, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return path.join(distDir, 'index.html')
}

export async function startLocalServer(options: LocalServerOptions) {
  const desktopSessionToken = randomBytes(32).toString('base64url')
  let expectedOrigin = ''
  const registry = createProjectRegistry({ projectsRoot: options.projectsRoot, registryPath: options.registryPath })
  const runnerManager = createProjectRunnerManager({
    registry,
    binaryPath: options.binaryPath,
    modelProfile: options.modelProfile,
    grokHome: options.grokHome,
    logsRoot: path.join(options.grokHome, 'runners'),
    getEnvironment: () => options.getAgentEnvironment?.() ?? resolveAgentRuntimeEnvironment(
      options.grokHome,
      process.env,
      options.authFallbackPaths,
    ),
  })
  const registryMiddleware = projectRegistryMiddleware(registry)
  const sessionCatalog = sessionCatalogMiddleware({ grokHome: options.grokHome, workspace: options.workspace, registry })
  const sessionMedia = sessionMediaMiddleware({ grokHome: options.grokHome, workspace: options.workspace, registry })
  const sidebarPreferences = sidebarPreferencesMiddleware(createSidebarPreferencesStore(options.preferencesPath))
  const taskEventLedger = createTaskEventLedger({ storageDir: path.join(options.grokHome, 'task-events') })
  const taskEventMiddleware = taskEventLedgerMiddleware(taskEventLedger)
  const automationControlPlane = createAutomationControlPlane({
    storageDir: path.join(options.grokHome, 'p3'),
    legacyStatePath: path.join(path.dirname(options.registryPath), 'automations.json'),
    taskEventLedger,
    projectExists: async (projectId) => (await registry.list()).some((project) => project.id === projectId),
  })
  const automationMiddleware = automationControlPlaneMiddleware(automationControlPlane)
  const providerRegistry = createProviderRegistry({ statePath: path.join(options.grokHome, 'webui', 'providers.json') })
  const p2ControlPlane = createP2ControlPlane({
    storageDir: path.join(options.grokHome, 'p2'),
    providerRegistry,
    taskEventLedger,
    getRuntimeModelAvailability: () => options.getModelAvailability(),
    projectExists: async (projectId) => (await registry.list()).some((project) => project.id === projectId),
    projectRules: async (projectId) => {
      if (!projectId) return []
      const project = (await registry.list()).find((entry) => entry.id === projectId)
      return project?.instructions ? [project.instructions] : []
    },
  })
  const taskWorkspace = taskWorkspaceMiddleware(createTaskWorkspaceStore({ storageDir: path.join(options.grokHome, 'task-workspaces') }), {
    assertProjectLifecycleAllowed: async (projectId, action) => {
      if (!(await registry.list()).some((project) => project.id === projectId)) throw new TaskWorkspaceNotFoundError('项目不存在')
      if (action === 'restore') return
      const runner = runnerManager.status(projectId)
      if (runner.state === 'starting' || runner.state === 'running') {
        throw new TaskWorkspaceConflictError('项目 Runner 仍在运行，不能归档或脱离项目')
      }
    },
  })
  const runnerMiddleware = projectRunnerMiddleware(runnerManager)
  const websocketProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true })
  websocketProxy.on('error', (_error, _request, socket) => {
    if (socket && 'destroy' in socket && typeof socket.destroy === 'function') socket.destroy()
  })

  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    const websocketOrigin = expectedOrigin.replace(/^http:/, 'ws:')
    response.setHeader('content-security-policy', `default-src 'self'; connect-src 'self' ${websocketOrigin}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:`)
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/') && !hasDesktopSession(request, desktopSessionToken)) {
        sendJson(response, 403, { error: 'Forbidden' })
        return
      }
      if (
        url.pathname.startsWith('/api/')
        && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')
        && request.headers.origin !== expectedOrigin
      ) {
        sendJson(response, 403, { error: 'Forbidden' })
        return
      }
      if (await runMiddleware(registryMiddleware, request, response)) return
      if (await runMiddleware(sessionCatalog, request, response)) return
      if (await runMiddleware(sessionMedia, request, response)) return
      if (await runMiddleware(sidebarPreferences, request, response)) return
      if (await runMiddleware(automationMiddleware, request, response)) return
      if (await runMiddleware(taskWorkspace, request, response)) return
      if (await runMiddleware(taskEventMiddleware, request, response)) return
      if (await runMiddleware(p2ControlPlane.middleware, request, response)) return
      if (await runMiddleware(runnerMiddleware, request, response)) return
      if (url.pathname === '/api/projects/pick-directory' && request.method === 'POST') {
        if (!options.selectProjectDirectory) {
          sendJson(response, 501, { error: '当前运行环境不支持系统文件夹选择器' })
          return
        }
        const rootPath = await options.selectProjectDirectory()
        sendJson(response, 200, rootPath ? { rootPath } : { cancelled: true })
        return
      }
      if (url.pathname === '/api/bridge-config' && request.method === 'GET') {
        const rootConnection = options.getRootConnection()
        const providerSnapshot = await providerRegistry.snapshot()
        sendJson(response, 200, {
          enabled: Boolean(rootConnection),
          path: '/acp',
          workspace: options.workspace,
          modelProfile: options.modelProfile,
          projectsRoot: options.projectsRoot,
          projectRunnerEnabled: existsSync(options.binaryPath),
          runtimeMode: 'desktop',
          runtimeState: options.getRuntimeState(),
          runtimeError: options.getRuntimeError(),
          modelAvailability: options.getModelAvailability(),
          providerRegistry: providerSnapshot,
          providerHealth: await providerRegistry.health(options.getModelAvailability()),
          initialization: options.getInitializationSnapshot(),
        })
        return
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        sendJson(response, 404, { error: 'Not found' })
        return
      }
      const filePath = staticPath(path.resolve(options.distDir), url.pathname)
      if (!filePath || !existsSync(filePath)) {
        sendJson(response, 404, { error: 'Desktop UI build not found' })
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream')
      if (path.basename(filePath) === 'index.html') {
        response.setHeader('set-cookie', `${desktopSessionCookieName}=${desktopSessionToken}; HttpOnly; SameSite=Strict; Path=/`)
      }
      if (request.method === 'HEAD') response.end()
      else createReadStream(filePath).pipe(response)
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : 'Local server error' })
      else response.destroy(error instanceof Error ? error : undefined)
    }
  })

  server.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== expectedOrigin || !hasDesktopSession(request, desktopSessionToken)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const projectId = url.pathname.match(/^\/acp\/projects\/([0-9a-f-]+)$/i)?.[1]
    const connection = projectId ? runnerManager.connection(projectId) : url.pathname === '/acp' ? options.getRootConnection() : null
    if (!connection) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    request.url = `/ws?server-key=${encodeURIComponent(connection.secret)}`
    websocketProxy.ws(request, socket, head, { target: connection.target, ws: true, changeOrigin: true })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Desktop local server did not bind to a TCP port')
  expectedOrigin = `http://127.0.0.1:${address.port}`
  await automationControlPlane.start()

  return {
    url: `http://127.0.0.1:${address.port}/?desktop=1`,
    stopActiveRunners: () => runnerManager.stopActive(),
    quiesceRunners: async () => {
      await runnerManager.quiesce()
      return () => runnerManager.resume()
    },
    stop: async () => {
      await automationControlPlane.stop()
      await runnerManager.stopAll()
      websocketProxy.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
