import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type MediaAccessPermissionRequest,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type WebContents,
} from 'electron'
import { DEFAULT_MODEL_PROFILE } from '../model-profile'
import {
  ensureRuntimeConfig,
  inspectRuntimeModelAvailability,
  resolveAgentRuntimeEnvironment,
  startAgentRuntime,
  type AgentRuntime,
  type RuntimeModelAvailability,
} from './agent-runtime'
import { runCliOAuthLogin } from './auth-runtime'
import {
  collectDesktopDiagnosticPermissions,
  collectDesktopDiagnostics,
  createSingleFlight,
  isDesktopDiagnosticLogSource,
  isDesktopDiagnosticPermissionId,
  probeFullDiskAccess,
  readDesktopDiagnosticLogTail,
  requestDesktopDiagnosticPermission,
  sanitizeDiagnosticMessage,
  type DesktopDiagnosticPermissionAccess,
  type DesktopDiagnosticRestartResult,
  type DesktopDiagnosticsSnapshot,
  type FullDiskAccessState,
} from './diagnostics'
import { startLocalServer, type DesktopInitializationSnapshot, type DesktopRuntimeState } from './local-server'
import { installSingleInstanceGuard } from './single-instance'
import { resolveTrustedLocalResource } from './local-resource'
import { launchRegisteredGodotProject } from './godot-project-launch'
import { resolveDesktopUserDataPath } from './user-data-path'

type MicrophonePermissionState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-required'
type ScreenRecordingPermissionState = MicrophonePermissionState
type DesktopSetupMode = 'granted' | 'limited'
type StoredDesktopSetup = { version: number; mode: DesktopSetupMode; completedAt: string }
type DesktopSetupSnapshot = {
  platform: NodeJS.Platform
  onboarding: { version: number; completed: boolean; mode: DesktopSetupMode | null }
  microphone: {
    state: MicrophonePermissionState
    canRequest: boolean
    canOpenSettings: boolean
  }
  screenRecording: {
    state: ScreenRecordingPermissionState
    canOpenSettings: boolean
  }
  accessibility: {
    trusted: boolean
    canRequest: boolean
  }
  fullDiskAccess: {
    state: FullDiskAccessState
    canOpenSettings: boolean
  }
  allPermissionsGranted: boolean
}
type DesktopAuthResult = {
  state: 'authenticated'
  runtimeState: DesktopRuntimeState
  runtimeError?: string
  modelAvailability: RuntimeModelAvailability[]
}

type RunBuildPackageMetadata = {
  runBuild?: { authPath?: unknown }
}

const desktopSetupVersion = 1
const desktopSetupChannels = [
  'desktop-setup:get',
  'desktop-setup:request-microphone',
  'desktop-setup:open-microphone-settings',
  'desktop-setup:open-screen-recording-settings',
  'desktop-setup:request-accessibility',
  'desktop-setup:open-full-disk-access-settings',
  'desktop-setup:complete',
] as const
const desktopAuthChannels = ['xai-auth:login', 'xai-auth:cancel'] as const
const desktopDiagnosticsChannels = [
  'desktop-diagnostics:get',
  'desktop-diagnostics:log-tail',
  'desktop-diagnostics:permissions',
  'desktop-diagnostics:request-permission',
  'desktop-diagnostics:restart-agent',
] as const
const desktopResourceChannels = ['desktop-resource:open-local'] as const
const desktopProjectChannels = ['desktop-project:launch-godot'] as const

function packagedAuthPath(appRoot: string) {
  try {
    const metadata = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as RunBuildPackageMetadata
    const authPath = metadata.runBuild?.authPath
    return typeof authPath === 'string' && path.isAbsolute(authPath) ? authPath : undefined
  } catch {
    return undefined
  }
}


function readStoredDesktopSetup(statePath: string): StoredDesktopSetup | null {
  if (!existsSync(statePath)) return null
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StoredDesktopSetup>
    if (value.version !== desktopSetupVersion || (value.mode !== 'granted' && value.mode !== 'limited') || typeof value.completedAt !== 'string') return null
    return { version: value.version, mode: value.mode, completedAt: value.completedAt }
  } catch {
    return null
  }
}

