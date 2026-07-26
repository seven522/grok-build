import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactFormat, artifactPreviewFailure } from './src/features/inspector/artifact-preview.ts'

test('recognizes Markdown artifacts by MIME type or file extension', () => {
  assert.equal(artifactFormat({ path: 'docs/plan.md', kind: 'text' }), 'markdown')
  assert.equal(artifactFormat({ path: 'docs/PLAN.MARKDOWN', kind: 'text' }), 'markdown')
  assert.equal(artifactFormat({ path: 'docs/plan.txt', mimeType: 'text/markdown; charset=utf-8', kind: 'text' }), 'markdown')
  assert.equal(artifactFormat({ path: 'notes.txt', kind: 'text' }), 'text')
  assert.equal(artifactFormat({ path: 'preview.png', kind: 'image' }), 'image')
})

test('maps only the structured not-found response to the planned artifact state', () => {
  assert.deepEqual(artifactPreviewFailure(404, 'file_not_found'), {
    state: 'not_created',
    message: '文件尚未生成',
  })
  assert.deepEqual(artifactPreviewFailure(404, 'different_error'), {
    state: 'error',
    message: '暂时无法预览此文件',
  })
  assert.deepEqual(artifactPreviewFailure(500, 'file_not_found'), {
    state: 'error',
    message: '暂时无法预览此文件',
  })
  assert.doesNotMatch(artifactPreviewFailure(500).message, /ENOENT|\/Users\//)
})
