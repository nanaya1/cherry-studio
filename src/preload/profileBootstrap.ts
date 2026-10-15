import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('profileBootstrap', {
  // enterLocal: () => ipcRenderer.invoke('profile-bootstrap:enter-local'),
  passwordLogin: (input: { identifier: string; password: string }) =>
    ipcRenderer.invoke('profile-bootstrap:password-login', input),
  enterpriseLogin: () => ipcRenderer.invoke('profile-bootstrap:enterprise-login'),
  adoptLegacy: () => ipcRenderer.invoke('profile-bootstrap:adopt-legacy'),
  retryRecovery: () => ipcRenderer.invoke('profile-bootstrap:retry-recovery'),
  cancelSwitch: () => ipcRenderer.invoke('profile-bootstrap:cancel-switch'),
  selectSignedOut: () => ipcRenderer.invoke('profile-bootstrap:select-signed-out'),
  // selectLocal: () => ipcRenderer.invoke('profile-bootstrap:select-local'),
  exportDiagnostics: () => ipcRenderer.invoke('profile-bootstrap:export-diagnostics')
})