function writeStoredDesktopSetup(statePath: string, mode: DesktopSetupMode) {
  mkdirSync(path.dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify({
    version: desktopSetupVersion,
    mode,
    completedAt: new Date().toISOString(),
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, statePath)
}

function microphonePermissionState(): MicrophonePermissionState {
  if (process.platform !== 'darwin') return 'not-required'
  try { return systemPreferences.getMediaAccessStatus('microphone') }
  catch { return 'unknown' }
}

function screenRecordingPermissionState(): ScreenRecordingPermissionState {
  if (process.platform !== 'darwin') return 'not-required'
  try { return systemPreferences.getMediaAccessStatus('screen') }
  catch { return 'unknown' }
}

function accessibilityTrusted(prompt = false) {
  if (process.platform !== 'darwin') return true
  try { return systemPreferences.isTrustedAccessibilityClient(prompt) }
  catch { return false }
}

async function openMacPrivacySettings(pane: 'Microphone' | 'ScreenCapture' | 'Accessibility' | 'AllFiles') {
  if (process.platform !== 'darwin') return
  try {
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`)
  } catch {
    await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension')
  }
}

function desktopSetupSnapshot(statePath: string): DesktopSetupSnapshot {
  const stored = readStoredDesktopSetup(statePath)
  const microphoneState = microphonePermissionState()
  const screenRecordingState = screenRecordingPermissionState()
  const accessibilityIsTrusted = accessibilityTrusted()
  const fullDiskAccessState = probeFullDiskAccess({ platform: process.platform, homeDirectory: app.getPath('home') })
  const allPermissionsGranted = (
    (microphoneState === 'granted' || microphoneState === 'not-required')
    && (screenRecordingState === 'granted' || screenRecordingState === 'not-required')
    && accessibilityIsTrusted
  )
  return {
    platform: process.platform,
    onboarding: {
      version: desktopSetupVersion,
      completed: Boolean(stored),
      mode: stored?.mode ?? null,
    },
    microphone: {
      state: microphoneState,
      canRequest: process.platform === 'darwin' && microphoneState === 'not-determined',
      canOpenSettings: process.platform === 'darwin' && (microphoneState === 'denied' || microphoneState === 'restricted'),
    },
    screenRecording: {
      state: screenRecordingState,
      canOpenSettings: process.platform === 'darwin' && screenRecordingState !== 'granted',
    },
    accessibility: {
      trusted: accessibilityIsTrusted,
      canRequest: process.platform === 'darwin' && !accessibilityIsTrusted,
    },
    fullDiskAccess: {
      state: fullDiskAccessState,
      canOpenSettings: process.platform === 'darwin' && fullDiskAccessState !== 'granted',
    },
    allPermissionsGranted,
  }
}

function hasExpectedOrigin(url: string, expectedOrigin: string) {
  try { return new URL(url).origin === expectedOrigin }
  catch { return false }
}

function assertTrustedDesktopIpc(event: IpcMainInvokeEvent, window: BrowserWindow, expectedOrigin: string) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL()
  if (
    event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame
    || !hasExpectedOrigin(senderUrl, expectedOrigin)
  ) {
    throw new Error('拒绝来自非工作台页面的桌面权限请求')
  }
}

function installDesktopSetupHandlers(window: BrowserWindow, expectedOrigin: string, statePath: string) {
  for (const channel of desktopSetupChannels) ipcMain.removeHandler(channel)
  ipcMain.handle('desktop-setup:get', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:request-microphone', async (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    const before = microphonePermissionState()
    if (process.platform === 'darwin' && before === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:open-microphone-settings', async (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    await openMacPrivacySettings('Microphone')
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:open-screen-recording-settings', async (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    await openMacPrivacySettings('ScreenCapture')
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:request-accessibility', async (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    const trusted = accessibilityTrusted(true)
    if (!trusted) await openMacPrivacySettings('Accessibility')
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:open-full-disk-access-settings', async (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    await openMacPrivacySettings('AllFiles')
    return desktopSetupSnapshot(statePath)
  })
  ipcMain.handle('desktop-setup:complete', (event, mode: DesktopSetupMode) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    if (mode !== 'granted' && mode !== 'limited') throw new Error('无效的初始化完成状态')
    const snapshot = desktopSetupSnapshot(statePath)
    if (mode === 'granted' && !snapshot.allPermissionsGranted) throw new Error('仍有系统权限未授权；完成授权后重试，或稍后配置')
    writeStoredDesktopSetup(statePath, mode)
    return desktopSetupSnapshot(statePath)
  })
  return () => {
    for (const channel of desktopSetupChannels) ipcMain.removeHandler(channel)
  }
}

function installDesktopAuthHandlers(
  window: BrowserWindow,
  expectedOrigin: string,
  actions: { login: () => Promise<DesktopAuthResult>; cancel: () => void },
) {
  for (const channel of desktopAuthChannels) ipcMain.removeHandler(channel)
  ipcMain.handle('xai-auth:login', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return actions.login()
  })
  ipcMain.handle('xai-auth:cancel', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    actions.cancel()
  })
  return () => {
    for (const channel of desktopAuthChannels) ipcMain.removeHandler(channel)
  }
}

function installDesktopDiagnosticsHandlers(
  window: BrowserWindow,
  expectedOrigin: string,
  actions: {
    getSnapshot: () => Promise<DesktopDiagnosticsSnapshot>
    getLogTail: (source: 'desktop-agent') => ReturnType<typeof readDesktopDiagnosticLogTail>
    getPermissions: () => ReturnType<typeof collectDesktopDiagnosticPermissions>
    requestPermission: (permission: Parameters<typeof requestDesktopDiagnosticPermission>[1]) => ReturnType<typeof requestDesktopDiagnosticPermission>
    restartAgent: () => Promise<DesktopDiagnosticRestartResult>
  },
) {
  for (const channel of desktopDiagnosticsChannels) ipcMain.removeHandler(channel)
  ipcMain.handle('desktop-diagnostics:get', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return actions.getSnapshot()
  })
  ipcMain.handle('desktop-diagnostics:log-tail', (event, source: unknown) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    if (source !== undefined && !isDesktopDiagnosticLogSource(source)) throw new Error('无效的诊断日志来源')
    return actions.getLogTail(source ?? 'desktop-agent')
  })
  ipcMain.handle('desktop-diagnostics:permissions', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return actions.getPermissions()
  })
  ipcMain.handle('desktop-diagnostics:request-permission', (event, permission: unknown) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    if (!isDesktopDiagnosticPermissionId(permission)) throw new Error('无效的 macOS 权限标识')
    return actions.requestPermission(permission)
  })
  ipcMain.handle('desktop-diagnostics:restart-agent', (event) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return actions.restartAgent()
  })
  return () => {
    for (const channel of desktopDiagnosticsChannels) ipcMain.removeHandler(channel)
  }
}

function installDesktopResourceHandlers(
  window: BrowserWindow,
  expectedOrigin: string,
  options: { workspace: string; registryPath: string },
) {
  for (const channel of desktopResourceChannels) ipcMain.removeHandler(channel)
  ipcMain.handle('desktop-resource:open-local', async (event, target: unknown) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    const resource = await resolveTrustedLocalResource({ target, ...options })
    const error = await shell.openPath(resource.path)
    if (error) throw new Error('系统无法打开这个文件')
    return { opened: true, kind: resource.kind }
  })
  return () => {
    for (const channel of desktopResourceChannels) ipcMain.removeHandler(channel)
  }
}

function installDesktopProjectHandlers(
  window: BrowserWindow,
  expectedOrigin: string,
  options: { registryPath: string; homeDirectory: string; configuredApplication?: string },
) {
  for (const channel of desktopProjectChannels) ipcMain.removeHandler(channel)
  ipcMain.handle('desktop-project:launch-godot', (event, projectId: unknown) => {
    assertTrustedDesktopIpc(event, window, expectedOrigin)
    return launchRegisteredGodotProject({
      projectId,
      registryPath: options.registryPath,
      platform: process.platform,
      homeDirectory: options.homeDirectory,
      configuredApplication: options.configuredApplication,
    })
  })
  return () => {
    for (const channel of desktopProjectChannels) ipcMain.removeHandler(channel)
  }
}

function installRendererPermissionBoundary(window: BrowserWindow, expectedOrigin: string) {
  const microphoneIsAvailable = () => {
    const state = microphonePermissionState()
    return state === 'granted' || state === 'not-required'
  }
  const isTrustedRenderer = (webContents: WebContents | null, url: string) => (
    webContents === window.webContents && hasExpectedOrigin(url, expectedOrigin)
  )
  window.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    permission === 'media'
    && details.isMainFrame
    && details.mediaType === 'audio'
    && isTrustedRenderer(webContents, details.requestingUrl || details.securityOrigin || requestingOrigin)
    && microphoneIsAvailable()
  ))
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaDetails = details as MediaAccessPermissionRequest
    const audioOnly = mediaDetails.mediaTypes?.length === 1 && mediaDetails.mediaTypes[0] === 'audio'
    callback(Boolean(
      permission === 'media'
      && mediaDetails.isMainFrame
      && audioOnly
      && isTrustedRenderer(webContents, mediaDetails.requestingUrl || mediaDetails.securityOrigin || '')
      && microphoneIsAvailable(),
    ))
  })
  return () => {
    window.webContents.session.setPermissionCheckHandler(null)
    window.webContents.session.setPermissionRequestHandler(null)
  }
}

function installMenu(window: BrowserWindow) {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: 'RunBuild',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '重新载入', accelerator: 'CmdOrCtrl+R', click: () => window.reload() }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let stopping = false
let stopAll: (() => Promise<void>) | null = null
let mainWindow: BrowserWindow | null = null
let focusExistingWindowRequested = false

const focusPrimaryWindow = () => {
  focusExistingWindowRequested = true
  const window = mainWindow
  if (!window) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

app.setName('RunBuild')
const userDataPath = resolveDesktopUserDataPath({
  appDataPath: app.getPath('appData'),
  explicitPath: process.env.PERSONAL_AGENT_USER_DATA,
  isPackaged: app.isPackaged,
  importLegacy: process.env.PERSONAL_AGENT_IMPORT_LEGACY_USER_DATA === '1',
  pathExists: existsSync,
})
mkdirSync(userDataPath, { recursive: true })
app.setPath('userData', userDataPath)

const primaryInstance = installSingleInstanceGuard({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  on: (_event, listener) => { app.on('second-instance', listener) },
}, focusPrimaryWindow)

app.whenReady().then(async () => {
  if (!primaryInstance) return
  const appRoot = app.getAppPath()
  const repositoryRoot = path.resolve(appRoot, '..')
  const workspace = process.env.PERSONAL_AGENT_WORKSPACE ?? (app.isPackaged ? path.join(app.getPath('userData'), 'workspace') : repositoryRoot)
  const grokHome = process.env.GROK_HOME ?? (app.isPackaged ? path.join(app.getPath('userData'), 'runtime') : path.join(repositoryRoot, '.personal-grok'))
  const binaryPath = process.env.PERSONAL_AGENT_BINARY ?? (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'xai-grok-pager') : '/tmp/grok-build-target/debug/xai-grok-pager')
  const modelProfile = process.env.PERSONAL_AGENT_MODEL_PROFILE ?? DEFAULT_MODEL_PROFILE
  const authFallbackPaths = app.isPackaged
    ? [packagedAuthPath(appRoot), path.join(app.getPath('home'), '.grok', 'auth.json')].filter((candidate): candidate is string => Boolean(candidate))
    : []
  mkdirSync(workspace, { recursive: true })
  ensureRuntimeConfig(grokHome, modelProfile)
  const canonicalAuthPath = path.join(grokHome, 'auth.json')
  let desktopAuthPath: string | null = null
  const getAgentEnvironment = () => {
    const environment = resolveAgentRuntimeEnvironment(grokHome, process.env, authFallbackPaths)
    if (desktopAuthPath) {
      for (const key of ['GROK_AUTH', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_DEPLOYMENT_KEY']) delete environment[key]
      environment.GROK_AUTH_PATH = desktopAuthPath
    }
    return environment
  }

  let runtime: AgentRuntime | null = null
  let runtimeOperation: Promise<AgentRuntime> | null = null
  let runtimeAbortController: AbortController | null = null
  let stopRuntimePromise: Promise<void> | null = null
  let runtimeGeneration = 0
  let runtimeState: DesktopRuntimeState = 'starting'
  let runtimeError: string | undefined
  let modelAvailability = inspectRuntimeModelAvailability(grokHome, getAgentEnvironment())
  let workbenchReady = false
  const publishRuntime = (nextRuntime: AgentRuntime) => {
    runtime = nextRuntime
    runtimeError = nextRuntime.error
    runtimeState = nextRuntime.connection ? 'listening' : 'failed'
    modelAvailability = nextRuntime.modelAvailability
  }
  const launchRuntime = () => {
    const generation = ++runtimeGeneration
    const controller = new AbortController()
    runtimeAbortController = controller
    runtimeState = 'starting'
    runtimeError = undefined
    modelAvailability = inspectRuntimeModelAvailability(grokHome, getAgentEnvironment())
    let operation!: Promise<AgentRuntime>
    operation = startAgentRuntime({
      binaryPath,
      workspace,
      grokHome,
      modelProfile,
      environment: getAgentEnvironment(),
      authFallbackPaths,
      signal: controller.signal,
      onStateChange: (nextRuntime) => {
        if (generation === runtimeGeneration) publishRuntime(nextRuntime)
      },
    }).catch((error): AgentRuntime => ({
      connection: null,
      error: error instanceof Error ? error.message : String(error),
      modelAvailability,
      stop: async () => undefined,
    })).then((result) => {
      if (generation === runtimeGeneration) publishRuntime(result)
      return result
    })
    runtimeOperation = operation
    return operation
  }
  const stopRuntime = () => {
    if (stopRuntimePromise) return stopRuntimePromise
    stopRuntimePromise = (async () => {
      ++runtimeGeneration
      const controller = runtimeAbortController
      const operation = runtimeOperation
      runtimeAbortController = null
      runtimeOperation = null
      controller?.abort()
      const activeRuntime = operation ? await operation.catch(() => runtime) : runtime
      await activeRuntime?.stop()
      if (runtime === activeRuntime) runtime = null
    })().finally(() => { stopRuntimePromise = null })
    return stopRuntimePromise
  }
  const getInitializationSnapshot = (): DesktopInitializationSnapshot => ({
    state: runtimeState === 'starting' || !workbenchReady
      ? 'starting'
      : runtimeState === 'listening' ? 'ready' : 'degraded',
    steps: [
      { id: 'workspace', label: '准备本地工作区', state: 'ready' },
      { id: 'workbench', label: '启动桌面工作台', state: workbenchReady ? 'ready' : 'running' },
      {
        id: 'agent',
        label: '连接本地 Agent',
        state: runtimeState === 'starting' ? 'running' : runtimeState === 'listening' ? 'ready' : 'warning',
        detail: runtimeState === 'failed' ? runtimeError : undefined,
      },
    ],
  })
  const projectDirectoryDialog: OpenDialogOptions = {
    title: '选择项目文件夹',
    buttonLabel: '打开',
    properties: ['openDirectory', 'createDirectory'],
  }
  const registryPath = path.join(grokHome, 'webui', 'projects.json')
  const localServer = await startLocalServer({
    distDir: path.join(appRoot, 'dist'),
    workspace,
    modelProfile,
    projectsRoot: path.join(grokHome, 'projects'),
    registryPath,
    preferencesPath: path.join(app.getPath('userData'), 'sidebar-preferences.json'),
    grokHome,
    binaryPath,
    authFallbackPaths,
    getAgentEnvironment,
    getRootConnection: () => runtime?.connection ?? null,
    getRuntimeState: () => runtimeState,
    getRuntimeError: () => runtimeError,
    getModelAvailability: () => modelAvailability,
    getInitializationSnapshot,
    selectProjectDirectory: async () => {
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, projectDirectoryDialog)
        : await dialog.showOpenDialog(projectDirectoryDialog)
      return result.canceled ? null : result.filePaths[0] ?? null
    },
  })
  const diagnosticPermissionAccess: DesktopDiagnosticPermissionAccess = {
    platform: process.platform,
    microphoneState: microphonePermissionState,
    screenRecordingState: screenRecordingPermissionState,
    accessibilityTrusted,
    fullDiskAccessState: () => probeFullDiskAccess({ platform: process.platform, homeDirectory: app.getPath('home') }),
    requestMicrophone: async () => {
      if (process.platform !== 'darwin' || microphonePermissionState() !== 'not-determined') return false
      try { return await systemPreferences.askForMediaAccess('microphone') }
      catch { return false }
    },
  }
  const getDiagnosticsSnapshot = () => collectDesktopDiagnostics({
    workspace,
    grokHome,
    userDataPath: app.getPath('userData'),
    modelProfile,
    runtimeState,
    runtimeConnected: Boolean(runtime?.connection),
    runtimeError,
    modelAvailability,
    permissionAccess: diagnosticPermissionAccess,
  })
  let removeDesktopSetupHandlers: () => void = () => undefined
  let removeDesktopAuthHandlers: () => void = () => undefined
  let removeDesktopDiagnosticsHandlers: () => void = () => undefined
  let removeDesktopResourceHandlers: () => void = () => undefined
  let removeDesktopProjectHandlers: () => void = () => undefined
  let removeRendererPermissionBoundary: () => void = () => undefined
  let loginAbortController: AbortController | null = null
  let loginPromise: Promise<DesktopAuthResult> | null = null
  const login = () => {
    if (loginPromise) return loginPromise
    const controller = new AbortController()
    loginAbortController = controller
    let runtimeStoppedForCommit = false
    let resumeProjectRunners: () => void = () => undefined
    const operation = (async (): Promise<DesktopAuthResult> => {
      try {
        await runCliOAuthLogin({
          binaryPath,
          workspace,
          grokHome,
          environment: process.env,
          signal: controller.signal,
          beforeCommit: async () => {
            resumeProjectRunners = await localServer.quiesceRunners()
            await stopRuntime()
            runtimeStoppedForCommit = true
          },
        })
        desktopAuthPath = canonicalAuthPath
        const nextRuntime = await launchRuntime()
        return {
          state: 'authenticated',
          runtimeState: nextRuntime.connection ? 'listening' : 'failed',
          runtimeError: nextRuntime.error,
          modelAvailability: nextRuntime.modelAvailability,
        }
      } catch (error) {
        if (runtimeStoppedForCommit && !stopping) await launchRuntime()
        throw error
      } finally {
        resumeProjectRunners()
      }
    })().finally(() => {
      if (loginAbortController === controller) loginAbortController = null
      if (loginPromise === operation) loginPromise = null
    })
    loginPromise = operation
    return operation
  }
  let restartAgentPromise: Promise<DesktopDiagnosticRestartResult> | null = null
  const runRestartAgent = createSingleFlight(async (): Promise<DesktopDiagnosticRestartResult> => {
    if (stopping || loginPromise) {
      return {
        status: 'blocked',
        error: stopping ? '应用正在退出，已取消 Agent 重启' : '正在完成 Agent 登录，完成后再重启',
        snapshot: await getDiagnosticsSnapshot(),
      }
    }
    try {
      // This only rotates the local root Agent process. It reuses the existing
      // environment/auth selection and does not write provider credentials or project files.
      await stopRuntime()
      if (stopping) {
        return {
          status: 'blocked',
          error: '应用正在退出，已取消 Agent 重启',
          snapshot: await getDiagnosticsSnapshot(),
        }
      }
      const nextRuntime = await launchRuntime()
      const snapshot = await getDiagnosticsSnapshot()
      if (!nextRuntime.connection) {
        return {
          status: 'degraded',
          error: sanitizeDiagnosticMessage(nextRuntime.error) ?? 'Agent 重启后未能建立本地连接',
          snapshot,
        }
      }
      return { status: 'restarted', snapshot }
    } catch (error) {
      return {
        status: 'failed',
        error: sanitizeDiagnosticMessage(error instanceof Error ? error.message : String(error)) ?? 'Agent 重启失败',
        snapshot: await getDiagnosticsSnapshot(),
      }
    }
  })
  const restartAgent = () => {
    const operation = runRestartAgent()
    restartAgentPromise = operation
    void operation.then(
      () => { if (restartAgentPromise === operation) restartAgentPromise = null },
      () => { if (restartAgentPromise === operation) restartAgentPromise = null },
    )
    return operation
  }
  stopAll = async () => {
    loginAbortController?.abort()
    removeDesktopSetupHandlers()
    removeDesktopAuthHandlers()
    removeDesktopDiagnosticsHandlers()
    removeDesktopResourceHandlers()
    removeDesktopProjectHandlers()
    removeRendererPermissionBoundary()
    await restartAgentPromise?.catch(() => undefined)
    await loginPromise?.catch(() => undefined)
    await Promise.all([localServer.stop(), stopRuntime()])
  }
  void launchRuntime()

  const window = new BrowserWindow({
    show: false,
    width: 1380,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'RunBuild',
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 15, y: 16 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      preload: path.join(appRoot, 'dist-desktop', 'preload.cjs'),
    },
  })
  mainWindow = window
  if (focusExistingWindowRequested) focusPrimaryWindow()
  window.once('closed', () => { mainWindow = null })
  window.once('ready-to-show', () => window.show())
  installMenu(window)
  const localOrigin = new URL(localServer.url).origin
  removeDesktopSetupHandlers = installDesktopSetupHandlers(window, localOrigin, path.join(app.getPath('userData'), 'desktop-setup.json'))
  removeDesktopAuthHandlers = installDesktopAuthHandlers(window, localOrigin, {
    login,
    cancel: () => loginAbortController?.abort(),
  })
  removeDesktopDiagnosticsHandlers = installDesktopDiagnosticsHandlers(window, localOrigin, {
    getSnapshot: getDiagnosticsSnapshot,
    getLogTail: (source) => readDesktopDiagnosticLogTail(grokHome, source),
    getPermissions: () => collectDesktopDiagnosticPermissions(diagnosticPermissionAccess),
    requestPermission: (permission) => requestDesktopDiagnosticPermission(diagnosticPermissionAccess, permission),
    restartAgent,
  })
  removeDesktopResourceHandlers = installDesktopResourceHandlers(window, localOrigin, { workspace, registryPath })
  removeDesktopProjectHandlers = installDesktopProjectHandlers(window, localOrigin, {
    registryPath,
    homeDirectory: app.getPath('home'),
    configuredApplication: process.env.RUNBUILD_GODOT_APP,
  })
  removeRendererPermissionBoundary = installRendererPermissionBoundary(window, localOrigin)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!hasExpectedOrigin(url, localOrigin)) event.preventDefault()
  })
  await window.loadURL(localServer.url)
  workbenchReady = true
}).catch((error) => {
  dialog.showErrorBox('RunBuild 无法启动', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (primaryInstance) app.quit()
})

app.on('before-quit', (event) => {
  if (!primaryInstance || stopping || !stopAll) return
  event.preventDefault()
  stopping = true
  void stopAll().finally(() => app.quit())
})
