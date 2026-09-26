import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isStillCastImageFile,
  mergeLibraryFolders,
  slugStillCastName,
  stillCastImageMatchKey,
} from '../../shared/stillCast'
import type { StillCastCustomStill, StillCastLibraryFolder, StillCastLibraryScan } from '../../shared/types'

const EXPRESSIONS_FOLDER = 'expressions'
const CUSTOM_FOLDER = 'custom'
const CUSTOM_9X16_FOLDER = 'custom-9x16'

const MISSING_EXPRESSIONS_ERROR =
  'Put expression stills in the channel Expressions folder. Custom stills go in this project’s Custom folder. 9:16 shorts use Custom-9x16.'

export async function scanStillCastLibrary(libraryPath: string): Promise<StillCastLibraryScan> {
  const trimmed = libraryPath.trim()
  if (!trimmed) {
    throw new Error(MISSING_EXPRESSIONS_ERROR)
  }
  const resolved = path.resolve(trimmed)
  const folders: StillCastLibraryFolder[] = []

  let entries: Array<{ name: string; isDirectory: () => boolean }> = []
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true })
  } catch {
    throw new Error(MISSING_EXPRESSIONS_ERROR)
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const folderPath = path.join(resolved, entry.name)
    const files = await fs.readdir(folderPath)
    const imagePaths = files
      .filter((fileName) => isStillCastImageFile(fileName))
      .map((fileName) => path.join(folderPath, fileName))
      .sort((left, right) => left.localeCompare(right))
    const id = slugStillCastName(entry.name)
    if (!id) continue
    folders.push({
      id,
      folderName: entry.name,
      imagePaths,
      kind: 'expression',
    })
  }

  return {
    libraryPath: resolved,
    folders: mergeLibraryFolders(folders),
    unmatchedFolders: [],
  }
}

export async function resolveProjectCustomFolder(projectRoot: string): Promise<string | undefined> {
  return findNamedDirectory(projectRoot, CUSTOM_FOLDER)
}

export async function ensureProjectCustomFolder(projectRoot: string): Promise<string> {
  const existing = await findNamedDirectory(projectRoot, CUSTOM_FOLDER)
  if (existing) return existing
  const folderPath = path.join(path.resolve(projectRoot), 'Custom')
  await fs.mkdir(folderPath, { recursive: true })
  return folderPath
}

export async function resolveProjectTrailerCustomFolder(
  projectRoot: string,
): Promise<string | undefined> {
  return findNamedDirectory(projectRoot, CUSTOM_9X16_FOLDER)
}

export function trailerCustomFolderName(): string {
  return 'Custom-9x16'
}

export async function resolveExpressionLibraryPath(
  projectRoot: string,
  configuredPath?: string,
): Promise<string> {
  const resolvedProject = path.resolve(projectRoot)
  const configured = configuredPath?.trim() ? path.resolve(configuredPath.trim()) : undefined
  const candidates = [
    configured,
    await findNamedDirectory(path.dirname(resolvedProject), EXPRESSIONS_FOLDER),
    await findNamedDirectory(resolvedProject, EXPRESSIONS_FOLDER),
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (await isDirectory(candidate)) return candidate
  }
  throw new Error(MISSING_EXPRESSIONS_ERROR)
}

export function expressionLibraryPathForChannel(channelFolderPath: string): string {
  return path.join(path.resolve(channelFolderPath.trim()), 'Expressions')
}

export async function scanProjectCustomStills(
  projectRoot: string,
  folderName: string = CUSTOM_FOLDER,
): Promise<{
  folderPath?: string
  stills: StillCastCustomStill[]
}> {
  const folderPath = await findNamedDirectory(projectRoot, folderName)
  if (!folderPath) return { stills: [] }

  let files: string[] = []
  try {
    files = await fs.readdir(folderPath)
  } catch {
    return { folderPath, stills: [] }
  }

  const stills = files
    .filter((fileName) => isStillCastImageFile(fileName))
    .map((fileName) => ({
      fileName,
      imagePath: path.join(folderPath, fileName),
      matchKey: stillCastImageMatchKey(fileName),
    }))
    .filter((still) => still.matchKey)
    .sort((left, right) => left.fileName.localeCompare(right.fileName))

  return { folderPath, stills }
}

export async function scanStillCastCatalog(
  libraryPath: string | undefined,
  projectRoot: string,
): Promise<StillCastLibraryScan> {
  const resolvedLibrary = await resolveExpressionLibraryPath(projectRoot, libraryPath)
  const expressions = await scanStillCastLibrary(resolvedLibrary)
  const customs = await scanProjectCustomStills(projectRoot, CUSTOM_FOLDER)
  const trailerCustoms = await scanProjectCustomStills(projectRoot, CUSTOM_9X16_FOLDER)
  return {
    ...expressions,
    customFolderPath: customs.folderPath,
    customStills: customs.stills,
    trailerCustomFolderPath: trailerCustoms.folderPath,
    trailerCustomStills: trailerCustoms.stills,
  }
}

export async function prepareStillCastLibrary(libraryPath: string): Promise<StillCastLibraryScan> {
  const resolved = path.resolve(libraryPath.trim())
  await fs.mkdir(resolved, { recursive: true })
  const scan = await scanStillCastLibrary(resolved)
  const readmePath = path.join(resolved, 'README.txt')
  await fs.writeFile(
    readmePath,
    [
      'Each subfolder is an expression you can prefix on a script line, for example Warm Smile: Beautiful.',
      'Add a new folder, drop 2–4 stills of the same character into it, then import or recast.',
      'Use Custom: for 16:9 episode pictures on spoken lines. Name those files after the spoken line and drop them in the project Custom folder.',
      '9:16 condensed cuts use Custom-9x16 only. Put one vertical still per short line there, named after the spoken line.',
      '',
      scan.folders.length > 0
        ? ['Current folders:', ...scan.folders.map((folder) => `- ${folder.folderName}`)].join('\n')
        : 'No expression folders yet.',
    ].join('\n'),
    'utf8',
  )
  return scan
}

async function findNamedDirectory(parentPath: string, name: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(parentPath, { withFileTypes: true })
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.toLowerCase() === name.toLowerCase(),
    )
    return match ? path.join(parentPath, match.name) : undefined
  } catch {
    return undefined
  }
}

async function isDirectory(folderPath: string): Promise<boolean> {
  try {
    return (await fs.stat(folderPath)).isDirectory()
  } catch {
    return false
  }
}
