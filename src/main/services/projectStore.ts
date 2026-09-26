import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AssetData,
  ProjectManifest,
  ProjectState,
  QwenParagraphMaster,
  RecordingPayload,
  ResetVoiceTakeCleanupPayload,
  ScriptLine,
  SequenceId,
  SequenceManifest,
  StillCastAssignInput,
  StillCastBeat,
  StillCastExpressionInput,
  TrimVoiceTakePayload,
  VisualBible,
  ScriptCreatorDraft,
  ScriptLineMode,
} from '../../shared/types'
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_TRAILER_EXPORT_SETTINGS as TRAILER_EXPORT_SETTINGS,
  normalizeExportSettings,
} from '../../shared/types'
import { composeScenePrompt, stripVisualBible } from '../../shared/promptComposer'
import { newerVideoIdeaSession, normalizeVideoIdeaSession } from '../../shared/videoIdea'
import {
  applyStillCastScriptPrefixes,
  createStillCastBeatId,
  isCustomStillCastExpression,
  lineStillCastImagesReady,
  matchCustomStillToLine,
  normalizeStillBeats,
  pickStillImage,
  slugStillCastName,
  stillCastDirectionSummary,
} from '../../shared/stillCast'
import { DEFAULT_THUMB_MAX_EDGE, imageThumbDataUrl } from './assetThumb'
import { estimateTimeline, splitIntoScriptLines, splitScript } from './scriptParser'
import { scanStillCastCatalog } from './stillCastLibrary'
import { splitStanzaAudio } from './audioSegmenter'
import { cleanupRecordedVoiceTake, clampVoiceTrimEnd, clampVoiceTrimStart, detectSpeechWindowFromRaw, rewriteCleanedVoiceTakeFromRaw, VOICE_CLEANUP_VERSION } from './voiceTakeCleanup'
import { computeAudioPeaks } from './audioPeaks'

const MANIFEST_FILE = 'higgsfilm.json'
const DRAFT_SCRIPT_FILE = 'draft-script.txt'
const DRAFT_TOPIC_FILE = 'draft-topic.txt'
const DRAFT_SOURCE_FILE = 'draft-source.json'
const MISSING_PROJECT_FOLDER_ERROR =
  'The project folder is missing. It may have been moved or renamed. Choose the folder again.'
type ProjectChangeListener = (state: ProjectState | null) => void

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
}

function missingProjectFolderError(error?: unknown): Error {
  if (error && !isMissingPathError(error)) {
    return error instanceof Error ? error : new Error('Could not save the project.')
  }
  return new Error(MISSING_PROJECT_FOLDER_ERROR)
}

export const DEFAULT_VISUAL_BIBLE: VisualBible = {
  name: 'Clean 2D Cartoon Explainer',
  style:
    'Clean, friendly 2D cartoon illustration on a white background. Use thick, smooth near-black outlines, rounded complete bodies, simplified anatomy, flat warm color fills, clear silhouettes, and expressive poses. Characters should feel like polished storybook cartoon art with consistent proportions, not line drawings. Keep recurring characters recognizable and fully colored in every scene. No photorealism or 3D rendering.',
  characters:
    'Use rounded cartoon humans and animals with complete heads, torsos, limbs, natural human hands or animal paws, hair or fur, clothing, and readable expressive faces. Keep animals anatomically natural and quadrupedal by default: an animal carrying, retrieving, bringing, or holding an object uses its mouth unless a cute anthropomorphic scene is explicitly requested. Never add human arms or hands, extra limbs, or upright human anatomy to an animal without that explicit direction. Every visible character must have two visible eyes, expressive eyebrows, a simple nose or facial mark, and a clearly shaped mouth that communicates the emotion and action. Preserve each character’s body proportions, face design, colors, hair or fur, clothing, accessories, and markings whenever that character appears. When the recurring protagonist appears, repeat the same full set of solid flat colors and identifying details. Do not force the recurring protagonist into every frame. Frame visible characters large enough for their eyes, eyebrows, and mouths to remain visible.',
  mainCharacter: '',
  supportingCharacter: '',
  setting:
    'Clean white background or a very light, uncluttered cartoon environment with simple rounded furniture and props outlined in near-black. Favor recognizable silhouettes, open space, and only the visual elements needed to explain the narration.',
  palette:
    'White background, thick near-black outlines, warm flat skin, fur, and clothing colors, restrained accent colors, and minimal flat color variation for readable markings. Use black or dark-gray text only when explicitly requested. Avoid gradients, heavy shadows, textures, and complex color blends.',
  camera:
    'Flat 2D cartoon composition, mostly medium or wide shots, front-facing readable staging, balanced rounded silhouettes, clear gestures, and consistent 16:9 framing. No lens blur, depth of field, cinematic lighting, or dramatic perspective.',
  negativePrompt:
    'photorealism, 3D rendering, cinematic lighting, gradients, heavy shading, shadows, textures, painterly detail, realistic anatomy, realistic faces, stick figures, stickman, line-body characters, circular-head-only characters, extra arms, extra hands, extra legs, extra paws, human hands on animals, human arms on animals, unrequested anthropomorphic anatomy, black-and-white protagonist, monochrome protagonist, unfilled protagonist, blank faces, expressionless faces, extra limbs, duplicate characters, inconsistent proportions, inconsistent line weight, clutter, unreadable text, logos, watermarks, visual noise',
}

const LEGACY_VISUAL_BIBLE: VisualBible = {
  name: 'Clean cinematic explainer',
  style: 'Simple, high-contrast editorial animation with crisp silhouettes and deliberate motion.',
  characters: 'Use the project character references consistently. Keep proportions, clothing, and facial design stable.',
  mainCharacter: '',
  supportingCharacter: '',
  setting: 'A clean, uncluttered environment that supports the narration.',
  palette: 'Warm white background, charcoal black linework, one restrained accent color.',
  camera: 'Clear compositions, readable framing, subtle camera movement, no distracting lens effects.',
  negativePrompt:
    'unreadable text, warped hands, duplicate characters, extra limbs, muddy contrast, accidental logos, visual noise',
}

const LEGACY_STICKMAN_VISUAL_BIBLE: VisualBible = {
  name: 'Stickman MS Paint Explainer',
  style:
    'Minimal hand-drawn MS Paint stickman illustration on a white canvas. Use rough 1–3 px near-black lines, simple round heads, expressive poses, flat 2D shapes, intentionally crude brush edges, and a clean readable composition. No realism or polished animation styling.',
  characters:
    'Use simple stick figures with circular heads, line bodies, two-line arms and legs, and tiny expressive faces. Keep head size, limb proportions, line weight, and identifying accessories consistent in every scene. Use one recurring protagonist with a single flat accent color.',
  mainCharacter: '',
  supportingCharacter: '',
  setting:
    'Sparse white MS Paint canvas with only the simple black-outline props and environment elements needed to explain the narration. Favor recognizable silhouettes and lots of negative space.',
  palette:
    'Pure white background, near-black linework, black or dark-gray text only when explicitly requested, plus one or two flat accent colors. No gradients, textures, shadows, or complex color blends.',
  camera:
    'Flat orthographic 2D view, mostly medium or wide compositions, front-facing readable staging, simple cutout-like poses, clear silhouettes, and consistent 16:9 framing. No lens blur, depth of field, cinematic lighting, or dramatic perspective.',
  negativePrompt:
    'photorealism, 3D rendering, cinematic lighting, gradients, shading, shadows, textures, painterly detail, polished vector art, realistic anatomy, realistic faces, extra limbs, duplicate characters, inconsistent proportions, inconsistent line weight, clutter, unreadable text, logos, watermarks, visual noise',
}

function createLine(
  text: string,
  index: number,
  startTime: number,
  endTime: number,
  visualBible: VisualBible,
  paragraphIndex = 0,
  stillBeats?: StillCastBeat[],
  shotNote?: string,
): ScriptLine {
  const beats = stillBeats && stillBeats.length > 0 ? stillBeats : undefined
  return {
    id: randomUUID(),
    index,
    paragraphIndex,
    text,
    ...(shotNote?.trim() ? { shotNote: shotNote.trim() } : {}),
    startTime,
    endTime,
    duration: Number((endTime - startTime).toFixed(2)),
    status: 'draft',
    scenePrompt: composeScenePrompt(text),
    directionStatus: beats ? 'complete' : 'draft',
    sceneStatus: 'draft',
    ...(beats
      ? {
          stillBeats: beats,
          sceneDescription: stillCastDirectionSummary(beats),
        }
      : {}),
  }
}

