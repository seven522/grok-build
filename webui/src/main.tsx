import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown, { type Components as MarkdownComponents } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Kbd,
  MantineProvider,
  Menu,
  Modal,
  NumberInput,
  Paper,
  Popover,
  Progress,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import {
  IconAccessible,
  IconAlertCircle,
  IconArchive,
  IconArrowDown,
  IconArrowUp,
  IconBolt,
  IconBrain,
  IconBrowser,
  IconBrandGithub,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircle,
  IconCircleCheck,
  IconClock,
  IconCode,
  IconCommand,
  IconCopy,
  IconDatabase,
  IconDots,
  IconFileText,
  IconFiles,
  IconFileCode,
  IconFolder,
  IconFolderPlus,
  IconFolderOpen,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconListDetails,
  IconLogin2,
  IconLoader2,
  IconMessage,
  IconMicrophone,
  IconMoon,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPin,
  IconPlayerPlay,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconScreenShare,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
  IconSquare,
  IconSquareCheck,
  IconSparkles,
  IconSun,
  IconTerminal2,
  IconTool,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import '@mantine/core/styles.css'
import './styles/aceternity.css'
import './typography.css'
import './styles.css'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { DesktopSidebar, SidebarNavButton, SidebarProvider } from '@/components/ui/sidebar'
import { LandingWelcome, TaskSwitchingState } from '@/features/conversation'
import {
  createSessionImageComponent,
  createSessionImageLinkComponent,
  materializeSessionImageReferences,
  messagePresentsSessionImage,
  sessionImageFilenamesInMessage,
  sessionImageSource,
} from '@/features/conversation/session-image'
import {
  appendVisibleUserMessageEcho,
  conversationResource,
  groupConversationTurns,
  isInternalConversationEcho,
  isInternalProtocolText,
  isPersistentMemoryContextEcho,
  PERSISTENT_MEMORY_CONTEXT_PREAMBLE,
  turnOwnsGeneratedImage,
} from '@/features/conversation/conversation-turn'
import {
  commandRequiresUiReadback,
  createToolReceiptVerifier,
  type AcpToolUpdateEvidence,
  type ToolReceiptReadback,
} from '@/features/conversation/completion-evidence'
import { SidebarGroupHeader } from '@/features/navigation'
import {
  artifactFormat,
  artifactPreviewFailure,
  type ArtifactPreviewFailure,
} from '@/features/inspector/artifact-preview'
import {
  automaticPermissionOption,
  DEFAULT_PERMISSION_PREFERENCE,
  permissionPreferenceNotification,
  type PermissionPreference,
} from '@/features/permissions/permission-preference'
import { DEFAULT_MODEL_PROFILE } from '../model-profile'
import type { SidebarPreferences } from '../sidebar-preferences'
import {
  isDesktopTaskSurfaceReady,
  mergeConversationCatalog,
  orderConversationHistory,
  planScopedConversationOpen,
  projectRecentActivity,
  reconcileArchivedConversationIds,
  selectRootHistory,
  selectScopedConversation,
  sidebarSelectedConversationId,
  shouldResumePendingTaskSubmission,
  shouldShowConversationLanding,
  shouldShowTaskInspector,
} from '../project-navigation'
import {
  filterAvailableModels,
  formatJsonRpcProviderError,
  isModelAvailable,
  modelUnavailableMessage,
  resolveAvailableModel,
  type ModelAvailability,
} from '../runtime-model-state'
import {
  planConversationNavigation,
  planScopeTransitionFailure,
  planSessionSwitch,
  replayNeedsSnapshotReset,
  sessionLoadMeta,
  shouldRevealLatestTaskContent,
} from '../session-switching'
import {
  acpTurnTerminalOutcome,
  acpTaskEvent,
  appendTaskEvent,
  type TaskEventAppendResult,
  type TaskEventInput,
} from '../task-event-adapter'
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  acceptsTerminalUpdate,
  applyPromptTimeout,
  createSessionReliabilityState,
  interruptedRunForSessionLoad,
  isActiveTask,
  markTransportConnected,
  markTransportDisconnected,
  pausePromptForUserInput,
  recordTaskTerminal,
  recoveryMessage,
  requestPromptCancel,
  resumePromptAfterUserInput,
  startPrompt,
  type SessionReliabilityState,
} from '../session-reliability'
import {
  projectTaskActivity,
  type TaskActivityProjection,
} from '../task-activity-projection'
import type { TaskEvent } from '../task-event-ledger'
import { isFirstDesktopRun, resolveInitialColorScheme, shouldAutoStartXaiLogin, type ColorScheme } from '../startup-preferences'

type ModelId = 'mimo' | 'deepseek-v4-pro' | typeof DEFAULT_MODEL_PROFILE
type BridgeState = 'offline' | 'connecting' | 'connected' | 'error'
type JsonRpcId = number | string
type EventIcon = typeof IconSparkles

type BridgeConfig = {
  enabled: boolean
  path: string
  workspace: string
  modelProfile: string
  projectsRoot: string
  projectRunnerEnabled: boolean
  runtimeMode?: 'web' | 'desktop'
  runtimeState?: 'starting' | 'listening' | 'failed'
  runtimeError?: string
  initialization?: DesktopInitializationSnapshot
  modelAvailability?: ModelAvailability[]
  providerRegistry?: ProviderRegistryView
  providerHealth?: ProviderHealthView
}

type DesktopInitializationSnapshot = {
  state: 'starting' | 'ready' | 'degraded'
  steps: Array<{
    id: 'workspace' | 'workbench' | 'agent'
    label: string
    state: 'pending' | 'running' | 'ready' | 'warning'
    detail?: string
  }>
}
type DesktopSessionState = { state: 'starting' | 'ready' | 'failed' | 'interaction'; detail?: string }
type DesktopStartupSnapshot = {
  state: 'starting' | 'ready' | 'degraded'
  steps: Array<{
    id: string
    label: string
    state: 'pending' | 'running' | 'ready' | 'warning'
    detail?: string
  }>
}
type DesktopMicrophoneState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-required'
type DesktopSetupSnapshot = {
  platform: string
  onboarding: { version: number; completed: boolean; mode: 'granted' | 'limited' | null }
  microphone: { state: DesktopMicrophoneState; canRequest: boolean; canOpenSettings: boolean }
  screenRecording: { state: DesktopMicrophoneState; canOpenSettings: boolean }
  accessibility: { trusted: boolean; canRequest: boolean }
  fullDiskAccess: { state: 'granted' | 'denied' | 'unknown' | 'not-required'; canOpenSettings: boolean }
  allPermissionsGranted: boolean
}
type DesktopSetupApi = {
  getSetupState: () => Promise<DesktopSetupSnapshot>
  requestMicrophone: () => Promise<DesktopSetupSnapshot>
  openMicrophoneSettings: () => Promise<DesktopSetupSnapshot>
  openScreenRecordingSettings: () => Promise<DesktopSetupSnapshot>
  requestAccessibility: () => Promise<DesktopSetupSnapshot>
  openFullDiskAccessSettings: () => Promise<DesktopSetupSnapshot>
  completeSetup: (mode: 'granted' | 'limited') => Promise<DesktopSetupSnapshot>
  loginXai: () => Promise<DesktopAuthResult>
  cancelXaiLogin: () => Promise<void>
  getDiagnosticsSnapshot: () => Promise<DesktopDiagnosticsSnapshot>
  getDiagnosticsLogTail: (source?: 'desktop-agent') => Promise<DesktopDiagnosticsLogTail>
  getDiagnosticsPermissions: () => Promise<DesktopDiagnosticsPermissions>
  requestDiagnosticsPermission: (permission: DesktopDiagnosticPermissionId) => Promise<DesktopDiagnosticPermissionRequest>
  restartAgent: () => Promise<DesktopDiagnosticRestart>
  openLocalResource: (target: string) => Promise<{ opened: true; kind: 'file' | 'directory' }>
  launchGodotProject: (projectId: string) => Promise<DesktopGodotLaunchReceipt>
}
type DesktopGodotLaunchReceipt = {
  launchId: string
  status: 'awaiting_visual_confirmation'
  projectId: string
  projectRoot: string
  applicationPath: string
  launchedAt: string
}
type ProjectLaunchState = {
  projectId: string
  status: 'launching' | 'awaiting_visual_confirmation' | 'confirmed' | 'failed'
  receipt?: DesktopGodotLaunchReceipt
  error?: string
}
type PendingUiVerification = {
  taskId: string
  projectId: string | null
  runId: string
  terminalKey: string
  terminalEventId: string
  receipts: AcpToolUpdateEvidence[]
}
type DesktopAuthResult = {
  state: 'authenticated'
  runtimeState: 'starting' | 'listening' | 'failed'
  runtimeError?: string
  modelAvailability: ModelAvailability[]
}
type DesktopDiagnosticPermissionId = 'microphone' | 'screen-recording' | 'accessibility' | 'full-disk-access'
type DesktopDiagnosticPermission = {
  id: DesktopDiagnosticPermissionId
  label: string
  state: string
  canRequest: boolean
  canOpenSettings: boolean
  detail: string
}
type DesktopDiagnosticsPermissions = { platform: string; permissions: DesktopDiagnosticPermission[] }
type DesktopDiagnosticsSnapshot = {
  generatedAt: string
  scope: 'local-only'
  providers: Array<{ id: string; label: string; status: 'ready' | 'unavailable'; reason?: string }>
  connectors: Array<{ id: string; label: string; status: 'ready' | 'degraded' | 'unavailable'; detail: string }>
  runtime: {
    state: string
    connected: boolean
    modelProfile: string
    error?: string
    lease: { status: string; id?: string; pid?: number; port?: number; runtimeState?: string; startedAt?: string; heartbeatAt?: string }
    process: { status: string; pid?: number }
  }
  storage: Array<{ id: string; label: string; path: string; kind: 'directory' | 'file'; status: 'ready' | 'missing' | 'unavailable'; sizeBytes?: number }>
  permissions: DesktopDiagnosticsPermissions
  logs: Array<{ source: 'desktop-agent'; status: 'available' | 'missing' | 'unavailable' }>
}
type DesktopDiagnosticsLogTail = { source: 'desktop-agent'; status: 'available' | 'missing' | 'unavailable'; lines: string[]; truncated: boolean; redactions: number }
type DesktopDiagnosticPermissionRequest = { permission: DesktopDiagnosticPermissionId; outcome: 'requested' | 'already-granted' | 'system-settings-required' | 'not-required'; permissions: DesktopDiagnosticsPermissions }
type DesktopDiagnosticRestart = { status: 'restarted' | 'degraded' | 'failed' | 'blocked'; error?: string; snapshot: DesktopDiagnosticsSnapshot }

type PermissionOption = { optionId: string; kind: string; name?: string }
type PendingPermission = {
  requestId: JsonRpcId
  sessionId: string
  runId: string | null
  requestKey: string
  toolCallId: string | null
  options: PermissionOption[]
  title: string
}
type AgentQuestionOption = { label: string; description: string; preview?: string }
type AgentQuestion = { question: string; options: AgentQuestionOption[]; multiSelect: boolean }
type PendingQuestion = { requestId: JsonRpcId; sessionId: string; questions: AgentQuestion[]; mode: string }
type PendingPlan = { requestId: JsonRpcId; sessionId: string; content: string }
type Attachment = { id: string; name: string; mimeType: string; size: number; kind: 'image' | 'text' | 'file'; data: string; preview?: string }
type PendingTaskSubmission = { projectId: string | null; text: string; attachments: Attachment[] }
type TaskWorkspaceAttachment = {
  id: string
  name: string
  kind: Attachment['kind']
  mimeType: string
  size: number
  sha256: string
  storedAt: string
}
type TaskWorkspaceSnapshot = {
  taskId: string
  projectId: string | null
  lifecycle: { state: 'active' | 'archived'; execution: 'idle' | 'running' | 'cancelling'; updatedAt: string }
  draft: { text: string; updatedAt: string; attachmentIds?: string[] }
  attachments: TaskWorkspaceAttachment[]
}
type TaskProjectLifecycle = {
  projectId: string
  state: 'active' | 'archived' | 'detached'
  updatedAt: string
  archivedAt?: string
  detachedAt?: string
  restoredAt?: string
}
type ChatMessage = { id: string; role: 'user' | 'agent' | 'system'; text: string; tone?: 'info' | 'error'; streaming?: boolean; attachments?: Attachment[]; startedAt?: number; completedAt?: number; durationMs?: number }
type GeneratedMedia = { kind: 'image'; filename: string }
type ImagePreview = { src: string; alt: string }
type ToolState = { id: string; title: string; kind?: string; name?: string; status: string; detail?: string; media?: GeneratedMedia; turnStartedAt?: number }
type Activity = { time: string; text: string; icon: EventIcon }
type InteractionFeedback = Activity & { id: string; tone: 'default' | 'error' | 'success'; kind?: 'bridge-offline' | 'xai-auth'; persistent?: boolean }
type BridgeCommandCopyState = 'idle' | 'copied' | 'failed'
type JsonRecord = Record<string, unknown>
type ConversationSnapshot = {
  id: string
  title: string
  messages: ChatMessage[]
  tools: ToolState[]
  createdAt: string
  cwd: string
  projectId: string | null
  cursor?: string
  modelId?: string
  reasoningEffort?: ReasoningEffort
}
type TaskRuntime = {
  reliability: SessionReliabilityState
  submitting: boolean
  activeRunId: string | null
  activeAgentMessageId: string | null
  turnStartedAt: number | null
  cancelRequestedRunId: string | null
  promptDeadlineTimer: number | null
  questionAnswers: Record<string, string[]>
}
type RestoringSession = { id: string; title: string; kind: 'switch' | 'create'; showCachedSnapshot?: boolean }
type ScopeTransitionSnapshot = {
  targetProjectId: string | null
  targetSessionId: string | null
  bridgeProjectId: string | null
  activeProjectId: string | null
  activeConversationId: string | null
  activeConversationTitle: string
  sessionId: string | null
  messages: ChatMessage[]
  tools: ToolState[]
  composer: string
  attachments: Attachment[]
  model: string
  reasoningEffort: ReasoningEffort
}
type CommandAvailability = 'ready' | 'bridge' | 'native'
type SlashCommand = { name: string; usage: string; description: string; group: string; availability: CommandAvailability; acceptsArgs?: boolean }
type WorkspacePage = 'chat' | 'automations' | 'skills' | 'memory'
type CatalogTab = 'skills' | 'connectors'
type ProviderCapabilitiesView = {
  sessions: { create: boolean; load: boolean; cancel: boolean; events: boolean }
  models: boolean
  permissions: boolean
  tools: boolean
  context: boolean
}
type ProviderDefinitionView = {
  id: string
  label: string
  protocol: 'acp'
  runtimeBinding: 'grok-acp' | 'unbound'
  route: '/acp' | null
  enabled: boolean
  modelIds: string[]
  capabilities: ProviderCapabilitiesView
}
type ProviderRegistryView = { defaultProviderId: string; providers: ProviderDefinitionView[] }
type ProviderHealthView = {
  defaultProviderId: string
  providers: Array<{
    providerId: string
    status: 'ready' | 'degraded' | 'unavailable'
    models: Array<{ id: string; available: boolean; reason?: string }>
    reasons: string[]
  }>
}
type MemoryStatusView = 'active' | 'superseded' | 'disputed' | 'deleted'
type MemoryRecordView = {
  id: string
  title: string
  fact: string
  status: MemoryStatusView
  writePath: string
  confidence: number
  sensitivity: 'normal' | 'sensitive' | 'restricted'
  pinned: boolean
  redacted: boolean
  updatedAt: string
  provenance: { sourceEventIds: string[]; sourceTaskId: string | null; sourceRunId: string | null }
}
type MemoryContextReceipt = {
  adapter: string
  maxChars: number
  usedChars: number
  redacted: boolean
  includedMemoryIds: string[]
  omittedMemoryIds: string[]
  sections: Array<{ kind: string; included: number; omitted: number }>
}
type PromptMemoryContext = {
  text: string
  receipt: MemoryContextReceipt | null
}
type GoalExecutionProjection = {
  runId: string
  state: 'planning' | 'executing' | 'verifying' | 'verified' | 'blocked' | 'failed' | 'cancelling' | 'cancelled' | 'recovering'
  recovery: 'active' | 'interrupted' | 'cancel_requested'
  plan: { pending: number; running: number; verifying: number; verified: number; blocked: number; failed: number; cancelled: number }
  independentVerifierReceiptCount: number
  completionAccepted: boolean
  activity: Array<{ id: string; at: string; tone: 'info' | 'success' | 'warning' | 'error'; text: string }>
}
type ProjectSource = { id: string; name: string; mimeType: string; size: number; kind: 'image' | 'text'; relativePath: string }
type Project = { id: string; name: string; rootPath: string; location?: 'managed' | 'external'; instructions: string; sources: ProjectSource[]; defaultSandbox: 'workspace'; createdAt: string; updatedAt: string }
type ProjectFile = { path: string; name: string; kind: 'text' | 'image' | 'unsupported'; mimeType: string; size: number }
const projectFileKindFromPath = (filePath: string): ProjectFile['kind'] => /\.(?:avif|gif|jpe?g|png|webp)$/i.test(filePath) ? 'image' : 'text'
type RuntimeModel = { id: string; label: string; description: string }
const markdownComponents: MarkdownComponents = {
  table: ({ node, ...props }) => {
    void node
    return <div className="message-table-scroll"><table {...props} /></div>
  },
}

const eventTimestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const formatDuration = (durationMs: number) => {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const formatMessageTime = (timestampMs: number) => new Date(timestampMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const toolName = (update: JsonRecord) => {
  const metadata = asRecord(asRecord(update._meta)['x.ai/tool'])
  const named = asText(metadata.name)
  if (named) return named.toLowerCase()
  const variant = asText(asRecord(update.rawInput).variant).toLowerCase()
  if (variant === 'imagegen') return 'image_gen'
  if (variant === 'imageedit') return 'image_edit'
  const title = asText(update.title).toLowerCase()
  if (/^image_(?:gen|edit)$/.test(title)) return title
  return ''
}

const generatedMedia = (value: unknown): GeneratedMedia | undefined => {
  const output = asRecord(value)
  const type = asText(output.type).toLowerCase()
  const filename = asText(output.filename)
  if (!['imagegen', 'imageedit'].includes(type) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:avif|gif|jpe?g|png|webp)$/i.test(filename)) return undefined
  return { kind: 'image', filename }
}
type ReasoningEffort = 'low' | 'medium' | 'high'
type VoiceState = 'idle' | 'listening'
type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}
type InspectorSelection = { kind: 'source' | 'attachment' | 'tool' | 'file'; id: string }
type InspectorTab = 'preview' | 'files' | 'activity'
const inspectorTabs: ReadonlyArray<{ value: InspectorTab; label: string; id: string; controls: string }> = [
  { value: 'preview', label: '预览', id: 'inspector-tab-preview', controls: 'inspector-panel-preview' },
  { value: 'files', label: '文件', id: 'inspector-tab-files', controls: 'inspector-panel-files' },
  { value: 'activity', label: '执行', id: 'inspector-tab-activity', controls: 'inspector-panel-activity' },
]
type PaneKind = 'sidebar' | 'inspector'
type WorkspaceContextKind = 'file' | 'browser' | 'terminal' | 'activity' | 'empty'
type ProjectFilePreview = { kind: 'text' | 'image'; name: string; path: string; mimeType: string; text?: string; url?: string }
type SessionInfoView = {
  cwd: string
  agentName: string
  modelName: string
  turns: number
  contextUsed: number
  contextTotal: number
  contextPercent: number
  toolCalls: number
  compactions: number
}

type AutomationTemplate = {
  name: string
  schedule: AutomationScheduleView
  instruction: string
  icon: EventIcon
}

type AutomationScheduleView =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; hour: number; minute: number }

type AutomationPolicyView = {
  permission: 'manual-current'
  maxPendingRuns: number
  maxAttempts: number
  retryDelayMinutes: number
  maxRunsPerDay: number
  maxWallClockMinutes: number
  tokenBudget: 'unsupported'
}

type StoredAutomation = {
  id: string
  revision: number
  name: string
  instruction: string
  projectId: string | null
  schedule: AutomationScheduleView
  enabled: boolean
  nextDueAt: string | null
  policy: AutomationPolicyView
  createdAt: string
  updatedAt: string
  migratedFromLegacy?: true
}

type AutomationRunState = 'queued' | 'claimed' | 'prepared' | 'dispatch_unconfirmed' | 'dispatched' | 'retry_wait' | 'succeeded' | 'failed' | 'blocked' | 'budget_exhausted' | 'cancelled'
type AutomationRunView = {
  id: string
  automationId: string
  occurrenceKey: string
  trigger: 'manual' | 'schedule' | 'retry' | 'replay'
  state: AutomationRunState
  attempt: number
  scheduledFor: string | null
  availableAt: string | null
  replayOf: string | null
  retryOf: string | null
  projectId: string | null
  policy: AutomationPolicyView
  claim: { id: string; clientId: string; expiresAt: string } | null
  taskId: string | null
  agentRunId: string | null
  taskCreatedEventId: string | null
  runStartedEventId: string | null
  deadlineAt: string | null
  createdAt: string
  updatedAt: string
  audit: Array<{ id: string; sequence: number; at: string; kind: string; detail?: string }>
}

type PendingAutomationHandoff = {
  runId: string
  claimId: string
  projectId: string | null
  instruction: string
}

type CapabilityCard = {
  name: string
  description: string
  status: string
  icon: EventIcon
}

declare global {
  interface Window {
    __personalAgentRoot?: Root
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
    grokDesktop?: DesktopSetupApi
  }
}

const isDesktopRuntime = new URLSearchParams(window.location.search).get('desktop') === '1'

if (isDesktopRuntime) {
  document.body.classList.add('is-desktop')
}

const models: Record<string, { label: string; detail: string; status: string }> = {
  mimo: { label: 'MiMo', detail: 'mimo-v2.5-pro', status: '需要 MIMO_API_KEY' },
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', detail: 'deepseek-v4-pro', status: '需要 DEEPSEEK_API_KEY' },
  [DEFAULT_MODEL_PROFILE]: { label: 'Grok 4.5', detail: DEFAULT_MODEL_PROFILE, status: 'xAI 登录后可用' },
}

const profileToModel: Record<string, ModelId> = {
  mimo: 'mimo',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  deepseek: 'deepseek-v4-pro',
  [DEFAULT_MODEL_PROFILE]: DEFAULT_MODEL_PROFILE,
  'grok-4-5': DEFAULT_MODEL_PROFILE,
}

const responseModeInstructions = {
  auto: '',
  fast: '响应模式：Fast。优先直接执行明确的编程任务，减少非必要的展开，但不省略必要的安全检查。',
  expert: '响应模式：Expert。先分析关键约束与风险，再执行并验证结果；保持对当前工作区的最小相关修改。',
} as const

const bridgeStartCommand = './run web-agent'

function stripResponseModeInstruction(text: string) {
  for (const instruction of [responseModeInstructions.fast, responseModeInstructions.expert]) {
    if (text === instruction) return ''
    if (text.startsWith(`${instruction}\n`)) return text.slice(instruction.length).trimStart()
  }
  return text
}

const initialEvents: Activity[] = [
  { time: '刚刚', text: '本地工作台已就绪。', icon: IconSparkles },
  { time: '刚刚', text: '模型凭据只保留在本地 Agent 进程。', icon: IconShieldCheck },
]

const slashCommands: SlashCommand[] = [
  { name: 'new', usage: '/new', description: '创建新的 ACP 会话', group: '会话', availability: 'ready' },
  { name: 'dashboard', usage: '/dashboard', description: '查看运行中与最近的 Agent 会话', group: '会话', availability: 'bridge' },
  { name: 'resume', usage: '/resume', description: '搜索并恢复历史会话', group: '会话', availability: 'ready' },
  { name: 'rename', usage: '/rename <标题>', description: '重命名当前会话', group: '会话', availability: 'bridge', acceptsArgs: true },
  { name: 'session-info', usage: '/session-info', description: '读取当前会话的真实信息', group: '会话', availability: 'bridge' },
  { name: 'compact', usage: '/compact', description: '压缩当前会话历史', group: '上下文', availability: 'bridge' },
  { name: 'context', usage: '/context', description: '查看当前上下文使用情况', group: '上下文', availability: 'bridge' },
  { name: 'mcps', usage: '/mcps', description: '重新加载桌面 Agent 的 MCP 连接', group: '上下文', availability: 'native' },
  { name: 'view-plan', usage: '/view-plan', description: '查看当前执行计划', group: '上下文', availability: 'ready' },
  { name: 'model', usage: '/model', description: '显示运行模型与切换方式', group: '模型与输入', availability: 'ready' },
  { name: 'always-approve', usage: '/always-approve', description: '切换工具审批模式', group: '模型与输入', availability: 'native' },
  { name: 'multiline', usage: '/multiline', description: '切换多行输入模式', group: '模型与输入', availability: 'ready' },
  { name: 'theme', usage: '/theme', description: '切换界面主题', group: '其他', availability: 'native' },
  { name: 'shortcuts', usage: '/shortcuts', description: '显示快捷键', group: '其他', availability: 'ready' },
  { name: 'docs', usage: '/docs', description: '查看 RunBuild 命令说明', group: '其他', availability: 'ready' },
  { name: 'run', usage: '/run <任务>', description: '把任务直接发送给 Agent', group: '快捷操作', availability: 'ready', acceptsArgs: true },
  { name: 'design-experts', usage: '/design-experts <任务>', description: '交给我们的设计专家团队', group: '快捷操作', availability: 'ready', acceptsArgs: true },
  { name: 'shell', usage: '/shell <命令>', description: '请求 Agent 按当前授权策略执行命令', group: '快捷操作', availability: 'ready', acceptsArgs: true },
  { name: 'clear', usage: '/clear', description: '清空当前页面的对话与工具记录', group: '快捷操作', availability: 'ready' },
  { name: 'status', usage: '/status', description: '显示 Bridge 与运行时状态', group: '快捷操作', availability: 'ready' },
  { name: 'help', usage: '/help', description: '显示全部命令说明', group: '快捷操作', availability: 'ready' },
]

const now = () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date())
const timestamp = () => new Date().toISOString()
const messageId = () => crypto.randomUUID()
const permissionOptionCopy = (option: PermissionOption) => {
  if (option.kind === 'allow_once') return { label: '允许一次', color: 'teal' as const }
  if (option.kind === 'allow_always') return { label: option.name || '按此范围始终允许', color: 'red' as const }
  if (option.kind === 'reject_always') return { label: option.name || '按此范围始终拒绝', color: 'red' as const }
  if (option.kind === 'reject_once') return { label: '拒绝', color: 'gray' as const }
  return { label: option.name || option.kind || '选择', color: 'gray' as const }
}
const initialColorScheme = (): ColorScheme => {
  try { return resolveInitialColorScheme(window.localStorage.getItem('stillpoint-color-scheme')) } catch { return 'light' }
}
const initialBooleanPreference = (key: string, fallback: boolean) => {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch { return fallback }
}
const initialStringListPreference = (key: string) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch { return [] }
}
const initialChoicePreference = <T extends string>(key: string, choices: readonly T[], fallback: T) => {
  try {
    const value = window.localStorage.getItem(key)
    return choices.includes(value as T) ? value as T : fallback
  } catch { return fallback }
}
const SIDEBAR_MIN_WIDTH = 224
const SIDEBAR_MAX_WIDTH = 420
const INSPECTOR_MIN_WIDTH = 360
const MIN_CONVERSATION_WIDTH = 360
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const inspectorMaxWidth = (viewportWidth: number, pinnedSidebarWidth: number) => Math.max(
  INSPECTOR_MIN_WIDTH,
  viewportWidth - pinnedSidebarWidth - MIN_CONVERSATION_WIDTH,
)
const initialPaneWidth = (key: string, fallback: number, min: number, max: number) => {
  try {
    const stored = window.localStorage.getItem(key)
    if (stored === null) return fallback
    const saved = Number(stored)
    return Number.isFinite(saved) ? clamp(saved, min, max) : fallback
  } catch { return fallback }
}
const startupColorScheme = initialColorScheme()
document.documentElement.dataset.theme = startupColorScheme
const desktopStartupSeenKey = 'runbuild-desktop-startup-seen-v1'
const firstDesktopRun = (() => {
  if (!isDesktopRuntime) return false
  try { return isFirstDesktopRun(window.localStorage.getItem(desktopStartupSeenKey)) } catch { return false }
})()

const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const asText = (value: unknown): string => typeof value === 'string' ? value : ''
const unwrapExtensionResult = (value: JsonRecord) => Object.keys(asRecord(value.result)).length ? asRecord(value.result) : value
const sessionModels = (value: JsonRecord): { currentId: string; reasoningEffort: ReasoningEffort | null; available: RuntimeModel[] } => {
  const meta = asRecord(value._meta)
  const state = Object.keys(asRecord(value.models)).length ? asRecord(value.models) : asRecord(meta.modelState ?? meta.model_state)
  const currentId = asText(state.currentModelId ?? state.current_model_id)
  const rawModels = Array.isArray(state.availableModels)
    ? state.availableModels
    : Array.isArray(state.available_models) ? state.available_models : []
  const available = rawModels.map(asRecord).map((entry) => {
    const id = asText(entry.modelId ?? entry.model_id ?? entry.id)
    return {
      id,
      label: asText(entry.name ?? entry.label) || models[id]?.label || id,
      description: asText(entry.description) || models[id]?.detail || '当前 Agent 提供的可选模型',
    }
  }).filter((entry) => entry.id)
  const rawEffort = asText(state.reasoningEffort ?? state.reasoning_effort)
  const reasoningEffort = rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high' ? rawEffort : null
  return { currentId, reasoningEffort, available }
}
const readFile = (file: File, mode: 'dataUrl' | 'text') => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
  reader.onload = () => resolve(String(reader.result ?? ''))
  if (mode === 'dataUrl') reader.readAsDataURL(file)
  else reader.readAsText(file)
})

const base64FromBytes = (bytes: Uint8Array) => {
  // Chunking avoids overflowing Function.apply / argument limits for restored
  // binary attachments. The server still enforces the canonical byte limits.
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000))
    for (const byte of chunk) binary += String.fromCharCode(byte)
  }
  return window.btoa(binary)
}

const bytesFromAttachment = (attachment: Attachment) => {
  if (attachment.kind === 'text') return new TextEncoder().encode(attachment.data)
  const binary = window.atob(attachment.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const MAX_COMPOSER_ATTACHMENTS = 6
const MAX_COMPOSER_ATTACHMENT_BYTES = 2 * 1024 * 1024
const textAttachmentPattern = /\.(txt|md|json|js|ts|tsx|jsx|py|rs|toml|yaml|yml|csv|log|xml|html|css|sql)$/i
const imageMimeByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
}
const textMimeByExtension: Record<string, string> = {
  md: 'text/markdown', json: 'application/json', xml: 'application/xml', html: 'text/html', css: 'text/css', csv: 'text/csv',
}
const attachmentName = (file: File) => {
  if (file.name) return file.name
  const imageExtension = file.type.split('/')[1] || 'png'
  return `${file.type.startsWith('image/') ? 'clipboard-image' : 'attachment'}-${Date.now()}.${imageExtension}`
}
const attachmentMimeType = (file: File, name: string) => {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return file.type || imageMimeByExtension[extension] || textMimeByExtension[extension] || (textAttachmentPattern.test(name) ? 'text/plain' : 'application/octet-stream')
}
const attachmentTransferFiles = (transfer: DataTransfer | null): File[] => {
  const directFiles = Array.from(transfer?.files ?? [])
  if (directFiles.length) return directFiles
  return Array.from(transfer?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}
const hasTransferFiles = (transfer: DataTransfer | null) => Boolean(transfer && (transfer.files.length || Array.from(transfer.types).includes('Files')))
const formatAttachmentSize = (size: number) => size < 1024
  ? `${size} B`
  : size < 1024 * 1024
    ? `${Math.ceil(size / 1024)} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (typeof record.text === 'string') return record.text
  if (record.content) return contentText(record.content)
  if (record.value) return contentText(record.value)
  return ''
}

function toolDetail(value: unknown): string {
  const text = contentText(value)
  if (text) return text.slice(0, 12_000)
  if (!value || typeof value !== 'object') return ''
  try { return JSON.stringify(value, null, 2).slice(0, 12_000) } catch { return '' }
}

function toolStatusKey(status: string) {
  return status.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function statusColor(status: string) {
  const key = toolStatusKey(status)
  if (['completed', 'success'].includes(key)) return 'teal'
  if (['failed', 'error', 'cancelled'].includes(key)) return 'red'
  if (['in_progress', 'running'].includes(key)) return 'blue'
  return 'gray'
}

function statusLabel(status: string) {
  const key = toolStatusKey(status)
  if (['completed', 'success'].includes(key)) return '已完成'
  if (['failed', 'error'].includes(key)) return '失败'
  if (key === 'cancelled') return '已取消'
  if (['in_progress', 'running'].includes(key)) return '进行中'
  if (['pending', 'queued'].includes(key)) return '等待中'
  return status || '等待中'
}

function toolActivityCopy(title: string) {
  const normalized = title.trim() || 'Agent 工具操作'
  const action = normalized.match(/^(Execute|List|Read|Write|Edit|Search|Fetch|Open)\s+([\s\S]+)$/i)
  if (!action) return { label: normalized, detail: '' }
  const labels: Record<string, string> = {
    execute: '运行命令',
    list: '查看目录',
    read: '读取文件',
    write: '写入文件',
    edit: '编辑文件',
    search: '搜索内容',
    fetch: '获取内容',
    open: '打开内容',
  }
  return { label: labels[action[1].toLowerCase()] || normalized, detail: action[2].trim() }
}

function toolWorkspaceContext(tool: ToolState | null): WorkspaceContextKind {
  if (!tool) return 'empty'
  const descriptor = `${tool.kind ?? ''} ${tool.title}`.toLowerCase()
  if (/(browser|playwright|chromium|chrome|webpage|url)/.test(descriptor)) return 'browser'
  if (/(terminal|shell|command|bash|zsh|powershell|exec|process)/.test(descriptor)) return 'terminal'
  return 'activity'
}

function sessionRow(rowValue: unknown, projectId: string | null): ConversationSnapshot | null {
  const row = asRecord(rowValue)
  const id = asText(row.sessionId)
  const cwd = asText(row.cwd)
  if (!id || !cwd) return null
  return {
    id,
    cwd,
    projectId,
    title: asText(row.title) || asText(row.summary) || asText(row.firstPrompt) || '新会话',
    createdAt: asText(row.updatedAt) || asText(row.lastActiveAt) || asText(row.createdAt) || timestamp(),
    messages: [],
    tools: [],
  }
}

function mergeScopedSessions(current: ConversationSnapshot[], incoming: ConversationSnapshot[], projectId: string | null) {
  const cachedById = new Map(current.map((session) => [session.id, session]))
  return [
    ...incoming.map((session) => {
      const cached = cachedById.get(session.id)
      return cached ? { ...cached, ...session, messages: cached.messages, tools: cached.tools } : session
    }),
    ...current.filter((session) => session.projectId !== projectId),
  ]
}

const automationTemplates: AutomationTemplate[] = [
  {
    name: '代码变更巡检',
    schedule: { kind: 'manual' },
    instruction: '检查当前项目最近的代码改动，优先指出会导致构建失败、数据丢失或安全问题的风险，并给出最小修复建议。',
    icon: IconFileCode,
  },
  {
    name: '依赖状态检查',
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    instruction: '检查当前项目的依赖与构建脚本，汇总过期、冲突或无法安装的依赖；不要自动升级，先给出影响范围。',
    icon: IconPlugConnected,
  },
  {
    name: '项目进展摘要',
    schedule: { kind: 'daily', hour: 18, minute: 0 },
    instruction: '读取当前项目的改动、任务和测试结果，生成一份简洁的开发进展摘要，明确完成项、风险和下一步。',
    icon: IconClock,
  },
]

const automationScheduleLabel = (schedule: AutomationScheduleView) => {
  if (schedule.kind === 'manual') return '手动入队'
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
  return `每天 ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
}

const automationRunStateCopy = (state: AutomationRunState): { label: string; color: 'gray' | 'blue' | 'orange' | 'teal' | 'red' } => {
  const copy: Record<AutomationRunState, { label: string; color: 'gray' | 'blue' | 'orange' | 'teal' | 'red' }> = {
    queued: { label: '待审核启动', color: 'blue' },
    claimed: { label: '正在准备任务', color: 'orange' },
    prepared: { label: '待在任务中发送', color: 'orange' },
    dispatch_unconfirmed: { label: '发送待确认', color: 'orange' },
    dispatched: { label: 'Agent 运行中', color: 'blue' },
    retry_wait: { label: '等待重试入队', color: 'gray' },
    succeeded: { label: '已验证', color: 'teal' },
    failed: { label: '运行失败', color: 'red' },
    blocked: { label: '待人工核对', color: 'orange' },
    budget_exhausted: { label: '预算已阻止', color: 'red' },
    cancelled: { label: '已取消', color: 'gray' },
  }
  return copy[state]
}

const skillCatalog: CapabilityCard[] = [
  { name: '代码库理解', description: '读取项目结构、源码与配置，建立当前任务所需的上下文。', status: '内置', icon: IconCode },
  { name: '项目文件', description: '查看、编辑并生成工作区内的文本、代码和图片文件。', status: '内置', icon: IconFiles },
  { name: '终端与脚本', description: '运行构建、测试和诊断命令，危险操作继续遵循审批。', status: '内置', icon: IconTerminal2 },
  { name: '浏览器操作', description: '在任务需要时打开网页、检查页面并保留可审计的工具活动。', status: 'Agent 工具', icon: IconBrowser },
  { name: '设计专家', description: '通过 /design-experts 把设计任务交给最少必要的专家角色。', status: '命令', icon: IconSparkles },
  { name: 'Git 工作流', description: '检查分支与改动，并在获得明确指令后完成提交或交付流程。', status: 'Agent 工具', icon: IconBrandGithub },
]

function AutomationWorkspace({
  automations,
  runs,
  loading,
  error,
  actionId,
  onCreate,
  onUse,
  onQueue,
  onStart,
  onPause,
  onReplay,
  onCancel,
}: {
  automations: StoredAutomation[]
  runs: AutomationRunView[]
  loading: boolean
  error: string
  actionId: string | null
  onCreate: (template?: AutomationTemplate) => void
  onUse: (automation: StoredAutomation) => void
  onQueue: (automation: StoredAutomation) => void
  onStart: (run: AutomationRunView) => void
  onPause: (automation: StoredAutomation) => void
  onReplay: (run: AutomationRunView) => void
  onCancel: (run: AutomationRunView) => void
}) {
  const latestRun = (automationId: string) => runs.find((run) => run.automationId === automationId)
  return <ScrollArea className="workspace-page-scroll" type="auto">
    <main className="grok-page library-page" aria-label="自动化任务">
      <Group className="grok-page-title" justify="space-between" align="center" wrap="nowrap">
        <Box><Title order={1}>自动化</Title><Text c="dimmed" size="sm" mt={4}>本机计划只会可靠入队；你仍会在普通任务里手动发送，并保留每次工具授权。</Text></Box>
        <Button className="page-primary-action" color="dark" radius="xl" leftSection={<IconPlus size={17} />} onClick={() => onCreate()}>新建自动化</Button>
      </Group>
      <Text className="page-eyebrow">建议</Text>
      <div className="automation-grid">
        {automationTemplates.map((template) => {
          const TemplateIcon = template.icon
          return <Paper key={template.name} className="automation-card" p="md" radius="lg">
            <Group justify="space-between" wrap="nowrap"><ThemeIcon variant="light" color="gray" radius="md"><TemplateIcon size={18} /></ThemeIcon><Button variant="default" color="gray" size="xs" radius="xl" onClick={() => onCreate(template)}>添加</Button></Group>
            <Text fw="var(--weight-bold)" mt={14}>{template.name}</Text>
            <Text c="dimmed" size="sm" mt={3} lineClamp={2}>{template.instruction}</Text>
          </Paper>
        })}
      </div>

      <Group className="page-section-heading" justify="space-between" mt={42} mb={14}>
        <Text className="page-eyebrow" m={0}>我的自动化</Text>
        {!loading && <Text size="sm" c="dimmed">{automations.length}</Text>}
      </Group>
      {loading && <div className="page-loading"><IconLoader2 className="spin" size={22} /><Text size="sm" c="dimmed">正在读取自动化…</Text></div>}
      {error && <Paper className="page-inline-error" role="alert" p="md" radius="lg"><IconAlertCircle size={18} /><Text size="sm">{error}</Text></Paper>}
      {!loading && !error && automations.length === 0 && <Paper className="page-empty-state" p="xl" radius="lg"><ThemeIcon variant="light" color="gray" radius="xl" size={44}><IconBolt size={21} /></ThemeIcon><Text fw="var(--weight-bold)">还没有自动化</Text><Text size="sm" c="dimmed">从上方建议添加，或创建一条需要人工审核启动的本地计划。</Text><Button variant="default" color="gray" radius="xl" onClick={() => onCreate()}>创建自动化</Button></Paper>}
      {automations.length > 0 && <div className="automation-drafts">
        {automations.map((automation) => {
          const run = latestRun(automation.id)
          const runCopy = run ? automationRunStateCopy(run.state) : null
          const isBusy = actionId === automation.id || actionId === run?.id
          return <Paper key={automation.id} className="automation-draft" p="md" radius="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box className="catalog-card-copy"><Group gap={8}><Text fw="var(--weight-bold)">{automation.name}</Text><Badge variant="light" color={automation.enabled ? 'gray' : 'orange'} size="sm">{automation.enabled ? automationScheduleLabel(automation.schedule) : '已暂停'}</Badge>{runCopy && <Badge variant="light" color={runCopy.color} size="sm">{runCopy.label}</Badge>}</Group><Text size="sm" c="dimmed" mt={6} lineClamp={2}>{automation.instruction}</Text>{automation.migratedFromLegacy && <Text size="xs" c="orange" mt={6}>旧模板已安全迁移为手动入队；不会猜测原先的自由文本触发时间。</Text>}{automation.nextDueAt && automation.enabled && <Text size="xs" c="dimmed" mt={6}>下次本机入队：{new Date(automation.nextDueAt).toLocaleString()}</Text>}{run?.state === 'prepared' && <Text size="xs" c="orange" mt={6}>已创建任务草稿；请在该任务中核对并点击发送。</Text>}{run?.state === 'dispatch_unconfirmed' && <Text size="xs" c="orange" mt={6}>发送结果尚未确认；不会自动重发。</Text>}</Box>
            <Group gap={4} wrap="nowrap"><Tooltip label="将指令放入当前任务"><ActionIcon variant="subtle" color="gray" aria-label={`用于当前任务：${automation.name}`} onClick={() => onUse(automation)}><IconPlayerPlay size={17} /></ActionIcon></Tooltip><Tooltip label={automation.enabled ? '暂停计划' : '恢复计划'}><ActionIcon variant="subtle" color={automation.enabled ? 'orange' : 'teal'} loading={actionId === automation.id} aria-label={`${automation.enabled ? '暂停' : '恢复'}自动化：${automation.name}`} onClick={() => onPause(automation)}><IconClock size={17} /></ActionIcon></Tooltip></Group>
          </Group>
          <Group gap={8} mt={12} wrap="wrap">
            {automation.enabled && <Button size="compact-xs" variant="default" color="gray" loading={isBusy && actionId === automation.id} onClick={() => onQueue(automation)}>入队审核</Button>}
            {run?.state === 'queued' && <Button size="compact-xs" color="teal" loading={isBusy && actionId === run.id} onClick={() => onStart(run)}>在新任务中审核</Button>}
            {run && ['queued', 'claimed', 'prepared', 'dispatch_unconfirmed', 'retry_wait'].includes(run.state) && <Button size="compact-xs" variant="subtle" color="orange" disabled={isBusy} onClick={() => onCancel(run)}>取消此运行</Button>}
            {run && ['succeeded', 'failed', 'blocked', 'budget_exhausted', 'cancelled'].includes(run.state) && automation.enabled && <Button size="compact-xs" variant="subtle" color="gray" disabled={isBusy} onClick={() => onReplay(run)}>重放到新队列</Button>}
          </Group>
        </Paper>
        })}
      </div>}
    </main>
  </ScrollArea>
}

function MemoryWorkspace({
  projectId,
}: {
  projectId: string | null
}) {
  type MemoryWorkspaceRecord = MemoryRecordView & {
    scope?: { projectId?: string | null }
  }
  type MemoryOwnership = {
    label: string
    detail: string
    canManage: boolean
  }

  const [memories, setMemories] = useState<MemoryWorkspaceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [fact, setFact] = useState('')
  const [writePath, setWritePath] = useState('remember')
  const [sensitivity, setSensitivity] = useState<MemoryRecordView['sensitivity']>('normal')
  const [pinned, setPinned] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [editingFact, setEditingFact] = useState('')
  const [editingSaving, setEditingSaving] = useState(false)

  const scope = projectId ?? 'root'
  const ownershipFor = (memory: MemoryWorkspaceRecord): MemoryOwnership => {
    const memoryProjectId = memory.scope?.projectId
    if (memoryProjectId === null) {
      return projectId === null
        ? { label: '通用记忆', detail: '独立任务范围', canManage: true }
        : { label: '通用记忆', detail: '跨项目可见；请在独立任务的记忆页管理', canManage: false }
    }
    if (memoryProjectId === projectId && typeof memoryProjectId === 'string') {
      return { label: '当前项目', detail: '仅当前项目可用', canManage: true }
    }
    return { label: '作用域待确认', detail: '刷新后再试；为保护作用域，当前不可修改', canManage: false }
  }
  const requireManageable = (memory: MemoryWorkspaceRecord) => {
    const ownership = ownershipFor(memory)
    if (ownership.canManage) return true
    setError(`“${memory.title}”是${ownership.label}，${ownership.detail}。`)
    return false
  }
  const refresh = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/memories?projectId=${encodeURIComponent(scope)}&includeUserScoped=true&statuses=active,superseded,disputed`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({})) as { memories?: MemoryWorkspaceRecord[]; error?: string }
      if (!response.ok) throw new Error(payload.error || '无法读取记忆')
      setMemories(Array.isArray(payload.memories) ? payload.memories : [])
      setError('')
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '无法读取记忆')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  // The selected project is the memory visibility boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const saveMemory = async () => {
    const nextTitle = title.trim()
    const nextFact = fact.trim()
    if (!nextTitle || !nextFact || saving) return
    setSaving(true)
    try {
      const response = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          writePath,
          title: nextTitle,
          fact: nextFact,
          sensitivity,
          pinned,
          idempotencyKey: `memory-ui:${crypto.randomUUID()}`,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { memory?: MemoryWorkspaceRecord; error?: string }
      if (!response.ok || !payload.memory) throw new Error(payload.error || '保存记忆失败')
      setMemories((current) => [payload.memory!, ...current.filter((memory) => memory.id !== payload.memory!.id)])
      setTitle('')
      setFact('')
      setWritePath('remember')
      setSensitivity('normal')
      setPinned(false)
      setError('')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存记忆失败')
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async (memory: MemoryWorkspaceRecord) => {
    const nextTitle = editingTitle.trim()
    const nextFact = editingFact.trim()
    if (!nextTitle || !nextFact || editingSaving || !requireManageable(memory)) return
    setEditingSaving(true)
    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(memory.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          reason: '用户在记忆页修订事实。',
          title: nextTitle,
          fact: nextFact,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { memory?: MemoryWorkspaceRecord; error?: string }
      if (!response.ok || !payload.memory) throw new Error(payload.error || '更新记忆失败')
      setMemories((current) => current.map((entry) => entry.id === memory.id ? payload.memory! : entry))
      setEditingId(null)
      setError('')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '更新记忆失败')
    } finally {
      setEditingSaving(false)
    }
  }

  const changeStatus = async (memory: MemoryWorkspaceRecord, status: 'active' | 'disputed' | 'deleted') => {
    const verb = status === 'deleted' ? '删除' : status === 'active' ? '恢复为有效' : '标记为有争议'
    if (!requireManageable(memory)) return
    if (status === 'deleted' && !window.confirm(`确定${verb}“${memory.title}”吗？这会保留审计记录，但不再注入任务上下文。`)) return
    try {
      const requestPath = status === 'deleted'
        ? `/api/memories/${encodeURIComponent(memory.id)}`
        : `/api/memories/${encodeURIComponent(memory.id)}/status`
      const response = await fetch(requestPath, {
        method: status === 'deleted' ? 'DELETE' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(status === 'deleted'
          ? { projectId, reason: '用户从记忆页删除事实。' }
          : { projectId, status, reason: status === 'active' ? '用户从记忆页恢复事实。' : '用户标记该事实需要复核。' }),
      })
      const payload = await response.json().catch(() => ({})) as { memory?: MemoryWorkspaceRecord; error?: string }
      if (!response.ok || !payload.memory) throw new Error(payload.error || `${verb}失败`)
      setMemories((current) => status === 'deleted'
        ? current.filter((entry) => entry.id !== memory.id)
        : current.map((entry) => entry.id === memory.id ? payload.memory! : entry))
      setError('')
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : `${verb}失败`)
    }
  }

  return <ScrollArea className="workspace-page-scroll" type="auto">
    <main className="grok-page library-page" aria-label="可检查记忆">
      <Group className="grok-page-title" justify="space-between" align="center" wrap="nowrap">
        <Box><Title order={1}>记忆</Title><Text c="dimmed" size="sm" mt={4}>只保存你明确确认的事实；每条都带来源、作用域和可撤销状态。</Text>{projectId && <Text c="dimmed" size="xs" mt={4}>通用记忆会在项目中只读显示；请在独立任务范围内管理它。</Text>}</Box>
        <Button variant="default" color="gray" radius="xl" leftSection={<IconRefresh size={16} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
      </Group>
      <Paper className="memory-composer" p="md" radius="lg">
        <Group justify="space-between" align="flex-start" wrap="nowrap"><Box><Text fw="var(--weight-bold)">保存一条可复用事实</Text><Text size="xs" c="dimmed" mt={3}>{projectId ? '将仅用于当前项目，并可引用你的通用偏好。' : '这是一条独立任务可用的本地用户记忆。'}</Text></Box><Badge variant="light" color="gray">本机存储</Badge></Group>
        <Stack gap={10} mt="md">
          <TextInput value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：回答偏好" aria-label="记忆标题" maxLength={512} />
          <Textarea value={fact} onChange={(event) => setFact(event.currentTarget.value)} placeholder="例如：用户偏好简洁的中文回答；生成代码后先给出验证结果。" aria-label="记忆事实" autosize minRows={3} maxRows={7} maxLength={24_000} />
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap={8} wrap="wrap"><label className="memory-field-label">类型<select value={writePath} onChange={(event) => setWritePath(event.currentTarget.value)}><option value="remember">事实</option><option value="accepted-decision">已确认决策</option></select></label><label className="memory-field-label">敏感级别<select value={sensitivity} onChange={(event) => setSensitivity(event.currentTarget.value as MemoryRecordView['sensitivity'])}><option value="normal">普通</option><option value="sensitive">敏感</option><option value="restricted">受限（不自动注入）</option></select></label><label className="memory-checkbox"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.currentTarget.checked)} />始终优先</label></Group>
            <Button color="dark" radius="xl" loading={saving} disabled={!title.trim() || !fact.trim()} onClick={() => void saveMemory()} leftSection={<IconBrain size={17} />}>保存记忆</Button>
          </Group>
        </Stack>
      </Paper>
      {error && <Paper className="page-inline-error" role="alert" p="md" radius="lg" mt="md"><IconAlertCircle size={18} /><Text size="sm">{error}</Text></Paper>}
      <Group className="page-section-heading" justify="space-between" mt={34} mb={14}><Text className="page-eyebrow" m={0}>可检查事实</Text><Text size="sm" c="dimmed">{memories.length}</Text></Group>
      {loading && <div className="page-loading"><IconLoader2 className="spin" size={22} /><Text size="sm" c="dimmed">正在读取本机记忆…</Text></div>}
      {!loading && !memories.length && <Paper className="page-empty-state" p="xl" radius="lg"><ThemeIcon variant="light" color="gray" radius="xl" size={44}><IconBrain size={21} /></ThemeIcon><Text fw="var(--weight-bold)">还没有可复用记忆</Text><Text size="sm" c="dimmed">只把以后确实需要回忆的事实写入这里；不会自动摘录对话。</Text></Paper>}
      <Stack gap={10} className="memory-list">{memories.map((memory) => {
        const ownership = ownershipFor(memory)
        const recoverable = memory.status === 'disputed' || memory.status === 'superseded'
        return <Paper key={memory.id} className={`memory-card ${memory.status !== 'active' ? 'is-inactive' : ''}`} p="md" radius="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap"><Box className="catalog-card-copy"><Group gap={7} wrap="wrap"><Text fw="var(--weight-bold)">{memory.title}</Text>{memory.pinned && <Badge size="xs" color="teal" variant="light">优先</Badge>}<Badge size="xs" color={memory.status === 'active' ? 'gray' : 'orange'} variant="light">{memory.status === 'active' ? '有效' : memory.status === 'disputed' ? '待复核' : '已替代'}</Badge><Badge size="xs" color={ownership.canManage ? 'blue' : 'gray'} variant="outline">{ownership.label}</Badge><Badge size="xs" color="gray" variant="outline">{memory.sensitivity}</Badge></Group><Text size="sm" mt={7} className="memory-fact">{memory.fact}</Text><Text size="xs" c="dimmed" mt={8}>作用域：{ownership.detail} · 来源：{memory.provenance.sourceTaskId ? `任务 ${memory.provenance.sourceTaskId.slice(0, 12)}…` : '手动确认'} · {memory.provenance.sourceEventIds.length} 条来源记录 · 置信度 {Math.round(memory.confidence * 100)}%</Text></Box>
            {ownership.canManage ? <Group gap={2} wrap="nowrap">{memory.status === 'active' && <><Tooltip label="编辑"><ActionIcon variant="subtle" color="gray" aria-label={`编辑记忆：${memory.title}`} onClick={() => { setEditingId(memory.id); setEditingTitle(memory.title); setEditingFact(memory.fact) }}><IconPencil size={16} /></ActionIcon></Tooltip><Tooltip label="标记待复核"><ActionIcon variant="subtle" color="orange" aria-label={`标记待复核：${memory.title}`} onClick={() => void changeStatus(memory, 'disputed')}><IconAlertCircle size={16} /></ActionIcon></Tooltip></>}{recoverable && <Tooltip label="恢复为有效"><ActionIcon variant="subtle" color="teal" aria-label={`恢复记忆：${memory.title}`} onClick={() => void changeStatus(memory, 'active')}><IconRefresh size={16} /></ActionIcon></Tooltip>}<Tooltip label="删除"><ActionIcon variant="subtle" color="red" aria-label={`删除记忆：${memory.title}`} onClick={() => void changeStatus(memory, 'deleted')}><IconTrash size={16} /></ActionIcon></Tooltip></Group> : <Text size="xs" c="dimmed" ta="right" maw={144}>{ownership.detail}</Text>}
          </Group>
          {editingId === memory.id && ownership.canManage && <Paper className="memory-edit" p="sm" radius="md" mt="md"><Stack gap={8}><TextInput value={editingTitle} onChange={(event) => setEditingTitle(event.currentTarget.value)} aria-label="编辑记忆标题" /><Textarea value={editingFact} onChange={(event) => setEditingFact(event.currentTarget.value)} autosize minRows={3} aria-label="编辑记忆事实" /><Group justify="flex-end"><Button variant="default" color="gray" size="xs" onClick={() => setEditingId(null)}>取消</Button><Button color="dark" size="xs" loading={editingSaving} onClick={() => void saveEdit(memory)}>保存修订</Button></Group></Stack></Paper>}
        </Paper>
      })}</Stack>
    </main>
  </ScrollArea>
}

function SkillsWorkspace({
  tab,
  search,
  bridgeState,
  projectRunnerEnabled,
  providerRegistry,
  providerHealth,
  onTabChange,
  onSearchChange,
  onUsePrompt,
}: {
  tab: CatalogTab
  search: string
  bridgeState: BridgeState
  projectRunnerEnabled: boolean
  providerRegistry?: ProviderRegistryView
  providerHealth?: ProviderHealthView
  onTabChange: (tab: CatalogTab) => void
  onSearchChange: (value: string) => void
  onUsePrompt: (prompt: string) => void
}) {
  const providerCards: CapabilityCard[] = (providerRegistry?.providers ?? []).map((provider) => {
    const health = providerHealth?.providers.find((entry) => entry.providerId === provider.id)
    const status = health?.status === 'ready'
      ? '已就绪'
      : health?.status === 'degraded'
        ? '部分可用'
        : provider.runtimeBinding === 'unbound'
          ? '未绑定执行器'
          : '不可用'
    return {
      name: provider.label,
      description: provider.runtimeBinding === 'grok-acp'
        ? `通过既有 ${provider.route ?? '/acp'} 本地桥接运行；模型与权限状态来自本机运行时。`
        : '已登记能力契约，但尚未绑定可执行的本地 Provider；不会伪装为可用。',
      status,
      icon: IconPlugConnected,
    }
  })
  const connectorCatalog: CapabilityCard[] = [
    { name: 'ACP Bridge', description: '连接 Web 界面与本地 RunBuild Agent。', status: bridgeState === 'connected' ? '已连接' : bridgeState === 'connecting' ? '连接中' : '未连接', icon: IconPlugConnected },
    { name: '项目 Runner', description: '每个项目使用独立 cwd、会话和沙箱边界运行。', status: projectRunnerEnabled ? '已启用' : '未启用', icon: IconTerminal2 },
    ...providerCards,
    { name: '项目 MCP', description: '连接器由项目目录中的 .mcp.json 与 Agent 配置共同管理。', status: '项目级', icon: IconTool },
    { name: 'GitHub', description: '通过本地 Git 与已授权的 GitHub 工作流访问代码仓库。', status: '按需使用', icon: IconBrandGithub },
  ]
  const query = search.trim().toLowerCase()
  const items = (tab === 'skills' ? skillCatalog : connectorCatalog).filter((item) => `${item.name} ${item.description} ${item.status}`.toLowerCase().includes(query))

  return <ScrollArea className="workspace-page-scroll" type="auto">
    <main className="grok-page library-page" aria-label="技能和连接器">
      <div className="skills-heading">
        <Box><Title order={1}>技能和连接器</Title><div className="catalog-tabs" role="tablist" aria-label="技能和连接器分类"><button type="button" role="tab" aria-selected={tab === 'skills'} className={`grok-tab ${tab === 'skills' ? 'is-active' : ''}`} onClick={() => onTabChange('skills')}>技能</button><button type="button" role="tab" aria-selected={tab === 'connectors'} className={`grok-tab ${tab === 'connectors' ? 'is-active' : ''}`} onClick={() => onTabChange('connectors')}>连接器</button></div></Box>
        <Stack className="skills-actions" gap={12} align="stretch"><Button className="page-primary-action" color="dark" radius="xl" leftSection={<IconSparkles size={17} />} onClick={() => onUsePrompt('请根据当前项目创建一个可复用的 RunBuild 技能，并先说明它的触发条件、步骤和安全边界。')}>用 Agent 创建</Button><TextInput className="skills-search" value={search} onChange={(event) => onSearchChange(event.currentTarget.value)} placeholder="搜索…" leftSection={<IconSearch size={20} />} /></Stack>
      </div>
      <Text className="page-eyebrow">{tab === 'skills' ? '可用技能' : '本地连接'}</Text>
      <div className={tab === 'skills' ? 'skills-grid' : 'connectors-grid'}>
        {items.map((item) => {
          const ItemIcon = item.icon
          return <Paper key={item.name} className={tab === 'skills' ? 'skill-card' : 'connector-card'} p="md" radius="lg"><Group wrap="nowrap" align="flex-start"><ThemeIcon variant="light" color="gray" radius="md" size={40}><ItemIcon size={20} /></ThemeIcon><Box className="catalog-card-copy"><Group justify="space-between" wrap="nowrap"><Text className="catalog-card-title" fw="var(--weight-bold)">{item.name}</Text><Badge variant="light" color={item.status === '已连接' || item.status === '已启用' || item.status === '已就绪' ? 'teal' : item.status === '部分可用' ? 'orange' : 'gray'}>{item.status}</Badge></Group><Text className="catalog-card-description" c="dimmed" size="sm">{item.description}</Text></Box></Group></Paper>
        })}
      </div>
      {!items.length && <Paper className="page-empty-state" p="xl" radius="lg"><IconSearch size={22} /><Text fw="var(--weight-bold)">没有匹配结果</Text><Text size="sm" c="dimmed">换一个关键词再试。</Text></Paper>}
    </main>
  </ScrollArea>
}

function DesktopStartupScreen({ snapshot }: { snapshot: DesktopStartupSnapshot | null }) {
  const steps = snapshot?.steps ?? [
    { id: 'workspace' as const, label: '准备本地工作区', state: 'running' as const },
    { id: 'workbench' as const, label: '启动桌面工作台', state: 'pending' as const },
    { id: 'agent' as const, label: '连接本地 Agent', state: 'pending' as const },
  ]
  const completed = steps.filter((step) => step.state === 'ready' || step.state === 'warning').length
  const progress = Math.round((completed / steps.length) * 100)
  const currentStep = steps.find((step) => step.state === 'running')
    ?? steps.find((step) => step.state === 'warning')
    ?? steps[steps.length - 1]
  const warningStep = [...steps].reverse().find((step) => step.state === 'warning')
  const status = snapshot?.state === 'degraded'
    ? warningStep?.detail ? `${warningStep.label}：${warningStep.detail}` : '本地 Agent 暂未就绪，正在进入受限模式'
    : snapshot?.state === 'ready' ? '本地工作台与 Agent 会话已准备完成' : currentStep.label

  return <main className={`desktop-startup ${snapshot?.state === 'degraded' ? 'is-degraded' : ''}`} aria-busy={snapshot?.state !== 'ready' && snapshot?.state !== 'degraded'}>
    <div className="desktop-startup-stack">
      <img className="desktop-startup-mark" src="/grok-build-icon-v5.png" alt="" />
      <div className="desktop-startup-copy">
        <h1>RunBuild</h1>
        <p>你的本地编程工作台</p>
      </div>
      <div className="desktop-startup-progress-wrap">
        <div
          className="desktop-startup-progress"
          role="progressbar"
          aria-label="应用初始化进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={status}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="desktop-startup-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  </main>
}

function DesktopRuntimeGate() {
  const [nativeSnapshot, setNativeSnapshot] = useState<DesktopInitializationSnapshot | null>(null)
  const [nativeSettled, setNativeSettled] = useState(!isDesktopRuntime)
  const [sessionState, setSessionState] = useState<DesktopSessionState>({ state: 'starting' })
  const [released, setReleased] = useState(!isDesktopRuntime)

  useEffect(() => {
    if (!isDesktopRuntime) return
    let disposed = false
    let pollTimer: number | null = null
    const controller = new AbortController()
    const poll = async () => {
      try {
        const response = await fetch('/api/bridge-config', { cache: 'no-store', signal: controller.signal })
        const payload = await response.json() as BridgeConfig
        if (!response.ok || !payload.initialization) throw new Error(payload.runtimeError || '无法读取桌面初始化状态')
        if (disposed) return
        setNativeSnapshot(payload.initialization)
        if (payload.initialization.state === 'starting') {
          pollTimer = window.setTimeout(() => { void poll() }, 180)
        } else {
          setNativeSettled(true)
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        setNativeSnapshot({
          state: 'degraded',
          steps: [
            { id: 'workspace', label: '准备本地工作区', state: 'ready' },
            { id: 'workbench', label: '启动桌面工作台', state: 'ready' },
            { id: 'agent', label: '读取 Agent 状态', state: 'warning', detail: error instanceof Error ? error.message : '状态读取失败' },
          ],
        })
        setNativeSettled(true)
      }
    }
    void poll()
    return () => {
      disposed = true
      controller.abort()
      if (pollTimer !== null) window.clearTimeout(pollTimer)
    }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime || !nativeSettled || sessionState.state === 'starting' || released) return
    const releaseTimer = window.setTimeout(
      () => setReleased(true),
      sessionState.state === 'interaction' ? 120 : sessionState.state === 'ready' ? 650 : 1_400,
    )
    return () => window.clearTimeout(releaseTimer)
  }, [nativeSettled, released, sessionState.state])

  const startupSnapshot = useMemo<DesktopStartupSnapshot | null>(() => {
    if (!nativeSnapshot) return null
    if (!nativeSettled) return nativeSnapshot
    const sessionStep = sessionState.state === 'ready'
      ? { id: 'session', label: '准备 Agent 会话', state: 'ready' as const }
      : sessionState.state === 'interaction'
        ? { id: 'session', label: '等待你的确认', state: 'warning' as const, detail: sessionState.detail || 'Agent 正在等待逐项授权' }
      : sessionState.state === 'failed'
        ? { id: 'session', label: '准备 Agent 会话', state: 'warning' as const, detail: sessionState.detail || '会话初始化失败' }
        : { id: 'session', label: '准备 Agent 会话', state: 'running' as const }
    const state = sessionState.state === 'starting'
      ? 'starting'
      : sessionState.state === 'ready' && nativeSnapshot.state !== 'degraded' ? 'ready' : 'degraded'
    return { state, steps: [...nativeSnapshot.steps, sessionStep] }
  }, [nativeSettled, nativeSnapshot, sessionState])

  if (!isDesktopRuntime) return <App />
  return <>
    {nativeSettled && <div ref={(node) => { node?.toggleAttribute('inert', !released) }} className="desktop-runtime-surface" aria-hidden={!released}>
      <App onDesktopSessionState={setSessionState} desktopSurfaceReady={released} />
    </div>}
    {!released && <div className="desktop-startup-overlay"><DesktopStartupScreen snapshot={startupSnapshot} /></div>}
  </>
}

function DesktopPermissionSetup({
  opened,
  snapshot,
  busy,
  error,
  onClose,
  onRequestMicrophone,
  onOpenMicrophoneSettings,
  onOpenScreenRecordingSettings,
  onRequestAccessibility,
  onOpenFullDiskAccessSettings,
  onComplete,
  onContinueLimited,
}: {
  opened: boolean
  snapshot: DesktopSetupSnapshot | null
  busy: boolean
  error: string
  onClose: () => void
  onRequestMicrophone: () => void
  onOpenMicrophoneSettings: () => void
  onOpenScreenRecordingSettings: () => void
  onRequestAccessibility: () => void
  onOpenFullDiskAccessSettings: () => void
  onComplete: () => void
  onContinueLimited: () => void
}) {
  const microphoneState = snapshot?.microphone.state ?? 'unknown'
  const microphoneGranted = microphoneState === 'granted' || microphoneState === 'not-required'
  const microphoneBlocked = microphoneState === 'denied' || microphoneState === 'restricted'
  const screenRecordingState = snapshot?.screenRecording.state ?? 'unknown'
  const screenRecordingGranted = screenRecordingState === 'granted' || screenRecordingState === 'not-required'
  const screenRecordingBlocked = screenRecordingState === 'denied' || screenRecordingState === 'restricted'
  const accessibilityGranted = snapshot?.accessibility.trusted ?? false
  const fullDiskAccessState = snapshot?.fullDiskAccess.state ?? 'unknown'
  const fullDiskAccessGranted = fullDiskAccessState === 'granted' || fullDiskAccessState === 'not-required'
  const fullDiskAccessBlocked = fullDiskAccessState === 'denied'
  const requiredGrantedCount = [microphoneGranted, screenRecordingGranted, accessibilityGranted].filter(Boolean).length
  const stateLabel = (state: DesktopMicrophoneState) => state === 'granted'
    ? '已授权'
    : state === 'not-determined' ? '等待授权'
      : state === 'denied' || state === 'restricted' ? '未授权'
        : state === 'not-required' ? '无需系统授权' : '状态不可用'
  const microphoneAction = snapshot?.microphone.canOpenSettings
    ? onOpenMicrophoneSettings
    : snapshot?.microphone.canRequest ? onRequestMicrophone : null
  const permissionCard = ({
    id,
    title,
    description,
    status,
    granted,
    blocked = false,
    optional = false,
    icon: Icon,
    action,
    actionLabel,
  }: {
    id: string
    title: string
    description: string
    status: string
    granted: boolean
    blocked?: boolean
    optional?: boolean
    icon: EventIcon
    action?: (() => void) | null
    actionLabel?: string
  }) => {
    const cardClassName = `desktop-permission-card ${granted ? 'is-granted' : blocked ? 'is-blocked' : ''}`
    const content = <>
      <Group className="desktop-permission-card-top" justify="space-between" wrap="nowrap">
        <ThemeIcon className="desktop-permission-card-icon" size={42} radius="md" variant="light"><Icon size={21} aria-hidden="true" /></ThemeIcon>
        <Badge color={granted ? 'teal' : blocked ? 'orange' : 'gray'} variant="light">{optional && !granted && !blocked ? '按需开启' : status}</Badge>
      </Group>
      <div className="desktop-permission-card-copy">
        <Text fw="var(--weight-bold)">{title}</Text>
        <Text id={id} size="sm" c="dimmed">{description}</Text>
      </div>
      <Group className="desktop-permission-card-result" gap={6} wrap="nowrap">
        {granted
          ? <><IconCircleCheck className="is-granted" size={18} aria-hidden="true" /><Text size="xs">已就绪</Text></>
          : action ? <><Text size="xs">{blocked || optional ? '前往系统设置' : '点击开启'}</Text><IconChevronRight size={17} aria-hidden="true" /></> : null}
      </Group>
    </>
    return action
      ? <button type="button" className={`${cardClassName} desktop-permission-card-action`} disabled={busy} onClick={action} aria-label={actionLabel} aria-describedby={id}>{content}</button>
      : <div className={cardClassName}>{content}</div>
  }

  return <Modal
    opened={opened}
    onClose={onClose}
    centered
    size="lg"
    closeOnClickOutside={!busy}
    closeOnEscape={!busy}
    trapFocus
    returnFocus
    withCloseButton={!busy}
    transitionProps={{ transition: 'pop', duration: 220, timingFunction: 'cubic-bezier(.2, .8, .2, 1)' }}
    title={<Group gap={14} wrap="nowrap" align="flex-start"><ThemeIcon className="desktop-permission-title-icon" size={48} radius="md" variant="light"><IconShieldLock size={25} stroke={1.7} /></ThemeIcon><Box className="desktop-permission-title-copy"><Text className="desktop-permission-eyebrow">RunBuild 桌面权限</Text><Title order={2}>完成授权，开始构建</Title><Text size="sm" c="dimmed">只开启桌面任务需要的能力，你可以随时在系统设置中更改。</Text></Box></Group>}
    classNames={{ root: 'desktop-permission-modal', content: 'desktop-permission-content', header: 'desktop-permission-header', body: 'desktop-permission-body' }}
    overlayProps={{ backgroundOpacity: .64, blur: 3 }}
  >
    <div className="desktop-permission-layout">
      <div className="desktop-permission-scroll">
        <section className="desktop-permission-progress" aria-labelledby="system-permission-heading">
          <Group justify="space-between" align="flex-end" gap={16} wrap="nowrap">
            <div>
              <Text id="system-permission-heading" fw="var(--weight-bold)">{snapshot?.allPermissionsGranted ? '核心权限已就绪' : '开启核心权限'}</Text>
              <Text size="sm" c="dimmed">麦克风、屏幕录制与辅助功能用于完成桌面任务。</Text>
            </div>
            <Text className="desktop-permission-progress-count" size="sm" fw="var(--weight-bold)">{requiredGrantedCount}/3</Text>
          </Group>
          <Progress value={(requiredGrantedCount / 3) * 100} size={6} radius="xl" color="teal" aria-label={`已开启 ${requiredGrantedCount} 项核心权限，共 3 项`} />
        </section>

        <section className="desktop-permission-section" aria-label="macOS 系统权限">
          <div className="desktop-permission-grid">
          {permissionCard({
            id: 'desktop-microphone-permission-description',
            title: '麦克风',
            description: '用于语音输入，不会自动发送。',
            status: stateLabel(microphoneState),
            granted: microphoneGranted,
            blocked: microphoneBlocked,
            icon: IconMicrophone,
            action: microphoneAction,
            actionLabel: snapshot?.microphone.canOpenSettings ? '打开麦克风系统设置' : '允许麦克风',
          })}
          {permissionCard({
            id: 'desktop-screen-recording-permission-description',
            title: '屏幕录制',
            description: '用于观察屏幕并验证桌面操作结果。',
            status: stateLabel(screenRecordingState),
            granted: screenRecordingGranted,
            blocked: screenRecordingBlocked,
            icon: IconScreenShare,
            action: snapshot?.screenRecording.canOpenSettings ? onOpenScreenRecordingSettings : null,
            actionLabel: '打开屏幕录制系统设置',
          })}
          {permissionCard({
            id: 'desktop-accessibility-permission-description',
            title: '辅助功能',
            description: '用于控制已打开的本机应用和界面。',
            status: accessibilityGranted ? '已授权' : '未授权',
            granted: accessibilityGranted,
            blocked: !accessibilityGranted,
            icon: IconAccessible,
            action: snapshot?.accessibility.canRequest ? onRequestAccessibility : null,
            actionLabel: '允许辅助功能控制',
          })}
          {permissionCard({
            id: 'desktop-full-disk-permission-description',
            title: '完全磁盘访问',
            description: '仅在处理受保护目录时按需开启。',
            status: stateLabel(fullDiskAccessState),
            granted: fullDiskAccessGranted,
            blocked: fullDiskAccessBlocked,
            optional: !fullDiskAccessGranted,
            icon: IconDatabase,
            action: snapshot?.fullDiskAccess.canOpenSettings ? onOpenFullDiskAccessSettings : null,
            actionLabel: '打开完全磁盘访问系统设置',
          })}
          </div>
        </section>

        <div className="desktop-permission-boundary">
          <ThemeIcon className="desktop-permission-boundary-icon" size={36} radius="md" variant="light"><IconShieldCheck size={19} aria-hidden="true" /></ThemeIcon>
          <div>
            <Group gap={7} wrap="wrap"><Text size="sm" fw="var(--weight-bold)">授权边界由你掌控</Text><Badge color="teal" variant="light">可随时更改</Badge></Group>
            <Text size="xs" c="dimmed">RunBuild 不会绕过 macOS 隐私保护；应用内“完全访问”只决定工具调用是否逐项确认。</Text>
          </div>
        </div>
        {error && <Text className="desktop-permission-error" role="alert" size="sm">{error}</Text>}
      </div>

      <div className="desktop-permission-footer">
        <Text className="desktop-permission-policy-note" size="xs" c="dimmed">以后也可以从侧栏底部的盾牌按钮重新打开此窗口。</Text>
        <Group className="desktop-permission-actions" justify="flex-end" gap={10}>
          <Button variant="default" disabled={busy} onClick={onContinueLimited}>稍后设置</Button>
          <Button data-autofocus color="dark" loading={busy} disabled={busy || !snapshot?.allPermissionsGranted} onClick={onComplete}>完成并进入 RunBuild</Button>
        </Group>
      </div>
    </div>
  </Modal>
}

type ComposerVanishFrame = {
  id: number
  text: string
  height: number
}

function ComposerVanishCanvas({
  frame,
  onComplete,
}: {
  frame: ComposerVanishFrame
  onComplete: (id: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const canvas = canvasRef.current
    const shell = canvas?.parentElement
    const textarea = shell?.querySelector('textarea')
    if (!canvas || !shell || !textarea) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const timeoutId = window.setTimeout(() => onCompleteRef.current(frame.id), 90)
      return () => window.clearTimeout(timeoutId)
    }

    const width = Math.max(1, Math.ceil(shell.clientWidth))
    const height = Math.max(1, Math.ceil(shell.clientHeight))
    const density = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.ceil(width * density)
    canvas.height = Math.ceil(height * density)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    const styles = window.getComputedStyle(textarea)
    const fontSize = Number.parseFloat(styles.fontSize) || 16
    const parsedLineHeight = Number.parseFloat(styles.lineHeight)
    const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.45
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0
    const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0
    const paddingRight = Number.parseFloat(styles.paddingRight) || 0
    const maxLineWidth = Math.max(1, width - paddingLeft - paddingRight)

    context.scale(density, density)
    context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`
    context.fillStyle = styles.color
    context.textBaseline = 'top'

    const lines: string[] = []
    let line = ''
    for (const character of Array.from(frame.text)) {
      if (character === '\n') {
        lines.push(line)
        line = ''
        if (lines.length === 4) break
        continue
      }
      const candidate = line + character
      if (line && context.measureText(candidate).width > maxLineWidth) {
        lines.push(line)
        line = character
        if (lines.length === 4) break
      } else {
        line = candidate
      }
    }
    if (lines.length < 4 && line) lines.push(line)
    lines.slice(0, 4).forEach((entry, index) => {
      context.fillText(entry, paddingLeft, paddingTop + index * lineHeight, maxLineWidth)
    })

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const particles: Array<{ x: number; y: number; r: number; g: number; b: number; a: number; seed: number }> = []
    const sampleStep = Math.max(2, Math.round(density * 2))
    for (let y = 0; y < canvas.height; y += sampleStep) {
      for (let x = 0; x < canvas.width; x += sampleStep) {
        const offset = (y * canvas.width + x) * 4
        const alpha = pixels.data[offset + 3]
        if (alpha < 72) continue
        particles.push({
          x: x / density,
          y: y / density,
          r: pixels.data[offset],
          g: pixels.data[offset + 1],
          b: pixels.data[offset + 2],
          a: alpha / 255,
          seed: ((particles.length * 37) % 101) / 100,
        })
      }
    }

    let animationFrameId = 0
    let startedAt = 0
    const duration = 640
    const render = (time: number) => {
      if (!startedAt) startedAt = time
      const progress = Math.min(1, (time - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      context.setTransform(density, 0, 0, density, 0, 0)
      context.clearRect(0, 0, width, height)
      for (const particle of particles) {
        const driftX = eased * (10 + particle.seed * 42)
        const driftY = (particle.seed - .5) * eased * 13
        const opacity = particle.a * Math.pow(1 - progress, 1.4)
        const size = .7 + particle.seed * 1.2
        context.fillStyle = `rgba(${particle.r}, ${particle.g}, ${particle.b}, ${opacity})`
        context.fillRect(particle.x + driftX, particle.y + driftY, size, size)
      }
      if (progress < 1) {
        animationFrameId = window.requestAnimationFrame(render)
      } else {
        onCompleteRef.current(frame.id)
      }
    }
    animationFrameId = window.requestAnimationFrame(render)
    return () => window.cancelAnimationFrame(animationFrameId)
  }, [frame])

  return <canvas ref={canvasRef} className="composer-vanish-canvas" aria-hidden="true" />
}

type ArtifactPreviewStateProps = {
  state: 'loading' | 'not_created' | 'error'
  title: string
  description: string
  onRetry?: () => void
  onShowActivity?: () => void
}

const ArtifactPreviewState = ({
  state,
  title,
  description,
  onRetry,
  onShowActivity,
}: ArtifactPreviewStateProps) => {
  const loading = state === 'loading'
  const Icon = loading ? IconLoader2 : state === 'error' ? IconAlertCircle : IconFileText
  const color = loading ? 'teal' : state === 'error' ? 'red' : 'gray'

  return (
    <Paper
      className={`artifact-state-card is-${state}`}
      p="lg"
      radius="md"
      role={state === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Stack gap={12} align="center">
        <ThemeIcon className="artifact-state-icon" size={42} radius="xl" variant="light" color={color}>
          <Icon className={loading ? 'spin' : undefined} size={21} />
        </ThemeIcon>
        <Stack gap={4} align="center" className="artifact-state-copy">
          <Text fw="var(--weight-bold)">{title}</Text>
          <Text size="sm" c="dimmed">{description}</Text>
        </Stack>
        {loading && <Stack gap={7} className="artifact-state-skeleton" aria-hidden="true">
          <Skeleton height={8} radius="xl" width="78%" />
          <Skeleton height={8} radius="xl" width="100%" />
          <Skeleton height={8} radius="xl" width="62%" />
        </Stack>}
        {!loading && (onRetry || onShowActivity) && <Group gap={8} justify="center">
          {onRetry && <Button size="compact-sm" variant="default" leftSection={<IconRefresh size={14} />} onClick={onRetry}>刷新</Button>}
          {onShowActivity && <Button size="compact-sm" variant="subtle" color="gray" onClick={onShowActivity}>查看执行</Button>}
        </Group>}
      </Stack>
    </Paper>
  )
}

function App({
  onDesktopSessionState,
  desktopSurfaceReady = true,
}: {
  onDesktopSessionState?: (state: DesktopSessionState) => void
  desktopSurfaceReady?: boolean
} = {}) {
  const [model, setModel] = useState<string>(DEFAULT_MODEL_PROFILE)
  const [availableModels, setAvailableModels] = useState<RuntimeModel[]>([])
  const [modelSwitching, setModelSwitching] = useState(false)
  const [permissionPreference, setPermissionPreference] = useState<PermissionPreference>(DEFAULT_PERMISSION_PREFERENCE)
  const [permissionSwitching, setPermissionSwitching] = useState(false)
  const [desktopSetup, setDesktopSetup] = useState<DesktopSetupSnapshot | null>(null)
  const [desktopSetupOpened, setDesktopSetupOpened] = useState(false)
  const [desktopSetupQueued, setDesktopSetupQueued] = useState(false)
  const [desktopSetupBusy, setDesktopSetupBusy] = useState(false)
  const [desktopSetupError, setDesktopSetupError] = useState('')
  const [diagnosticsOpened, setDiagnosticsOpened] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState('')
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<DesktopDiagnosticsSnapshot | null>(null)
  const [diagnosticsLog, setDiagnosticsLog] = useState<DesktopDiagnosticsLogTail | null>(null)
  const [projectLifecycle, setProjectLifecycle] = useState<TaskProjectLifecycle[]>([])
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high')
  const [reasoningSwitching, setReasoningSwitching] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [inspectorOpened, setInspectorOpened] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('preview')
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection | null>(null)
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([])
  const [projectFilesLoading, setProjectFilesLoading] = useState(false)
  const [projectFilesError, setProjectFilesError] = useState('')
  const [projectLaunchState, setProjectLaunchState] = useState<ProjectLaunchState | null>(null)
  const [projectFilesNonce, setProjectFilesNonce] = useState(0)
  const [projectFilePreviewNonce, setProjectFilePreviewNonce] = useState(0)
  const [projectFilePreview, setProjectFilePreview] = useState<ProjectFilePreview | null>(null)
  const [projectFilePreviewLoading, setProjectFilePreviewLoading] = useState(false)
  const [projectFilePreviewError, setProjectFilePreviewError] = useState<ArtifactPreviewFailure | null>(null)
  const [sessionInfo, setSessionInfo] = useState<SessionInfoView | null>(null)
  const [sessionInfoLoading, setSessionInfoLoading] = useState(false)
  const [sessionInfoError, setSessionInfoError] = useState('')
  const [colorScheme, setColorScheme] = useState<ColorScheme>(startupColorScheme)
  const [composer, setComposer] = useState('')
  const [composerPromptIndex, setComposerPromptIndex] = useState(0)
  const [composerVanish, setComposerVanish] = useState<ComposerVanishFrame | null>(null)
  const composerVanishIdRef = useRef(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentDragActive, setAttachmentDragActive] = useState(false)
  const [attachmentLoadCount, setAttachmentLoadCount] = useState(0)
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [homeTaskProjectId, setHomeTaskProjectId] = useState<string | null | undefined>(undefined)
  const [pendingTaskSubmission, setPendingTaskSubmission] = useState<PendingTaskSubmission | null>(null)
  const [sessionsOpened, setSessionsOpened] = useState(false)
  const [sidebarOpened, setSidebarOpened] = useState(true)
  const [sidebarPeeked, setSidebarPeeked] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => initialPaneWidth('grok-build-sidebar-width', 320, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH))
  const [inspectorWidth, setInspectorWidth] = useState(() => initialPaneWidth(
    'grok-build-inspector-width',
    420,
    INSPECTOR_MIN_WIDTH,
    inspectorMaxWidth(window.innerWidth, sidebarWidth),
  ))
  const [page, setPage] = useState<WorkspacePage>('chat')
  const [searchOpened, setSearchOpened] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [agentMode] = useState<'auto' | 'fast' | 'expert'>('auto')
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [bridgeProjectId, setBridgeProjectId] = useState<string | null>(null)
  const [projectsExpanded, setProjectsExpanded] = useState(() => initialBooleanPreference('runbuild-sidebar-projects-expanded-v1', true))
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(() => initialBooleanPreference('runbuild-sidebar-history-expanded-v1', true))
  const [projectStep, setProjectStep] = useState<'chooser' | 'details' | 'import' | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectRootPath, setProjectRootPath] = useState('')
  const [projectInstructions, setProjectInstructions] = useState('')
  const [projectEditingId, setProjectEditingId] = useState<string | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)
  const [projectFolderPicking, setProjectFolderPicking] = useState(false)
  const [projectSaveError, setProjectSaveError] = useState('')
  const [projectSort, setProjectSort] = useState<'priority' | 'updated' | 'manual'>(() => initialChoicePreference('runbuild-sidebar-project-sort-v1', ['priority', 'updated', 'manual'] as const, 'priority'))
  const [historySort, setHistorySort] = useState<'priority' | 'created'>(() => initialChoicePreference('runbuild-sidebar-history-sort-v1', ['priority', 'created'] as const, 'priority'))
  const [manualProjectOrder, setManualProjectOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('grok-build-project-order') ?? '[]') as unknown
      return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : []
    } catch { return [] }
  })
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>(() => initialStringListPreference('runbuild-sidebar-pinned-projects-v1'))
  const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>(() => initialStringListPreference('runbuild-sidebar-pinned-history-v1'))
  const [archivedConversationIds, setArchivedConversationIds] = useState<string[]>(() => initialStringListPreference('runbuild-sidebar-archived-history-v1'))
  const [sidebarPreferencesHydrated, setSidebarPreferencesHydrated] = useState(!isDesktopRuntime)
  const [automations, setAutomations] = useState<StoredAutomation[]>([])
  const [automationRuns, setAutomationRuns] = useState<AutomationRunView[]>([])
  const [automationsLoading, setAutomationsLoading] = useState(true)
  const [automationsError, setAutomationsError] = useState('')
  const [automationDialogOpened, setAutomationDialogOpened] = useState(false)
  const [automationName, setAutomationName] = useState('')
  const [automationScheduleKind, setAutomationScheduleKind] = useState<AutomationScheduleView['kind']>('manual')
  const [automationIntervalMinutes, setAutomationIntervalMinutes] = useState<number | ''>(60)
  const [automationDailyTime, setAutomationDailyTime] = useState('09:00')
  const [automationMaxAttempts, setAutomationMaxAttempts] = useState<number | ''>(2)
  const [automationMaxWallClockMinutes, setAutomationMaxWallClockMinutes] = useState<number | ''>(45)
  const [automationInstruction, setAutomationInstruction] = useState('')
  const [automationSaving, setAutomationSaving] = useState(false)
  const [automationActionId, setAutomationActionId] = useState<string | null>(null)
  const [pendingAutomationHandoff, setPendingAutomationHandoff] = useState<PendingAutomationHandoff | null>(null)
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('skills')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [bridgeState, setBridgeState] = useState<BridgeState>('offline')
  const [bridgeConfig, setBridgeConfig] = useState<BridgeConfig | null>(null)
  const [bridgeError, setBridgeError] = useState('')
  const [sessionReady, setSessionReady] = useState(false)
  const [restoringSession, setRestoringSession] = useState<RestoringSession | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [, setTaskRuntimeVersion] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tools, setTools] = useState<ToolState[]>([])
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null)
  const [events, setEvents] = useState<Activity[]>(initialEvents)
  const [ledgerActivity, setLedgerActivity] = useState<TaskActivityProjection[]>([])
  const [goalExecution, setGoalExecution] = useState<GoalExecutionProjection | null>(null)
  const [sessionReliability, setSessionReliability] = useState<SessionReliabilityState>(() => createSessionReliabilityState())
  const [feedback, setFeedback] = useState<InteractionFeedback | null>(null)
  const [xaiAuthBusy, setXaiAuthBusy] = useState(false)
  const firstRunXaiAuthAttemptedRef = useRef(false)
  const [bridgeCommandCopyState, setBridgeCommandCopyState] = useState<BridgeCommandCopyState>('idle')
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = colorScheme
    try { window.localStorage.setItem('stillpoint-color-scheme', colorScheme) } catch { /* local preference is optional */ }
  }, [colorScheme])

  useEffect(() => {
    const api = window.grokDesktop
    if (!api) {
      if (isDesktopRuntime) {
        setDesktopSetupError('桌面权限桥接未加载；可先以受限模式继续。')
      }
      return
    }
    let disposed = false
    const refresh = async (queueIfIncomplete = false) => {
      try {
        const next = await api.getSetupState()
        if (disposed) return
        setDesktopSetup(next)
        setDesktopSetupError('')
        if (queueIfIncomplete && !next.onboarding.completed) setDesktopSetupQueued(true)
      } catch (error) {
        if (!disposed) {
          setDesktopSetupError(error instanceof Error ? error.message : '无法读取系统权限状态')
          if (queueIfIncomplete) setDesktopSetupQueued(true)
        }
      }
    }
    const openSetup = () => {
      setDesktopSetupQueued(true)
      void refresh(false)
    }
    const refreshOnFocus = () => { void refresh(false) }
    // Reading status is safe; opening the consent flow is a deliberate user
    // action only (settings button or a feature such as voice input).
    void refresh(false)
    window.addEventListener('grok-build:open-permission-setup', openSetup)
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      disposed = true
      window.removeEventListener('grok-build:open-permission-setup', openSetup)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [])

  useEffect(() => {
    const api = window.grokDesktop
    if (!api || !desktopSetupOpened) return
    let disposed = false
    let refreshing = false
    const refreshVisibleSetup = async () => {
      if (disposed || refreshing) return
      refreshing = true
      try {
        const next = await api.getSetupState()
        if (!disposed) {
          setDesktopSetup(next)
          setDesktopSetupError('')
        }
      } catch (error) {
        if (!disposed) setDesktopSetupError(error instanceof Error ? error.message : '无法刷新系统权限状态')
      } finally {
        refreshing = false
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshVisibleSetup()
    }
    const intervalId = window.setInterval(() => { void refreshVisibleSetup() }, 1_000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void refreshVisibleSetup()
    return () => {
      disposed = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [desktopSetupOpened])

  const desktopTaskSurfaceReady = isDesktopTaskSurfaceReady({
    bridgeState,
    bridgeProjectId,
    homeTaskProjectId,
    sessionReady,
  })

  useEffect(() => {
    if (!desktopSurfaceReady || !desktopSetupQueued || pendingPermission) return
    const sessionSettled = desktopTaskSurfaceReady || Boolean(bridgeError) || Boolean(bridgeConfig && !bridgeConfig.enabled)
    if (!sessionSettled) return
    setDesktopSetupOpened(true)
    setDesktopSetupQueued(false)
  }, [bridgeConfig, bridgeError, desktopSetupQueued, desktopSurfaceReady, desktopTaskSurfaceReady, pendingPermission])

  useEffect(() => {
    if (!pendingPermission || !desktopSetupOpened) return
    setDesktopSetupOpened(false)
    setDesktopSetupQueued(true)
  }, [desktopSetupOpened, pendingPermission])

  useEffect(() => {
    if (!onDesktopSessionState) return
    if (pendingPermission && !sessionReady) {
      onDesktopSessionState({ state: 'interaction', detail: `等待授权：${pendingPermission.title}` })
      return
    }
    if (desktopTaskSurfaceReady) {
      onDesktopSessionState({ state: 'ready' })
      return
    }
    if (bridgeError || (bridgeConfig && !bridgeConfig.enabled)) {
      onDesktopSessionState({
        state: 'failed',
        detail: bridgeError || bridgeConfig?.runtimeError || '本地 Agent 暂不可用',
      })
      return
    }
    onDesktopSessionState({ state: 'starting' })
  }, [bridgeConfig, bridgeError, desktopTaskSurfaceReady, onDesktopSessionState, pendingPermission, sessionReady])

  useEffect(() => {
    try { window.localStorage.setItem('grok-build-sidebar-width', String(sidebarWidth)) } catch { /* local preference is optional */ }
  }, [sidebarWidth])

  useEffect(() => {
    try { window.localStorage.setItem('grok-build-inspector-width', String(inspectorWidth)) } catch { /* local preference is optional */ }
  }, [inspectorWidth])

  useEffect(() => {
    const constrainInspectorWidth = () => {
      if (!window.matchMedia('(min-width: 1101px)').matches) return
      const maximumWidth = inspectorMaxWidth(window.innerWidth, sidebarOpened ? sidebarWidth : 0)
      setInspectorWidth((current) => clamp(current, INSPECTOR_MIN_WIDTH, maximumWidth))
    }
    constrainInspectorWidth()
    window.addEventListener('resize', constrainInspectorWidth)
    return () => window.removeEventListener('resize', constrainInspectorWidth)
  }, [sidebarOpened, sidebarWidth])

  useEffect(() => {
    if (!projects.length || !sidebarPreferencesHydrated) return
    setManualProjectOrder((current) => {
      const available = new Set(projects.map((project) => project.id))
      const retained = current.filter((id) => available.has(id))
      const retainedSet = new Set(retained)
      return [...retained, ...projects.map((project) => project.id).filter((id) => !retainedSet.has(id))]
    })
  }, [projects, sidebarPreferencesHydrated])

  useEffect(() => {
    if (!isDesktopRuntime) return
    let disposed = false
    void fetch('/api/sidebar-preferences').then(async (response) => {
      if (!response.ok) throw new Error(`侧边栏偏好读取失败 (${response.status})`)
      return response.json() as Promise<{ preferences?: SidebarPreferences | null }>
    }).then(({ preferences }) => {
      if (disposed || !preferences) return
      setProjectsExpanded(preferences.projectsExpanded)
      setHistoryExpanded(preferences.historyExpanded)
      setProjectSort(preferences.projectSort)
      setHistorySort(preferences.historySort)
      setManualProjectOrder(preferences.manualProjectOrder)
      setPinnedProjectIds(preferences.pinnedProjectIds)
      setPinnedConversationIds(preferences.pinnedConversationIds)
      setArchivedConversationIds(preferences.archivedConversationIds)
      setSidebarWidth(preferences.sidebarWidth)
    }).catch(() => undefined).finally(() => {
      if (!disposed) setSidebarPreferencesHydrated(true)
    })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime || !sidebarPreferencesHydrated) return
    void Promise.all([
      restoreDurableArchivedTasks(),
      refreshProjectLifecycle(),
    ]).catch(() => undefined)
  }, [sidebarPreferencesHydrated])

  useEffect(() => {
    try { window.localStorage.setItem('grok-build-project-order', JSON.stringify(manualProjectOrder)) } catch { /* local ordering is optional */ }
  }, [manualProjectOrder])

  useEffect(() => {
    try {
      window.localStorage.setItem('runbuild-sidebar-projects-expanded-v1', String(projectsExpanded))
      window.localStorage.setItem('runbuild-sidebar-history-expanded-v1', String(historyExpanded))
      window.localStorage.setItem('runbuild-sidebar-project-sort-v1', projectSort)
      window.localStorage.setItem('runbuild-sidebar-history-sort-v1', historySort)
      window.localStorage.setItem('runbuild-sidebar-pinned-projects-v1', JSON.stringify(pinnedProjectIds))
      window.localStorage.setItem('runbuild-sidebar-pinned-history-v1', JSON.stringify(pinnedConversationIds))
      window.localStorage.setItem('runbuild-sidebar-archived-history-v1', JSON.stringify(archivedConversationIds))
    } catch { /* sidebar preferences are optional */ }
  }, [archivedConversationIds, historyExpanded, historySort, pinnedConversationIds, pinnedProjectIds, projectSort, projectsExpanded])

  useEffect(() => {
    if (!isDesktopRuntime || !sidebarPreferencesHydrated) return
    const timeoutId = window.setTimeout(() => {
      const preferences: SidebarPreferences = {
        version: 1,
        projectsExpanded,
        historyExpanded,
        projectSort,
        historySort,
        manualProjectOrder,
        pinnedProjectIds,
        pinnedConversationIds,
        archivedConversationIds,
        sidebarWidth,
      }
      void fetch('/api/sidebar-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(preferences),
      }).catch(() => undefined)
    }, 180)
    return () => window.clearTimeout(timeoutId)
  }, [archivedConversationIds, historyExpanded, historySort, manualProjectOrder, pinnedConversationIds, pinnedProjectIds, projectSort, projectsExpanded, sidebarPreferencesHydrated, sidebarWidth])

  const fetchAutomationSnapshot = async () => {
    const [automationsResponse, runsResponse] = await Promise.all([
      fetch('/api/automations', { cache: 'no-store' }),
      fetch('/api/automation-runs?limit=120', { cache: 'no-store' }),
    ])
    const automationsPayload = await automationsResponse.json() as { automations?: StoredAutomation[]; error?: string }
    const runsPayload = await runsResponse.json() as { runs?: AutomationRunView[]; error?: string }
    if (!automationsResponse.ok) throw new Error(automationsPayload.error || '自动化读取失败')
    if (!runsResponse.ok) throw new Error(runsPayload.error || '自动化运行记录读取失败')
    return {
      automations: Array.isArray(automationsPayload.automations) ? automationsPayload.automations : [],
      runs: Array.isArray(runsPayload.runs) ? runsPayload.runs : [],
    }
  }
  const refreshAutomations = async (showLoading = false) => {
    if (showLoading) setAutomationsLoading(true)
    setAutomationsError('')
    try {
      const snapshot = await fetchAutomationSnapshot()
      setAutomations(snapshot.automations)
      setAutomationRuns(snapshot.runs)
      return snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动化读取失败'
      setAutomationsError(message)
      throw error
    } finally {
      if (showLoading) setAutomationsLoading(false)
    }
  }
  useEffect(() => {
    let disposed = false
    setAutomationsLoading(true)
    setAutomationsError('')
    void fetchAutomationSnapshot().then((snapshot) => {
      if (disposed) return
      setAutomations(snapshot.automations)
      setAutomationRuns(snapshot.runs)
    }).catch((error) => {
      if (!disposed) setAutomationsError(error instanceof Error ? error.message : '自动化读取失败')
    }).finally(() => {
      if (!disposed) setAutomationsLoading(false)
    })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (page !== 'automations') return
    const intervalId = window.setInterval(() => { void refreshAutomations().catch(() => undefined) }, 15_000)
    return () => window.clearInterval(intervalId)
  }, [page])

  const toggleColorScheme = () => setColorScheme((current) => current === 'dark' ? 'light' : 'dark')
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({})
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const [connectionNonce, setConnectionNonce] = useState(0)
  const [commandIndex, setCommandIndex] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentDragDepthRef = useRef(0)
  const sidebarCollapseRef = useRef<HTMLButtonElement | null>(null)
  const sidebarEdgeRef = useRef<HTMLButtonElement | null>(null)
  const inspectorToggleRef = useRef<HTMLButtonElement | null>(null)
  const inspectorPanelRef = useRef<HTMLElement | null>(null)
  const chatViewportRef = useRef<HTMLDivElement | null>(null)
  const latestTaskScrollTargetRef = useRef<string | null>(null)
  const sidebarFocusRequestedRef = useRef(false)
  const sidebarCloseTimerRef = useRef<number | null>(null)
  const paneResizeCleanupRef = useRef<(() => void) | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const agentRestartingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const residentSessionIdsRef = useRef(new Set<string>())
  const sessionCursorsRef = useRef(new Map<string, string>())
  const replayResetStateRef = useRef(new Map<string, { hasCachedSnapshot: boolean; reset: boolean }>())
  const replayedRunIdRef = useRef<string | null>(null)
  const conversationsRef = useRef(conversations)
  const activeConversationIdRef = useRef(activeConversationId)
  const archivedConversationIdsRef = useRef(archivedConversationIds)
  const requestIdRef = useRef(1)
  const pendingRef = useRef(new Map<JsonRpcId, { resolve: (value: JsonRecord) => void; reject: (reason: Error) => void }>())
  const activeAgentMessageRef = useRef<string | null>(null)
  const turnStartedAtRef = useRef<number | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const automationClientIdRef = useRef(`automation-ui-${messageId()}`)
  const automationHandoffByTaskRef = useRef(new Map<string, { runId: string; claimId: string }>())
  const automationRunByAgentRunRef = useRef(new Map<string, { runId: string; claimId: string }>())
  const automationHandoffAttemptRef = useRef<string | null>(null)
  const sessionReliabilityRef = useRef<SessionReliabilityState>(sessionReliability)
  const promptDeadlineTimerRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const taskWorkspaceLoadRef = useRef(0)
  const toolReceiptsByRunRef = useRef(new Map<string, Map<string, AcpToolUpdateEvidence>>())
  const pendingUiVerificationByTaskRef = useRef(new Map<string, PendingUiVerification>())
  const taskEventQueueRef = useRef<Promise<void>>(Promise.resolve())
  const taskLedgerLastErrorRef = useRef('')
  const taskWorkspaceLastErrorRef = useRef('')
  const terminalEventsProcessingRef = useRef(new Set<string>())
  const goalRunBySourceRunRef = useRef(new Map<string, { goalRunId: string; taskId: string; projectId: string | null; authorizationMode: PermissionPreference }>())
  const cancelRequestedRunRef = useRef<string | null>(null)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)
  const questionAnswersRef = useRef<Record<string, string[]>>({})
  const pendingSessionIdRef = useRef<string | null>(null)
  const pendingNewScopeRef = useRef<string | null>(null)
  const pendingScopeTransitionRef = useRef<ScopeTransitionSnapshot | null>(null)
  const submittingRef = useRef(false)
  const taskRuntimesRef = useRef(new Map<string, TaskRuntime>())
  const pendingPermissionByTaskRef = useRef(new Map<string, PendingPermission>())
  const pendingQuestionByTaskRef = useRef(new Map<string, PendingQuestion>())
  const pendingPlanByTaskRef = useRef(new Map<string, PendingPlan>())
  const activeToolStepRef = useRef<HTMLButtonElement | null>(null)
  const projectSavingRef = useRef(false)
  const projectNameInputRef = useRef<HTMLInputElement | null>(null)
  const permissionPreferenceRef = useRef<PermissionPreference>(DEFAULT_PERMISSION_PREFERENCE)
  const deferredPermissionPreferenceRef = useRef<PermissionPreference | null>(null)
  const preferredModelRef = useRef<string | null>(null)
  const newSessionModelRef = useRef<string | null>(null)
  const silentModelUpdateRef = useRef<string | null>(null)
  const preferredReasoningRef = useRef<ReasoningEffort>('high')
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const speechBaseRef = useRef('')
  const sidebarVisible = sidebarOpened || sidebarPeeked
  const inspectorVisible = shouldShowTaskInspector({ page, opened: inspectorOpened })
  conversationsRef.current = conversations
  activeConversationIdRef.current = activeConversationId

  useEffect(() => {
    if (inspectorOpened && !inspectorVisible) setInspectorOpened(false)
  }, [inspectorOpened, inspectorVisible])

  useEffect(() => {
    sessionReliabilityRef.current = sessionReliability
  }, [sessionReliability])

  useEffect(() => () => {
    for (const runtime of taskRuntimesRef.current.values()) {
      if (runtime.promptDeadlineTimer !== null) window.clearTimeout(runtime.promptDeadlineTimer)
    }
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
  }, [])

  useEffect(() => {
    archivedConversationIdsRef.current = archivedConversationIds
  }, [archivedConversationIds])

  useEffect(() => {
    // A verification badge belongs to one task only.  A persisted projection
    // is restored from that task's checkpoint after switching, never carried
    // across projects or independent conversations.
    setGoalExecution(null)
  }, [activeConversationId])

  useEffect(() => {
    // Inspector data is task-scoped. Clear it synchronously on navigation so
    // an old session snapshot, restored ledger, or preview cannot leak into
    // the next task while its own data is loading.
    setSessionInfo(null)
    setSessionInfoLoading(false)
    setSessionInfoError('')
    setLedgerActivity([])
    setInspectorSelection(null)
  }, [activeConversationId, activeProjectId, homeTaskProjectId])

  useEffect(() => {
    if (projectStep !== 'details' || projectEditingId) return
    const frame = window.requestAnimationFrame(() => projectNameInputRef.current?.select())
    return () => window.cancelAnimationFrame(frame)
  }, [projectEditingId, projectStep])

  const paneMaxWidth = (pane: PaneKind) => {
    const occupiedWidth = pane === 'sidebar'
      ? inspectorVisible ? inspectorWidth : 0
      : sidebarOpened ? sidebarWidth : 0
    const availableWidth = window.innerWidth - occupiedWidth - MIN_CONVERSATION_WIDTH
    return pane === 'sidebar'
      ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, availableWidth))
      : inspectorMaxWidth(window.innerWidth, occupiedWidth)
  }

  const setPaneWidth = (pane: PaneKind, width: number) => {
    if (pane === 'sidebar') {
      setSidebarWidth(clamp(width, SIDEBAR_MIN_WIDTH, paneMaxWidth('sidebar')))
      return
    }
    setInspectorWidth(clamp(width, INSPECTOR_MIN_WIDTH, paneMaxWidth('inspector')))
  }

  const cancelPaneResize = () => {
    const cleanup = paneResizeCleanupRef.current
    paneResizeCleanupRef.current = null
    cleanup?.()
  }

  const startPaneResize = (pane: PaneKind) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(min-width: 1101px)').matches) return
    event.preventDefault()
    cancelPaneResize()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = pane === 'sidebar' ? sidebarWidth : inspectorWidth
    handle.setPointerCapture(pointerId)
    document.body.classList.add('is-resizing-pane')
    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      setPaneWidth(pane, pane === 'sidebar' ? startWidth + delta : startWidth - delta)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      document.body.classList.remove('is-resizing-pane')
      if (paneResizeCleanupRef.current === cleanup) paneResizeCleanupRef.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    paneResizeCleanupRef.current = cleanup
  }

  const resizePaneFromKey = (pane: PaneKind) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.shiftKey ? 48 : 16
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const currentWidth = pane === 'sidebar' ? sidebarWidth : inspectorWidth
    setPaneWidth(pane, currentWidth + (pane === 'sidebar' ? direction : -direction) * step)
  }

  const applySessionModels = (response: JsonRecord, preservePreference = false) => {
    const state = sessionModels(response)
    if (state.currentId && !(preservePreference && preferredModelRef.current)) {
      preferredModelRef.current = state.currentId
      setModel(state.currentId)
    }
    if (state.reasoningEffort) {
      preferredReasoningRef.current = state.reasoningEffort
      setReasoningEffort(state.reasoningEffort)
    }
    if (state.available.length) setAvailableModels(state.available)
    return state
  }

  useEffect(() => () => {
    speechRecognitionRef.current?.abort()
    speechRecognitionRef.current = null
  }, [])

  useEffect(() => () => {
    cancelPaneResize()
  }, [])

  const setSidebarVisibility = (opened: boolean) => {
    sidebarFocusRequestedRef.current = true
    setSidebarPeeked(false)
    setSidebarOpened(opened)
  }

  const cancelSidebarClose = () => {
    if (sidebarCloseTimerRef.current !== null) window.clearTimeout(sidebarCloseTimerRef.current)
    sidebarCloseTimerRef.current = null
  }

  const revealSidebarFromEdge = () => {
    cancelSidebarClose()
    if (!sidebarOpened) setSidebarPeeked(true)
  }

  const scheduleSidebarClose = () => {
    cancelSidebarClose()
    if (sidebarOpened) return
    sidebarCloseTimerRef.current = window.setTimeout(() => setSidebarPeeked(false), 220)
  }

  useEffect(() => () => {
    cancelSidebarClose()
  }, [])

  useEffect(() => {
    const trackEdgeHover = (event: MouseEvent) => {
      if (!sidebarOpened) {
        if (event.clientX <= 12) revealSidebarFromEdge()
        else if (sidebarPeeked && event.clientX > sidebarWidth + 44) scheduleSidebarClose()
        else if (sidebarPeeked) cancelSidebarClose()
      }
    }
    document.addEventListener('mousemove', trackEdgeHover)
    return () => document.removeEventListener('mousemove', trackEdgeHover)
  }, [sidebarOpened, sidebarPeeked, sidebarWidth])

  useEffect(() => {
    if (!sidebarFocusRequestedRef.current) return
    sidebarFocusRequestedRef.current = false
    window.requestAnimationFrame(() => sidebarCollapseRef.current?.focus())
  }, [sidebarOpened])

  useEffect(() => {
    if (!feedback || feedback.persistent) return
    const timeout = window.setTimeout(() => setFeedback((current) => current?.id === feedback.id ? null : current), 4200)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  useEffect(() => {
    if (!inspectorVisible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeInspector()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [inspectorVisible])

  useEffect(() => {
    if (!activeProjectId) {
      setProjectFiles([])
      setProjectFilesError('')
      return
    }
    let disposed = false
    setProjectFilesLoading(true)
    setProjectFilesError('')
    void fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/files`).then(async (response) => {
      const payload = await response.json() as { files?: ProjectFile[]; error?: string }
      if (!response.ok) throw new Error(payload.error || '项目文件读取失败')
      if (!disposed) setProjectFiles(Array.isArray(payload.files) ? payload.files : [])
    }).catch((error) => {
      if (!disposed) {
        setProjectFiles([])
        setProjectFilesError(error instanceof Error ? error.message : '项目文件读取失败')
      }
    }).finally(() => {
      if (!disposed) setProjectFilesLoading(false)
    })
    return () => { disposed = true }
  }, [activeProjectId, projectFilesNonce])

  useEffect(() => {
    setInspectorSelection((current) => current && ['file', 'source'].includes(current.kind) ? null : current)
  }, [activeProjectId])

  useEffect(() => {
    if (!activeProjectId) return
    setExpandedProjectIds((current) => current.includes(activeProjectId) ? current : [...current, activeProjectId])
  }, [activeProjectId])

  useEffect(() => {
    const preserveNotCreatedState = projectFilePreviewError?.state === 'not_created'
    setProjectFilePreview(null)
    if (!preserveNotCreatedState) setProjectFilePreviewError(null)
    setProjectFilePreviewLoading(false)
    const project = projects.find((entry) => entry.id === activeProjectId)
    if (!project || !inspectorSelection || !['source', 'file'].includes(inspectorSelection.kind)) {
      setProjectFilePreviewError(null)
      return
    }
    const source = inspectorSelection.kind === 'source'
      ? project.sources.find((entry) => entry.id === inspectorSelection.id)
      : null
    const file = inspectorSelection.kind === 'file'
      ? projectFiles.find((entry) => entry.path === inspectorSelection.id)
      : null
    const selectedPath = inspectorSelection.kind === 'file' ? inspectorSelection.id : undefined
    const relativePath = source?.relativePath ?? file?.path ?? selectedPath
    const kind = source?.kind ?? file?.kind ?? (relativePath ? projectFileKindFromPath(relativePath) : undefined)
    const name = source?.name ?? file?.name ?? relativePath?.split('/').pop()
    const mimeType = source?.mimeType ?? file?.mimeType ?? ''
    if (!relativePath || !name || (kind !== 'text' && kind !== 'image')) {
      setProjectFilePreviewError(null)
      return
    }
    const endpoint = `/api/projects/${encodeURIComponent(project.id)}/file?path=${encodeURIComponent(relativePath)}`
    if (kind === 'image') {
      setProjectFilePreview({ kind, name, path: relativePath, mimeType, url: endpoint })
      return
    }
    let disposed = false
    setProjectFilePreviewLoading(!preserveNotCreatedState)
    void fetch(endpoint).then(async (response) => {
      const body = await response.text()
      if (!response.ok) {
        let code = ''
        try { code = String((JSON.parse(body) as { code?: unknown }).code ?? '') } catch { /* use the safe generic state */ }
        if (!disposed) setProjectFilePreviewError(artifactPreviewFailure(response.status, code))
        return
      }
      if (!disposed) {
        setProjectFilePreviewError(null)
        setProjectFilePreview({ kind, name, path: relativePath, mimeType, text: body })
      }
    }).catch(() => {
      if (!disposed) setProjectFilePreviewError(artifactPreviewFailure(500))
    }).finally(() => {
      if (!disposed) setProjectFilePreviewLoading(false)
    })
    return () => { disposed = true }
  }, [activeProjectId, inspectorSelection, projectFilePreviewNonce, projectFiles, projects])

  useEffect(() => {
    if (projectFilePreviewError?.state !== 'not_created' || !isRunning || inspectorTab !== 'preview') return
    const timer = window.setTimeout(() => setProjectFilePreviewNonce((value) => value + 1), 1600)
    return () => window.clearTimeout(timer)
  }, [inspectorTab, isRunning, projectFilePreviewError])

  const scrollChatToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const viewport = chatViewportRef.current
    if (!viewport) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? 'auto' : behavior })
    setChatAtBottom(true)
  }

  useEffect(() => {
    if (!chatAtBottom) return
    const frame = window.requestAnimationFrame(() => scrollChatToBottom(messages.some((entry) => entry.streaming) ? 'auto' : 'smooth'))
    return () => window.cancelAnimationFrame(frame)
  // Follow new output only while the user remains near the latest message.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, tools.length, pendingPermission, pendingPlan, pendingQuestion])

  useEffect(() => {
    const requestedConversationId = latestTaskScrollTargetRef.current
    if (!shouldRevealLatestTaskContent({
      requestedConversationId,
      activeConversationId,
      restoringConversationId: restoringSession?.id ?? null,
    })) return
    const frame = window.requestAnimationFrame(() => {
      if (activeConversationIdRef.current !== requestedConversationId) return
      scrollChatToBottom('auto')
      latestTaskScrollTargetRef.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  // A task switch owns one immediate jump after its complete snapshot is rendered.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, messages, restoringSession, tools.length])

  useEffect(() => {
    if (!inspectorVisible || !sessionReady || !sessionIdRef.current) return
    let disposed = false
    const requestedSessionId = sessionIdRef.current
    setSessionInfoLoading(true)
    setSessionInfoError('')
    void request('_x.ai/session/info', { sessionId: requestedSessionId }, 20_000).then((response) => {
      if (disposed || activeConversationIdRef.current !== requestedSessionId || sessionIdRef.current !== requestedSessionId) return
      const payload = unwrapExtensionResult(response)
      const context = asRecord(payload.context)
      setSessionInfo({
        cwd: asText(payload.cwd),
        agentName: asText(payload.agentName ?? payload.agent_name) || 'RunBuild',
        modelName: asText(payload.modelDisplayName ?? payload.model_display_name ?? payload.model) || model,
        turns: Number(payload.turns ?? 0),
        contextUsed: Number(context.used ?? 0),
        contextTotal: Number(context.total ?? 0),
        contextPercent: Number(context.usagePct ?? context.usage_pct ?? 0),
        toolCalls: Number(context.toolCallCount ?? context.tool_call_count ?? 0),
        compactions: Number(context.compactionCount ?? context.compaction_count ?? 0),
      })
    }).catch((error) => {
      if (!disposed && activeConversationIdRef.current === requestedSessionId && sessionIdRef.current === requestedSessionId) {
        setSessionInfo(null)
        setSessionInfoError(error instanceof Error ? error.message : '会话信息读取失败')
      }
    }).finally(() => {
      if (!disposed && activeConversationIdRef.current === requestedSessionId && sessionIdRef.current === requestedSessionId) setSessionInfoLoading(false)
    })
    return () => { disposed = true }
  // Refresh the real session snapshot when the panel opens or the visible activity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorVisible, activeConversationId, messages.length, tools.length, sessionReady])

  const recordEvent = (text: string, icon: EventIcon = IconSparkles) => {
    const activity = { time: now(), text, icon }
    setEvents((current) => [activity, ...current].slice(0, 24))
    return activity
  }

  const enqueueTaskEvent = (event: TaskEventInput): Promise<TaskEventAppendResult> => {
    const append = () => appendTaskEvent((url, init) => fetch(url, init), event)
    const operation = taskEventQueueRef.current.then(append, append)
    taskEventQueueRef.current = operation.then(
      () => undefined,
      (error) => {
        const detail = error instanceof Error ? error.message : '未知错误'
        if (taskLedgerLastErrorRef.current !== detail) {
          taskLedgerLastErrorRef.current = detail
          recordEvent(`任务账本写入失败：${detail}`, IconAlertCircle)
        }
      },
    )
    return operation
  }

  const memoryContextForPrompt = async (input: { taskId: string; projectId: string | null; prompt: string }): Promise<PromptMemoryContext> => {
    // Older web-only bridge deployments do not expose P2.  Its absence must
    // never make a live ACP task fail or cause a retry with different input.
    if (!bridgeConfig?.providerRegistry) return { text: '', receipt: null }
    try {
      const response = await fetch('/api/memories/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: input.projectId,
          query: input.prompt || '当前任务附件与项目上下文',
          currentSessionSummary: `当前任务 ${input.taskId} 已显示 ${messages.length} 条会话消息。当前用户请求：${input.prompt.slice(0, 900)}`,
          maxChars: 8_000,
        }),
      })
      const payload = await response.json().catch(() => ({})) as {
        adapter?: string
        context?: {
          text?: string
          maxChars?: number
          usedChars?: number
          redacted?: boolean
          includedMemoryIds?: unknown
          omittedMemoryIds?: unknown
          sections?: unknown
        }
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || '记忆上下文读取失败')
      const rawContext = payload.context
      if (!rawContext) return { text: '', receipt: null }
      const context = typeof rawContext.text === 'string' ? rawContext.text.trim() : ''
      const memoryIds = (value: unknown) => Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && /^mem_[a-f0-9]{64}$/.test(entry)).slice(0, 128)
        : []
      const nonnegativeInteger = (value: unknown) => (
        typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, value) : null
      )
      const sections = Array.isArray(rawContext.sections)
        ? rawContext.sections.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
          const value = entry as { kind?: unknown; included?: unknown; omitted?: unknown }
          const included = nonnegativeInteger(value.included)
          const omitted = nonnegativeInteger(value.omitted)
          if (typeof value.kind !== 'string' || included === null || omitted === null) return []
          return [{ kind: value.kind.slice(0, 64), included, omitted }]
        }).slice(0, 8)
        : []
      const receipt: MemoryContextReceipt = {
        adapter: typeof payload.adapter === 'string' ? payload.adapter.slice(0, 128) : 'unknown',
        maxChars: nonnegativeInteger(rawContext.maxChars) ?? 0,
        usedChars: nonnegativeInteger(rawContext.usedChars) ?? 0,
        redacted: rawContext.redacted === true,
        includedMemoryIds: memoryIds(rawContext.includedMemoryIds),
        omittedMemoryIds: memoryIds(rawContext.omittedMemoryIds),
        sections,
      }
      if (!context) return { text: '', receipt }
      return {
        text: [
        PERSISTENT_MEMORY_CONTEXT_PREAMBLE,
        context,
        ].join('\n\n'),
        receipt,
      }
    } catch (error) {
      recordEvent(`记忆上下文暂不可用，本轮按原上下文执行：${error instanceof Error ? error.message : '读取失败'}`, IconAlertCircle)
      return { text: '', receipt: null }
    }
  }

  const memoryContextEventPayload = (receipt: MemoryContextReceipt, injected: boolean) => ({
    adapter: receipt.adapter,
    injected,
    maxChars: receipt.maxChars,
    usedChars: receipt.usedChars,
    redacted: receipt.redacted,
    includedMemoryIds: receipt.includedMemoryIds,
    omittedMemoryIds: receipt.omittedMemoryIds,
    sections: receipt.sections,
  })

  const createGoalExecutionForPrompt = async (input: { taskId: string; projectId: string | null; sourceRunId: string; goal: string }) => {
    if (!bridgeConfig?.providerRegistry) return null
    try {
      const response = await fetch('/api/goal-executions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: input.taskId,
          projectId: input.projectId,
          sourceRunId: input.sourceRunId,
          authorizationMode: permissionPreference,
          operationId: `goal:${input.sourceRunId}`,
          goal: input.goal || '处理当前附件并给出可验证结果',
        }),
      })
      const payload = await response.json().catch(() => ({})) as { goal?: GoalExecutionProjection; error?: string }
      if (!response.ok || !payload.goal) throw new Error(payload.error || '创建验证执行计划失败')
      goalRunBySourceRunRef.current.set(input.sourceRunId, {
        goalRunId: payload.goal.runId,
        taskId: input.taskId,
        projectId: input.projectId,
        authorizationMode: permissionPreference,
      })
      setGoalExecution(payload.goal)
      return payload.goal
    } catch (error) {
      recordEvent(`本轮未建立 P2 验证计划：${error instanceof Error ? error.message : '创建失败'}`, IconAlertCircle)
      return null
    }
  }

  const settleGoalExecutionFromLedger = async (sourceRunId: string | null) => {
    if (!sourceRunId) return
    const binding = goalRunBySourceRunRef.current.get(sourceRunId)
    if (!binding) return
    try {
      const response = await fetch(`/api/goal-executions/${encodeURIComponent(binding.goalRunId)}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: binding.taskId,
          projectId: binding.projectId,
          authorizationMode: binding.authorizationMode,
          sourceRunId,
          operationId: `goal-settle:${sourceRunId}`,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { goal?: GoalExecutionProjection; error?: string }
      if (!response.ok || !payload.goal) throw new Error(payload.error || '同步验证结果失败')
      setGoalExecution(payload.goal)
      if (payload.goal.completionAccepted) recordEvent('P2 已从任务账本确认独立验证收据。', IconCircleCheck)
      else if (['blocked', 'failed', 'cancelled'].includes(payload.goal.state)) recordEvent('P2 未接受本轮为已验证完成；请查看任务账本与验证证据。', IconAlertCircle)
    } catch (error) {
      recordEvent(`P2 验证状态待恢复：${error instanceof Error ? error.message : '同步失败'}`, IconAlertCircle)
    }
  }

  const selectedTaskId = () => sessionIdRef.current ?? activeConversationIdRef.current

  const runtimeForTask = (taskId: string): TaskRuntime => {
    const existing = taskRuntimesRef.current.get(taskId)
    if (existing) return existing
    const next: TaskRuntime = {
      reliability: createSessionReliabilityState(),
      submitting: false,
      activeRunId: null,
      activeAgentMessageId: null,
      turnStartedAt: null,
      cancelRequestedRunId: null,
      promptDeadlineTimer: null,
      questionAnswers: {},
    }
    taskRuntimesRef.current.set(taskId, next)
    return next
  }

  const syncSelectedTaskRuntime = (taskId: string | null = selectedTaskId()) => {
    if (!taskId) {
      setIsRunning(false)
      return
    }
    const runtime = runtimeForTask(taskId)
    sessionReliabilityRef.current = runtime.reliability
    setSessionReliability(runtime.reliability)
    submittingRef.current = runtime.submitting
    activeRunIdRef.current = runtime.activeRunId
    activeAgentMessageRef.current = runtime.activeAgentMessageId
    turnStartedAtRef.current = runtime.turnStartedAt
    cancelRequestedRunRef.current = runtime.cancelRequestedRunId
    promptDeadlineTimerRef.current = runtime.promptDeadlineTimer
    setIsRunning(runtime.submitting || isActiveTask(runtime.reliability.task))
  }

  const restoreTaskInteractions = (taskId: string) => {
    const permission = pendingPermissionByTaskRef.current.get(taskId) ?? null
    const question = pendingQuestionByTaskRef.current.get(taskId) ?? null
    const plan = pendingPlanByTaskRef.current.get(taskId) ?? null
    const answers = runtimeForTask(taskId).questionAnswers
    setPendingPermission(permission)
    pendingQuestionRef.current = question
    questionAnswersRef.current = answers
    setPendingQuestion(question)
    setQuestionAnswers(answers)
    setPendingPlan(plan)
  }

  const activateTaskRuntime = (taskId: string) => {
    runtimeForTask(taskId)
    syncSelectedTaskRuntime(taskId)
    restoreTaskInteractions(taskId)
  }

  const deactivateTaskRuntime = () => {
    const idle = createSessionReliabilityState()
    sessionReliabilityRef.current = idle
    setSessionReliability(idle)
    submittingRef.current = false
    activeRunIdRef.current = null
    activeAgentMessageRef.current = null
    turnStartedAtRef.current = null
    cancelRequestedRunRef.current = null
    promptDeadlineTimerRef.current = null
    setIsRunning(false)
  }

  const publishTaskRuntime = (taskId: string) => {
    if (selectedTaskId() === taskId) syncSelectedTaskRuntime(taskId)
    setTaskRuntimeVersion((version) => version + 1)
  }

  const updateTaskReliability = (taskId: string, next: SessionReliabilityState) => {
    runtimeForTask(taskId).reliability = next
    publishTaskRuntime(taskId)
    return next
  }

  const updateSessionReliability = (next: SessionReliabilityState) => {
    const taskId = selectedTaskId()
    if (taskId) return updateTaskReliability(taskId, next)
    sessionReliabilityRef.current = next
    setSessionReliability(next)
    return next
  }

  const clearTaskPromptDeadline = (taskId: string) => {
    const runtime = runtimeForTask(taskId)
    if (runtime.promptDeadlineTimer !== null) window.clearTimeout(runtime.promptDeadlineTimer)
    runtime.promptDeadlineTimer = null
    if (selectedTaskId() === taskId) promptDeadlineTimerRef.current = null
  }

  const clearPromptDeadline = () => {
    const taskId = selectedTaskId()
    if (taskId) clearTaskPromptDeadline(taskId)
    else if (promptDeadlineTimerRef.current !== null) {
      window.clearTimeout(promptDeadlineTimerRef.current)
      promptDeadlineTimerRef.current = null
    }
  }

  const updateTaskMessages = (taskId: string, update: (messages: ChatMessage[]) => ChatMessage[]) => {
    setConversations((current) => {
      const next = current.map((session) => session.id === taskId
        ? { ...session, messages: update(session.messages) }
        : session)
      conversationsRef.current = next
      return next
    })
    if (selectedTaskId() === taskId) setMessages((current) => update(current))
  }

  const updateTaskTools = (taskId: string, update: (tools: ToolState[]) => ToolState[]) => {
    setConversations((current) => {
      const next = current.map((session) => session.id === taskId
        ? { ...session, tools: update(session.tools) }
        : session)
      conversationsRef.current = next
      return next
    })
    if (selectedTaskId() === taskId) setTools((current) => update(current))
  }

  const finishAgentMessage = (completedAt?: number, targetTaskId = selectedTaskId()) => {
    if (!targetTaskId) return
    const runtime = runtimeForTask(targetTaskId)
    updateTaskMessages(targetTaskId, (current) => current.map((entry) => {
      if (!entry.streaming) return entry
      const durationMs = completedAt && entry.startedAt ? Math.max(0, completedAt - entry.startedAt) : entry.durationMs
      return { ...entry, streaming: false, completedAt: completedAt ?? entry.completedAt, durationMs }
    }))
    runtime.activeAgentMessageId = null
    publishTaskRuntime(targetTaskId)
  }

  const finishCurrentRunUi = (completedAt = Date.now()) => {
    const taskId = selectedTaskId()
    clearPromptDeadline()
    finishAgentMessage(completedAt)
    turnStartedAtRef.current = null
    activeRunIdRef.current = null
    cancelRequestedRunRef.current = null
    submittingRef.current = false
    if (taskId) {
      const runtime = runtimeForTask(taskId)
      runtime.turnStartedAt = null
      runtime.activeRunId = null
      runtime.cancelRequestedRunId = null
      runtime.submitting = false
      runtime.activeAgentMessageId = null
      pendingPermissionByTaskRef.current.delete(taskId)
      pendingQuestionByTaskRef.current.delete(taskId)
      pendingPlanByTaskRef.current.delete(taskId)
      runtime.questionAnswers = {}
      publishTaskRuntime(taskId)
    } else setIsRunning(false)
    setPendingPermission(null)
    pendingQuestionRef.current = null
    questionAnswersRef.current = {}
    setPendingQuestion(null)
    setQuestionAnswers({})
    setPendingPlan(null)
  }

  const settleLocalTaskEnd = async (input: {
    taskId: string
    projectId: string | null
    runId: string
    outcome: 'failed' | 'cancelled'
    reason: string
  }) => {
    const eventType = input.outcome === 'cancelled' ? 'run.cancelled' : 'run.failed'
    await enqueueTaskEvent({
      type: eventType,
      taskId: input.taskId,
      projectId: input.projectId,
      runId: input.runId,
      source: 'ui',
      idempotencyKey: `run:${input.taskId}:${input.runId}:${input.reason}`,
      payload: { reason: input.reason },
    })
    await enqueueTaskEvent({
      type: 'state.changed',
      taskId: input.taskId,
      projectId: input.projectId,
      runId: input.runId,
      source: 'system',
      idempotencyKey: `state:${input.taskId}:${input.runId}:${input.reason}`,
      payload: { state: input.outcome, reason: input.reason },
    })
    await settleGoalExecutionFromLedger(input.runId)
  }

  const taskWorkspaceScope = (projectId: string | null) => `projectId=${encodeURIComponent(projectId ?? 'root')}`

  const saveTaskDraft = async (taskId: string, projectId: string | null, text: string, draftAttachments: readonly Attachment[]) => {
    const response = await fetch(`/api/task-workspaces/${encodeURIComponent(taskId)}/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, text, attachmentIds: draftAttachments.map((attachment) => attachment.id) }),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(payload.error || `草稿保存失败 (${response.status})`)
    }
  }

  const persistTaskAttachment = async (taskId: string, projectId: string | null, attachment: Attachment) => {
    const response = await fetch(
      `/api/task-workspaces/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}?${taskWorkspaceScope(projectId)}&name=${encodeURIComponent(attachment.name)}&kind=${encodeURIComponent(attachment.kind)}`,
      {
        method: 'PUT',
        headers: { 'content-type': attachment.mimeType },
        body: bytesFromAttachment(attachment),
      },
    )
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(payload.error || `附件保存失败 (${response.status})`)
    }
  }

  const restoreTaskWorkspace = async (taskId: string, projectId: string | null) => {
    const restoreToken = taskWorkspaceLoadRef.current + 1
    taskWorkspaceLoadRef.current = restoreToken
    const response = await fetch(`/api/task-workspaces/${encodeURIComponent(taskId)}?${taskWorkspaceScope(projectId)}`, { cache: 'no-store' })
    if (response.status === 404 || taskWorkspaceLoadRef.current !== restoreToken) return
    const payload = await response.json().catch(() => ({})) as { task?: TaskWorkspaceSnapshot; error?: string }
    if (!response.ok || !payload.task) throw new Error(payload.error || `任务工作区读取失败 (${response.status})`)
    const selectedIds = new Set(Array.isArray(payload.task.draft.attachmentIds) ? payload.task.draft.attachmentIds : [])
    const descriptors = payload.task.attachments.filter((attachment) => selectedIds.has(attachment.id))
    const restoredAttachments = await Promise.all(descriptors.map(async (descriptor): Promise<Attachment | null> => {
      const attachmentResponse = await fetch(
        `/api/task-workspaces/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(descriptor.id)}?${taskWorkspaceScope(projectId)}`,
        { cache: 'no-store' },
      )
      if (!attachmentResponse.ok) return null
      if (descriptor.kind === 'text') {
        return { ...descriptor, data: await attachmentResponse.text() }
      }
      const data = base64FromBytes(new Uint8Array(await attachmentResponse.arrayBuffer()))
      return {
        ...descriptor,
        data,
        ...(descriptor.kind === 'image' ? { preview: `data:${descriptor.mimeType};base64,${data}` } : {}),
      }
    }))
    if (taskWorkspaceLoadRef.current !== restoreToken) return
    setComposer(payload.task.draft.text)
    setAttachments(restoredAttachments.filter((attachment): attachment is Attachment => attachment !== null))
    if (payload.task.draft.text || descriptors.length) recordEvent('已恢复本任务未发送的草稿和附件。', IconRefresh)
  }

  const changeTaskWorkspaceLifecycle = async (taskId: string, projectId: string | null, action: 'archive' | 'restore' | 'mark-running' | 'mark-idle' | 'mark-cancelling') => {
    const response = await fetch(`/api/task-workspaces/${encodeURIComponent(taskId)}/lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, action }),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(payload.error || `任务生命周期更新失败 (${response.status})`)
    }
  }

  useEffect(() => {
    if (!activeConversationId || restoringSession) return
    const taskId = activeConversationId
    const projectId = projectIdForTask(taskId, activeProjectId)
    const draftAttachments = attachments
    const timeoutId = window.setTimeout(() => {
      void saveTaskDraft(taskId, projectId, composer, draftAttachments).then(() => {
        taskWorkspaceLastErrorRef.current = ''
      }).catch((error) => {
        const detail = error instanceof Error ? error.message : '未知错误'
        if (taskWorkspaceLastErrorRef.current === detail) return
        taskWorkspaceLastErrorRef.current = detail
        recordEvent(`任务草稿未能保存：${detail}`, IconAlertCircle)
      })
    }, 320)
    return () => window.clearTimeout(timeoutId)
  }, [activeConversationId, activeProjectId, attachments, composer, restoringSession])

  const projectIdForTask = (taskId: string, fallback: string | null) => (
    conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId ?? fallback
  )

  const storeToolReceipt = (runId: string, event: TaskEventInput, receipt: TaskEventAppendResult) => {
    if (event.type !== 'tool.requested' && event.type !== 'tool.updated') return
    const toolCallId = asText(event.payload.toolCallId)
    if (!toolCallId) return
    const receipts = toolReceiptsByRunRef.current.get(runId) ?? new Map<string, AcpToolUpdateEvidence>()
    const previous = receipts.get(toolCallId)
    const rawInput = asRecord(event.payload.rawInput)
    const rawOutput = asRecord(event.payload.rawOutput)
    const hasRawInput = Object.keys(rawInput).length > 0
    const hasRawOutput = Object.keys(rawOutput).length > 0
    receipts.set(toolCallId, {
      toolCallId,
      title: asText(event.payload.title) || previous?.title,
      status: asText(event.payload.status) || previous?.status,
      rawInput: hasRawInput ? rawInput : previous?.rawInput,
      rawOutput: hasRawOutput ? rawOutput : previous?.rawOutput,
      eventId: hasRawOutput ? receipt.event.eventId : previous?.eventId,
      sequence: hasRawOutput ? receipt.event.sequence : previous?.sequence,
    })
    toolReceiptsByRunRef.current.set(runId, receipts)
  }

  const persistAcpUpdate = (input: {
    taskId: string
    projectId: string | null
    runId: string | null
    eventMeta: JsonRecord
    rawUpdate: JsonRecord
  }) => {
    const event = acpTaskEvent({ ...input, update: input.rawUpdate })
    if (!event) return Promise.resolve(null)
    return enqueueTaskEvent(event).then((receipt) => {
      if (input.runId) storeToolReceipt(input.runId, event, receipt)
      return { event, receipt }
    })
  }

  const settleTerminalLedgerEvent = async (input: {
    taskId: string
    projectId: string | null
    runId: string | null
    sourceEventId: string
    isReplay: boolean
    terminal: { event: TaskEventInput; receipt: TaskEventAppendResult }
  }) => {
    const terminalEventId = input.terminal.receipt.event.eventId
    if (terminalEventsProcessingRef.current.has(terminalEventId)) return
    terminalEventsProcessingRef.current.add(terminalEventId)
    const runScope = input.runId ?? 'unattributed'
    const terminalKey = `${input.taskId}:${runScope}:${terminalEventId}`
    let terminalSettled = false
    try {
      await enqueueTaskEvent({
        type: 'message.agent.completed',
        taskId: input.taskId,
        projectId: input.projectId,
        runId: input.runId,
        source: 'system',
        idempotencyKey: `message:${terminalKey}:completed`,
        timestamp: input.terminal.receipt.event.timestamp,
        payload: { terminalEventId, terminalType: input.terminal.event.type },
      })

      // ACP replay reconstructs the visible conversation; it must not turn a
      // partial replay into a new completion verdict. The original durable
      // verdict, if any, remains keyed to the terminal source event.
      if (input.isReplay) {
        terminalSettled = true
        return
      }

      if (input.terminal.event.type === 'run.completed') {
        const receipts = input.runId
          ? [...(toolReceiptsByRunRef.current.get(input.runId)?.values() ?? [])]
          : []
        const verification = input.runId && input.sourceEventId
          ? createToolReceiptVerifier({
              scopeId: terminalKey,
              checkedAt: input.terminal.receipt.event.timestamp,
              toolUpdates: receipts,
            })
          : null
        if (verification) {
          await enqueueTaskEvent({
            type: 'verification.recorded',
            taskId: input.taskId,
            projectId: input.projectId,
            runId: input.runId,
            source: 'verifier',
            idempotencyKey: `verification:${terminalKey}`,
            timestamp: input.terminal.receipt.event.timestamp,
            payload: {
              status: verification.report.status,
              verifierId: verification.verifier.id,
              evidenceIds: [...verification.verifier.evidenceIds],
              cleanupStatus: verification.cleanup.status,
              cleanupSummary: verification.cleanup.summary,
              changedFileCount: verification.report.changedFiles.files.length,
              commandCount: verification.report.commands.length,
            },
          })
          await enqueueTaskEvent({
            type: 'state.changed',
            taskId: input.taskId,
            projectId: input.projectId,
            runId: input.runId,
            source: 'verifier',
            idempotencyKey: `state:${terminalKey}:verified`,
            timestamp: input.terminal.receipt.event.timestamp,
            payload: { state: 'verified', terminalEventId, verifierId: verification.verifier.id },
          })
          recordEvent('本轮编码操作已通过工具收据核验。', IconCircleCheck)
          await settleGoalExecutionFromLedger(input.runId)
          terminalSettled = true
          return
        }

        const hasToolReceipts = receipts.length > 0
        const requiresUiReadback = receipts.some((receipt) => {
          const output = asRecord(receipt.rawOutput)
          const command = asText(output.command ?? asRecord(receipt.rawInput).command)
          return commandRequiresUiReadback(command)
        })
        if (hasToolReceipts && requiresUiReadback && input.runId) {
          pendingUiVerificationByTaskRef.current.set(input.taskId, {
            taskId: input.taskId,
            projectId: input.projectId,
            runId: input.runId,
            terminalKey,
            terminalEventId,
            receipts,
          })
          await enqueueTaskEvent({
            type: 'state.changed',
            taskId: input.taskId,
            projectId: input.projectId,
            runId: input.runId,
            source: 'system',
            idempotencyKey: `state:${terminalKey}:awaiting-visual-confirmation`,
            timestamp: input.terminal.receipt.event.timestamp,
            payload: { state: 'awaiting_visual_confirmation', terminalEventId, reason: 'native-ui-readback-required' },
          })
          recordEvent('原生应用已被请求启动；看到实际画面后再确认本轮结果。', IconScreenShare)
          terminalSettled = true
          return
        }
        await enqueueTaskEvent({
          type: 'state.changed',
          taskId: input.taskId,
          projectId: input.projectId,
          runId: input.runId,
          source: 'system',
          idempotencyKey: `state:${terminalKey}:${hasToolReceipts ? 'incomplete' : 'response-complete'}`,
          timestamp: input.terminal.receipt.event.timestamp,
          payload: hasToolReceipts
            ? { state: 'incomplete', terminalEventId, reason: input.sourceEventId ? 'tool-evidence-incomplete' : 'terminal-source-event-missing' }
            : { state: 'response_complete', terminalEventId, reason: 'no-tool-execution' },
        })
        if (hasToolReceipts) recordEvent('Agent 已返回终态，但编码结果缺少完整工具收据，未标记为已验证。', IconAlertCircle)
        await settleGoalExecutionFromLedger(input.runId)
        terminalSettled = true
        return
      }

      const state = input.terminal.event.type === 'run.cancelled' ? 'cancelled' : 'failed'
      await enqueueTaskEvent({
        type: 'state.changed',
        taskId: input.taskId,
        projectId: input.projectId,
        runId: input.runId,
        source: 'system',
        idempotencyKey: `state:${terminalKey}:${state}`,
        timestamp: input.terminal.receipt.event.timestamp,
        payload: { state, terminalEventId },
      })
      await settleGoalExecutionFromLedger(input.runId)
      terminalSettled = true
    } catch (error) {
      // A temporary local-ledger failure must not turn a replayed ACP terminal
      // event into a permanent skipped completion decision.
      terminalEventsProcessingRef.current.delete(terminalEventId)
      throw error
    } finally {
      if (terminalSettled && input.runId) {
        const pendingUiVerification = pendingUiVerificationByTaskRef.current.get(input.taskId)
        if (pendingUiVerification?.runId !== input.runId) toolReceiptsByRunRef.current.delete(input.runId)
        const runtime = runtimeForTask(input.taskId)
        if (runtime.activeRunId === input.runId) runtime.activeRunId = null
        if (runtime.cancelRequestedRunId === input.runId) runtime.cancelRequestedRunId = null
        publishTaskRuntime(input.taskId)
      }
    }
  }

  const restoreTaskLedgerProjection = async (taskId: string) => {
    try {
      const response = await fetch(`/api/task-events?taskId=${encodeURIComponent(taskId)}&limit=1000`, { cache: 'no-store' })
      if (!response.ok) return
      const payload = await response.json() as { events?: TaskEvent[] }
      if (activeConversationIdRef.current !== taskId) return
      const events = Array.isArray(payload.events) ? payload.events : []
      setLedgerActivity(projectTaskActivity(events))
      const latestGoalCheckpoint = [...events].reverse().find((event) => {
        const payload = asRecord(event.payload)
        return event.type === 'checkpoint.created' && asText(payload.checkpoint) === 'p2-goal-execution'
      })
      const goalPayload = asRecord(latestGoalCheckpoint?.payload)
      const goalRunId = asText(goalPayload.goalRunId)
      const authorizationMode = asText(goalPayload.authorizationMode)
      if (goalRunId && (authorizationMode === 'manual-current' || authorizationMode === 'approve-running')) {
        const projectId = latestGoalCheckpoint?.projectId ?? null
        const sourceRunId = latestGoalCheckpoint?.runId ?? null
        void fetch(`/api/goal-executions/${encodeURIComponent(goalRunId)}?taskId=${encodeURIComponent(taskId)}&projectId=${encodeURIComponent(projectId ?? 'root')}&authorizationMode=${encodeURIComponent(authorizationMode)}`, { cache: 'no-store' })
          .then(async (goalResponse) => {
            const goal = await goalResponse.json().catch(() => ({})) as { goal?: GoalExecutionProjection }
            if (!goalResponse.ok || !goal.goal || activeConversationIdRef.current !== taskId) return
            setGoalExecution(goal.goal)
            if (sourceRunId) goalRunBySourceRunRef.current.set(sourceRunId, { goalRunId, taskId, projectId, authorizationMode })
          })
          .catch(() => undefined)
      } else {
        setGoalExecution(null)
      }
      const latestState = [...events].reverse().find((event) => event.type === 'state.changed')
      const state = asText(asRecord(latestState?.payload).state)
      if (state === 'verified') {
        recordEvent('已从任务账本恢复最近一次已验证的编码结果。', IconCircleCheck)
        return
      }
      if (state === 'incomplete') {
        recordEvent('已从任务账本恢复：最近编码结果尚未通过完整收据核验。', IconAlertCircle)
        return
      }
      if (state === 'failed' || state === 'cancelled') recordEvent(`已从任务账本恢复：最近一次运行${state === 'failed' ? '失败' : '已取消'}。`, IconAlertCircle)
    } catch {
      // ACP replay remains usable when an older web server does not yet expose
      // the ledger endpoint; do not replace the conversation with a read error.
    }
  }

  useEffect(() => {
    if (!activeConversationId) return
    void restoreTaskLedgerProjection(activeConversationId)
  // The active task is the ownership boundary; stale async responses are ignored above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

  const addEvent = (text: string, icon: EventIcon = IconSparkles) => {
    const activity = recordEvent(text, icon)
    if (icon !== IconX && icon !== IconAlertCircle) return
    setFeedback({
      ...activity,
      id: messageId(),
      tone: 'error',
    })
  }

  const showBridgeOfflineFeedback = () => {
    const activity = recordEvent(`未检测到 Agent Bridge；请在项目根目录运行 ${bridgeStartCommand}。`, IconAlertCircle)
    setBridgeCommandCopyState('idle')
    setFeedback({
      ...activity,
      id: messageId(),
      tone: 'error',
      kind: 'bridge-offline',
      persistent: true,
    })
  }

  const showXaiAuthFeedback = (detail = '请通过浏览器登录，或切换到有 Grok 模型权限的 xAI 账号。') => {
    const activity = recordEvent(detail, IconAlertCircle)
    setFeedback({
      ...activity,
      id: messageId(),
      tone: 'error',
      kind: 'xai-auth',
      persistent: true,
    })
  }

  const authenticateXai = async () => {
    const api = window.grokDesktop
    if (!api) {
      addEvent('当前页面不支持桌面 xAI 登录。', IconAlertCircle)
      return
    }
    setXaiAuthBusy(true)
    const activity = recordEvent('已打开浏览器，正在等待 xAI 登录确认。', IconLoader2)
    setFeedback({ ...activity, id: messageId(), tone: 'default', kind: 'xai-auth', persistent: true })
    try {
      const result = await api.loginXai()
      setBridgeConfig((current) => current ? {
        ...current,
        enabled: result.runtimeState === 'listening',
        runtimeState: result.runtimeState,
        runtimeError: result.runtimeError,
        modelAvailability: result.modelAvailability,
      } : current)
      const detail = result.runtimeState === 'listening'
        ? 'xAI 认证已保存，Agent 已重新连接。'
        : `xAI 认证已保存，但 Agent 重启失败${result.runtimeError ? `：${result.runtimeError}` : '。'}`
      const success = recordEvent(detail, result.runtimeState === 'listening' ? IconCircleCheck : IconAlertCircle)
      setFeedback({
        ...success,
        id: messageId(),
        tone: result.runtimeState === 'listening' ? 'success' : 'error',
        persistent: result.runtimeState !== 'listening',
      })
      setConnectionNonce((value) => value + 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'xAI 登录未完成，请重试'
      if (/登录已取消/.test(message)) {
        const cancelled = recordEvent('已取消 xAI 登录，原认证保持不变。', IconAlertCircle)
        setFeedback({ ...cancelled, id: messageId(), tone: 'default' })
      } else {
        showXaiAuthFeedback(/登录未完成/.test(message) ? 'xAI 登录未完成，原认证保持不变；可以重试。' : message)
      }
    } finally {
      setXaiAuthBusy(false)
    }
  }

  const cancelXaiLogin = async () => {
    try { await window.grokDesktop?.cancelXaiLogin() }
    catch (error) { addEvent(error instanceof Error ? error.message : '取消登录失败', IconX) }
  }

  const refreshProjectLifecycle = async () => {
    const response = await fetch('/api/task-workspaces/projects', { cache: 'no-store' })
    const payload = await response.json().catch(() => ({})) as { projects?: TaskProjectLifecycle[]; error?: string }
    if (!response.ok) throw new Error(payload.error || `项目生命周期读取失败 (${response.status})`)
    setProjectLifecycle(Array.isArray(payload.projects) ? payload.projects : [])
  }

  const restoreDurableArchivedTasks = async () => {
    const response = await fetch('/api/task-workspaces?includeArchived=true', { cache: 'no-store' })
    const payload = await response.json().catch(() => ({})) as { tasks?: TaskWorkspaceSnapshot[]; error?: string }
    if (!response.ok) throw new Error(payload.error || `归档任务读取失败 (${response.status})`)
    const archived = (Array.isArray(payload.tasks) ? payload.tasks : [])
      .filter((task) => task.lifecycle.state === 'archived')
      .map((task) => task.taskId)
    // A pre-P1 sidebar could record an archive only in the UI preferences.
    // Do not keep those stale IDs hidden once a durable task lifecycle exists.
    setArchivedConversationIds((current) => reconcileArchivedConversationIds(current, archived))
  }

  const refreshDiagnostics = async () => {
    const api = window.grokDesktop
    if (!api) throw new Error('当前页面不支持桌面诊断。')
    setDiagnosticsLoading(true)
    setDiagnosticsError('')
    try {
      const [snapshot] = await Promise.all([
        api.getDiagnosticsSnapshot(),
        refreshProjectLifecycle().catch(() => undefined),
      ])
      setDiagnosticsSnapshot(snapshot)
      setDiagnosticsLog(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地诊断读取失败'
      setDiagnosticsError(message)
      throw error
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  const openDiagnostics = () => {
    if (!window.grokDesktop) {
      addEvent('当前页面不支持桌面诊断。', IconAlertCircle)
      return
    }
    setDiagnosticsOpened(true)
    void refreshDiagnostics().catch(() => undefined)
  }

  const loadDiagnosticsLog = async () => {
    const api = window.grokDesktop
    if (!api) return
    setDiagnosticsBusy(true)
    setDiagnosticsError('')
    try {
      setDiagnosticsLog(await api.getDiagnosticsLogTail('desktop-agent'))
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : '本地日志读取失败')
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const requestDiagnosticPermission = async (permission: DesktopDiagnosticPermissionId) => {
    const api = window.grokDesktop
    if (!api) return
    setDiagnosticsBusy(true)
    setDiagnosticsError('')
    try {
      const result = await api.requestDiagnosticsPermission(permission)
      setDiagnosticsSnapshot((current) => current ? { ...current, permissions: result.permissions } : current)
      const detail = result.outcome === 'already-granted'
        ? '该系统权限已授予。'
        : result.outcome === 'requested'
          ? '已按你的操作请求系统权限。'
          : result.outcome === 'system-settings-required'
            ? '此权限需要在系统设置中手动开启。'
            : '当前平台不需要该权限。'
      recordEvent(detail, result.outcome === 'already-granted' || result.outcome === 'requested' ? IconCheck : IconAlertCircle)
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : '系统权限请求失败')
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const restartLocalAgent = async (source: 'diagnostics' | 'mcps' = 'diagnostics') => {
    const api = window.grokDesktop
    if (!api) {
      const message = '当前页面不能重载桌面 Agent；请在 RunBuild 桌面客户端中使用 /mcps。'
      if (source === 'mcps') appendSystemMessage(message, 'error')
      else addEvent(message, IconAlertCircle)
      return
    }
    if (diagnosticsBusy) {
      if (source === 'mcps') appendSystemMessage('本地诊断正在处理其他操作，请完成后再使用 /mcps。', 'error')
      return
    }
    setDiagnosticsBusy(true)
    setDiagnosticsError('')
    agentRestartingRef.current = true
    if (source === 'mcps') appendSystemMessage('正在安全重启本地 Agent，并重新加载 MCP 配置…')
    try {
      const result = await api.restartAgent()
      setDiagnosticsSnapshot(result.snapshot)
      if (result.status === 'restarted') {
        const activity = recordEvent(source === 'mcps' ? 'MCP 配置已重新加载，正在恢复会话历史。' : '本地 Agent 已安全重启，正在恢复会话历史。', IconRefresh)
        if (source === 'mcps') {
          appendSystemMessage('本地 Agent 已重启，MCP 配置已重新加载；只恢复会话历史，不会继续已中断的任务。')
          setFeedback({ ...activity, id: messageId(), tone: 'success' })
        }
        setConnectionNonce((value) => value + 1)
      } else {
        const message = result.error || `本地 Agent 未能完成重启（${result.status}）。`
        setDiagnosticsError(message)
        if (source === 'mcps') {
          appendSystemMessage(`MCP 重新加载失败：${message}`, 'error')
          setFeedback({ time: now(), text: `MCP 重新加载失败：${message}`, icon: IconAlertCircle, id: messageId(), tone: 'error' })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地 Agent 重启失败'
      setDiagnosticsError(message)
      if (source === 'mcps') {
        appendSystemMessage(`MCP 重新加载失败：${message}`, 'error')
        setFeedback({ time: now(), text: `MCP 重新加载失败：${message}`, icon: IconAlertCircle, id: messageId(), tone: 'error' })
      }
    } finally {
      agentRestartingRef.current = false
      setDiagnosticsBusy(false)
    }
  }

  const changeProjectLifecycle = async (projectId: string, action: 'archive' | 'restore' | 'detach') => {
    try {
      const response = await fetch(`/api/task-workspaces/projects/${encodeURIComponent(projectId)}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const payload = await response.json().catch(() => ({})) as { project?: TaskProjectLifecycle; error?: string }
      if (!response.ok || !payload.project) throw new Error(payload.error || `项目生命周期更新失败 (${response.status})`)
      setProjectLifecycle((current) => [...current.filter((item) => item.projectId !== projectId), payload.project!])
      recordEvent(action === 'restore' ? '项目已恢复到本地工作台。' : action === 'archive' ? '项目已归档；真实目录未删除。' : '项目已从工作台脱离；真实目录未删除。', action === 'restore' ? IconCheck : IconArchive)
    } catch (error) {
      addEvent(error instanceof Error ? error.message : '项目生命周期更新失败', IconAlertCircle)
    }
  }

  const copyBridgeStartCommand = async () => {
    try {
      await navigator.clipboard.writeText(bridgeStartCommand)
      setBridgeCommandCopyState('copied')
    } catch {
      setBridgeCommandCopyState('failed')
    }
  }

  const sendRaw = (payload: JsonRecord) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Bridge 未连接')
    socket.send(JSON.stringify({ jsonrpc: '2.0', ...payload }))
  }

  const applyPermissionPreference = (next: PermissionPreference) => {
    sendRaw(permissionPreferenceNotification(next))
    deferredPermissionPreferenceRef.current = null
    permissionPreferenceRef.current = next
    setPermissionPreference(next)
  }

  const applySessionPermissionPreference = () => {
    applyPermissionPreference(deferredPermissionPreferenceRef.current ?? DEFAULT_PERMISSION_PREFERENCE)
  }

  const request = (method: string, params: JsonRecord, timeoutMs?: number) => new Promise<JsonRecord>((resolve, reject) => {
    const id = requestIdRef.current++
    const timeout = timeoutMs ? window.setTimeout(() => {
      pendingRef.current.delete(id)
      reject(new Error(`${method} 请求超时`))
    }, timeoutMs) : null
    pendingRef.current.set(id, {
      resolve: (value) => {
        if (timeout !== null) window.clearTimeout(timeout)
        resolve(value)
      },
      reject: (error) => {
        if (timeout !== null) window.clearTimeout(timeout)
        reject(error)
      },
    })
    try {
      sendRaw({ id, method, params })
    } catch (error) {
      pendingRef.current.delete(id)
      reject(error instanceof Error ? error : new Error('Bridge 未连接'))
    }
  })

  const finishInterruptedLoadedSession = async (taskId: string, projectId: string | null, loaded: JsonRecord) => {
    const loadedMeta = asRecord(loaded._meta)
    const runningPromptId = asText(loadedMeta['x.ai/runningPromptId'])
    const runtime = runtimeForTask(taskId)
    const interruptedRunId = interruptedRunForSessionLoad({
      runningPromptId: runningPromptId || null,
      replayedRunId: replayedRunIdRef.current,
      task: runtime.reliability.task,
    })
    replayedRunIdRef.current = null

    if (runningPromptId) {
      try {
        sendRaw({
          method: 'session/cancel',
          params: { sessionId: taskId, _meta: { cancelTrigger: 'session-load-terminal-policy', promptId: runningPromptId } },
        })
      } catch {
        // Restoring history must still end locally even when the best-effort
        // cancellation notification cannot be delivered.
      }
    }

    if (interruptedRunId && isActiveTask(runtime.reliability.task) && runtime.reliability.task.runId === interruptedRunId) {
      const terminal = recordTaskTerminal(runtime.reliability, {
        runId: interruptedRunId,
        outcome: 'failed',
        observedAtMs: Date.now(),
        reason: 'session-restored-after-interruption',
      })
      updateTaskReliability(taskId, terminal.state)
    }
    finishAgentMessage(Date.now(), taskId)
    clearTaskPromptDeadline(taskId)
    runtime.turnStartedAt = null
    runtime.activeRunId = null
    runtime.cancelRequestedRunId = null
    runtime.submitting = false
    runtime.activeAgentMessageId = null
    pendingPermissionByTaskRef.current.delete(taskId)
    pendingQuestionByTaskRef.current.delete(taskId)
    pendingPlanByTaskRef.current.delete(taskId)
    runtime.questionAnswers = {}
    publishTaskRuntime(taskId)

    if (!interruptedRunId) return
    toolReceiptsByRunRef.current.delete(interruptedRunId)
    await changeTaskWorkspaceLifecycle(taskId, projectId, 'mark-idle').catch(() => undefined)
    await settleLocalTaskEnd({
      taskId,
      projectId,
      runId: interruptedRunId,
      outcome: 'failed',
      reason: 'session-restored-after-interruption',
    })
    if (selectedTaskId() === taskId) recordEvent('上次运行已因中断结束；本次只恢复任务历史。', IconAlertCircle)
  }

  const finishActiveTasksForTransportDisconnect = (reason: string) => {
    for (const [taskId, runtime] of taskRuntimesRef.current.entries()) {
      const activeTask = isActiveTask(runtime.reliability.task) ? runtime.reliability.task : null
      if (!activeTask) continue
      const projectId = conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId ?? null
      const terminal = recordTaskTerminal(runtime.reliability, {
        runId: activeTask.runId,
        outcome: 'failed',
        observedAtMs: Date.now(),
        reason,
      })
      updateTaskReliability(taskId, terminal.state)
      clearTaskPromptDeadline(taskId)
      finishAgentMessage(Date.now(), taskId)
      runtime.turnStartedAt = null
      runtime.activeRunId = null
      runtime.cancelRequestedRunId = null
      runtime.submitting = false
      runtime.activeAgentMessageId = null
      pendingPermissionByTaskRef.current.delete(taskId)
      pendingQuestionByTaskRef.current.delete(taskId)
      pendingPlanByTaskRef.current.delete(taskId)
      runtime.questionAnswers = {}
      toolReceiptsByRunRef.current.delete(activeTask.runId)
      publishTaskRuntime(taskId)
      void changeTaskWorkspaceLifecycle(taskId, projectId, 'mark-idle').catch(() => undefined)
      void settleLocalTaskEnd({
        taskId,
        projectId,
        runId: activeTask.runId,
        outcome: 'failed',
        reason,
      }).catch((error) => {
        recordEvent(`异常结束状态无法写入账本：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
      })
    }
  }

  const scheduleBridgeReconnect = (reason: string) => {
    const taskId = selectedTaskId()
    const current = taskId ? runtimeForTask(taskId).reliability : sessionReliabilityRef.current
    const activeTask = isActiveTask(current.task) ? current.task : null
    const disconnected = markTransportDisconnected(current, { nowMs: Date.now(), reason })
    if (taskId) updateTaskReliability(taskId, disconnected.state)
    else updateSessionReliability(disconnected.state)
    if (taskId && activeTask) {
      const projectId = projectIdForTask(taskId, bridgeProjectId)
      finishCurrentRunUi()
      toolReceiptsByRunRef.current.delete(activeTask.runId)
      void changeTaskWorkspaceLifecycle(taskId, projectId, 'mark-idle').catch(() => undefined)
      void settleLocalTaskEnd({
        taskId,
        projectId,
        runId: activeTask.runId,
        outcome: 'failed',
        reason: 'transport-disconnected',
      }).catch((error) => {
        recordEvent(`异常结束状态无法写入账本：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
      })
    }
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
    if (disconnected.reconnect.kind === 'scheduled') {
      setBridgeState('connecting')
      setBridgeError(disconnected.message.text)
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        setConnectionNonce((value) => value + 1)
      }, disconnected.reconnect.delayMs)
      return disconnected.message
    }
    setBridgeState('error')
    setBridgeError(disconnected.message.text)
    return disconnected.message
  }

  const confirmBridgeRecovery = () => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    const recovered = markTransportConnected(sessionReliabilityRef.current)
    updateSessionReliability(recovered.state)
    setIsRunning(isActiveTask(recovered.state.task))
    const taskId = sessionIdRef.current ?? activeConversationId
    if (taskId && isActiveTask(recovered.state.task)) {
      void enqueueTaskEvent({
        type: 'state.changed',
        taskId,
        projectId: projectIdForTask(taskId, bridgeProjectId),
        runId: recovered.state.task.runId,
        source: 'system',
        idempotencyKey: `state:${taskId}:${recovered.state.task.runId}:recovered:${Date.now()}`,
        payload: { state: 'recovered', taskPhase: recovered.state.task.phase },
      })
    }
    for (const action of recovered.actions) {
      if (action.kind !== 'resend_cancel' || !taskId) continue
      try {
        sendRaw({ method: 'session/cancel', params: { sessionId: taskId, _meta: { cancelTrigger: 'reconnect-retry', promptId: action.runId } } })
      } catch {
        // The close handler owns the next retry; an absent socket must not
        // change a queued cancellation into a terminal outcome.
      }
    }
    return recovered.message
  }

  const retryBridgeConnection = () => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    const current = sessionReliabilityRef.current
    updateSessionReliability({
      ...current,
      transport: { ...current.transport, phase: 'reconnecting', reconnectAttempts: 0 },
    })
    setBridgeState('connecting')
    setBridgeError('正在按你的操作重新连接 Agent。')
    setConnectionNonce((value) => value + 1)
  }

  const pauseTaskForUserInput = (taskId: string) => {
    const runtime = runtimeForTask(taskId)
    const paused = pausePromptForUserInput(runtime.reliability)
    if (paused === runtime.reliability) return false
    updateTaskReliability(taskId, paused)
    clearTaskPromptDeadline(taskId)
    return true
  }

  const markPromptTimedOut = (taskId: string, projectId: string | null, runId: string) => {
    const previous = runtimeForTask(taskId).reliability
    const timed = applyPromptTimeout(previous, Date.now())
    updateTaskReliability(taskId, timed.state)
    if (!timed.timedOut || previous.task?.phase === 'failed') return
    finishAgentMessage(Date.now(), taskId)
    const runtime = runtimeForTask(taskId)
    runtime.turnStartedAt = null
    runtime.activeRunId = null
    runtime.cancelRequestedRunId = null
    runtime.submitting = false
    clearTaskPromptDeadline(taskId)
    publishTaskRuntime(taskId)
    toolReceiptsByRunRef.current.delete(runId)
    void changeTaskWorkspaceLifecycle(taskId, projectId, 'mark-idle').catch(() => undefined)
    void settleLocalTaskEnd({
      taskId,
      projectId,
      runId,
      outcome: 'failed',
      reason: 'prompt-terminal-timeout',
    }).catch((error) => {
      recordEvent(`超时终态无法写入账本：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
    })
    recordEvent('等待 Agent 终态超时，本轮任务已结束。', IconAlertCircle)
  }

  const resumeTaskAfterUserInput = (taskId: string) => {
    const runtime = runtimeForTask(taskId)
    const resumed = resumePromptAfterUserInput(runtime.reliability, {
      resumedAtMs: Date.now(),
      timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    })
    if (!resumed.resumed || resumed.deadlineAtMs === null || !resumed.state.task) return false
    updateTaskReliability(taskId, resumed.state)
    clearTaskPromptDeadline(taskId)
    const runId = resumed.state.task.runId
    runtime.promptDeadlineTimer = window.setTimeout(() => {
      if (runtimeForTask(taskId).reliability.task?.runId === runId) {
        markPromptTimedOut(taskId, projectIdForTask(taskId, bridgeProjectId), runId)
      }
    }, Math.max(0, resumed.deadlineAtMs - Date.now()))
    publishTaskRuntime(taskId)
    return true
  }

  const applyPreferredReasoning = async (sessionId: string, modelId: string) => {
    try {
      await request('session/set_model', {
        sessionId,
        modelId,
        _meta: { reasoningEffort: preferredReasoningRef.current },
      }, 30_000)
      return true
    } catch (error) {
      addEvent(`新会话未能应用推理程度：${error instanceof Error ? error.message : '当前模型不支持该档位'}`, IconAlertCircle)
      return false
    }
  }

  const reconcileLoadedSessionModel = async (
    sessionId: string,
    state: ReturnType<typeof sessionModels>,
    config: BridgeConfig,
  ) => {
    const restoredModelId = state.currentId || config.modelProfile
    const resolution = resolveAvailableModel(restoredModelId, config.modelProfile, config.modelAvailability)
    if (!resolution.modelId) {
      preferredModelRef.current = config.modelProfile
      newSessionModelRef.current = config.modelProfile
      setModel(config.modelProfile)
      addEvent(resolution.error || '默认模型当前不可用。', IconAlertCircle)
      return false
    }
    if (!resolution.fellBack) {
      preferredModelRef.current = resolution.modelId
      setModel(resolution.modelId)
      return true
    }

    silentModelUpdateRef.current = resolution.modelId
    try {
      await request('session/set_model', { sessionId, modelId: resolution.modelId }, 30_000)
      preferredModelRef.current = resolution.modelId
      newSessionModelRef.current = resolution.modelId
      setModel(resolution.modelId)
      addEvent(`原会话模型不可用，已切换到 ${models[resolution.modelId]?.label || resolution.modelId}。`, IconAlertCircle)
      return true
    } catch (error) {
      setModel(restoredModelId)
      addEvent(`原会话模型不可用，回退失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
      return false
    } finally {
      silentModelUpdateRef.current = null
    }
  }

  const appendAgentText = (taskId: string, text: string, eventMeta: JsonRecord = {}) => {
    if (!text) return
    const runtime = runtimeForTask(taskId)
    const startedAt = eventTimestamp(eventMeta.turnStartMs) ?? runtime.turnStartedAt ?? undefined
    const activeId = runtime.activeAgentMessageId
    if (activeId) {
      updateTaskMessages(taskId, (current) => current.map((entry) => entry.id === activeId ? { ...entry, text: `${entry.text}${text}`, streaming: true, startedAt: entry.startedAt ?? startedAt } : entry))
      return
    }
    const id = messageId()
    runtime.activeAgentMessageId = id
    updateTaskMessages(taskId, (current) => [...current, { id, role: 'agent', text, streaming: true, startedAt }])
    publishTaskRuntime(taskId)
  }

  const updateTool = (taskId: string, patch: ToolState) => {
    updateTaskTools(taskId, (current) => {
      const index = current.findIndex((item) => item.id === patch.id)
      if (index < 0) return [patch, ...current].slice(0, 12)
      const next = [...current]
      const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ToolState
      next[index] = { ...next[index], ...definedPatch }
      return next
    })
  }

  const handleUpdate = (taskId: string, rawUpdate: JsonRecord, eventMeta: JsonRecord = {}) => {
    const runtime = runtimeForTask(taskId)
    const kind = asText(rawUpdate.sessionUpdate) || asText(rawUpdate.type)
    if (kind === 'model_changed') {
      const nextModel = asText(rawUpdate.modelId ?? rawUpdate.model_id)
      const nextEffort = asText(rawUpdate.reasoningEffort ?? rawUpdate.reasoning_effort)
      if (nextModel) {
        const silent = silentModelUpdateRef.current === nextModel
        if (silent) silentModelUpdateRef.current = null
        if (selectedTaskId() === taskId) {
          setModel(nextModel)
          if (!silent) addEvent(`当前会话已切换到 ${models[nextModel]?.label || nextModel}。`, IconSparkles)
        }
      }
      if (nextEffort === 'low' || nextEffort === 'medium' || nextEffort === 'high') {
        preferredReasoningRef.current = nextEffort
        if (selectedTaskId() === taskId) setReasoningEffort(nextEffort)
      }
      return
    }
    if (kind === 'user_message_chunk') {
      const text = stripResponseModeInstruction(contentText(rawUpdate.content))
      if (!text || isPersistentMemoryContextEcho(rawUpdate.content, text) || isInternalConversationEcho(rawUpdate, text)) return
      finishAgentMessage(undefined, taskId)
      const startedAt = eventTimestamp(eventMeta.turnStartMs) ?? undefined
      updateTaskMessages(taskId, (current) => appendVisibleUserMessageEcho(current, {
        id: messageId(), role: 'user', text, startedAt,
      }))
      return
    }
    if (kind === 'agent_message_chunk') {
      appendAgentText(taskId, contentText(rawUpdate.content), eventMeta)
      return
    }
    if (kind === 'agent_thought_chunk') {
      return
    }
    if (kind === 'tool_call') {
      const id = asText(rawUpdate.toolCallId) || messageId()
      const title = asText(rawUpdate.title) || 'Agent 工具操作'
      const status = asText(rawUpdate.status) || 'pending'
      const turnStartedAt = eventTimestamp(eventMeta.turnStartMs) ?? runtime.turnStartedAt ?? undefined
      updateTool(taskId, { id, title, kind: asText(rawUpdate.kind), name: toolName(rawUpdate) || undefined, status, detail: toolDetail(rawUpdate.rawInput ?? rawUpdate.content), turnStartedAt })
      if (selectedTaskId() === taskId) recordEvent(`工具：${title}`, IconTool)
      return
    }
    if (kind === 'tool_call_update') {
      const id = asText(rawUpdate.toolCallId)
      if (!id) return
      const status = asText(rawUpdate.status) || 'in_progress'
      const turnStartedAt = eventTimestamp(eventMeta.turnStartMs) ?? runtime.turnStartedAt ?? undefined
      updateTool(taskId, {
        id,
        title: asText(rawUpdate.title) || 'Agent 工具操作',
        kind: asText(rawUpdate.kind),
        name: toolName(rawUpdate) || undefined,
        status,
        detail: toolDetail(rawUpdate.rawOutput ?? rawUpdate.content ?? rawUpdate.rawInput),
        media: generatedMedia(rawUpdate.rawOutput),
        turnStartedAt,
      })
      if (selectedTaskId() === taskId && ['completed', 'failed', 'cancelled'].includes(status)) recordEvent(`工具${status === 'completed' ? '已完成' : '已结束'}：${asText(rawUpdate.title) || id}`, status === 'completed' ? IconCheck : IconAlertCircle)
      return
    }
    const terminalOutcome = acpTurnTerminalOutcome(rawUpdate)
    if (terminalOutcome) {
      const runId = asText(eventMeta.promptId ?? eventMeta.prompt_id) || runtime.activeRunId
      if (runId) {
        const terminal = recordTaskTerminal(runtime.reliability, {
          runId,
          outcome: terminalOutcome,
          observedAtMs: eventTimestamp(eventMeta.agentTimestampMs) ?? Date.now(),
          reason: kind,
        })
        updateTaskReliability(taskId, terminal.state)
      }
      clearTaskPromptDeadline(taskId)
      finishAgentMessage(eventTimestamp(eventMeta.agentTimestampMs) ?? Date.now(), taskId)
      runtime.turnStartedAt = null
      runtime.submitting = false
      runtime.activeRunId = null
      runtime.cancelRequestedRunId = null
      publishTaskRuntime(taskId)
    }
  }

  useEffect(() => {
    let disposed = false
    residentSessionIdsRef.current.clear()
    replayResetStateRef.current.clear()
    const closeWithError = (error: Error) => {
      pendingRef.current.forEach(({ reject }) => reject(error))
      pendingRef.current.clear()
    }
    const rollbackScopeTransition = (message: string) => {
      const previous = pendingScopeTransitionRef.current
      if (!previous || previous.targetProjectId !== bridgeProjectId) return 'none' as const
      const failurePlan = planScopeTransitionFailure({
        targetConversationId: previous.targetSessionId,
        previousConversationId: previous.activeConversationId,
        previousHasDraftOrContent: Boolean(
          previous.composer.trim()
          || previous.attachments.length
          || previous.messages.length
          || previous.tools.length
        ),
      })
      if (failurePlan.kind === 'preserve-target') {
        pendingScopeTransitionRef.current = null
        pendingSessionIdRef.current = failurePlan.retryConversationId
        pendingNewScopeRef.current = null
        sessionIdRef.current = null
        setSessionReady(false)
        setRestoringSession(null)
        recordEvent(`任务恢复暂未完成：${message}；已保留当前任务并准备重连。`, IconAlertCircle)
        return 'preserved-target' as const
      }
      if (latestTaskScrollTargetRef.current === previous.targetSessionId) latestTaskScrollTargetRef.current = null
      pendingScopeTransitionRef.current = null
      pendingSessionIdRef.current = previous.sessionId ?? previous.activeConversationId
      pendingNewScopeRef.current = null
      sessionIdRef.current = null
      setActiveProjectId(previous.activeProjectId)
      setActiveConversationId(previous.activeConversationId)
      setMessages(previous.messages)
      setTools(previous.tools)
      setComposer(previous.composer)
      setAttachments(previous.attachments)
      preferredModelRef.current = previous.model
      setModel(previous.model)
      preferredReasoningRef.current = previous.reasoningEffort
      setReasoningEffort(previous.reasoningEffort)
      setSessionReady(false)
      setBridgeError('')
      setBridgeState('connecting')
      setRestoringSession(previous.activeConversationId ? {
        id: previous.activeConversationId,
        title: previous.activeConversationTitle,
        kind: 'switch',
      } : null)
      recordEvent(`目标会话恢复失败：${message}；正在返回原会话。`, IconX)
      setBridgeProjectId(previous.bridgeProjectId)
      setConnectionNonce((value) => value + 1)
      return 'rolled-back' as const
    }

    const boot = async () => {
      setBridgeError('')
      try {
        const [response, projectsResponse] = await Promise.all([
          fetch('/api/bridge-config'),
          fetch('/api/projects'),
        ])
        if (!response.ok) throw new Error(`配置读取失败 (${response.status})`)
        if (!projectsResponse.ok) throw new Error(`项目读取失败 (${projectsResponse.status})`)
        const config = await response.json() as BridgeConfig
        const projectPayload = await projectsResponse.json() as { projects?: Project[] }
        const loadedProjects = Array.isArray(projectPayload.projects) ? projectPayload.projects : []
        if (disposed) return
        setBridgeConfig(config)
        setProjects(loadedProjects)
        if (config.runtimeMode === 'desktop') {
          try { window.localStorage.setItem(desktopStartupSeenKey, '1') } catch { /* first-run detection is best effort */ }
        }
        void fetch('/api/session-catalog').then(async (catalogResponse) => {
          if (!catalogResponse.ok) return null
          return catalogResponse.json() as Promise<{ sessions?: Array<Omit<ConversationSnapshot, 'messages' | 'tools'>> }>
        }).then((catalogPayload) => {
          if (disposed || !Array.isArray(catalogPayload?.sessions)) return
          const catalogSessions: ConversationSnapshot[] = catalogPayload.sessions.map((session) => ({ ...session, messages: [], tools: [] }))
          setConversations((current) => {
            const catalogIds = new Set(catalogSessions.map((session) => session.id))
            return mergeConversationCatalog(current, [
              ...catalogSessions,
              ...current.filter((session) => !catalogIds.has(session.id)),
            ])
          })
        }).catch(() => undefined)
        const configuredModel = profileToModel[config.modelProfile]
        if (configuredModel && !newSessionModelRef.current) newSessionModelRef.current = configuredModel
        if (configuredModel && !preferredModelRef.current) {
          preferredModelRef.current = configuredModel
          setModel(configuredModel)
        }
        if (!config.enabled) {
          const unavailableMessage = config.runtimeError || (config.runtimeMode === 'desktop' ? '桌面客户端未能启动 Agent' : 'Agent Bridge 未启用')
          if (config.runtimeMode === 'desktop' && agentRestartingRef.current) {
            setBridgeState('connecting')
            setBridgeError('正在安全重启本地 Agent。')
            setSessionReady(false)
            return
          }
          const transitionFailure = rollbackScopeTransition(unavailableMessage)
          if (transitionFailure === 'rolled-back') return
          setBridgeState('offline')
          setBridgeError(unavailableMessage)
          setSessionReady(false)
          setRestoringSession(null)
          pendingNewScopeRef.current = null
          if (transitionFailure !== 'preserved-target') pendingSessionIdRef.current = null
          const grokLoginRequired = config.modelAvailability?.some((entry) => entry.id === DEFAULT_MODEL_PROFILE && entry.reason === 'login-required')
          if (config.runtimeMode === 'desktop' && grokLoginRequired) {
            showXaiAuthFeedback(config.runtimeError || '尚未完成 xAI 登录，请通过浏览器登录后重试。')
            if (shouldAutoStartXaiLogin({
              desktopRuntime: true,
              firstRun: firstDesktopRun,
              loginRequired: grokLoginRequired,
              alreadyAttempted: firstRunXaiAuthAttemptedRef.current,
            })) {
              firstRunXaiAuthAttemptedRef.current = true
              void authenticateXai()
            }
          }
          else if (config.runtimeError) addEvent(config.runtimeError, IconAlertCircle)
          else if (config.runtimeMode === 'desktop') addEvent('桌面客户端未能启动 Agent。', IconAlertCircle)
          else showBridgeOfflineFeedback()
          return
        }

        setBridgeState('connecting')
        setSessionReady(false)
        const scopedProject = bridgeProjectId ? loadedProjects.find((project) => project.id === bridgeProjectId) ?? null : null
        if (bridgeProjectId && !scopedProject) throw new Error('当前项目不存在')
        if (scopedProject) {
          if (!config.projectRunnerEnabled) throw new Error('项目 Runner 未启用，请使用 ./run web-agent 启动')
          addEvent(`正在启动项目 Runner：${scopedProject.name}`, IconLoader2)
          const runnerResponse = await fetch(`/api/runners/${encodeURIComponent(scopedProject.id)}`, { method: 'POST' })
          const runnerPayload = await runnerResponse.json() as { runner?: { state?: string }; error?: string }
          if (!runnerResponse.ok || runnerPayload.runner?.state !== 'running') throw new Error(runnerPayload.error || '项目 Runner 启动失败')
        }
        const scopedWorkspace = scopedProject?.rootPath ?? config.workspace
        const scopedProjectId = scopedProject?.id ?? null
        const scopedBridgePath = scopedProject ? `${config.path}/projects/${scopedProject.id}` : config.path
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const socket = new WebSocket(`${protocol}://${window.location.host}${scopedBridgePath}`)
        socketRef.current = socket

        socket.onopen = async () => {
          try {
            const initialized = await request('initialize', {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              _meta: {
                // RunBuild is a generic ACP client backed by CLI session auth; `grok-desktop` is a separate xAI surface.
                clientType: 'generic',
                clientIdentifier: 'personal-agent-webui',
                clientVersion: '0.3.0',
              },
            }, 20_000)
            applySessionModels(initialized, true)
            const listSessions = async (cwd: string, projectId: string | null) => {
              const response = await request('_x.ai/session/list', { cwd, limit: 50 }, 20_000)
              const payload = unwrapExtensionResult(response)
              return (Array.isArray(payload.sessions) ? payload.sessions : [])
                .map((row) => sessionRow(row, projectId))
                .filter((session): session is ConversationSnapshot => Boolean(session))
            }
            const scopedSessions = await listSessions(scopedWorkspace, scopedProjectId)
            const knownSessions = [...scopedSessions].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            const requestedSessionId = pendingSessionIdRef.current
            const scopeKey = scopedProjectId ?? 'root'
            const forceBlankTask = pendingNewScopeRef.current === scopeKey
            pendingSessionIdRef.current = null
            if (forceBlankTask) pendingNewScopeRef.current = null
            const selection = selectScopedConversation(knownSessions, requestedSessionId, forceBlankTask, archivedConversationIdsRef.current)
            const opening = planScopedConversationOpen(selection)
            if (opening.kind === 'missing') throw new Error('目标会话不存在或已不可访问')
            if (opening.kind === 'landing') {
              sessionIdRef.current = null
              if (!disposed) {
                setHomeTaskProjectId(scopedProjectId)
                setActiveProjectId(scopedProjectId)
                setActiveConversationId(null)
                setMessages([])
                setTools([])
                if (!forceBlankTask) {
                  setComposer('')
                  setAttachments([])
                }
                setPendingPermission(null)
                pendingQuestionRef.current = null
                questionAnswersRef.current = {}
                setPendingQuestion(null)
                setPendingPlan(null)
                setQuestionAnswers({})
                activeAgentMessageRef.current = null
                setBridgeState('connected')
                setBridgeError('')
                setSessionReady(false)
                setRestoringSession(null)
                confirmBridgeRecovery()
                const transition = pendingScopeTransitionRef.current
                if (transition?.targetProjectId === scopedProjectId && !transition.targetSessionId) pendingScopeTransitionRef.current = null
                if (selection.archivedOnly) recordEvent('当前范围内的任务均已归档，可直接开始新任务。', IconArchive)
              }
              return
            }
            let activeSession = opening.session
            const cachedSession = conversationsRef.current.find((session) => session.id === activeSession.id)
            if (cachedSession) {
              activeSession = {
                ...cachedSession,
                ...activeSession,
                messages: cachedSession.messages,
                tools: cachedSession.tools,
              }
            }
            const hasCachedSnapshot = Boolean(activeSession.cursor || activeSession.messages.length || activeSession.tools.length)
            if (activeSession.cursor) sessionCursorsRef.current.set(activeSession.id, activeSession.cursor)
            sessionIdRef.current = activeSession.id
            activateTaskRuntime(activeSession.id)
            if (!disposed) {
              setConversations((current) => mergeScopedSessions(current, knownSessions, scopedProjectId))
              setBridgeState('connected')
              setRestoringSession({ id: activeSession.id, title: activeSession.title, kind: 'switch', showCachedSnapshot: hasCachedSnapshot })
            }
            setMessages(hasCachedSnapshot ? activeSession.messages : [])
            setTools(hasCachedSnapshot ? activeSession.tools : [])
            setComposer('')
            setAttachments([])
            replayedRunIdRef.current = null
            replayResetStateRef.current.set(activeSession.id, { hasCachedSnapshot, reset: false })
            const loaded = await request('session/load', {
              sessionId: activeSession.id,
              cwd: activeSession.cwd,
              mcpServers: [],
              _meta: sessionLoadMeta(activeSession.cursor),
            }, 65_000)
            replayResetStateRef.current.delete(activeSession.id)
            await finishInterruptedLoadedSession(activeSession.id, activeSession.projectId, loaded)
            const loadedModels = applySessionModels(loaded)
            await reconcileLoadedSessionModel(activeSession.id, loadedModels, config)
            residentSessionIdsRef.current.add(activeSession.id)
            await restoreTaskWorkspace(activeSession.id, activeSession.projectId).catch((error) => {
              recordEvent(`任务草稿恢复失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
            })
            void enqueueTaskEvent({
              type: 'task.loaded',
              taskId: activeSession.id,
              projectId: activeSession.projectId,
              runId: null,
              source: 'system',
              idempotencyKey: `task:${activeSession.id}:loaded`,
              payload: { source: 'session-load' },
            })
            activeSession = {
              ...activeSession,
              cursor: sessionCursorsRef.current.get(activeSession.id) ?? activeSession.cursor,
              modelId: preferredModelRef.current ?? (loadedModels.currentId || activeSession.modelId || config.modelProfile),
              reasoningEffort: preferredReasoningRef.current,
            }
            const activeIndex = knownSessions.findIndex((session) => session.id === activeSession.id)
            if (activeIndex >= 0) knownSessions[activeIndex] = activeSession
            applySessionPermissionPreference()
            if (!disposed) {
              setActiveConversationId(activeSession.id)
              setActiveProjectId(activeSession.projectId)
              setConversations((current) => mergeScopedSessions(current, knownSessions, scopedProjectId))
              setBridgeState('connected')
              setBridgeError('')
              setSessionReady(true)
              setRestoringSession(null)
              confirmBridgeRecovery()
              const transition = pendingScopeTransitionRef.current
              if (
                transition
                && transition.targetProjectId === activeSession.projectId
                && (!transition.targetSessionId || transition.targetSessionId === activeSession.id)
              ) pendingScopeTransitionRef.current = null
              recordEvent(`已恢复会话：${activeSession.title}`, IconCircleCheck)
            }
          } catch (error) {
            if (!disposed) {
              const message = error instanceof Error ? error.message : '未知错误'
              if (isActiveTask(sessionReliabilityRef.current.task) && activeConversationId) pendingSessionIdRef.current = activeConversationId
              sessionIdRef.current = null
              const transitionFailure = rollbackScopeTransition(message)
              if (transitionFailure === 'rolled-back') return
              if (transitionFailure === 'preserved-target') {
                const recovery = scheduleBridgeReconnect(message)
                setRestoringSession(null)
                addEvent(recovery.text, IconAlertCircle)
                return
              }
              setBridgeState('error')
              setBridgeError(`ACP 初始化失败：${message}`)
              setRestoringSession(null)
              recordEvent(`ACP 初始化失败：${message}`, IconX)
            }
          }
        }

        socket.onmessage = (event) => {
          let packet: JsonRecord
          try { packet = JSON.parse(String(event.data)) as JsonRecord } catch { return }

          const rawMethod = asText(packet.method)
          const outerParams = asRecord(packet.params)
          const isWrappedExtension = rawMethod.startsWith('_')
          const method = isWrappedExtension ? asText(outerParams.method) || rawMethod.slice(1) : rawMethod
          const params = isWrappedExtension && outerParams.method ? asRecord(outerParams.params) : outerParams

          if (method === 'session/update' || method === 'x.ai/session/update' || method === 'x.ai/session_notification') {
            const updateSessionId = asText(params.sessionId)
            const targetSessionId = updateSessionId || sessionIdRef.current
            if (!targetSessionId) return
            const eventMeta = asRecord(packet._meta ?? outerParams._meta ?? params._meta)
            const replayState = replayResetStateRef.current.get(targetSessionId)
            const isReplay = eventMeta.isReplay === true || eventMeta.is_replay === true
            if (replayState && replayNeedsSnapshotReset({
              hasCachedSnapshot: replayState.hasCachedSnapshot,
              isReplay,
              alreadyReset: replayState.reset,
            })) {
              replayState.reset = true
              sessionCursorsRef.current.delete(targetSessionId)
              runtimeForTask(targetSessionId).activeAgentMessageId = null
              updateTaskMessages(targetSessionId, () => [])
              updateTaskTools(targetSessionId, () => [])
            }
            const eventId = asText(eventMeta.eventId ?? eventMeta.event_id)
            if (eventId) sessionCursorsRef.current.set(targetSessionId, eventId)
            const rawUpdate = asRecord(params.update ?? params.sessionUpdate)
            const updateKind = asText(rawUpdate.sessionUpdate) || asText(rawUpdate.type)
            const runId = asText(eventMeta.promptId ?? eventMeta.prompt_id) || runtimeForTask(targetSessionId).activeRunId
            const projectId = projectIdForTask(targetSessionId, bridgeProjectId)
            const terminalOutcome = acpTurnTerminalOutcome(rawUpdate)
            if (isReplay && runId) replayedRunIdRef.current = runId
            if (isReplay && terminalOutcome && replayedRunIdRef.current === runId) replayedRunIdRef.current = null
            const runtime = runtimeForTask(targetSessionId)
            const acceptsTerminal = !terminalOutcome || acceptsTerminalUpdate(runtime.reliability.task, runId || null, terminalOutcome)
            const persisted = acceptsTerminal
              ? persistAcpUpdate({
                  taskId: targetSessionId,
                  projectId,
                  runId: runId || null,
                  eventMeta,
                  rawUpdate,
                })
              : Promise.resolve(null)
            if (terminalOutcome && acceptsTerminal) {
              const sourceEventId = asText(eventMeta.eventId ?? eventMeta.event_id)
              void changeTaskWorkspaceLifecycle(targetSessionId, projectId, 'mark-idle').catch(() => undefined)
              void persisted.then(async (terminal) => {
                if (!terminal) return
                await settleTerminalLedgerEvent({
                  taskId: targetSessionId,
                  projectId,
                  runId: runId || null,
                  sourceEventId,
                  isReplay: eventMeta.isReplay === true || eventMeta.is_replay === true,
                  terminal,
                })
                const automationRun = runId ? automationRunByAgentRunRef.current.get(runId) : null
                if (!automationRun) return
                try {
                  const response = await fetch(`/api/automation-runs/${encodeURIComponent(automationRun.runId)}/reconcile`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ operationId: `ui:reconcile-terminal:${messageId()}` }),
                  })
                  if (!response.ok) throw new Error('自动化运行账本核对失败')
                  void refreshAutomations().catch(() => undefined)
                } finally {
                  automationRunByAgentRunRef.current.delete(runId!)
                }
              }).catch((error) => {
                const detail = error instanceof Error ? error.message : '未知错误'
                recordEvent(`任务终态无法写入账本：${detail}`, IconAlertCircle)
              })
            }
            if (!isReplay && !terminalOutcome && runId && runtime.reliability.task?.runId === runId && !isActiveTask(runtime.reliability.task)) return
            handleUpdate(targetSessionId, rawUpdate, eventMeta)
            return
          }

          if (method === 'session/request_permission' && (typeof packet.id === 'number' || typeof packet.id === 'string')) {
            const toolCall = asRecord(params.toolCall)
            const rawOptions = Array.isArray(params.options) ? params.options : []
            const options = rawOptions.map(asRecord).map((option) => ({ optionId: asText(option.optionId), kind: asText(option.kind), name: asText(option.name) })).filter((option) => option.optionId)
            const title = asText(toolCall.title) || 'Agent 工具操作'
            const permissionMeta = asRecord(packet._meta ?? outerParams._meta ?? params._meta)
            const permissionSessionId = asText(params.sessionId) || sessionIdRef.current
            const permissionRunId = asText(permissionMeta.promptId ?? permissionMeta.prompt_id)
              || (permissionSessionId ? runtimeForTask(permissionSessionId).activeRunId : null)
            const toolCallId = asText(toolCall.toolCallId ?? toolCall.tool_call_id ?? toolCall.id) || null
            const requestKey = `permission:${permissionSessionId ?? 'unattributed'}:${permissionRunId ?? 'unattributed'}:${toolCallId ?? 'unknown'}:${String(packet.id)}`
            const optionFacts = options.map((option) => ({
              optionId: option.optionId,
              kind: option.kind,
              ...(option.name ? { name: option.name } : {}),
            }))
            if (permissionSessionId) {
              void enqueueTaskEvent({
                type: 'permission.requested',
                taskId: permissionSessionId,
                projectId: projectIdForTask(permissionSessionId, bridgeProjectId),
                runId: permissionRunId || null,
                source: 'acp',
                idempotencyKey: requestKey,
                payload: {
                  toolCallId,
                  title,
                  action: title,
                  risk: 'agent-tool',
                  scope: permissionSessionId,
                  options: optionFacts,
                  decisionMode: permissionPreferenceRef.current,
                },
              })
            }
            if (permissionPreferenceRef.current !== 'manual-current') {
              const selected = automaticPermissionOption(options)
              if (selected) {
                sendRaw({
                  id: packet.id,
                  result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
                })
                if (permissionSessionId) {
                  void enqueueTaskEvent({
                    type: 'permission.resolved',
                    taskId: permissionSessionId,
                    projectId: projectIdForTask(permissionSessionId, bridgeProjectId),
                    runId: permissionRunId || null,
                    source: 'system',
                    idempotencyKey: `${requestKey}:resolved`,
                    payload: {
                      toolCallId,
                      action: title,
                      risk: 'agent-tool',
                      scope: permissionSessionId,
                      optionId: selected.optionId,
                      outcome: 'selected',
                      decision: 'approved',
                      decisionMode: 'approve-running',
                    },
                  })
                }
                recordEvent(`完全访问已自动批准：${title}`, IconShieldCheck)
                return
              }
            }
            if (!permissionSessionId) {
              try {
                sendRaw({ id: packet.id, error: { code: -32000, message: 'Permission request is missing its session scope' } })
              } catch { /* close handler owns state */ }
              addEvent('授权请求缺少会话范围，已拒绝展示。', IconAlertCircle)
              return
            }
            const pendingPermission: PendingPermission = {
              requestId: packet.id,
              sessionId: permissionSessionId,
              runId: permissionRunId || null,
              requestKey,
              toolCallId,
              options,
              title,
            }
            pauseTaskForUserInput(permissionSessionId)
            pendingPermissionByTaskRef.current.set(permissionSessionId, pendingPermission)
            if (selectedTaskId() === permissionSessionId) {
              setPendingPermission(pendingPermission)
              recordEvent(`等待授权：${title}`, IconShieldCheck)
            }
            setTaskRuntimeVersion((version) => version + 1)
            return
          }

          if (method === 'x.ai/ask_user_question' && (typeof packet.id === 'number' || typeof packet.id === 'string')) {
            const rawQuestions = Array.isArray(params.questions) ? params.questions : []
            const questions = rawQuestions.map(asRecord).map((question) => ({
              question: asText(question.question),
              multiSelect: Boolean(question.multiSelect ?? question.multi_select),
              options: (Array.isArray(question.options) ? question.options : []).map(asRecord).map((option) => ({ label: asText(option.label), description: asText(option.description), preview: asText(option.preview) || undefined })).filter((option) => option.label),
            })).filter((question) => question.question)
            const questionSessionId = asText(params.sessionId) || sessionIdRef.current
            if (!questionSessionId) {
              try { sendRaw({ id: packet.id, error: { code: -32000, message: 'Question request is missing its session scope' } }) } catch { /* close handler owns state */ }
              return
            }
            const questionRequest: PendingQuestion = { requestId: packet.id, sessionId: questionSessionId, questions, mode: asText(params.mode) || 'default' }
            pauseTaskForUserInput(questionSessionId)
            pendingQuestionByTaskRef.current.set(questionSessionId, questionRequest)
            runtimeForTask(questionSessionId).questionAnswers = {}
            if (selectedTaskId() === questionSessionId) {
              questionAnswersRef.current = {}
              pendingQuestionRef.current = questionRequest
              setQuestionAnswers({})
              setPendingQuestion(questionRequest)
              recordEvent('Agent 正在等待你的回答。', IconMessage)
            }
            setTaskRuntimeVersion((version) => version + 1)
            return
          }

          if (method === 'x.ai/exit_plan_mode' && (typeof packet.id === 'number' || typeof packet.id === 'string')) {
            const planSessionId = asText(params.sessionId) || sessionIdRef.current
            if (!planSessionId) {
              try { sendRaw({ id: packet.id, error: { code: -32000, message: 'Plan request is missing its session scope' } }) } catch { /* close handler owns state */ }
              return
            }
            const planRequest: PendingPlan = { requestId: packet.id, sessionId: planSessionId, content: asText(params.planContent) }
            pauseTaskForUserInput(planSessionId)
            pendingPlanByTaskRef.current.set(planSessionId, planRequest)
            if (selectedTaskId() === planSessionId) {
              setPendingPlan(planRequest)
              recordEvent('Agent 请求批准执行计划。', IconShieldCheck)
            }
            setTaskRuntimeVersion((version) => version + 1)
            return
          }

          if ((typeof packet.id === 'number' || typeof packet.id === 'string') && !packet.method) {
            const waiter = pendingRef.current.get(packet.id)
            if (!waiter) return
            pendingRef.current.delete(packet.id)
            if (packet.error) {
              const error = asRecord(packet.error)
              waiter.reject(new Error(formatJsonRpcProviderError(error)))
            } else {
              waiter.resolve(asRecord(packet.result))
            }
            return
          }

          if ((typeof packet.id === 'number' || typeof packet.id === 'string') && rawMethod) {
            try { sendRaw({ id: packet.id, error: { code: -32601, message: 'Unsupported ACP client request' } }) } catch { /* close handler owns state */ }
          }
        }

        socket.onclose = () => {
          const ownsCurrentConnection = socketRef.current === socket
          const disconnectedSessionId = sessionIdRef.current
          const activeTask = isActiveTask(sessionReliabilityRef.current.task)
          if (ownsCurrentConnection && !disposed) {
            socketRef.current = null
            if (disconnectedSessionId) pendingSessionIdRef.current = disconnectedSessionId
            sessionIdRef.current = null
            residentSessionIdsRef.current.clear()
            replayResetStateRef.current.clear()
            if (!activeTask) {
              activeRunIdRef.current = null
              cancelRequestedRunRef.current = null
              toolReceiptsByRunRef.current.clear()
            }
            closeWithError(new Error('Bridge 已关闭'))
          }
          const transitionFailure = !disposed && ownsCurrentConnection
            ? rollbackScopeTransition('Agent 会话连接已关闭')
            : 'none'
          if (transitionFailure === 'rolled-back') return
          if (!disposed && ownsCurrentConnection) {
            finishActiveTasksForTransportDisconnect('transport-disconnected')
            const recovery = scheduleBridgeReconnect('Agent 会话连接已关闭')
            setSessionReady(false)
            setRestoringSession(disconnectedSessionId ? {
              id: disconnectedSessionId,
              title: conversationsRef.current.find((session) => session.id === disconnectedSessionId)?.title ?? '恢复任务',
              kind: 'switch',
              showCachedSnapshot: true,
            } : null)
            finishCurrentRunUi()
            setPendingPermission(null)
            pendingQuestionRef.current = null
            questionAnswersRef.current = {}
            setPendingQuestion(null)
            setQuestionAnswers({})
            setPendingPlan(null)
            addEvent(recovery.text, IconAlertCircle)
          }
        }
        socket.onerror = () => {
          if (!disposed && socketRef.current === socket) {
            setBridgeState('error')
            setBridgeError('Agent 会话连接出错')
          }
        }
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : '无法连接 Agent Bridge'
          const transitionFailure = rollbackScopeTransition(message)
          if (transitionFailure === 'rolled-back') return
          const recovery = scheduleBridgeReconnect(message)
          setBridgeError(recovery.text)
          addEvent(message, IconX)
        }
      }
    }

    void boot()
    return () => {
      disposed = true
      const currentSocket = socketRef.current
      if (!currentSocket) return
      residentSessionIdsRef.current.clear()
      replayResetStateRef.current.clear()
      currentSocket.close()
      socketRef.current = null
      sessionIdRef.current = null
      activeRunIdRef.current = null
      cancelRequestedRunRef.current = null
      toolReceiptsByRunRef.current.clear()
      closeWithError(new Error('Bridge 已关闭'))
    }
  // The nonce reconnects manually; bridgeProjectId switches to that project's isolated Runner.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionNonce, bridgeProjectId])

  useEffect(() => {
    const id = activeConversationId
    if (!id || restoringSession) return
    setConversations((current) => current.map((session) => session.id === id
      ? {
          ...session,
          messages,
          tools,
          cursor: sessionCursorsRef.current.get(id) ?? session.cursor,
          modelId: model,
          reasoningEffort,
          title: session.title === '新会话' && messages[0]?.role === 'user' ? messages[0].text.slice(0, 28) : session.title,
        }
      : session))
  }, [activeConversationId, messages, model, reasoningEffort, restoringSession, tools])

  const dispatchPromptToSession = (targetSessionId: string, text: string, promptAttachments: Attachment[] = []) => {
    const runtime = runtimeForTask(targetSessionId)
    if (runtime.submitting) return false
    const automationHandoff = automationHandoffByTaskRef.current.get(targetSessionId) ?? null
    if (automationHandoff && permissionPreferenceRef.current !== 'manual-current') {
      addEvent('自动化审核任务必须保持“执行前确认”；请切换后再发送。', IconShieldCheck)
      return false
    }
    const id = messageId()
    const taskProjectId = projectIdForTask(targetSessionId, bridgeProjectId)
    if (taskProjectId && Array.from(taskRuntimesRef.current.entries()).some(([taskId, taskRuntime]) => {
      if (taskId === targetSessionId || !isActiveTask(taskRuntime.reliability.task)) return false
      return conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId === taskProjectId
    })) {
      addEvent('同一项目已有任务在执行；为避免同时改动同一工作目录，请等待其结束。', IconAlertCircle)
      return false
    }
    const startedAtMs = Date.now()
    const promptStart = startPrompt(runtime.reliability, {
      runId: id,
      startedAtMs,
      timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    })
    if (promptStart.kind === 'blocked') {
      addEvent(promptStart.reason === 'active_task' ? '上一轮任务尚未确认终态，不能重复发送。' : 'Agent 连接未恢复，草稿已保留。', IconAlertCircle)
      return false
    }
    updateTaskReliability(targetSessionId, promptStart.state)
    clearTaskPromptDeadline(targetSessionId)
    runtime.promptDeadlineTimer = window.setTimeout(() => {
      if (runtimeForTask(targetSessionId).reliability.task?.runId === id) markPromptTimedOut(targetSessionId, taskProjectId, id)
    }, Math.max(0, promptStart.deadlineAtMs - Date.now()))
    runtime.submitting = true
    runtime.turnStartedAt = startedAtMs
    runtime.activeRunId = id
    runtime.cancelRequestedRunId = null
    toolReceiptsByRunRef.current.set(id, new Map())
    setChatAtBottom(true)
    runtime.activeAgentMessageId = null
    updateTaskMessages(targetSessionId, (current) => [...current, { id, role: 'user', text: text || '请查看附件。', attachments: promptAttachments, startedAt: runtime.turnStartedAt ?? undefined }])
    publishTaskRuntime(targetSessionId)
    recordEvent('已发送给 Agent。', IconCommand)
    const userEventWrite = enqueueTaskEvent({
      type: 'message.user.created',
      taskId: targetSessionId,
      projectId: taskProjectId,
      runId: id,
      source: 'ui',
      idempotencyKey: `message:${targetSessionId}:${id}:user`,
      payload: { promptId: id, hasText: Boolean(text), attachmentCount: promptAttachments.length },
    })
    const runStartedEventWrite = enqueueTaskEvent({
      type: 'run.started',
      taskId: targetSessionId,
      projectId: taskProjectId,
      runId: id,
      source: 'ui',
      idempotencyKey: `run:${targetSessionId}:${id}:started`,
      payload: {
        promptId: id,
        responseMode: agentMode,
        attachmentCount: promptAttachments.length,
        ...(automationHandoff ? { automationRunId: automationHandoff.runId } : {}),
      },
    })
    void (async () => {
      let automationDispatchPrepared = false
      try {
        const runStartedReceipt = await runStartedEventWrite
        await Promise.all([
          ...promptAttachments.map((attachment) => persistTaskAttachment(targetSessionId, taskProjectId, attachment)),
          userEventWrite,
        ])
        if (automationHandoff) {
          const preparedResponse = await fetch(`/api/automation-runs/${encodeURIComponent(automationHandoff.runId)}/prepare-dispatch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              operationId: `ui:prepare-dispatch:${messageId()}`,
              clientId: automationClientIdRef.current,
              claimId: automationHandoff.claimId,
              taskId: targetSessionId,
              agentRunId: id,
              runStartedEventId: runStartedReceipt.event.eventId,
            }),
          })
          const preparedPayload = await preparedResponse.json() as { run?: AutomationRunView; error?: string }
          if (!preparedResponse.ok || !preparedPayload.run) throw new Error(preparedPayload.error || '自动化派发准备失败')
          automationDispatchPrepared = true
          automationRunByAgentRunRef.current.set(id, automationHandoff)
          automationHandoffByTaskRef.current.delete(targetSessionId)
        }
        await changeTaskWorkspaceLifecycle(targetSessionId, taskProjectId, 'mark-running')
        await createGoalExecutionForPrompt({
          taskId: targetSessionId,
          projectId: taskProjectId,
          sourceRunId: id,
          goal: text || '处理当前附件并给出可验证结果',
        })
        let persistentMemoryContext = await memoryContextForPrompt({
          taskId: targetSessionId,
          projectId: taskProjectId,
          prompt: text,
        })
        let preparedMemoryContextReceipt: TaskEventAppendResult | null = null
        if (persistentMemoryContext.receipt) {
          try {
            preparedMemoryContextReceipt = await enqueueTaskEvent({
              type: 'memory.context.prepared',
              taskId: targetSessionId,
              projectId: taskProjectId,
              runId: id,
              source: 'system',
              idempotencyKey: `memory-context:${targetSessionId}:${id}:prepared`,
              payload: memoryContextEventPayload(persistentMemoryContext.receipt, Boolean(persistentMemoryContext.text)),
            })
          } catch (error) {
            // Never inject durable memory if its selected IDs and budget cannot
            // be recorded. The normal task context still proceeds unchanged.
            if (persistentMemoryContext.text) {
              recordEvent(`记忆上下文账本暂不可用，本轮未注入记忆：${error instanceof Error ? error.message : '写入失败'}`, IconAlertCircle)
              persistentMemoryContext = { ...persistentMemoryContext, text: '' }
            }
          }
        }
        const responseModeInstruction = responseModeInstructions[agentMode]
        const result = await request('session/prompt', {
          sessionId: targetSessionId,
          prompt: [
            ...(persistentMemoryContext.text ? [{
              type: 'text',
              text: persistentMemoryContext.text,
              _meta: { 'runbuild.memoryContext': true },
            }] : []),
            ...(responseModeInstruction ? [{ type: 'text', text: responseModeInstruction }] : []),
            ...(text ? [{ type: 'text', text }] : []),
            ...promptAttachments.map((attachment) => {
              if (attachment.kind === 'image') return { type: 'image', data: attachment.data, mimeType: attachment.mimeType }
              const resource = { uri: `file:///personal-agent/${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType }
              return attachment.kind === 'text'
                ? { type: 'resource', resource: { ...resource, text: attachment.data } }
                : { type: 'resource', resource: { ...resource, blob: attachment.data } }
            }),
          ],
          _meta: { promptId: id, responseMode: agentMode },
        })
        if (automationHandoff && automationDispatchPrepared) {
          try {
            const confirmedResponse = await fetch(`/api/automation-runs/${encodeURIComponent(automationHandoff.runId)}/confirm-dispatch`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                operationId: `ui:confirm-dispatch:${messageId()}`,
                clientId: automationClientIdRef.current,
                claimId: automationHandoff.claimId,
                taskId: targetSessionId,
                agentRunId: id,
              }),
            })
            const confirmedPayload = await confirmedResponse.json() as { run?: AutomationRunView; error?: string }
            if (!confirmedResponse.ok || !confirmedPayload.run) throw new Error(confirmedPayload.error || '自动化派发确认失败')
            void refreshAutomations().catch(() => undefined)
          } catch (confirmationError) {
            // ACP may already have accepted this prompt.  Keep the durable
            // state at dispatch_unconfirmed and never send it again.
            recordEvent(`自动化发送收据待确认：${confirmationError instanceof Error ? confirmationError.message : '未知错误'}`, IconAlertCircle)
          }
        }
        if (preparedMemoryContextReceipt && persistentMemoryContext.receipt) {
          try {
            await enqueueTaskEvent({
              type: 'memory.context.dispatched',
              taskId: targetSessionId,
              projectId: taskProjectId,
              runId: id,
              source: 'system',
              idempotencyKey: `memory-context:${targetSessionId}:${id}:dispatched`,
              payload: {
                ...memoryContextEventPayload(persistentMemoryContext.receipt, Boolean(persistentMemoryContext.text)),
                preparedEventId: preparedMemoryContextReceipt.event.eventId,
              },
            })
          } catch (error) {
            // The prepared receipt is still durable. Do not change a confirmed
            // ACP result into a false failed run merely because the follow-up
            // delivery receipt could not be appended.
            recordEvent(`记忆上下文已准备但发送收据待恢复：${error instanceof Error ? error.message : '写入失败'}`, IconAlertCircle)
          }
        }
        const stopReason = asText(result.stopReason)
        recordEvent(stopReason ? `Agent 已返回终态：${stopReason}；等待任务账本确认。` : 'Agent 已返回终态；等待任务账本确认。', IconLoader2)
      } catch (error) {
        const message = error instanceof Error ? error.message : '发送失败'
        const targetRuntime = runtimeForTask(targetSessionId)
        const transportLost = targetRuntime.reliability.transport.phase !== 'connected' || /Bridge (?:已关闭|未连接)/.test(message)
        if (transportLost) {
          const terminal = recordTaskTerminal(targetRuntime.reliability, {
            runId: id,
            outcome: 'failed',
            observedAtMs: Date.now(),
            reason: 'transport-disconnected',
          })
          updateTaskReliability(targetSessionId, terminal.state)
          clearTaskPromptDeadline(targetSessionId)
          finishAgentMessage(Date.now(), targetSessionId)
          targetRuntime.turnStartedAt = null
          targetRuntime.activeRunId = null
          targetRuntime.cancelRequestedRunId = null
          targetRuntime.submitting = false
          publishTaskRuntime(targetSessionId)
          toolReceiptsByRunRef.current.delete(id)
          void changeTaskWorkspaceLifecycle(targetSessionId, taskProjectId, 'mark-idle').catch(() => undefined)
          void settleLocalTaskEnd({
            taskId: targetSessionId,
            projectId: taskProjectId,
            runId: id,
            outcome: 'failed',
            reason: 'transport-disconnected',
          }).catch((ledgerError) => {
            recordEvent(`异常结束状态无法写入账本：${ledgerError instanceof Error ? ledgerError.message : '未知错误'}`, IconAlertCircle)
          })
          recordEvent('Agent 连接异常，本轮任务已结束。', IconAlertCircle)
          return
        }
        const terminal = recordTaskTerminal(targetRuntime.reliability, {
          runId: id,
          outcome: 'failed',
          observedAtMs: Date.now(),
          reason: 'prompt-request-failed',
        })
        updateTaskReliability(targetSessionId, terminal.state)
        clearTaskPromptDeadline(targetSessionId)
        void changeTaskWorkspaceLifecycle(targetSessionId, taskProjectId, 'mark-idle').catch(() => undefined)
        try {
          await enqueueTaskEvent({
            type: 'run.failed',
            taskId: targetSessionId,
            projectId: taskProjectId,
            runId: id,
            source: 'ui',
            idempotencyKey: `run:${targetSessionId}:${id}:prompt-failed`,
            payload: { reason: 'prompt-request-failed' },
          })
          await enqueueTaskEvent({
            type: 'state.changed',
            taskId: targetSessionId,
            projectId: taskProjectId,
            runId: id,
            source: 'system',
            idempotencyKey: `state:${targetSessionId}:${id}:prompt-failed`,
            payload: { state: 'failed', reason: 'prompt-request-failed' },
          })
          await settleGoalExecutionFromLedger(id)
          const automationRun = automationRunByAgentRunRef.current.get(id)
          if (automationRun && automationDispatchPrepared) {
            try {
              const reconcileResponse = await fetch(`/api/automation-runs/${encodeURIComponent(automationRun.runId)}/reconcile`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ operationId: `ui:reconcile:${messageId()}` }),
              })
              if (!reconcileResponse.ok) throw new Error('自动化运行收据核对失败')
              void refreshAutomations().catch(() => undefined)
            } catch (reconcileError) {
              recordEvent(`自动化运行待账本核对：${reconcileError instanceof Error ? reconcileError.message : '未知错误'}`, IconAlertCircle)
            } finally {
              automationRunByAgentRunRef.current.delete(id)
            }
          }
        } catch (ledgerError) {
          recordEvent(`失败状态未能写入验证账本：${ledgerError instanceof Error ? ledgerError.message : '未知错误'}`, IconAlertCircle)
        }
        toolReceiptsByRunRef.current.delete(id)
        if (targetRuntime.activeRunId === id) targetRuntime.activeRunId = null
        const errorMessageId = messageId()
        updateTaskMessages(targetSessionId, (current) => [...current, { id: errorMessageId, role: 'system', tone: 'error', text: `请求失败：${message}` }])
        if (/当前账号无模型访问权限|模型凭据无效或已过期/.test(message)) {
          showXaiAuthFeedback(`${message}。可以切换到有权限的 xAI 账号。`)
        } else {
          addEvent(`请求失败：${message}`, IconX)
        }
        targetRuntime.submitting = false
        finishAgentMessage(Date.now(), targetSessionId)
        targetRuntime.turnStartedAt = null
        targetRuntime.cancelRequestedRunId = null
        publishTaskRuntime(targetSessionId)
      }
    })()
    return true
  }

  const submitPrompt = (rawText: string, promptAttachments: Attachment[] = []) => {
    const text = rawText.trim()
    if ((!text && promptAttachments.length === 0) || (sessionIdRef.current && runtimeForTask(sessionIdRef.current).submitting)) return false
    if (bridgeState !== 'connected' || !sessionReady || !sessionIdRef.current) {
      addEvent('Bridge 未连接，消息未发送。', IconAlertCircle)
      return false
    }
    if (!isModelAvailable(model, bridgeConfig?.modelAvailability)) {
      const reason = modelUnavailableMessage(model, bridgeConfig?.modelAvailability) || `${models[model]?.label || model} 当前不可用。`
      setMessages((current) => [...current, { id: messageId(), role: 'system', tone: 'error', text: reason }])
      if (model === DEFAULT_MODEL_PROFILE && bridgeConfig?.modelAvailability?.some((entry) => entry.id === model && entry.reason === 'login-required')) showXaiAuthFeedback(reason)
      else addEvent(reason, IconAlertCircle)
      return false
    }
    return dispatchPromptToSession(sessionIdRef.current, text, promptAttachments)
  }

  const cancelPrompt = () => {
    const taskId = selectedTaskId()
    if (!taskId) return
    const requestedAt = Date.now()
    const runtime = runtimeForTask(taskId)
    const plan = requestPromptCancel(runtime.reliability, requestedAt)
    updateTaskReliability(taskId, plan.state)
    if (plan.kind === 'not_active') return
    const runId = plan.runId
    if (plan.kind === 'already_requested') {
      const terminal = recordTaskTerminal(plan.state, {
        runId,
        outcome: 'cancelled',
        observedAtMs: requestedAt,
        reason: 'user-cancelled',
      })
      updateTaskReliability(taskId, terminal.state)
    }
    let delivery = 'not-connected'
    if (plan.kind === 'send_cancel' || (plan.kind === 'already_requested' && !plan.awaitingTransport)) {
      try {
        sendRaw({ method: 'session/cancel', params: { sessionId: taskId, _meta: { cancelTrigger: 'button', promptId: runId } } })
        delivery = 'sent'
      } catch {
        delivery = 'send-failed'
      }
    }
    const projectId = projectIdForTask(taskId, bridgeProjectId)
    void enqueueTaskEvent({
      type: 'cancel.requested',
      taskId,
      projectId,
      runId,
      source: 'ui',
      idempotencyKey: `cancel:${taskId}:${runId}`,
      payload: { trigger: 'button', delivery },
    })
    finishCurrentRunUi()
    toolReceiptsByRunRef.current.delete(runId)
    void changeTaskWorkspaceLifecycle(taskId, projectId, 'mark-idle').catch(() => undefined)
    void settleLocalTaskEnd({
      taskId,
      projectId,
      runId,
      outcome: 'cancelled',
      reason: 'user-cancelled',
    }).catch((error) => {
      recordEvent(`取消终态无法写入账本：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
    })
    recordEvent(delivery === 'sent' ? '当前任务已停止。' : '当前任务已结束；Agent 停止通知未送达。', IconX)
  }

  const resolvePermission = (optionId: string | null, decisionMode: PermissionPreference = 'manual-current') => {
    if (!pendingPermission) return
    const selected = optionId ? pendingPermission.options.find((option) => option.optionId === optionId) : null
    if (optionId && !selected) {
      addEvent('授权选项已失效，请等待 Agent 重新请求。', IconX)
      return
    }
    try {
      sendRaw({
        id: pendingPermission.requestId,
        result: { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } },
      })
      resumeTaskAfterUserInput(pendingPermission.sessionId)
      const copy = selected ? permissionOptionCopy(selected).label : '取消'
      void enqueueTaskEvent({
        type: 'permission.resolved',
        taskId: pendingPermission.sessionId,
        projectId: projectIdForTask(pendingPermission.sessionId, bridgeProjectId),
        runId: pendingPermission.runId,
        source: 'ui',
        idempotencyKey: `${pendingPermission.requestKey}:resolved`,
        payload: {
          toolCallId: pendingPermission.toolCallId,
          action: pendingPermission.title,
          risk: 'agent-tool',
          scope: pendingPermission.sessionId,
          optionId: selected?.optionId ?? null,
          outcome: selected ? 'selected' : 'cancelled',
          decision: selected?.kind.startsWith('allow') ? 'approved' : 'rejected',
          decisionMode,
        },
      })
      recordEvent(
        decisionMode === 'approve-running' && selected
          ? `已切换为替我执行，并批准当前操作：${pendingPermission.title}。`
          : `已提交授权选择：${copy}。`,
        selected?.kind.startsWith('allow') ? IconCheck : IconX,
      )
      pendingPermissionByTaskRef.current.delete(pendingPermission.sessionId)
      setPendingPermission(null)
    } catch (error) {
      addEvent(error instanceof Error ? error.message : '授权响应发送失败', IconX)
    }
  }

  const toggleQuestionOption = (question: AgentQuestion, option: string) => {
    const taskId = selectedTaskId()
    const currentAnswers = taskId ? runtimeForTask(taskId).questionAnswers : questionAnswersRef.current
    const selected = currentAnswers[question.question] ?? []
    const next = question.multiSelect
      ? (selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option])
      : [option]
    const nextAnswers = { ...currentAnswers, [question.question]: next }
    if (taskId) runtimeForTask(taskId).questionAnswers = nextAnswers
    questionAnswersRef.current = nextAnswers
    setQuestionAnswers(nextAnswers)
  }

  const resolveQuestion = (accept: boolean) => {
    const questionRequest = pendingQuestionRef.current
    if (!questionRequest) return
    const answers = questionAnswersRef.current
    pendingQuestionRef.current = null
    questionAnswersRef.current = {}
    setPendingQuestion(null)
    setQuestionAnswers({})
    recordEvent(accept ? '已提交给 Agent。' : '已取消本次问答。', accept ? IconCheck : IconX)
    try {
      sendRaw({ id: questionRequest.requestId, result: accept ? { outcome: 'accepted', answers } : { outcome: 'cancelled' } })
      resumeTaskAfterUserInput(questionRequest.sessionId)
      pendingQuestionByTaskRef.current.delete(questionRequest.sessionId)
      runtimeForTask(questionRequest.sessionId).questionAnswers = {}
    } catch (error) {
      pendingQuestionRef.current = questionRequest
      questionAnswersRef.current = answers
      runtimeForTask(questionRequest.sessionId).questionAnswers = answers
      setPendingQuestion(questionRequest)
      setQuestionAnswers(answers)
      addEvent(error instanceof Error ? error.message : '问答响应发送失败', IconX)
    }
  }

  const resolvePlan = (outcome: 'approved' | 'cancelled' | 'abandoned') => {
    if (!pendingPlan) return
    try {
      sendRaw({ id: pendingPlan.requestId, result: { outcome } })
      resumeTaskAfterUserInput(pendingPlan.sessionId)
      recordEvent(outcome === 'approved' ? '已批准执行计划。' : outcome === 'abandoned' ? '已放弃当前计划。' : '已要求 Agent 保持在计划阶段。', outcome === 'approved' ? IconCheck : IconX)
      setPendingPlan(null)
      pendingPlanByTaskRef.current.delete(pendingPlan.sessionId)
    } catch (error) {
      addEvent(error instanceof Error ? error.message : '计划响应发送失败', IconX)
    }
  }

  const approvalCopy = useMemo(() => {
    if (pendingQuestion) return { label: 'Agent 正在提问', color: 'blue', note: '选择答案后提交，Agent 才会继续当前回合。' }
    if (pendingPlan) return { label: '需要批准执行计划', color: 'amber', note: '批准后 Agent 将离开计划阶段并继续执行。' }
    if (pendingPermission) return { label: '等待你的授权', color: 'amber', note: `${toolActivityCopy(pendingPermission.title).label}将在你确认后执行。` }
    return { label: '没有待审批操作', color: 'teal', note: '工具真正执行前，Agent 会在这里请求你的选择。' }
  }, [pendingPermission, pendingPlan, pendingQuestion])
  const answeredQuestionCount = pendingQuestion?.questions.filter((question) => (questionAnswers[question.question] ?? []).length > 0).length ?? 0
  const questionAnswersComplete = Boolean(pendingQuestion?.questions.length) && answeredQuestionCount === pendingQuestion?.questions.length

  const appendSystemMessage = (text: string, tone: 'info' | 'error' = 'info') => {
    setMessages((current) => [...current, { id: messageId(), role: 'system', tone, text }])
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  const addAttachments = async (files: FileList | File[]) => {
    const availableSlots = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length)
    const selected = Array.from(files).slice(0, availableSlots)
    if (!selected.length) {
      addEvent(`最多可添加 ${MAX_COMPOSER_ATTACHMENTS} 个附件。`, IconAlertCircle)
      return
    }
    if (files.length > selected.length) addEvent(`最多可添加 ${MAX_COMPOSER_ATTACHMENTS} 个附件，其余文件未添加。`, IconAlertCircle)
    setAttachmentLoadCount((current) => current + 1)
    try {
      const next: Attachment[] = []
      for (const file of selected) {
        const name = attachmentName(file)
        if (file.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
          addEvent(`未添加 ${name}：单个附件不能超过 2MB。`, IconAlertCircle)
          continue
        }
        try {
          const mimeType = attachmentMimeType(file, name)
          if (mimeType.startsWith('image/')) {
            const dataUrl = await readFile(file, 'dataUrl')
            next.push({ id: messageId(), name, mimeType, size: file.size, kind: 'image', data: dataUrl.split(',', 2)[1] ?? '', preview: dataUrl })
          } else if (mimeType.startsWith('text/') || textAttachmentPattern.test(name)) {
            const text = await readFile(file, 'text')
            next.push({ id: messageId(), name, mimeType, size: file.size, kind: 'text', data: text })
          } else {
            const dataUrl = await readFile(file, 'dataUrl')
            next.push({ id: messageId(), name, mimeType, size: file.size, kind: 'file', data: dataUrl.split(',', 2)[1] ?? '' })
          }
        } catch (error) {
          addEvent(error instanceof Error ? error.message : `无法读取 ${name}`, IconX)
        }
      }
      if (next.length) {
        const taskId = sessionIdRef.current
        if (taskId) {
          const projectId = projectIdForTask(taskId, bridgeProjectId)
          const persisted: Attachment[] = []
          for (const attachment of next) {
            try {
              await persistTaskAttachment(taskId, projectId, attachment)
              persisted.push(attachment)
            } catch (error) {
              addEvent(`未添加 ${attachment.name}：${error instanceof Error ? error.message : '附件保存失败'}`, IconAlertCircle)
            }
          }
          if (persisted.length) setAttachments((current) => [...current, ...persisted].slice(0, MAX_COMPOSER_ATTACHMENTS))
        } else {
          // A new task has no durable ID yet. The attachment remains in the
          // caller-owned composer and is atomically persisted before prompt
          // dispatch after the ACP session is created.
          setAttachments((current) => [...current, ...next].slice(0, MAX_COMPOSER_ATTACHMENTS))
        }
      }
    } finally {
      setAttachmentLoadCount((current) => Math.max(0, current - 1))
    }
  }

  const handleComposerDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    attachmentDragDepthRef.current += 1
    setAttachmentDragActive(true)
  }

  const handleComposerDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleComposerDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1)
    if (!attachmentDragDepthRef.current) setAttachmentDragActive(false)
  }

  const handleComposerDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    attachmentDragDepthRef.current = 0
    setAttachmentDragActive(false)
    const droppedFiles = attachmentTransferFiles(event.dataTransfer)
    if (droppedFiles.length) void addAttachments(droppedFiles)
  }

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = attachmentTransferFiles(event.clipboardData)
    if (!pastedFiles.length) return
    event.preventDefault()
    void addAttachments(pastedFiles)
  }

  const captureScopeTransition = (targetProjectId: string | null, targetSessionId: string | null) => {
    if (pendingScopeTransitionRef.current) return
    pendingScopeTransitionRef.current = {
      targetProjectId,
      targetSessionId,
      bridgeProjectId,
      activeProjectId,
      activeConversationId,
      activeConversationTitle: conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? '原会话',
      sessionId: sessionIdRef.current,
      messages,
      tools,
      composer,
      attachments,
      model,
      reasoningEffort,
    }
  }

  const switchConversation = async (session: ConversationSnapshot) => {
    const navigationPlan = planConversationNavigation({
      activeConversationId,
      targetConversationId: session.id,
      restoringSession: Boolean(restoringSession),
    })
    if (navigationPlan.kind === 'current') {
      setHomeTaskProjectId(undefined)
      setPage('chat')
      setSessionsOpened(false)
      return
    }
    if (navigationPlan.kind === 'blocked') {
      return
    }
    setPendingTaskSubmission(null)
    setHomeTaskProjectId(undefined)
    const hasCachedSnapshot = Boolean(session.cursor || session.messages.length || session.tools.length)
    const applyCachedSessionModel = () => {
      if (session.modelId) {
        preferredModelRef.current = session.modelId
        setModel(session.modelId)
      }
      if (session.reasoningEffort) {
        preferredReasoningRef.current = session.reasoningEffort
        setReasoningEffort(session.reasoningEffort)
      }
    }
    if (session.projectId !== bridgeProjectId) {
      if (Array.from(taskRuntimesRef.current.entries()).some(([taskId, runtime]) => {
        if (!isActiveTask(runtime.reliability.task)) return false
        return conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId !== session.projectId
      })) {
        addEvent('另一个项目的 Agent 正在运行；当前版本不能切换其连接范围。', IconAlertCircle)
        return
      }
      latestTaskScrollTargetRef.current = session.id
      captureScopeTransition(session.projectId, session.id)
      pendingSessionIdRef.current = session.id
      setPage('chat')
      setSessionsOpened(false)
      sessionIdRef.current = null
      setActiveProjectId(session.projectId)
      setActiveConversationId(session.id)
      setMessages(hasCachedSnapshot ? session.messages : [])
      setTools(hasCachedSnapshot ? session.tools : [])
      setComposer('')
      setAttachments([])
      applyCachedSessionModel()
      setBridgeState('connecting')
      setSessionReady(false)
      setRestoringSession({ id: session.id, title: session.title, kind: 'switch', showCachedSnapshot: hasCachedSnapshot })
      setBridgeProjectId(session.projectId)
      return
    }
    latestTaskScrollTargetRef.current = session.id
    setPage('chat')
    setActiveProjectId(session.projectId)
    setSessionsOpened(false)
    const switchPlan = planSessionSwitch({
      currentSessionId: sessionIdRef.current,
      targetSessionId: session.id,
      residentSessionIds: residentSessionIdsRef.current,
      hasCachedSnapshot,
    })
    if (switchPlan.kind === 'current') {
      setActiveConversationId(session.id)
      setMessages(session.messages)
      setTools(session.tools)
      setAttachments([])
      return
    }
    if (switchPlan.kind === 'resident') {
      if (session.cursor) sessionCursorsRef.current.set(session.id, session.cursor)
      sessionIdRef.current = session.id
      activateTaskRuntime(session.id)
      setActiveConversationId(session.id)
      setMessages(session.messages)
      setTools(session.tools)
      setComposer('')
      setAttachments([])
      void restoreTaskWorkspace(session.id, session.projectId).catch((error) => {
        recordEvent(`任务草稿恢复失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
      })
      applyCachedSessionModel()
      setSessionReady(true)
      setRestoringSession(null)
      addEvent(`已切换会话：${session.title}`, IconMessage)
      return
    }
    const previousId = sessionIdRef.current
    const previousConversationId = activeConversationId
    const previousProjectId = activeProjectId
    const previousMessages = messages
    const previousTools = tools
    const previousComposer = composer
    const previousAttachments = attachments
    const previousModel = model
    const previousReasoningEffort = reasoningEffort
    sessionIdRef.current = session.id
    activateTaskRuntime(session.id)
    if (session.cursor) sessionCursorsRef.current.set(session.id, session.cursor)
    setActiveConversationId(session.id)
    setMessages(switchPlan.showCachedSnapshot ? session.messages : [])
    setTools(switchPlan.showCachedSnapshot ? session.tools : [])
    setComposer('')
    setAttachments([])
    applyCachedSessionModel()
    setSessionReady(false)
    setRestoringSession({ id: session.id, title: session.title, kind: 'switch', showCachedSnapshot: switchPlan.showCachedSnapshot })
    replayedRunIdRef.current = null
    replayResetStateRef.current.set(session.id, { hasCachedSnapshot: switchPlan.showCachedSnapshot, reset: false })
    try {
      const loaded = await request('session/load', {
        sessionId: session.id,
        cwd: session.cwd,
        mcpServers: [],
        _meta: sessionLoadMeta(session.cursor),
      }, 65_000)
      replayResetStateRef.current.delete(session.id)
      await finishInterruptedLoadedSession(session.id, session.projectId, loaded)
      const loadedModels = applySessionModels(loaded)
      if (bridgeConfig) await reconcileLoadedSessionModel(session.id, loadedModels, bridgeConfig)
      residentSessionIdsRef.current.add(session.id)
      await restoreTaskWorkspace(session.id, session.projectId).catch((error) => {
        recordEvent(`任务草稿恢复失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
      })
      void enqueueTaskEvent({
        type: 'task.loaded',
        taskId: session.id,
        projectId: session.projectId,
        runId: null,
        source: 'system',
        idempotencyKey: `task:${session.id}:loaded`,
        payload: { source: 'session-load' },
      })
      setConversations((current) => current.map((entry) => entry.id === session.id ? {
        ...entry,
        cursor: sessionCursorsRef.current.get(session.id) ?? entry.cursor,
        modelId: preferredModelRef.current ?? (loadedModels.currentId || entry.modelId || bridgeConfig?.modelProfile),
        reasoningEffort: preferredReasoningRef.current,
      } : entry))
      applySessionPermissionPreference()
      setSessionReady(true)
      setRestoringSession(null)
      addEvent(`已恢复会话：${session.title}`, IconMessage)
    } catch (error) {
      replayResetStateRef.current.delete(session.id)
      if (latestTaskScrollTargetRef.current === session.id) latestTaskScrollTargetRef.current = null
      sessionIdRef.current = previousId
      if (previousId) activateTaskRuntime(previousId)
      setActiveConversationId(previousConversationId)
      setActiveProjectId(previousProjectId)
      setMessages(previousMessages)
      setTools(previousTools)
      setComposer(previousComposer)
      setAttachments(previousAttachments)
      preferredModelRef.current = previousModel
      setModel(previousModel)
      preferredReasoningRef.current = previousReasoningEffort
      setReasoningEffort(previousReasoningEffort)
      setSessionReady(Boolean(previousId))
      setRestoringSession(null)
      addEvent(error instanceof Error ? `会话恢复失败：${error.message}` : '会话恢复失败', IconX)
    }
  }

  const newTask = async (
    projectId?: string,
    projectOverride?: Project,
    initialPrompt?: { text: string; attachments: Attachment[] },
    automationHandoff?: { runId: string; claimId: string; instruction: string },
  ) => {
    const requestedProjectId = projectId ?? null
    const runningTaskInAnotherScope = Array.from(taskRuntimesRef.current.entries()).some(([taskId, runtime]) => {
      if (!isActiveTask(runtime.reliability.task)) return false
      return conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId !== requestedProjectId
    })
    if (runningTaskInAnotherScope) {
      addEvent('另一个项目的 Agent 正在运行；跨项目并行将在后续连接池版本中提供。', IconAlertCircle)
      return 'blocked' as const
    }
    if (restoringSession) return 'blocked' as const
    const project = projectOverride ?? projects.find((entry) => entry.id === requestedProjectId) ?? null
    const transitionTitle = project?.name ?? '新会话'
    const deferInitialPrompt = () => {
      if (!initialPrompt) return
      setPendingTaskSubmission({
        projectId: requestedProjectId,
        text: initialPrompt.text,
        attachments: initialPrompt.attachments,
      })
      recordEvent('正在连接对应 Agent；连接完成后会继续创建并发送首条任务。', IconLoader2)
    }
    const showPendingTask = () => {
      setHomeTaskProjectId(undefined)
      setPage('chat')
      setActiveProjectId(requestedProjectId)
      setActiveConversationId(null)
      setComposer('')
      setAttachments([])
      setMessages([])
      setTools([])
      setPendingPermission(null)
      pendingQuestionRef.current = null
      questionAnswersRef.current = {}
      setPendingQuestion(null)
      setPendingPlan(null)
      setQuestionAnswers({})
      activeAgentMessageRef.current = null
      deactivateTaskRuntime()
      setSessionReady(false)
      setRestoringSession({ id: requestedProjectId ?? 'root', title: transitionTitle, kind: 'create' })
    }
    if (requestedProjectId !== bridgeProjectId) {
      deferInitialPrompt()
      captureScopeTransition(requestedProjectId, null)
      pendingNewScopeRef.current = requestedProjectId ?? 'root'
      showPendingTask()
      setBridgeState('connecting')
      setBridgeProjectId(requestedProjectId)
      return 'deferred' as const
    }
    if (bridgeState !== 'connected' || !bridgeConfig?.workspace) {
      deferInitialPrompt()
      pendingNewScopeRef.current = requestedProjectId ?? 'root'
      showPendingTask()
      setBridgeState('connecting')
      setConnectionNonce((value) => value + 1)
      return 'deferred' as const
    }
    const cwd = project?.rootPath ?? bridgeConfig.workspace
    const previousSessionId = sessionIdRef.current
    const previousConversationId = activeConversationId
    const previousProjectId = activeProjectId
    const previousComposer = composer
    const previousAttachments = attachments
    const previousMessages = messages
    const previousTools = tools
    const previousPendingPermission = pendingPermission
    const previousPendingQuestion = pendingQuestion
    const previousPendingPlan = pendingPlan
    const previousQuestionAnswers = questionAnswers
    const previousPendingQuestionRef = pendingQuestionRef.current
    const previousQuestionAnswersRef = questionAnswersRef.current
    const previousActiveAgentMessage = activeAgentMessageRef.current
    sessionIdRef.current = null
    activeRunIdRef.current = null
    cancelRequestedRunRef.current = null
    showPendingTask()
    try {
      const preferredModelId = newSessionModelRef.current ?? preferredModelRef.current ?? bridgeConfig.modelProfile
      const modelResolution = resolveAvailableModel(preferredModelId, bridgeConfig.modelProfile, bridgeConfig.modelAvailability)
      if (!modelResolution.modelId) throw new Error(modelResolution.error || '默认模型当前不可用')
      const requestedModelId = modelResolution.modelId
      if (modelResolution.fellBack) {
        newSessionModelRef.current = requestedModelId
        preferredModelRef.current = requestedModelId
        setModel(requestedModelId)
        addEvent(`所选模型不可用，已改用 ${models[requestedModelId]?.label || requestedModelId}。`, IconAlertCircle)
      }
      const session = await request('session/new', {
        cwd,
        mcpServers: [],
        _meta: { modelId: requestedModelId },
      }, 30_000)
      const sessionId = asText(session.sessionId)
      if (!sessionId) throw new Error('Agent 未返回会话 ID')
      applySessionModels(session, true)
      if (await applyPreferredReasoning(sessionId, requestedModelId)) {
        preferredModelRef.current = requestedModelId
        setModel(requestedModelId)
      }
      applySessionPermissionPreference()
      sessionIdRef.current = sessionId
      activateTaskRuntime(sessionId)
      const taskCreatedEvent = enqueueTaskEvent({
        type: 'task.created',
        taskId: sessionId,
        projectId: project?.id ?? null,
        runId: null,
        source: 'ui',
        idempotencyKey: `task:${sessionId}:created`,
        payload: { title: '新会话', modelId: requestedModelId, ...(automationHandoff ? { automationRunId: automationHandoff.runId } : {}) },
      })
      if (!automationHandoff) void taskCreatedEvent
      setActiveConversationId(sessionId)
      setActiveProjectId(project?.id ?? null)
      residentSessionIdsRef.current.add(sessionId)
      setConversations((current) => [{
        id: sessionId,
        title: '新会话',
        messages: [],
        tools: [],
        createdAt: timestamp(),
        cwd,
        projectId: project?.id ?? null,
        modelId: requestedModelId,
        reasoningEffort: preferredReasoningRef.current,
      }, ...current])
      setSessionReady(true)
      setRestoringSession(null)
      recordEvent(project ? `已在项目“${project.name}”中创建会话。` : '已创建新的 ACP 会话。', IconCircleCheck)
      if (automationHandoff) {
        try {
          const receipt = await taskCreatedEvent
          const response = await fetch(`/api/automation-runs/${encodeURIComponent(automationHandoff.runId)}/bind-task`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              operationId: `ui:bind-task:${messageId()}`,
              clientId: automationClientIdRef.current,
              claimId: automationHandoff.claimId,
              taskId: sessionId,
              taskCreatedEventId: receipt.event.eventId,
            }),
          })
          const payload = await response.json() as { run?: AutomationRunView; error?: string }
          if (!response.ok || !payload.run) throw new Error(payload.error || '自动化任务交接失败')
          automationHandoffByTaskRef.current.set(sessionId, { runId: automationHandoff.runId, claimId: automationHandoff.claimId })
          setComposer(automationHandoff.instruction)
          setAttachments([])
          void refreshAutomations().catch(() => undefined)
          recordEvent('自动化已交接到新任务草稿；请先审核，再手动发送。', IconShieldCheck)
        } catch (handoffError) {
          void fetch(`/api/automation-runs/${encodeURIComponent(automationHandoff.runId)}/release`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operationId: `ui:release:${messageId()}`, clientId: automationClientIdRef.current, claimId: automationHandoff.claimId }),
          }).catch(() => undefined)
          addEvent(`自动化未能交接到新任务：${handoffError instanceof Error ? handoffError.message : '未知错误'}`, IconAlertCircle)
        }
      } else if (initialPrompt) {
        dispatchPromptToSession(sessionId, initialPrompt.text, initialPrompt.attachments)
      }
      return 'created' as const
    } catch (error) {
      sessionIdRef.current = previousSessionId
      if (previousSessionId) activateTaskRuntime(previousSessionId)
      setActiveConversationId(previousConversationId)
      setActiveProjectId(previousProjectId)
      setComposer(previousComposer)
      setAttachments(previousAttachments)
      setMessages(previousMessages)
      setTools(previousTools)
      setPendingPermission(previousPendingPermission)
      pendingQuestionRef.current = previousPendingQuestionRef
      questionAnswersRef.current = previousQuestionAnswersRef
      setPendingQuestion(previousPendingQuestion)
      setPendingPlan(previousPendingPlan)
      setQuestionAnswers(previousQuestionAnswers)
      activeAgentMessageRef.current = previousActiveAgentMessage
      setSessionReady(Boolean(previousSessionId))
      setRestoringSession(null)
      const message = error instanceof Error ? error.message : '未知错误'
      addEvent(`新会话创建失败：${message}`, IconX)
      return 'failed' as const
    }
  }

  const restorePendingTaskSubmission = (submission: PendingTaskSubmission, message: string) => {
    setHomeTaskProjectId(submission.projectId)
    setPage('chat')
    setActiveProjectId(submission.projectId)
    setComposer(submission.text)
    setAttachments(submission.attachments)
    addEvent(message, IconAlertCircle)
  }

  useEffect(() => {
    const submission = pendingTaskSubmission
    if (!submission || !shouldResumePendingTaskSubmission({
      pendingProjectId: submission.projectId,
      bridgeProjectId,
      bridgeState,
      isRunning,
      restoringSession: Boolean(restoringSession),
    })) return
    const project = submission.projectId ? projects.find((entry) => entry.id === submission.projectId) : undefined
    setPendingTaskSubmission(null)
    if (submission.projectId && !project) {
      restorePendingTaskSubmission(submission, '目标项目已不存在，首条任务已恢复为草稿。')
      return
    }
    void newTask(submission.projectId ?? undefined, project, {
      text: submission.text,
      attachments: submission.attachments,
    }).then((result) => {
      if (result === 'created' || result === 'deferred') return
      restorePendingTaskSubmission(
        submission,
        result === 'blocked'
          ? '当前任务状态仍在切换，首条任务已恢复为草稿。'
          : '新会话未能创建，首条任务已恢复为草稿。',
      )
    })
  }, [bridgeProjectId, bridgeState, isRunning, pendingTaskSubmission, projects, restoringSession])

  useEffect(() => {
    const submission = pendingTaskSubmission
    if (!submission) return
    const bridgeUnavailable = submission.projectId === bridgeProjectId && ['error', 'offline'].includes(bridgeState)
    const returnedToAnotherScope = submission.projectId !== bridgeProjectId && bridgeState === 'connected' && !restoringSession
    if (!bridgeUnavailable && !returnedToAnotherScope) return
    setPendingTaskSubmission(null)
    restorePendingTaskSubmission(
      submission,
      returnedToAnotherScope
        ? '未能切换到目标项目，首条任务已恢复为草稿。'
        : bridgeError
          ? `连接对应 Agent 失败：${bridgeError}；首条任务已恢复为草稿。`
          : '连接对应 Agent 失败，首条任务已恢复为草稿。',
    )
  }, [bridgeError, bridgeProjectId, bridgeState, pendingTaskSubmission, restoringSession])

  const releaseAutomationHandoff = async (handoff: PendingAutomationHandoff) => {
    const response = await fetch(`/api/automation-runs/${encodeURIComponent(handoff.runId)}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: `ui:release:${messageId()}`,
        clientId: automationClientIdRef.current,
        claimId: handoff.claimId,
      }),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(payload.error || '自动化领取释放失败')
    }
  }
  const startAutomationRun = async (run: AutomationRunView) => {
    if (automationActionId || isRunning || restoringSession) return
    setAutomationActionId(run.id)
    setAutomationsError('')
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: `ui:claim:${messageId()}`, clientId: automationClientIdRef.current }),
      })
      const payload = await response.json() as {
        run?: AutomationRunView
        launch?: { projectId: string | null; instruction: string; claimId: string; permission: 'manual-current' }
        error?: string
      }
      if (!response.ok || !payload.run || !payload.launch) throw new Error(payload.error || '自动化领取失败')
      const handoff: PendingAutomationHandoff = {
        runId: payload.run.id,
        claimId: payload.launch.claimId,
        projectId: payload.launch.projectId,
        instruction: payload.launch.instruction,
      }
      if (handoff.projectId && !projects.some((project) => project.id === handoff.projectId)) {
        await releaseAutomationHandoff(handoff)
        throw new Error('自动化所属项目已不在当前工作台，请恢复项目后再启动')
      }
      setPendingAutomationHandoff(handoff)
      automationHandoffAttemptRef.current = null
      await refreshAutomations()
      addEvent('自动化已领取，正在创建可审核的新任务。', IconClock)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化领取失败')
    } finally {
      setAutomationActionId(null)
    }
  }
  useEffect(() => {
    const handoff = pendingAutomationHandoff
    if (!handoff || isRunning || restoringSession) return
    const project = handoff.projectId ? projects.find((entry) => entry.id === handoff.projectId) : undefined
    if (handoff.projectId && !project) {
      setPendingAutomationHandoff(null)
      void releaseAutomationHandoff(handoff).catch(() => undefined)
      setAutomationsError('自动化所属项目已不在当前工作台，请恢复项目后再启动。')
      return
    }
    const key = `${handoff.runId}:${handoff.projectId ?? 'root'}:${bridgeProjectId ?? 'root'}:${bridgeState}:${sessionReady ? 'ready' : 'waiting'}`
    if (automationHandoffAttemptRef.current === key) return
    automationHandoffAttemptRef.current = key
    void newTask(handoff.projectId ?? undefined, project, undefined, handoff).then((result) => {
      if (result === 'deferred') return
      automationHandoffAttemptRef.current = null
      setPendingAutomationHandoff(null)
      if (result === 'created') return
      void releaseAutomationHandoff(handoff).catch(() => undefined)
      setAutomationsError('未能创建自动化审核任务；该运行已退回队列。')
    })
  }, [bridgeProjectId, bridgeState, isRunning, pendingAutomationHandoff, projects, restoringSession, sessionReady])

  const openTaskHome = (projectId: string | null) => {
    if (restoringSession) return
    setPendingTaskSubmission(null)
    const changesScope = projectId !== bridgeProjectId
    if (changesScope && Array.from(taskRuntimesRef.current.entries()).some(([taskId, runtime]) => {
      if (!isActiveTask(runtime.reliability.task)) return false
      return conversationsRef.current.find((conversation) => conversation.id === taskId)?.projectId !== projectId
    })) {
      addEvent('另一个项目的 Agent 正在运行；当前版本不能切换其连接范围。', IconAlertCircle)
      return
    }
    if (changesScope) captureScopeTransition(projectId, null)
    sessionIdRef.current = null
    deactivateTaskRuntime()
    setPage('chat')
    setHomeTaskProjectId(projectId)
    setActiveProjectId(projectId)
    setActiveConversationId(null)
    setComposer('')
    setAttachments([])
    setMessages([])
    setTools([])
    setPendingPermission(null)
    pendingQuestionRef.current = null
    questionAnswersRef.current = {}
    setPendingQuestion(null)
    setPendingPlan(null)
    setQuestionAnswers({})
    activeAgentMessageRef.current = null
    setSessionReady(false)
    setRestoringSession(null)
    if (changesScope) {
      pendingNewScopeRef.current = projectId ?? 'root'
      setBridgeState('connecting')
      setBridgeProjectId(projectId)
    }
  }

  useEffect(() => {
    if (!sidebarPreferencesHydrated || !activeConversationId || !archivedConversationIds.includes(activeConversationId)) return
    if (isRunning || restoringSession) return
    openTaskHome(activeProjectId)
  }, [activeConversationId, activeProjectId, archivedConversationIds, isRunning, restoringSession, sidebarPreferencesHydrated])

  const submitTaskPrompt = (text: string, promptAttachments: Attachment[] = []) => {
    if (homeTaskProjectId === undefined) return submitPrompt(text, promptAttachments)
    const project = projects.find((entry) => entry.id === homeTaskProjectId)
    void newTask(homeTaskProjectId ?? undefined, project, { text, attachments: promptAttachments })
    return true
  }

  const commandDraft = composer.trimStart()
  const commandInput = commandDraft.startsWith('/')
  const commandMenuOpen = commandInput && !commandDraft.slice(1).includes(' ') && !commandMenuDismissed
  const commandToken = commandInput ? commandDraft.slice(1).split(/\s/, 1)[0].toLowerCase() : ''
  const commandSuggestions = useMemo(() => commandMenuOpen
    ? slashCommands.filter((command) => command.name.startsWith(commandToken))
    : [], [commandMenuOpen, commandToken])
  const groupedCommandSuggestions = useMemo(() => {
    const groups = new Map<SlashCommand['group'], SlashCommand[]>()
    for (const command of commandSuggestions) {
      const group = groups.get(command.group) ?? []
      group.push(command)
      groups.set(command.group, group)
    }
    return [...groups.entries()]
  }, [commandSuggestions])
  const selectedCommand = commandSuggestions[Math.min(commandIndex, Math.max(commandSuggestions.length - 1, 0))]
  useEffect(() => {
    if (!commandMenuOpen || !selectedCommand) return
    document.getElementById(`composer-command-${selectedCommand.name}`)?.scrollIntoView({ block: 'nearest' })
  }, [commandMenuOpen, selectedCommand])
  const composerNeedsSession = !commandInput || !['clear', 'dashboard', 'docs', 'help', 'mcps', 'model', 'multiline', 'resume', 'shortcuts', 'status', 'theme', 'view-plan'].includes(commandToken)

  const completeCommand = (command: SlashCommand) => {
    setComposer(`/${command.name}${command.acceptsArgs ? ' ' : ''}`)
    setCommandIndex(0)
    setCommandMenuDismissed(true)
  }

  const clearCurrentView = () => {
    setMessages([])
    setTools([])
    setPendingPermission(null)
    pendingQuestionRef.current = null
    questionAnswersRef.current = {}
    setPendingQuestion(null)
    setPendingPlan(null)
    setQuestionAnswers({})
    const taskId = selectedTaskId()
    if (taskId) {
      runtimeForTask(taskId).activeAgentMessageId = null
      pendingPermissionByTaskRef.current.delete(taskId)
      pendingQuestionByTaskRef.current.delete(taskId)
      pendingPlanByTaskRef.current.delete(taskId)
      publishTaskRuntime(taskId)
    }
    recordEvent('已清空当前页面记录。', IconX)
  }

  const showExtensionResult = (title: string, value: JsonRecord) => {
    const payload = unwrapExtensionResult(value)
    let detail = ''
    try { detail = JSON.stringify(payload, null, 2).slice(0, 16_000) } catch { detail = String(payload) }
    appendSystemMessage(`${title}\n${detail || '没有返回条目。'}`)
  }

  const runBridgeCommand = (command: string, argument: string, fullInput: string) => {
    if (!sessionReady || !sessionIdRef.current || !bridgeConfig) {
      appendSystemMessage('当前命令需要先连接 Agent。', 'error')
      return true
    }
    const sessionId = sessionIdRef.current
    const cwd = activeProject?.rootPath ?? bridgeConfig.workspace
    if (command === 'rename') {
      if (!argument) { appendSystemMessage('用法：/rename <标题>'); return true }
      void request('_x.ai/session/rename', { sessionId, title: argument, cwd }, 20_000).then(() => {
        setConversations((current) => current.map((entry) => entry.id === sessionId ? { ...entry, title: argument } : entry))
        addEvent(`会话已重命名为：${argument}`, IconCheck)
      }).catch((error) => appendSystemMessage(`重命名失败：${error instanceof Error ? error.message : '未知错误'}`, 'error'))
      return true
    }
    if (command === 'session-info' || command === 'context') {
      void request('_x.ai/session/info', { sessionId }, 20_000).then((response) => showExtensionResult(command === 'context' ? '上下文状态' : '会话信息', response)).catch((error) => appendSystemMessage(`读取失败：${error instanceof Error ? error.message : '未知错误'}`, 'error'))
      return true
    }
    if (command === 'compact') return submitPrompt(fullInput)
    return false
  }

  const runComposerInput = (rawInput: string, promptAttachments: Attachment[] = []): boolean => {
    const input = rawInput.trim()
    if (!input && promptAttachments.length === 0) return false
    if (!input.startsWith('/')) {
      return submitTaskPrompt(input, promptAttachments)
    }

    const [rawCommand, ...rest] = input.slice(1).split(/\s+/)
    const command = rawCommand.toLowerCase()
    const argument = rest.join(' ').trim()
    if (promptAttachments.length && !['run', 'design-experts', 'shell'].includes(command)) {
      appendSystemMessage(`/${rawCommand || '命令'} 不能附带附件；请改为直接发送任务，或使用 /run、/shell。`, 'error')
      return false
    }
    if (command === 'run') {
      if (!argument) appendSystemMessage('用法：/run <任务>')
      else return submitTaskPrompt(argument, promptAttachments)
      return true
    }
    if (command === 'design-experts') {
      if (!argument) appendSystemMessage('用法：/design-experts <任务>')
      else return submitTaskPrompt(`请使用 design-experts 技能，把下面的任务交给 design-expert 设计专家团队；选择最少必要的专业角色，并汇总成一个一致、可执行的方案：\n\n${argument}`, promptAttachments)
      return true
    }
    if (command === 'shell') {
      if (!argument) appendSystemMessage('用法：/shell <命令>')
      else return submitTaskPrompt(`请在当前工作区执行以下命令：\`${argument}\`。执行前说明影响，并在需要时请求工具审批。`, promptAttachments)
      return true
    }
    if (command === 'new') {
      openTaskHome(activeProjectId)
      return true
    }
    if (command === 'dashboard') {
      const rows = conversations.length
        ? conversations.map((session) => `${session.id === activeConversationId ? '●' : '○'} ${session.title} — ${session.projectId ? projects.find((item) => item.id === session.projectId)?.name || '项目' : '独立会话'}`).join('\n')
        : '暂无会话。'
      appendSystemMessage(`会话总览\n${rows}`)
      return true
    }
    if (command === 'resume') {
      setSearchText('')
      setSearchOpened(true)
      return true
    }
    if (command === 'view-plan') {
      appendSystemMessage(pendingPlan?.content ? `当前待批准计划\n${pendingPlan.content}` : '当前没有待批准的执行计划。')
      return true
    }
    if (command === 'mcps') {
      if (isRunning || pendingPermission || pendingQuestion || pendingPlan) {
        appendSystemMessage('当前任务仍在执行或等待确认。请先完成或停止本轮任务，再使用 /mcps 重新加载连接。', 'error')
        return true
      }
      void restartLocalAgent('mcps')
      return true
    }
    if (command === 'always-approve') {
      const next = argument.toLowerCase() === 'off' ? 'manual-current' : permissionFullAccess ? 'manual-current' : 'approve-running'
      void changePermissionPreference(next)
      return true
    }
    if (command === 'multiline') {
      appendSystemMessage('输入框已支持多行：按 Shift + Enter 换行，按 Enter 发送。')
      return true
    }
    if (['rename', 'session-info', 'compact', 'context'].includes(command)) {
      return runBridgeCommand(command, argument, input)
    }
    if (command === 'clear') {
      clearCurrentView()
      return true
    }
    if (command === 'status') {
      const currentModel = models[model] ?? { label: model, detail: '当前会话模型' }
      appendSystemMessage(`Bridge：${bridgeLabel}\n会话：${sessionReady ? '已就绪' : '未就绪'}\n运行模型：${currentModel.label}（${currentModel.detail}）`)
      return true
    }
    if (command === 'model') {
      const currentModel = models[model] ?? { label: model }
      appendSystemMessage(`当前会话模型：${currentModel.label}\n可在输入框下方的模型菜单中切换；菜单只显示当前 Agent 返回的可选模型。`)
      return true
    }
    if (command === 'theme') {
      const nextScheme = colorScheme === 'dark' ? 'light' : 'dark'
      setColorScheme(nextScheme)
      appendSystemMessage(`已切换到${nextScheme === 'light' ? '浅色' : '深色'}主题。`)
      return true
    }
    if (command === 'help') {
      appendSystemMessage(`可用命令：\n${slashCommands.map((item) => `${item.usage} — ${item.description}`).join('\n')}`)
      return true
    }
    if (command === 'shortcuts') {
      appendSystemMessage('快捷键\nEnter：发送\nShift + Enter：换行\nEsc：关闭上下文侧栏或命令菜单\n↑/↓：选择命令补全\nTab/Enter：补全命令')
      return true
    }
    if (command === 'docs') {
      appendSystemMessage('命令说明\n输入 / 打开命令菜单；/help 查看完整列表。项目会话始终绑定项目目录，工具写入受 workspace 沙箱约束。')
      return true
    }
    appendSystemMessage(`未知命令：/${rawCommand}\n输入 / 可查看可用命令。`, 'error')
    return true
  }

  const sendComposer = () => {
    const input = composer
    const currentAttachments = attachments
    const consumed = runComposerInput(input, currentAttachments)
    if (!consumed) return
    if (input.trim()) {
      const textareaHeight = document.querySelector<HTMLTextAreaElement>('.composer-input textarea')?.getBoundingClientRect().height ?? 54
      composerVanishIdRef.current += 1
      setComposerVanish({ id: composerVanishIdRef.current, text: input, height: Math.ceil(textareaHeight) })
    }
    setComposer('')
    setAttachments([])
    setCommandIndex(0)
    setCommandMenuDismissed(false)
  }

  const switchSessionModel = async (nextModelId: string) => {
    if (isRunning || modelSwitching || nextModelId === model) return
    if (!isModelAvailable(nextModelId, bridgeConfig?.modelAvailability)) {
      addEvent(modelUnavailableMessage(nextModelId, bridgeConfig?.modelAvailability) || `${models[nextModelId]?.label || nextModelId} 当前不可用。`, IconAlertCircle)
      return
    }
    if (!sessionIdRef.current || !sessionReady) {
      newSessionModelRef.current = nextModelId
      preferredModelRef.current = nextModelId
      setModel(nextModelId)
      addEvent(`下一个新会话将使用 ${models[nextModelId]?.label || nextModelId}。`, IconSparkles)
      return
    }
    const previousModel = model
    setModelSwitching(true)
    try {
      await request('session/set_model', { sessionId: sessionIdRef.current, modelId: nextModelId }, 30_000)
      newSessionModelRef.current = nextModelId
      preferredModelRef.current = nextModelId
      setModel(nextModelId)
      addEvent(`当前会话已切换到 ${models[nextModelId]?.label || nextModelId}。`, IconSparkles)
    } catch (error) {
      preferredModelRef.current = previousModel
      setModel(previousModel)
      addEvent(`模型切换失败：${error instanceof Error ? error.message : '未知错误'}`, IconX)
    } finally {
      setModelSwitching(false)
    }
  }

  const changePermissionPreference = async (next: PermissionPreference) => {
    if (permissionSwitching || next === permissionPreferenceRef.current) return
    setPermissionSwitching(true)
    try {
      const label = next === 'manual-current' ? '执行前确认' : '替我执行'
      const socket = socketRef.current
      if (!sessionIdRef.current || !sessionReady || !socket || socket.readyState !== WebSocket.OPEN) {
        deferredPermissionPreferenceRef.current = next
        permissionPreferenceRef.current = next
        setPermissionPreference(next)
        addEvent(`授权策略已选择：${label}；Agent 连接后立即生效。`, IconShieldLock)
        return
      }
      applyPermissionPreference(next)
      addEvent(`授权策略：${label}。`, IconShieldLock)
      if (next === 'approve-running' && pendingPermission) {
        const selected = automaticPermissionOption(pendingPermission.options)
        if (selected) resolvePermission(selected.optionId, 'approve-running')
        else addEvent('当前授权请求没有可用的允许选项，请手动处理；后续请求将按“替我执行”处理。', IconAlertCircle)
      }
    } catch (error) {
      addEvent(`授权策略切换失败：${error instanceof Error ? error.message : '未知错误'}`, IconX)
    } finally {
      setPermissionSwitching(false)
    }
  }

  const switchReasoningEffort = async (next: ReasoningEffort) => {
    if (isRunning || reasoningSwitching || next === reasoningEffort) return
    if (!sessionIdRef.current || !sessionReady) {
      preferredReasoningRef.current = next
      setReasoningEffort(next)
      addEvent(`下一个新会话将使用${next === 'low' ? '低' : next === 'medium' ? '中' : '高'}推理。`, IconBrain)
      return
    }
    const previous = reasoningEffort
    setReasoningSwitching(true)
    try {
      await request('session/set_model', {
        sessionId: sessionIdRef.current,
        modelId: model,
        _meta: { reasoningEffort: next },
      }, 30_000)
      preferredReasoningRef.current = next
      setReasoningEffort(next)
      addEvent(`推理程度已切换为${next === 'low' ? '低' : next === 'medium' ? '中' : '高'}。`, IconBrain)
    } catch (error) {
      preferredReasoningRef.current = previous
      setReasoningEffort(previous)
      addEvent(`推理程度切换失败：${error instanceof Error ? error.message : '当前模型不支持该档位'}`, IconX)
    } finally {
      setReasoningSwitching(false)
    }
  }

  const requestDesktopMicrophonePermission = async () => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      const next = await api.requestMicrophone()
      setDesktopSetup(next)
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '麦克风授权请求失败')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const openDesktopMicrophoneSettings = async () => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      const next = await api.openMicrophoneSettings()
      setDesktopSetup(next)
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '无法打开麦克风系统设置')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const openDesktopScreenRecordingSettings = async () => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      setDesktopSetup(await api.openScreenRecordingSettings())
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '无法打开屏幕录制系统设置')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const requestDesktopAccessibilityPermission = async () => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      setDesktopSetup(await api.requestAccessibility())
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '辅助功能授权请求失败')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const openDesktopFullDiskAccessSettings = async () => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      setDesktopSetup(await api.openFullDiskAccessSettings())
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '无法打开完全磁盘访问系统设置')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const completeDesktopSetup = async (mode: 'granted' | 'limited') => {
    const api = window.grokDesktop
    if (!api || desktopSetupBusy) return
    setDesktopSetupBusy(true)
    setDesktopSetupError('')
    try {
      const next = await api.completeSetup(mode)
      setDesktopSetup(next)
      setDesktopSetupOpened(false)
      setDesktopSetupQueued(false)
      addEvent(mode === 'granted' ? '本机完全访问与可验证的系统权限已完成配置。' : '本机完全访问已启用；系统隐私权限可稍后继续配置。', mode === 'granted' ? IconCircleCheck : IconShieldCheck)
    } catch (error) {
      setDesktopSetupError(error instanceof Error ? error.message : '初始化状态保存失败')
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  const launchActiveGodotProject = async () => {
    const project = projects.find((entry) => entry.id === activeProjectId)
    if (!project) return
    const api = window.grokDesktop
    if (!api) {
      setProjectLaunchState({ projectId: project.id, status: 'failed', error: '请在 RunBuild 桌面版中运行 Godot 项目' })
      return
    }
    setProjectLaunchState({ projectId: project.id, status: 'launching' })
    try {
      const receipt = await api.launchGodotProject(project.id)
      setProjectLaunchState({ projectId: project.id, status: receipt.status, receipt })
      addEvent('Godot 启动请求已交给系统；进程启动不代表画面可用，请查看游戏窗口。', IconScreenShare)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Godot 启动失败'
      setProjectLaunchState({ projectId: project.id, status: 'failed', error: message })
      addEvent(`Godot 系统启动失败：${message}`, IconAlertCircle)
    }
  }

  const confirmActiveGodotProject = async (passed: boolean) => {
    const launch = projectLaunchState
    const taskId = activeConversationIdRef.current
    if (!launch?.receipt || !taskId) {
      if (launch) setProjectLaunchState({ ...launch, status: passed ? 'confirmed' : 'failed', error: passed ? undefined : '用户确认游戏画面不可用' })
      return
    }
    const projectId = projectIdForTask(taskId, activeProjectId)
    try {
      const uiEvent = await enqueueTaskEvent({
        type: 'verification.recorded',
        taskId,
        projectId,
        runId: pendingUiVerificationByTaskRef.current.get(taskId)?.runId ?? null,
        source: 'ui',
        idempotencyKey: `ui:${launch.receipt.launchId}:${passed ? 'passed' : 'failed'}`,
        payload: {
          status: passed ? 'ui_passed' : 'ui_failed',
          kind: 'ui',
          subject: 'Godot game window',
          launchId: launch.receipt.launchId,
        },
      })
      setProjectLaunchState({ ...launch, status: passed ? 'confirmed' : 'failed', error: passed ? undefined : '用户确认游戏画面不可用' })
      const pending = pendingUiVerificationByTaskRef.current.get(taskId)
      if (!pending) {
        addEvent(passed ? '已记录 Godot 游戏画面正常。' : '已记录 Godot 游戏画面不可用。', passed ? IconCircleCheck : IconAlertCircle)
        return
      }
      if (!passed) {
        await enqueueTaskEvent({
          type: 'state.changed',
          taskId,
          projectId: pending.projectId,
          runId: pending.runId,
          source: 'verifier',
          idempotencyKey: `state:${pending.terminalKey}:ui-failed`,
          payload: { state: 'failed', terminalEventId: pending.terminalEventId, reason: 'native-ui-readback-failed' },
        })
        pendingUiVerificationByTaskRef.current.delete(taskId)
        toolReceiptsByRunRef.current.delete(pending.runId)
        addEvent('界面验收未通过，本轮任务没有标记为完成。', IconAlertCircle)
        return
      }
      const uiReadback: ToolReceiptReadback = {
        id: uiEvent.event.eventId,
        status: 'passed',
        kind: 'ui',
        subject: 'Godot game window',
        source: 'runner',
        sourceSequence: uiEvent.event.sequence,
      }
      const verification = createToolReceiptVerifier({
        scopeId: pending.terminalKey,
        checkedAt: uiEvent.event.timestamp,
        toolUpdates: pending.receipts,
        readbacks: [uiReadback],
      })
      if (!verification) {
        await enqueueTaskEvent({
          type: 'state.changed',
          taskId,
          projectId: pending.projectId,
          runId: pending.runId,
          source: 'verifier',
          idempotencyKey: `state:${pending.terminalKey}:ui-confirmed-evidence-incomplete`,
          payload: { state: 'incomplete', terminalEventId: pending.terminalEventId, reason: 'non-ui-evidence-incomplete' },
        })
        addEvent('游戏画面已确认，但本轮仍缺少其他工具收据，未标记为已验证。', IconAlertCircle)
      } else {
        await enqueueTaskEvent({
          type: 'verification.recorded',
          taskId,
          projectId: pending.projectId,
          runId: pending.runId,
          source: 'verifier',
          idempotencyKey: `verification:${pending.terminalKey}:with-ui`,
          payload: {
            status: verification.report.status,
            verifierId: verification.verifier.id,
            evidenceIds: [...verification.verifier.evidenceIds],
            cleanupStatus: verification.cleanup.status,
            cleanupSummary: verification.cleanup.summary,
            changedFileCount: verification.report.changedFiles.files.length,
            commandCount: verification.report.commands.length,
            uiReadbackId: uiReadback.id,
          },
        })
        await enqueueTaskEvent({
          type: 'state.changed',
          taskId,
          projectId: pending.projectId,
          runId: pending.runId,
          source: 'verifier',
          idempotencyKey: `state:${pending.terminalKey}:verified-with-ui`,
          payload: { state: 'verified', terminalEventId: pending.terminalEventId, verifierId: verification.verifier.id },
        })
        addEvent('Godot 实际画面与工具收据均已通过核验。', IconCircleCheck)
      }
      pendingUiVerificationByTaskRef.current.delete(taskId)
      toolReceiptsByRunRef.current.delete(pending.runId)
      await restoreTaskLedgerProjection(taskId)
    } catch (error) {
      addEvent(`界面验收记录失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
    }
  }

  const toggleVoiceInput = async () => {
    if (voiceState === 'listening') {
      speechRecognitionRef.current?.stop()
      return
    }
    const desktopApi = window.grokDesktop
    if (desktopApi) {
      try {
        let setup = await desktopApi.getSetupState()
        if (setup.microphone.state === 'not-determined') setup = await desktopApi.requestMicrophone()
        setDesktopSetup(setup)
        if (setup.microphone.state !== 'granted' && setup.microphone.state !== 'not-required') {
          setDesktopSetupError('')
          setDesktopSetupQueued(true)
          addEvent(setup.microphone.state === 'denied' || setup.microphone.state === 'restricted'
            ? '麦克风未授权；可在系统设置中开启，文字输入不受影响。'
            : '当前无法使用麦克风；文字输入不受影响。', IconAlertCircle)
          return
        }
      } catch (error) {
        setDesktopSetupError(error instanceof Error ? error.message : '无法读取麦克风权限')
        setDesktopSetupQueued(true)
        return
      }
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Recognition) {
      addEvent('当前浏览器不支持语音输入，请使用系统支持的浏览器或桌面版。', IconAlertCircle)
      return
    }
    const recognition = new Recognition()
    speechBaseRef.current = composer.trimEnd()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let finalText = ''
      let interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) finalText += result[0].transcript
        else interimText += result[0].transcript
      }
      if (finalText) speechBaseRef.current = `${speechBaseRef.current}${speechBaseRef.current ? ' ' : ''}${finalText.trim()}`
      setComposer(`${speechBaseRef.current}${interimText ? `${speechBaseRef.current ? ' ' : ''}${interimText}` : ''}`)
    }
    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') addEvent(`语音输入失败：${event.error === 'not-allowed' ? '未获得麦克风权限' : event.error}`, IconAlertCircle)
      setVoiceState('idle')
    }
    recognition.onend = () => {
      speechRecognitionRef.current = null
      setVoiceState('idle')
    }
    speechRecognitionRef.current = recognition
    try {
      recognition.start()
      setVoiceState('listening')
    } catch {
      speechRecognitionRef.current = null
      setVoiceState('idle')
      addEvent('语音输入启动失败，请检查麦克风权限。', IconAlertCircle)
    }
  }
  const openAutomationDialog = (template?: AutomationTemplate) => {
    setAutomationName(template?.name ?? '')
    const schedule = template?.schedule ?? { kind: 'manual' as const }
    setAutomationScheduleKind(schedule.kind)
    setAutomationIntervalMinutes(schedule.kind === 'interval' ? schedule.everyMinutes : 60)
    setAutomationDailyTime(schedule.kind === 'daily'
      ? `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
      : '09:00')
    setAutomationMaxAttempts(2)
    setAutomationMaxWallClockMinutes(45)
    setAutomationInstruction(template?.instruction ?? '')
    setAutomationsError('')
    setAutomationDialogOpened(true)
  }
  const closeAutomationDialog = () => {
    if (automationSaving) return
    setAutomationDialogOpened(false)
  }
  const createAutomation = async () => {
    if (!automationName.trim() || !automationInstruction.trim() || automationSaving) return
    const interval = typeof automationIntervalMinutes === 'number' ? automationIntervalMinutes : Number(automationIntervalMinutes)
    const maxAttempts = typeof automationMaxAttempts === 'number' ? automationMaxAttempts : Number(automationMaxAttempts)
    const maxWallClockMinutes = typeof automationMaxWallClockMinutes === 'number' ? automationMaxWallClockMinutes : Number(automationMaxWallClockMinutes)
    const dailyParts = automationDailyTime.match(/^(\d{2}):(\d{2})$/)
    const schedule: AutomationScheduleView = automationScheduleKind === 'manual'
      ? { kind: 'manual' }
      : automationScheduleKind === 'interval'
        ? { kind: 'interval', everyMinutes: interval }
        : dailyParts
          ? { kind: 'daily', hour: Number(dailyParts[1]), minute: Number(dailyParts[2]) }
          : { kind: 'manual' }
    if ((schedule.kind === 'interval' && (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 1))
      || (automationScheduleKind === 'daily' && !dailyParts)
      || !Number.isInteger(maxAttempts)
      || !Number.isInteger(maxWallClockMinutes)) {
      setAutomationsError('请填写有效的计划和预算。')
      return
    }
    setAutomationSaving(true)
    setAutomationsError('')
    try {
      const response = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: `ui:create:${messageId()}`,
          name: automationName.trim(),
          instruction: automationInstruction.trim(),
          projectId: activeProjectId,
          schedule,
          policy: {
            maxAttempts,
            maxWallClockMinutes,
            permission: 'manual-current',
            tokenBudget: 'unsupported',
          },
        }),
      })
      const payload = await response.json() as { automation?: StoredAutomation; error?: string }
      if (!response.ok || !payload.automation) throw new Error(payload.error || '自动化保存失败')
      await refreshAutomations()
      setAutomationDialogOpened(false)
      addEvent(`已创建自动化：${payload.automation.name}`, IconCircleCheck)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化保存失败')
    } finally {
      setAutomationSaving(false)
    }
  }
  const queueAutomation = async (automation: StoredAutomation) => {
    if (automationActionId) return
    setAutomationActionId(automation.id)
    setAutomationsError('')
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/enqueue`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: `ui:enqueue:${messageId()}` }),
      })
      const payload = await response.json() as { run?: AutomationRunView; error?: string }
      if (!response.ok || !payload.run) throw new Error(payload.error || '自动化入队失败')
      await refreshAutomations()
      addEvent(`已将“${automation.name}”加入审核队列。`, IconClock)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化入队失败')
    } finally {
      setAutomationActionId(null)
    }
  }
  const pauseAutomation = async (automation: StoredAutomation) => {
    if (automationActionId) return
    setAutomationActionId(automation.id)
    setAutomationsError('')
    try {
      const action = automation.enabled ? 'pause' : 'resume'
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: `ui:${action}:${messageId()}` }),
      })
      const payload = await response.json() as { automation?: StoredAutomation; error?: string }
      if (!response.ok || !payload.automation) throw new Error(payload.error || '自动化计划更新失败')
      await refreshAutomations()
      addEvent(`已${automation.enabled ? '暂停' : '恢复'}自动化：${automation.name}`, automation.enabled ? IconClock : IconCircleCheck)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化计划更新失败')
    } finally {
      setAutomationActionId(null)
    }
  }
  const replayAutomationRun = async (run: AutomationRunView) => {
    if (automationActionId) return
    setAutomationActionId(run.id)
    setAutomationsError('')
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}/replay`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: `ui:replay:${messageId()}` }),
      })
      const payload = await response.json() as { run?: AutomationRunView; error?: string }
      if (!response.ok || !payload.run) throw new Error(payload.error || '自动化重放失败')
      await refreshAutomations()
      addEvent('已创建一条新的审核队列，不会复用原任务。', IconRefresh)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化重放失败')
    } finally {
      setAutomationActionId(null)
    }
  }
  const cancelAutomationRun = async (run: AutomationRunView) => {
    if (automationActionId || !window.confirm('取消这条自动化运行？未发送给 Agent 的任务将不会执行。')) return
    setAutomationActionId(run.id)
    setAutomationsError('')
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: `ui:cancel:${messageId()}` }),
      })
      const payload = await response.json() as { run?: AutomationRunView; error?: string }
      if (!response.ok || !payload.run) throw new Error(payload.error || '自动化取消失败')
      await refreshAutomations()
      addEvent('已取消自动化运行。', IconArchive)
    } catch (error) {
      setAutomationsError(error instanceof Error ? error.message : '自动化取消失败')
    } finally {
      setAutomationActionId(null)
    }
  }
  const usePromptInTask = (prompt: string) => {
    setPage('chat')
    setComposer(prompt)
    setCommandMenuDismissed(true)
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer-input textarea')?.focus())
  }
  const useAutomation = (automation: StoredAutomation) => {
    usePromptInTask(automation.instruction)
    addEvent(`已把“${automation.name}”放入当前任务输入框。`, IconPlayerPlay)
  }
  const moveProject = (projectId: string, direction: -1 | 1) => {
    setManualProjectOrder((current) => {
      const order = [...current]
      const index = order.indexOf(projectId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return current
      ;[order[index], order[nextIndex]] = [order[nextIndex], order[index]]
      return order
    })
  }
  const openNewProject = () => {
    if (projectSavingRef.current) return
    setProjectEditingId(null)
    setProjectName('')
    setProjectRootPath('')
    setProjectInstructions('')
    setProjectSaveError('')
    setProjectStep('chooser')
  }
  const openBlankProjectDetails = () => {
    if (projectSavingRef.current) return
    setProjectEditingId(null)
    setProjectName('New project')
    setProjectRootPath('')
    setProjectInstructions('')
    setProjectSaveError('')
    setProjectStep('details')
  }
  const openRenameProject = (project: Project) => {
    if (projectSavingRef.current) return
    setProjectEditingId(project.id)
    setProjectName(project.name)
    setProjectRootPath(project.rootPath)
    setProjectInstructions(project.instructions)
    setProjectSaveError('')
    setProjectStep('details')
  }
  const closeProjectDialog = () => {
    if (projectSavingRef.current) return
    setProjectSaveError('')
    setProjectStep(null)
  }
  const createProject = async () => {
    const name = projectName.trim()
    const importing = projectStep === 'import'
    if ((!importing && !name) || (importing && !projectRootPath.trim()) || projectSavingRef.current) return
    const editingId = projectEditingId
    projectSavingRef.current = true
    setProjectSaving(true)
    setProjectSaveError('')
    try {
      const response = await fetch(editingId ? `/api/projects/${editingId}` : importing ? '/api/projects/import' : '/api/projects', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, rootPath: projectRootPath.trim(), instructions: projectInstructions.trim() }),
      })
      const payload = await response.json() as { project?: Project; error?: string }
      if (!response.ok || !payload.project) throw new Error(payload.error || '项目保存失败')
      const project = payload.project
      setProjects((current) => editingId
        ? current.map((entry) => entry.id === project.id ? project : entry)
        : [...current, project])
      setProjectStep(null)
      setProjectEditingId(null)
      if (editingId) {
        addEvent(`已更新项目：${name}`, IconCircleCheck)
        return
      }
      setActiveProjectId(project.id)
      setPage('chat')
      addEvent(importing ? `已添加项目：${project.name}` : `已创建项目：${project.name}`, IconCircleCheck)
      openTaskHome(project.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目保存失败'
      setProjectSaveError(message)
      addEvent(`项目保存失败：${message}`, IconX)
    } finally {
      projectSavingRef.current = false
      setProjectSaving(false)
    }
  }
  const importPickedProject = async (rootPath: string) => {
    if (!rootPath || projectSavingRef.current) return
    projectSavingRef.current = true
    setProjectSaving(true)
    setProjectSaveError('')
    try {
      const response = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootPath }),
      })
      const payload = await response.json() as { project?: Project; error?: string }
      if (!response.ok || !payload.project) throw new Error(payload.error || '项目添加失败')
      const project = payload.project
      setProjects((current) => [...current, project])
      setProjectStep(null)
      setActiveProjectId(project.id)
      setPage('chat')
      addEvent(`已添加项目：${project.name}`, IconCircleCheck)
      openTaskHome(project.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目添加失败'
      setProjectSaveError(message)
      addEvent(`项目添加失败：${message}`, IconX)
    } finally {
      projectSavingRef.current = false
      setProjectSaving(false)
    }
  }
  const openManualProjectImport = () => {
    setProjectEditingId(null)
    setProjectName('')
    setProjectRootPath('')
    setProjectInstructions('')
    setProjectSaveError('')
    setProjectStep('import')
  }
  const pickExistingProjectDirectory = async () => {
    if (projectSavingRef.current || projectFolderPicking) return
    setProjectFolderPicking(true)
    setProjectSaveError('')
    try {
      const response = await fetch('/api/projects/pick-directory', { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { cancelled?: boolean; error?: string; rootPath?: string }
      if (response.status === 404 || response.status === 501) {
        openManualProjectImport()
        addEvent('当前运行环境不支持系统文件夹选择器，请输入本机项目路径。', IconAlertCircle)
        return
      }
      if (!response.ok) throw new Error(payload.error || '无法打开文件夹选择器')
      if (payload.cancelled || !payload.rootPath) return
      await importPickedProject(payload.rootPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法打开文件夹选择器'
      setProjectSaveError(message)
      addEvent(`文件夹选择失败：${message}`, IconX)
    } finally {
      setProjectFolderPicking(false)
    }
  }
  const bridgeLabel = bridgeState === 'connected' ? 'Bridge 已连接' : bridgeState === 'connecting' ? 'Bridge 连接中' : bridgeState === 'error' ? 'Bridge 连接失败' : 'Bridge 未连接'
  const permissionFullAccess = permissionPreference === 'approve-running'
  const permissionDisplayLabel = permissionFullAccess ? '替我执行' : '执行前确认'
  const reasoningOptions: Array<{ value: ReasoningEffort; label: string; description: string }> = [
    { value: 'low', label: '低', description: '快速处理明确任务，减少推理开销' },
    { value: 'medium', label: '中', description: '平衡速度与复杂问题分析' },
    { value: 'high', label: '高', description: '用于复杂代码、架构与调试任务' },
  ]
  const reasoningLabel = reasoningOptions.find((option) => option.value === reasoningEffort)?.label ?? '高'
  const taskContextProjectId = homeTaskProjectId !== undefined ? homeTaskProjectId : activeProjectId
  const activeProject = projects.find((project) => project.id === taskContextProjectId) ?? null
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null
  const composerPrompts = useMemo(() => {
    if (homeTaskProjectId !== undefined) {
      return activeProject
        ? [
            `描述你想在“${activeProject.name}”中完成的编程任务…`,
            `例如：探索并理解“${activeProject.name}”的代码…`,
            '例如：构建新功能、审查代码或修复问题…',
          ]
        : [
            '描述你想完成的编程任务…',
            '例如：探索并理解代码…',
            '例如：构建新功能、审查代码或修复问题…',
          ]
    }
    if (!sessionReady) {
      return activeProject
        ? [
            '可先输入任务草稿，连接 Agent 后发送…',
            `例如：梳理“${activeProject.name}”里准备处理的改动…`,
            '例如：记录报错、预期结果和需要验证的内容…',
          ]
        : [
            '可先输入任务草稿，连接 Agent 后发送…',
            '例如：描述需求、报错或预期结果…',
            '例如：先记下要做的改动，连接后交给 Agent…',
          ]
    }

    return activeProject
      ? [
          `描述你想在“${activeProject.name}”中完成的编程任务…`,
          `例如：先阅读“${activeProject.name}”的结构，再说明关键模块…`,
          '例如：定位一个问题，给出最小修复和验证方式…',
        ]
      : [
          '描述你的编程任务或问题…',
          '例如：先阅读项目结构，再解释入口和依赖关系…',
          '例如：修复一个报错，并运行相关验证…',
        ]
  }, [activeProject, homeTaskProjectId, sessionReady])
  const showComposerPrompt = composer.length === 0 && !composerVanish
  const composerPrompt = composerPrompts[composerPromptIndex % composerPrompts.length] ?? ''

  useEffect(() => {
    setComposerPromptIndex(0)
  }, [activeProject?.id, sessionReady])

  useEffect(() => {
    if (!showComposerPrompt || composerPrompts.length < 2) return
    const intervalId = window.setInterval(() => {
      setComposerPromptIndex((current) => (current + 1) % composerPrompts.length)
    }, 7000)
    return () => window.clearInterval(intervalId)
  }, [composerPrompts.length, showComposerPrompt])

  const visibleConversations = conversations.filter((session) => !archivedConversationIds.includes(session.id))
  const orderedHistory = orderConversationHistory(conversations, {
    archivedIds: archivedConversationIds,
    pinnedIds: pinnedConversationIds,
    sort: historySort,
  })
  const filteredConversations = orderConversationHistory(conversations, { archivedIds: archivedConversationIds, sort: 'created' })
    .filter((session) => session.title.toLowerCase().includes(searchText.trim().toLowerCase()))
  const orderedProjects = [...projects].sort((left, right) => {
    const leftPinned = pinnedProjectIds.includes(left.id)
    const rightPinned = pinnedProjectIds.includes(right.id)
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    if (projectSort === 'updated') return projectRecentActivity(right, conversations) - projectRecentActivity(left, conversations)
    if (projectSort === 'manual') return manualProjectOrder.indexOf(left.id) - manualProjectOrder.indexOf(right.id)
    return 0
  })
  const projectLifecycleById = useMemo(() => new Map(projectLifecycle.map((entry) => [entry.projectId, entry])), [projectLifecycle])
  const orderedProjectSessions = (projectId: string) => orderConversationHistory(
    visibleConversations.filter((session) => session.projectId === projectId),
    { pinnedIds: pinnedConversationIds, sort: 'priority' },
  )
  const currentModel = availableModels.find((entry) => entry.id === model) ?? {
    id: model,
    label: models[model]?.label || model,
    description: models[model]?.detail || '当前会话模型',
  }
  const selectableModels = filterAvailableModels(availableModels.length ? availableModels : Object.entries(models).map(([id, entry]) => ({
    id,
    label: entry.label,
    description: `${entry.detail} · ${entry.status}`,
  })), bridgeConfig?.modelAvailability)
  const messageAttachments = messages.flatMap((entry) => entry.attachments ?? [])
  const selectedSource = inspectorSelection?.kind === 'source'
    ? activeProject?.sources.find((entry) => entry.id === inspectorSelection.id) ?? null
    : null
  const selectedAttachment = inspectorSelection?.kind === 'attachment'
    ? messageAttachments.find((entry) => entry.id === inspectorSelection.id) ?? null
    : null
  const selectedTool = inspectorSelection?.kind === 'tool'
    ? tools.find((entry) => entry.id === inspectorSelection.id) ?? null
    : null
  const currentTool = selectedTool ?? (isRunning ? tools[0] ?? null : null)
  const selectedProjectFile = inspectorSelection?.kind === 'file'
    ? projectFiles.find((entry) => entry.path === inspectorSelection.id) ?? {
        path: inspectorSelection.id,
        name: inspectorSelection.id.split('/').pop() || inspectorSelection.id,
        kind: projectFileKindFromPath(inspectorSelection.id),
        mimeType: '',
        size: 0,
      }
    : null
  const previewTitle = selectedAttachment?.name || currentTool?.title || projectFilePreview?.name || selectedSource?.name || selectedProjectFile?.name || ''
  const previewPath = projectFilePreview?.path || selectedSource?.relativePath || selectedProjectFile?.path || ''
  const hasPreviewSelection = Boolean(selectedAttachment || currentTool || selectedSource || selectedProjectFile)
  const previewArtifactFormat = projectFilePreview
    ? artifactFormat(projectFilePreview)
    : selectedAttachment
      ? artifactFormat({ path: selectedAttachment.name, mimeType: selectedAttachment.mimeType, kind: selectedAttachment.kind === 'image' ? 'image' : 'text' })
      : selectedSource
        ? artifactFormat({ path: selectedSource.relativePath, mimeType: selectedSource.mimeType, kind: selectedSource.kind })
        : selectedProjectFile
          ? artifactFormat(selectedProjectFile)
          : 'text'
  const previewStatusBadge = currentTool
    ? null
    : projectFilePreviewLoading
      ? { label: '读取中', color: 'gray' }
      : projectFilePreviewError?.state === 'not_created'
        ? { label: isRunning ? '准备中' : '未生成', color: isRunning ? 'teal' : 'gray' }
        : projectFilePreviewError
          ? { label: '预览失败', color: 'red' }
          : projectFilePreview || selectedAttachment
            ? { label: '已就绪', color: 'teal' }
            : null
  const latestBrowserTool = tools.find((tool) => toolWorkspaceContext(tool) === 'browser') ?? null
  const latestTerminalTool = tools.find((tool) => toolWorkspaceContext(tool) === 'terminal') ?? null
  const currentWorkspaceContext: WorkspaceContextKind = selectedAttachment || selectedSource || selectedProjectFile
    ? 'file'
    : toolWorkspaceContext(currentTool)
  const inspectorScopeLabel = activeProject?.name ?? '独立任务'
  const inspectorTaskLabel = activeConversation?.title
    ?? (restoringSession?.kind === 'switch' ? restoringSession.title : '新任务')
  const inspectorContextLabel = `${inspectorScopeLabel} · ${inspectorTaskLabel}`

  const openInspector = (selection?: InspectorSelection, tab?: InspectorTab) => {
    if (selection) {
      if (selection.kind !== inspectorSelection?.kind || selection.id !== inspectorSelection.id) {
        setProjectFilePreview(null)
        setProjectFilePreviewError(null)
        setProjectFilePreviewLoading(false)
      }
      setInspectorSelection(selection)
    }
    setInspectorTab(tab ?? (selection ? 'preview' : inspectorTab))
    setInspectorOpened(true)
  }

  const refreshProjectFilePreview = () => {
    setProjectFilesNonce((value) => value + 1)
    setProjectFilePreviewNonce((value) => value + 1)
  }

  const closeInspector = () => {
    setInspectorOpened(false)
    window.requestAnimationFrame(() => inspectorToggleRef.current?.focus())
  }

  const hasComposerPayload = Boolean(composer.trim() || attachments.length)
  const attachmentsLoading = attachmentLoadCount > 0
  const isTaskHome = homeTaskProjectId !== undefined
  const isSwitchingTask = restoringSession?.kind === 'switch' && !restoringSession.showCachedSnapshot
  const selectedSidebarConversationId = sidebarSelectedConversationId({
    page,
    activeConversationId,
    restoringSession,
    archivedConversationIds,
  })
  const isLandingConversation = shouldShowConversationLanding({
    activeConversationId,
    messageCount: messages.length,
    isRunning,
    isSwitchingTask,
  })
  const activeToolCount = tools.filter((tool) => ['in_progress', 'running', 'pending', 'queued'].includes(toolStatusKey(tool.status))).length
  const inspectorExecutionState = restoringSession
    ? {
        label: restoringSession.kind === 'create' ? '正在创建任务' : '正在恢复任务',
        detail: '任务内容准备完成后会在这里显示真实执行状态。',
        tone: 'loading',
      }
    : isRunning || activeToolCount
      ? {
          label: '正在执行',
          detail: activeToolCount ? `${activeToolCount} 个步骤正在处理` : 'Agent 正在处理当前任务',
          tone: 'running',
        }
      : sessionReady
        ? {
            label: '等待执行',
            detail: '本地 Agent 已连接，可以开始新的任务。',
            tone: 'ready',
          }
        : bridgeState === 'connecting'
          ? {
              label: '正在连接',
              detail: '正在连接当前任务对应的本地 Agent。',
              tone: 'loading',
            }
          : bridgeState === 'error'
            ? {
                label: '连接失败',
                detail: bridgeError || '本地 Agent 暂时不可用。',
                tone: 'error',
              }
            : {
                label: '尚未连接',
                detail: '连接本地 Agent 后可查看真实会话与执行过程。',
                tone: 'offline',
              }
  const InspectorExecutionIcon = inspectorExecutionState.tone === 'running' || inspectorExecutionState.tone === 'loading'
    ? IconLoader2
    : inspectorExecutionState.tone === 'ready'
      ? IconCircleCheck
      : IconAlertCircle
  useEffect(() => {
    if (!inspectorVisible || inspectorTab !== 'activity' || !activeToolCount) return
    const frame = window.requestAnimationFrame(() => activeToolStepRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    }))
    return () => window.cancelAnimationFrame(frame)
  }, [activeToolCount, inspectorTab, inspectorVisible, tools])
  const visibleConversationMessages = useMemo(() => messages.filter((message) => !isInternalProtocolText(message.text)), [messages])
  const conversationTurns = useMemo(() => groupConversationTurns(visibleConversationMessages), [visibleConversationMessages])
  const imageTools = tools.filter((tool) => ['image_gen', 'image_edit'].includes(tool.name ?? '') || /^image_(?:gen|edit)$/i.test(tool.title))
  const lastConversationTurnId = conversationTurns[conversationTurns.length - 1]?.id
  const imageToolForTurn = (turn: (typeof conversationTurns)[number]) => imageTools.find((tool) => turnOwnsGeneratedImage(turn.messages, tool))
    ?? (isRunning && turn.id === lastConversationTurnId
      ? imageTools.find((tool) => {
          const status = toolStatusKey(tool.status)
          return ['pending', 'queued', 'in_progress', 'running'].includes(status)
            && !conversationTurns.some((candidate) => turnOwnsGeneratedImage(candidate.messages, tool))
        })
      : undefined)
  const conversationResourceRoot = activeProject?.rootPath ?? activeConversation?.cwd ?? bridgeConfig?.workspace ?? null
  const openConversationResource = async (reference: ReturnType<typeof conversationResource>) => {
    if (!reference) return
    if (reference.kind === 'web') {
      window.open(reference.href, '_blank', 'noopener,noreferrer')
      return
    }
    if (activeProject && reference.relativePath) {
      openInspector({ kind: 'file', id: reference.relativePath }, 'preview')
      return
    }
    try {
      const api = window.grokDesktop
      if (!api) throw new Error('请在 RunBuild 桌面版中打开本地文件')
      await api.openLocalResource(reference.absolutePath)
    } catch (error) {
      setFeedback({
        id: messageId(),
        time: now(),
        text: error instanceof Error ? error.message : '文件打开失败',
        icon: IconAlertCircle,
        tone: 'error',
      })
    }
  }
  const conversationResourceLink = ({ node, href, children, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
    void node
    const resource = conversationResource(href ?? '', conversationResourceRoot)
    if (resource?.kind === 'web') return <a {...props} className="message-resource-link is-web" href={resource.href} target="_blank" rel="noopener noreferrer">{children}</a>
    if (resource?.kind === 'file') return <button className="message-resource-link is-file" type="button" title={`${resource.absolutePath}${resource.line ? `:${resource.line}` : ''}`} onClick={() => void openConversationResource(resource)}><IconFileCode size={14} aria-hidden="true" /><span>{children}</span></button>
    return <a {...props} href={href}>{children}</a>
  }
  const conversationCode = ({ node, className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown }) => {
    void node
    const value = React.Children.toArray(children).filter((child): child is string | number => typeof child === 'string' || typeof child === 'number').join('').trim()
    const resource = !className && !value.includes('\n') ? conversationResource(value, conversationResourceRoot) : null
    if (resource?.kind === 'file') return <button className="message-resource-link message-file-code" type="button" title={`${resource.absolutePath}${resource.line ? `:${resource.line}` : ''}`} onClick={() => void openConversationResource(resource)}><IconFileCode size={14} aria-hidden="true" /><span>{value}</span></button>
    return <code {...props} className={className}>{children}</code>
  }
  const conversationMarkdownComponents = useMemo<MarkdownComponents>(() => ({
    ...markdownComponents,
    a: createSessionImageLinkComponent(activeConversationId, setImagePreview, { fallback: conversationResourceLink }),
    img: createSessionImageComponent(activeConversationId, setImagePreview),
    code: conversationCode,
  // Resource handlers intentionally track the active task scope and current desktop API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activeConversationId, activeProjectId, conversationResourceRoot])
  const currentModelUnavailable = modelUnavailableMessage(model, bridgeConfig?.modelAvailability)
  const taskHomeBridgePending = isTaskHome && (bridgeState !== 'connected' || bridgeProjectId !== (homeTaskProjectId ?? null))
  const activeReliableTask = isActiveTask(sessionReliability.task)
  const recoveryState = recoveryMessage(sessionReliability)
  const showRecoveryState = recoveryState.code !== 'idle' && recoveryState.code !== 'task_completed' && recoveryState.code !== 'task_failed' && recoveryState.code !== 'task_cancelled'
  const sendDisabled = isRunning || activeReliableTask || attachmentsLoading || !hasComposerPayload || (composerNeedsSession && (Boolean(currentModelUnavailable) || taskHomeBridgePending || (!sessionReady && !isTaskHome)))
  const sendLabel = isRunning || activeReliableTask
    ? '停止当前任务'
    : attachmentsLoading
      ? '正在准备附件'
    : !hasComposerPayload
      ? '输入任务后发送'
      : composerNeedsSession && currentModelUnavailable
        ? currentModelUnavailable
      : composerNeedsSession && taskHomeBridgePending
        ? '连接对应 Agent 后发送'
      : composerNeedsSession && !sessionReady && !isTaskHome
        ? '连接 Agent 后发送'
        : '发送任务'
  const FeedbackIcon = feedback?.icon ?? IconSparkles
  const toggleProjectTasks = (projectId: string) => {
    setExpandedProjectIds((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId])
  }
  const createTaskInProject = (projectId: string) => {
    setExpandedProjectIds((current) => current.includes(projectId) ? current : [...current, projectId])
    openTaskHome(projectId)
  }
  const independentHistory = selectRootHistory(orderedHistory)
  const pageContextLabel = page === 'automations'
    ? '自动化'
    : page === 'skills'
      ? '技能和连接器'
      : page === 'memory'
        ? '记忆'
        : activeProject?.name ?? '任务'
  const pageDetailLabel = page === 'chat' ? activeConversation?.title ?? '新任务' : 'RunBuild 工作区'
  const projectActions = (project: Project) => {
    const pinned = pinnedProjectIds.includes(project.id)
    const projectIndex = orderedProjects.findIndex((entry) => entry.id === project.id)
    const lifecycle = projectLifecycleById.get(project.id)?.state ?? 'active'
    return <Menu position="bottom-end" shadow="md" width={190}>
      <Menu.Target>
        <ActionIcon className="project-actions-trigger" size="sm" variant="subtle" color="gray" aria-label={`${project.name} 更多操作`} title="更多操作">
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconPin size={15} />} onClick={() => setPinnedProjectIds((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id])}>
          {pinned ? '取消置顶项目' : '置顶项目'}
        </Menu.Item>
        <Menu.Item leftSection={<IconPencil size={15} />} onClick={() => openRenameProject(project)}>编辑项目信息</Menu.Item>
        <Menu.Divider />
        {lifecycle === 'active' ? <>
          <Menu.Item leftSection={<IconArchive size={15} />} disabled={isRunning || Boolean(restoringSession)} onClick={() => void changeProjectLifecycle(project.id, 'archive')}>归档项目（保留文件）</Menu.Item>
          <Menu.Item leftSection={<IconFolderOpen size={15} />} disabled={isRunning || Boolean(restoringSession)} onClick={() => void changeProjectLifecycle(project.id, 'detach')}>从工作台脱离（保留文件）</Menu.Item>
        </> : <Menu.Item leftSection={<IconRefresh size={15} />} onClick={() => void changeProjectLifecycle(project.id, 'restore')}>恢复{lifecycle === 'archived' ? '归档项目' : '已脱离项目'}</Menu.Item>}
        {projectSort === 'manual' && <>
          <Menu.Divider />
          <Menu.Item leftSection={<IconArrowUp size={15} />} disabled={projectIndex <= 0} onClick={() => moveProject(project.id, -1)}>向上移动</Menu.Item>
          <Menu.Item leftSection={<IconArrowDown size={15} />} disabled={projectIndex < 0 || projectIndex >= orderedProjects.length - 1} onClick={() => moveProject(project.id, 1)}>向下移动</Menu.Item>
        </>}
      </Menu.Dropdown>
    </Menu>
  }
  const conversationActions = (session: ConversationSnapshot) => {
    const pinned = pinnedConversationIds.includes(session.id)
    const archived = archivedConversationIds.includes(session.id)
    const toggleArchived = async () => {
      if (archived) {
        try {
          await changeTaskWorkspaceLifecycle(session.id, session.projectId, 'restore')
        } catch (error) {
          addEvent(`任务恢复失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
          return
        }
        setArchivedConversationIds((current) => current.filter((id) => id !== session.id))
        void enqueueTaskEvent({
          type: 'task.archived',
          taskId: session.id,
          projectId: session.projectId,
          runId: null,
          source: 'ui',
          idempotencyKey: `task:${session.id}:archive:restored`,
          payload: { archived: false },
        })
        return
      }
      if (session.id === activeConversationId && (isRunning || restoringSession)) {
        addEvent('当前任务仍在运行或恢复中，结束后再归档。', IconAlertCircle)
        return
      }
      try {
        await changeTaskWorkspaceLifecycle(session.id, session.projectId, 'archive')
      } catch (error) {
        addEvent(`任务归档失败：${error instanceof Error ? error.message : '未知错误'}`, IconAlertCircle)
        return
      }
      setArchivedConversationIds((current) => [...new Set([...current, session.id])])
      void enqueueTaskEvent({
        type: 'task.archived',
        taskId: session.id,
        projectId: session.projectId,
        runId: null,
        source: 'ui',
        idempotencyKey: `task:${session.id}:archive:archived`,
        payload: { archived: true },
      })
      if (session.id === activeConversationId) openTaskHome(session.projectId)
    }
    return <>
      <Tooltip label={pinned ? '取消置顶会话' : '置顶会话'}>
        <ActionIcon
          className={`task-action-button ${pinned ? 'is-active' : ''}`}
          size={28}
          variant="subtle"
          color="gray"
          aria-label={`${pinned ? '取消置顶' : '置顶'}：${session.title}`}
          aria-pressed={pinned}
          onClick={() => setPinnedConversationIds((current) => current.includes(session.id) ? current.filter((id) => id !== session.id) : [...current, session.id])}
        >
          <IconPin size={15} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={archived ? '恢复到历史记录' : '归档会话'}>
        <ActionIcon
          className={`task-action-button ${archived ? 'is-active' : ''}`}
          size={28}
          variant="subtle"
          color="gray"
          aria-label={`${archived ? '恢复' : '归档'}：${session.title}`}
          aria-pressed={archived}
          onClick={() => { void toggleArchived() }}
        >
          <IconArchive size={15} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
    </>
  }

  return (
    <MantineProvider forceColorScheme={colorScheme} theme={{
      primaryColor: 'teal',
      fontFamily: 'var(--font-ui)',
      fontFamilyMonospace: 'var(--font-mono)',
      fontSizes: {
        xs: 'var(--type-caption)',
        sm: 'var(--type-label)',
        md: 'var(--type-body)',
        lg: 'var(--type-body-lg)',
        xl: 'var(--type-card-title)',
      },
      lineHeights: {
        xs: 'var(--leading-compact)',
        sm: 'var(--leading-ui)',
        md: 'var(--leading-body)',
        lg: 'var(--leading-body)',
        xl: 'var(--leading-heading)',
      },
      headings: {
        fontFamily: 'var(--font-ui)',
        fontWeight: 'var(--weight-bold)',
        sizes: {
          h1: { fontSize: 'var(--type-page-title)', lineHeight: 'var(--leading-heading)' },
          h2: { fontSize: 'var(--type-dialog-title)', lineHeight: 'var(--leading-heading)' },
          h3: { fontSize: 'var(--type-section-title)', lineHeight: 'var(--leading-heading)' },
          h4: { fontSize: 'var(--type-card-title)', lineHeight: 'var(--leading-heading)' },
          h5: { fontSize: 'var(--type-body-lg)', lineHeight: 'var(--leading-heading)' },
          h6: { fontSize: 'var(--type-body)', lineHeight: 'var(--leading-heading)' },
        },
      },
      defaultRadius: 'md',
      colors: { amber: ['#fff9e8', '#fff1c7', '#fee39a', '#fbd16d', '#f5bd42', '#e7a21c', '#c9860b', '#a66b08', '#85550c', '#6f450c'] },
    }}>
      <AppShell
        header={{ height: 0 }}
        navbar={{ width: sidebarWidth, breakpoint: 'sm' }}
        padding={0}
        style={{ '--sidebar-width': `${sidebarWidth}px`, '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}
      >
        <header className="workbench-topbar" aria-label="工作区控制栏">
          <div className="workbench-topbar-start">
            <Tooltip label={sidebarVisible ? '收起导航侧栏' : '打开导航侧栏'} events={{ hover: true, focus: false, touch: false }}>
              <ActionIcon
                ref={sidebarCollapseRef}
                className="workbench-topbar-toggle"
                variant="subtle"
                color="gray"
                aria-label={sidebarVisible ? '收起导航侧栏' : '打开导航侧栏'}
                aria-expanded={sidebarVisible}
                onClick={() => setSidebarVisibility(!sidebarVisible)}
              >
                {sidebarVisible ? <IconLayoutSidebarLeftCollapse size={20} stroke={1.7} /> : <IconLayoutSidebarLeftExpand size={20} stroke={1.7} />}
              </ActionIcon>
            </Tooltip>
          </div>
          <div className="workbench-topbar-context" aria-live="polite">
            {page === 'chat' ? <IconFolder size={15} stroke={1.7} /> : page === 'automations' ? <IconBolt size={15} stroke={1.7} /> : page === 'memory' ? <IconBrain size={15} stroke={1.7} /> : <IconSparkles size={15} stroke={1.7} />}
            <span className="workbench-context-scope">{pageContextLabel}</span>
            <IconChevronRight className="workbench-context-divider" size={13} stroke={1.7} />
            <span className="workbench-context-detail">{pageDetailLabel}</span>
          </div>
          {page === 'chat' && <div className="workbench-topbar-end">
            <Tooltip label={inspectorVisible ? '收起任务上下文' : tools.length ? `打开任务上下文（${tools.length} 个执行步骤）` : '打开任务上下文'} events={{ hover: true, focus: false, touch: false }}>
              <ActionIcon
                ref={inspectorToggleRef}
                className={`workbench-topbar-toggle inspector-activity-toggle ${activeToolCount ? 'is-running' : tools.length ? 'has-activity' : ''}`}
                variant="subtle"
                color="gray"
                aria-label={inspectorVisible ? '收起任务上下文' : tools.length ? `打开任务上下文，共 ${tools.length} 个执行步骤` : '打开任务上下文'}
                aria-expanded={inspectorVisible}
                onClick={() => inspectorVisible ? closeInspector() : openInspector()}
              >
                {inspectorVisible ? <IconLayoutSidebarRightCollapse size={20} stroke={1.7} /> : <IconLayoutSidebarRightExpand size={20} stroke={1.7} />}
                {!inspectorVisible && tools.length > 0 && <span className="inspector-activity-count" aria-hidden="true">{tools.length > 9 ? '9+' : tools.length}</span>}
              </ActionIcon>
            </Tooltip>
          </div>}
        </header>
        <button ref={sidebarEdgeRef} type="button" className="edge-reveal-zone edge-reveal-left" aria-label="从左侧边缘打开导航侧栏" aria-expanded={sidebarVisible} onMouseEnter={revealSidebarFromEdge} onClick={() => setSidebarVisibility(true)} />
        <SidebarProvider open={sidebarVisible} onOpenChange={setSidebarVisibility} animate={false}>
          <AppShell.Navbar
            className={`grok-sidebar ${sidebarVisible ? 'is-visible' : 'is-hidden'} ${sidebarOpened ? 'is-pinned' : 'is-peeked'}`}
            aria-hidden={!sidebarVisible}
            onMouseEnter={cancelSidebarClose}
            onMouseLeave={scheduleSidebarClose}
            onFocusCapture={() => {
              cancelSidebarClose()
              if (!sidebarOpened) { setSidebarPeeked(false); setSidebarOpened(true) }
            }}
            onPointerDownCapture={() => {
              if (!sidebarOpened) { setSidebarPeeked(false); setSidebarOpened(true) }
            }}
          >
            <DesktopSidebar mode={sidebarOpened ? 'pinned' : 'peek'}>
              <Stack h="100%" gap={0} className="ide-sidebar-stack">
            <Group className="ide-brand" justify="space-between" wrap="nowrap">
              <Group className="ide-brand-lockup" gap={10} wrap="nowrap">
                <img className="grok-mark" src="/grok-build-icon-v5.png" alt="" />
                <Box className="ide-brand-copy"><Text className="ide-brand-name">RunBuild</Text><Text className="ide-brand-subtitle">Coding Workspace</Text></Box>
              </Group>
            </Group>
            <Stack className="ide-sidebar-body" gap={0}>
              <Stack className="primary-navigation" gap={3}>
                <SidebarNavButton className="grok-nav-button new-task-button" icon={<IconPencil size={19} />} aria-label="新建独立任务" title="新建独立任务" onClick={() => openTaskHome(null)}>新建任务</SidebarNavButton>
                <SidebarNavButton className="grok-nav-button sidebar-product-link" icon={<IconBolt size={18} stroke={1.7} />} active={page === 'automations'} aria-current={page === 'automations' ? 'page' : undefined} onClick={() => setPage('automations')}>自动化</SidebarNavButton>
                <SidebarNavButton className="grok-nav-button sidebar-product-link" icon={<IconBrain size={18} stroke={1.7} />} active={page === 'memory'} aria-current={page === 'memory' ? 'page' : undefined} onClick={() => setPage('memory')}>记忆</SidebarNavButton>
                <SidebarNavButton className="grok-nav-button sidebar-product-link" icon={<IconSparkles size={18} stroke={1.7} />} active={page === 'skills'} aria-current={page === 'skills' ? 'page' : undefined} onClick={() => setPage('skills')}>技能和连接器</SidebarNavButton>
              </Stack>
              <Box className="sidebar-collections">
                <SidebarNavButton className="grok-nav-button sidebar-search-row sidebar-collection-search" icon={<IconSearch size={18} />} aria-label="搜索任务" onClick={() => { setSearchText(''); setSearchOpened(true) }}>搜索任务</SidebarNavButton>
                <SidebarGroupHeader
                  controlsId="project-list"
                  expanded={projectsExpanded}
                  icon={<IconFolder size={17} stroke={1.7} />}
                  label="项目"
                  onToggle={() => setProjectsExpanded((value) => !value)}
                  actions={<Group className="project-section-tools" gap={1} wrap="nowrap">
                    <Tooltip label="添加项目"><ActionIcon size="sm" variant="subtle" color="gray" aria-label="添加项目" onClick={openNewProject}><IconPlus size={17} /></ActionIcon></Tooltip>
                    <Menu position="bottom-end" shadow="md" width={190}>
                      <Menu.Target><ActionIcon size="sm" variant="subtle" color="gray" aria-label="项目排序" title="项目排序"><IconDots size={17} /></ActionIcon></Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>排序方式</Menu.Label>
                        <Menu.Item leftSection={projectSort === 'priority' ? <IconCheck size={15} /> : undefined} onClick={() => setProjectSort('priority')}>置顶优先</Menu.Item>
                        <Menu.Item leftSection={projectSort === 'updated' ? <IconCheck size={15} /> : undefined} onClick={() => setProjectSort('updated')}>最近使用</Menu.Item>
                        <Menu.Item leftSection={projectSort === 'manual' ? <IconCheck size={15} /> : undefined} onClick={() => setProjectSort('manual')}>手动排序</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>}
                />
                <Box id="project-list" className="project-tree-list" hidden={!projectsExpanded}>
                  {orderedProjects.length ? orderedProjects.map((project) => {
                    const projectSessions = orderedProjectSessions(project.id)
                    const projectExpanded = expandedProjectIds.includes(project.id)
                    const lifecycle = projectLifecycleById.get(project.id)?.state ?? 'active'
                    return <Box key={project.id} className="project-tree">
                      <Group gap={0} wrap="nowrap" className="project-tree-row project-root-row">
                        <Button className="project-row" classNames={{ inner: 'project-row-inner', label: 'project-row-button-label' }} variant="subtle" color="gray" justify="flex-start" title={`${project.name}\n${project.rootPath}${lifecycle === 'active' ? '' : `\n${lifecycle === 'archived' ? '已归档' : '已脱离'}`}`} aria-expanded={projectExpanded} onClick={() => toggleProjectTasks(project.id)}><span className="project-row-label"><span className="project-row-name">{project.name}</span>{lifecycle !== 'active' && <Badge size="xs" color={lifecycle === 'archived' ? 'gray' : 'orange'} variant="light">{lifecycle === 'archived' ? '已归档' : '已脱离'}</Badge>}<IconChevronDown className={`project-row-chevron ${projectExpanded ? 'is-expanded' : ''}`} size={15} stroke={1.8} aria-hidden="true" /></span></Button>
                        <Group className="project-row-actions" gap={0} wrap="nowrap">
                          <Tooltip label={lifecycle === 'active' ? `在“${project.name}”中新建任务` : '请先在项目菜单中恢复此项目'}><ActionIcon className="project-new-task-trigger" size="sm" variant="subtle" color="gray" aria-label={`在“${project.name}”中新建任务`} disabled={lifecycle !== 'active' || Boolean(restoringSession)} onClick={() => createTaskInProject(project.id)}><IconPencil size={16} /></ActionIcon></Tooltip>
                          {projectActions(project)}
                        </Group>
                      </Group>
                      {projectExpanded && projectSessions.length > 0 && <Box className="project-task-list">{projectSessions.map((session) => <Group key={session.id} gap={0} wrap="nowrap" className={`task-row project-task-row ${session.id === selectedSidebarConversationId ? 'is-active' : ''}`}><Button className="history-row" classNames={{ inner: 'history-row-inner', label: 'history-row-label' }} variant="subtle" color="gray" justify="flex-start" title={session.title} aria-label={`${session.title}，项目：${project.name}`} aria-current={session.id === selectedSidebarConversationId ? 'page' : undefined} onClick={() => void switchConversation(session)}>{session.title}</Button><Group className="task-row-actions" gap={0} wrap="nowrap">{conversationActions(session)}</Group></Group>)}</Box>}
                    </Box>
                  }) : <button type="button" className="sidebar-inline-create is-empty" onClick={openNewProject}><IconFolderPlus size={15} />添加第一个项目</button>}
                </Box>

                <SidebarGroupHeader
                  className="independent-heading"
                  controlsId="independent-task-list"
                  expanded={historyExpanded}
                  icon={<IconMessage size={17} stroke={1.7} />}
                  label="独立任务"
                  onToggle={() => setHistoryExpanded((value) => !value)}
                  actions={<Group className="project-section-tools" gap={1} wrap="nowrap">
                    <Menu position="bottom-end" shadow="md" width={190}>
                      <Menu.Target><ActionIcon size="sm" variant="subtle" color="gray" aria-label="独立任务排序" title="独立任务排序"><IconDots size={17} /></ActionIcon></Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>排序方式</Menu.Label>
                        <Menu.Item leftSection={historySort === 'priority' ? <IconCheck size={15} /> : undefined} onClick={() => setHistorySort('priority')}>置顶优先</Menu.Item>
                        <Menu.Item leftSection={historySort === 'created' ? <IconCheck size={15} /> : undefined} onClick={() => setHistorySort('created')}>最近使用</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>}
                />
                <Box id="independent-task-list" className="general-task-list" hidden={!historyExpanded}>
                  <Box className="history-scroll">{independentHistory.length ? independentHistory.map((session) => <Group key={session.id} gap={0} wrap="nowrap" className={`task-row independent-task-row ${session.id === selectedSidebarConversationId ? 'is-active' : ''}`}><Button className="history-row" classNames={{ inner: 'history-row-inner', label: 'history-row-label' }} variant="subtle" color="gray" justify="flex-start" title={session.title} aria-label={`${session.title}，独立任务`} aria-current={session.id === selectedSidebarConversationId ? 'page' : undefined} onClick={() => void switchConversation(session)}>{session.title}</Button><Group className="task-row-actions" gap={0} wrap="nowrap">{conversationActions(session)}</Group></Group>) : <Text className="history-empty" size="xs">还没有独立任务</Text>}</Box>
                </Box>
              </Box>
            </Stack>
            <Box mt="auto" className="account-row"><Group gap={10} wrap="nowrap"><ThemeIcon radius="xl" size={34} variant="light" color={bridgeState === 'connected' ? 'teal' : 'gray'}><IconTerminal2 size={17} /></ThemeIcon><Box className="account-copy"><Text size="sm" fw="var(--weight-semibold)">本地 Agent</Text><Text size="xs">{bridgeLabel}</Text></Box>{isDesktopRuntime && <Tooltip label="设置与本地诊断"><ActionIcon className="theme-toggle" variant="subtle" color="gray" aria-label="打开设置与本地诊断" onClick={openDiagnostics}><IconSettings size={17} /></ActionIcon></Tooltip>}{isDesktopRuntime && <Tooltip label="权限设置"><ActionIcon className="theme-toggle" variant="subtle" color="gray" aria-label="打开权限设置" onClick={() => window.dispatchEvent(new Event('grok-build:open-permission-setup'))}><IconShieldLock size={17} /></ActionIcon></Tooltip>}{isDesktopRuntime && <Tooltip label={xaiAuthBusy ? '取消 xAI 登录' : '登录或切换 xAI 账号'}><ActionIcon className="theme-toggle" variant="subtle" color="gray" aria-label={xaiAuthBusy ? '取消 xAI 登录' : '登录或切换 xAI 账号'} onClick={() => void (xaiAuthBusy ? cancelXaiLogin() : authenticateXai())}>{xaiAuthBusy ? <IconLoader2 className="spin" size={17} /> : <IconLogin2 size={17} />}</ActionIcon></Tooltip>}<Tooltip label={colorScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}><ActionIcon className="theme-toggle" variant="subtle" color="gray" aria-label={colorScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={toggleColorScheme}>{colorScheme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}</ActionIcon></Tooltip></Group></Box>
              </Stack>
            </DesktopSidebar>
          </AppShell.Navbar>
        </SidebarProvider>
        {sidebarVisible && <button type="button" className="sidebar-backdrop" aria-label="关闭导航侧栏" onClick={() => setSidebarVisibility(false)} />}
        {sidebarOpened && <div className="pane-resizer sidebar-pane-resizer" role="separator" aria-orientation="vertical" aria-label="调整导航侧栏宽度" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={startPaneResize('sidebar')} onKeyDown={resizePaneFromKey('sidebar')} />}

        <AppShell.Main className={`grok-main-shell ${sidebarOpened ? 'sidebar-is-pinned' : ''} ${inspectorVisible ? 'inspector-is-pinned' : ''}`}>
          {page === 'chat' && <div className="workspace-grid">
            <section className={`conversation-stage ${showRecoveryState ? 'has-recovery-state' : ''}`} aria-label="当前 Agent 会话" aria-busy={Boolean(restoringSession)}>
              {showRecoveryState && <Paper className={`recovery-status is-${recoveryState.tone}`} role={recoveryState.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
                <Group className="recovery-status-layout" justify="space-between" align="center" wrap="nowrap">
                  <Group className="recovery-status-copy" gap={9} wrap="nowrap">
                    <ThemeIcon size="sm" radius="xl" color={recoveryState.tone === 'error' ? 'red' : recoveryState.tone === 'warning' ? 'orange' : 'teal'} variant="light">{recoveryState.tone === 'error' || recoveryState.tone === 'warning' ? <IconAlertCircle size={15} /> : <IconRefresh size={15} />}</ThemeIcon>
                    <Box className="recovery-status-text"><Text className="recovery-status-title">任务恢复状态</Text><Text className="recovery-status-detail">{recoveryState.text}</Text></Box>
                  </Group>
                  <Group className="recovery-status-actions" gap={4} wrap="nowrap">{sessionReliability.transport.phase !== 'connected' && <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={13} />} onClick={retryBridgeConnection}>立即重连</Button>}{activeReliableTask && <Button size="compact-xs" color="orange" variant="subtle" leftSection={<IconX size={13} />} onClick={cancelPrompt}>请求停止</Button>}</Group>
                </Group>
              </Paper>}
              {feedback && <Paper className={`interaction-feedback is-${feedback.tone} ${feedback.kind ? `is-${feedback.kind}` : ''}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
                <FeedbackIcon size={17} aria-hidden="true" />
                {feedback.kind === 'bridge-offline' ? <Box className="interaction-feedback-copy">
                  <Text className="interaction-feedback-title">Agent Bridge 未启动</Text>
                  <Text className="interaction-feedback-detail">在项目根目录运行 <code className="interaction-feedback-command">{bridgeStartCommand}</code>，再打开终端显示的地址。</Text>
                </Box> : feedback.kind === 'xai-auth' ? <Box className="interaction-feedback-copy">
                  <Text className="interaction-feedback-title">{xaiAuthBusy ? '正在登录 xAI' : feedback.tone === 'error' ? 'xAI 认证未通过' : 'xAI 认证'}</Text>
                  <Text className="interaction-feedback-detail">{feedback.text}</Text>
                </Box> : <Text size="sm" fw="var(--weight-semibold)">{feedback.text}</Text>}
                {feedback.kind === 'bridge-offline' ? <Group className="interaction-feedback-actions" gap={2} wrap="nowrap">
                  <Button className="interaction-feedback-action" size="compact-xs" variant="subtle" color="gray" leftSection={bridgeCommandCopyState === 'copied' ? <IconCheck size={13} /> : <IconCopy size={13} />} onClick={() => void copyBridgeStartCommand()}>{bridgeCommandCopyState === 'copied' ? '已复制' : bridgeCommandCopyState === 'failed' ? '重试复制' : '复制命令'}</Button>
                  <ActionIcon size="sm" variant="subtle" color="gray" aria-label="关闭错误提示" onClick={() => setFeedback(null)}><IconX size={14} /></ActionIcon>
                </Group> : feedback.kind === 'xai-auth' ? <Group className="interaction-feedback-actions" gap={2} wrap="nowrap">
                  <Button className="interaction-feedback-action" size="compact-xs" variant="subtle" color="gray" leftSection={xaiAuthBusy ? <IconX size={13} /> : <IconLogin2 size={13} />} onClick={() => void (xaiAuthBusy ? cancelXaiLogin() : authenticateXai())}>{xaiAuthBusy ? '取消登录' : '登录 xAI'}</Button>
                  <ActionIcon size="sm" variant="subtle" color="gray" aria-label="关闭认证提示" onClick={() => setFeedback(null)}><IconX size={14} /></ActionIcon>
                </Group> : <ActionIcon size="sm" variant="subtle" color="gray" aria-label="关闭操作提示" onClick={() => setFeedback(null)}><IconX size={14} /></ActionIcon>}
              </Paper>}
              <div className={`conversation-body ${isLandingConversation ? 'is-empty' : 'has-messages'}`}>
              <div className="conversation-flow">
              <ScrollArea className="chat-scroll" type="always" scrollbarSize={4} viewportRef={chatViewportRef} onScrollPositionChange={({ y }) => {
                const viewport = chatViewportRef.current
                if (!viewport) return
                setChatAtBottom(viewport.scrollHeight - viewport.clientHeight - y < 72)
              }}>
                <div className={`chat-thread ${isSwitchingTask ? 'is-switching-task' : ''}`}>
                  {isSwitchingTask ? <TaskSwitchingState title={restoringSession.title} /> : isLandingConversation ? <LandingWelcome projectName={isTaskHome ? activeProject?.name : undefined} /> : <Stack gap={28} className="message-list">{conversationTurns.map((turn, turnIndex) => {
                    const imageTool = imageToolForTurn(turn)
                    const imageStatus = toolStatusKey(imageTool?.status ?? '')
                    const imageSource = imageTool?.media
                      ? sessionImageSource(activeConversationId, `images/${imageTool.media.filename}`)
                      : null
                    const imageAlreadyInReply = Boolean(imageTool?.media && turn.messages.some((message) => (
                      message.role === 'agent' && messagePresentsSessionImage(message.text, imageTool.media?.filename)
                    )))
                    const showImageActivity = Boolean(imageTool && (
                      ['pending', 'queued', 'in_progress', 'running'].includes(imageStatus)
                      || ['failed', 'error', 'cancelled'].includes(imageStatus)
                      || (imageStatus === 'completed' && imageSource && !imageAlreadyInReply)
                    ))
                    return <section key={turn.id} className="conversation-turn" aria-label={`第 ${turnIndex + 1} 轮对话`}>
                      {turn.messages.map((entry) => {
                        const entryImageFilenames = entry.role === 'agent' ? sessionImageFilenamesInMessage(entry.text) : []
                        const entryImageCaption = entryImageFilenames.length && (!imageTool || imageStatus === 'completed')
                          ? <><IconPhoto size={17} aria-hidden="true" /><span>图片生成完成</span></>
                          : undefined
                        const entryImageRenderOptions = {
                          caption: entryImageCaption,
                          captionFilenames: entryImageFilenames,
                          fallback: conversationResourceLink,
                        }
                        const entryMarkdownComponents = entryImageCaption
                          ? {
                              ...conversationMarkdownComponents,
                              a: createSessionImageLinkComponent(activeConversationId, setImagePreview, entryImageRenderOptions),
                              img: createSessionImageComponent(activeConversationId, setImagePreview, entryImageRenderOptions),
                            }
                          : conversationMarkdownComponents
                        return <Box key={entry.id} aria-busy={entry.streaming || undefined} className={`message-row message-${entry.role} ${entry.role === 'system' && entry.tone === 'error' ? 'is-error' : ''}`}>
                        {entry.role === 'agent' ? entry.durationMs ? <button className="message-run-summary" type="button" onClick={() => openInspector(undefined, 'activity')} aria-label={`查看本次处理活动，共耗时 ${formatDuration(entry.durationMs)}`}>
                          <span>已处理 {formatDuration(entry.durationMs)}</span><IconChevronRight size={17} />
                        </button> : <Group className="message-agent-header" gap={8} wrap="nowrap">
                          <ThemeIcon size={26} radius="md" color="teal" variant="light"><IconSparkles size={14} /></ThemeIcon>
                          <Text className="message-agent-name">RunBuild</Text>
                          {entry.streaming && <Text className="message-agent-status">{activeToolCount ? '正在使用工具' : '正在回复'}</Text>}
                        </Group> : entry.role === 'system' ? <Text size="xs" fw="var(--weight-bold)" c="dimmed" className="message-author">系统</Text> : null}
                        {entry.role === 'agent' ? <Box className="message-content message-markdown"><ReactMarkdown components={entryMarkdownComponents} remarkPlugins={[remarkGfm]}>{materializeSessionImageReferences(entry.text || '正在整理回复…')}</ReactMarkdown>{entry.streaming && <span className="typing-caret" />}</Box> : <Text size="sm" className="message-content">{entry.text || '正在生成…'}{entry.streaming && <span className="typing-caret" />}</Text>}
                        {entry.attachments?.length ? <Group gap={8} mt={10} className="message-attachments">{entry.attachments.map((attachment) => attachment.kind === 'image' ? <button className="message-image-button" key={attachment.id} type="button" aria-label={`在预览工作区查看 ${attachment.name}`} onClick={() => openInspector({ kind: 'attachment', id: attachment.id })}><img className="message-image" src={attachment.preview} alt={attachment.name} /></button> : <button key={attachment.id} type="button" className="file-chip" onClick={() => openInspector({ kind: 'attachment', id: attachment.id })}><IconFileText size={16} /><span>{attachment.name}</span></button>)}</Group> : null}
                        {entry.role === 'agent' && !entry.streaming && <div className="message-agent-footer">
                          <Tooltip label="复制回复"><ActionIcon variant="subtle" color="gray" size="sm" aria-label="复制回复" onClick={() => void navigator.clipboard.writeText(entry.text)}><IconCopy size={17} /></ActionIcon></Tooltip>
                          {entry.completedAt && <span>{formatMessageTime(entry.completedAt)}</span>}
                        </div>}
                      </Box>})}
                      {showImageActivity && imageTool && <div className={`image-generation-activity is-${imageStatus}`} aria-live="polite" aria-busy={['pending', 'queued', 'in_progress', 'running'].includes(imageStatus)}>
                        {imageSource && imageStatus === 'completed' ? <span className="message-generated-image-block" role="group" aria-label="生成的图片，图片生成完成">
                          <img className="message-generated-image image-generation-result" src={imageSource} alt="生成的图片" role="button" tabIndex={0} title="双击全屏查看" aria-label="生成的图片，双击全屏查看" onDoubleClick={() => setImagePreview({ src: imageSource, alt: '生成的图片' })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setImagePreview({ src: imageSource, alt: '生成的图片' }) } }} />
                          <span className="message-generated-image-caption" role="status"><IconPhoto size={17} aria-hidden="true" /><span>图片生成完成</span></span>
                        </span> : <>
                          <div className="image-generation-status">
                            {['pending', 'queued', 'in_progress', 'running'].includes(imageStatus) ? <IconLoader2 className="spin" size={19} /> : <IconPhoto size={19} />}
                            <span>{['failed', 'error'].includes(imageStatus) ? '图片生成失败' : imageStatus === 'cancelled' ? '已取消图片生成' : '正在生成图片'}</span>
                          </div>
                          {!['failed', 'error', 'cancelled'].includes(imageStatus) && <div className="image-generation-preview" role="img" aria-label="图片生成中">
                              <div className="image-generation-scales" aria-hidden="true" />
                            </div>}
                        </>}
                      </div>}
                    </section>
                  })}</Stack>}

                  {(pendingPermission || pendingPlan) && <div className="run-activity-stack">
                    <Paper className="approval-card approval-pending" radius="lg" role="status" aria-live="polite">
                      <div className="approval-card-header">
                        <Group className="approval-card-copy" align="flex-start" wrap="nowrap" gap={11}>
                          <ThemeIcon color={approvalCopy.color} variant="light" size={34} radius="md"><IconShieldCheck size={18} /></ThemeIcon>
                          <Box className="approval-card-copy-text"><Text className="approval-card-title" fw="var(--weight-bold)">{approvalCopy.label}</Text><Text className="approval-card-note" size="sm" c="dimmed">{approvalCopy.note}</Text>{pendingPermission && <details className="permission-detail"><summary>查看操作详情</summary><Text component="pre" className="approval-file">{pendingPermission.title.slice(0, 1200) || '等待 Agent 提供操作详情'}</Text></details>}</Box>
                        </Group>
                        {pendingPermission && <Group className="approval-card-actions" gap={8}>{pendingPermission.options.length ? pendingPermission.options.map((option) => { const copy = permissionOptionCopy(option); return <Button key={option.optionId} size="compact-sm" variant={option.kind === 'allow_once' ? 'filled' : 'default'} color={copy.color} radius="md" onClick={() => resolvePermission(option.optionId)}>{copy.label}</Button> }) : <Button size="compact-sm" variant="default" color="gray" radius="md" onClick={() => resolvePermission(null)}>取消</Button>}</Group>}
                        {pendingPlan && <Group className="approval-card-actions" gap={8}><Button size="compact-sm" variant="default" color="gray" radius="md" onClick={() => resolvePlan('abandoned')}>放弃</Button><Button size="compact-sm" variant="default" color="gray" radius="md" onClick={() => resolvePlan('cancelled')}>返回计划</Button><Button size="compact-sm" color="teal" radius="md" onClick={() => resolvePlan('approved')}>批准执行</Button></Group>}
                      </div>
                      {pendingPlan?.content && <Text size="sm" mt={14} className="plan-preview">{pendingPlan.content}</Text>}
                    </Paper>
                  </div>}
                </div>
              </ScrollArea>

              <div className="composer-wrap">
                {pendingQuestion && <div className="question-card-dock">
                  <Paper className="approval-card approval-approved question-card" radius="lg" role="status" aria-label="Agent 正在提问" aria-live="polite">
                    <div className="question-card-body">
                      <Stack className="question-list" gap={0}>{pendingQuestion.questions.map((question, questionIndex) => <Box component="section" className="question-group" key={question.question} aria-labelledby={`agent-question-${questionIndex}`}>
                        <Group className="question-heading" justify="space-between" align="flex-start" wrap="nowrap">
                          <Box>
                            {pendingQuestion.questions.length > 1 && <Text className="question-index" size="xs">问题 {questionIndex + 1}</Text>}
                            <Text id={`agent-question-${questionIndex}`} className="question-title" size="sm" fw="var(--weight-semibold)">{question.question}</Text>
                          </Box>
                          <Badge className="question-mode" size="xs" radius="xl" variant="light" color="gray">{question.multiSelect ? '可多选' : '单选'}</Badge>
                        </Group>
                        <Stack className="question-options" mt={7} gap={6} role={question.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`agent-question-${questionIndex}`}>
                          {question.options.map((option) => {
                            const selected = (questionAnswers[question.question] ?? []).includes(option.label)
                            const OptionIcon = question.multiSelect
                              ? selected ? IconSquareCheck : IconSquare
                              : selected ? IconCircleCheck : IconCircle
                            return <UnstyledButton
                              key={option.label}
                              className={`question-option ${selected ? 'is-selected' : ''}`}
                              role={question.multiSelect ? 'checkbox' : 'radio'}
                              aria-checked={selected}
                              onClick={() => toggleQuestionOption(question, option.label)}
                            >
                              <OptionIcon className="question-option-indicator" size={18} stroke={1.8} aria-hidden="true" />
                              <Box className="question-option-copy">
                                <Text className="question-option-label" size="sm" fw="var(--weight-semibold)">{option.label}</Text>
                                {option.description && <Text className="question-option-description" size="xs" title={option.description}>{option.description}</Text>}
                              </Box>
                            </UnstyledButton>
                          })}
                        </Stack>
                      </Box>)}</Stack>
                      <Divider className="question-card-divider" />
                      <Group className="question-card-footer" justify="space-between" wrap="nowrap">
                        <Text className="question-progress" size="xs">{answeredQuestionCount}/{pendingQuestion.questions.length} 已回答</Text>
                        <Group gap={7} wrap="nowrap"><Button className="question-cancel" size="compact-sm" variant="subtle" color="gray" radius="md" onClick={() => resolveQuestion(false)}>取消</Button><Button className="question-submit" size="compact-sm" color="teal" radius="md" disabled={!questionAnswersComplete} onClick={() => resolveQuestion(true)}>提交给 Agent</Button></Group>
                      </Group>
                    </div>
                  </Paper>
                </div>}
                {messages.length > 0 && !chatAtBottom && <Tooltip label="跳到最新消息"><ActionIcon className="jump-to-latest" variant="default" color="gray" aria-label="跳到最新消息" onClick={() => scrollChatToBottom()}><IconArrowDown size={18} /></ActionIcon></Tooltip>}
                <Paper
                  className={`composer ${hasComposerPayload ? 'has-content' : ''} ${isRunning ? 'is-running' : ''} ${attachmentDragActive ? 'is-dragging' : ''}`}
                  p={10}
                  radius="xl"
                  aria-busy={attachmentsLoading}
                  onDragEnter={handleComposerDragEnter}
                  onDragOver={handleComposerDragOver}
                  onDragLeave={handleComposerDragLeave}
                  onDrop={handleComposerDrop}
                >
                {commandMenuOpen && <Box id="composer-command-menu" className="command-menu" role="listbox" aria-label="命令补全">
                  <Group className="command-menu-header" justify="space-between" wrap="nowrap">
                    <Group gap={9} wrap="nowrap">
                      <ThemeIcon size={30} radius="md" variant="light" color="teal"><IconTerminal2 size={17} /></ThemeIcon>
                      <Box>
                        <Text size="sm" fw="var(--weight-bold)">{commandToken ? `搜索 /${commandToken}` : '快捷命令'}</Text>
                        <Text size="xs" c="dimmed">{commandSuggestions.length} 个结果 · 继续输入可筛选</Text>
                      </Box>
                    </Group>
                    <Group className="command-menu-shortcuts" gap={6} wrap="nowrap" aria-hidden="true">
                      <kbd>↑↓</kbd><Text size="xs" c="dimmed">移动</Text><kbd>↵</kbd><Text size="xs" c="dimmed">选择</Text><kbd>esc</kbd>
                    </Group>
                  </Group>
                  <div className="command-menu-list">
                    {commandSuggestions.length > 0 ? groupedCommandSuggestions.map(([group, commands]) => <section key={group} className="command-group" aria-label={group}>
                      <Text className="command-group-label" size="xs" fw="var(--weight-bold)" c="dimmed">{group}</Text>
                      {commands.map((command) => {
                        const index = commandSuggestions.indexOf(command)
                        const active = selectedCommand?.name === command.name
                        return <Button id={`composer-command-${command.name}`} key={command.name} role="option" aria-selected={active} className="command-option" data-active={active || undefined} variant="subtle" color="dark" justify="space-between" fullWidth onMouseDown={(event) => event.preventDefault()} onClick={() => completeCommand(command)}>
                          <Group className="command-option-main" gap={10} wrap="nowrap">
                            <ThemeIcon size={28} radius="md" variant="light" color={active ? 'teal' : 'gray'}><IconTerminal2 size={15} /></ThemeIcon>
                            <Box className="command-option-copy" ta="left">
                              <Text className="command-option-name" size="sm" fw="var(--weight-semibold)">{command.usage}</Text>
                              <Text className="command-option-description" size="xs" c="dimmed">{command.description}</Text>
                            </Box>
                          </Group>
                          {index === Math.min(commandIndex, commandSuggestions.length - 1) && <Text className="command-option-action" size="xs" c="dimmed">↵ 选择</Text>}
                        </Button>
                      })}
                    </section>) : <div className="command-menu-empty"><IconTerminal2 size={20} /><Box><Text size="sm" fw="var(--weight-semibold)">没有匹配的命令</Text><Text size="xs" c="dimmed">换个关键词，或输入 /help 查看完整说明。</Text></Box></div>}
                  </div>
                </Box>}
                <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.currentTarget.files) void addAttachments(event.currentTarget.files); event.currentTarget.value = '' }} />
                {(attachments.length > 0 || attachmentsLoading) && <div className="composer-attachments" role="list" aria-label={`待发送附件 ${attachments.length} 个`}>
                  {attachments.map((attachment) => <Paper key={attachment.id} className="composer-attachment" data-kind={attachment.kind} p={0} radius="md" role="listitem">
                    {attachment.kind === 'image'
                      ? <img src={attachment.preview} alt={attachment.name} />
                      : <div className="composer-attachment-file"><IconFileText size={21} /><div><Text size="xs" fw="var(--weight-semibold)" lineClamp={2}>{attachment.name}</Text><Text size="xs" c="dimmed">{formatAttachmentSize(attachment.size)} · {attachment.name.split('.').pop()?.toUpperCase() || '文件'}</Text></div></div>}
                    <ActionIcon className="composer-attachment-remove" size="sm" variant="filled" color="dark" aria-label={`移除 ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}><IconX size={15} /></ActionIcon>
                  </Paper>)}
                  {attachmentsLoading && <Paper className="composer-attachment composer-attachment-loading" p={0} radius="md" role="status"><IconLoader2 className="spin" size={21} /><Text size="xs" fw="var(--weight-semibold)">正在准备附件…</Text></Paper>}
                </div>}
                <div
                  className={`composer-input-shell ${showComposerPrompt ? 'is-prompt-active' : ''} ${composerVanish ? 'is-vanishing' : ''}`}
                  style={composerVanish ? { minHeight: composerVanish.height } : undefined}
                >
                  <Textarea
                    value={composer}
                    onChange={(event) => { setComposer(event.currentTarget.value); setCommandIndex(0); setCommandMenuDismissed(false) }}
                    onPaste={handleComposerPaste}
                    onFocus={() => setComposerPromptIndex(0)}
                    onBlur={() => setComposerPromptIndex(0)}
                    onKeyDown={(event) => {
                      if (commandMenuOpen && event.key === 'Escape') { event.preventDefault(); setCommandMenuDismissed(true); return }
                      if (commandMenuOpen && commandSuggestions.length > 0 && event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((value) => (value + 1) % commandSuggestions.length); return }
                      if (commandMenuOpen && commandSuggestions.length > 0 && event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((value) => (value - 1 + commandSuggestions.length) % commandSuggestions.length); return }
                      if (event.key === 'Enter' && event.nativeEvent.isComposing) return
                      if (commandMenuOpen && selectedCommand && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey))) { event.preventDefault(); completeCommand(selectedCommand); return }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        if (!isRunning && !sendDisabled) sendComposer()
                      }
                    }}
                    placeholder={composerPrompt}
                    variant="unstyled"
                    autosize
                    minRows={1}
                    maxRows={4}
                    className="composer-input"
                    aria-label="向编程 Agent 发送任务"
                    aria-controls={commandMenuOpen ? 'composer-command-menu' : undefined}
                  />
                  {showComposerPrompt && <span key={`${activeProject?.id ?? 'global'}-${sessionReady ? 'ready' : 'offline'}-${composerPromptIndex}`} className="composer-prompt" aria-hidden="true">{composerPrompt}</span>}
                  {composerVanish && <ComposerVanishCanvas frame={composerVanish} onComplete={(id) => setComposerVanish((current) => current?.id === id ? null : current)} />}
                  <Tooltip label={sendLabel}><span className="composer-inline-send-wrap"><ActionIcon className="composer-send" variant="filled" color={isRunning ? 'red' : 'teal'} aria-label={sendLabel} disabled={!isRunning && sendDisabled} onClick={isRunning ? cancelPrompt : sendComposer}>{isRunning ? <IconX size={19} /> : <IconArrowUp size={22} stroke={2.1} />}</ActionIcon></span></Tooltip>
                </div>
                <Group justify="space-between" wrap="nowrap" className="composer-toolbar">
                  <Group gap={8} wrap="nowrap" className="composer-toolbar-left">
                    <Tooltip label="添加图片或文件"><ActionIcon className="composer-add" variant="subtle" color="gray" aria-label="添加图片或文件" onClick={() => fileInputRef.current?.click()}><IconPaperclip size={21} /></ActionIcon></Tooltip>
                    <Menu shadow="md" width={180} position="top-start" withArrow>
                      <Menu.Target><Button className={`composer-permission-label ${permissionFullAccess ? 'is-elevated' : ''}`} variant="subtle" color="gray" size="sm" loading={permissionSwitching} leftSection={<IconShieldLock size={19} />}>{permissionDisplayLabel}</Button></Menu.Target>
                      <Menu.Dropdown className="agent-mode-menu" aria-label="选择执行方式"><Menu.Item leftSection={permissionPreference === 'manual-current' ? <IconCheck size={18} /> : <IconShieldCheck size={18} />} onClick={() => void changePermissionPreference('manual-current')}><Text size="sm" fw="var(--weight-bold)">执行前确认</Text></Menu.Item><Menu.Item leftSection={permissionPreference === 'approve-running' ? <IconCheck size={18} /> : <IconShieldLock size={18} />} onClick={() => void changePermissionPreference('approve-running')}><Text size="sm" fw="var(--weight-bold)">替我执行</Text></Menu.Item></Menu.Dropdown>
                    </Menu>
                    <Text className="composer-hint" size="xs" c="dimmed">/ 命令 · Enter 发送 · Shift + Enter 换行</Text>
                  </Group>
                  <Group gap={4} wrap="nowrap" className="composer-controls">
                    <Menu shadow="md" width={300} position="top-end" withArrow><Menu.Target><Button className="composer-model-trigger" variant="subtle" color="gray" size="sm" loading={modelSwitching} disabled={isRunning} rightSection={<IconChevronDown className="mode-chevron" size={13} />}><span>{currentModel.label}</span></Button></Menu.Target><Menu.Dropdown className="agent-mode-menu" aria-label="选择会话模型">{selectableModels.map((option) => <Menu.Item key={option.id} leftSection={option.id === model ? <IconCheck size={18} /> : <IconSparkles size={18} />} onClick={() => void switchSessionModel(option.id)}><Box><Text size="sm" fw="var(--weight-bold)">{option.label}</Text><Text size="xs" c="dimmed">{option.description}</Text></Box></Menu.Item>)}</Menu.Dropdown></Menu>
                    <Menu shadow="md" width={260} position="top-end" withArrow><Menu.Target><Button className="composer-reasoning-trigger" variant="subtle" color="gray" size="sm" loading={reasoningSwitching} disabled={isRunning} rightSection={<IconChevronDown className="mode-chevron" size={14} />}>{reasoningLabel}</Button></Menu.Target><Menu.Dropdown className="agent-mode-menu" aria-label="选择模型推理程度"><Menu.Label>模型推理程度</Menu.Label>{reasoningOptions.map((option) => <Menu.Item key={option.value} leftSection={option.value === reasoningEffort ? <IconCheck size={18} /> : <IconBrain size={18} />} onClick={() => void switchReasoningEffort(option.value)}><Box><Text size="sm" fw="var(--weight-bold)">{option.label}</Text><Text size="xs" c="dimmed">{option.description}</Text></Box></Menu.Item>)}</Menu.Dropdown></Menu>
                    <Tooltip label={voiceState === 'listening' ? '停止语音输入' : '语音输入'}><ActionIcon className={`composer-voice ${voiceState === 'listening' ? 'is-listening' : ''}`} variant="subtle" color="gray" aria-label={voiceState === 'listening' ? '停止语音输入' : '开始语音输入'} aria-pressed={voiceState === 'listening'} onClick={toggleVoiceInput}><IconMicrophone size={21} /></ActionIcon></Tooltip>
                  </Group>
                </Group>
              </Paper></div>
              </div>
              </div>
            </section>
            {inspectorVisible && <button type="button" className="inspector-backdrop" aria-label="关闭上下文侧栏" onClick={closeInspector} />}
            {inspectorVisible && <div className="pane-resizer inspector-pane-resizer" role="separator" aria-orientation="vertical" aria-label="调整右侧工作区宽度" aria-valuemin={INSPECTOR_MIN_WIDTH} aria-valuemax={paneMaxWidth('inspector')} aria-valuenow={inspectorWidth} tabIndex={0} onPointerDown={startPaneResize('inspector')} onKeyDown={resizePaneFromKey('inspector')} />}
            <aside
              ref={inspectorPanelRef}
              className={`context-inspector ${inspectorVisible ? 'is-visible' : 'is-hidden'} is-pinned`}
              aria-label="当前任务上下文"
              aria-hidden={!inspectorVisible}
            >
              <Box className="inspector-header">
                <Group justify="space-between" wrap="nowrap">
                  <Box className="inspector-header-copy">
                    <Text fw="var(--weight-bold)">任务上下文</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>{inspectorContextLabel}</Text>
                  </Box>
                  <Group gap={6} wrap="nowrap">
                    {goalExecution && <Tooltip label={`P2：${goalExecution.completionAccepted ? '已接受独立验证' : `状态 ${goalExecution.state}`} · 独立收据 ${goalExecution.independentVerifierReceiptCount}`}><Badge size="xs" color={goalExecution.completionAccepted ? 'teal' : goalExecution.state === 'blocked' || goalExecution.state === 'failed' ? 'orange' : 'blue'} variant="light">{goalExecution.completionAccepted ? '已验证' : '待验证'}</Badge></Tooltip>}
                    <Tooltip label="收起任务上下文"><ActionIcon className="inspector-close" size="sm" variant="subtle" color="gray" aria-label="收起任务上下文" onClick={closeInspector}><IconX size={16} /></ActionIcon></Tooltip>
                  </Group>
                </Group>
              </Box>
              <AnimatedTabs tabs={inspectorTabs} value={inspectorTab} onValueChange={setInspectorTab} ariaLabel="任务上下文视图" className="preview-tabs" />
              {inspectorTab === 'preview' && <div id="inspector-panel-preview" className="preview-workspace inspector-tab-panel" role="tabpanel" aria-labelledby="inspector-tab-preview">
                {hasPreviewSelection ? <div className="preview-document">
                  <Group className="preview-document-header" justify="space-between" wrap="nowrap">
                    <Group className="preview-document-title" gap={8} wrap="nowrap">
                      {currentTool
                        ? currentWorkspaceContext === 'browser'
                          ? <IconBrowser size={17} />
                          : currentWorkspaceContext === 'terminal'
                            ? <IconTerminal2 size={17} />
                            : <IconListDetails size={17} />
                        : previewArtifactFormat === 'image'
                          ? <IconFiles size={17} />
                          : <IconFileText size={17} />}
                      <Box>
                        <Text size="sm" fw="var(--weight-bold)" lineClamp={1}>{previewTitle}</Text>
                        {previewPath && <Text size="xs" c="dimmed" lineClamp={1}>{previewPath}</Text>}
                      </Box>
                    </Group>
                    <Group className="preview-document-actions" gap={6} wrap="nowrap">
                      {previewStatusBadge && <Badge size="xs" color={previewStatusBadge.color} variant="light">{previewStatusBadge.label}</Badge>}
                      <ActionIcon size="sm" variant="subtle" color="gray" aria-label="关闭当前预览" onClick={() => setInspectorSelection(null)}><IconX size={15} /></ActionIcon>
                    </Group>
                  </Group>
                  <div className={`preview-document-body ${previewArtifactFormat === 'markdown' ? 'is-markdown' : ''} ${projectFilePreviewLoading || projectFilePreviewError ? 'is-state' : ''}`}>
                    {projectFilePreviewLoading && <ArtifactPreviewState
                      state="loading"
                      title="正在准备预览"
                      description="正在读取并整理这份成果。"
                    />}
                    {!projectFilePreviewLoading && projectFilePreviewError?.state === 'not_created' && <ArtifactPreviewState
                      state="not_created"
                      title={isRunning ? '正在准备文档' : projectFilePreviewError.message}
                      description={isRunning ? 'Agent 完成写入后，这里会自动显示内容。' : '这份文档还没有写入项目，可以稍后刷新或查看任务执行情况。'}
                      onRetry={refreshProjectFilePreview}
                      onShowActivity={() => setInspectorTab('activity')}
                    />}
                    {!projectFilePreviewLoading && projectFilePreviewError?.state === 'error' && <ArtifactPreviewState
                      state="error"
                      title={projectFilePreviewError.message}
                      description="文件没有成功读取。你可以重试，或查看本次任务的执行情况。"
                      onRetry={refreshProjectFilePreview}
                      onShowActivity={() => setInspectorTab('activity')}
                    />}
                    {!projectFilePreviewLoading && !projectFilePreviewError && projectFilePreview?.kind === 'image' && <img className="preview-artifact-image" src={projectFilePreview.url} alt={projectFilePreview.name} onError={() => setProjectFilePreviewError(artifactPreviewFailure(500))} />}
                    {!projectFilePreviewLoading && !projectFilePreviewError && projectFilePreview?.kind === 'text' && previewArtifactFormat === 'markdown' && <Box className="preview-markdown message-markdown"><ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{projectFilePreview.text ?? ''}</ReactMarkdown></Box>}
                    {!projectFilePreviewLoading && !projectFilePreviewError && projectFilePreview?.kind === 'text' && previewArtifactFormat !== 'markdown' && <Text component="pre" className="preview-code">{projectFilePreview.text}</Text>}
                    {selectedAttachment?.kind === 'image' && <img className="preview-artifact-image" src={selectedAttachment.preview} alt={selectedAttachment.name} />}
                    {selectedAttachment?.kind === 'text' && previewArtifactFormat === 'markdown' && <Box className="preview-markdown message-markdown"><ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{selectedAttachment.data}</ReactMarkdown></Box>}
                    {selectedAttachment?.kind === 'text' && previewArtifactFormat !== 'markdown' && <Text component="pre" className="preview-code">{selectedAttachment.data}</Text>}
                    {currentTool && <Stack gap={10}><Badge size="sm" color={statusColor(currentTool.status)} variant="light">{statusLabel(currentTool.status)}</Badge><Text component="pre" className="preview-code">{currentTool.detail || '该工具没有返回可展示的文本详情。'}</Text></Stack>}
                  </div>
                </div> : <div className="preview-empty context-choice-empty"><Text fw="var(--weight-bold)">选择要查看的工作区</Text><Text size="sm" c="dimmed">侧栏只会展示当前真实存在的文件、浏览器或终端上下文。</Text><div className="context-choice-grid"><button type="button" className="context-choice" disabled={!activeProject && !messageAttachments.length} onClick={() => setInspectorTab('files')}><IconFileText size={18} /><span>文件</span><small>{activeProject ? activeProject.name : messageAttachments.length ? `${messageAttachments.length} 个附件` : '暂无内容'}</small></button><button type="button" className="context-choice" disabled={!latestBrowserTool} onClick={() => latestBrowserTool && openInspector({ kind: 'tool', id: latestBrowserTool.id }, 'preview')}><IconBrowser size={18} /><span>浏览器</span><small>{latestBrowserTool ? '查看最近活动' : '暂无活动'}</small></button><button type="button" className="context-choice" disabled={!latestTerminalTool} onClick={() => latestTerminalTool && openInspector({ kind: 'tool', id: latestTerminalTool.id }, 'preview')}><IconTerminal2 size={18} /><span>终端</span><small>{latestTerminalTool ? '查看最近命令' : '暂无活动'}</small></button></div></div>}
              </div>}
              {inspectorTab === 'files' && <ScrollArea id="inspector-panel-files" className="inspector-scroll inspector-tab-panel" type="auto" role="tabpanel" aria-labelledby="inspector-tab-files"><Stack gap={18} p="md"><Box><Group justify="space-between" mb={8}><Group gap={7}><IconFolder size={17} /><Text size="sm" fw="var(--weight-bold)">项目文件</Text></Group><Group gap={6}>{projectFilesLoading ? <IconLoader2 className="spin" size={15} /> : <Text size="xs" c="dimmed">{projectFiles.length}</Text>}<Tooltip label="在系统中运行 Godot 项目"><ActionIcon size="sm" variant="subtle" color="teal" aria-label="在系统中运行 Godot 项目" disabled={!activeProject || projectLaunchState?.status === 'launching'} loading={projectLaunchState?.status === 'launching'} onClick={() => void launchActiveGodotProject()}><IconPlayerPlay size={15} /></ActionIcon></Tooltip><Tooltip label="刷新项目文件"><ActionIcon size="sm" variant="subtle" color="gray" aria-label="刷新项目文件" disabled={!activeProject || projectFilesLoading} onClick={() => setProjectFilesNonce((value) => value + 1)}><IconRefresh size={15} /></ActionIcon></Tooltip></Group></Group>{activeProject ? <><Paper className="inspector-scope" p="sm" radius="md" mb="sm"><Text size="sm" fw="var(--weight-semibold)">{activeProject.name}</Text><Text size="xs" c="dimmed" lineClamp={2}>{activeProject.rootPath}</Text></Paper>{projectLaunchState?.projectId === activeProject.id && <Paper withBorder p="sm" radius="md" mb="sm"><Group gap={8} wrap="nowrap">{projectLaunchState.status === 'launching' ? <IconLoader2 className="spin" size={16} /> : projectLaunchState.status === 'confirmed' ? <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" /> : <IconScreenShare size={16} />}<Text size="xs" style={{ flex: 1 }}>{projectLaunchState.status === 'launching' ? '正在交给系统启动…' : projectLaunchState.status === 'awaiting_visual_confirmation' ? '启动请求已发送。请查看真实游戏窗口。' : projectLaunchState.status === 'confirmed' ? '已确认游戏画面正常。' : projectLaunchState.error ?? '游戏画面不可用。'}</Text></Group>{projectLaunchState.status === 'awaiting_visual_confirmation' && <Group gap={6} mt="xs"><Button size="compact-xs" color="teal" onClick={() => void confirmActiveGodotProject(true)}>画面正常</Button><Button size="compact-xs" variant="default" onClick={() => void confirmActiveGodotProject(false)}>启动失败</Button></Group>}</Paper>}{projectFilesError && <Text role="alert" c="red" size="xs">{projectFilesError}</Text>}<Stack gap={3} className="file-browser-list">{projectFiles.map((file) => <button key={file.path} type="button" className={`inspector-row file-browser-row ${file.kind === 'unsupported' ? 'is-disabled' : ''}`} disabled={file.kind === 'unsupported'} onClick={() => openInspector({ kind: 'file', id: file.path }, 'preview')}>{file.kind === 'image' ? <IconFiles size={16} /> : <IconFileText size={16} />}<span>{file.path}</span><Text component="span" size="xs" c="dimmed">{Math.max(1, Math.round(file.size / 1024))}K</Text></button>)}</Stack>{!projectFilesLoading && !projectFilesError && !projectFiles.length && <Text size="xs" c="dimmed">项目中还没有可预览文件。</Text>}</> : <Text size="xs" c="dimmed">选择左侧项目后，这里会显示它的真实文件。</Text>}</Box><Box><Group justify="space-between" mb={8}><Group gap={7}><IconPaperclip size={17} /><Text size="sm" fw="var(--weight-bold)">会话附件</Text></Group><Text size="xs" c="dimmed">{messageAttachments.length}</Text></Group>{messageAttachments.length ? <Stack gap={5}>{messageAttachments.map((attachment) => <button key={attachment.id} type="button" className="inspector-row" onClick={() => openInspector({ kind: 'attachment', id: attachment.id }, 'preview')}>{attachment.kind === 'image' ? <IconFiles size={16} /> : <IconFileText size={16} />}<span>{attachment.name}</span><IconChevronRight size={14} /></button>)}</Stack> : <Text size="xs" c="dimmed">还没有发送附件。</Text>}</Box></Stack></ScrollArea>}
              {inspectorTab === 'activity' && (
                <ScrollArea id="inspector-panel-activity" className="inspector-scroll inspector-tab-panel" type="auto" role="tabpanel" aria-labelledby="inspector-tab-activity">
                  <Stack gap={16} p="md">
                    <Paper className={`inspector-run-summary is-${inspectorExecutionState.tone}`} p="md" radius="md" aria-live="polite">
                      <Group justify="space-between" wrap="nowrap" align="flex-start">
                        <Group gap={10} wrap="nowrap" align="flex-start">
                          <ThemeIcon className="inspector-run-icon" size={34} radius="md" variant="light" color={inspectorExecutionState.tone === 'error' ? 'red' : inspectorExecutionState.tone === 'ready' || inspectorExecutionState.tone === 'running' ? 'teal' : 'gray'}>
                            <InspectorExecutionIcon className={inspectorExecutionState.tone === 'running' || inspectorExecutionState.tone === 'loading' ? 'spin' : undefined} size={18} />
                          </ThemeIcon>
                          <Box className="inspector-run-copy">
                            <Text size="sm" fw="var(--weight-bold)">{inspectorExecutionState.label}</Text>
                            <Text size="xs" c="dimmed">{inspectorExecutionState.detail}</Text>
                          </Box>
                        </Group>
                        {sessionInfoLoading && <IconLoader2 className="spin inspector-summary-loading" size={15} aria-label="正在更新会话信息" />}
                      </Group>

                      <div className="inspector-summary-meta">
                        <div><span>模型</span><strong>{sessionInfo?.modelName ?? currentModel.label}</strong></div>
                        <div><span>权限</span><strong>{permissionDisplayLabel}</strong></div>
                        <div><span>步骤</span><strong>{tools.length}</strong></div>
                      </div>

                      {sessionInfo && <div className="inspector-context-meter">
                        <Group justify="space-between" wrap="nowrap">
                          <Text size="xs" c="dimmed">上下文</Text>
                          <Text size="xs" fw="var(--weight-bold)">{sessionInfo.contextPercent}%</Text>
                        </Group>
                        <Progress value={sessionInfo.contextPercent} color="teal" size="xs" mt={7} aria-label={`上下文已使用 ${sessionInfo.contextPercent}%`} />
                        <Group justify="space-between" mt={7} wrap="nowrap">
                          <Text size="xs" c="dimmed">{sessionInfo.contextUsed.toLocaleString()} / {sessionInfo.contextTotal.toLocaleString()} tokens</Text>
                          <Text size="xs" c="dimmed">{sessionInfo.turns} 轮 · 压缩 {sessionInfo.compactions}</Text>
                        </Group>
                      </div>}
                      {sessionInfoError && <Text className="inspector-summary-error" role="alert" size="xs" c="red">会话信息读取失败：{sessionInfoError}</Text>}
                    </Paper>

                    <section className="inspector-execution-section" aria-labelledby="inspector-execution-heading">
                      <Group className="inspector-section-heading" justify="space-between" wrap="nowrap">
                        <Group gap={7} wrap="nowrap"><IconListDetails size={17} /><Text id="inspector-execution-heading" size="sm" fw="var(--weight-bold)">执行过程</Text></Group>
                        {tools.length > 0 && <Text size="xs" c="dimmed">{activeToolCount ? `${activeToolCount} 个进行中` : `${tools.length} 个步骤`}</Text>}
                      </Group>
                      {tools.length ? <div className="activity-chain" aria-label="当前任务执行过程">{[...tools].reverse().map((tool) => { const copy = toolActivityCopy(tool.title); const context = toolWorkspaceContext(tool); const ToolRowIcon = context === 'terminal' ? IconTerminal2 : context === 'browser' ? IconBrowser : IconTool; const statusKey = toolStatusKey(tool.status); const toolIsRunning = ['in_progress', 'running'].includes(statusKey); const toolIsPending = ['pending', 'queued'].includes(statusKey); const toolIsCompleted = ['completed', 'success'].includes(statusKey); const toolIsFailed = ['failed', 'error', 'cancelled'].includes(statusKey); return <button ref={toolIsRunning || toolIsPending ? activeToolStepRef : undefined} key={tool.id} type="button" className={`inspector-row inspector-tool-row activity-chain-step ${toolIsRunning ? 'is-running' : toolIsCompleted ? 'is-completed' : toolIsFailed ? 'is-failed' : 'is-pending'}`} title={tool.title} aria-label={`${copy.label}，${statusLabel(tool.status)}`} onClick={() => openInspector({ kind: 'tool', id: tool.id }, 'preview')}><span className="activity-chain-marker">{toolIsRunning ? <IconLoader2 className="spin" size={13} /> : toolIsCompleted ? <IconCheck size={13} /> : toolIsFailed ? <IconX size={13} /> : <ToolRowIcon size={12} />}</span><span className="inspector-tool-copy"><span>{copy.label}</span>{copy.detail && <small>{copy.detail}</small>}</span><Badge size="xs" color={statusColor(tool.status)} variant="light">{statusLabel(tool.status)}</Badge></button> })}</div> : <div className="inspector-execution-empty">
                        <ThemeIcon size={36} radius="xl" variant="light" color={inspectorExecutionState.tone === 'offline' || inspectorExecutionState.tone === 'error' ? 'gray' : 'teal'}><IconListDetails size={18} /></ThemeIcon>
                        <Text size="sm" fw="var(--weight-semibold)">{sessionReady ? '还没有执行记录' : '尚未连接本地 Agent'}</Text>
                        <Text size="xs" c="dimmed">{sessionReady ? '发送任务后，工具调用与执行状态会按顺序显示在这里。' : '连接后，这里会显示真实会话、工具调用和执行结果。'}</Text>
                      </div>}
                    </section>

                    {ledgerActivity.length > 0 && <details className="inspector-disclosure">
                      <summary><span className="inspector-disclosure-title"><IconDatabase size={16} />任务记录</span><span className="inspector-disclosure-meta">{ledgerActivity.length}<IconChevronDown size={14} /></span></summary>
                      <div className="inspector-disclosure-body">{ledgerActivity.map((event) => <div className="inspector-record-row" key={event.id}><span>{event.text}</span><Badge size="xs" color={event.tone === 'success' ? 'teal' : event.tone === 'warning' ? 'orange' : event.tone === 'error' ? 'red' : 'gray'} variant="light">{event.time.slice(11, 16)}</Badge></div>)}</div>
                    </details>}

                    {events.length > 0 && <details className="inspector-disclosure">
                      <summary><span className="inspector-disclosure-title"><IconClock size={16} />本地通知</span><span className="inspector-disclosure-meta">{events.length}<IconChevronDown size={14} /></span></summary>
                      <div className="inspector-disclosure-body">{events.slice(0, 10).map((event, index) => { const ActivityIcon = event.icon; return <div className="activity-row" key={`${event.time}-${index}`}><ActivityIcon size={15} /><span>{event.text}</span><time>{event.time}</time></div> })}</div>
                    </details>}
                  </Stack>
                </ScrollArea>
              )}
            </aside>
          </div>}

          {page === 'automations' && <AutomationWorkspace
            automations={automations}
            runs={automationRuns}
            loading={automationsLoading}
            error={automationsError}
            actionId={automationActionId}
            onCreate={openAutomationDialog}
            onUse={useAutomation}
            onQueue={(automation) => void queueAutomation(automation)}
            onStart={(run) => void startAutomationRun(run)}
            onPause={(automation) => void pauseAutomation(automation)}
            onReplay={(run) => void replayAutomationRun(run)}
            onCancel={(run) => void cancelAutomationRun(run)}
          />}
          {page === 'memory' && <MemoryWorkspace projectId={activeProject?.id ?? null} />}
          {page === 'skills' && <SkillsWorkspace tab={catalogTab} search={catalogSearch} bridgeState={bridgeState} projectRunnerEnabled={Boolean(bridgeConfig?.projectRunnerEnabled)} providerRegistry={bridgeConfig?.providerRegistry} providerHealth={bridgeConfig?.providerHealth} onTabChange={setCatalogTab} onSearchChange={setCatalogSearch} onUsePrompt={usePromptInTask} />}

        </AppShell.Main>
      </AppShell>
      <Modal
        opened={diagnosticsOpened}
        onClose={() => { if (!diagnosticsBusy) setDiagnosticsOpened(false) }}
        title="设置与本地诊断"
        size="xl"
        closeOnClickOutside={!diagnosticsBusy}
        closeOnEscape={!diagnosticsBusy}
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box>
              <Text fw="var(--weight-bold)">本机恢复中心</Text>
              <Text size="xs" c="dimmed">只读取本机运行状态；日志在显示前会脱敏，不会上传凭据或任务内容。</Text>
            </Box>
            <Group gap={6} wrap="nowrap">
              <Button size="compact-sm" variant="default" leftSection={<IconRefresh size={14} />} loading={diagnosticsLoading} disabled={diagnosticsBusy} onClick={() => void refreshDiagnostics().catch(() => undefined)}>刷新</Button>
              <Button size="compact-sm" color="orange" variant="light" leftSection={<IconRefresh size={14} />} loading={diagnosticsBusy} disabled={diagnosticsLoading} onClick={() => void restartLocalAgent()}>安全重启 Agent</Button>
            </Group>
          </Group>
          {diagnosticsError && <Text role="alert" c="red" size="sm">{diagnosticsError}</Text>}
          {!diagnosticsSnapshot && !diagnosticsLoading && !diagnosticsError && <Text size="sm" c="dimmed">打开时会读取本机诊断快照。</Text>}
          {diagnosticsSnapshot && <>
            <Paper p="sm" withBorder radius="md">
              <Group justify="space-between" wrap="nowrap"><Box><Text size="sm" fw="var(--weight-semibold)">本地 Agent 运行时</Text><Text size="xs" c="dimmed">{diagnosticsSnapshot.runtime.connected ? 'ACP 连接已建立' : 'ACP 连接未建立'} · {diagnosticsSnapshot.runtime.modelProfile}</Text></Box><Badge color={diagnosticsSnapshot.runtime.connected ? 'teal' : 'orange'} variant="light">{diagnosticsSnapshot.runtime.state}</Badge></Group>
              <Text size="xs" mt={8} c="dimmed">租约：{diagnosticsSnapshot.runtime.lease.status}{diagnosticsSnapshot.runtime.lease.pid ? ` · PID ${diagnosticsSnapshot.runtime.lease.pid}` : ''}{diagnosticsSnapshot.runtime.lease.port ? ` · 端口 ${diagnosticsSnapshot.runtime.lease.port}` : ''}；进程：{diagnosticsSnapshot.runtime.process.status}{diagnosticsSnapshot.runtime.process.pid ? ` · PID ${diagnosticsSnapshot.runtime.process.pid}` : ''}</Text>
              {diagnosticsSnapshot.runtime.error && <Text size="xs" mt={6} c="red">{diagnosticsSnapshot.runtime.error}</Text>}
            </Paper>
            <Box><Text size="sm" fw="var(--weight-bold)" mb={6}>Provider 与连接器</Text><Stack gap={5}>{diagnosticsSnapshot.providers.map((provider) => <Group key={provider.id} justify="space-between" wrap="nowrap"><Text size="sm">{provider.label}</Text><Badge size="sm" color={provider.status === 'ready' ? 'teal' : 'red'} variant="light">{provider.status === 'ready' ? '可用' : provider.reason === 'login-required' ? '需要登录' : '不可用'}</Badge></Group>)}{diagnosticsSnapshot.connectors.map((connector) => <Group key={connector.id} justify="space-between" wrap="nowrap"><Box><Text size="sm">{connector.label}</Text><Text size="xs" c="dimmed">{connector.detail}</Text></Box><Badge size="sm" color={connector.status === 'ready' ? 'teal' : connector.status === 'degraded' ? 'orange' : 'red'} variant="light">{connector.status === 'ready' ? '正常' : connector.status === 'degraded' ? '待检查' : '不可用'}</Badge></Group>)}</Stack></Box>
            <Box><Group justify="space-between" mb={6}><Text size="sm" fw="var(--weight-bold)">存储与本地日志</Text><Button size="compact-xs" variant="subtle" disabled={diagnosticsBusy} onClick={() => void loadDiagnosticsLog()}>查看脱敏日志尾部</Button></Group><Stack gap={4}>{diagnosticsSnapshot.storage.map((entry) => <Paper key={entry.id} p="xs" withBorder radius="sm"><Group justify="space-between" wrap="nowrap"><Box><Text size="xs" fw="var(--weight-semibold)">{entry.label}</Text><Text size="xs" c="dimmed" lineClamp={1}>{entry.path}</Text></Box><Badge size="xs" color={entry.status === 'ready' ? 'teal' : entry.status === 'missing' ? 'orange' : 'red'} variant="light">{entry.status === 'ready' ? '正常' : entry.status === 'missing' ? '缺失' : '不可用'}</Badge></Group></Paper>)}</Stack>{diagnosticsLog && <Paper p="sm" mt={8} withBorder radius="md"><Group justify="space-between" mb={6}><Text size="xs" fw="var(--weight-semibold)">桌面 Agent 日志尾部</Text><Text size="xs" c="dimmed">{diagnosticsLog.status} · 已脱敏 {diagnosticsLog.redactions} 处</Text></Group><Text component="pre" size="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflowY: 'auto', margin: 0 }}>{diagnosticsLog.lines.join('\n') || '暂无可读取的本地日志。'}</Text></Paper>}</Box>
            <Box><Group justify="space-between" mb={6}><Text size="sm" fw="var(--weight-bold)">系统权限（按需）</Text><Button size="compact-xs" variant="subtle" onClick={() => window.dispatchEvent(new Event('grok-build:open-permission-setup'))}>打开权限中心</Button></Group><Text size="xs" c="dimmed" mb={6}>这里只会在你点击某项时请求权限；屏幕录制和完全磁盘访问仍需要你在系统设置中确认。</Text><Stack gap={5}>{diagnosticsSnapshot.permissions.permissions.map((permission) => <Paper key={permission.id} p="xs" withBorder radius="sm"><Group justify="space-between" wrap="nowrap"><Box><Text size="xs" fw="var(--weight-semibold)">{permission.label}</Text><Text size="xs" c="dimmed">{permission.detail}</Text></Box><Group gap={6} wrap="nowrap"><Badge size="xs" color={permission.state === 'granted' ? 'teal' : permission.state === 'not-required' ? 'gray' : 'orange'} variant="light">{permission.state}</Badge><Button size="compact-xs" variant="subtle" disabled={diagnosticsBusy || permission.state === 'granted' || permission.state === 'not-required'} onClick={() => void requestDiagnosticPermission(permission.id)}>{permission.canRequest ? '请求' : permission.canOpenSettings ? '检查' : '状态'}</Button></Group></Group></Paper>)}</Stack></Box>
            {projectLifecycle.length > 0 && <Box><Text size="sm" fw="var(--weight-bold)" mb={6}>项目生命周期</Text><Stack gap={5}>{projectLifecycle.map((lifecycle) => { const project = projects.find((entry) => entry.id === lifecycle.projectId); return <Paper key={lifecycle.projectId} p="xs" withBorder radius="sm"><Group justify="space-between" wrap="nowrap"><Box><Text size="xs" fw="var(--weight-semibold)">{project?.name ?? lifecycle.projectId}</Text><Text size="xs" c="dimmed">{lifecycle.state === 'archived' ? '已归档，真实目录未删除。' : lifecycle.state === 'detached' ? '已从工作台脱离，真实目录未删除。' : '项目可用。'}</Text></Box>{lifecycle.state !== 'active' && <Button size="compact-xs" variant="subtle" onClick={() => void changeProjectLifecycle(lifecycle.projectId, 'restore')}>恢复</Button>}</Group></Paper> })}</Stack></Box>}
          </>}
        </Stack>
      </Modal>
      <DesktopPermissionSetup
        opened={desktopSetupOpened}
        snapshot={desktopSetup}
        busy={desktopSetupBusy}
        error={desktopSetupError}
        onClose={() => {
          if (desktopSetupBusy) return
          setDesktopSetupOpened(false)
          setDesktopSetupQueued(false)
        }}
        onRequestMicrophone={() => { void requestDesktopMicrophonePermission() }}
        onOpenMicrophoneSettings={() => { void openDesktopMicrophoneSettings() }}
        onOpenScreenRecordingSettings={() => { void openDesktopScreenRecordingSettings() }}
        onRequestAccessibility={() => { void requestDesktopAccessibilityPermission() }}
        onOpenFullDiskAccessSettings={() => { void openDesktopFullDiskAccessSettings() }}
        onComplete={() => { void completeDesktopSetup('granted') }}
        onContinueLimited={() => { void completeDesktopSetup('limited') }}
      />
      <Modal
        opened={Boolean(imagePreview)}
        onClose={() => setImagePreview(null)}
        fullScreen
        withCloseButton
        closeOnClickOutside={false}
        closeOnEscape
        trapFocus
        returnFocus
        title="图片预览"
        closeButtonProps={{ 'aria-label': '关闭全屏图片预览' }}
        classNames={{ root: 'image-lightbox', content: 'image-lightbox-content', header: 'image-lightbox-header', body: 'image-lightbox-body' }}
      >
        {imagePreview && <div className="image-lightbox-stage" onClick={() => setImagePreview(null)}>
          <img className="image-lightbox-image" src={imagePreview.src} alt={imagePreview.alt} onClick={(event) => event.stopPropagation()} />
          <Text className="image-lightbox-hint">按 Esc 或点击右上角关闭</Text>
        </div>}
      </Modal>
      <Modal opened={automationDialogOpened} onClose={closeAutomationDialog} centered size="md" withCloseButton={false} classNames={{ content: 'automation-dialog' }}>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap"><Box><Title order={3}>新建自动化</Title><Text size="sm" c="dimmed" mt={4}>计划只会入队；任务创建、发送与工具授权仍由你确认。</Text></Box><ActionIcon variant="subtle" color="gray" aria-label="关闭新建自动化" disabled={automationSaving} onClick={closeAutomationDialog}><IconX size={18} /></ActionIcon></Group>
          <TextInput className="automation-name" value={automationName} onChange={(event) => setAutomationName(event.currentTarget.value)} label="名称" placeholder="例如：每天检查项目状态" autoFocus />
          <Text size="xs" c="dimmed">运行范围：{activeProjectId ? projects.find((project) => project.id === activeProjectId)?.name ?? '当前项目' : '独立任务（无项目 cwd）'}</Text>
          <Select className="automation-trigger" value={automationScheduleKind} onChange={(value) => {
            if (value === 'manual' || value === 'interval' || value === 'daily') setAutomationScheduleKind(value)
          }} label="本机计划" data={[{ value: 'manual', label: '手动入队' }, { value: 'interval', label: '固定间隔' }, { value: 'daily', label: '每天固定时间' }]} />
          {automationScheduleKind === 'interval' && <NumberInput value={automationIntervalMinutes} onChange={(value) => setAutomationIntervalMinutes(typeof value === 'number' ? value : '')} label="间隔（分钟）" min={1} max={10_080} clampBehavior="strict" />}
          {automationScheduleKind === 'daily' && <TextInput type="time" value={automationDailyTime} onChange={(event) => setAutomationDailyTime(event.currentTarget.value)} label="每天本机时间" />}
          <Textarea className="automation-instruction" value={automationInstruction} onChange={(event) => setAutomationInstruction(event.currentTarget.value)} label="指令" placeholder="告诉 Agent 每次需要完成什么…" autosize minRows={6} maxRows={12} />
          <Group grow align="flex-start"><NumberInput value={automationMaxAttempts} onChange={(value) => setAutomationMaxAttempts(typeof value === 'number' ? value : '')} label="最多尝试" description="失败后只再次入队，仍需人工审核。" min={1} max={8} clampBehavior="strict" /><NumberInput value={automationMaxWallClockMinutes} onChange={(value) => setAutomationMaxWallClockMinutes(typeof value === 'number' ? value : '')} label="最长运行（分钟）" description="超时只标记待处理，不会强制终止 Agent。" min={1} max={1_440} clampBehavior="strict" /></Group>
          <Text size="xs" c="dimmed">token/费用预算暂不可由本地控制面可靠强制，当前明确标记为未支持。</Text>
          {automationsError && <Text role="alert" c="red" size="sm">自动化保存失败：{automationsError}</Text>}
          <Group justify="flex-end" mt="sm"><Button variant="default" color="gray" disabled={automationSaving} onClick={closeAutomationDialog}>取消</Button><Button color="teal" loading={automationSaving} disabled={!automationName.trim() || !automationInstruction.trim() || automationSaving} onClick={() => void createAutomation()}>保存</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={projectStep === 'chooser'} onClose={closeProjectDialog} centered size="sm" withCloseButton={false} classNames={{ content: 'project-dialog' }}>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap"><Box><Title order={3}>添加项目</Title><Text size="sm" c="dimmed" mt={4}>项目对应一个真实文件夹，并拥有独立的任务与 Runner。</Text></Box><ActionIcon variant="subtle" color="gray" aria-label="关闭添加项目" disabled={projectSaving || projectFolderPicking} onClick={closeProjectDialog}><IconX size={18} /></ActionIcon></Group>
          <Stack gap={8}>
            <button type="button" className="project-choice-card" disabled={projectSaving || projectFolderPicking} onClick={() => void pickExistingProjectDirectory()}>
              {projectFolderPicking ? <IconLoader2 className="spin" size={21} /> : <IconFolderOpen size={21} />}
              <span><strong>使用现有文件夹</strong><small>选择本机代码目录并添加到 RunBuild</small></span>
              <IconChevronRight size={17} />
            </button>
            <button type="button" className="project-choice-card" disabled={projectSaving || projectFolderPicking} onClick={openBlankProjectDetails}>
              <IconFolderPlus size={21} />
              <span><strong>创建新的工作区</strong><small>先命名，再由 RunBuild 建立项目目录</small></span>
              <IconChevronRight size={17} />
            </button>
          </Stack>
          {projectSaveError && <Text role="alert" c="red" size="sm">项目添加失败：{projectSaveError}</Text>}
        </Stack>
      </Modal>
      <Modal opened={projectStep === 'details'} onClose={closeProjectDialog} centered size="sm" withCloseButton={false} classNames={{ content: 'project-dialog' }}>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap"><Box><Title order={3}>{projectEditingId ? '重命名项目' : '为项目命名'}</Title><Text size="sm" c="dimmed" mt={4}>{projectEditingId ? '更新项目名称与长期指令。' : '保持简短且易识别'}</Text></Box><ActionIcon variant="subtle" color="gray" aria-label="关闭项目编辑" disabled={projectSaving} onClick={closeProjectDialog}><IconX size={18} /></ActionIcon></Group>
          <TextInput ref={projectNameInputRef} value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} label={projectEditingId ? '项目名称' : undefined} aria-label={projectEditingId ? undefined : '项目名称'} placeholder="例如：个人站点" autoFocus />
          {projectEditingId && <Textarea value={projectInstructions} onChange={(event) => setProjectInstructions(event.currentTarget.value)} label="项目指令（可选）" placeholder="技术栈、代码规范或长期约束" autosize minRows={4} />}
          {projectSaveError && <Text role="alert" c="red" size="sm">项目保存失败：{projectSaveError}</Text>}
          <Group justify="flex-end" mt="sm"><Button variant="default" color="gray" disabled={projectSaving} onClick={closeProjectDialog}>取消</Button><Button color="teal" loading={projectSaving} disabled={!projectName.trim() || projectSaving} onClick={() => void createProject()}>保存</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={projectStep === 'import'} onClose={closeProjectDialog} centered size="sm" withCloseButton={false} classNames={{ content: 'project-dialog' }}>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap"><Box><Title order={3}>使用现有文件夹</Title><Text size="sm" c="dimmed" mt={4}>添加时会在该目录创建 <code>.grok</code>，并创建或更新 <code>AGENTS.md</code>。</Text></Box><ActionIcon variant="subtle" color="gray" aria-label="关闭现有文件夹项目" disabled={projectSaving} onClick={closeProjectDialog}><IconX size={18} /></ActionIcon></Group>
          <TextInput value={projectRootPath} onChange={(event) => setProjectRootPath(event.currentTarget.value)} label="文件夹路径" placeholder="/Users/you/Projects/my-app" autoFocus />
          <TextInput value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} label="显示名称（可选）" placeholder="默认使用文件夹名称" />
          <Textarea value={projectInstructions} onChange={(event) => setProjectInstructions(event.currentTarget.value)} label="项目指令（可选）" placeholder="技术栈、代码规范或长期约束" autosize minRows={3} />
          {projectSaveError && <Text role="alert" c="red" size="sm">项目添加失败：{projectSaveError}</Text>}
          <Group justify="space-between" mt="sm"><Button variant="subtle" color="gray" disabled={projectSaving} onClick={() => setProjectStep('chooser')}>上一步</Button><Group gap={8}><Button variant="default" color="gray" disabled={projectSaving} onClick={closeProjectDialog}>取消</Button><Button color="teal" loading={projectSaving} disabled={!projectRootPath.trim() || projectSaving} onClick={() => void createProject()}>添加项目</Button></Group></Group>
        </Stack>
      </Modal>
      <Modal opened={searchOpened} onClose={() => setSearchOpened(false)} withCloseButton={false} centered size="calc(100% - 16vw)" classNames={{ content: 'grok-search-modal', body: 'grok-search-body' }}>
        <TextInput value={searchText} onChange={(event) => setSearchText(event.currentTarget.value)} placeholder="搜索…" variant="unstyled" leftSection={<IconSearch size={20} />} autoFocus className="grok-search-input" />
        <Divider /><div className="search-dialog-grid"><ScrollArea className="search-result-list" type="never"><Text size="sm" c="dimmed" fw="var(--weight-semibold)" mb={8}>最近会话</Text>{filteredConversations.length ? filteredConversations.map((session) => <Button key={session.id} variant="subtle" color="dark" className="search-session" fullWidth justify="space-between" onClick={() => { setSearchOpened(false); void switchConversation(session) }}><Text lineClamp={1}>{session.title}</Text><Text size="xs" c="dimmed">{session.createdAt}</Text></Button>) : <Text size="sm" c="dimmed" p="sm">没有匹配的会话</Text>}</ScrollArea><Box className="search-preview"><Text size="sm" c="dimmed">选择要预览的对话</Text></Box></div>
      </Modal>
    </MantineProvider>
  )
}

const rootElement = document.getElementById('root')!
window.__personalAgentRoot ??= createRoot(rootElement)
window.__personalAgentRoot.render(<DesktopRuntimeGate />)
