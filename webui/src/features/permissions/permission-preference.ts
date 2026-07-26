export type PermissionPreference = 'manual-current' | 'approve-running'

export type PermissionOptionLike = {
  optionId: string
  kind: string
}

export const DEFAULT_PERMISSION_PREFERENCE: PermissionPreference = 'manual-current'

export const automaticPermissionOption = <T extends PermissionOptionLike>(options: readonly T[]): T | null => (
  options.find((option) => option.kind === 'allow_always')
  ?? options.find((option) => option.kind === 'allow_once')
  ?? null
)

export const permissionPreferenceNotification = (preference: PermissionPreference) => {
  const approveRunning = preference === 'approve-running'
  return {
    method: 'x.ai/yolo_mode_changed',
    params: {
      yolo_mode: approveRunning,
      auto_mode: false,
      permission_mode: approveRunning ? 'always-approve' : 'ask',
      clientIdentifier: 'personal-agent-webui',
    },
  }
}
