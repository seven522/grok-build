export type SingleInstanceApp = {
  requestSingleInstanceLock: () => boolean
  quit: () => void
  on: (event: 'second-instance', listener: () => void) => void
}

export function installSingleInstanceGuard(app: SingleInstanceApp, focusPrimaryWindow: () => void) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', focusPrimaryWindow)
  return true
}
