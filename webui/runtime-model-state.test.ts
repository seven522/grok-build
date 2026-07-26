import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterAvailableModels,
  formatJsonRpcProviderError,
  modelUnavailableMessage,
  resolveAvailableModel,
} from './runtime-model-state.ts'

const choices = [
  { id: 'grok-4.5', label: 'Grok 4.5', description: 'grok-4.5' },
  { id: 'mimo', label: 'MiMo', description: 'mimo-v2.5-pro' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'deepseek-v4-pro' },
]

test('desktop availability filters the model menu while missing availability keeps web compatibility', () => {
  assert.deepEqual(filterAvailableModels(choices, undefined), choices)
  assert.deepEqual(filterAvailableModels(choices, [
    { id: 'grok-4.5', available: true },
    { id: 'mimo', available: false, reason: 'credential-missing' },
    { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
  ]), [choices[0]])
})

test('an unavailable restored model falls back to the available default', () => {
  assert.deepEqual(resolveAvailableModel('deepseek-v4-pro', 'grok-4.5', [
    { id: 'grok-4.5', available: true },
    { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
  ]), {
    modelId: 'grok-4.5',
    fellBack: true,
  })
})

test('an unavailable default blocks model use with a concise reason', () => {
  const availability = [
    { id: 'grok-4.5', available: false, reason: 'login-required' as const },
    { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' as const },
  ]
  assert.deepEqual(resolveAvailableModel('deepseek-v4-pro', 'grok-4.5', availability), {
    modelId: null,
    fellBack: false,
    error: '请先登录 xAI 以使用 Grok 4.5。',
  })
  assert.equal(modelUnavailableMessage('deepseek-v4-pro', availability), 'DEEPSEEK_API_KEY 未配置。')
})

test('provider errors expose useful 401, 403, and missing credential messages', () => {
  assert.equal(formatJsonRpcProviderError({
    message: 'Internal error',
    data: { message: 'request rejected', http_status: 401, stack: 'do not expose' },
  }), '模型凭据无效或已过期')
  assert.equal(formatJsonRpcProviderError({
    message: 'Internal error',
    data: { message: 'account cannot access this model', http_status: 403, token: 'do not expose' },
  }), '当前账号无模型访问权限')
  assert.equal(formatJsonRpcProviderError({
    message: 'Internal error',
    data: { message: 'DEEPSEEK_API_KEY is not configured', api_key_prefix: 'do not expose' },
  }), 'DEEPSEEK_API_KEY 未配置')
})

test('provider error formatting never renders raw internal JSON or stack data', () => {
  assert.equal(formatJsonRpcProviderError({
    message: 'Internal error: {"message":"denied","http_status":403,"token":"secret"}',
    data: { stack: 'sensitive stack', prefix: 'sensitive prefix' },
  }), '当前账号无模型访问权限')
  assert.equal(formatJsonRpcProviderError({ message: '普通 ACP 错误', data: { stack: 'secret' } }), '普通 ACP 错误')
  assert.equal(formatJsonRpcProviderError({ message: '文件第 403 行解析失败' }), '文件第 403 行解析失败')
  assert.equal(formatJsonRpcProviderError({ message: 'MCP server is not configured' }), 'MCP server is not configured')
  assert.equal(formatJsonRpcProviderError({
    message: 'Internal error',
    data: { message: 'unknown provider payload with sensitive detail', prefix: 'secret' },
  }), 'Agent 请求失败')
  assert.equal(formatJsonRpcProviderError({ message: 'Internal error', data: { stack: 'secret' } }), 'Agent 请求失败')
})
