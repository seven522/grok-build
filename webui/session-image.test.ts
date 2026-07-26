import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'

import {
  createSessionImageLinkComponent,
  materializeSessionImageReferences,
  messagePresentsSessionImage,
  sessionImageFilenamesInMessage,
  sessionImagePresentation,
  sessionImageSource,
} from './src/features/conversation/session-image.ts'

test('maps generated session image paths to the protected media endpoint', () => {
  const sessionId = '019f92df-8340-7472-8c35-3f17ef4d3610'

  assert.equal(
    sessionImageSource(sessionId, 'images/1.jpg'),
    `/api/session-media/${sessionId}/images/1.jpg`,
  )
  assert.deepEqual(
    sessionImagePresentation(sessionId, 'images/1.jpg', 'images/1.jpg'),
    { src: `/api/session-media/${sessionId}/images/1.jpg`, alt: 'images/1.jpg' },
  )
  assert.equal(sessionImagePresentation(sessionId, 'https://example.com/image.jpg', 'image'), null)
  assert.equal(sessionImagePresentation(sessionId, '../images/1.jpg', 'image'), null)
})

test('renders a generated session image link as the image component', () => {
  const sessionId = '019f92df-8340-7472-8c35-3f17ef4d3610'
  const components = { a: createSessionImageLinkComponent(sessionId, () => undefined) }
  const markup = renderToStaticMarkup(React.createElement(
    ReactMarkdown,
    { components },
    '**[images/1.jpg](images/1.jpg)**',
  ))

  assert.match(markup, /<img[^>]+class="message-generated-image"/)
  assert.match(markup, new RegExp(`/api/session-media/${sessionId}/images/1.jpg`))
  assert.doesNotMatch(markup, /<a\b/)
})

test('materializes the generated image path while preserving unsafe boundaries', () => {
  assert.equal(
    materializeSessionImageReferences('已生成：**images/2.jpg**', '2.jpg'),
    '已生成：**[生成的图片](images/2.jpg)**',
  )
  assert.equal(
    materializeSessionImageReferences('已生成：`images/2.jpg`', '2.jpg'),
    '已生成：[生成的图片](images/2.jpg)',
  )
  assert.equal(
    materializeSessionImageReferences('```text\nimages/2.jpg\n```', '2.jpg'),
    '```text\nimages/2.jpg\n```',
  )
  assert.equal(
    materializeSessionImageReferences('https://example.com/images/2.jpg', '2.jpg'),
    'https://example.com/images/2.jpg',
  )
  assert.equal(
    materializeSessionImageReferences('../images/2.jpg 和 images/2.jpg.bak', '2.jpg'),
    '../images/2.jpg 和 images/2.jpg.bak',
  )
  assert.equal(
    materializeSessionImageReferences('images/2.jpg 和 images/3.webp'),
    '[生成的图片](images/2.jpg) 和 [生成的图片](images/3.webp)',
  )
})

test('treats only renderable same-file references as the generated image', () => {
  assert.equal(
    messagePresentsSessionImage('已经生成好了：`images/1.jpg`', '1.jpg'),
    true,
  )
  assert.equal(
    messagePresentsSessionImage('![海底小猫](images/1.jpg)', '1.jpg'),
    true,
  )
  assert.equal(
    messagePresentsSessionImage('[images/1.jpg](images/1.jpg)', '1.jpg'),
    true,
  )
  assert.equal(
    messagePresentsSessionImage('```text\nimages/1.jpg\n```', '1.jpg'),
    false,
  )
  assert.equal(
    messagePresentsSessionImage('https://example.com/images/1.jpg', '1.jpg'),
    false,
  )
  assert.deepEqual(sessionImageFilenamesInMessage(
    'images/1.jpg https://example.com/images/2.jpg ../images/3.jpg images/4.jpg.bak',
  ), ['1.jpg'])
})

test('places the completion caption after the generated image', () => {
  const sessionId = '019f92df-8340-7472-8c35-3f17ef4d3610'
  const components = {
    a: createSessionImageLinkComponent(sessionId, () => undefined, {
      caption: '图片生成完成',
      captionFilename: '1.jpg',
    }),
  }
  const markup = renderToStaticMarkup(React.createElement(
    ReactMarkdown,
    { components },
    '[生成的图片](images/1.jpg)',
  ))

  assert.match(markup, /message-generated-image-block/)
  assert.match(markup, /<img[^>]+class="message-generated-image"[^>]*\/><span class="message-generated-image-caption"[^>]*>图片生成完成<\/span>/)
})