function createManifest(name: string, visualBible?: VisualBible): ProjectManifest {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    lines: [],
    visualBible: structuredClone(visualBible || DEFAULT_VISUAL_BIBLE),
    exportSettings: structuredClone(DEFAULT_EXPORT_SETTINGS),
    trailer: createTrailerSequence(),
  }
}

function createTrailerSequence(): SequenceManifest {
  return {
    lines: [],
    scriptFile: 'trailer/script.txt',
    exportSettings: structuredClone(TRAILER_EXPORT_SETTINGS),
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function normalizeScriptCreatorDraft(value: Partial<ScriptCreatorDraft> | undefined): ScriptCreatorDraft {
  const source = value?.source
  const normalizedSource =
    source && typeof source.topic === 'string' && typeof source.bible === 'string'
      ? {
          topic: source.topic,
          bible: source.bible,
          ...(typeof source.biblePath === 'string' ? { biblePath: source.biblePath } : {}),
          ...(typeof source.draftFingerprint === 'string'
            ? { draftFingerprint: source.draftFingerprint }
            : {}),
        }
      : undefined
  return {
    topic: typeof value?.topic === 'string' ? value.topic : '',
    draft: typeof value?.draft === 'string' ? value.draft : '',
    ...(normalizedSource ? { source: normalizedSource } : {}),
  }
}

function normalizeManifest(raw: Partial<ProjectManifest>, fallbackName: string): ProjectManifest {
  const base = createManifest(raw.name || fallbackName)
  const rawVisualBible = raw.visualBible || {}
  const visualBible = isLegacyVisualBible(rawVisualBible)
    ? structuredClone(DEFAULT_VISUAL_BIBLE)
    : { ...base.visualBible, ...rawVisualBible }
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map((line) => normalizeLinePrompt(line))
    : []

  return {
    ...base,
    ...raw,
    version: 1,
    visualBible,
    exportSettings: normalizeExportSettings(raw.exportSettings, base.exportSettings),
    lines,
    qwenParagraphMasters: normalizeQwenParagraphMasters(raw.qwenParagraphMasters),
    trailer: normalizeSequence(raw.trailer, base.trailer!),
    videoIdea: normalizeVideoIdeaSession(raw.videoIdea),
  }
}

function normalizeSequence(
  raw: Partial<SequenceManifest> | undefined,
  base: SequenceManifest,
): SequenceManifest {
  const lines = Array.isArray(raw?.lines)
    ? raw.lines.map((line) => normalizeLinePrompt(line))
    : []
  if (lines.length > 0) lines[lines.length - 1].role ||= 'cta'
  return {
    ...base,
    ...raw,
    lines,
    qwenParagraphMasters: normalizeQwenParagraphMasters(raw?.qwenParagraphMasters),
    exportSettings: normalizeExportSettings(raw?.exportSettings, base.exportSettings),
  }
}

function exportSettingsNeedPersist(raw: Partial<ProjectManifest>, manifest: ProjectManifest): boolean {
  return (
    raw.exportSettings?.width !== manifest.exportSettings.width ||
    raw.exportSettings?.height !== manifest.exportSettings.height ||
    raw.trailer?.exportSettings?.width !== manifest.trailer?.exportSettings.width ||
    raw.trailer?.exportSettings?.height !== manifest.trailer?.exportSettings.height
  )
}

function normalizeQwenParagraphMasters(
  value: unknown,
): QwenParagraphMaster[] | undefined {
  if (!Array.isArray(value)) return undefined
  const masters = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const rawMaster = candidate as Partial<QwenParagraphMaster>
    const paragraphIndex = rawMaster.paragraphIndex
    const durationMs = rawMaster.durationMs
    if (
      rawMaster.version !== 1 ||
      !Number.isInteger(paragraphIndex) ||
      paragraphIndex === undefined ||
      paragraphIndex < 0 ||
      !Array.isArray(rawMaster.lineIds) ||
      rawMaster.lineIds.some((lineId) => typeof lineId !== 'string' || !lineId) ||
      typeof rawMaster.masterPath !== 'string' ||
      !rawMaster.masterPath ||
      !Number.isFinite(durationMs) ||
      durationMs === undefined ||
      durationMs <= 0 ||
      typeof rawMaster.createdAt !== 'string'
    ) {
      return []
    }
    const alignmentStatus: QwenParagraphMaster['alignmentStatus'] =
      rawMaster.alignmentStatus === 'aligned' ||
      rawMaster.alignmentStatus === 'failed'
        ? rawMaster.alignmentStatus
        : 'pending'
    return [{
      version: 1 as const,
      paragraphIndex,
      lineIds: rawMaster.lineIds,
      masterPath: rawMaster.masterPath,
      ...(typeof rawMaster.masterFingerprint === 'string' && rawMaster.masterFingerprint
        ? { masterFingerprint: rawMaster.masterFingerprint }
        : {}),
      durationMs,
      createdAt: rawMaster.createdAt,
      alignmentStatus,
      ...(typeof rawMaster.alignmentReportPath === 'string' && rawMaster.alignmentReportPath
        ? { alignmentReportPath: rawMaster.alignmentReportPath }
        : {}),
      ...(typeof rawMaster.alignmentError === 'string' && rawMaster.alignmentError
        ? { alignmentError: rawMaster.alignmentError }
        : {}),
    }]
  })
  return masters.length > 0 ? masters : []
}

function normalizeLinePrompt(line: ScriptLine): ScriptLine {
  const cleanedPrompt = stripVisualBible(line.scenePrompt || composeScenePrompt(line.text))
  const sceneRecord = normalizeSceneRecord(line.sceneRecord, line.id)
  const sceneDescription =
    line.sceneDescription?.trim() ||
    sceneRecord?.direction.trim() ||
    extractSceneDescription(cleanedPrompt)
  const hasManualDirection =
    line.directionStatus === 'complete' &&
    cleanedPrompt.trim() !== composeScenePrompt(line.text).trim()
  const scenePrompt = sceneDescription
    ? composeScenePrompt(line.text, sceneDescription)
    : cleanedPrompt || composeScenePrompt(line.text)
  const directionStatus =
    line.directionStatus === 'generating'
      ? 'generating'
      : line.directionStatus === 'failed'
        ? 'failed'
        : sceneDescription || hasManualDirection
          ? 'complete'
          : 'draft'

  return {
    ...line,
    scenePrompt,
    promptRefinement: line.promptRefinement?.trim() || undefined,
    sceneDescription: sceneDescription || undefined,
    sceneRecord: sceneRecord
      ? {
          ...sceneRecord,
          direction: sceneDescription || sceneRecord.direction,
        }
      : undefined,
    directionStatus,
    directionError: line.directionError,
    shotNote: line.shotNote?.trim() || undefined,
    stillBeats: (() => {
      const beats = normalizeStillBeats(line.stillBeats)
      return beats.length > 0 ? beats : undefined
    })(),
    imageTags: (() => {
      const tags = normalizeStringArray(line.imageTags)
      return tags.length > 0 ? tags : undefined
    })(),
  }
}

