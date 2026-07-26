export type ArtifactFormat = 'image' | 'markdown' | 'text'

export type ArtifactPreviewFailure = {
  state: 'not_created' | 'error'
  message: string
}

type ArtifactDescriptor = {
  path: string
  mimeType?: string
  kind?: 'image' | 'text' | 'unsupported'
}

export const artifactFormat = ({ path, mimeType = '', kind }: ArtifactDescriptor): ArtifactFormat => {
  if (kind === 'image') return 'image'
  if (mimeType.toLowerCase().startsWith('text/markdown') || /\.(?:md|markdown)$/i.test(path)) return 'markdown'
  return 'text'
}

export const artifactPreviewFailure = (status: number, code?: string): ArtifactPreviewFailure => (
  status === 404 && code === 'file_not_found'
    ? { state: 'not_created', message: '文件尚未生成' }
    : { state: 'error', message: '暂时无法预览此文件' }
)
