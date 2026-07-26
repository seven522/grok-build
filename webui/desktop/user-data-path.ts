import path from 'node:path'

export type DesktopUserDataPathOptions = {
  appDataPath: string
  explicitPath?: string
  isPackaged: boolean
  importLegacy: boolean
  pathExists: (candidate: string) => boolean
}

/**
 * Packaged releases start from the RunBuild product profile. The former
 * Grok Build profile is only reused when migration is explicitly requested;
 * development keeps its historical fallback so local workflows do not move.
 */
export const resolveDesktopUserDataPath = (options: DesktopUserDataPathOptions) => {
  const explicitPath = options.explicitPath?.trim()
  if (explicitPath) return path.resolve(explicitPath)

  const productPath = path.join(options.appDataPath, 'RunBuild')
  const legacyPath = path.join(options.appDataPath, 'Grok Build')
  const canReuseLegacy = options.importLegacy || !options.isPackaged
  return canReuseLegacy && options.pathExists(legacyPath) ? legacyPath : productPath
}
