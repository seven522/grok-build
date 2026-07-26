import { contextBridge, ipcRenderer } from 'electron'

const desktopSetupApi = Object.freeze({
  getSetupState: () => ipcRenderer.invoke('desktop-setup:get'),
  requestMicrophone: () => ipcRenderer.invoke('desktop-setup:request-microphone'),
  openMicrophoneSettings: () => ipcRenderer.invoke('desktop-setup:open-microphone-settings'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('desktop-setup:open-screen-recording-settings'),
  requestAccessibility: () => ipcRenderer.invoke('desktop-setup:request-accessibility'),
  openFullDiskAccessSettings: () => ipcRenderer.invoke('desktop-setup:open-full-disk-access-settings'),
  completeSetup: (mode: 'granted' | 'limited') => ipcRenderer.invoke('desktop-setup:complete', mode),
  loginXai: () => ipcRenderer.invoke('xai-auth:login'),
  cancelXaiLogin: () => ipcRenderer.invoke('xai-auth:cancel'),
  getDiagnosticsSnapshot: () => ipcRenderer.invoke('desktop-diagnostics:get'),
  getDiagnosticsLogTail: (source?: 'desktop-agent') => ipcRenderer.invoke('desktop-diagnostics:log-tail', source),
  getDiagnosticsPermissions: () => ipcRenderer.invoke('desktop-diagnostics:permissions'),
  requestDiagnosticsPermission: (permission: 'microphone' | 'screen-recording' | 'accessibility' | 'full-disk-access') => ipcRenderer.invoke('desktop-diagnostics:request-permission', permission),
  restartAgent: () => ipcRenderer.invoke('desktop-diagnostics:restart-agent'),
  openLocalResource: (target: string) => ipcRenderer.invoke('desktop-resource:open-local', target),
  launchGodotProject: (projectId: string) => ipcRenderer.invoke('desktop-project:launch-godot', projectId),
})

contextBridge.exposeInMainWorld('grokDesktop', desktopSetupApi)
