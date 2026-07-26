import type { TaskEvent } from './task-event-ledger.ts'

export type TaskActivityTone = 'info' | 'success' | 'warning' | 'error'

export type TaskActivityProjection = {
  id: string
  sequence: number
  time: string
  tone: TaskActivityTone
  text: string
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : {}

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const label = (value: unknown, fallback: string) => {
  const text = asText(value)
  return text ? text.slice(0, 160) : fallback
}

const stateCopy = (state: string) => ({
  verified: { tone: 'success' as const, text: '编码结果已通过验证。' },
  incomplete: { tone: 'warning' as const, text: '编码结果缺少完整验证收据。' },
  awaiting_visual_confirmation: { tone: 'warning' as const, text: '原生应用已启动，等待实际界面确认。' },
  response_complete: { tone: 'info' as const, text: 'Agent 已完成回复，未执行可验证编码操作。' },
  failed: { tone: 'error' as const, text: '本轮任务失败。' },
  cancelled: { tone: 'warning' as const, text: '本轮任务已取消。' },
  timed_out: { tone: 'warning' as const, text: '本轮等待超时，正在等待恢复或人工处理。' },
  reconnecting: { tone: 'warning' as const, text: '正在恢复 Agent 连接。' },
  recovered: { tone: 'success' as const, text: 'Agent 连接已恢复。' },
}[state] ?? { tone: 'info' as const, text: `任务状态：${label(state, 'unknown')}` })

const eventCopy = (event: TaskEvent): Omit<TaskActivityProjection, 'id' | 'sequence' | 'time'> | null => {
  const payload = asRecord(event.payload)
  switch (event.type) {
    case 'task.created': return { tone: 'info', text: '已创建任务。' }
    case 'task.loaded': return { tone: 'info', text: '已恢复任务会话。' }
    case 'task.archived': return payload.archived === true
      ? { tone: 'info', text: '任务已归档。' }
      : { tone: 'success', text: '任务已从归档恢复。' }
    case 'run.started': return { tone: 'info', text: '已开始新的 Agent 回合。' }
    case 'run.completed': return { tone: 'info', text: 'Agent 已返回终态，正在核验结果。' }
    case 'run.failed': return { tone: 'error', text: 'Agent 回合失败。' }
    case 'run.cancelled': return { tone: 'warning', text: 'Agent 回合已取消。' }
    case 'cancel.requested': return { tone: 'warning', text: '已请求停止当前回合。' }
    case 'state.changed': {
      const state = asText(payload.state)
      return state ? stateCopy(state) : { tone: 'info', text: '会话配置已更新。' }
    }
    case 'tool.requested': return { tone: 'info', text: `工具已请求：${label(payload.title ?? payload.toolCallId, 'Agent 工具操作')}` }
    case 'tool.updated': {
      const status = label(payload.status, '已更新')
      const tone: TaskActivityTone = /failed|error|cancelled/i.test(status)
        ? 'error'
        : /completed|success/i.test(status) ? 'success' : 'info'
      return { tone, text: `工具${status}：${label(payload.title ?? payload.toolCallId, 'Agent 工具操作')}` }
    }
    case 'permission.requested': return { tone: 'warning', text: `等待授权：${label(payload.action ?? payload.title, 'Agent 工具操作')}` }
    case 'permission.resolved': return {
      tone: asText(payload.decision) === 'approved' ? 'success' : 'warning',
      text: `授权${asText(payload.decision) === 'approved' ? '已批准' : '未批准'}：${label(payload.action, 'Agent 工具操作')}`,
    }
    case 'checkpoint.created': return { tone: 'success', text: '已创建可恢复检查点。' }
    case 'context.condensed': return { tone: 'info', text: '已压缩会话上下文。' }
    case 'memory.context.prepared': return payload.injected === true
      ? { tone: 'info', text: '已确定本轮可检查记忆，等待发送确认。' }
      : { tone: 'info', text: '本轮未注入可检查记忆。' }
    case 'memory.context.dispatched': return payload.injected === true
      ? { tone: 'success', text: '可检查记忆已随本轮请求发送。' }
      : { tone: 'info', text: '本轮请求未使用可检查记忆。' }
    case 'memory.proposed': return { tone: 'info', text: '已提出一条待确认记忆。' }
    case 'memory.committed': return { tone: 'success', text: '已提交一条来源可追溯的记忆。' }
    case 'verification.recorded': return ['verified', 'ui_passed'].includes(asText(payload.status))
      ? { tone: 'success', text: asText(payload.status) === 'ui_passed' ? '实际界面观察已确认。' : '验证记录已保存。' }
      : { tone: 'warning', text: '验证记录未达到通过状态。' }
    // User/agent message chunks can contain private task content. They remain
    // in the ACP conversation projection and are intentionally not copied into
    // the global activity view.
    case 'message.user.created':
    case 'message.agent.delta':
    case 'message.agent.completed':
      return null
  }
}

/**
 * Build an inspectable task activity slice from durable ledger facts only.
 * It deliberately uses a closed payload allowlist so raw prompts, tool output,
 * binary attachment content, and credentials never leak into the activity UI.
 */
export function projectTaskActivity(events: readonly TaskEvent[], limit = 24): TaskActivityProjection[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 24
  return events
    .flatMap((event) => {
      const copy = eventCopy(event)
      return copy ? [{ id: event.eventId, sequence: event.sequence, time: event.timestamp, ...copy }] : []
    })
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, boundedLimit)
}
