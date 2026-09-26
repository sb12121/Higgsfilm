import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  CUSTOM_IMAGE_GUIDE_FILE,
  composeCustomImagePrompt,
  formatCursorCustomImagePrompts,
  formatMissingCustomStillsBrief,
  type CustomImageVideoContext,
} from '../../shared/customImagePrompt'
import {
  customStillOutputFileName,
  isCustomStillCastExpression,
  matchCustomStillToLine,
  parseStillCastScriptLine,
} from '../../shared/stillCast'
import type {
  CustomImageGenerateInput,
  CustomImageGenerateResult,
  CustomImageProgress,
  CustomImageSetup,
  ProjectState,
  ScriptLine,
} from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import type { CodexClient } from './codexClient'
import { ensurePngExportCanvas } from './imageUpscale'
import { ProjectStore } from './projectStore'
import { ensureProjectCustomFolder, scanProjectCustomStills } from './stillCastLibrary'

const MAX_GUIDE_WALK = 6
const SOURCE_LEDGER_FILE = '.custom-image-sources.json'

interface FileRevision { size: number; mtimeMs: number; ctimeMs: number; ino: number }
interface SourceLedgerEntry { sourceFingerprint: string; outputRevision: FileRevision }
interface SourceLedger { version: 1; files: Record<string, SourceLedgerEntry> }
interface SourceInputs {
  guidePath: string
  guide: string
  characterSheetPath: string
  characterSheetRevision: FileRevision
  references: Array<{ path: string; revision: FileRevision }>
  channelId: string
  niche: string
  configuredGuidePath: string
  configuredCharacterSheetPath: string
  configuredReferencePaths: string[]
  state: ProjectState
  lines: ScriptLine[]
  promptByLine: Map<string, string>
}

export class CustomImageClient {
  private stopRequested = false
  private busy = false

  constructor(
    private readonly projectStore: ProjectStore,
    private readonly settings: AppSettingsStore,
    private readonly codex: Pick<CodexClient, 'generateImage' | 'cancelImageGeneration'>,
  ) {}

  async getSetup(): Promise<CustomImageSetup> {
    const state = this.projectStore.get()
    const sequenceLines = state ? structuredClone(this.projectStore.getSequenceManifest('main').lines) : []
    const lines = customLines(sequenceLines)
    const saved = this.settings.get()
    const guidePath = state
      ? await resolveCustomImageGuide(state.rootPath, saved.customImageGuidePath).catch(() => '')
      : saved.customImageGuidePath.trim()
    const setup: CustomImageSetup = {
      guidePath,
      characterSheetPath: saved.customImageCharacterSheetPath,
      referencePaths: saved.customImageReferencePaths,
    }
    if (!state) return setup
    try {
      const evaluated = await evaluateStillStatuses(state, this.settings, sequenceLines)
      setup.stills = evaluated.stills
      setup.sourceError = evaluated.sourceError
    } catch (error) {
      setup.sourceError = error instanceof Error ? error.message : 'Could not evaluate custom still sources.'
      setup.stills = lines.map((line) => ({
        lineId: line.id,
        status: 'unknown' as const,
      }))
    }
    return setup
  }

  cancel(): void {
    this.stopRequested = true
    void this.codex.cancelImageGeneration()
  }

  async missingCursorBrief(): Promise<string> {
    const state = this.projectStore.get()
    if (!state) throw new Error('Open a project before copying custom stills.')
    const sequenceLines = structuredClone(this.projectStore.getSequenceManifest('main').lines)
    const lines = customLines(sequenceLines)
    const customs = await scanProjectCustomStills(state.rootPath)
    const statuses = (await evaluateStillStatuses(state, this.settings, sequenceLines)).stills
    const regenerate = new Set(statuses.filter((still) => still.status === 'missing' || still.status === 'stale').map((still) => still.lineId))
    const missing = lines.filter((line) => regenerate.has(line.id) || !matchCustomStillToLine(line.text, customs.stills))
    const saved = this.settings.get()
    const guidePath = await resolveCustomImageGuide(state.rootPath, saved.customImageGuidePath)
    const guide = await fs.readFile(guidePath, 'utf8')
    const profile = this.settings.getActiveChannelProfile()
    return formatMissingCustomStillsBrief({
      folderPath: customs.folderPath || path.join(state.rootPath, 'Custom'),
      characterSheetPath: saved.customImageCharacterSheetPath,
      referencePaths: saved.customImageReferencePaths,
      guide,
      context: customImageVideoContext(state, profile?.niche || '', sequenceLines, ''),
      stills: missing.map((line) => ({
        fileName: customStillOutputFileName(line.text),
        spokenLine: line.text,
        durationSeconds: line.duration,
        shotNote: line.shotNote,
      })),
    })
  }

