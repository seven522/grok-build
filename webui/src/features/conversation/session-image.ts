import React from 'react'

const SESSION_IMAGE_PATH = /^(?:\.\/)?images\/([A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:avif|gif|jpe?g|png|webp))$/i

type SessionImagePreview = { src: string; alt: string }
type MarkdownLinkProps = React.ComponentPropsWithoutRef<'a'> & { node?: unknown }
type SessionImageRenderOptions = {
  caption?: React.ReactNode
  captionFilename?: string
  captionFilenames?: readonly string[]
  fallback?: (props: MarkdownLinkProps) => React.ReactNode
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const sessionImageSource = (sessionId: string | null, source: string | undefined) => {
  if (!sessionId || !source) return null
  const match = source.match(SESSION_IMAGE_PATH)
  return match ? `/api/session-media/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(match[1])}` : null
}

export const sessionImagePresentation = (
  sessionId: string | null,
  source: string | undefined,
  label: string,
) => {
  const src = sessionImageSource(sessionId, source)
  return src ? { src, alt: label.trim() || '生成的图片' } : null
}

const sessionImageFilename = (source: string | undefined) => source?.match(SESSION_IMAGE_PATH)?.[1] ?? null

const sessionImageLinkPattern = (filename: string) => {
  const safeFilename = sessionImageFilename(`images/${filename}`)
  if (!safeFilename) return null
  const sessionImagePath = `(?:\\./)?images/${escapeRegExp(safeFilename)}`
  return new RegExp(`!?\\[[^\\]]*\\]\\(\\s*${sessionImagePath}(?:\\s+["'][^"'\\n]*["'])?\\s*\\)`, 'i')
}

const withSessionImageCaption = (
  imageNode: React.ReactElement,
  source: string | undefined,
  image: SessionImagePreview,
  options: SessionImageRenderOptions,
) => {
  const filename = sessionImageFilename(source)
  const captionFilenames = options.captionFilenames ?? (options.captionFilename ? [options.captionFilename] : [])
  if (!options.caption || !filename || !captionFilenames.includes(filename)) return imageNode
  return React.createElement('span', {
    className: 'message-generated-image-block',
    role: 'group',
    'aria-label': `${image.alt}，${typeof options.caption === 'string' ? options.caption : '图片生成完成'}`,
  }, imageNode, React.createElement('span', {
    className: 'message-generated-image-caption',
    role: 'status',
    'aria-live': 'polite',
  }, options.caption))
}

const candidateSessionImageFilenames = (message: string) => Array.from(message.matchAll(
  /(?:\.\/)?images\/([A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:avif|gif|jpe?g|png|webp))/gi,
), (match) => match[1])

const materializeSessionImageReference = (message: string, filename: string) => {
  const safeFilename = sessionImageFilename(`images/${filename}`)
  if (!safeFilename) return message
  const source = `images/${safeFilename}`
  const linkedReference = sessionImageLinkPattern(safeFilename)
  const escapedSource = escapeRegExp(source)
  const inlineCode = new RegExp(`(\`{1,2})\\s*${escapedSource}\\s*\\1`, 'g')
  const bareReference = new RegExp(`(^|[^A-Za-z0-9_./-])${escapedSource}(?=$|[^A-Za-z0-9_./-])`, 'g')
  const renderedReference = `[生成的图片](${source})`
  const placeholder = '\u0000runbuild-session-image\u0000'
  let fenceMarker: '`' | '~' | null = null

  return message.split('\n').map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1][0] as '`' | '~'
      if (!fenceMarker) fenceMarker = marker
      else if (fenceMarker === marker) fenceMarker = null
      return line
    }
    if (fenceMarker || /^(?: {4}|\t)/.test(line) || linkedReference?.test(line)) return line
    return line
      .replace(inlineCode, placeholder)
      .replace(bareReference, (_match, prefix: string) => `${prefix}${renderedReference}`)
      .split(placeholder).join(renderedReference)
  }).join('\n')
}

export const materializeSessionImageReferences = (message: string, filename?: string) => {
  const filenames = filename ? [filename] : candidateSessionImageFilenames(message)
  return [...new Set(filenames)].reduce(materializeSessionImageReference, message)
}

const messageHasLinkedSessionImage = (message: string, filename: string) => {
  const linkedReference = sessionImageLinkPattern(filename)
  if (!linkedReference) return false
  let fenceMarker: '`' | '~' | null = null
  return message.split('\n').some((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1][0] as '`' | '~'
      if (!fenceMarker) fenceMarker = marker
      else if (fenceMarker === marker) fenceMarker = null
      return false
    }
    return !fenceMarker && !/^(?: {4}|\t)/.test(line) && linkedReference.test(line)
  })
}

export const messagePresentsSessionImage = (message: string, filename: string | undefined) => {
  if (!filename) return false
  return messageHasLinkedSessionImage(message, filename) || materializeSessionImageReferences(message, filename) !== message
}

export const sessionImageFilenamesInMessage = (message: string) => [...new Set(
  candidateSessionImageFilenames(message).filter((filename) => messagePresentsSessionImage(message, filename)),
)]

export const createSessionImageLinkComponent = (
  sessionId: string | null,
  onPreview: (image: SessionImagePreview) => void,
  options: SessionImageRenderOptions = {},
) => ({ node, href, children, ...props }: MarkdownLinkProps) => {
  void node
  const label = React.Children.toArray(children)
    .filter((child): child is string | number => typeof child === 'string' || typeof child === 'number')
    .join('')
  const image = sessionImagePresentation(sessionId, href, label)
  if (!image) return options.fallback
    ? options.fallback({ node, href, children, ...props })
    : React.createElement('a', { ...props, href }, children)
  const imageNode = React.createElement('img', {
    className: 'message-generated-image',
    src: image.src,
    alt: image.alt,
    loading: 'lazy',
    role: 'button',
    tabIndex: 0,
    title: '双击全屏查看',
    'aria-label': `${image.alt}，双击全屏查看`,
    onDoubleClick: () => onPreview(image),
    onKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onPreview(image)
      }
    },
  })
  return withSessionImageCaption(imageNode, href, image, options)
}

export const createSessionImageComponent = (
  sessionId: string | null,
  onPreview: (image: SessionImagePreview) => void,
  options: SessionImageRenderOptions = {},
) => ({ node, src, alt, ...props }: React.ComponentPropsWithoutRef<'img'> & { node?: unknown }) => {
  void node
  const resolved = sessionImageSource(sessionId, src) ?? src
  const image = { src: resolved ?? '', alt: alt?.trim() || '生成的图片' }
  const imageNode = React.createElement('img', {
    ...props,
    className: 'message-generated-image',
    src: image.src,
    alt: image.alt,
    loading: 'lazy',
    role: 'button',
    tabIndex: 0,
    title: '双击全屏查看',
    'aria-label': `${image.alt}，双击全屏查看`,
    onDoubleClick: () => onPreview(image),
    onKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onPreview(image)
      }
    },
  })
  return withSessionImageCaption(imageNode, src, image, options)
}