function normalizeSceneRecord(
  value: ScriptLine['sceneRecord'],
  lineId: string,
): ScriptLine['sceneRecord'] {
  if (!value || value.version !== 1 || value.lineId !== lineId) return undefined
  if (!value.sourceFingerprint || !value.direction?.trim()) {
    return undefined
  }
  return {
    version: 1,
    lineId,
    sourceFingerprint: value.sourceFingerprint,
    ...(value.focalSubject?.trim() ? { focalSubject: value.focalSubject.trim() } : {}),
    ...(value.visualAction?.trim() ? { visualAction: value.visualAction.trim() } : {}),
    ...(value.shotType?.trim() ? { shotType: value.shotType.trim() } : {}),
    ...(value.setting?.trim() ? { setting: value.setting.trim() } : {}),
    ...(value.visibleCharacters?.length
      ? { visibleCharacters: normalizeStringArray(value.visibleCharacters) }
      : {}),
    ...(value.visibleProps?.length
      ? { visibleProps: normalizeStringArray(value.visibleProps) }
      : {}),
    ...(value.propState?.trim() ? { propState: value.propState.trim() } : {}),
    ...(value.variationReason?.trim()
      ? { variationReason: value.variationReason.trim() }
      : {}),
    direction: value.direction.trim(),
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function preserveVideoIdea(incoming: ProjectManifest, current: ProjectManifest): void {
  incoming.videoIdea = newerVideoIdeaSession(
    normalizeVideoIdeaSession(incoming.videoIdea),
    normalizeVideoIdeaSession(current.videoIdea),
  )
}

function preserveConcurrentLineAssets(
  incoming: ProjectManifest,
  current: ProjectManifest,
): void {
  invalidateStaleQwenMasters(incoming, current)
  const sequences: Array<[ScriptLine[], ScriptLine[]]> = [[incoming.lines, current.lines]]
  if (incoming.trailer && current.trailer) {
    sequences.push([incoming.trailer.lines, current.trailer.lines])
  }

  for (const [incomingLines, currentLines] of sequences) {
    const currentById = new Map(currentLines.map((line) => [line.id, line]))
    for (const line of incomingLines) {
      const currentLine = currentById.get(line.id)
      if (!currentLine) continue
      const scriptTextChanged = line.text.trim() !== currentLine.text.trim()
      if (scriptTextChanged && currentLine.voiceAlignmentSource) {
        line.voicePath = undefined
        line.voiceRawPath = undefined
        line.voiceTrimStart = undefined
        line.voiceTrimEnd = undefined
        line.voiceCleanupVersion = undefined
        line.voiceCleanupEndPaddingSeconds = undefined
        line.voiceCleanupConfident = undefined
        line.voiceAssetVersion = undefined
        line.voiceSourcePath = undefined
        line.voiceCueStartMs = undefined
        line.voiceCueEndMs = undefined
        line.voiceAlignmentSource = undefined
        line.voiceAlignmentConfidence = undefined
        line.voiceTranscript = undefined
        line.voiceAlignmentError = 'The script text changed; regenerate QWEN audio to refresh its alignment.'
        line.voiceAlignmentReportPath = undefined
        line.status = 'draft'
      }
      if (currentLine.voicePath) {
        if (!scriptTextChanged || !currentLine.voiceAlignmentSource) {
          line.voicePath = currentLine.voicePath
          line.voiceRawPath = currentLine.voiceRawPath
          line.voiceTrimStart = currentLine.voiceTrimStart
          line.voiceTrimEnd = currentLine.voiceTrimEnd
          line.voiceCleanupVersion = currentLine.voiceCleanupVersion
          line.voiceCleanupEndPaddingSeconds = currentLine.voiceCleanupEndPaddingSeconds
          line.voiceCleanupConfident = currentLine.voiceCleanupConfident
          line.voiceAssetVersion = currentLine.voiceAssetVersion
          line.duration = currentLine.duration
          line.status = currentLine.status
          line.voiceSourcePath = currentLine.voiceSourcePath
          line.voiceCueStartMs = currentLine.voiceCueStartMs
          line.voiceCueEndMs = currentLine.voiceCueEndMs
          line.voiceAlignmentSource = currentLine.voiceAlignmentSource
          line.voiceAlignmentConfidence = currentLine.voiceAlignmentConfidence
          line.voiceTranscript = currentLine.voiceTranscript
          line.voiceAlignmentError = currentLine.voiceAlignmentError
          line.voiceAlignmentReportPath = currentLine.voiceAlignmentReportPath
        }
      }
      if (currentLine.imagePath) {
        const promptChanged =
          line.scenePrompt !== currentLine.scenePrompt ||
          JSON.stringify(line.sceneRecord) !== JSON.stringify(currentLine.sceneRecord)
        if (!promptChanged) line.imagePath = currentLine.imagePath
        if (!promptChanged) line.sceneStatus = currentLine.sceneStatus
      }
      if (Array.isArray(line.imageTags)) {
        const tags = normalizeStringArray(line.imageTags)
        line.imageTags = tags.length > 0 ? tags : undefined
      } else if (currentLine.imageTags?.length) {
        const promptChanged =
          line.scenePrompt !== currentLine.scenePrompt ||
          JSON.stringify(line.sceneRecord) !== JSON.stringify(currentLine.sceneRecord)
        if (!promptChanged) line.imageTags = [...currentLine.imageTags]
      }
      if (currentLine.stillBeats?.length && !line.stillBeats?.length) {
        line.stillBeats = structuredClone(currentLine.stillBeats)
      }
    }
  }
}

function invalidateStaleQwenMasters(
  incoming: ProjectManifest,
  current: ProjectManifest,
): void {
  const invalidate = (
    incomingMasters: QwenParagraphMaster[] | undefined,
    incomingLines: ScriptLine[],
    currentLines: ScriptLine[],
  ): QwenParagraphMaster[] | undefined => {
    if (!incomingMasters) return incomingMasters
    const currentById = new Map(currentLines.map((line) => [line.id, line]))
    const incomingById = new Map(incomingLines.map((line) => [line.id, line]))
    return incomingMasters.filter((master) =>
      master.lineIds.every((lineId) => {
        const before = currentById.get(lineId)
        const after = incomingById.get(lineId)
        return Boolean(before && after && before.text.trim() === after.text.trim())
      }),
    )
  }
  incoming.qwenParagraphMasters = invalidate(
    incoming.qwenParagraphMasters,
    incoming.lines,
    current.lines,
  )
  if (incoming.trailer && current.trailer) {
    incoming.trailer.qwenParagraphMasters = invalidate(
      incoming.trailer.qwenParagraphMasters,
      incoming.trailer.lines,
      current.trailer.lines,
    )
  }
}

function extractSceneDescription(prompt: string): string | undefined {
  const marker = prompt.match(/\nScene direction\s*:\s*([\s\S]*)$/i)
  return marker?.[1]?.trim() || undefined
}

function isLegacyVisualBible(value: Partial<VisualBible>): boolean {
  if (value.name === LEGACY_STICKMAN_VISUAL_BIBLE.name) return true
  return [LEGACY_VISUAL_BIBLE].some(
    (legacy) =>
      value.name === legacy.name &&
      value.style === legacy.style &&
      value.characters === legacy.characters &&
      value.setting === legacy.setting &&
      value.palette === legacy.palette &&
      value.camera === legacy.camera &&
      value.negativePrompt === legacy.negativePrompt,
  )
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('flac')) return 'flac'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

const GENERATED_SCENE_IMAGE_PATTERN = /^image-\d+\.(?:png|jpe?g|webp)$/i

async function removeGeneratedSceneImages(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && GENERATED_SCENE_IMAGE_PATTERN.test(entry.name))
      .map((entry) => fs.rm(path.join(directory, entry.name), { force: true })),
  )
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function comparableScriptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

async function restoreParagraphIndices(
  manifest: ProjectManifest,
  rootPath: string,
): Promise<boolean> {
  let changed = false
  const sequences: Array<{ lines: ScriptLine[]; scriptFile: string }> = [
    { lines: manifest.lines, scriptFile: manifest.scriptFile || 'script.txt' },
  ]
  if (manifest.trailer) {
    sequences.push({
      lines: manifest.trailer.lines,
      scriptFile: manifest.trailer.scriptFile || 'trailer/script.txt',
    })
  }

  for (const sequence of sequences) {
    if (
      sequence.lines.length === 0 ||
      sequence.lines.some((line) => Number.isInteger(line.paragraphIndex))
    ) {
      continue
    }
    const scriptPath = path.resolve(rootPath, sequence.scriptFile)
    if (!isInsideRoot(rootPath, scriptPath)) continue

    let parsedLines: ReturnType<typeof splitIntoScriptLines>
    try {
      parsedLines = splitIntoScriptLines(await fs.readFile(scriptPath, 'utf8'))
    } catch {
      continue
    }
    if (
      parsedLines.length !== sequence.lines.length ||
      parsedLines.some(
        (parsed, index) =>
          comparableScriptText(parsed.text) !== comparableScriptText(sequence.lines[index].text),
      )
    ) {
      continue
    }
    parsedLines.forEach((parsed, index) => {
      sequence.lines[index].paragraphIndex = parsed.paragraphIndex
    })
    changed = true
  }
  return changed
}

export class ProjectStore {
  private rootPath: string | null = null
  private manifest: ProjectManifest | null = null
  private scriptCreator: ScriptCreatorDraft = { topic: '', draft: '' }
  private scriptCreatorWriteQueue: Promise<void> = Promise.resolve()
  private readonly scriptCreatorPending = new Map<string, ScriptCreatorDraft>()
  private revision = 0
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly changeListeners = new Set<ProjectChangeListener>()

  onChange(listener: ProjectChangeListener): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  async open(
    folderPath: string,
    options?: { defaultVisualBible?: VisualBible },
  ): Promise<ProjectState> {
    await this.writeQueue
    await fs.mkdir(folderPath, { recursive: true })
    const manifestPath = path.join(folderPath, MANIFEST_FILE)
    let manifest: ProjectManifest
    let manifestNeedsPersist = false

    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<ProjectManifest>
      manifest = normalizeManifest(raw, path.basename(folderPath))
      const folderName = path.basename(path.resolve(folderPath))
      if (manifest.name !== folderName) {
        manifest = { ...manifest, name: folderName }
        manifestNeedsPersist = true
      }
      manifestNeedsPersist =
        manifestNeedsPersist ||
        isLegacyVisualBible(raw.visualBible || {}) ||
        exportSettingsNeedPersist(raw, manifest)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      manifest = createManifest(path.basename(folderPath), options?.defaultVisualBible)
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    }

    this.rootPath = path.resolve(folderPath)
    this.manifest = manifest
    this.scriptCreator = await this.readScriptCreatorFiles()
    this.scriptCreatorPending.set(this.scriptCreatorKey(this.rootPath, manifest.id), this.scriptCreator)
    if (manifestNeedsPersist || (await restoreParagraphIndices(manifest, this.rootPath))) {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    }
    this.revision += 1
    const state = this.state()
    this.notifyChange(state)
    return state
  }

  async close(): Promise<void> {
    await this.writeQueue
    const hadProject = Boolean(this.rootPath || this.manifest)
    this.rootPath = null
    this.manifest = null
    this.scriptCreator = { topic: '', draft: '' }
    if (hadProject) this.revision += 1
    this.notifyChange(null)
  }

  get(): ProjectState | null {
    return this.rootPath && this.manifest ? this.state() : null
  }

  async saveScriptCreator(
    input: Partial<ScriptCreatorDraft> & { expectedProjectId?: string; expectedRootPath?: string },
  ): Promise<ProjectState> {
    this.requireProject()
    const rootPath = this.rootPath!
    const projectId = this.manifest!.id
    if (
      (input.expectedProjectId && input.expectedProjectId !== projectId) ||
      (input.expectedRootPath && path.resolve(input.expectedRootPath) !== rootPath)
    ) {
      throw new Error('The project changed before the script draft could be saved.')
    }
    const key = this.scriptCreatorKey(rootPath, projectId)
    const baseDraft = this.scriptCreatorPending.get(key) || this.scriptCreator
    const next = normalizeScriptCreatorDraft({
      topic: input.topic !== undefined ? input.topic : baseDraft.topic,
      draft: input.draft !== undefined ? input.draft : baseDraft.draft,
      source: input.source !== undefined ? input.source : baseDraft.source,
    })
    this.scriptCreatorPending.set(key, next)
    const persist = async (): Promise<void> => {
      try {
        await fs.access(rootPath)
        const writes = [
          fs.writeFile(path.join(rootPath, DRAFT_TOPIC_FILE), next.topic, 'utf8'),
          fs.writeFile(path.join(rootPath, DRAFT_SCRIPT_FILE), next.draft, 'utf8'),
        ]
        if (next.source) {
          writes.push(
            fs.writeFile(
              path.join(rootPath, DRAFT_SOURCE_FILE),
              JSON.stringify(next.source, null, 2),
              'utf8',
            ),
          )
        }
        await Promise.all(writes)
      } catch (error) {
        throw missingProjectFolderError(error)
      }
    }
    const write = this.scriptCreatorWriteQueue.then(persist)
    this.scriptCreatorWriteQueue = write.catch(() => undefined)
    await write
    if (this.rootPath === rootPath && this.manifest?.id === projectId) {
      this.scriptCreator = next
      return this.state()
    }
    throw new Error('The project changed while the script draft was being saved.')
  }

  async importScript(
    filePath: string,
    sequence: SequenceId = 'main',
    lineMode: ScriptLineMode = 'sentences',
    stillLibraryPath?: string,
  ): Promise<ProjectState> {
    this.requireProject()
    const rawScript = await fs.readFile(filePath, 'utf8')
    return this.importScriptText(rawScript, sequence, lineMode, stillLibraryPath)
  }

  async importScriptText(
    rawScript: string,
    sequence: SequenceId = 'main',
    lineMode: ScriptLineMode = 'sentences',
    stillLibraryPath?: string,
  ): Promise<ProjectState> {
    this.requireProject()
    const parsedLines = splitScript(rawScript, lineMode)
    const expressionFolders =
      lineMode === 'stanzas' ? await this.stillCastFoldersForImport(stillLibraryPath) : []
    const annotatedLines: Array<{
      text: string
      paragraphIndex: number
      expression?: string
      shotNote?: string
    }> = lineMode === 'stanzas' ? applyStillCastScriptPrefixes(parsedLines, expressionFolders) : parsedLines
    const timeline = estimateTimeline(annotatedLines.map((line) => line.text))
    const visualBible = this.manifest!.visualBible
    const lines = annotatedLines.map((parsed, index) => {
      // 9:16 shorts use Custom-9x16 stills only — every line waits for a matching vertical Custom.
      const expression = sequence === 'trailer' ? 'custom' : parsed.expression
      const stillBeats: StillCastBeat[] | undefined =
        sequence === 'trailer'
          ? [{ id: createStillCastBeatId(), text: parsed.text, expression: 'custom' }]
          : expression
            ? [{ id: createStillCastBeatId(), text: parsed.text, expression }]
            : undefined
      return createLine(
        parsed.text,
        index,
        timeline[index].startTime,
        timeline[index].endTime,
        visualBible,
        parsed.paragraphIndex,
        stillBeats,
        parsed.shotNote,
      )
    })
    if (sequence === 'trailer' && lines.length > 0) {
      lines[lines.length - 1].role = 'cta'
    }
    if (sequence === 'main') {
      this.manifest!.lines = lines
      this.manifest!.scriptFile = 'script.txt'
      this.manifest!.qwenParagraphMasters = undefined
      this.manifest!.scriptSummary = undefined
      this.manifest!.scriptSummaryFingerprint = undefined
      this.manifest!.continuityCanon = undefined
    } else {
      const trailer = this.ensureTrailerSequence()
      trailer.lines = lines
      trailer.scriptFile = 'trailer/script.txt'
      trailer.qwenParagraphMasters = undefined
      trailer.scriptSummary = undefined
      trailer.scriptSummaryFingerprint = undefined
      trailer.continuityCanon = undefined
    }
    this.touch()

    const scriptPath =
      sequence === 'main'
        ? path.join(this.rootPath!, 'script.txt')
        : path.join(this.rootPath!, 'trailer', 'script.txt')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(scriptPath, rawScript, 'utf8')
    const saved = await this.save()
    const assignedIds = lines
      .filter((line) => (line.stillBeats || []).length > 0)
      .map((line) => line.id)
    if (assignedIds.length === 0) return saved
    try {
      return await this.assignStillCastImages({
        sequence,
        libraryPath: stillLibraryPath,
        lineIds: assignedIds,
        reroll: true,
      })
    } catch {
      return this.get() || saved
    }
  }

  private async stillCastFoldersForImport(stillLibraryPath?: string) {
    try {
      const scan = await scanStillCastCatalog(stillLibraryPath, this.rootPath!)
      return scan.folders
    } catch {
      return []
    }
  }

  async save(manifest = this.manifest!): Promise<ProjectState> {
    this.requireProject()
    const mergedManifest = structuredClone(manifest)
    preserveConcurrentLineAssets(mergedManifest, this.manifest!)
    preserveVideoIdea(mergedManifest, this.manifest!)
    this.manifest = normalizeManifest(mergedManifest, path.basename(this.rootPath!))
    this.touch()
    const snapshot = structuredClone(this.manifest)
    const revision = ++this.revision
    const manifestPath = path.join(this.rootPath!, MANIFEST_FILE)
    const writeTask = this.writeQueue.then(async () => {
      await this.assertProjectFolderExists()
      try {
        await fs.writeFile(manifestPath, JSON.stringify(snapshot, null, 2), 'utf8')
      } catch (error) {
        throw missingProjectFolderError(error)
      }
    })
    this.writeQueue = writeTask.then(
      () => undefined,
      () => undefined,
    )
    await writeTask
    const state = this.state(snapshot, revision)
    this.notifyChange(state)
    return state
  }

  async saveRecording(payload: RecordingPayload): Promise<ProjectState> {
    this.requireProject()
    const sequence = payload.sequence || this.findSequenceForLine(payload.lineId)
    const line = this.findLine(payload.lineId, sequence)
    if (!line) throw new Error('The selected script line no longer exists.')

    const sceneDirectory = this.sceneDirectory(sequence, line)
    await fs.mkdir(sceneDirectory, { recursive: true })
    const extension = extensionForMime(payload.mimeType)
    const fileName = `voice.${extension}`
    const absolutePath = path.join(sceneDirectory, fileName)
    await fs.writeFile(absolutePath, Buffer.from(payload.data))

    const currentLine = this.findLine(payload.lineId, sequence)
    if (!currentLine) throw new Error('The selected script line no longer exists.')
    currentLine.voicePath = this.relativePath(absolutePath)
    currentLine.voiceAssetVersion = randomUUID()
    currentLine.duration = Number(Math.max(0.1, payload.duration).toFixed(2))
    currentLine.status = 'recorded'
    currentLine.error = undefined
    currentLine.voiceSourcePath = payload.sourcePath
    currentLine.voiceCueStartMs = payload.cueStartMs
    currentLine.voiceCueEndMs = payload.cueEndMs
    currentLine.voiceAlignmentSource = payload.alignmentSource
    currentLine.voiceAlignmentConfidence = payload.alignmentConfidence
    currentLine.voiceTranscript = payload.transcript
    currentLine.voiceAlignmentError = payload.alignmentError
    currentLine.voiceAlignmentReportPath = payload.alignmentReportPath
    await this.applyVoiceTakeCleanup(currentLine, absolutePath, payload.duration)
    this.recalculateTimeline(sequence)
    return this.save()
  }

  async saveStanzaRecording(payload: RecordingPayload): Promise<ProjectState> {
    this.requireProject()
    const sequence = payload.sequence || this.findSequenceForLine(payload.lineId)
    const lines = sequence === 'main' ? this.manifest!.lines : this.ensureTrailerSequence().lines
    const seed = this.findLine(payload.lineId, sequence)
    if (!seed) throw new Error('The selected script line no longer exists.')
    const paragraphIndex = seed.paragraphIndex || 0
    const stanza = lines
      .filter((line) => (line.paragraphIndex || 0) === paragraphIndex)
      .sort((left, right) => left.index - right.index)
    if (stanza.length === 0) throw new Error('That recording stanza no longer exists.')

    const masterDirectory = path.join(
      this.rootPath!,
      ...(sequence === 'trailer' ? ['trailer'] : []),
      'stanzas',
    )
    await fs.mkdir(masterDirectory, { recursive: true })
    const masterExtension = extensionForMime(payload.mimeType)
    const masterPath = path.join(
      masterDirectory,
      `${String(paragraphIndex + 1).padStart(3, '0')}-master.${masterExtension}`,
    )
    await fs.writeFile(masterPath, Buffer.from(payload.data))
    const masterRelative = this.relativePath(masterPath)
    const duration = Number(Math.max(0.1, payload.duration).toFixed(2))
    const segments = await splitStanzaAudio(
      Buffer.from(payload.data),
      payload.mimeType,
      stanza,
      duration,
    )
    const voiceVersion = randomUUID()
    const sliced = stanza.length > 1
    for (const [index, line] of stanza.entries()) {
      const segment = segments[index]
      if (!segment) continue
      const sceneDirectory = this.sceneDirectory(sequence, line)
      await fs.mkdir(sceneDirectory, { recursive: true })
      const extension = sliced ? 'flac' : extensionForMime(payload.mimeType)
      const absolutePath = path.join(sceneDirectory, `voice.${extension}`)
      await fs.writeFile(absolutePath, segment.data)
      line.voicePath = this.relativePath(absolutePath)
      line.voiceAssetVersion = voiceVersion
      line.duration = Number(Math.max(0.1, segment.duration).toFixed(2))
      line.status = 'recorded'
      line.error = undefined
      line.voiceSourcePath = masterRelative
      line.voiceCueStartMs = Math.round(segment.start * 1000)
      line.voiceCueEndMs = Math.round(segment.end * 1000)
      line.voiceAlignmentSource = 'paragraph-aligned'
      await this.applyVoiceTakeCleanup(line, absolutePath, segment.duration)
    }
    this.recalculateTimeline(sequence)
    return this.save()
  }

  async trimVoiceTake(payload: TrimVoiceTakePayload): Promise<ProjectState> {
    this.requireProject()
    const sequence = payload.sequence || this.findSequenceForLine(payload.lineId)
    const line = this.findLine(payload.lineId, sequence)
    if (!line) throw new Error('The selected script line no longer exists.')
    if (!line.voiceRawPath) {
      throw new Error('This take has no raw recording to re-trim. Re-record it first.')
    }

    const rawAbsolutePath = path.join(this.rootPath!, ...line.voiceRawPath.split('/'))
    const cleanedAbsolutePath = line.voicePath
      ? path.join(this.rootPath!, ...line.voicePath.split('/'))
      : path.join(this.sceneDirectory(sequence, line), 'voice.flac')

    let trimStart = line.voiceTrimStart
    let sourceDuration = Math.max(
      line.voiceTrimEnd || 0,
      line.duration || 0,
      payload.trimEndSeconds,
      payload.trimStartSeconds || 0,
      0.1,
    )
    if (typeof trimStart !== 'number' || !Number.isFinite(trimStart)) {
      const detected = await detectSpeechWindowFromRaw(rawAbsolutePath, sourceDuration)
      trimStart = detected.trimStart
      sourceDuration = detected.sourceDuration
    } else if (typeof line.voiceTrimEnd === 'number' && Number.isFinite(line.voiceTrimEnd)) {
      sourceDuration = Math.max(sourceDuration, line.voiceTrimEnd)
    }

    if (typeof payload.trimStartSeconds === 'number' && Number.isFinite(payload.trimStartSeconds)) {
      trimStart = payload.trimStartSeconds
    }
    trimStart = clampVoiceTrimStart(trimStart, payload.trimEndSeconds, sourceDuration)
    const trimEnd = clampVoiceTrimEnd(trimStart, payload.trimEndSeconds, sourceDuration)
    trimStart = clampVoiceTrimStart(trimStart, trimEnd, sourceDuration)
    const rewritten = await rewriteCleanedVoiceTakeFromRaw(rawAbsolutePath, cleanedAbsolutePath, {
      trimStart,
      trimEnd,
      sourceDuration,
      endPaddingSeconds: Math.max(0, 0.25 - Math.max(0, trimEnd - (await detectSpeechWindowFromRaw(rawAbsolutePath, sourceDuration)).trimEnd + 0.1)),
    })

    line.voicePath = this.relativePath(cleanedAbsolutePath)
    line.voiceTrimStart = rewritten.trimStart
    line.voiceTrimEnd = rewritten.trimEnd
    line.voiceCleanupVersion = VOICE_CLEANUP_VERSION
    line.voiceCleanupEndPaddingSeconds = rewritten.endPaddingSeconds
    line.voiceCleanupConfident = true
    line.voiceAssetVersion = randomUUID()
    line.duration = rewritten.durationSeconds
    line.status = 'recorded'
    this.recalculateTimeline(sequence)
    return this.save()
  }

  async resetVoiceTakeCleanup(payload: ResetVoiceTakeCleanupPayload): Promise<ProjectState> {
    this.requireProject()
    const sequence = payload.sequence || this.findSequenceForLine(payload.lineId)
    const line = this.findLine(payload.lineId, sequence)
    if (!line) throw new Error('The selected script line no longer exists.')
    if (!line.voiceRawPath) {
      throw new Error('This take has no raw recording to reset. Re-record it first.')
    }

    const rawAbsolutePath = path.join(this.rootPath!, ...line.voiceRawPath.split('/'))
    const cleanedAbsolutePath = line.voicePath
      ? path.join(this.rootPath!, ...line.voicePath.split('/'))
      : path.join(this.sceneDirectory(sequence, line), 'voice.flac')
    const window = await detectSpeechWindowFromRaw(rawAbsolutePath, line.duration || 1)
    const rewritten = await rewriteCleanedVoiceTakeFromRaw(rawAbsolutePath, cleanedAbsolutePath, window)

    line.voicePath = this.relativePath(cleanedAbsolutePath)
    line.voiceTrimStart = rewritten.trimStart
    line.voiceTrimEnd = rewritten.trimEnd
    line.voiceCleanupVersion = VOICE_CLEANUP_VERSION
    line.voiceCleanupEndPaddingSeconds = rewritten.endPaddingSeconds
    line.voiceCleanupConfident = window.confident
    line.voiceAssetVersion = randomUUID()
    line.duration = rewritten.durationSeconds
    line.status = 'recorded'
    this.recalculateTimeline(sequence)
    return this.save()
  }

  async saveImage(
    lineId: string,
    data: Buffer,
    extension = 'jpg',
    sequence?: SequenceId,
  ): Promise<ProjectState> {
    this.requireProject()
    const resolvedSequence = sequence || this.findSequenceForLine(lineId)
    const line = this.findLine(lineId, resolvedSequence)
    if (!line) throw new Error('The selected scene no longer exists.')

    const sceneDirectory = this.sceneDirectory(resolvedSequence, line)
    await fs.mkdir(sceneDirectory, { recursive: true })
    const absolutePath = path.join(sceneDirectory, `image-01.${extension}`)
    await fs.writeFile(absolutePath, data)
    const currentLine = this.findLine(lineId, resolvedSequence)
    if (!currentLine) throw new Error('The selected scene no longer exists.')
    currentLine.imagePath = this.relativePath(absolutePath)
    currentLine.sceneStatus = 'complete'
    currentLine.error = undefined
    return this.save()
  }

  async assignStillCastImages(input: StillCastAssignInput): Promise<ProjectState> {
    this.requireProject()
    const scan = await scanStillCastCatalog(input.libraryPath, this.rootPath!)
    const resolvedSequence = input.sequence || 'main'
    const trailerCustomOnly = resolvedSequence === 'trailer'
    const skipCustom = Boolean(input.skipCustom) && !trailerCustomOnly
    const customStills = trailerCustomOnly
      ? scan.trailerCustomStills || []
      : scan.customStills || []
    const customFolderLabel = trailerCustomOnly ? 'Custom-9x16' : 'Custom'
    const lines =
      resolvedSequence === 'main' ? this.manifest!.lines : this.ensureTrailerSequence().lines
    const targets = input.lineIds?.length
      ? lines.filter((line) => input.lineIds?.includes(line.id))
      : lines.filter(
          (line) =>
            (line.stillBeats || []).length > 0 ||
            (!skipCustom && Boolean(matchCustomStillToLine(line.text, customStills))),
        )
    if (targets.length === 0) {
      throw new Error(
        trailerCustomOnly
          ? 'Drop vertical stills named after each short line into the project Custom-9x16 folder, then assign stills.'
          : 'Cast expressions onto the script, or drop images named after script lines into the project Custom folder, then assign stills.',
      )
    }

    const usedSources: string[] = []
    for (const line of targets) {
      const stillDirectory = path.join(
        this.rootPath!,
        ...(resolvedSequence === 'trailer' ? ['trailer'] : []),
        'stills',
        String(line.index + 1).padStart(3, '0'),
      )
      await fs.mkdir(stillDirectory, { recursive: true })
      const existingBeats = normalizeStillBeats(line.stillBeats)
      const wantsCustom =
        trailerCustomOnly ||
        (!skipCustom &&
          (existingBeats.length === 0 ||
            existingBeats.some((beat) => isCustomStillCastExpression(beat.expression))))
      const custom = !wantsCustom ? undefined : matchCustomStillToLine(line.text, customStills)
      if (custom) {
        const existing = normalizeStillBeats(line.stillBeats)
        for (const beat of existing) {
          if (beat.imagePath) {
            await this.removeStillCastImage(beat.imagePath)
          }
        }
        const extension = path.extname(custom.imagePath).toLowerCase() || '.png'
        const beatId = existing[0]?.id || createStillCastBeatId()
        const absolutePath = path.join(stillDirectory, `${beatId}-${randomUUID().slice(0, 8)}${extension}`)
        await this.writeStillCastImage(custom.imagePath, absolutePath, resolvedSequence)
        const imagePath = this.relativePath(absolutePath)
        line.stillBeats = [
          {
            id: beatId,
            text: line.text,
            expression: 'custom',
            imagePath,
          },
        ]
        line.imagePath = imagePath
        line.sceneStatus = 'complete'
        line.directionStatus = 'complete'
        line.sceneDescription = `Custom still: ${custom.fileName}`
        line.error = undefined
        continue
      }

      if (trailerCustomOnly) {
        const existing = normalizeStillBeats(line.stillBeats)
        for (const beat of existing) {
          if (beat.imagePath) {
            await this.removeStillCastImage(beat.imagePath)
          }
        }
        const beatId = existing[0]?.id || createStillCastBeatId()
        line.stillBeats = [
          {
            id: beatId,
            text: line.text,
            expression: 'custom',
          },
        ]
        line.imagePath = undefined
        line.sceneDescription = 'Custom-9x16 still pending'
        line.sceneStatus = 'draft'
        line.directionStatus = 'complete'
        line.error = `Drop an image named after this line into the project ${customFolderLabel} folder, then assign stills.`
        continue
      }

      const beats = normalizeStillBeats(line.stillBeats)
      if (beats.length === 0) continue
      const primaryExpression = beats[0].expression
      const sameExpression = beats.every((beat) => beat.expression === primaryExpression)
      let workBeats = beats
      if (beats.length > 1 && sameExpression && !isCustomStillCastExpression(primaryExpression)) {
        for (const beat of beats) {
          if (beat.imagePath) {
            await this.removeStillCastImage(beat.imagePath)
          }
        }
        workBeats = [
          {
            id: beats[0].id,
            text: line.text,
            expression: primaryExpression,
          },
        ]
      }
      const nextBeats = []
      for (const beat of workBeats) {
        if (!input.reroll && beat.imagePath) {
          nextBeats.push(beat)
          continue
        }
        if (beat.imagePath) {
          await this.removeStillCastImage(beat.imagePath)
        }
        const expression = beat.expression
        if (isCustomStillCastExpression(expression)) {
          nextBeats.push({ ...beat, imagePath: undefined })
          continue
        }
        const sourcePath = pickStillImage(expression, scan, usedSources)
        if (!sourcePath) {
          nextBeats.push({ ...beat, imagePath: undefined })
          continue
        }
        usedSources.push(sourcePath)
        const extension = path.extname(sourcePath).toLowerCase() || '.png'
        const absolutePath = path.join(
          stillDirectory,
          `${beat.id}-${randomUUID().slice(0, 8)}${extension}`,
        )
        await this.writeStillCastImage(sourcePath, absolutePath, resolvedSequence)
        nextBeats.push({
          ...beat,
          expression,
          imagePath: this.relativePath(absolutePath),
        })
      }
      line.stillBeats = nextBeats
      line.imagePath = nextBeats.find((beat) => beat.imagePath)?.imagePath
      line.sceneDescription = stillCastDirectionSummary(nextBeats)
      line.sceneStatus = lineStillCastImagesReady(line) ? 'complete' : 'draft'
      line.error = lineStillCastImagesReady(line)
        ? undefined
        : nextBeats.some((beat) => isCustomStillCastExpression(beat.expression))
          ? `Drop an image named after this line into the project ${customFolderLabel} folder, then assign stills.`
          : 'Add stills to the missing expression folders, or drop an image named after this line into Custom, then assign again.'
    }
    return this.save()
  }

  /** Assign a generated Custom still only while its captured project and source remain current. */
  async assignCustomImageIfCurrent(input: {
    expectedRootPath: string
    expectedProjectId: string
    lineId: string
    expectedLineText: string
    expectedShotNote?: string
    generatedFileName?: string
    libraryPath?: string
    validateSource: () => Promise<boolean>
    validateContext: () => boolean
  }): Promise<ProjectState> {
    const rootPath = path.resolve(input.expectedRootPath)
    const isExpectedProject = (): boolean =>
      this.rootPath === rootPath && this.manifest?.id === input.expectedProjectId
    const getLine = (): ScriptLine | undefined =>
      this.manifest?.lines.find((line) => line.id === input.lineId)
    const isExpectedLine = (): boolean => {
      const line = getLine()
      return Boolean(
          line &&
          line.text === input.expectedLineText &&
          (line.shotNote || '') === (input.expectedShotNote || '') &&
          (line.stillBeats || []).some((beat) => isCustomStillCastExpression(beat.expression)),
      )
    }

    if (!isExpectedProject() || !isExpectedLine() || !input.validateContext()) {
      throw new Error('The project or Custom line changed before assignment.')
    }
    const catalog = await scanStillCastCatalog(input.libraryPath, rootPath)
    if (!(await input.validateSource()) || !isExpectedProject() || !isExpectedLine() || !input.validateContext()) {
      throw new Error('The project or Custom image source changed before assignment.')
    }
    const line = getLine()!
    const custom = input.generatedFileName
      ? (catalog.customStills || []).find((still) => still.fileName === input.generatedFileName)
      : matchCustomStillToLine(line.text, catalog.customStills || [])
    if (!custom) throw new Error('The generated Custom still is no longer in the project Custom folder.')

    const stillDirectory = path.join(rootPath, 'stills', String(line.index + 1).padStart(3, '0'))
    await fs.mkdir(stillDirectory, { recursive: true })
    const extension = path.extname(custom.imagePath).toLowerCase() || '.png'
    const beatId = normalizeStillBeats(line.stillBeats)[0]?.id || createStillCastBeatId()
    const destination = path.join(stillDirectory, `${beatId}-${randomUUID().slice(0, 8)}${extension}`)
    await fs.copyFile(custom.imagePath, destination)
    if (!(await input.validateSource()) || !isExpectedProject() || !isExpectedLine() || !input.validateContext()) {
      await fs.rm(destination, { force: true })
      throw new Error('The project or Custom image source changed before assignment.')
    }

    const currentLine = getLine()!
    const imagePath = path.relative(rootPath, destination).split(path.sep).join('/')
    currentLine.stillBeats = [{ id: beatId, text: currentLine.text, expression: 'custom', imagePath }]
    currentLine.imagePath = imagePath
    currentLine.sceneStatus = 'complete'
    currentLine.directionStatus = 'complete'
    currentLine.sceneDescription = `Custom still: ${custom.fileName}`
    currentLine.error = undefined
    return this.save()
  }

  async setStillCastExpression(input: StillCastExpressionInput): Promise<ProjectState> {
    this.requireProject()
    const sequence = input.sequence || this.findSequenceForLine(input.lineId)
    const line = this.findLine(input.lineId, sequence)
    if (!line) throw new Error('The selected script line no longer exists.')
    const expression = slugStillCastName(input.expression)
    if (!expression) throw new Error('Choose an expression folder.')
    const beats = normalizeStillBeats(line.stillBeats)
    const targetBeatId = input.beatId || beats[0]?.id || createStillCastBeatId()
    line.stillBeats = [{ id: targetBeatId, text: line.text, expression }]
    line.sceneDescription = stillCastDirectionSummary(line.stillBeats)
    line.directionStatus = 'complete'
    line.error = undefined
    return this.assignStillCastImages({
      sequence,
      libraryPath: input.libraryPath,
      lineIds: [line.id],
      reroll: true,
      skipCustom: expression !== 'custom',
    })
  }

  async resetSceneGenerationCache(sequence: SequenceId = 'main'): Promise<ProjectState> {
    this.requireProject()
    const target = sequence === 'main' ? this.manifest! : this.ensureTrailerSequence()

    await Promise.all(
      target.lines.map((line) => removeGeneratedSceneImages(this.sceneDirectory(sequence, line))),
    )

    for (const line of target.lines) {
      line.scenePrompt = composeScenePrompt(line.text)
      line.sceneRecord = undefined
      line.sceneDescription = undefined
      line.directionStatus = 'draft'
      line.directionError = undefined
      line.sceneStatus = 'draft'
      line.imagePath = undefined
      line.stillBeats = undefined
      line.imageGenerator = undefined
      line.higgsRequestId = undefined
      line.higgsStatus = undefined
      line.comfyPromptId = undefined
      line.error = undefined
    }
    return this.save()
  }

  async assetDataUrl(relativePath: string): Promise<AssetData | null> {
    this.requireProject()
    const absolutePath = path.resolve(this.rootPath!, relativePath)
    if (!isInsideRoot(this.rootPath!, absolutePath)) {
      throw new Error('Asset path is outside the active project.')
    }

    try {
      const data = await fs.readFile(absolutePath)
      const extension = path.extname(absolutePath).toLowerCase()
      const mimeType =
        extension === '.png'
          ? 'image/png'
          : extension === '.webp'
            ? 'image/webp'
            : extension === '.flac'
              ? 'audio/flac'
              : extension === '.mp3'
                ? 'audio/mpeg'
                : extension === '.m4a'
                  ? 'audio/mp4'
                  : extension === '.wav'
                    ? 'audio/wav'
                    : extension === '.ogg'
                      ? 'audio/ogg'
                      : extension === '.webm'
                        ? 'audio/webm'
                        : 'image/jpeg'
      return { dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, mimeType }
    } catch {
      return null
    }
  }

  async audioPeaks(relativePath: string, bucketCount = 220): Promise<number[] | null> {
    this.requireProject()
    const absolutePath = path.resolve(this.rootPath!, relativePath)
    if (!isInsideRoot(this.rootPath!, absolutePath)) {
      throw new Error('Asset path is outside the active project.')
    }
    try {
      await fs.access(absolutePath)
      return await computeAudioPeaks(absolutePath, bucketCount)
    } catch {
      return null
    }
  }

  async assetThumbDataUrl(
    relativePath: string,
    maxEdge = DEFAULT_THUMB_MAX_EDGE,
  ): Promise<AssetData | null> {
    this.requireProject()
    const absolutePath = path.resolve(this.rootPath!, relativePath)
    if (!isInsideRoot(this.rootPath!, absolutePath)) {
      throw new Error('Asset path is outside the active project.')
    }
    const extension = path.extname(absolutePath).toLowerCase()
    if (['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm'].includes(extension)) {
      return this.assetDataUrl(relativePath)
    }
    return imageThumbDataUrl(this.rootPath!, absolutePath, maxEdge)
  }

  getRootPath(): string {
    this.requireProject()
    return this.rootPath!
  }

  getManifest(): ProjectManifest {
    this.requireProject()
    return this.manifest!
  }

  getSequenceManifest(sequence: SequenceId = 'main'): SequenceManifest {
    this.requireProject()
    if (sequence === 'main') {
      return {
        lines: this.manifest!.lines,
        scriptFile: this.manifest!.scriptFile,
        scriptSummary: this.manifest!.scriptSummary,
        scriptSummaryFingerprint: this.manifest!.scriptSummaryFingerprint,
        continuityCanon: this.manifest!.continuityCanon,
        qwenParagraphMasters: this.manifest!.qwenParagraphMasters,
        exportSettings: this.manifest!.exportSettings,
      }
    }
    return this.ensureTrailerSequence()
  }

  async saveQwenParagraphMaster(
    sequence: SequenceId,
    master: QwenParagraphMaster,
  ): Promise<ProjectState> {
    this.requireProject()
    const target = sequence === 'main' ? this.manifest! : this.ensureTrailerSequence()
    target.qwenParagraphMasters = [
      ...(target.qwenParagraphMasters || []).filter(
        (candidate) => candidate.paragraphIndex !== master.paragraphIndex,
      ),
      master,
    ]
    return this.save()
  }

  async updateQwenParagraphMaster(
    sequence: SequenceId,
    paragraphIndex: number,
    patch: Partial<Omit<QwenParagraphMaster, 'version' | 'paragraphIndex' | 'lineIds' | 'masterPath' | 'durationMs' | 'createdAt'>>,
  ): Promise<ProjectState> {
    this.requireProject()
    const target = sequence === 'main' ? this.manifest! : this.ensureTrailerSequence()
    const master = target.qwenParagraphMasters?.find(
      (candidate) => candidate.paragraphIndex === paragraphIndex,
    )
    if (!master) throw new Error(`QWEN paragraph master ${paragraphIndex + 1} is not saved.`)
    Object.assign(master, patch)
    return this.save()
  }

  async invalidateQwenParagraphCues(
    sequence: SequenceId,
    paragraphIndex: number,
    error: string,
    masterFingerprint?: string,
  ): Promise<ProjectState> {
    this.requireProject()
    const target = sequence === 'main' ? this.manifest! : this.ensureTrailerSequence()
    for (const line of target.lines) {
      if (line.paragraphIndex !== paragraphIndex || !line.voiceAlignmentSource) continue
      line.voicePath = undefined
      line.voiceRawPath = undefined
      line.voiceTrimStart = undefined
      line.voiceTrimEnd = undefined
      line.voiceCleanupVersion = undefined
      line.voiceCleanupEndPaddingSeconds = undefined
      line.voiceCleanupConfident = undefined
      line.voiceAssetVersion = undefined
      line.voiceSourcePath = undefined
      line.voiceCueStartMs = undefined
      line.voiceCueEndMs = undefined
      line.voiceAlignmentSource = undefined
      line.voiceAlignmentConfidence = undefined
      line.voiceTranscript = undefined
      line.voiceAlignmentError = error
      line.voiceAlignmentReportPath = undefined
      line.status = 'draft'
    }
    const master = target.qwenParagraphMasters?.find(
      (candidate) => candidate.paragraphIndex === paragraphIndex,
    )
    if (master) {
      master.alignmentStatus = 'failed'
      master.alignmentError = error
      if (masterFingerprint) master.masterFingerprint = masterFingerprint
    }
    this.recalculateTimeline(sequence)
    return this.save()
  }

  findLine(lineId: string, sequence?: SequenceId): ScriptLine | undefined {
    if (sequence) return this.getSequenceManifest(sequence).lines.find((line) => line.id === lineId)
    return (
      this.manifest?.lines.find((line) => line.id === lineId) ||
      this.manifest?.trailer?.lines.find((line) => line.id === lineId)
    )
  }

  private findSequenceForLine(lineId: string): SequenceId {
    if (this.manifest?.lines.some((line) => line.id === lineId)) return 'main'
    if (this.manifest?.trailer?.lines.some((line) => line.id === lineId)) return 'trailer'
    throw new Error('The selected scene no longer exists.')
  }

  private ensureTrailerSequence(): SequenceManifest {
    if (!this.manifest!.trailer) this.manifest!.trailer = createTrailerSequence()
    return this.manifest!.trailer
  }

  private sceneDirectory(sequence: SequenceId, line: ScriptLine): string {
    return path.join(
      this.rootPath!,
      ...(sequence === 'trailer' ? ['trailer'] : []),
      'scenes',
      String(line.index + 1).padStart(3, '0'),
    )
  }

  private recalculateTimeline(sequence: SequenceId = 'main'): void {
    let cursor = 0
    this.getSequenceManifest(sequence).lines.forEach((line, index) => {
      const duration = Math.max(0.1, line.duration || 0.8)
      line.index = index
      line.startTime = Number(cursor.toFixed(2))
      line.endTime = Number((cursor + duration).toFixed(2))
      cursor = line.endTime
    })
  }

  private async readScriptCreatorFiles(): Promise<ScriptCreatorDraft> {
    this.requireProject()
    const [topic, draftFile, scriptFile, sourceFile] = await Promise.all([
      readOptionalText(path.join(this.rootPath!, DRAFT_TOPIC_FILE)),
      readOptionalText(path.join(this.rootPath!, DRAFT_SCRIPT_FILE)),
      readOptionalText(path.join(this.rootPath!, 'script.txt')),
      readOptionalText(path.join(this.rootPath!, DRAFT_SOURCE_FILE)),
    ])
    let source: ScriptCreatorDraft['source']
    try {
      const parsed: unknown = JSON.parse(sourceFile)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'topic' in parsed &&
        typeof parsed.topic === 'string' &&
        'bible' in parsed &&
        typeof parsed.bible === 'string'
      ) {
        source = {
          topic: parsed.topic,
          bible: parsed.bible,
          ...('biblePath' in parsed && typeof parsed.biblePath === 'string'
            ? { biblePath: parsed.biblePath }
            : {}),
          ...('draftFingerprint' in parsed && typeof parsed.draftFingerprint === 'string'
            ? { draftFingerprint: parsed.draftFingerprint }
            : {}),
        }
      }
    } catch {
      // Missing and malformed source metadata leave the existing draft source unknown.
    }
    return normalizeScriptCreatorDraft({
      topic,
      draft: draftFile.trim() ? draftFile : scriptFile,
      source,
    })
  }

  private scriptCreatorKey(rootPath: string, projectId: string): string {
    return `${projectId}\n${path.resolve(rootPath).toLowerCase()}`
  }

  private async writeStillCastImage(
    sourcePath: string,
    destinationPath: string,
    _sequence: SequenceId,
  ): Promise<void> {
    // Trailer stills are authored as true 9:16 Custom-9x16 images — copy as-is.
    await fs.copyFile(sourcePath, destinationPath)
  }

  private async removeStillCastImage(relativePath: string): Promise<void> {
    const root = this.getRootPath()
    const target = path.resolve(root, relativePath)
    if (target === root || !isInsideRoot(root, target)) {
      throw new Error('Still image path is outside the active project.')
    }
    try {
      const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)])
      if (realTarget === realRoot || !isInsideRoot(realRoot, realTarget)) {
        throw new Error('Still image path is outside the active project.')
      }
      await fs.rm(target, { force: true })
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
  }

  private async applyVoiceTakeCleanup(
    line: ScriptLine,
    absoluteVoicePath: string,
    fallbackDurationSeconds: number,
  ): Promise<void> {
    const root = this.getRootPath()
    const projectId = this.manifest!.id
    let cleanupPatch: Partial<ScriptLine>
    try {
      const cleaned = await cleanupRecordedVoiceTake(absoluteVoicePath, fallbackDurationSeconds)
      cleanupPatch = {
        voicePath: path.relative(root, cleaned.cleanedAbsolutePath).split(path.sep).join('/'),
        voiceRawPath: path.relative(root, cleaned.rawAbsolutePath).split(path.sep).join('/'),
        voiceTrimStart: cleaned.trimStart,
        voiceTrimEnd: cleaned.trimEnd,
        voiceCleanupVersion: cleaned.version,
        voiceCleanupEndPaddingSeconds: cleaned.endPaddingSeconds,
        voiceCleanupConfident: cleaned.confident,
        duration: cleaned.durationSeconds,
      }
    } catch {
      // Keep the raw take playable if FFmpeg cleanup cannot run.
      cleanupPatch = {
        voiceRawPath: undefined,
        voiceTrimStart: undefined,
        voiceTrimEnd: undefined,
        voiceCleanupVersion: undefined,
        voiceCleanupEndPaddingSeconds: undefined,
        voiceCleanupConfident: undefined,
      }
    }
    if (this.rootPath !== root || this.manifest?.id !== projectId) {
      throw new Error('The active project changed while saving the recording.')
    }
    const currentLine = this.findLine(line.id)
    if (!currentLine) throw new Error('The selected script line no longer exists.')
    // A concurrent manifest save replaces line objects. Commit only voice fields
    // to the current line so unrelated scene edits survive audio processing.
    Object.assign(currentLine, {
      voicePath: line.voicePath,
      voiceAssetVersion: line.voiceAssetVersion,
      duration: line.duration,
      status: line.status,
      error: line.error,
      voiceSourcePath: line.voiceSourcePath,
      voiceCueStartMs: line.voiceCueStartMs,
      voiceCueEndMs: line.voiceCueEndMs,
      voiceAlignmentSource: line.voiceAlignmentSource,
      voiceAlignmentConfidence: line.voiceAlignmentConfidence,
      voiceTranscript: line.voiceTranscript,
      voiceAlignmentError: line.voiceAlignmentError,
      voiceAlignmentReportPath: line.voiceAlignmentReportPath,
      ...cleanupPatch,
    })
  }

  private relativePath(absolutePath: string): string {
    return path.relative(this.rootPath!, absolutePath).split(path.sep).join('/')
  }

  private touch(): void {
    this.manifest!.updatedAt = new Date().toISOString()
  }

  private state(manifest = this.manifest!, revision = this.revision): ProjectState {
    this.requireProject()
    return {
      rootPath: this.rootPath!,
      manifest: structuredClone(manifest),
      revision,
      scriptCreator: { ...this.scriptCreator },
    }
  }

  private notifyChange(state: ProjectState | null): void {
    for (const listener of this.changeListeners) listener(state)
  }

  private requireProject(): void {
    if (!this.rootPath || !this.manifest) {
      throw new Error('Open a project folder first.')
    }
  }

  private async assertProjectFolderExists(): Promise<void> {
    this.requireProject()
    try {
      const stat = await fs.stat(this.rootPath!)
      if (!stat.isDirectory()) throw missingProjectFolderError()
    } catch (error) {
      throw missingProjectFolderError(error)
    }
  }
}
