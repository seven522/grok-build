export type ColorScheme = 'dark' | 'light'

export const resolveInitialColorScheme = (storedPreference: string | null): ColorScheme => (
  storedPreference === 'dark' ? 'dark' : 'light'
)

export const isFirstDesktopRun = (storedMarker: string | null) => storedMarker !== '1'

export const shouldAutoStartXaiLogin = (options: {
  desktopRuntime: boolean
  firstRun: boolean
  loginRequired: boolean
  alreadyAttempted: boolean
}) => options.desktopRuntime && options.firstRun && options.loginRequired && !options.alreadyAttempted
