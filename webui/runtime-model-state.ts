export type ModelAvailabilityReason = 'login-required' | 'credential-missing'

export type ModelAvailability = {
  id: string
  available: boolean
  reason?: ModelAvailabilityReason
}

export type RuntimeModelChoice = {
  id: string
  label: string
  description: string
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
)

const asText = (value: unknown) => typeof value === 'string' ? value : ''

const availabilityEntry = (modelId: string, availability?: ModelAvailability[]) => (
  availability?.find((entry) => entry.id === modelId)
)

export const isModelAvailable = (modelId: string, availability?: ModelAvailability[]) => (
  availability === undefined || availabilityEntry(modelId, availability)?.available === true
)

export const filterAvailableModels = <T extends RuntimeModelChoice>(
  choices: T[],
  availability?: ModelAvailability[],
) => availability === undefined ? choices : choices.filter((choice) => isModelAvailable(choice.id, availability))

const credentialName = (modelId: string) => {
  if (modelId === 'mimo' || modelId.startsWith('mimo-')) return 'MIMO_API_KEY'
  if (modelId === 'deepseek' || modelId.startsWith('deepseek-')) return 'DEEPSEEK_API_KEY'
  return 'XAI_API_KEY'
}

const modelName = (modelId: string) => {
  if (modelId === 'grok-4.5') return 'Grok 4.5'
  if (modelId === 'mimo' || modelId.startsWith('mimo-')) return 'MiMo'
  if (modelId === 'deepseek' || modelId.startsWith('deepseek-')) return 'DeepSeek V4 Pro'
  return modelId || '当前模型'
}

export function modelUnavailableMessage(modelId: string, availability?: ModelAvailability[]) {
  const entry = availabilityEntry(modelId, availability)
  if (!entry || entry.available) return ''
  if (entry.reason === 'login-required') return `请先登录 xAI 以使用 ${modelName(modelId)}。`
  if (entry.reason === 'credential-missing') return `${credentialName(modelId)} 未配置。`
  return `${modelName(modelId)} 当前不可用。`
}

export function resolveAvailableModel(
  requestedModelId: string,
  defaultModelId: string,
  availability?: ModelAvailability[],
): { modelId: string | null; fellBack: boolean; error?: string } {
  const requested = requestedModelId || defaultModelId
  if (isModelAvailable(requested, availability)) return { modelId: requested, fellBack: false }
  if (requested !== defaultModelId && isModelAvailable(defaultModelId, availability)) {
    return { modelId: defaultModelId, fellBack: true }
  }
  return {
    modelId: null,
    fellBack: false,
    error: modelUnavailableMessage(defaultModelId, availability) || `${modelName(defaultModelId)} 当前不可用。`,
  }
}

const providerKeyFrom = (message: string) => (
  message.match(/\b(?:XAI_API_KEY|MIMO_API_KEY|DEEPSEEK_API_KEY)\b/)?.[0] ?? ''
)

const missingNamedCredential = (message: string) => /(?:not configured|missing|未配置|缺少)/i.test(message)

const missingGenericCredential = (message: string) => (
  /(?:credential(?:s)?\s+(?:is\s+)?missing|missing\s+credential|模型凭据未配置|缺少.*凭据)/i.test(message)
)

const httpStatusFrom = (data: JsonRecord, message: string) => {
  const raw = data.http_status ?? data.httpStatus
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (numeric === 401 || numeric === 403) return numeric
  const match = message.match(/(?:http[_\s-]?status|status)[^0-9]{0,12}(401|403)\b|\((401|403)\)/i)
  return match ? Number(match[1] ?? match[2]) : null
}

export function formatJsonRpcProviderError(value: unknown) {
  const error = asRecord(value)
  const data = asRecord(error.data)
  const message = asText(error.message)
  const safeDetail = asText(data.message)
  const searchable = `${message}\n${safeDetail}`
  const providerKey = providerKeyFrom(searchable)

  if ((providerKey && missingNamedCredential(searchable)) || missingGenericCredential(searchable)) {
    return providerKey ? `${providerKey} 未配置` : '模型凭据未配置'
  }

  const httpStatus = httpStatusFrom(data, searchable)
  if (httpStatus === 401) return '模型凭据无效或已过期'
  if (httpStatus === 403) return '当前账号无模型访问权限'

  if (message && !/^Internal error\b/i.test(message)) return message
  return 'Agent 请求失败'
}