  async scriptCreatorCursorBrief(script: string, topic = ''): Promise<string> {
    const state = this.projectStore.get()
    if (!state) throw new Error('Open a project before copying custom stills.')
    const hasCustomLine = script
      .replace(/\r\n/g, '\n')
      .split('\n')
      .some((raw) => isCustomStillCastExpression(parseStillCastScriptLine(raw.trim()).expression))
    if (!hasCustomLine) throw new Error('This draft has no Custom lines to copy.')
    await this.projectStore.saveScriptCreator({ topic, draft: script })
    const saved = this.settings.get()
    const guidePath = await resolveCustomImageGuide(state.rootPath, saved.customImageGuidePath)
    const profile = this.settings.getActiveChannelProfile()
    const customs = await scanProjectCustomStills(state.rootPath)
    return formatCursorCustomImagePrompts({
      folderPath: customs.folderPath || path.join(state.rootPath, 'Custom'),
      guidePath,
      scriptPath: path.join(state.rootPath, 'draft-script.txt'),
      topicPath: topic.trim() ? path.join(state.rootPath, 'draft-topic.txt') : '',
      characterSheetPath: saved.customImageCharacterSheetPath,
      referencePaths: saved.customImageReferencePaths,
      niche: profile?.niche || '',
    })
  }

