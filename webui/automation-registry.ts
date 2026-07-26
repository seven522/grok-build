import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type StoredAutomation = {
  id: string
  name: string
  trigger: string
  instruction: string
  createdAt: string
  updatedAt: string
}

type AutomationInput = { name?: unknown; trigger?: unknown; instruction?: unknown }

async function readJsonBody(request: IncomingMessage): Promise<AutomationInput> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 256 * 1024) throw new Error('请求内容超过 256KB')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容必须是 JSON 对象')
  return value as AutomationInput
}

export function createAutomationRegistry(statePathInput: string) {
  const statePath = path.resolve(statePathInput)
  let mutationQueue: Promise<void> = Promise.resolve()
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const list = async (): Promise<StoredAutomation[]> => {
    try {
      const value = JSON.parse(await readFile(statePath, 'utf8')) as unknown
      return Array.isArray(value) ? value as StoredAutomation[] : []
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') return []
      throw error
    }
  }
  const persist = async (items: StoredAutomation[]) => {
    await mkdir(path.dirname(statePath), { recursive: true })
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, statePath)
  }
  const create = (input: AutomationInput): Promise<StoredAutomation> => serializeMutation(async () => {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : ''
    const trigger = typeof input.trigger === 'string' ? input.trigger.trim().slice(0, 500) : ''
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim().slice(0, 20_000) : ''
    if (!name || !instruction) throw new Error('名称和指令不能为空')
    const timestamp = new Date().toISOString()
    const automation = { id: randomUUID(), name, trigger: trigger || '手动运行', instruction, createdAt: timestamp, updatedAt: timestamp }
    await persist([...(await list()), automation])
    return automation
  })
  const remove = (id: string): Promise<boolean> => serializeMutation(async () => {
    const current = await list()
    const next = current.filter((item) => item.id !== id)
    if (next.length === current.length) return false
    await persist(next)
    return true
  })
  return { list, create, remove, statePath }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export function automationRegistryMiddleware(registry: ReturnType<typeof createAutomationRegistry>) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/automations' && request.method === 'GET') {
      try { sendJson(response, 200, { automations: await registry.list() }) } catch (error) { next(error) }
      return
    }
    if (url.pathname === '/api/automations' && request.method === 'POST') {
      try { sendJson(response, 201, { automation: await registry.create(await readJsonBody(request)) }) }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '无法保存自动化' }) }
      return
    }
    const match = url.pathname.match(/^\/api\/automations\/([0-9a-f-]+)$/i)
    if (match && request.method === 'DELETE') {
      try {
        const removed = await registry.remove(match[1])
        sendJson(response, removed ? 200 : 404, removed ? { removed: true } : { error: '自动化不存在' })
      } catch (error) { next(error) }
      return
    }
    next()
  }
}