  async generate(
    input: CustomImageGenerateInput,
    onProgress?: (progress: CustomImageProgress) => void,
  ): Promise<CustomImageGenerateResult> {
    if (this.busy) throw new Error('Custom still generation is already running.')
    this.busy = true
    this.stopRequested = false
    try {
    const state = this.projectStore.get()
    if (!state) throw new Error('Open a project before generating custom stills.')

    const sequenceLines = structuredClone(this.projectStore.getSequenceManifest('main').lines)
    const lines = customLines(sequenceLines)
    const saved = this.settings.get()
    const capturedProfile = this.settings.getActiveChannelProfile()
    const requested = input.lineIds?.length
      ? lines.filter((line) => input.lineIds?.includes(line.id))
      : lines
    if (input.lineIds?.length && requested.length === 0) {
      throw new Error('That line is not a Custom still.')
    }
    if (requested.length === 0) {
      throw new Error('This script has no Custom lines to generate.')
    }

    const customs = await scanProjectCustomStills(state.rootPath)
    const statuses = (await evaluateStillStatuses(state, this.settings, sequenceLines)).stills
    const statusByLine = new Map(statuses.map((still) => [still.lineId, still.status]))
    const targets = input.onlyMissing
      ? requested.filter((line) => statusByLine.get(line.id) === 'missing' || statusByLine.get(line.id) === 'stale' || (!statusByLine.has(line.id) && !matchCustomStillToLine(line.text, customs.stills)))
      : requested
    if (targets.length === 0) {
      throw new Error('Every Custom line is current, unknown, or already has an image in the project Custom folder.')
    }

    const folderPath = await ensureProjectCustomFolder(state.rootPath)
    const libraryPath = capturedProfile?.stillLibraryPath
    const sourceInputs = await resolveSourceInputs(state, this.settings, sequenceLines, { saved, profile: capturedProfile })
    if (!sourceInputs.guide.trim()) throw new Error('The custom image guide is empty.')
    const expectedProject = { rootPath: path.resolve(state.rootPath), id: state.manifest.id }

    for (const [index, line] of targets.entries()) {
      if (this.stopRequested) break
      const fileName = customStillOutputFileName(line.text)
      const expectedSourceFingerprint = await fingerprintForLine(sourceInputs, line)
      const outputPath = path.join(folderPath, fileName)
      const beforeOutput = await fileRevision(outputPath).catch(() => undefined)
      onProgress?.({
        index: index + 1,
        total: targets.length,
        spoken: line.text,
        fileName,
        phase: 'generating',
      })
      let image: { data: Buffer; extension: string }
      try {
        image = await this.codex.generateImage({
          prompt: sourceInputs.promptByLine.get(line.id)!,
          aspectRatio: '16:9',
          referenceImagePaths: sourceInputs.references.map((reference) => reference.path),
          characterSheetPath: sourceInputs.characterSheetPath,
        })
      } catch (error) {
        if (this.stopRequested || isCancellation(error)) {
          return { state: this.projectStore.get() || state, stopped: true }
        }
        throw error
      }
      if (this.stopRequested) return { state: this.projectStore.get() || state, stopped: true }

      if (!(await sourceStillCurrent(this.projectStore, this.settings, expectedProject, sourceInputs, line, expectedSourceFingerprint))) {
        throw new Error(`The project or source for ${fileName} changed during generation. The image was not saved.`)
      }
      const currentOutput = await fileRevision(outputPath).catch(() => undefined)
      if (!sameOptionalRevision(beforeOutput, currentOutput)) {
        throw new Error(`${fileName} changed during generation. The existing file was left untouched.`)
      }

      onProgress?.({
        index: index + 1,
        total: targets.length,
        spoken: line.text,
        fileName,
        phase: 'saving',
      })
      const prepared = await ensurePngExportCanvas(image.data, image.extension || 'png', '16:9')
      const temporaryOutputPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(temporaryOutputPath, prepared)
      const stagedOutputRevision = await fileRevision(temporaryOutputPath)
      const latestOutput = await fileRevision(outputPath).catch(() => undefined)
      const sourceIsCurrent = await sourceStillCurrent(
        this.projectStore, this.settings, expectedProject, sourceInputs, line, expectedSourceFingerprint,
      )
      if (!sameOptionalRevision(beforeOutput, latestOutput) || !sourceIsCurrent) {
        await fs.rm(temporaryOutputPath, { force: true })
        throw new Error(`The project or source for ${fileName} changed during generation. The image was not saved.`)
      }
      try {
        await fs.rename(temporaryOutputPath, outputPath)
      } catch (error) {
        await fs.rm(temporaryOutputPath, { force: true })
        throw error
      }
      const writtenRevision = await fileRevision(outputPath)
      if (writtenRevision.size !== stagedOutputRevision.size) {
        throw new Error(`${fileName} changed while being saved. The source ledger was not updated.`)
      }
      await writeLedgerEntry(folderPath, fileName, {
        sourceFingerprint: expectedSourceFingerprint,
        outputRevision: writtenRevision,
      })
      try {
        if (!(await sourceStillCurrent(this.projectStore, this.settings, expectedProject, sourceInputs, line, expectedSourceFingerprint))) {
          throw new Error('The project or Custom image source changed before assignment.')
        }
        await this.projectStore.assignCustomImageIfCurrent({
          expectedRootPath: expectedProject.rootPath,
          expectedProjectId: expectedProject.id,
          lineId: line.id,
          expectedLineText: line.text,
          expectedShotNote: line.shotNote,
          generatedFileName: fileName,
          libraryPath,
          validateSource: () => sourceStillCurrent(this.projectStore, this.settings, expectedProject, sourceInputs, line, expectedSourceFingerprint),
          validateContext: () => syncContextStillCurrent(this.projectStore, this.settings, expectedProject, sourceInputs),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Could not assign the still.'
        throw new Error(`Saved ${fileName} in Custom, but could not assign it. ${detail}`)
      }
      onProgress?.({
        index: index + 1,
        total: targets.length,
        spoken: line.text,
        fileName,
        phase: 'assigned',
      })
    }

    return { state: this.projectStore.get() || state, stopped: this.stopRequested }
    } finally {
      this.busy = false
    }
  }
}

export async function resolveCustomImageGuide(projectRoot: string, configuredPath?: string): Promise<string> {
  const configured = configuredPath?.trim()
  if (configured) {
    try {
      await fs.access(configured)
    } catch {
      throw new Error('Could not read the custom image guide. Choose it again.')
    }
    return path.resolve(configured)
  }

  let current = path.resolve(projectRoot)
  for (let depth = 0; depth < MAX_GUIDE_WALK; depth += 1) {
    for (const name of [CUSTOM_IMAGE_GUIDE_FILE, 'Bux_Custom_Image_Generation_Prompt.txt']) {
      const candidate = path.join(current, name)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // Support existing channel folders as well as section-named guides.
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Choose the 16:9 custom image guide (${CUSTOM_IMAGE_GUIDE_FILE}).`)
}

function customImageVideoContext(
  state: ProjectState,
  niche: string,
  lines: ScriptLine[],
  currentLineId: string,
): CustomImageVideoContext {
  const topicParts: string[] = []
  const creatorTopic = state.scriptCreator?.topic?.trim() || ''
  if (creatorTopic) topicParts.push(creatorTopic)
  const idea = state.manifest.videoIdea?.idea
  const title = idea?.title.trim() || ''
  const subject = idea?.subject.trim() || ''
  if (title && !creatorTopic.includes(title)) topicParts.push(`Title: ${title}`)
  if (subject && subject !== title && !creatorTopic.includes(subject)) topicParts.push(`Subject: ${subject}`)
  const script = lines
    .map((entry, index) => {
      const text = entry.text.trim()
      if (!text) return ''
      const marker = entry.id === currentLineId ? ' [this still]' : ''
      return `${index + 1}. ${text}${marker}`
    })
    .filter(Boolean)
    .join('\n')
  return {
    niche,
    topic: topicParts.join('\n'),
    script,
  }
}

function customLines(lines: ScriptLine[]): ScriptLine[] {
  return lines.filter((line) =>
    (line.stillBeats || []).some((beat) => isCustomStillCastExpression(beat.expression)),
  )
}

async function existingFile(filePath: string): Promise<string> {
  const trimmed = filePath.trim()
  if (!trimmed) return ''
  try {
    const stat = await fs.stat(trimmed)
    return stat.isFile() ? trimmed : ''
  } catch {
    return ''
  }
}

async function existingReferencePaths(paths: string[]): Promise<string[]> {
  const existing: string[] = []
  for (const filePath of paths) {
    try {
      const stat = await fs.stat(filePath)
      if (stat.isFile()) existing.push(filePath)
    } catch {
      // Drop references the user moved or deleted.
    }
  }
  return existing
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && /cancelled/i.test(error.message)
}

async function resolveSourceInputs(
  state: ProjectState,
  settings: AppSettingsStore,
  lines: ScriptLine[],
  captured?: { saved: ReturnType<AppSettingsStore['get']>; profile: ReturnType<AppSettingsStore['getActiveChannelProfile']> },
): Promise<SourceInputs> {
  const saved = captured?.saved || settings.get()
  const profile = captured ? captured.profile : settings.getActiveChannelProfile()
  const guidePath = await resolveCustomImageGuide(state.rootPath, saved.customImageGuidePath)
  const guide = await fs.readFile(guidePath, 'utf8')
  if (!guide.trim()) throw new Error('The custom image guide is empty.')
  const characterSheetPath = await existingFile(saved.customImageCharacterSheetPath)
  if (!characterSheetPath) throw new Error('Choose a character sheet before generating custom stills.')
  const characterSheetRevision = await fileRevision(characterSheetPath)
  const references: SourceInputs['references'] = []
  for (const referencePath of saved.customImageReferencePaths) {
    const existing = await existingFile(referencePath)
    if (existing) references.push({ path: path.resolve(existing), revision: await fileRevision(existing) })
  }
  const clonedState = structuredClone(state)
  const clonedLines = structuredClone(lines)
  const promptByLine = new Map<string, string>()
  for (const line of clonedLines) {
    promptByLine.set(line.id, composeCustomImagePrompt(
      guide,
      line.text,
      customImageVideoContext(clonedState, profile?.niche || '', clonedLines, line.id),
      line.shotNote,
    ))
  }
  return {
    guidePath: path.resolve(guidePath),
    guide,
    characterSheetPath: path.resolve(characterSheetPath),
    characterSheetRevision,
    references,
    channelId: profile?.id || '',
    niche: profile?.niche || '',
    configuredGuidePath: saved.customImageGuidePath,
    configuredCharacterSheetPath: saved.customImageCharacterSheetPath,
    configuredReferencePaths: [...saved.customImageReferencePaths],
    state: clonedState,
    lines: clonedLines,
    promptByLine,
  }
}

async function evaluateStillStatuses(
  state: ProjectState,
  settings: AppSettingsStore,
  lines: ScriptLine[],
): Promise<{ stills: NonNullable<CustomImageSetup['stills']>; sourceError?: string }> {
  const customs = await scanProjectCustomStills(state.rootPath)
  const ledger = await readSourceLedger(customs.folderPath || path.join(state.rootPath, 'Custom'))
  let sourceInputs: SourceInputs | undefined
  let sourceError: string | undefined
  try {
    sourceInputs = await resolveSourceInputs(structuredClone(state), settings, structuredClone(lines))
  } catch (error) {
    sourceError = error instanceof Error ? error.message : 'Could not evaluate custom still sources.'
  }
  const stills = await Promise.all(customLines(lines).map(async (line) => {
    const fileName = customStillOutputFileName(line.text)
    const trackedOutput = customs.stills.find((still) =>
      still.fileName === fileName && isLedgerEntry(ledger?.files[still.fileName]),
    )
    const output = trackedOutput || matchCustomStillToLine(line.text, customs.stills)
    if (!output) return { lineId: line.id, status: 'missing' as const }
    const entry = ledger?.files[output.fileName]
    if (!ledger || !entry || !isLedgerEntry(entry) || !sourceInputs) return { lineId: line.id, status: 'unknown' as const }
    const currentRevision = await fileRevision(output.imagePath).catch(() => undefined)
    if (!currentRevision || !sameRevision(currentRevision, entry.outputRevision)) {
      return { lineId: line.id, status: 'unknown' as const }
    }
    const sourceFingerprint = await fingerprintForLine(sourceInputs, line)
    return {
      lineId: line.id,
      status: sourceFingerprint === entry.sourceFingerprint ? 'current' as const : 'stale' as const,
    }
  }))
  return { stills, ...(sourceError ? { sourceError } : {}) }
}

async function fingerprintForLine(inputs: SourceInputs, line: ScriptLine): Promise<string> {
  const prompt = inputs.promptByLine.get(line.id)
  if (prompt === undefined) throw new Error(`Could not compose the source prompt for ${line.id}.`)
  return createHash('sha256').update(JSON.stringify({
    prompt,
    guidePath: inputs.guidePath,
    guide: inputs.guide,
    characterSheet: { path: inputs.characterSheetPath, revision: inputs.characterSheetRevision },
    references: inputs.references,
    channelId: inputs.channelId,
  })).digest('hex')
}

async function sourceStillCurrent(
  projectStore: ProjectStore,
  settings: AppSettingsStore,
  expectedProject: { rootPath: string; id: string },
  original: SourceInputs,
  line: ScriptLine,
  expectedFingerprint: string,
): Promise<boolean> {
  const state = projectStore.get()
  if (!state || path.resolve(state.rootPath) !== expectedProject.rootPath || state.manifest.id !== expectedProject.id) return false
  const currentLines = structuredClone(projectStore.getSequenceManifest('main').lines)
  const currentLine = currentLines.find((candidate) => candidate.id === line.id)
  if (!currentLine) return false
  try {
    const current = await resolveSourceInputs(state, settings, currentLines)
    const currentFingerprint = await fingerprintForLine(current, currentLine)
    const originalScript = original.lines.map((entry) => [entry.id, entry.text]).join('\n')
    const currentScript = currentLines.map((entry) => [entry.id, entry.text]).join('\n')
    return currentFingerprint === expectedFingerprint &&
      currentLine.shotNote === line.shotNote &&
      currentScript === originalScript &&
      wantsCustomStill(currentLine) &&
      syncContextStillCurrent(projectStore, settings, expectedProject, original)
  } catch {
    return false
  }
}

function syncContextStillCurrent(
  projectStore: ProjectStore,
  settings: AppSettingsStore,
  expectedProject: { rootPath: string; id: string },
  original: SourceInputs,
): boolean {
  const state = projectStore.get()
  if (!state || path.resolve(state.rootPath) !== expectedProject.rootPath || state.manifest.id !== expectedProject.id) return false
  const lines = projectStore.getSequenceManifest('main').lines
  const currentProfile = settings.getActiveChannelProfile()
  const context = (
    project: ProjectState,
    scriptLines: ScriptLine[],
    profile: { id?: string; niche?: string; guidePath?: string; characterSheetPath?: string; referencePaths?: string[] } | null,
    imageSettings: { customImageGuidePath: string; customImageCharacterSheetPath: string; customImageReferencePaths: string[] },
  ) => JSON.stringify({
    lines: scriptLines.map((entry) => [entry.id, entry.text, entry.shotNote || '']),
    topic: project.scriptCreator?.topic || '',
    title: project.manifest.videoIdea?.idea?.title || '',
    subject: project.manifest.videoIdea?.idea?.subject || '',
    channelId: profile?.id || '',
    niche: profile?.niche || '',
    guidePath: imageSettings.customImageGuidePath,
    characterSheetPath: imageSettings.customImageCharacterSheetPath,
    referencePaths: imageSettings.customImageReferencePaths,
  })
  const currentSettings = settings.get()
  const capturedSettings = {
    customImageGuidePath: original.configuredGuidePath,
    customImageCharacterSheetPath: original.configuredCharacterSheetPath,
    customImageReferencePaths: original.configuredReferencePaths,
  }
  return context(state, lines, currentProfile, currentSettings) === context(original.state, original.lines, {
    id: original.channelId,
    niche: original.niche,
  }, capturedSettings)
}

function wantsCustomStill(line: ScriptLine): boolean {
  return (line.stillBeats || []).some((beat) => isCustomStillCastExpression(beat.expression))
}

async function fileRevision(filePath: string): Promise<FileRevision> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }
}

function sameRevision(a: FileRevision, b: FileRevision): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
}

function sameOptionalRevision(a?: FileRevision, b?: FileRevision): boolean {
  return !a ? !b : Boolean(b && sameRevision(a, b))
}

function isLedgerEntry(value: unknown): value is SourceLedgerEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<SourceLedgerEntry>
  const revision = entry.outputRevision
  return typeof entry.sourceFingerprint === 'string' && Boolean(revision) &&
    Number.isFinite(revision?.size) && Number.isFinite(revision?.mtimeMs) &&
    Number.isFinite(revision?.ctimeMs) && Number.isFinite(revision?.ino)
}

async function readSourceLedger(folderPath: string): Promise<SourceLedger | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(folderPath, SOURCE_LEDGER_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const ledger = parsed as Partial<SourceLedger>
    if (ledger.version !== 1 || !ledger.files || typeof ledger.files !== 'object') return null
    return ledger as SourceLedger
  } catch {
    return null
  }
}

async function writeLedgerEntry(folderPath: string, fileName: string, entry: SourceLedgerEntry): Promise<void> {
  const current = await readSourceLedger(folderPath)
  const next: SourceLedger = {
    version: 1,
    files: { ...(current?.files || {}), [fileName]: entry },
  }
  const ledgerPath = path.join(folderPath, SOURCE_LEDGER_FILE)
  const temporaryPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(temporaryPath, ledgerPath)
}
