import { IDEA_REVIEW_FIELDS, recordIdeaResearch } from '../shared/videoIdeaQuality'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Copy,
  Download,
  FileAudio,
  FileText,
  Filter,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Maximize2,
  Mic,
  Music2,
  PanelLeft,
  PenLine,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Tv,
  WandSparkles,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { VoiceWaveformPreview } from './components/VoiceWaveformPreview'
import { ExpressionToolsPanel } from './ExpressionToolsPanel'
import {
  MIC_PROCESSOR_BUFFER,
  MIC_SILENCE_ADVANCE_MS,
  createSilenceAdvanceTracker,
  rmsFromTimeDomain,
} from './micSilence'
import type {
  AssetData,
  ChannelImageProfile,
  ChannelProductionMode,
  ComfyConnectionStatus,
  ComfyUiSettings,
  DirectionStatus,
  ExportSettings,
  HiggsConnectionStatus,
  ImageGenerator,
  LlmConnectionStatus,
  ProjectManifest,
  ProjectState,
  ScriptCreatorDraft,
  ProductionBiblePreset,
  CustomImageProgress,
  CustomImageSetup,
  QwenTtsGenerateInput,
  QwenTtsProgress,
  QwenTtsStatus,
  RecordingFocusPayload,
  ImageInspectorPayload,
  VoiceInspectorPayload,
  SceneDirectionRecord,
  SceneLedgerEntry,
  ScriptLine,
  SequenceId,
  SequenceManifest,
  StillCastLibraryScan,
  StudioSettings,
  VideoIdeaBrief,
  VideoIdeaSession,
  VisualBible,
  LlmModel,
  LlmReasoningEffort,
  LlmServiceTier,
  LlmStep,
  LlmStepSetting,
  VoiceMode,
} from '../shared/types'
import {
  COMFY_SAMPLERS,
  COMFY_WEIGHT_DTYPES,
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_LLM_SERVICE_TIER,
  DEFAULT_TRAILER_EXPORT_SETTINGS,
  DEFAULT_COMFY_UI_SETTINGS,
  defaultLlmStepSettings,
  LLM_MODEL_LABELS,
  LLM_MODELS,
  LLM_REASONING_EFFORTS,
  LLM_SERVICE_TIERS,
  LLM_STEP_LABELS,
  LLM_STEPS,
  normalizeComfyUiSettings,
} from '../shared/types'
import {
  composeScenePrompt,
  composeScriptDraftPrompt,
  composeTrailerScriptPrompt,
  normalizeScriptDraft,
  normalizeTrailerScript,
  scriptSummaryForSequence,
} from '../shared/promptComposer'
import { ensureDoggoBuxScriptCloser, isDoggoBuxChannel } from '../shared/doggoBuxCloser'
import { reviewScriptDraft } from '../shared/scriptDraftReview'
import { composeVideoIdeaPrompt } from '../shared/videoIdeaPrompt'
import {
  appendVideoIdeaMessage,
  applyVideoIdeaCoachTurn,
  composeChannelBriefFromSnapshot,
  composeScriptTopicFromIdea,
  emptyVideoIdeaSession,
  emptyVideoIdeaChecklist,
  formatVideoIdeaResearch,
  unpaidVideoIdeaGates,
  normalizeVideoIdeaSession,
  parseVideoIdeaResponse,
  recoverVideoIdeaFromRawAssistantMessage,
  shouldAllowVideoIdeaResearch,
  shouldContinueVideoIdeaCoach,
  touchVideoIdeaSession,
  VIDEO_IDEA_MAX_ROUNDS,
  VIDEO_IDEA_MAX_RESEARCH_ROUNDS,
  videoIdeaDemandComplete,
  videoIdeaPackagingComplete,
  videoIdeaReadyForScript,
} from '../shared/videoIdea'
import { sceneContextFingerprint, scenePromptFingerprint } from '../shared/sceneContext'
import {
  parseContinuityCanonResponse,
  parseSceneDirectionResponse,
  sceneLedgerEntry,
} from '../shared/sceneDirection'
import { scenePromptingWorkflowForSettings } from '../shared/imageModels'
import { buildSceneDirectionPrompt } from '../shared/sceneDirectionPrompt'
import {
  channelProfileMatchesCurrent,
  emptyVisualBible,
  normalizeYoutubeChannelHandle,
} from '../shared/channelProfiles'
import {
  expressionPlaybackBeats,
  extractCustomStillCastLines,
  isCustomStillCastExpression,
  lineHasStillCastBeats,
  lineStillCastImagesReady,
  matchCustomStillToLine,
  partitionStillCastTargets,
  spokenStillCastLinesFromScriptLines,
  stillCastDirectionSummary,
  stillCastExpressionLabel,
  stockedStillCastFolders,
} from '../shared/stillCast'
import { stillCastLineVocalExpression } from '../shared/qwenVocalTone'
import { scriptSpeakerCuesForLines } from '../shared/scriptSpeaker'
import { buildStillCastPrompt, parseStillCastResponse } from '../shared/stillCastPrompt'
import {
  adjacentFilteredLine,
  filterLinesForTimeline,
  isRegeneratedImage,
  lineIdsWithImageTag,
  nextRegeneratedLine,
  REGENERATED_IMAGE_TAG,
  type TimelineImageFilter,
  withImageTag,
  withoutImageTag,
} from '../shared/imageTags'
import {
  buildSceneGenerationJobPlans,
  mergeSceneLedgers,
  sceneGenerationWaves,
  sceneLineMatchesSnapshot,
  type SceneGenerationOutcome,
} from '../shared/sceneGeneration'

type StudioSection = 'overview' | 'idea' | 'create' | 'script' | 'visuals' | 'timeline' | 'export' | 'tools'
type WorkflowSection = Exclude<StudioSection, 'overview' | 'idea' | 'create'>

interface Notice {
  type: 'success' | 'error' | 'info'
  message: string
}

interface ContextPromptProgress {
  phase?: 'summary' | 'prompts'
  current: number
  total: number
  completed: number
  lineText: string
  startedAt: number
}

type AssetLineSnapshot = Pick<
  ScriptLine,
  'imagePath' | 'voicePath' | 'voiceAssetVersion' | 'status' | 'sceneStatus'
> & { stillBeatKey?: string }

const ASSET_LOAD_CONCURRENCY = 6

interface SceneGenerationRun {
  id: number
  requestId: string
  projectId: string
  sequence: SequenceId
  sourceFingerprint: string
  state: ProjectState
  targetLineIds: string[]
  targetLineSnapshots: ScriptLine[]
  acceptedLedger: SceneLedgerEntry[]
  outcomes: Map<string, SceneGenerationOutcome>
  cancelled: boolean
}

interface SceneGenerationJob {
  paragraphIndex: number
  chunkIndex: number
  paragraphLines: ScriptLine[]
  targetLines: ScriptLine[]
}

interface SceneGenerationFailure {
  line: ScriptLine
  message: string
}

interface SceneGenerationJobResult {
  job: SceneGenerationJob
  records: SceneDirectionRecord[]
  failures: SceneGenerationFailure[]
}

const navItems: Array<{
  id: WorkflowSection
  label: string
  icon: LucideIcon
}> = [
  { id: 'script', label: 'Script & voice', icon: FileText },
  { id: 'visuals', label: 'Visual direction', icon: ImageIcon },
  { id: 'timeline', label: 'Timeline', icon: Clapperboard },
  { id: 'export', label: 'Export', icon: Download },
]

const AUTOMATIC_IMAGE_GENERATION_KEY = 'higgsfilm:automatic-image-generation'
const MAX_PARAGRAPH_BATCH_LINES = 1
const MAX_PARALLEL_SCENE_AGENTS = 5

function readAutomaticImageGenerationPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTOMATIC_IMAGE_GENERATION_KEY) !== 'off'
  } catch {
    return true
  }
}

const visualBibleFields: Array<{
  key: keyof ProjectManifest['visualBible']
  label: string
  placeholder: string
}> = [
  {
    key: 'style',
    label: 'Style language',
    placeholder: 'Clean 2D cartoon illustration, thick rounded black outlines, white background, flat colors...',
  },
  {
    key: 'characters',
    label: 'Characters & references',
    placeholder: 'Rounded complete bodies, expressive faces, consistent proportions, recurring character details...',
  },
  {
    key: 'mainCharacter',
    label: 'Main character lock',
    placeholder: 'Optional: exact appearance, species/breed, colors, markings, clothing, accessories, and proportions...',
  },
  {
    key: 'supportingCharacter',
    label: 'Supporting character lock',
    placeholder: 'Optional: exact appearance, species/age, colors, clothing, accessories, and distinguishing features...',
  },
  {
    key: 'setting',
    label: 'World & setting',
    placeholder: 'Clean white background, simple rounded props, uncluttered readable staging...',
  },
  {
    key: 'palette',
    label: 'Palette',
    placeholder: 'White background, thick near-black outlines, warm flat colors, minimal shading...',
  },
  {
    key: 'camera',
    label: 'Camera language',
    placeholder: 'Flat 2D cartoon composition, medium/wide shots, readable 16:9 framing...',
  },
  {
    key: 'negativePrompt',
    label: 'Avoid',
    placeholder: 'Photorealism, 3D, shading, gradients, extra limbs, duplicate characters, clutter...',
  },
]

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds)
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = (safeSeconds % 60).toFixed(1).padStart(4, '0')
  return `${String(minutes).padStart(2, '0')}:${remainder}`
}

function formatExportCanvas(settings: ExportSettings): string {
  return `${settings.width} × ${settings.height} · ${settings.fps} fps`
}

function fileNameFromPath(filePath: string): string {
  return filePath.replace(/^.*[/\\]/, '') || filePath
}

/** Clean Codex/ChatGPT CLI errors for the producer (rate limits, auth, etc.). */
function formatLlmFailureMessage(raw: string): string {
  const normalized = raw
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/YouΓÇÖve/g, "You've")
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^ERROR:\s*/i, '').trim())
    .filter(Boolean)
  const unique = [...new Set(normalized)]
  const text = unique.join(' ')
  const limitMatch = text.match(/try again at ([^.]+)/i)
  if (/usage limit/i.test(text)) {
    return limitMatch
      ? `ChatGPT usage limit reached. Try again at ${limitMatch[1].trim()}.`
      : 'ChatGPT usage limit reached. Wait for the reset, then Continue.'
  }
  return unique.slice(0, 2).join(' ') || 'ChatGPT could not complete the request.'
}

function cloneManifest(manifest: ProjectManifest): ProjectManifest {
  return structuredClone(manifest)
}

function projectHasSceneWork(state: ProjectState): boolean {
  const hasWork = (lines: ScriptLine[]): boolean =>
    lines.some((line) => line.sceneRecord || line.imagePath || line.sceneStatus !== 'draft')
  return hasWork(state.manifest.lines) || Boolean(state.manifest.trailer && hasWork(state.manifest.trailer.lines))
}

function invalidateVisualBibleDependentState(manifest: ProjectManifest): void {
  const resetLines = (lines: ScriptLine[]): void => {
    for (const line of lines) {
      line.sceneRecord = undefined
      line.sceneDescription = undefined
      line.scenePrompt = composeScenePrompt(line.text)
      line.directionStatus = 'draft'
      line.directionError = undefined
      line.sceneStatus = 'draft'
      line.imagePath = undefined
      line.imageGenerator = undefined
      line.higgsRequestId = undefined
      line.higgsStatus = undefined
      line.comfyPromptId = undefined
      line.error = undefined
    }
  }

  resetLines(manifest.lines)
  if (manifest.trailer) resetLines(manifest.trailer.lines)
  manifest.scriptSummary = undefined
  manifest.scriptSummaryFingerprint = undefined
  manifest.continuityCanon = undefined
  if (manifest.trailer) {
    manifest.trailer.scriptSummary = undefined
    manifest.trailer.scriptSummaryFingerprint = undefined
    manifest.trailer.continuityCanon = undefined
  }
}

function stanzaLinesFor(line: ScriptLine, lines: readonly ScriptLine[]): ScriptLine[] {
  const paragraphIndex = line.paragraphIndex || 0
  return lines
    .filter((candidate) => (candidate.paragraphIndex || 0) === paragraphIndex)
    .sort((left, right) => left.index - right.index)
}

function nextStanzaFirstLine(line: ScriptLine, lines: readonly ScriptLine[]): ScriptLine | undefined {
  const paragraphIndex = line.paragraphIndex || 0
  return lines
    .slice()
    .sort((left, right) => left.index - right.index)
    .find((candidate) => (candidate.paragraphIndex || 0) > paragraphIndex)
}

function previousStanzaFirstLine(line: ScriptLine, lines: readonly ScriptLine[]): ScriptLine | undefined {
  const paragraphIndex = line.paragraphIndex || 0
  const sorted = lines.slice().sort((left, right) => left.index - right.index)
  const previous = [...sorted].reverse().find(
    (candidate) => (candidate.paragraphIndex || 0) < paragraphIndex,
  )
  if (!previous) return undefined
  const previousIndex = previous.paragraphIndex || 0
  return sorted.find((candidate) => (candidate.paragraphIndex || 0) === previousIndex)
}

function previousRecordingLine(
  line: ScriptLine,
  lines: readonly ScriptLine[],
  stanzaMode: boolean,
): ScriptLine | undefined {
  if (stanzaMode) return previousStanzaFirstLine(line, lines)
  return lines.find((candidate) => candidate.index === line.index - 1)
}

function stanzaDuration(lines: readonly ScriptLine[]): number {
  return lines.reduce((sum, line) => sum + line.duration, 0)
}

function sequenceManifestFromProject(
  manifest: ProjectManifest,
  sequence: SequenceId,
): SequenceManifest {
  if (sequence === 'main') {
    return {
      lines: manifest.lines,
      scriptFile: manifest.scriptFile,
      scriptSummary: manifest.scriptSummary,
      scriptSummaryFingerprint: manifest.scriptSummaryFingerprint,
      continuityCanon: manifest.continuityCanon,
      qwenParagraphMasters: manifest.qwenParagraphMasters,
      exportSettings: manifest.exportSettings,
    }
  }
  return (
    manifest.trailer || {
      lines: [],
      scriptFile: 'trailer/script.txt',
      scriptSummary: undefined,
      exportSettings: structuredClone(DEFAULT_TRAILER_EXPORT_SETTINGS),
    }
  )
}

function sequenceProjectState(state: ProjectState, sequence: SequenceId): ProjectState {
  const sequenceManifest = sequenceManifestFromProject(state.manifest, sequence)
  return {
    ...state,
    manifest: {
      ...state.manifest,
      lines: sequenceManifest.lines,
      scriptFile: sequenceManifest.scriptFile,
      scriptSummary: sequenceManifest.scriptSummary,
      scriptSummaryFingerprint: sequenceManifest.scriptSummaryFingerprint,
      continuityCanon: sequenceManifest.continuityCanon,
      qwenParagraphMasters: sequenceManifest.qwenParagraphMasters,
      exportSettings: sequenceManifest.exportSettings,
    },
  }
}

function mutateSequenceManifest(
  manifest: ProjectManifest,
  sequence: SequenceId,
  mutator: (manifest: ProjectManifest) => void,
): void {
  if (sequence === 'main') {
    mutator(manifest)
    return
  }
  const trailer = manifest.trailer || {
    lines: [],
    scriptFile: 'trailer/script.txt',
    scriptSummary: undefined,
    scriptSummaryFingerprint: undefined,
    continuityCanon: undefined,
    qwenParagraphMasters: undefined,
    exportSettings: structuredClone(DEFAULT_TRAILER_EXPORT_SETTINGS),
  }
  const view = {
    ...manifest,
    lines: trailer.lines,
    scriptFile: trailer.scriptFile,
    scriptSummary: trailer.scriptSummary,
    scriptSummaryFingerprint: trailer.scriptSummaryFingerprint,
    continuityCanon: trailer.continuityCanon,
    qwenParagraphMasters: trailer.qwenParagraphMasters,
    exportSettings: trailer.exportSettings,
  }
  mutator(view)
  manifest.visualBible = view.visualBible
  manifest.trailer = {
    ...trailer,
    lines: view.lines,
    scriptFile: view.scriptFile,
    scriptSummary: view.scriptSummary,
    scriptSummaryFingerprint: view.scriptSummaryFingerprint,
    continuityCanon: view.continuityCanon,
    qwenParagraphMasters: view.qwenParagraphMasters,
    exportSettings: view.exportSettings,
  }
}

function findLineInProject(
  state: ProjectState,
  lineId: string,
  sequence?: SequenceId,
): ScriptLine | undefined {
  const sequenceManifest = sequence
    ? sequenceManifestFromProject(state.manifest, sequence)
    : undefined
  return (
    sequenceManifest?.lines.find((line) => line.id === lineId) ||
    state.manifest.lines.find((line) => line.id === lineId) ||
    state.manifest.trailer?.lines.find((line) => line.id === lineId)
  )
}

function buildScriptSummaryPrompt(state: ProjectState, sequence: SequenceId): string {
  const activeSequence = sequenceManifestFromProject(state.manifest, sequence)
  const activeScript = activeSequence.lines
    .map((line) => `LINE ${line.index + 1}: ${line.text}`)
    .join('\n')
  const longformScript =
    sequence === 'trailer'
      ? state.manifest.lines.map((line) => `LINE ${line.index + 1}: ${line.text}`).join('\n')
      : ''

  return [
    'Create a concise, factual continuity canon for an AI video image sequence.',
    'Read the entire script before summarizing it.',
    'Identify the exact recurring subject, species or identity, cast, setting, important props, visual motifs, story arc, and any facts that later scenes must preserve.',
    'Do not invent details that are not established. Do not write scene directions, shot lists, or image prompts.',
    'This canon will be supplied with every sequential scene-direction request, so make continuity-critical details explicit and easy to follow.',
    'Return only valid JSON with no Markdown fences in this exact shape:',
    '{"version":1,"summary":"120–250 words of factual continuity prose","subject":"exact recurring subject identity, or empty string if none","cast":["concrete character descriptions"],"locations":["concrete locations"],"props":["important props and their state"],"visualMotifs":["recurring visual motifs"]}',
    '',
    `ACTIVE ${sequence === 'trailer' ? 'CONDENSED 9:16' : 'LONGFORM'} SCRIPT:`,
    activeScript,
    ...(sequence === 'trailer'
      ? ['', 'LONGFORM SCRIPT CONTEXT:', longformScript]
      : []),
    '',
    'PROJECT VISUAL BIBLE:',
    `Style: ${state.manifest.visualBible.style}`,
    `Characters: ${state.manifest.visualBible.characters}`,
    `Main character lock: ${state.manifest.visualBible.mainCharacter || 'none provided'}`,
    `Supporting character lock: ${state.manifest.visualBible.supportingCharacter || 'none provided'}`,
    `Setting: ${state.manifest.visualBible.setting}`,
    `Palette: ${state.manifest.visualBible.palette}`,
    `Camera: ${state.manifest.visualBible.camera}`,
  ].join('\n')
}

function acceptedLedgerForSequence(
  state: ProjectState,
  sequence: SequenceId,
  beforeIndex = Number.POSITIVE_INFINITY,
): SceneLedgerEntry[] {
  const fingerprint = sceneContextFingerprint(state.manifest, sequence)
  return sequenceManifestFromProject(state.manifest, sequence)
    .lines
    .slice()
    .sort((left, right) => left.index - right.index)
    .filter(
      (line) =>
        line.index < beforeIndex &&
        line.sceneRecord?.sourceFingerprint === fingerprint &&
        directionStatusOf(line) === 'complete',
    )
    .map((line) => sceneLedgerEntry(line, line.sceneRecord!))
}

function statusLabel(status: ScriptLine['sceneStatus']): string {
  switch (status) {
    case 'complete':
      return 'Visual ready'
    case 'generating':
      return 'Generating'
    case 'queued':
      return 'Queued'
    case 'failed':
      return 'Needs attention'
    case 'prompt-approved':
      return 'Prompt approved'
    default:
      return 'Draft'
  }
}

function directionStatusOf(line: ScriptLine): DirectionStatus {
  return line.directionStatus || (line.sceneDescription?.trim() ? 'complete' : 'draft')
}

function directionStatusLabel(line: ScriptLine): string {
  switch (directionStatusOf(line)) {
    case 'complete':
      return 'Direction ready'
    case 'generating':
      return 'Drafting direction'
    case 'failed':
      return 'Direction needs retry'
    default:
      return 'Direction missing'
  }
}

function hasDirectionPrompt(line: ScriptLine): boolean {
  return (
    directionStatusOf(line) === 'complete' &&
    (Boolean(line.scenePrompt.trim()) || lineHasStillCastBeats(line))
  )
}

function hasCurrentDirectionPrompt(
  line: ScriptLine,
  state: ProjectState,
  sequence: SequenceId,
): boolean {
  const fingerprint = sceneContextFingerprint(state.manifest, sequence)
  return (
    hasDirectionPrompt(line) &&
    line.sceneRecord?.sourceFingerprint === fingerprint &&
    line.sceneRecord?.lineId === line.id
  )
}

function hasImage(line: ScriptLine): boolean {
  return lineStillCastImagesReady(line)
}

function buildImageInspectorPayload(
  lines: ScriptLine[],
  activeLineId: string | null,
): ImageInspectorPayload | null {
  const items = lines
    .filter((line) => Boolean(line.imagePath))
    .map((line) => ({
      lineId: line.id,
      lineNumber: line.index + 1,
      label: line.text,
      imagePath: line.imagePath!,
    }))
  if (items.length === 0) return null
  const selectedIndex = activeLineId
    ? items.findIndex((item) => item.lineId === activeLineId)
    : -1
  return {
    items,
    index: selectedIndex >= 0 ? selectedIndex : 0,
  }
}

function buildVoiceInspectorPayload(
  lines: ScriptLine[],
  activeLineId: string | null,
  sequence: SequenceId,
): VoiceInspectorPayload | null {
  const items = lines
    .filter((line) => Boolean(line.voicePath))
    .map((line) => ({
      lineId: line.id,
      lineNumber: line.index + 1,
      label: line.text,
      voicePath: line.voicePath!,
      durationSeconds: line.duration || 0,
      sequence,
      voiceAssetVersion: line.voiceAssetVersion,
      voiceTrimStart: line.voiceTrimStart,
      voiceTrimEnd: line.voiceTrimEnd,
      voiceCleanupVersion: line.voiceCleanupVersion,
      voiceCleanupEndPaddingSeconds: line.voiceCleanupEndPaddingSeconds,
      voiceCleanupConfident: line.voiceCleanupConfident,
      canTrim: Boolean(line.voiceRawPath && typeof line.voiceTrimStart === 'number'),
    }))
  if (items.length === 0) return null
  const selectedIndex = activeLineId
    ? items.findIndex((item) => item.lineId === activeLineId)
    : -1
  return {
    items,
    index: selectedIndex >= 0 ? selectedIndex : 0,
  }
}

function imageProviderLabel(provider: ImageGenerator): string {
  if (provider === 'chatgpt') return 'ChatGPT'
  if (provider === 'comfyui') return 'ComfyUI'
  return 'Higgsfield'
}

function imageProviderLabelForActivity(provider: ImageGenerator | undefined): string {
  return imageProviderLabel(provider || 'higgsfield')
}

function modelEndpointForProvider(
  provider: ImageGenerator,
  higgsStatus: HiggsConnectionStatus | null,
): string {
  if (provider === 'chatgpt') return 'chatgpt-image-generation'
  if (provider === 'comfyui') return 'comfyui-local'
  return higgsStatus?.modelEndpoint || 'nano_banana_2_lite'
}

function App() {
  const [project, setProject] = useState<ProjectState | null>(null)
  const [activeSection, setActiveSection] = useState<StudioSection>('overview')
  const [activeSequence, setActiveSequence] = useState<SequenceId>('main')
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [higgsStatus, setHiggsStatus] = useState<HiggsConnectionStatus | null>(null)
  const [comfyStatus, setComfyStatus] = useState<ComfyConnectionStatus | null>(null)
  const [llmStatus, setLlmStatus] = useState<LlmConnectionStatus | null>(null)
  const [studioSettings, setStudioSettings] = useState<StudioSettings>({
    imageGenerator: 'higgsfield',
    voiceMode: 'microphone',
    llmReasoningEffort: DEFAULT_LLM_REASONING_EFFORT,
    llmServiceTier: DEFAULT_LLM_SERVICE_TIER,
    llmSteps: defaultLlmStepSettings(),
    comfy: DEFAULT_COMFY_UI_SETTINGS,
    customImageGuidePath: '',
    customImageCharacterSheetPath: '',
    customImageReferencePaths: [],
    expressionGuidePath: '',
    expressionBackgroundPath: '',
  })
  const [llmAuthBusy, setLlmAuthBusy] = useState(false)
  const [llmPrompt, setLlmPrompt] = useState('')
  const [llmOutput, setLlmOutput] = useState('')
  const [llmBusy, setLlmBusy] = useState(false)
  const [qwenStatus, setQwenStatus] = useState<QwenTtsStatus | null>(null)
  const [qwenBusy, setQwenBusy] = useState(false)
  const [qwenProgress, setQwenProgress] = useState<QwenTtsProgress | null>(null)
  const [qwenReferenceBusy, setQwenReferenceBusy] = useState(false)
  const [trailerScriptBusy, setTrailerScriptBusy] = useState(false)
  const [contextPromptsBusy, setContextPromptsBusy] = useState(false)
  const [contextPromptProgress, setContextPromptProgress] = useState<ContextPromptProgress | null>(null)
  const [imageBatchBusy, setImageBatchBusy] = useState(false)
  const [imageCancelBusy, setImageCancelBusy] = useState(false)
  const [automaticImageGenerationEnabled, setAutomaticImageGenerationEnabled] = useState(
    readAutomaticImageGenerationPreference,
  )
  const [productionBibles, setProductionBibles] = useState<ProductionBiblePreset[]>([])
  const [productionBibleBusy, setProductionBibleBusy] = useState(false)
  const [channelProfiles, setChannelProfiles] = useState<ChannelImageProfile[]>([])
  const [activeChannelProfileId, setActiveChannelProfileId] = useState('')
  const [channelProfileBusy, setChannelProfileBusy] = useState(false)
  const [channelBriefBusy, setChannelBriefBusy] = useState(false)
  const [channelMenuOpen, setChannelMenuOpen] = useState(false)
  const channelMenuRef = useRef<HTMLDivElement>(null)
  const [stillCastLibrary, setStillCastLibrary] = useState<StillCastLibraryScan | null>(null)
  const [stillCastBusy, setStillCastBusy] = useState(false)
  const [customImageSetup, setCustomImageSetup] = useState<CustomImageSetup | null>(null)
  const [customImageBusy, setCustomImageBusy] = useState(false)
  const [customImageProgress, setCustomImageProgress] = useState<CustomImageProgress | null>(null)
  const customImageSetupRefreshTimerRef = useRef<number | null>(null)
  const customImageSetupRequestRef = useRef(0)
  const [scriptTopic, setScriptTopic] = useState('')
  const [scriptDraft, setScriptDraft] = useState('')
  const [scriptDraftSource, setScriptDraftSource] = useState<ScriptCreatorDraft['source']>()
  const [scriptBibleText, setScriptBibleText] = useState('')
  const [scriptBiblePathLocal, setScriptBiblePathLocal] = useState('')
  const [ideaGuideText, setIdeaGuideText] = useState('')
  const [ideaGuidePathLocal, setIdeaGuidePathLocal] = useState('')
  const [scriptDraftBusy, setScriptDraftBusy] = useState(false)
  const [videoIdeaBusy, setVideoIdeaBusy] = useState(false)
  const [videoIdeaResearching, setVideoIdeaResearching] = useState(false)
  const [videoIdeaDraft, setVideoIdeaDraft] = useState('')
  const [videoIdeaSeed, setVideoIdeaSeed] = useState('')
  const [timelineImageFilter, setTimelineImageFilter] = useState<TimelineImageFilter>('all')
  const pendingTimelineScrollRef = useRef<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [higgsAuthBusy, setHiggsAuthBusy] = useState(false)
  const [comfyBusy, setComfyBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generatingLineId, setGeneratingLineId] = useState<string | null>(null)
  const [recordingLineId, setRecordingLineId] = useState<string | null>(null)
  const [countdownLineId, setCountdownLineId] = useState<string | null>(null)
  const [countdownValue, setCountdownValue] = useState<number | null>(null)
  const [countdownLeadInSeconds, setCountdownLeadInSeconds] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [imageInspectorOpen, setImageInspectorOpen] = useState(false)
  const imageInspectorOpenRef = useRef(false)
  imageInspectorOpenRef.current = imageInspectorOpen
  const imageInspectorLinesRef = useRef<ScriptLine[]>([])
  const [voiceInspectorOpen, setVoiceInspectorOpen] = useState(false)
  const voiceInspectorOpenRef = useRef(false)
  voiceInspectorOpenRef.current = voiceInspectorOpen
  const voiceInspectorLinesRef = useRef<ScriptLine[]>([])
  const voiceInspectorSequenceRef = useRef<SequenceId>('main')
  const [assetSources, setAssetSources] = useState<Record<string, string>>({})
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingStartedRef = useRef<number>(0)
  const cancelRecordingRef = useRef(false)
  const restartRecordingRef = useRef<string | null>(null)
  const advanceRecordingRef = useRef(false)
  const recordOnceRef = useRef(false)
  const [recordOnceActive, setRecordOnceActive] = useState(false)
  const cancelContextPromptsRef = useRef(false)
  const sceneGenerationRunIdRef = useRef(0)
  const activeSceneGenerationRunRef = useRef<SceneGenerationRun | null>(null)
  const activePromptLineIdsRef = useRef(new Set<string>())
  const activeDirectionLinesRef = useRef(new Set<string>())
  const promptSaveQueueRef = useRef(Promise.resolve())
  const projectStateRef = useRef<ProjectState | null>(null)
  const imageSubmitQueueRef = useRef(Promise.resolve())
  const imageGenerationCancelledRef = useRef(false)
  const imageGenerationRequestVersionRef = useRef(0)
  const projectRevisionRef = useRef(0)
  const assetSourcesRef = useRef<Record<string, string>>({})
  const assetLineSnapshotsRef = useRef(new Map<string, AssetLineSnapshot>())
  const assetLoadPromisesRef = useRef(new Map<string, Promise<string | null>>())
  const assetLoadVersionsRef = useRef(new Map<string, number>())
  const assetProjectIdRef = useRef<string | null>(null)
  const activeLineIdRef = useRef<string | null>(null)
  const automaticImageGenerationEnabledRef = useRef(automaticImageGenerationEnabled)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const micKeepAliveRef = useRef<GainNode | null>(null)
  const micSilencePollRef = useRef<number | null>(null)
  const audioContextCloseRef = useRef(Promise.resolve())
  const videoIdeaBusyRef = useRef(false)
  const videoIdeaRequestIdRef = useRef<string | null>(null)
  const videoIdeaCancelRef = useRef(false)
  const scriptTopicRef = useRef(scriptTopic)
  const scriptDraftRef = useRef(scriptDraft)
  const scriptDraftGenerationVersionRef = useRef(0)
  const scriptDraftBusyRef = useRef(false)
  const scriptBibleTextRef = useRef(scriptBibleText)
  const scriptBiblePathRef = useRef('')
  const scriptChannelIdRef = useRef('')
  const scriptChannelNameRef = useRef('')
  const scriptCreatorSaveTimerRef = useRef<number | null>(null)
  scriptTopicRef.current = scriptTopic
  scriptDraftRef.current = scriptDraft
  scriptBibleTextRef.current = scriptBibleText

  const selectedLine = useMemo(
    () => {
      const lines = project
        ? sequenceManifestFromProject(project.manifest, activeSequence).lines
        : []
      return lines.find((line) => line.id === activeLineId) || lines[0]
    },
    [activeLineId, activeSequence, project],
  )
  const sequenceProject = useMemo(
    () => (project ? sequenceProjectState(project, activeSequence) : null),
    [activeSequence, project],
  )
  const activeChannelProfile = useMemo(
    () => channelProfiles.find((profile) => profile.id === activeChannelProfileId),
    [activeChannelProfileId, channelProfiles],
  )
  scriptBiblePathRef.current = activeChannelProfile?.scriptBiblePath || scriptBiblePathLocal
  scriptChannelIdRef.current = activeChannelProfile?.id || ''
  scriptChannelNameRef.current = activeChannelProfile?.name || ''
  const stillCastEnabled = activeChannelProfile?.productionMode === 'still-cast'
  const stillCastEnabledRef = useRef(stillCastEnabled)
  stillCastEnabledRef.current = stillCastEnabled

  useEffect(() => {
    const libraryPath = activeChannelProfile?.stillLibraryPath
    if (!libraryPath && !project) {
      setStillCastLibrary(null)
      return
    }
    const scan = project
      ? window.studio.stillCast.scanCatalog(libraryPath)
      : window.studio.stillCast.scanLibrary(libraryPath || '')
    void scan.then(setStillCastLibrary).catch(() => setStillCastLibrary(null))
  }, [activeChannelProfile?.id, activeChannelProfile?.stillLibraryPath, project?.rootPath])

  useEffect(() => {
    const biblePath = activeChannelProfile?.scriptBiblePath || ''
    setScriptBiblePathLocal(biblePath)
    if (!biblePath) {
      setScriptBibleText('')
      return
    }
    let cancelled = false
    void window.studio.scriptBible
      .read(biblePath)
      .then((result) => {
        if (!cancelled) setScriptBibleText(result.text)
      })
      .catch(() => {
        if (!cancelled) setScriptBibleText('')
      })
    return () => {
      cancelled = true
    }
  }, [activeChannelProfile?.id, activeChannelProfile?.scriptBiblePath])

  useEffect(() => {
    const guidePath = activeChannelProfile?.ideaGuidePath || ''
    setIdeaGuidePathLocal(guidePath)
    if (!guidePath) {
      setIdeaGuideText('')
      return
    }
    let cancelled = false
    void window.studio.ideaGuide
      .read(guidePath)
      .then((result) => {
        if (!cancelled) setIdeaGuideText(result.text)
      })
      .catch(() => {
        if (!cancelled) setIdeaGuideText('')
      })
    return () => {
      cancelled = true
    }
  }, [activeChannelProfile?.id, activeChannelProfile?.ideaGuidePath])

  useEffect(() => {
    if (!channelMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (channelMenuRef.current?.contains(event.target as Node)) return
      setChannelMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [channelMenuOpen])

  useEffect(() => {
    const lines = sequenceProject?.manifest.lines || []
    setActiveLineId((current) =>
      current && lines.some((line) => line.id === current) ? current : lines[0]?.id || null,
    )
  }, [activeSequence, sequenceProject])

  useEffect(() => {
    activeLineIdRef.current = activeLineId
    if (!projectStateRef.current || !activeLineId) return
    void loadAssets(projectStateRef.current)
  }, [activeLineId])

  useEffect(() => {
    const lineId = pendingTimelineScrollRef.current
    if (!lineId || lineId !== activeLineId) return
    pendingTimelineScrollRef.current = null
    const node = document.querySelector(`[data-timeline-line="${lineId}"]`)
    node?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeLineId, timelineImageFilter])

  const totalDuration = useMemo(
    () => sequenceProject?.manifest.lines.reduce((total, line) => total + line.duration, 0) || 0,
    [sequenceProject],
  )

  const recordedCount =
    sequenceProject?.manifest.lines.filter((line) => line.status === 'recorded' || line.status === 'ready').length || 0
  const visualCount =
    sequenceProject?.manifest.lines.filter((line) => hasImage(line)).length || 0
  const regeneratedImageCount =
    sequenceProject?.manifest.lines.filter(isRegeneratedImage).length || 0

  useEffect(() => {
    void (async () => {
      try {
        const [existingProject, status, comfy, settings, qwen, savedProductionBibles, savedChannelProfiles] =
          await Promise.all([
          window.studio.project.get(),
          window.studio.settings.getHiggs(),
          window.studio.settings.getComfyStatus(),
          window.studio.settings.get(),
          window.studio.qwen.getStatus(),
          window.studio.productionBibles.list(),
          window.studio.channelProfiles.list(),
        ])
        setLlmStatus(await window.studio.llm.getStatus())
        if (existingProject) {
          await loadProject(existingProject)
        }
        setHiggsStatus(status)
        setComfyStatus(comfy)
        setStudioSettings(settings)
        setQwenStatus(qwen)
        setProductionBibles(savedProductionBibles)
        setChannelProfiles(savedChannelProfiles.profiles)
        setActiveChannelProfileId(savedChannelProfiles.activeProfileId)
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : 'Could not load Higgsfilm.')
      }
    })()
  }, [])

  useEffect(() => {
    return window.studio.higgs.onUpdate((state) => {
      const current = projectStateRef.current
      if (!current || current.manifest.id !== state.manifest.id) return
      void loadProject(state)
    })
  }, [])

  useEffect(() => window.studio.qwen.onProgress(setQwenProgress), [])
  useEffect(() => window.studio.customImages.onProgress(setCustomImageProgress), [])

  const refreshCustomImageSetup = useCallback((delayMs = 450): void => {
    const requestId = ++customImageSetupRequestRef.current
    if (customImageSetupRefreshTimerRef.current !== null) {
      window.clearTimeout(customImageSetupRefreshTimerRef.current)
      customImageSetupRefreshTimerRef.current = null
    }
    const target = projectStateRef.current
    if (!target) {
      setCustomImageSetup(null)
      return
    }
    customImageSetupRefreshTimerRef.current = window.setTimeout(() => {
      customImageSetupRefreshTimerRef.current = null
      const expectedId = target.manifest.id
      const expectedRoot = target.rootPath
      void window.studio.customImages
        .getSetup()
        .then((setup) => {
          const current = projectStateRef.current
          if (
            requestId === customImageSetupRequestRef.current &&
            current?.manifest.id === expectedId &&
            current.rootPath === expectedRoot
          ) setCustomImageSetup(setup)
        })
        .catch(() => {
          const current = projectStateRef.current
          if (
            requestId === customImageSetupRequestRef.current &&
            current?.manifest.id === expectedId &&
            current.rootPath === expectedRoot
          ) setCustomImageSetup(null)
        })
    }, delayMs)
  }, [])

  useEffect(() => {
    if (!project) {
      customImageSetupRequestRef.current += 1
      setCustomImageSetup(null)
      return
    }
    refreshCustomImageSetup(0)
    return () => {
      if (customImageSetupRefreshTimerRef.current !== null) {
        window.clearTimeout(customImageSetupRefreshTimerRef.current)
        customImageSetupRefreshTimerRef.current = null
      }
    }
  }, [
    refreshCustomImageSetup,
    project?.manifest.id,
    project?.rootPath,
    studioSettings.customImageGuidePath,
    studioSettings.customImageCharacterSheetPath,
    studioSettings.customImageReferencePaths,
  ])

  useEffect(() => {
    if (!project) {
      setQwenStatus(null)
      return
    }
    void window.studio.qwen.getStatus().then(setQwenStatus).catch(() => undefined)
  }, [project?.manifest.id])

  useEffect(() => {
    const handleRecordingKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (event.key === 'Enter' && recordingLineId) {
        event.preventDefault()
        stopRecording(!recordOnceRef.current)
      }
      if ((event.code === 'Space' || event.key === ' ') && recordingLineId) {
        event.preventDefault()
        stopRecording()
      }
      if (event.key === 'Escape' && (recordingLineId || countdownLineId)) {
        event.preventDefault()
        cancelRecording()
      }
      if (event.key === 'ArrowLeft' && (recordingLineId || countdownLineId)) {
        event.preventDefault()
        const currentLineId = recordingLineId || countdownLineId
        if (!currentLineId) return
        const previous = previousRecordingTarget(currentLineId, activeSequence)
        if (!previous) {
          showNotice(
            'info',
            stillCastEnabledRef.current ? 'This is the first stanza.' : 'This is the first line.',
          )
          return
        }
        cancelRecording(previous.id)
      }
    }

    window.addEventListener('keydown', handleRecordingKey)
    return () => window.removeEventListener('keydown', handleRecordingKey)
  }, [activeSequence, countdownLineId, recordingLineId])

  async function loadAssets(state: ProjectState): Promise<void> {
    if (assetProjectIdRef.current !== state.manifest.id) {
      assetProjectIdRef.current = state.manifest.id
      assetSourcesRef.current = {}
      assetLineSnapshotsRef.current.clear()
      assetLoadPromisesRef.current.clear()
      assetLoadVersionsRef.current.clear()
      setAssetSources({})
      projectRevisionRef.current = 0
    }

    const lines = [
      ...state.manifest.lines,
      ...(state.manifest.trailer?.lines || []),
    ]
    const invalidatedPaths = new Set<string>()
    const nextSnapshots = new Map<string, AssetLineSnapshot>()
    for (const line of lines) {
      const previous = assetLineSnapshotsRef.current.get(line.id)
      const stillBeatKey = (line.stillBeats || [])
        .map((beat) => `${beat.id}:${beat.imagePath || ''}`)
        .join('|')
      if (previous?.imagePath && previous.imagePath !== line.imagePath) {
        invalidatedPaths.add(previous.imagePath)
      }
      if (previous?.stillBeatKey && previous.stillBeatKey !== stillBeatKey) {
        for (const part of previous.stillBeatKey.split('|')) {
          const imagePath = part.slice(part.indexOf(':') + 1)
          if (imagePath) invalidatedPaths.add(imagePath)
        }
      }
      if (previous?.stillBeatKey !== stillBeatKey) {
        for (const beat of line.stillBeats || []) {
          if (beat.imagePath) invalidatedPaths.add(beat.imagePath)
        }
      }
      if (
        line.imagePath &&
        (!previous ||
          previous.imagePath !== line.imagePath ||
          (line.sceneStatus === 'complete' && previous.sceneStatus !== 'complete'))
      ) {
        invalidatedPaths.add(line.imagePath)
      }
      if (
        line.voicePath &&
        (!previous ||
          previous.voicePath !== line.voicePath ||
          previous.voiceAssetVersion !== line.voiceAssetVersion ||
          previous.status !== line.status)
      ) {
        invalidatedPaths.add(line.voicePath)
      }
      nextSnapshots.set(line.id, {
        imagePath: line.imagePath,
        voicePath: line.voicePath,
        voiceAssetVersion: line.voiceAssetVersion,
        status: line.status,
        sceneStatus: line.sceneStatus,
        stillBeatKey,
      })
    }
    assetLineSnapshotsRef.current = nextSnapshots

    if (invalidatedPaths.size > 0) {
      const nextSources = { ...assetSourcesRef.current }
      for (const assetPath of invalidatedPaths) {
        delete nextSources[assetPath]
        assetLoadPromisesRef.current.delete(assetPath)
        assetLoadVersionsRef.current.set(
          assetPath,
          (assetLoadVersionsRef.current.get(assetPath) || 0) + 1,
        )
      }
      assetSourcesRef.current = nextSources
      setAssetSources(nextSources)
    }

    const selectedLineId = activeLineIdRef.current
    const selectedLine = selectedLineId
      ? lines.find((line) => line.id === selectedLineId)
      : undefined
    const imagePaths = [
      ...new Set(
        [
          ...lines.map((line) => line.imagePath),
          ...(selectedLine?.stillBeats || []).map((beat) => beat.imagePath),
        ].filter((value): value is string => Boolean(value)),
      ),
    ]
    const selectedVoicePath = selectedLine?.voicePath
    const allVoicePaths = new Set(
      lines.map((line) => line.voicePath).filter((value): value is string => Boolean(value)),
    )
    const unusedVoicePaths = [...allVoicePaths].filter((assetPath) => assetPath !== selectedVoicePath)
    if (unusedVoicePaths.length > 0) {
      const nextSources = { ...assetSourcesRef.current }
      let pruned = false
      for (const assetPath of unusedVoicePaths) {
        if (!(assetPath in nextSources)) continue
        delete nextSources[assetPath]
        assetLoadPromisesRef.current.delete(assetPath)
        pruned = true
      }
      if (pruned) {
        assetSourcesRef.current = nextSources
        setAssetSources(nextSources)
      }
    }

    const queue: Array<{
      assetPath: string
      version: number
      load: Promise<string | null>
    }> = []

    const enqueue = (
      assetPath: string,
      loader: (path: string) => Promise<AssetData | null>,
    ) => {
      if (assetSourcesRef.current[assetPath]) return
      const version = assetLoadVersionsRef.current.get(assetPath) || 0
      let load = assetLoadPromisesRef.current.get(assetPath)
      if (!load) {
        load = loader(assetPath)
          .then((asset) => asset?.dataUrl || null)
          .catch(() => null)
        assetLoadPromisesRef.current.set(assetPath, load)
        void load.finally(() => {
          if (assetLoadPromisesRef.current.get(assetPath) === load) {
            assetLoadPromisesRef.current.delete(assetPath)
          }
        })
      }
      queue.push({ assetPath, version, load })
    }

    for (const assetPath of imagePaths) {
      enqueue(assetPath, (path) => window.studio.project.assetThumbDataUrl(path))
    }
    if (selectedVoicePath) {
      enqueue(selectedVoicePath, (path) => window.studio.project.assetDataUrl(path))
    }
    if (queue.length === 0) return

    const entries: Array<readonly [string, string | null, number]> = []
    for (let index = 0; index < queue.length; index += ASSET_LOAD_CONCURRENCY) {
      const batch = queue.slice(index, index + ASSET_LOAD_CONCURRENCY)
      const batchEntries = await Promise.all(
        batch.map(async ({ assetPath, version, load }) => {
          const dataUrl = await load
          return [assetPath, dataUrl, version] as const
        }),
      )
      entries.push(...batchEntries)
      if (assetProjectIdRef.current !== state.manifest.id) return
    }

    let changed = false
    for (const [assetPath, dataUrl, version] of entries) {
      if (
        !dataUrl ||
        assetLoadVersionsRef.current.get(assetPath) !== version ||
        assetSourcesRef.current[assetPath]
      ) {
        continue
      }
      assetSourcesRef.current[assetPath] = dataUrl
      changed = true
    }
    if (changed) setAssetSources({ ...assetSourcesRef.current })
  }

  function showNotice(type: Notice['type'], message: string): void {
    setNotice({ type, message })
    window.setTimeout(() => setNotice(null), 5000)
  }

  async function copySceneImage(line: ScriptLine): Promise<void> {
    if (!line.imagePath) {
      showNotice('info', 'This scene does not have a generated image to copy.')
      return
    }
    try {
      await window.studio.project.copyImageToClipboard(line.imagePath)
      showNotice('success', `Copied scene ${line.index + 1} image to the clipboard.`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not copy the scene image.')
    }
  }

  function applyProjectState(state: ProjectState): boolean {
    if (state.revision < projectRevisionRef.current) return false
    projectRevisionRef.current = state.revision
    projectStateRef.current = state
    setProject(state)
    refreshCustomImageSetup()
    const activeLines = sequenceManifestFromProject(state.manifest, activeSequence).lines
    setActiveLineId((current) => {
      const next = current || activeLines[0]?.id || null
      activeLineIdRef.current = next
      return next
    })
    return true
  }

  async function loadProject(state: ProjectState): Promise<void> {
    const previousId = projectStateRef.current?.manifest.id
    const previousRoot = projectStateRef.current?.rootPath
    const isNewProject = previousId !== state.manifest.id || previousRoot !== state.rootPath
    if (!applyProjectState(state)) return
    await loadAssets(state)
    const ideaRaw = normalizeVideoIdeaSession(state.manifest.videoIdea)
    const idea = ideaRaw ? recoverVideoIdeaFromRawAssistantMessage(ideaRaw) : undefined
    if (idea && ideaRaw && idea.updatedAt !== ideaRaw.updatedAt) {
      const next = cloneManifest(state.manifest)
      next.videoIdea = idea
      const nextState = { ...state, manifest: next }
      projectStateRef.current = nextState
      setProject(nextState)
      void window.studio.project.save(next).catch(() => undefined)
    }
    if (isNewProject) {
      const persistedDraft = state.scriptCreator?.draft || ''
      const persistedTopic = state.scriptCreator?.topic?.trim() || ''
      setScriptDraft(persistedDraft)
      scriptDraftRef.current = persistedDraft
      setScriptDraftSource(state.scriptCreator?.source)
      if (persistedTopic) {
        setScriptTopic(persistedTopic)
        scriptTopicRef.current = persistedTopic
      } else {
        const topic = idea?.locked ? composeScriptTopicFromIdea(idea.idea) : ''
        setScriptTopic(topic)
        scriptTopicRef.current = topic
      }
    }
    if (idea?.seed) setVideoIdeaSeed((current) => current || idea.seed)
  }

  async function unloadCurrentProject(): Promise<void> {
    scriptDraftGenerationVersionRef.current += 1
    cancelRecordingRef.current = true
    restartRecordingRef.current = null
    advanceRecordingRef.current = false
    recordOnceRef.current = false
    setRecordOnceActive(false)
    if (recorderRef.current?.state === 'recording' || recorderRef.current?.state === 'paused') {
      stopSilenceDetection()
      recorderRef.current.stop()
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    setRecordingLineId(null)
    setCountdownLineId(null)
    setCountdownValue(null)
    setCountdownLeadInSeconds(null)
    endMicSession()

    if (contextPromptsBusy) await cancelContextualPrompts()
    sceneGenerationRunIdRef.current += 1
    const activeRun = activeSceneGenerationRunRef.current
    if (activeRun) activeRun.cancelled = true
    imageGenerationRequestVersionRef.current += 1
    imageGenerationCancelledRef.current = true
    await window.studio.higgs.cancel().catch(() => undefined)
    await window.studio.qwen.cancel().catch(() => undefined)
    videoIdeaCancelRef.current = true
    await window.studio.llm.cancel(videoIdeaRequestIdRef.current || undefined).catch(() => undefined)
    await window.studio.llm.cancel(activeRun?.requestId).catch(() => undefined)
    await window.studio.imageInspector.hide().catch(() => undefined)
    setImageInspectorOpen(false)
    await window.studio.voiceInspector.hide().catch(() => undefined)
    setVoiceInspectorOpen(false)
    await window.studio.project.close().catch(() => undefined)

    projectStateRef.current = null
    projectRevisionRef.current = 0
    assetProjectIdRef.current = null
    assetSourcesRef.current = {}
    assetLineSnapshotsRef.current.clear()
    assetLoadPromisesRef.current.clear()
    assetLoadVersionsRef.current.clear()
    activePromptLineIdsRef.current.clear()
    activeDirectionLinesRef.current.clear()
    setProject(null)
    setActiveLineId(null)
    setActiveSequence('main')
    setActiveSection('overview')
    setAssetSources({})
    setGeneratingLineId(null)
    setQwenBusy(false)
    setQwenProgress(null)
    setQwenStatus(null)
    setStillCastLibrary(null)
    setTimelineImageFilter('all')
    setContextPromptsBusy(false)
    setContextPromptProgress(null)
    setImageBatchBusy(false)
    setExporting(false)
    imageGenerationCancelledRef.current = false
    if (scriptCreatorSaveTimerRef.current) {
      window.clearTimeout(scriptCreatorSaveTimerRef.current)
      scriptCreatorSaveTimerRef.current = null
    }
    setScriptDraft('')
    setScriptTopic('')
    setScriptDraftSource(undefined)
    scriptDraftRef.current = ''
    scriptTopicRef.current = ''
  }

  async function chooseProject(): Promise<void> {
    scriptDraftGenerationVersionRef.current += 1
    try {
      const state = await window.studio.project.choose()
      if (!state) return
      await loadProject(state)
      showNotice('success', 'Project folder is ready.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not open that folder.')
    }
  }

  function stillCastLibraryPath(): string | undefined {
    return stillCastEnabledRef.current ? activeChannelProfile?.stillLibraryPath : undefined
  }

  function finishStillCastImport(state: ProjectState, sequence: SequenceId): void {
    setActiveSection('visuals')
    const lines = sequenceManifestFromProject(state.manifest, sequence).lines
    if (lines.some((line) => !lineHasStillCastBeats(line))) {
      void generateStillCastBeats(0, true, undefined, sequence)
    }
  }

  async function importScript(sequence: SequenceId = activeSequence): Promise<void> {
    try {
      const lineMode = stillCastEnabledRef.current ? 'stanzas' : 'sentences'
      const state = await window.studio.project.importScript(sequence, lineMode, stillCastLibraryPath())
      if (!state) return
      await loadProject(state)
      setActiveSection('script')
      const lineCount = sequenceManifestFromProject(state.manifest, sequence).lines.length
      showNotice(
        'success',
        stillCastEnabledRef.current
          ? `${lineCount} visual beats created.`
          : `${lineCount} ${sequence === 'trailer' ? 'condensed' : 'narration'} lines created.`,
      )
      if (stillCastEnabledRef.current) {
        finishStillCastImport(state, sequence)
      } else {
        startAutomaticSceneGeneration(state, sequence)
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not import that script.')
    }
  }

  async function importScriptText(
    script: string,
    sequence: SequenceId = activeSequence,
    options: { autoCast?: boolean; silent?: boolean } = {},
  ): Promise<boolean> {
    const autoCast = options.autoCast ?? true
    try {
      const lineMode = stillCastEnabledRef.current ? 'stanzas' : 'sentences'
      const state = await window.studio.project.importScriptText(
        script,
        sequence,
        lineMode,
        stillCastLibraryPath(),
      )
      await loadProject(state)
      if (!options.silent) {
        setActiveSection('script')
        const lineCount = sequenceManifestFromProject(state.manifest, sequence).lines.length
        showNotice(
          'success',
          stillCastEnabledRef.current
            ? `${lineCount} visual beats created.`
            : `${lineCount} ${sequence === 'trailer' ? 'condensed' : 'narration'} lines created.`,
        )
      }
      if (!autoCast) return true
      if (stillCastEnabledRef.current) {
        finishStillCastImport(state, sequence)
      } else {
        startAutomaticSceneGeneration(state, sequence)
      }
      return true
    } catch (error) {
      if (!options.silent) {
        showNotice('error', error instanceof Error ? error.message : 'Could not create narration lines.')
      }
      return false
    }
  }

  function startAutomaticSceneGeneration(
    state: ProjectState,
    sequence: SequenceId,
    qwenMode: 'all' | 'resume' = 'all',
  ): void {
    automaticImageGenerationEnabledRef.current = true
    imageGenerationCancelledRef.current = false
    setAutomaticImageGenerationEnabled(true)
    try {
      window.localStorage.setItem(AUTOMATIC_IMAGE_GENERATION_KEY, 'on')
    } catch {
      // The in-memory preference still applies if storage is unavailable.
    }
    void runAutomaticGenerationWorkflow(state, sequence, qwenMode)
  }

  async function runAutomaticGenerationWorkflow(
    state: ProjectState,
    sequence: SequenceId,
    qwenMode: 'all' | 'resume' = 'all',
  ): Promise<void> {
    const directionTask = generateContextualPrompts(
      state,
      0,
      true,
      undefined,
      sequence,
      false,
    )
    const voiceTask =
      studioSettings.voiceMode === 'qwen'
        ? generateQwen({ mode: qwenMode, sequence })
        : Promise.resolve(true)

    const [directionResult, voiceResult] = await Promise.allSettled([directionTask, voiceTask])
    if (directionResult.status === 'rejected') {
      showNotice(
        'error',
        directionResult.reason instanceof Error
          ? directionResult.reason.message
          : 'Automatic scene direction generation failed.',
      )
      return
    }
    if (voiceResult.status === 'rejected' || (voiceResult.status === 'fulfilled' && !voiceResult.value)) {
      if (voiceResult.status === 'rejected') {
        showNotice(
          'error',
          voiceResult.reason instanceof Error
            ? voiceResult.reason.message
            : 'Automatic QWEN voice generation failed.',
        )
      }
      return
    }
    if (!automaticImageGenerationEnabledRef.current || imageGenerationCancelledRef.current) return
    if (stillCastEnabledRef.current) return

    const latestState = await window.studio.project.get()
    if (!latestState || latestState.manifest.id !== state.manifest.id) return
    const unresolvedDirectionLines = sequenceManifestFromProject(latestState.manifest, sequence).lines
      .filter((line) => !hasCurrentDirectionPrompt(line, latestState, sequence))
    if (unresolvedDirectionLines.length > 0) {
      showNotice(
        'error',
        `Automatic image generation is paused. Unresolved scene IDs: ${unresolvedDirectionLines
          .map((line) => line.id)
          .join(', ')}`,
      )
      return
    }
    await queueAutomaticImages(latestState, sequence)
  }

  async function startLlmLogin(): Promise<void> {
    setLlmAuthBusy(true)
    try {
      await window.studio.llm.login()
      showNotice('info', 'A Codex login window opened. Finish ChatGPT sign-in, then reopen Higgsfilm.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not start ChatGPT sign-in.')
    } finally {
      setLlmAuthBusy(false)
    }
  }

  async function ensureScriptSummary(
    baseState: ProjectState,
    sequence: SequenceId,
    requestId?: string,
  ): Promise<ProjectState> {
    baseState = stateWithLatestLocalVisualBible(baseState)
    const activeSequence = sequenceManifestFromProject(baseState.manifest, sequence)
    if (activeSequence.lines.length === 0) return baseState
    const fingerprint = sceneContextFingerprint(baseState.manifest, sequence)
    const currentCanon =
      activeSequence.continuityCanon?.sourceFingerprint === fingerprint
        ? activeSequence.continuityCanon
        : undefined
    const existingSummary = currentCanon?.summary || scriptSummaryForSequence(baseState.manifest, sequence)
    if (
      existingSummary &&
      activeSequence.scriptSummaryFingerprint === fingerprint &&
      activeSequence.continuityCanon?.sourceFingerprint === fingerprint
    ) {
      return baseState
    }
    const result = await window.studio.llm.generate({
      purpose: 'script-summary',
      requestId,
      prompt: buildScriptSummaryPrompt(baseState, sequence),
    })
    const canon = parseContinuityCanonResponse(result.text, fingerprint)
    if (!canon.summary) throw new Error('ChatGPT did not return a usable script continuity canon.')

    const manifest = cloneManifest(baseState.manifest)
    if (sequence === 'main') {
      manifest.scriptSummary = canon.summary
      manifest.scriptSummaryFingerprint = fingerprint
      manifest.continuityCanon = canon
    } else {
      const trailer = manifest.trailer || {
        lines: [],
        scriptFile: 'trailer/script.txt',
        exportSettings: structuredClone(DEFAULT_TRAILER_EXPORT_SETTINGS),
      }
      trailer.scriptSummary = canon.summary
      trailer.scriptSummaryFingerprint = fingerprint
      trailer.continuityCanon = canon
      manifest.trailer = trailer
    }
    const savedState = await window.studio.project.save(manifest)
    applyProjectState(savedState)
    return savedState
  }

  async function refreshLlmStatus(): Promise<void> {
    setLlmAuthBusy(true)
    try {
      setLlmStatus(await window.studio.llm.getStatus())
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not refresh ChatGPT status.')
    } finally {
      setLlmAuthBusy(false)
    }
  }

  async function generateSceneRecordWithRetry(
    state: ProjectState,
    line: ScriptLine,
    sequence: SequenceId,
    acceptedLedger: SceneLedgerEntry[],
    refinement?: string,
    requestId?: string,
    initialRetryFeedback?: string,
  ): Promise<SceneDirectionRecord> {
    const sourceFingerprint = sceneContextFingerprint(state.manifest, sequence)
    let retryFeedback: string | undefined = initialRetryFeedback
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await window.studio.llm.generate({
        purpose: 'scene-direction',
        requestId,
        prompt: buildSceneDirectionPrompt({
          sequence,
          targetLine: line,
          sequenceLines: sequenceManifestFromProject(state.manifest, sequence).lines,
          longformLines: sequence === 'trailer' ? state.manifest.lines : undefined,
          visualBible: state.manifest.visualBible,
          canon: sequenceManifestFromProject(state.manifest, sequence).continuityCanon,
          acceptedLedger,
          refinement,
          retryFeedback,
          promptingWorkflow: scenePromptingWorkflowForSettings(studioSettings),
        }),
      })
      try {
        const parsed = parseSceneDirectionResponse(result.text, line, sourceFingerprint, {
          canon: sequenceManifestFromProject(state.manifest, sequence).continuityCanon,
          acceptedLedger,
          narration: line.text,
        })
        console.info(
          '[Higgsfilm][SceneGeneration] response normalized',
          JSON.stringify({
            requestId,
            lineId: line.id,
            sceneNumber: line.index + 1,
            attempt: attempt + 1,
            responseChars: parsed.record.direction.length,
            warnings: parsed.warnings,
          }),
        )
        return parsed.record
      } catch (error) {
        console.warn(
          '[Higgsfilm][SceneGeneration] response normalization failed',
          JSON.stringify({
            requestId,
            lineId: line.id,
            sceneNumber: line.index + 1,
            attempt: attempt + 1,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        retryFeedback =
          error instanceof Error
            ? `${error.message} Return one non-empty paragraph of visual scene prose only.`
            : 'The previous response was empty or could not be normalized. Return one visual paragraph only.'
        if (attempt === 1) throw error
      }
    }
    throw new Error(`Scene ${line.index + 1} did not return a valid scene record.`)
  }

  async function generateWithChatGpt(): Promise<void> {
    if (!llmPrompt.trim()) {
      showNotice('info', 'Describe what you want ChatGPT to create first.')
      return
    }
    setLlmBusy(true)
    try {
      const result = await window.studio.llm.generate({ purpose: 'creative', prompt: llmPrompt })
      setLlmOutput(result.text)
      showNotice('success', 'ChatGPT returned a creative draft.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'ChatGPT generation failed.')
    } finally {
      setLlmBusy(false)
    }
  }

  async function generateTrailerScript(options: { fromLongformApply?: boolean } = {}): Promise<void> {
    const source = projectStateRef.current || project
    if (!source) {
      showNotice('info', 'Choose a project and import the longform script first.')
      return
    }
    if (source.manifest.lines.length === 0) {
      showNotice('info', 'Import the longform script before generating a condensed 9:16 cut.')
      return
    }
    setTrailerScriptBusy(true)
    try {
      const stillCast = stillCastEnabledRef.current
      const result = await window.studio.llm.generate({
        purpose: 'trailer-script',
        prompt: composeTrailerScriptPrompt(
          source.manifest.lines.map((line) => line.text).join('\n'),
          source.manifest.visualBible,
          { stillCast },
        ),
      })
      const script = normalizeTrailerScript(result.text, stillCast)
      if (
        !(await importScriptText(script, 'trailer', {
          silent: Boolean(options.fromLongformApply),
          autoCast: !options.fromLongformApply && !stillCastBusy,
        }))
      ) {
        if (options.fromLongformApply) {
          showNotice('error', 'The 16:9 script was created, but the 9:16 condensed cut could not be imported.')
        }
        return
      }
      if (!options.fromLongformApply) {
        setActiveSequence('trailer')
        setActiveSection('script')
      }
      showNotice(
        'success',
        options.fromLongformApply
          ? '16:9 episode and 9:16 condensed cut are ready. Drop Custom-9x16 stills named after each short line.'
          : 'Generated a ~30 second 9:16 condensed cut. Edit any line before recording.',
      )
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not generate the condensed 9:16 script.',
      )
    } finally {
      setTrailerScriptBusy(false)
    }
  }

  async function updateDirectionStatus(
    lineId: string,
    status: DirectionStatus,
    error?: string,
    sequence: SequenceId = activeSequence,
  ): Promise<ProjectState> {
    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = await window.studio.project.get()
      if (!currentState) throw new Error('Choose a project folder first.')
      const manifest = cloneManifest(stateWithLatestLocalVisualBible(currentState).manifest)
      const line = sequenceManifestFromProject(manifest, sequence).lines.find(
        (candidate) => candidate.id === lineId,
      )
      if (!line) throw new Error('The selected narration line no longer exists.')
      mutateSequenceManifest(manifest, sequence, (view) => {
        const currentLine = view.lines.find((candidate) => candidate.id === lineId)
        if (!currentLine) throw new Error(`The narration line ${lineId} no longer exists.`)
        currentLine.directionStatus = status
        currentLine.directionError = error
      })
      const state = await window.studio.project.save(manifest)
      applyProjectState(state)
      return state
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  async function updateDirectionStatuses(
    lineIds: string[],
    status: DirectionStatus,
    error?: string,
    sequence: SequenceId = activeSequence,
  ): Promise<ProjectState> {
    if (lineIds.length === 0) {
      const currentState = await window.studio.project.get()
      if (!currentState) throw new Error('Choose a project folder first.')
      return currentState
    }
    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = await window.studio.project.get()
      if (!currentState) throw new Error('Choose a project folder first.')
      const manifest = cloneManifest(stateWithLatestLocalVisualBible(currentState).manifest)
      mutateSequenceManifest(manifest, sequence, (view) => {
        const missingLineIds = lineIds.filter(
          (lineId) => !view.lines.some((candidate) => candidate.id === lineId),
        )
        if (missingLineIds.length > 0) {
          throw new Error(`These narration lines no longer exist: ${missingLineIds.join(', ')}`)
        }
        for (const lineId of lineIds) {
          const line = view.lines.find((candidate) => candidate.id === lineId)
          if (!line) throw new Error(`The narration line ${lineId} no longer exists.`)
          line.directionStatus = status
          line.directionError = error
        }
      })
      const state = await window.studio.project.save(manifest)
      applyProjectState(state)
      return state
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  async function saveGeneratedPrompts(
    fallbackState: ProjectState,
    generated: Array<{ line: ScriptLine; record: SceneDirectionRecord }>,
    sequence: SequenceId,
    run?: SceneGenerationRun,
  ): Promise<ProjectState> {
    const saveTask = promptSaveQueueRef.current.then(async () => {
      if (run) {
        const activeRun = activeSceneGenerationRunRef.current
        if (
          !activeRun ||
          activeRun.id !== run.id ||
          activeRun.projectId !== run.projectId
        ) {
          throw new Error('This scene-generation run is no longer active.')
        }
      }
      const currentState = stateWithLatestLocalVisualBible(
        (await window.studio.project.get()) || fallbackState,
      )
      if (run && currentState.manifest.id !== run.projectId) {
        throw new Error('The project changed while scene directions were being drafted.')
      }
      const manifest = cloneManifest(currentState.manifest)
      const currentFingerprint = sceneContextFingerprint(currentState.manifest, sequence)
      if (run && currentFingerprint !== run.sourceFingerprint) {
        throw new Error('The script or visual bible changed while the scene was being drafted.')
      }
      mutateSequenceManifest(manifest, sequence, (view) => {
        const missingLineIds = generated
          .filter((item) => !view.lines.some((candidate) => candidate.id === item.line.id))
          .map((item) => item.line.id)
        if (missingLineIds.length > 0) {
          throw new Error(`These target scene lines no longer exist: ${missingLineIds.join(', ')}`)
        }
        for (const item of generated) {
          const line = view.lines.find((candidate) => candidate.id === item.line.id)
          if (!line) throw new Error(`The target scene line ${item.line.id} no longer exists.`)
          if (
            run &&
            (!run.targetLineIds.includes(item.line.id) ||
              !run.targetLineSnapshots.some((snapshot) =>
                sceneLineMatchesSnapshot(snapshot, item.line),
              ))
          ) {
            throw new Error(`Scene ${item.line.id} is not part of the active generation snapshot.`)
          }
          if (!sceneLineMatchesSnapshot(line, item.line)) {
            throw new Error(
              `Scene ${item.line.index + 1} changed while its direction was being drafted.`,
            )
          }
          const record = item.record
          if (
            record.lineId !== line.id ||
            record.sourceFingerprint !== currentFingerprint ||
            (run && record.sourceFingerprint !== run.sourceFingerprint)
          ) {
            throw new Error('The script or visual bible changed while the scene was being drafted.')
          }
          line.sceneRecord = record
          line.sceneDescription = record.direction
          line.scenePrompt = composeScenePrompt(line.text, record.direction)
          line.directionStatus = 'complete'
          line.directionError = undefined
          line.sceneStatus = 'draft'
          line.imagePath = undefined
          line.error = undefined
        }
      })
      const state = await window.studio.project.save(manifest)
      applyProjectState(state)
      console.info(
        '[Higgsfilm][SceneGeneration] scenes saved',
        JSON.stringify({
          sequence,
          lineIds: generated.map((item) => item.line.id),
          directionChars: generated.map((item) => item.record.direction.length),
        }),
      )
      return state
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  async function draftSingleLinePrompt(
    fullState: ProjectState,
    lineId: string,
    sequence: SequenceId = activeSequence,
    refinement?: string,
    requestId?: string,
  ): Promise<{ state: ProjectState; line: ScriptLine }> {
    const workingState = await updateDirectionStatus(lineId, 'generating', undefined, sequence)
    const line = findLineInProject(workingState, lineId, sequence)
    if (!line) throw new Error('The selected narration line no longer exists.')

    const acceptedLedger = acceptedLedgerForSequence(workingState, sequence, line.index)
    const record = await generateSceneRecordWithRetry(
      workingState,
      line,
      sequence,
      acceptedLedger,
      refinement,
      requestId,
    )

    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = stateWithLatestLocalVisualBible(
        (await window.studio.project.get()) || fullState,
      )
      const manifest = cloneManifest(currentState.manifest)
      const currentLine = sequenceManifestFromProject(manifest, sequence).lines.find(
        (candidate) => candidate.id === lineId,
      )
      if (!currentLine) throw new Error('The selected narration line no longer exists.')
      mutateSequenceManifest(manifest, sequence, (view) => {
        const lineToSave = view.lines.find((candidate) => candidate.id === lineId)
        if (!lineToSave) throw new Error('The selected narration line no longer exists.')
        if (!sceneLineMatchesSnapshot(lineToSave, line)) {
          throw new Error('The selected narration line changed while its direction was being drafted.')
        }
        if (record.sourceFingerprint !== sceneContextFingerprint(currentState.manifest, sequence)) {
          throw new Error('The script or visual bible changed while the scene was being drafted.')
        }
        lineToSave.sceneRecord = record
        lineToSave.sceneDescription = record.direction
        lineToSave.scenePrompt = composeScenePrompt(lineToSave.text, record.direction)
        if (refinement !== undefined) {
          lineToSave.promptRefinement = refinement.trim() || undefined
        }
        lineToSave.directionStatus = 'complete'
        lineToSave.directionError = undefined
        lineToSave.sceneStatus = 'draft'
        lineToSave.imagePath = undefined
        lineToSave.error = undefined
      })
      const state = await window.studio.project.save(manifest)
      applyProjectState(state)
      console.info(
        '[Higgsfilm][SceneGeneration] scene saved',
        JSON.stringify({
          sequence,
          lineId,
          sceneNumber: line.index + 1,
          directionChars: record.direction.length,
        }),
      )
      const savedLine = findLineInProject(state, lineId, sequence)
      if (!savedLine) throw new Error('The drafted narration line could not be saved.')
      return { state, line: savedLine }
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  function sceneRunOwned(run: SceneGenerationRun): boolean {
    return activeSceneGenerationRunRef.current?.id === run.id
  }

  function sceneRunActive(run: SceneGenerationRun): boolean {
    return sceneRunOwned(run) && !run.cancelled
  }

  async function generateSceneJobWithFallback(
    run: SceneGenerationRun,
    job: SceneGenerationJob,
    acceptedLedger: SceneLedgerEntry[],
  ): Promise<SceneGenerationJobResult> {
    const jobKey = `${job.paragraphIndex}:${job.chunkIndex}`
    console.info(
      '[Higgsfilm][SceneGeneration] job started',
      JSON.stringify({
        runId: run.requestId,
        jobKey,
        targetLineIds: job.targetLines.map((line) => line.id),
      }),
    )
    const line = job.targetLines[0]
    const records: SceneDirectionRecord[] = []
    const failures: SceneGenerationFailure[] = []
    if (!line) {
      failures.push({
        line: job.paragraphLines[0]!,
        message: 'Scene generation job did not contain a target line.',
      })
    } else if (!sceneRunActive(run)) {
      failures.push({ line, message: 'Scene generation cancelled.' })
    } else {
      try {
        records.push(
          await generateSceneRecordWithRetry(
            run.state,
            line,
            run.sequence,
            acceptedLedger,
            undefined,
            run.requestId,
          ),
        )
      } catch (error) {
        failures.push({
          line,
          message: error instanceof Error ? error.message : 'Scene generation failed.',
        })
      }
    }

    console.info(
      '[Higgsfilm][SceneGeneration] job resolved',
      JSON.stringify({
        runId: run.requestId,
        jobKey,
        records: records.map((record) => record.lineId),
        failures: failures.map((failure) => ({
          lineId: failure.line.id,
          message: failure.message,
        })),
      }),
    )
    return { job, records, failures }
  }

  async function generateContextualPrompts(
    baseState = project,
    startIndex = 0,
    onlyMissing = false,
    endIndex?: number,
    sequence: SequenceId = activeSequence,
    queueImages = false,
  ): Promise<void> {
    if (!baseState) {
      showNotice('info', 'Import a script before drafting contextual scene prompts.')
      return
    }
    baseState = stateWithLatestLocalVisualBible(baseState)
    const initialSequenceLines = sequenceManifestFromProject(baseState.manifest, sequence)
      .lines
      .slice()
      .sort((left, right) => left.index - right.index)
    if (initialSequenceLines.length === 0) {
      showNotice('info', 'Import a script before drafting contextual scene prompts.')
      return
    }
    if (contextPromptsBusy) {
      showNotice('info', 'A scene direction is already being drafted. Wait for it to finish or cancel it first.')
      return
    }
    const runId = sceneGenerationRunIdRef.current + 1
    sceneGenerationRunIdRef.current = runId
    const run: SceneGenerationRun = {
      id: runId,
      requestId: `scene-run-${runId}`,
      projectId: baseState.manifest.id,
      sequence,
      sourceFingerprint: sceneContextFingerprint(baseState.manifest, sequence),
      state: structuredClone(baseState),
      targetLineIds: [],
      targetLineSnapshots: [],
      acceptedLedger: [],
      outcomes: new Map(),
      cancelled: false,
    }
    activeSceneGenerationRunRef.current = run
    let promptState: ProjectState = baseState
    setContextPromptsBusy(true)
    cancelContextPromptsRef.current = false
    const startedAt = Date.now()
    setContextPromptProgress({
      phase: 'summary',
      current: 0,
      total: initialSequenceLines.length,
      completed: 0,
      lineText: 'Building the whole-script continuity summary…',
      startedAt,
    })
    let claimedLineIds: string[] = []
    try {
      try {
        promptState = await ensureScriptSummary(promptState, sequence, run.requestId)
      } catch (error) {
        if (!sceneRunActive(run)) throw error
        console.warn(
          '[Higgsfilm][SceneGeneration] continuity summary unavailable; continuing with full script context',
          JSON.stringify({
            runId: run.requestId,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        showNotice('info', 'Continuity summary unavailable; drafting scenes from the full script instead.')
        promptState = baseState
      }
      const sequenceLines = sequenceManifestFromProject(promptState.manifest, sequence)
        .lines
        .slice()
        .sort((left, right) => left.index - right.index)
      run.state = structuredClone(promptState)
      run.sourceFingerprint = sceneContextFingerprint(promptState.manifest, sequence)
      run.acceptedLedger = acceptedLedgerForSequence(run.state, sequence)
      const linesToDraft = sequenceLines
        .slice(Math.max(0, startIndex), endIndex)
        .filter(
          (line) =>
            (!onlyMissing || !hasCurrentDirectionPrompt(line, promptState, sequence)) &&
            !activePromptLineIdsRef.current.has(line.id),
        )
      if (linesToDraft.length === 0) {
        showNotice('info', 'There are no scenes to draft from the selected line.')
        return
      }
      claimedLineIds = linesToDraft.map((line) => line.id)
      run.targetLineIds = [...claimedLineIds]
      run.targetLineSnapshots = structuredClone(linesToDraft)
      run.outcomes = new Map(linesToDraft.map((line) => [line.id, 'pending']))
      claimedLineIds.forEach((lineId) => activePromptLineIdsRef.current.add(lineId))
      setContextPromptProgress({
        phase: 'prompts',
        current: linesToDraft[0].index + 1,
        total: linesToDraft.length,
        completed: 0,
        lineText: linesToDraft[0].text,
        startedAt,
      })

      const linesById = new Map(sequenceLines.map((line) => [line.id, line]))
      const groups: SceneGenerationJob[] = buildSceneGenerationJobPlans(
        sequenceLines,
        linesToDraft.map((line) => line.id),
        MAX_PARAGRAPH_BATCH_LINES,
      ).map((plan) => {
        const paragraphLines = plan.paragraphLineIds.map((lineId) => linesById.get(lineId))
        const targetLines = plan.targetLineIds.map((lineId) => linesById.get(lineId))
        if (paragraphLines.some((line) => !line) || targetLines.some((line) => !line)) {
          throw new Error(`Scene-generation job ${plan.paragraphIndex}:${plan.chunkIndex} has a missing line.`)
        }
        return {
          paragraphIndex: plan.paragraphIndex,
          chunkIndex: plan.chunkIndex,
          paragraphLines: paragraphLines as ScriptLine[],
          targetLines: targetLines as ScriptLine[],
        }
      })
      const outcomeByLineId = run.outcomes
      await updateDirectionStatuses(
        linesToDraft.map((line) => line.id),
        'generating',
        undefined,
        sequence,
      )
      let committedLedger: SceneLedgerEntry[] = []

      for (const wave of sceneGenerationWaves(groups, MAX_PARALLEL_SCENE_AGENTS)) {
        const waveLedger = new Map<SceneGenerationJob, SceneLedgerEntry[]>()
        for (const job of wave) {
          const stableLedger = run.acceptedLedger.filter(
            (entry) => entry.lineIndex < job.targetLines[0].index,
          )
          waveLedger.set(job, mergeSceneLedgers(stableLedger, committedLedger))
        }

        const results = await Promise.all(
          wave.map((job) => {
            const ledger = waveLedger.get(job) || []
            if (!sceneRunActive(run)) {
              return Promise.resolve<SceneGenerationJobResult>({
                job,
                records: [],
                failures: job.targetLines.map((line) => ({
                  line,
                  message: 'Scene generation cancelled.',
                })),
              })
            }
            return generateSceneJobWithFallback(run, job, ledger)
          }),
        )

        for (const result of results) {
          const { job } = result
          const recordsById = new Map(result.records.map((record) => [record.lineId, record]))
          const recordsToSave: Array<{ line: ScriptLine; record: SceneDirectionRecord }> = []
          const failures = [...result.failures]

          for (const line of job.targetLines) {
            const record = recordsById.get(line.id)
            if (!record) continue
            if (
              record.lineId !== line.id ||
              record.sourceFingerprint !== run.sourceFingerprint ||
              !record.direction.trim()
            ) {
              failures.push({
                line,
                message: 'The returned scene direction did not match the active scene snapshot.',
              })
              continue
            }
            recordsToSave.push({ line, record })
          }

          if (recordsToSave.length > 0) {
            try {
              promptState = await saveGeneratedPrompts(
                promptState,
                recordsToSave,
                sequence,
                run,
              )
              for (const item of recordsToSave) {
                outcomeByLineId.set(item.line.id, 'complete')
                committedLedger = mergeSceneLedgers(
                  committedLedger,
                  [sceneLedgerEntry(item.line, item.record)],
                )
              }
              if (
                queueImages &&
                !stillCastEnabledRef.current &&
                automaticImageGenerationEnabledRef.current &&
                !run.cancelled
              ) {
                for (const item of recordsToSave) {
                  const savedLine = findLineInProject(promptState, item.line.id, sequence)
                  if (savedLine) await queueSceneForLine(promptState, savedLine, sequence)
                }
              }
            } catch (error) {
              for (const item of recordsToSave) {
                failures.push({
                  line: item.line,
                  message: error instanceof Error ? error.message : 'Could not commit scene direction.',
                })
              }
            }
          }

          for (const failure of failures) {
            if (outcomeByLineId.get(failure.line.id) === 'complete') continue
            const cancelled = !sceneRunActive(run)
            outcomeByLineId.set(failure.line.id, cancelled ? 'cancelled' : 'failed')
            await updateDirectionStatus(
              failure.line.id,
              cancelled ? 'draft' : 'failed',
              cancelled ? undefined : failure.message,
              sequence,
            ).catch(() => undefined)
          }

          const completedCount = [...outcomeByLineId.values()].filter(
            (outcome) => outcome === 'complete',
          ).length
          const failedCount = [...outcomeByLineId.values()].filter(
            (outcome) => outcome === 'failed',
          ).length
          const lastLine = job.targetLines[job.targetLines.length - 1]
          setContextPromptProgress((current) =>
            current
              ? {
                  ...current,
                  current: lastLine.index + 1,
                  completed: completedCount,
                  lineText: `Paragraph ${job.paragraphIndex + 1}: ${lastLine.text}`,
                }
              : current,
          )
        }

        if (!sceneRunActive(run)) break
      }

      const unresolvedIds = [...outcomeByLineId.entries()]
        .filter(([, outcome]) => outcome === 'pending')
        .map(([lineId]) => lineId)
      if (unresolvedIds.length > 0) {
        const cancelled = !sceneRunActive(run)
        for (const lineId of unresolvedIds) {
          outcomeByLineId.set(lineId, cancelled ? 'cancelled' : 'failed')
        }
        await updateDirectionStatuses(
          unresolvedIds,
          cancelled ? 'draft' : 'failed',
          cancelled ? undefined : 'Scene generation ended before this line was committed.',
          sequence,
        ).catch(() => undefined)
      }

      const completedCount = [...outcomeByLineId.values()].filter(
        (outcome) => outcome === 'complete',
      ).length
      const failedCount = [...outcomeByLineId.values()].filter(
        (outcome) => outcome === 'failed',
      ).length
      for (const [lineId, outcome] of outcomeByLineId) {
        console.info(
          '[Higgsfilm][SceneGeneration] terminal outcome',
          JSON.stringify({
            runId: run.requestId,
            sequence,
            lineId,
            outcome,
          }),
        )
      }
      if (!sceneRunActive(run)) {
        showNotice(
          'info',
          `Paragraph scene drafting cancelled. ${completedCount} completed scene(s) were saved.`,
        )
      } else if (failedCount > 0) {
        showNotice(
          'error',
          `ChatGPT drafted ${completedCount} scene prompt(s) with five concurrent scene agents; ${failedCount} failed and can be retried.`,
        )
      } else {
        showNotice('success', `ChatGPT drafted ${completedCount} contextual prompts with five concurrent scene agents.`)
      }
    } catch (error) {
      if (run.cancelled || cancelContextPromptsRef.current) {
        showNotice('info', 'Paragraph scene drafting cancelled. Completed lines were saved.')
        return
      }
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not draft contextual scene prompts.',
      )
    } finally {
      claimedLineIds.forEach((lineId) => activePromptLineIdsRef.current.delete(lineId))
      if (sceneRunOwned(run)) activeSceneGenerationRunRef.current = null
      cancelContextPromptsRef.current = false
      setContextPromptsBusy(false)
      setContextPromptProgress(null)
    }
  }

  async function regenerateAllPrompts(): Promise<void> {
    let state = await persistLatestLocalVisualBible(
      (await window.studio.project.get()) || project,
    )
    if (!state) return
    showNotice('info', 'Stopping old image jobs and clearing cached scene directions and images.')
    imageGenerationRequestVersionRef.current += 1
    imageGenerationCancelledRef.current = true
    const pendingImageSubmissions = imageSubmitQueueRef.current
    try {
      await pendingImageSubmissions.catch(() => undefined)
      await window.studio.higgs.cancel()
      state = await window.studio.project.resetSceneGenerationCache(activeSequence)
      await loadProject(state)
      imageGenerationCancelledRef.current = false
      showNotice('info', 'Cached scene directions and images cleared. Regenerating all prompts from Scene 1.')
      await generateContextualPrompts(
        state,
        0,
        false,
        undefined,
        activeSequence,
        false,
      )
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not clear the scene-generation cache.',
      )
    }
  }

  async function generateSelectedPrompt(): Promise<void> {
    if (!project || !selectedLine) return
    if (stillCastEnabled) {
      await generateStillCastBeats(selectedLine.index, false, selectedLine.id)
      return
    }
    const lineId = selectedLine.id
    if (contextPromptsBusy || activePromptLineIdsRef.current.has(lineId)) {
      showNotice('info', 'This scene direction is already being drafted.')
      return
    }

    activePromptLineIdsRef.current.add(lineId)
    cancelContextPromptsRef.current = false
    setContextPromptsBusy(true)
    setContextPromptProgress({
      current: selectedLine.index + 1,
      total: 1,
      completed: 0,
      lineText: selectedLine.text,
      startedAt: Date.now(),
    })

    try {
      const generationState = await persistLatestLocalVisualBible(project)
      if (!generationState) return
      const drafted = await draftSingleLinePrompt(generationState, lineId, activeSequence)
      setContextPromptProgress((current) =>
        current ? { ...current, completed: 1 } : current,
      )
      showNotice('success', `Scene ${drafted.line.index + 1} prompt generated.`)
    } catch (error) {
      const cancelled = cancelContextPromptsRef.current
      await updateDirectionStatus(
        lineId,
        cancelled ? 'draft' : 'failed',
        cancelled ? undefined : error instanceof Error ? error.message : 'Prompt generation failed.',
        activeSequence,
      ).catch(() => undefined)
      showNotice(
        cancelled ? 'info' : 'error',
        cancelled
          ? 'Prompt generation cancelled.'
          : error instanceof Error
            ? error.message
            : 'Could not generate the selected prompt.',
      )
    } finally {
      activePromptLineIdsRef.current.delete(lineId)
      cancelContextPromptsRef.current = false
      setContextPromptsBusy(false)
      setContextPromptProgress(null)
    }
  }

  async function regeneratePromptWithRefinement(): Promise<void> {
    if (!project || !selectedLine) return
    const lineId = selectedLine.id
    const refinement = selectedLine.promptRefinement?.trim() || ''
    if (!refinement) {
      showNotice('info', 'Add a specific refinement before regenerating this prompt.')
      return
    }
    if (contextPromptsBusy || activePromptLineIdsRef.current.has(lineId)) {
      showNotice('info', 'This scene direction is already being drafted.')
      return
    }

    const sequence = activeSequence
    activePromptLineIdsRef.current.add(lineId)
    cancelContextPromptsRef.current = false
    setContextPromptsBusy(true)
    setContextPromptProgress({
      current: selectedLine.index + 1,
      total: 1,
      completed: 0,
      lineText: selectedLine.text,
      startedAt: Date.now(),
    })

    try {
      const generationState = await persistLatestLocalVisualBible(project)
      if (!generationState) return
      const drafted = await draftSingleLinePrompt(generationState, lineId, sequence, refinement)
      setContextPromptProgress((current) =>
        current ? { ...current, completed: 1 } : current,
      )
      showNotice('success', `Scene ${drafted.line.index + 1} prompt regenerated with your refinement.`)
    } catch (error) {
      const cancelled = cancelContextPromptsRef.current
      await updateDirectionStatus(
        lineId,
        cancelled ? 'draft' : 'failed',
        cancelled ? undefined : error instanceof Error ? error.message : 'Prompt regeneration failed.',
        sequence,
      ).catch(() => undefined)
      if (cancelled) {
        showNotice('info', 'Prompt refinement cancelled.')
      } else {
        showNotice(
          'error',
          error instanceof Error ? error.message : 'Could not regenerate the refined prompt.',
        )
      }
    } finally {
      activePromptLineIdsRef.current.delete(lineId)
      cancelContextPromptsRef.current = false
      setContextPromptsBusy(false)
      setContextPromptProgress(null)
    }
  }

  async function cancelContextualPrompts(): Promise<void> {
    if (!contextPromptsBusy) return
    cancelContextPromptsRef.current = true
    const activeRun = activeSceneGenerationRunRef.current
    if (activeRun) activeRun.cancelled = true
    await window.studio.llm.cancel(activeRun?.requestId).catch(() => undefined)
  }

  async function draftAndQueueRecordedLine(
    lineId: string,
    sequence: SequenceId = activeSequence,
  ): Promise<void> {
    if (activeSceneGenerationRunRef.current) return
    if (activeDirectionLinesRef.current.has(lineId)) return
    if (stillCastEnabledRef.current) return
    if (!automaticImageGenerationEnabledRef.current) return
    const state = await window.studio.project.get()
    const line = state ? findLineInProject(state, lineId, sequence) : undefined
    if (!state || !line) return
    if (
      activePromptLineIdsRef.current.has(lineId) ||
      line.directionStatus === 'generating' ||
      hasDirectionPrompt(line)
    ) {
      return
    }
    const sequenceLines = sequenceManifestFromProject(state.manifest, sequence).lines

    imageGenerationCancelledRef.current = false
    activePromptLineIdsRef.current.add(lineId)
    activeDirectionLinesRef.current.add(lineId)
    cancelContextPromptsRef.current = false
    setContextPromptsBusy(true)
    const startedAt = Date.now()
    setContextPromptProgress({
      current: line.index + 1,
      total: sequenceLines.length,
      completed: 0,
      lineText: line.text,
      startedAt,
    })

    try {
      if (
        cancelContextPromptsRef.current ||
        !automaticImageGenerationEnabledRef.current ||
        imageGenerationCancelledRef.current
      ) {
        return
      }
      let drafted: { state: ProjectState; line: ScriptLine }
      try {
        drafted = await draftSingleLinePrompt(state, lineId, sequence)
      } catch (error) {
        if (!cancelContextPromptsRef.current) {
          await updateDirectionStatus(
            lineId,
            'failed',
            error instanceof Error ? error.message : 'Direction generation failed.',
            sequence,
          ).catch(() => undefined)
        }
        throw error
      }
      if (
        cancelContextPromptsRef.current ||
        !automaticImageGenerationEnabledRef.current ||
        imageGenerationCancelledRef.current
      ) {
        return
      }
      setContextPromptProgress({
        current: drafted.line.index + 1,
        total: sequenceLines.length,
        completed: 1,
        lineText: drafted.line.text,
        startedAt,
      })
      const queued = await queueSceneForLine(drafted.state, drafted.line, sequence)
      if (queued) showNotice('success', `Scene ${drafted.line.index + 1} direction ready; image queued.`)
    } catch (error) {
      if (!cancelContextPromptsRef.current) {
        showNotice(
          'error',
          error instanceof Error ? error.message : `Could not draft scene ${line.index + 1}.`,
        )
      }
    } finally {
      activePromptLineIdsRef.current.delete(lineId)
      activeDirectionLinesRef.current.delete(lineId)
      const stillDrafting = activeDirectionLinesRef.current.size > 0
      setContextPromptsBusy(stillDrafting)
      if (!stillDrafting) setContextPromptProgress(null)
    }
  }

  async function queueSceneForLine(
    state: ProjectState,
    line: ScriptLine,
    sequence: SequenceId = activeSequence,
  ): Promise<boolean> {
    const requestVersion = imageGenerationRequestVersionRef.current
    const submitTask = imageSubmitQueueRef.current.then(async () => {
      try {
        if (
          imageGenerationCancelledRef.current ||
          requestVersion !== imageGenerationRequestVersionRef.current
        ) {
          return false
        }
        const queuedState = await window.studio.higgs.queueScene({
          lineId: line.id,
          sequence,
          prompt: line.scenePrompt,
          promptFingerprint: scenePromptFingerprint(line.scenePrompt),
          modelEndpoint: modelEndpointForProvider(studioSettings.imageGenerator, higgsStatus),
          aspectRatio: sequence === 'trailer' ? '9:16' : '16:9',
          resolution: '1k',
        })
        if (
          imageGenerationCancelledRef.current ||
          requestVersion !== imageGenerationRequestVersionRef.current
        ) {
          return false
        }
        applyProjectState(queuedState)
        return true
      } catch (error) {
        if (
          requestVersion === imageGenerationRequestVersionRef.current &&
          !imageGenerationCancelledRef.current
        ) {
          showNotice('error', error instanceof Error ? error.message : `Could not queue scene ${line.index + 1}.`)
        }
        return false
      }
    })
    imageSubmitQueueRef.current = submitTask.then(
      () => undefined,
      () => undefined,
    )
    return submitTask
  }

  async function queueAutomaticImages(state: ProjectState, sequence: SequenceId): Promise<void> {
    if (!automaticImageGenerationEnabledRef.current || imageGenerationCancelledRef.current) return
    if (stillCastEnabledRef.current) return
    const candidates = sequenceManifestFromProject(state.manifest, sequence).lines.filter(
      (line) => hasCurrentDirectionPrompt(line, state, sequence) && !hasImage(line),
    )
    if (candidates.length === 0) {
      showNotice('info', 'Scene directions and voice are ready; there are no images waiting to generate.')
      return
    }

    try {
      await window.studio.higgs.resume()
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not resume image generation.',
      )
      return
    }

    setImageBatchBusy(true)
    try {
      const results = await Promise.all(
        candidates.map((line) => queueSceneForLine(state, line, sequence)),
      )
      const queuedCount = results.filter(Boolean).length
      showNotice(
        'info',
        `${queuedCount} image generation(s) started after voice and scene directions completed.`,
      )
    } finally {
      setImageBatchBusy(false)
    }
  }

  function toggleAutomaticImageGeneration(): void {
    const enabled = !automaticImageGenerationEnabledRef.current
    automaticImageGenerationEnabledRef.current = enabled
    setAutomaticImageGenerationEnabled(enabled)
    try {
      window.localStorage.setItem(AUTOMATIC_IMAGE_GENERATION_KEY, enabled ? 'on' : 'off')
    } catch {
      // The in-memory preference still applies if storage is unavailable.
    }
    if (!enabled) {
      imageGenerationRequestVersionRef.current += 1
      imageGenerationCancelledRef.current = true
      showNotice('info', 'Automatic recording-to-image generation is off. Manual generation remains available.')
    } else {
      imageGenerationCancelledRef.current = false
      void (async () => {
        try {
          const state = await window.studio.project.get()
          if (state) await queueAutomaticImages(state, activeSequence)
          showNotice('success', 'Automatic recording-to-image generation is on.')
        } catch (error) {
          showNotice(
            'error',
            error instanceof Error ? error.message : 'Could not resume image generation.',
          )
        }
      })()
    }
  }

  async function cancelImageGenerations(): Promise<void> {
    imageGenerationRequestVersionRef.current += 1
    imageGenerationCancelledRef.current = true
    automaticImageGenerationEnabledRef.current = false
    setAutomaticImageGenerationEnabled(false)
    try {
      window.localStorage.setItem(AUTOMATIC_IMAGE_GENERATION_KEY, 'off')
    } catch {
      // The in-memory preference still applies if storage is unavailable.
    }
    setImageCancelBusy(true)
    try {
      await window.studio.higgs.cancel()
      showNotice('info', 'Pending image generations were cancelled.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not cancel image generations.')
    } finally {
      setImageCancelBusy(false)
      setImageBatchBusy(false)
    }
  }

  async function setLineImageTag(
    lineIds: string[],
    tag: string,
    present: boolean,
    sequence: SequenceId = activeSequence,
  ): Promise<ProjectState | null> {
    if (lineIds.length === 0) return projectStateRef.current || project
    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = await window.studio.project.get()
      if (!currentState) throw new Error('Choose a project folder first.')
      const manifest = cloneManifest(stateWithLatestLocalVisualBible(currentState).manifest)
      mutateSequenceManifest(manifest, sequence, (view) => {
        for (const lineId of lineIds) {
          const currentLine = view.lines.find((candidate) => candidate.id === lineId)
          if (!currentLine) continue
          const next = present ? withImageTag(currentLine, tag) : withoutImageTag(currentLine, tag)
          currentLine.imageTags = next.imageTags ?? []
        }
      })
      const state = await window.studio.project.save(manifest)
      applyProjectState(state)
      return state
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  async function clearRegeneratedImageReview(
    sequence: SequenceId = activeSequence,
  ): Promise<ProjectState | null> {
    const current = projectStateRef.current || project
    if (!current) return null
    const ids = lineIdsWithImageTag(
      sequenceManifestFromProject(current.manifest, sequence).lines,
      REGENERATED_IMAGE_TAG,
    )
    setTimelineImageFilter('all')
    if (ids.length === 0) return current
    return setLineImageTag(ids, REGENERATED_IMAGE_TAG, false, sequence)
  }

  async function acceptRegeneratedImage(lineId: string): Promise<void> {
    try {
      const state = await setLineImageTag([lineId], REGENERATED_IMAGE_TAG, false)
      const lines = sequenceManifestFromProject(
        (state || projectStateRef.current)!.manifest,
        activeSequence,
      ).lines
      const next = nextRegeneratedLine(lines, lineId)
      if (next) {
        pendingTimelineScrollRef.current = next.id
        setActiveLineId(next.id)
      } else {
        setTimelineImageFilter('all')
        pendingTimelineScrollRef.current = lineId
        setActiveLineId(lineId)
      }
      showNotice('success', 'Marked this regeneration as good.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not mark this image as good.')
    }
  }

  async function generateSelectedImage(): Promise<void> {
    if (!project || !selectedLine) return
    imageGenerationCancelledRef.current = false
    try {
      const state = await persistLatestLocalVisualBible(project)
      const line = state ? findLineInProject(state, selectedLine.id, activeSequence) : undefined
      if (!state || !line) throw new Error('The selected scene no longer exists.')
      const taggedState = await setLineImageTag([line.id], REGENERATED_IMAGE_TAG, true)
      await window.studio.higgs.resume()
      await queueSceneForLine(taggedState || state, line, activeSequence)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not generate the selected image.')
    }
  }

  async function generateSelectedStillCastImages(): Promise<void> {
    if (!selectedLine) return
    await setLineImageTag([selectedLine.id], REGENERATED_IMAGE_TAG, true)
    await assignStillCastImages({ lineIds: [selectedLine.id], reroll: true })
  }

  async function queueImageBatch(scope: 'all' | 'from-here' | 'remaining'): Promise<void> {
    if (!project) return
    imageGenerationCancelledRef.current = false
    let state = await persistLatestLocalVisualBible(project)
    if (!state) return
    const selectedIndex = selectedLine?.index || 0
    const getCandidates = (currentState: ProjectState): ScriptLine[] => {
      const sequenceLines = sequenceManifestFromProject(currentState.manifest, activeSequence)
        .lines
        .slice()
        .sort((left, right) => left.index - right.index)
      const scopedLines =
        scope === 'from-here'
          ? sequenceLines.slice(selectedIndex)
          : sequenceLines
      return scopedLines.filter((line) => {
        if (!hasDirectionPrompt(line)) return false
        return scope === 'remaining' ? !hasImage(line) : true
      })
    }

    let candidates = getCandidates(state)

    if (candidates.length === 0) {
      showNotice(
        'info',
        scope === 'remaining'
          ? 'There are no remaining direction-ready images to generate.'
          : 'There are no direction-ready scenes in that range.',
      )
      return
    }

    const hasActiveImageQueue = [state.manifest.lines, state.manifest.trailer?.lines || []].some(
      (lines) =>
        lines.some((line) => line.sceneStatus === 'queued' || line.sceneStatus === 'generating'),
    )
    const existingImageCount = candidates.filter((line) => hasImage(line)).length
    const shouldConfirmRegeneration =
      (scope !== 'remaining' && existingImageCount > 0) ||
      (scope === 'all' && (hasActiveImageQueue || imageBatchBusy))
    if (
      shouldConfirmRegeneration &&
      !window.confirm(
        scope === 'all'
          ? `This will cancel active image jobs and regenerate all ${candidates.length} direction-ready scenes from Scene 1, including ${existingImageCount} existing image(s). Continue?`
          : `This will regenerate ${existingImageCount} existing image(s) and generate the rest. Continue?`,
      )
    ) {
      return
    }

    setImageBatchBusy(true)
    try {
      if (scope === 'all') {
        imageGenerationRequestVersionRef.current += 1
        imageGenerationCancelledRef.current = true
        if (hasActiveImageQueue || imageBatchBusy) {
          await window.studio.higgs.cancel()
        }
        state = (await clearRegeneratedImageReview(activeSequence)) || state
        state = (await window.studio.project.get()) || state
        candidates = getCandidates(state)
        if (candidates.length === 0) {
          showNotice('info', 'There are no direction-ready scenes to regenerate.')
          return
        }
        imageGenerationCancelledRef.current = false
      }

      await window.studio.higgs.resume()
      const results: boolean[] = []
      for (const line of candidates) {
        if (imageGenerationCancelledRef.current) break
        results.push(await queueSceneForLine(state, line, activeSequence))
      }
      const queuedCount = results.filter(Boolean).length
      const providerLabel = imageProviderLabel(studioSettings.imageGenerator)
      showNotice('info', `${queuedCount} image generation(s) added to the ${providerLabel} queue.`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not restart image generation.')
    } finally {
      setImageBatchBusy(false)
    }
  }

  async function saveProject(manifest = project?.manifest): Promise<ProjectState | null> {
    if (!manifest) return null
    setSaving(true)
    try {
      const state = await window.studio.project.save(manifest)
      await loadProject(state)
      showNotice('success', 'Project saved locally.')
      return state
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save the project.')
      return null
    } finally {
      setSaving(false)
    }
  }

  function stateWithLatestLocalVisualBible(state: ProjectState): ProjectState {
    const localState = projectStateRef.current
    if (!localState || localState.manifest.id !== state.manifest.id) return state
    return {
      ...state,
      manifest: {
        ...state.manifest,
        visualBible: structuredClone(localState.manifest.visualBible),
      },
    }
  }

  async function persistLatestLocalVisualBible(
    fallbackState: ProjectState | null,
  ): Promise<ProjectState | null> {
    const currentState = (await window.studio.project.get()) || fallbackState
    if (!currentState) return null
    const mergedState = stateWithLatestLocalVisualBible(currentState)
    if (
      JSON.stringify(mergedState.manifest.visualBible) ===
      JSON.stringify(currentState.manifest.visualBible)
    ) {
      return currentState
    }
    const savedState = await window.studio.project.save(mergedState.manifest)
    applyProjectState(savedState)
    return savedState
  }

  async function writeVisualBibleToProject(bible: VisualBible): Promise<void> {
    const currentProject = projectStateRef.current || project
    if (!currentProject) return
    if (
      JSON.stringify(currentProject.manifest.visualBible) === JSON.stringify(bible)
    ) {
      return
    }
    if (contextPromptsBusy) await cancelContextualPrompts()
    imageGenerationRequestVersionRef.current += 1
    imageGenerationCancelledRef.current = true
    await window.studio.higgs.cancel().catch(() => undefined)

    const currentState = (await window.studio.project.get()) || currentProject
    const manifest = cloneManifest(currentState.manifest)
    manifest.visualBible = structuredClone(bible)
    invalidateVisualBibleDependentState(manifest)
    const state = await window.studio.project.save(manifest)
    await loadProject(state)
    imageGenerationCancelledRef.current = false
  }

  async function saveProductionBible(name: string): Promise<void> {
    if (!project) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      showNotice('info', 'Enter a name before saving the production bible.')
      return
    }

    setProductionBibleBusy(true)
    try {
      const localState = projectStateRef.current || project
      const currentState = await window.studio.project.save(localState.manifest)
      await loadProject(currentState)
      const saved = await window.studio.productionBibles.save(
        trimmedName,
        currentState.manifest.visualBible,
      )
      setProductionBibles(saved)
      showNotice('success', `Saved production bible "${trimmedName}".`)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not save the production bible.',
      )
    } finally {
      setProductionBibleBusy(false)
    }
  }

  async function loadProductionBible(name: string): Promise<void> {
    if (!project || !name) return
    if (
      projectHasSceneWork(project) &&
      !window.confirm(
        'Loading a production bible will clear existing scene directions and images because they were generated with the current style. Continue?',
      )
    ) {
      return
    }

    setProductionBibleBusy(true)
    try {
      const preset = await window.studio.productionBibles.load(name)
      if (!preset) throw new Error(`Production bible "${name}" was not found.`)
      await writeVisualBibleToProject(preset.bible)
      showNotice('success', `Loaded production bible "${preset.name}" for this project.`)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not load the production bible.',
      )
    } finally {
      setProductionBibleBusy(false)
    }
  }

  async function saveChannelProfile(name: string): Promise<void> {
    const trimmedName = name.trim()
    if (!trimmedName) {
      showNotice('info', 'Enter a YouTube channel name before saving the profile.')
      return
    }

    setChannelProfileBusy(true)
    try {
      const localState = projectStateRef.current || project
      if (localState) {
        const currentState = await window.studio.project.save(localState.manifest)
        await loadProject(currentState)
      }
      const visualBible =
        (projectStateRef.current || project)?.manifest.visualBible || emptyVisualBible(trimmedName)
      const currentProfile =
        channelProfiles.find((profile) => profile.id === activeChannelProfileId) ||
        channelProfiles.find((profile) => profile.name.toLowerCase() === trimmedName.toLowerCase())
      const saved = await window.studio.channelProfiles.save({
        name: trimmedName,
        visualBible,
        imageGenerator: studioSettings.imageGenerator,
        comfy: studioSettings.comfy,
        productionMode: currentProfile?.productionMode,
        channelFolderPath: currentProfile?.channelFolderPath,
        stillLibraryPath: currentProfile?.stillLibraryPath,
        scriptBiblePath: currentProfile?.scriptBiblePath || scriptBiblePathLocal,
        ideaGuidePath: currentProfile?.ideaGuidePath || ideaGuidePathLocal,
        niche: currentProfile?.niche,
        youtubeHandle: currentProfile?.youtubeHandle,
        channelBrief: currentProfile?.channelBrief,
        channelBriefUpdatedAt: currentProfile?.channelBriefUpdatedAt,
      })
      setChannelProfiles(saved.profiles)
      setActiveChannelProfileId(saved.activeProfileId)
      showNotice('success', `Saved channel profile "${trimmedName}".`)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not save the channel profile.',
      )
    } finally {
      setChannelProfileBusy(false)
    }
  }

  async function chooseChannelFolder(): Promise<void> {
    setChannelProfileBusy(true)
    try {
      if (projectStateRef.current || project) {
        await unloadCurrentProject()
      }
      const saved = await window.studio.channelProfiles.chooseFolder()
      if (!saved) return
      setChannelProfiles(saved.profiles)
      setActiveChannelProfileId(saved.activeProfileId)
      const active = saved.profiles.find((profile) => profile.id === saved.activeProfileId)
      if (active) {
        const applied = await window.studio.channelProfiles.apply(active.id)
        setStudioSettings(applied.settings)
        if (applied.settings.imageGenerator === 'comfyui') {
          setComfyStatus(await window.studio.settings.getComfyStatus().catch(() => comfyStatus))
        }
        if (active.stillLibraryPath) {
          setStillCastLibrary(
            await window.studio.stillCast.scanLibrary(active.stillLibraryPath).catch(() => null),
          )
        }
      }
      showNotice(
        'success',
        active
          ? `Channel folder "${active.name}" is ready. Choose a project inside it to continue.`
          : 'Channel folder saved.',
      )
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not choose that channel folder.',
      )
    } finally {
      setChannelProfileBusy(false)
    }
  }

  async function prepareStillLibrary(): Promise<void> {
    const libraryPath =
      stillCastLibrary?.libraryPath ||
      activeChannelProfile?.stillLibraryPath ||
      (activeChannelProfile?.channelFolderPath
        ? `${activeChannelProfile.channelFolderPath}\\Expressions`
        : '')
    if (!libraryPath) {
      showNotice('info', 'Choose a channel folder first so Expressions can be found.')
      return
    }
    try {
      const scan = await window.studio.stillCast.prepareLibrary(libraryPath)
      setStillCastLibrary(scan)
      showNotice('success', 'Expression folders are ready. Drop stills into Happy, talk, point, and the rest.')
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not prepare the expression folders.',
      )
    }
  }

  async function applyChannelProfile(id: string): Promise<void> {
    if (id === activeChannelProfileId) {
      setChannelMenuOpen(false)
      return
    }
    const profile = channelProfiles.find((candidate) => candidate.id === id)
    if (project) {
      const channelName = profile?.name || 'this channel'
      if (
        !window.confirm(
          `Switch to "${channelName}"? This closes the current project. Choose a project folder after switching.`,
        )
      ) {
        return
      }
    }

    setChannelProfileBusy(true)
    try {
      if (projectStateRef.current || project) {
        await unloadCurrentProject()
      }
      const applied = await window.studio.channelProfiles.apply(id)
      setChannelProfiles(applied.profiles)
      setActiveChannelProfileId(applied.activeProfileId)
      setStudioSettings(applied.settings)
      if (applied.settings.imageGenerator === 'comfyui') {
        setComfyStatus(await window.studio.settings.getComfyStatus().catch(() => comfyStatus))
      }
      const appliedName = applied.profiles.find((candidate) => candidate.id === applied.activeProfileId)?.name
      showNotice(
        'success',
        appliedName
          ? `Loaded the "${appliedName}" channel. Choose a project folder inside it to continue.`
          : 'Cleared the active channel profile.',
      )
      setChannelMenuOpen(false)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not load the channel profile.',
      )
    } finally {
      setChannelProfileBusy(false)
    }
  }

  async function removeChannelProfile(id: string): Promise<void> {
    const profile = channelProfiles.find((candidate) => candidate.id === id)
    if (!id || !profile) return
    if (!window.confirm(`Delete the "${profile.name}" channel profile? This does not change the open project.`)) {
      return
    }
    setChannelProfileBusy(true)
    try {
      const remaining = await window.studio.channelProfiles.remove(id)
      setChannelProfiles(remaining.profiles)
      setActiveChannelProfileId(remaining.activeProfileId)
      showNotice('success', `Deleted channel profile "${profile.name}".`)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not delete the channel profile.',
      )
    } finally {
      setChannelProfileBusy(false)
    }
  }

  function updateVisualBibleField(
    key: keyof ProjectManifest['visualBible'],
    value: string,
  ): void {
    setProject((current) => {
      if (!current) return current
      const next = cloneManifest(current.manifest)
      next.visualBible[key] = value
      invalidateVisualBibleDependentState(next)
      const nextState = { ...current, manifest: next }
      projectStateRef.current = nextState
      return nextState
    })
  }

  function updateManifest(mutator: (manifest: ProjectManifest) => void): void {
    setProject((current) => {
      if (!current) return current
      const next = cloneManifest(current.manifest)
      mutateSequenceManifest(next, activeSequence, mutator)
      const nextState = { ...current, manifest: next }
      projectStateRef.current = nextState
      return nextState
    })
  }

  async function persistChannelProfilePatch(patch: {
    productionMode?: ChannelProductionMode
    stillLibraryPath?: string
    scriptBiblePath?: string
    ideaGuidePath?: string
    niche?: string
    youtubeHandle?: string
    channelBrief?: string
    channelBriefUpdatedAt?: string
  }): Promise<boolean> {
    const active = channelProfiles.find((profile) => profile.id === activeChannelProfileId)
    if (!active) {
      showNotice('info', 'Choose a channel folder first.')
      return false
    }
    setChannelProfileBusy(true)
    try {
      const saved = await window.studio.channelProfiles.save({
        id: active.id,
        name: active.name,
        visualBible: (projectStateRef.current || project)?.manifest.visualBible || active.visualBible,
        imageGenerator: studioSettings.imageGenerator,
        comfy: studioSettings.comfy,
        productionMode: patch.productionMode ?? active.productionMode,
        channelFolderPath: active.channelFolderPath,
        stillLibraryPath: patch.stillLibraryPath ?? active.stillLibraryPath,
        scriptBiblePath: patch.scriptBiblePath ?? active.scriptBiblePath,
        ideaGuidePath: patch.ideaGuidePath ?? active.ideaGuidePath,
        niche: patch.niche ?? active.niche,
        youtubeHandle:
          patch.youtubeHandle !== undefined
            ? normalizeYoutubeChannelHandle(patch.youtubeHandle)
            : active.youtubeHandle,
        channelBrief: patch.channelBrief ?? active.channelBrief,
        channelBriefUpdatedAt: patch.channelBriefUpdatedAt ?? active.channelBriefUpdatedAt,
      })
      setChannelProfiles(saved.profiles)
      setActiveChannelProfileId(saved.activeProfileId)
      refreshCustomImageSetup()
      if (patch.stillLibraryPath) {
        const scan = projectStateRef.current
          ? window.studio.stillCast.scanCatalog(patch.stillLibraryPath)
          : window.studio.stillCast.scanLibrary(patch.stillLibraryPath)
        setStillCastLibrary(await scan.catch(() => null))
      }
      return true
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not update the channel profile.',
      )
      return false
    } finally {
      setChannelProfileBusy(false)
    }
  }

  async function refreshChannelBrief(handleOverride?: string): Promise<void> {
    const active = channelProfiles.find((profile) => profile.id === activeChannelProfileId)
    if (!active) {
      showNotice('info', 'Choose a channel folder first.')
      return
    }
    const handle = normalizeYoutubeChannelHandle(handleOverride ?? active.youtubeHandle)
    if (!handle) {
      showNotice('info', 'Enter a YouTube @handle before refreshing the channel brief.')
      return
    }
    setChannelBriefBusy(true)
    try {
      const research = await window.studio.youtube.research({ channels: [handle] })
      const entry = research.channels[0]
      if (!entry || entry.error || !entry.snapshot) {
        throw new Error(entry?.error || `Could not load YouTube channel ${handle}.`)
      }
      const channelBrief = composeChannelBriefFromSnapshot(entry.snapshot)
      const saved = await persistChannelProfilePatch({
        youtubeHandle: entry.snapshot.handle || handle,
        channelBrief,
        channelBriefUpdatedAt: new Date().toISOString(),
      })
      if (saved) {
        showNotice('success', `Updated channel brief from ${entry.snapshot.handle || handle}.`)
      }
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not refresh the channel brief.',
      )
    } finally {
      setChannelBriefBusy(false)
    }
  }

  async function persistChannelStillCastSettings(patch: {
    productionMode?: ChannelProductionMode
    stillLibraryPath?: string
    scriptBiblePath?: string
  }): Promise<boolean> {
    return persistChannelProfilePatch(patch)
  }

  async function persistScriptCreator(
    next?: { topic?: string; draft?: string },
    source?: ScriptCreatorDraft['source'],
    expectedTarget?: ProjectState,
  ): Promise<void> {
    const target = expectedTarget || projectStateRef.current
    if (!target) return
    if (
      projectStateRef.current?.manifest.id !== target.manifest.id ||
      projectStateRef.current?.rootPath !== target.rootPath
    ) return
    try {
      await window.studio.project.saveScriptCreator({
        topic: next?.topic ?? scriptTopicRef.current,
        draft: next?.draft ?? scriptDraftRef.current,
        ...(source ? { source } : {}),
        expectedProjectId: target.manifest.id,
        expectedRootPath: target.rootPath,
      })
      refreshCustomImageSetup()
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not save the script draft to the project folder.',
      )
    }
  }

  function scheduleScriptCreatorSave(): void {
    if (scriptCreatorSaveTimerRef.current) window.clearTimeout(scriptCreatorSaveTimerRef.current)
    const target = projectStateRef.current
    const topic = scriptTopicRef.current
    const draft = scriptDraftRef.current
    if (!target) return
    scriptCreatorSaveTimerRef.current = window.setTimeout(() => {
      if (
        projectStateRef.current?.manifest.id !== target.manifest.id ||
        projectStateRef.current?.rootPath !== target.rootPath
      ) return
      void persistScriptCreator({ topic, draft }, undefined, target)
    }, 400)
  }

  function handleScriptTopicChange(value: string): void {
    scriptTopicRef.current = value
    setScriptTopic(value)
    scheduleScriptCreatorSave()
  }

  function handleScriptDraftChange(value: string): void {
    scriptDraftRef.current = value
    setScriptDraft(value)
    scheduleScriptCreatorSave()
  }

  async function chooseScriptBible(): Promise<void> {
    const folder = await window.studio.scriptBible.choose()
    if (!folder) return
    try {
      const loaded = await window.studio.scriptBible.read(folder)
      setScriptBibleText(loaded.text)
      setScriptBiblePathLocal(loaded.path)
      if (activeChannelProfileId) {
        const saved = await persistChannelStillCastSettings({ scriptBiblePath: loaded.path })
        if (!saved) return
      }
      showNotice('success', `Loaded script bible "${fileNameFromPath(loaded.path)}".`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not load that script bible.')
    }
  }

  async function chooseCustomImageGuide(): Promise<void> {
    const chosen = await window.studio.customImages.chooseGuide()
    if (!chosen) return
    const settings = await window.studio.settings.save({
      ...studioSettings,
      customImageGuidePath: chosen,
    })
    setStudioSettings(settings)
    showNotice('success', `Custom image guide set to ${fileNameFromPath(chosen)}.`)
  }

  async function chooseCustomImageCharacterSheet(): Promise<void> {
    const chosen = await window.studio.customImages.chooseCharacterSheet()
    if (!chosen) return
    const settings = await window.studio.settings.save({
      ...studioSettings,
      customImageCharacterSheetPath: chosen,
      customImageReferencePaths: studioSettings.customImageReferencePaths.filter(
        (existing) => existing.toLowerCase() !== chosen.toLowerCase(),
      ),
    })
    setStudioSettings(settings)
    showNotice('success', `Character sheet set to ${fileNameFromPath(chosen)}.`)
  }

  async function clearCustomImageCharacterSheet(): Promise<void> {
    const settings = await window.studio.settings.save({
      ...studioSettings,
      customImageCharacterSheetPath: '',
    })
    setStudioSettings(settings)
  }

  async function addCustomImageReferences(): Promise<void> {
    const chosen = await window.studio.customImages.chooseReferences()
    if (!chosen || chosen.length === 0) return
    const sheet = studioSettings.customImageCharacterSheetPath.toLowerCase()
    const merged = [...studioSettings.customImageReferencePaths]
    for (const filePath of chosen) {
      if (filePath.toLowerCase() === sheet) continue
      if (merged.some((existing) => existing.toLowerCase() === filePath.toLowerCase())) continue
      merged.push(filePath)
    }
    const settings = await window.studio.settings.save({
      ...studioSettings,
      customImageReferencePaths: merged.slice(0, 4),
    })
    setStudioSettings(settings)
    showNotice('success', merged.length === 1 ? 'Reference image added.' : `${Math.min(merged.length, 4)} reference images saved.`)
  }

  async function removeCustomImageReference(filePath: string): Promise<void> {
    const settings = await window.studio.settings.save({
      ...studioSettings,
      customImageReferencePaths: studioSettings.customImageReferencePaths.filter(
        (existing) => existing !== filePath,
      ),
    })
    setStudioSettings(settings)
  }

  async function copyScriptCreatorStills(): Promise<void> {
    try {
      const brief = await window.studio.customImages.scriptCreatorBrief({
        script: scriptDraftRef.current,
        topic: scriptTopicRef.current,
      })
      const copied = await copyTextToClipboard(brief)
      if (!copied) throw new Error('Could not copy the still prompts.')
      showNotice(
        'success',
        'Copied the ChatGPT still prompts. Paste them into Cursor and attach the face references, then the character sheet.',
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not copy the still prompts.')
      throw error
    }
  }

  async function copyMissingCustomStills(): Promise<void> {
    try {
      const brief = await window.studio.customImages.missingBrief()
      const copied = await copyTextToClipboard(brief)
      if (!copied) throw new Error('Could not copy the missing custom stills.')
      showNotice(
        'success',
        'Copied missing and stale custom stills. Paste them into Cursor and attach the character sheet and face references.',
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not copy the missing custom stills.')
    }
  }

  async function generateCustomImages(onlyMissing: boolean): Promise<void> {
    if (!project) return
    const targetProjectId = project.manifest.id
    const targetRootPath = project.rootPath
    const isTargetProjectActive = (): boolean => {
      const current = projectStateRef.current
      return current?.manifest.id === targetProjectId && current.rootPath === targetRootPath
    }
    setCustomImageBusy(true)
    setCustomImageProgress(null)
    try {
      const result = await window.studio.customImages.generate({
        lineIds: onlyMissing || !selectedLine ? undefined : [selectedLine.id],
        onlyMissing,
      })
      if (
        !isTargetProjectActive() ||
        result.state.manifest.id !== targetProjectId ||
        result.state.rootPath !== targetRootPath
      ) return
      await loadProject(result.state)
      if (!isTargetProjectActive()) return
      const scan = await window.studio.stillCast
        .scanCatalog(activeChannelProfile?.stillLibraryPath)
        .catch(() => null)
      if (!isTargetProjectActive()) return
      if (scan) setStillCastLibrary(scan)
      showNotice(
        result.stopped ? 'info' : 'success',
        result.stopped
          ? 'Custom image generation stopped. Finished stills stay in the Custom folder.'
          : onlyMissing
            ? 'Missing and stale custom stills generated.'
            : 'Custom still generated.',
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not generate the custom still.')
    } finally {
      setCustomImageBusy(false)
      refreshCustomImageSetup()
    }
  }

  async function chooseIdeaGuide(): Promise<void> {
    const chosen = await window.studio.ideaGuide.choose()
    if (!chosen) return
    try {
      const loaded = await window.studio.ideaGuide.read(chosen)
      setIdeaGuideText(loaded.text)
      setIdeaGuidePathLocal(loaded.path)
      if (activeChannelProfileId) {
        const saved = await persistChannelProfilePatch({ ideaGuidePath: loaded.path })
        if (!saved) return
      }
      showNotice('success', `Loaded idea guide "${fileNameFromPath(loaded.path)}".`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not load that idea guide.')
    }
  }

  async function generateScriptDraft(): Promise<void> {
    if (scriptDraftBusyRef.current) return
    scriptDraftBusyRef.current = true
    const projectSnapshot = projectStateRef.current
    if (!projectSnapshot) {
      showNotice('info', 'Choose a project folder before generating a script.')
      scriptDraftBusyRef.current = false
      return
    }
    const topicSnapshot = scriptTopicRef.current
    const draftSnapshot = scriptDraftRef.current
    const generationVersion = scriptDraftGenerationVersionRef.current
    if (!topicSnapshot.trim()) {
      showNotice('info', 'Enter a topic for the script.')
      scriptDraftBusyRef.current = false
      return
    }
    const channelIdSnapshot = scriptChannelIdRef.current
    const channelNameSnapshot = scriptChannelNameRef.current
    const biblePath = scriptBiblePathRef.current
    setScriptDraftBusy(true)
    let bible = scriptBibleText
    if (biblePath.trim()) {
      try {
        const loaded = await window.studio.scriptBible.read(biblePath)
        if (!loaded.text.trim()) throw new Error(`The configured script bible "${fileNameFromPath(biblePath)}" is empty.`)
        bible = loaded.text
        if (
          projectStateRef.current?.manifest.id === projectSnapshot.manifest.id &&
          projectStateRef.current?.rootPath === projectSnapshot.rootPath &&
          scriptBiblePathRef.current === biblePath &&
          scriptChannelIdRef.current === channelIdSnapshot
        ) {
          scriptBibleTextRef.current = loaded.text
          setScriptBibleText(loaded.text)
        }
      } catch (error) {
        showNotice(
          'error',
          error instanceof Error
            ? `Could not reload the configured script bible: ${error.message}`
            : 'Could not reload the configured script bible. Load it again before generating.',
        )
        scriptDraftBusyRef.current = false
        setScriptDraftBusy(false)
        return
      }
    }
    if (!bible.trim()) {
      showNotice('info', 'Load a script bible file before generating a script.')
      scriptDraftBusyRef.current = false
      setScriptDraftBusy(false)
      return
    }
    if (
      projectStateRef.current?.manifest.id !== projectSnapshot.manifest.id ||
      projectStateRef.current?.rootPath !== projectSnapshot.rootPath ||
      scriptBiblePathRef.current !== biblePath ||
      scriptChannelIdRef.current !== channelIdSnapshot
    ) {
      showNotice('info', 'The project changed while the script bible was loading. Generate again from the current project.')
      scriptDraftBusyRef.current = false
      setScriptDraftBusy(false)
      return
    }
    if (scriptTopicRef.current !== topicSnapshot) {
      showNotice('info', 'The topic changed while the script bible was loading. Generate again to use the current topic.')
      scriptDraftBusyRef.current = false
      setScriptDraftBusy(false)
      return
    }
    try {
      const result = await window.studio.llm.generate({
        purpose: 'script-draft',
        prompt: composeScriptDraftPrompt(topicSnapshot, bible),
      })
      if (
        projectStateRef.current?.manifest.id !== projectSnapshot.manifest.id ||
        projectStateRef.current?.rootPath !== projectSnapshot.rootPath ||
        scriptTopicRef.current !== topicSnapshot ||
        scriptDraftGenerationVersionRef.current !== generationVersion ||
        scriptChannelIdRef.current !== channelIdSnapshot ||
        scriptChannelNameRef.current !== channelNameSnapshot ||
        scriptDraftRef.current !== draftSnapshot ||
        scriptBiblePathRef.current !== biblePath ||
        scriptBibleTextRef.current !== bible
      ) {
        showNotice('info', 'The project, topic, or script bible changed while the draft was generating. Your current draft was kept; generate again to review a new result.')
        return
      }
      const normalizedDraft = normalizeScriptDraft(result.text)
      if (!normalizedDraft) throw new Error('ChatGPT returned an empty script.')
      const draft = isDoggoBuxChannel(channelNameSnapshot, bible)
        ? ensureDoggoBuxScriptCloser(normalizedDraft)
        : normalizedDraft
      if (scriptCreatorSaveTimerRef.current) {
        window.clearTimeout(scriptCreatorSaveTimerRef.current)
        scriptCreatorSaveTimerRef.current = null
      }
      scriptDraftRef.current = draft
      setScriptDraft(draft)
      const source = {
        topic: topicSnapshot,
        bible,
        biblePath,
        draftFingerprint: scriptDraftFingerprint(draft),
      }
      setScriptDraftSource(source)
      await persistScriptCreator({ topic: topicSnapshot, draft }, source)
      showNotice('success', 'Script draft is ready. Edit it, then create narration lines.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not generate the script.')
    } finally {
      scriptDraftBusyRef.current = false
      setScriptDraftBusy(false)
    }
  }

  async function applyScriptDraft(): Promise<void> {
    if (!scriptDraft.trim()) {
      showNotice('info', 'Generate a script before creating narration lines.')
      return
    }
    const customOnly = isBuxFitCustomOnly(activeChannelProfile?.name, scriptBibleText)
    const review = reviewScriptDraft(scriptDraft, { customOnly })
    if (!review.canApply) {
      showNotice(
        'error',
        review.issues.find((issue) => issue.severity === 'error')?.message ||
          'Add spoken narration before creating lines.',
      )
      return
    }
    const sourceIsStale = Boolean(
      scriptDraftSource &&
        (scriptDraftSource.topic !== scriptTopicRef.current ||
          scriptDraftSource.bible !== scriptBibleText ||
          (scriptDraftSource.biblePath !== undefined &&
            scriptDraftSource.biblePath !== scriptBiblePathRef.current)),
    )
    const hasExistingLines = Boolean(projectStateRef.current?.manifest.lines.length)
    if (sourceIsStale || hasExistingLines) {
      const confirmation =
        sourceIsStale && hasExistingLines
          ? 'This draft was generated from a different topic or script bible. Continue with this draft and replace the current narration?'
          : sourceIsStale
            ? 'This draft was generated from a different topic or script bible. Continue applying this draft?'
            : 'Replace the current narration with this generated script?'
      if (!window.confirm(confirmation)) return
    }
    const closerReadyDraft = isDoggoBuxChannel(
      activeChannelProfile?.name,
      scriptBibleText,
    )
      ? ensureDoggoBuxScriptCloser(scriptDraft)
      : scriptDraft
    if (closerReadyDraft !== scriptDraft) {
      scriptDraftRef.current = closerReadyDraft
      setScriptDraft(closerReadyDraft)
    }
    await persistScriptCreator({ topic: scriptTopicRef.current, draft: closerReadyDraft })
    const imported = await importScriptText(closerReadyDraft, 'main', { autoCast: false })
    if (!imported) return
    await generateTrailerScript({ fromLongformApply: true })
    const state = projectStateRef.current
    if (!state) return
    if (stillCastEnabledRef.current) finishStillCastImport(state, 'main')
    else startAutomaticSceneGeneration(state, 'main')
  }

  function currentVideoIdea(): VideoIdeaSession {
    return (
      normalizeVideoIdeaSession(projectStateRef.current?.manifest.videoIdea) ||
      emptyVideoIdeaSession(videoIdeaSeed)
    )
  }

  function setVideoIdeaSession(session: VideoIdeaSession): void {
    const current = projectStateRef.current
    if (!current) return
    const next = cloneManifest(current.manifest)
    next.videoIdea = session
    const nextState = { ...current, manifest: next }
    projectStateRef.current = nextState
    setProject(nextState)
  }

  async function persistVideoIdea(session = currentVideoIdea()): Promise<void> {
    const current = projectStateRef.current
    if (!current) return
    const latest = (await window.studio.project.get()) || current
    const manifest = cloneManifest(latest.manifest)
    manifest.visualBible = structuredClone(current.manifest.visualBible)
    manifest.videoIdea = session
    const state = await window.studio.project.save(manifest)
    applyProjectState(state)
    refreshCustomImageSetup()
  }

  async function runVideoIdeaTurn(options: {
    userText?: string
    start?: boolean
    seed?: string
  } = {}): Promise<void> {
    if (videoIdeaBusyRef.current) return
    const source = projectStateRef.current
    if (!source) {
      showNotice('info', 'Choose a project folder first.')
      return
    }
    videoIdeaCancelRef.current = false
    videoIdeaBusyRef.current = true
    setVideoIdeaBusy(true)
    setVideoIdeaResearching(false)
    try {
      let session = normalizeVideoIdeaSession(source.manifest.videoIdea) || emptyVideoIdeaSession()
      if (options.start) {
        session = emptyVideoIdeaSession(options.seed ?? videoIdeaSeed)
      } else {
        const recovered = recoverVideoIdeaFromRawAssistantMessage(session)
        if (
          recovered.messages.at(-1)?.text !== session.messages.at(-1)?.text ||
          recovered.locked !== session.locked ||
          recovered.idea.title !== session.idea.title
        ) {
          session = recovered
          setVideoIdeaSession(session)
          await persistVideoIdea(session)
          if (videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)) {
            const topic = composeScriptTopicFromIdea(session.idea)
            if (topic) setScriptTopic(topic)
            showNotice(
              'success',
              session.locked
                ? 'Recovered the locked idea brief from the coach reply. Send it to Script creator when you are ready.'
                : 'Recovered the idea brief from the coach reply. Review it, then send it to Script creator.',
            )
            return
          }
        }
        if (options.seed && !session.seed) {
          session = { ...session, seed: options.seed }
        }
      }
      if (options.userText?.trim()) {
        session = appendVideoIdeaMessage(session, 'user', options.userText)
      } else if (options.start) {
        session = appendVideoIdeaMessage(
          session,
          'user',
          session.seed
            ? `Starting point: ${session.seed}`
            : 'Find the next episode for this channel. Start with the audience and demand test. Research YouTube as needed.',
        )
      }
      if (session.phase === 'idle') session = { ...session, phase: 'audience' }
      setVideoIdeaSession(session)
      await persistVideoIdea(session)

      const activeProfile = channelProfiles.find((profile) => profile.id === activeChannelProfileId)
      let guideText = ideaGuideText
      const guidePath = activeProfile?.ideaGuidePath || ideaGuidePathLocal
      if (guidePath.trim()) {
        try {
          const loaded = await window.studio.ideaGuide.read(guidePath)
          if (loaded.text.trim()) {
            guideText = loaded.text
            setIdeaGuideText(loaded.text)
          }
        } catch {
          // Keep the in-memory guide if the file cannot be re-read.
        }
      }

      let research: Parameters<typeof composeVideoIdeaPrompt>[0]['research']
      let researchRoundsUsed = 0
      for (let round = 0; round < VIDEO_IDEA_MAX_ROUNDS; round += 1) {
        if (videoIdeaCancelRef.current) throw new Error('Video idea coaching was cancelled.')
        const forcePackaging = videoIdeaDemandComplete(session)
        const requestId = globalThis.crypto.randomUUID()
        videoIdeaRequestIdRef.current = requestId
        const result = await window.studio.llm.generate({
          purpose: 'video-idea',
          requestId,
          prompt: composeVideoIdeaPrompt({
            channelName: activeProfile?.name || source.manifest.visualBible.name,
            niche: activeProfile?.niche,
            youtubeHandle: activeProfile?.youtubeHandle,
            channelBrief: activeProfile?.channelBrief,
            ideaGuide: guideText,
            visualBible: source.manifest.visualBible,
            stillCastEnabled: stillCastEnabledRef.current,
            session,
            research,
            forcePackaging,
            researchBudgetExhausted: researchRoundsUsed >= VIDEO_IDEA_MAX_RESEARCH_ROUNDS,
          }),
        })
        if (videoIdeaCancelRef.current) throw new Error('Video idea coaching was cancelled.')
        const turn = parseVideoIdeaResponse(result.text)
        session = applyVideoIdeaCoachTurn(session, turn)
        setVideoIdeaSession(session)
        await persistVideoIdea(session)

        const wantsResearch = turn.researchQueries.length > 0 || turn.researchChannels.length > 0
        if (
          wantsResearch &&
          shouldAllowVideoIdeaResearch(session, researchRoundsUsed) &&
          shouldContinueVideoIdeaCoach(session, turn, researchRoundsUsed)
        ) {
          setVideoIdeaResearching(true)
          try {
            research = await window.studio.youtube.research({
              queries: turn.researchQueries,
              channels: turn.researchChannels,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'YouTube research failed.'
            research = {
              queries: turn.researchQueries.map((query) => ({ query, videos: [], error: message })),
              channels: turn.researchChannels.map((channel) => ({ channel, error: message })),
            }
          }
          session = recordIdeaResearch(session, research)
          const researchText = formatVideoIdeaResearch(research) || 'No YouTube results.'
          session = appendVideoIdeaMessage(session, 'research', researchText)
          setVideoIdeaSession(session)
          await persistVideoIdea(session)
          setVideoIdeaResearching(false)
          researchRoundsUsed += 1
          continue
        }

        research = undefined
        if (!shouldContinueVideoIdeaCoach(session, turn, researchRoundsUsed)) break
      }
      if (videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)) {
        const topic = composeScriptTopicFromIdea(session.idea)
        if (topic) setScriptTopic(topic)
        showNotice(
          'success',
          session.locked
            ? 'Video idea is locked. Send it to Script creator when you are ready.'
            : 'Idea brief is drafted. Review demand, packaging, promised experience, and CTA, then send it to Script creator.',
        )
      } else {
        const remaining = unpaidVideoIdeaGates(session)
        const budgetMessage = researchRoundsUsed >= VIDEO_IDEA_MAX_RESEARCH_ROUNDS
          ? ' The lookup limit for this run was reached; Continue can start another research run.'
          : ''
        showNotice(
          'info',
          `Idea review is still incomplete. Still needed: ${remaining.join('; ') || 'coach review'}.${budgetMessage}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not continue the video idea.'
      const friendly = formatLlmFailureMessage(message)
      showNotice(/cancelled/i.test(message) ? 'info' : 'error', friendly)
      // If the coach never answered, the last bubble is still "user" and Continue
      // used to stay disabled. Leave a short retry note so the UI unsticks.
      try {
        const current = currentVideoIdea()
        const last = current.messages.at(-1)
        if (current.messages.length > 0 && last?.role === 'user' && !/cancelled/i.test(message)) {
          const next = appendVideoIdeaMessage(
            current,
            'assistant',
            /usage limit/i.test(message)
              ? `${friendly} Click Continue to retry when the limit resets.`
              : `Coach turn failed: ${friendly} Click Continue to retry.`,
          )
          setVideoIdeaSession(next)
          await persistVideoIdea(next)
        }
      } catch {
        // UI recovery should not mask the original LLM failure.
      }
    } finally {
      videoIdeaBusyRef.current = false
      videoIdeaRequestIdRef.current = null
      setVideoIdeaBusy(false)
      setVideoIdeaResearching(false)
    }
  }

  async function cancelVideoIdea(): Promise<void> {
    if (!videoIdeaBusyRef.current) return
    videoIdeaCancelRef.current = true
    await window.studio.llm.cancel(videoIdeaRequestIdRef.current || undefined).catch(() => undefined)
    // If Codex is wedged after a rate-limit (process hung), don't leave Stop forever.
    window.setTimeout(() => {
      if (!videoIdeaBusyRef.current) return
      videoIdeaBusyRef.current = false
      videoIdeaRequestIdRef.current = null
      setVideoIdeaBusy(false)
      setVideoIdeaResearching(false)
      showNotice('info', 'Stopped waiting on ChatGPT. You can Continue when ready.')
    }, 2500)
  }

  async function resetVideoIdea(): Promise<void> {
    if (videoIdeaBusyRef.current) return
    if (!window.confirm('Start a new video idea? The current research chat will be cleared.')) return
    const session = emptyVideoIdeaSession()
    setVideoIdeaSeed('')
    setVideoIdeaDraft('')
    setVideoIdeaSession(session)
    await persistVideoIdea(session)
  }

  function patchVideoIdeaField(key: keyof VideoIdeaBrief, value: string): void {
    const current = currentVideoIdea()
    const nextIdea = { ...current.idea, [key]: value }
    // Keep the producer's draft intact. Clearing approval forces the coach to
    // reassess the edited brief without deleting its research or packaging.
    if (key !== 'decision') nextIdea.decision = ''
    const session = touchVideoIdeaSession({
      ...current,
      locked: false,
      checklist: emptyVideoIdeaChecklist(),
      idea: nextIdea,
    })
    if (!session.locked && session.phase === 'locked') session.phase = 'packaging'
    setVideoIdeaSession(session)
  }

  function sendIdeaToScriptCreator(): void {
    const session = currentVideoIdea()
    if (!videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)) {
      showNotice('info', 'Complete candidate comparison, evidence review, and the production decision before sending to Script creator.')
      return
    }
    const topic = composeScriptTopicFromIdea(session.idea)
    if (!topic.trim()) {
      showNotice('info', 'Fill the idea brief before sending this to Script creator.')
      return
    }
    setScriptTopic(topic)
    scriptTopicRef.current = topic
    void persistScriptCreator({ topic, draft: scriptDraftRef.current })
    setActiveSequence('main')
    setActiveSection('create')
    void persistVideoIdea(session)
    showNotice(
      'success',
      session.locked
        ? 'Script creator has the locked video idea as its topic.'
        : 'Script creator has the current idea brief. Lock it after demand, packaging, promised experience, and CTA if you can.',
    )
  }

  async function generateStillCastBeats(
    startIndex = 0,
    onlyMissing = false,
    lineId?: string,
    targetSequence: SequenceId = activeSequence,
  ): Promise<void> {
    const source = projectStateRef.current || project
    if (!source) {
      showNotice('info', 'Import a script before casting expressions.')
      return
    }
    if (!stillCastEnabledRef.current) {
      showNotice('info', 'Switch this channel to Expression stills in Settings first.')
      return
    }
    const sequence = targetSequence
    const lines = sequenceManifestFromProject(source.manifest, sequence).lines
      .slice()
      .sort((left, right) => left.index - right.index)
    const targets = lines.filter((line) => {
      if (lineId) return line.id === lineId
      if (line.index < startIndex) return false
      if (onlyMissing) {
        if (sequence === 'trailer') return !lineStillCastImagesReady(line)
        if (lineHasStillCastBeats(line)) return false
      }
      return true
    })
    if (targets.length === 0) {
      showNotice(
        'info',
        sequence === 'trailer'
          ? 'Every selected short line already has a Custom-9x16 beat.'
          : 'Every selected line already has expression beats.',
      )
      return
    }

    const libraryPath = activeChannelProfile?.stillLibraryPath

    // 9:16 shorts use Custom-9x16 only — assign matches, never cast expression faces.
    if (sequence === 'trailer') {
      setStillCastBusy(true)
      try {
        const scan = await window.studio.stillCast.scanCatalog(libraryPath)
        setStillCastLibrary(scan)
        const state = await window.studio.stillCast.assignImages({
          sequence,
          libraryPath,
          lineIds: targets.map((line) => line.id),
          reroll: true,
        })
        await loadProject(state)
        const matched = sequenceManifestFromProject(state.manifest, 'trailer').lines.filter(
          (line) =>
            targets.some((target) => target.id === line.id) && lineStillCastImagesReady(line),
        ).length
        const missing = targets.length - matched
        if (missing > 0) {
          showNotice(
            'info',
            `${matched} Custom-9x16 still${matched === 1 ? '' : 's'} matched. ${missing} line${missing === 1 ? '' : 's'} still need a file in Custom-9x16 named after the spoken words.`,
          )
        } else {
          showNotice(
            'success',
            matched === 1
              ? 'Custom-9x16 still assigned.'
              : `${matched} Custom-9x16 stills assigned.`,
          )
        }
      } catch (error) {
        showNotice(
          'error',
          error instanceof Error ? error.message : 'Could not assign Custom-9x16 stills.',
        )
      } finally {
        setStillCastBusy(false)
      }
      return
    }

    setStillCastBusy(true)
    setContextPromptsBusy(true)
    cancelContextPromptsRef.current = false
    const startedAt = Date.now()
    try {
      const scan = await window.studio.stillCast.scanCatalog(libraryPath)
      setStillCastLibrary(scan)
      const folders = stockedStillCastFolders(scan)
      const customStills = scan.customStills || []
      const { custom: customTargets, remaining: llmTargets } = partitionStillCastTargets(
        targets,
        customStills,
      )
      const fingerprint = sceneContextFingerprint(source.manifest, sequence)
      let working = source
      let completed = 0

      if (customTargets.length > 0) {
        setContextPromptProgress({
          current: customTargets[0]!.index + 1,
          total: targets.length,
          completed: 0,
          lineText: `Applying ${customTargets.length} Custom still${customTargets.length === 1 ? '' : 's'}`,
          startedAt,
        })
        working = await window.studio.stillCast.assignImages({
          sequence,
          libraryPath,
          lineIds: customTargets.map((line) => line.id),
          reroll: true,
        })
        await loadProject(working)
        completed = customTargets.length
        setContextPromptProgress({
          current: (llmTargets[0]?.index || customTargets[0]!.index) + 1,
          total: targets.length,
          completed,
          lineText: llmTargets[0]?.text || customTargets[0]!.text,
          startedAt,
        })
      }

      if (llmTargets.length === 0) {
        showNotice(
          'success',
          customTargets.length === 1
            ? 'Custom still applied. That line skipped expression casting.'
            : `${customTargets.length} Custom stills applied. Those lines skipped expression casting.`,
        )
        return
      }

      if (folders.length === 0) {
        showNotice('info', 'Drop stills into expression folders in the library, then cast the remaining lines.')
        return
      }

      const jobs: Array<{ paragraphIndex: number; paragraphLines: ScriptLine[]; targetLines: ScriptLine[] }> = []
      const groups = new Map<number, ScriptLine[]>()
      for (const line of llmTargets) {
        const paragraphIndex = line.paragraphIndex || 0
        const group = groups.get(paragraphIndex) || []
        group.push(line)
        groups.set(paragraphIndex, group)
      }
      for (const [paragraphIndex, targetLines] of [...groups.entries()].sort(([left], [right]) => left - right)) {
        jobs.push({
          paragraphIndex,
          targetLines,
          paragraphLines: lines.filter((line) => (line.paragraphIndex || 0) === paragraphIndex),
        })
      }

      for (const wave of sceneGenerationWaves(jobs, MAX_PARALLEL_SCENE_AGENTS)) {
        if (cancelContextPromptsRef.current) break
        setContextPromptProgress({
          current: wave[0]!.targetLines[0]!.index + 1,
          total: targets.length,
          completed,
          lineText: wave[0]!.targetLines[0]!.text,
          startedAt,
        })
        const settled = await Promise.allSettled(
          wave.map(async (job) => {
            const result = await window.studio.llm.generate({
              purpose: 'still-cast',
              requestId: globalThis.crypto.randomUUID(),
              prompt: buildStillCastPrompt({
                paragraphLines: job.paragraphLines,
                targetLines: job.targetLines,
                folders,
              }),
            })
            return {
              job,
              parsed: parseStillCastResponse(result.text, job.targetLines, folders),
            }
          }),
        )
        const manifest = cloneManifest(working.manifest)
        const failures: string[] = []
        mutateSequenceManifest(manifest, sequence, (view) => {
          for (const result of settled) {
            if (result.status === 'rejected') {
              failures.push(result.reason instanceof Error ? result.reason.message : 'Could not cast a stanza.')
              continue
            }
            for (const row of result.value.parsed) {
              const line = view.lines.find((candidate) => candidate.id === row.lineId)
              if (!line) continue
              const beats = row.beats.map((beat) => ({
                id: globalThis.crypto.randomUUID(),
                text: beat.text,
                expression: beat.expression,
              }))
              line.stillBeats = beats
              line.sceneDescription = stillCastDirectionSummary(beats)
              line.sceneRecord = {
                version: 1,
                lineId: line.id,
                sourceFingerprint: fingerprint,
                direction: stillCastDirectionSummary(beats),
              }
              line.directionStatus = 'complete'
              line.directionError = undefined
              line.imagePath = undefined
              line.sceneStatus = 'draft'
              line.error = undefined
              completed += 1
            }
          }
        })
        working = await window.studio.project.save(manifest)
        await loadProject(working)
        setContextPromptProgress({
          current: Math.min(completed + 1, targets.length),
          total: targets.length,
          completed,
          lineText: llmTargets[Math.min(completed - customTargets.length, llmTargets.length - 1)]?.text || '',
          startedAt,
        })
        if (failures.length > 0 && !cancelContextPromptsRef.current) {
          showNotice('error', failures[0]!)
        }
      }

      const expressionLineIds = llmTargets
        .map((line) => findLineInProject(working, line.id, sequence))
        .filter((line): line is ScriptLine => Boolean(line && lineHasStillCastBeats(line)))
        .map((line) => line.id)
      if (expressionLineIds.length > 0 && !cancelContextPromptsRef.current) {
        working = await window.studio.stillCast.assignImages({
          sequence,
          libraryPath,
          lineIds: expressionLineIds,
          reroll: true,
        })
        await loadProject(working)
      }

      const customCount = customTargets.length
      const expressionCount = expressionLineIds.length
      if (cancelContextPromptsRef.current) {
        showNotice('info', 'Expression casting stopped. Custom stills already applied stay in place.')
      } else if (customCount > 0) {
        showNotice(
          'success',
          `${customCount} Custom still${customCount === 1 ? '' : 's'} applied, then ${expressionCount} expression${expressionCount === 1 ? '' : 's'} cast in batches of ${MAX_PARALLEL_SCENE_AGENTS}.`,
        )
      } else {
        showNotice('success', `Expression stills assigned in batches of ${MAX_PARALLEL_SCENE_AGENTS}.`)
      }
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not cast expression beats.',
      )
    } finally {
      setStillCastBusy(false)
      setContextPromptsBusy(false)
      setContextPromptProgress(null)
    }
  }

  async function assignStillCastImages(options: { lineIds?: string[]; reroll?: boolean } = {}): Promise<void> {
    const libraryPath = activeChannelProfile?.stillLibraryPath
    if (!project) return
    setStillCastBusy(true)
    try {
      if (options.reroll && !options.lineIds?.length) {
        await clearRegeneratedImageReview(activeSequence)
      }
      const state = await window.studio.stillCast.assignImages({
        sequence: activeSequence,
        libraryPath,
        lineIds: options.lineIds,
        reroll: options.reroll,
      })
      await loadProject(state)
      setStillCastLibrary(await window.studio.stillCast.scanCatalog(libraryPath).catch(() => stillCastLibrary))
      const missing = sequenceManifestFromProject(state.manifest, activeSequence).lines.filter(
        (line) => lineHasStillCastBeats(line) && !lineStillCastImagesReady(line),
      )
      if (missing.length > 0) {
        showNotice(
          'info',
          activeSequence === 'trailer'
            ? `${missing.length} line${missing.length === 1 ? '' : 's'} still need a Custom-9x16 image named after the spoken line.`
            : `${missing.length} line${missing.length === 1 ? '' : 's'} still need stills in the matching expression folders, or a Custom image named after the line.`,
        )
      } else {
        const customCount = sequenceManifestFromProject(state.manifest, activeSequence).lines.filter(
          (line) => (line.stillBeats || []).some((beat) => beat.expression === 'custom'),
        ).length
        showNotice(
          'success',
          activeSequence === 'trailer'
            ? `Custom-9x16 stills assigned${customCount > 0 ? ` (${customCount} lines)` : ''}.`
            : customCount > 0
              ? `Stills assigned. ${customCount} line${customCount === 1 ? '' : 's'} used a matching Custom image.`
              : 'Stills assigned from the expression folders.',
        )
      }
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not assign stills from the library.',
      )
    } finally {
      setStillCastBusy(false)
    }
  }

  async function changeStillCastExpression(
    lineId: string,
    expression: string,
    beatId?: string,
  ): Promise<void> {
    const libraryPath = activeChannelProfile?.stillLibraryPath
    if (!expression || stillCastBusy) return
    setStillCastBusy(true)
    try {
      const state = await window.studio.stillCast.setExpression({
        sequence: activeSequence,
        libraryPath,
        lineId,
        beatId,
        expression,
      })
      await loadProject(state)
      setStillCastLibrary(await window.studio.stillCast.scanCatalog(libraryPath).catch(() => stillCastLibrary))
      showNotice('success', 'Expression updated.')
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not change that expression.',
      )
    } finally {
      setStillCastBusy(false)
    }
  }

  function recordingFocusPayload(
    line: ScriptLine,
    state: RecordingFocusPayload['state'],
    countdown: number | null,
    leadInSeconds: number,
    sequence: SequenceId = activeSequence,
  ): RecordingFocusPayload {
    const lines = project
      ? sequenceManifestFromProject(project.manifest, sequence).lines
      : [line]
    const stanza = stillCastEnabledRef.current ? stanzaLinesFor(line, lines) : [line]
    const folders = stillCastLibrary?.folders || []
    const expressions = stillCastEnabledRef.current
      ? stanza.map((entry) => {
          const expression = entry.stillBeats?.[0]?.expression
          return expression ? stillCastExpressionLabel(expression, folders) : ''
        })
      : undefined
    const uniqueExpressions = [...new Set((expressions || []).filter(Boolean))]
    const speakerCues = stillCastEnabledRef.current ? scriptSpeakerCuesForLines(stanza) : undefined
    const uniqueSpeakers = [...new Set((speakerCues || []).map((cue) => cue.label))]
    return {
      text: stanza.map((entry) => entry.text).join('\n'),
      lines: stillCastEnabledRef.current ? stanza.map((entry) => entry.text) : undefined,
      expression: uniqueExpressions.length === 1 ? uniqueExpressions[0] : undefined,
      expressions,
      speaker: uniqueSpeakers.length === 1 ? uniqueSpeakers[0] : undefined,
      speakers: speakerCues?.map((cue) => cue.label),
      speakerHint: uniqueSpeakers.length === 1 ? speakerCues?.[0]?.hint : undefined,
      lineNumber: stanza[0]?.index + 1 || line.index + 1,
      stanzaNumber: stillCastEnabledRef.current ? (line.paragraphIndex || 0) + 1 : undefined,
      duration: stanzaDuration(stanza),
      state,
      countdown,
      leadInSeconds,
    }
  }

  function showTeleprompter(payload: RecordingFocusPayload): void {
    void window.studio.teleprompter.show(payload).catch(() => undefined)
  }

  function updateTeleprompter(payload: RecordingFocusPayload): void {
    void window.studio.teleprompter.update(payload).catch(() => undefined)
  }

  function hideTeleprompter(): void {
    void window.studio.teleprompter.hide().catch(() => undefined)
  }

  function currentImageInspectorPayload(): ImageInspectorPayload | null {
    return buildImageInspectorPayload(imageInspectorLinesRef.current, activeLineIdRef.current)
  }

  async function openImageInspector(): Promise<void> {
    const payload = currentImageInspectorPayload()
    if (!payload) {
      setNotice({ type: 'info', message: 'No scene images are ready to inspect yet.' })
      return
    }
    await window.studio.imageInspector.show(payload)
    setImageInspectorOpen(true)
  }

  function syncImageInspector(): void {
    if (!imageInspectorOpenRef.current) return
    const payload = currentImageInspectorPayload()
    if (!payload) {
      void window.studio.imageInspector.hide().catch(() => undefined)
      setImageInspectorOpen(false)
      return
    }
    const activeId = activeLineIdRef.current
    if (activeId && !payload.items.some((item) => item.lineId === activeId)) return
    void window.studio.imageInspector.update(payload).catch(() => undefined)
  }

  function navigateImageInspector(delta: number): void {
    const payload = currentImageInspectorPayload()
    if (!payload || payload.items.length === 0) return
    const nextIndex = Math.min(
      payload.items.length - 1,
      Math.max(0, payload.index + delta),
    )
    const nextItem = payload.items[nextIndex]
    if (!nextItem || nextItem.lineId === activeLineIdRef.current) {
      if (nextItem) {
        void window.studio.imageInspector
          .update({ ...payload, index: nextIndex })
          .catch(() => undefined)
      }
      return
    }
    setActiveLineId(nextItem.lineId)
  }

  function currentVoiceInspectorPayload(): VoiceInspectorPayload | null {
    return buildVoiceInspectorPayload(
      voiceInspectorLinesRef.current,
      activeLineIdRef.current,
      voiceInspectorSequenceRef.current,
    )
  }

  async function openVoiceInspector(): Promise<void> {
    const payload = currentVoiceInspectorPayload()
    if (!payload) {
      setNotice({ type: 'info', message: 'No voice takes are ready to inspect yet.' })
      return
    }
    await window.studio.voiceInspector.show(payload)
    setVoiceInspectorOpen(true)
  }

  function syncVoiceInspector(): void {
    if (!voiceInspectorOpenRef.current) return
    const payload = currentVoiceInspectorPayload()
    if (!payload) {
      void window.studio.voiceInspector.hide().catch(() => undefined)
      setVoiceInspectorOpen(false)
      return
    }
    const activeId = activeLineIdRef.current
    if (activeId && !payload.items.some((item) => item.lineId === activeId)) return
    void window.studio.voiceInspector.update(payload).catch(() => undefined)
  }

  function navigateVoiceInspector(delta: number): void {
    const payload = currentVoiceInspectorPayload()
    if (!payload || payload.items.length === 0) return
    const nextIndex = Math.min(
      payload.items.length - 1,
      Math.max(0, payload.index + delta),
    )
    const nextItem = payload.items[nextIndex]
    if (!nextItem || nextItem.lineId === activeLineIdRef.current) {
      if (nextItem) {
        void window.studio.voiceInspector
          .update({ ...payload, index: nextIndex })
          .catch(() => undefined)
      }
      return
    }
    setActiveLineId(nextItem.lineId)
  }

  useEffect(() => {
    imageInspectorLinesRef.current = sequenceProject?.manifest.lines || []
    syncImageInspector()
  }, [imageInspectorOpen, activeLineId, activeSequence, sequenceProject])

  useEffect(() => {
    return window.studio.imageInspector.onNavigate((delta) => {
      navigateImageInspector(delta)
    })
  }, [])

  useEffect(() => {
    return window.studio.imageInspector.onClosed(() => {
      setImageInspectorOpen(false)
    })
  }, [])

  useEffect(() => {
    voiceInspectorLinesRef.current = sequenceProject?.manifest.lines || []
    voiceInspectorSequenceRef.current = activeSequence
    syncVoiceInspector()
  }, [voiceInspectorOpen, activeLineId, activeSequence, sequenceProject])

  useEffect(() => {
    return window.studio.voiceInspector.onNavigate((delta) => {
      navigateVoiceInspector(delta)
    })
  }, [])

  useEffect(() => {
    return window.studio.voiceInspector.onClosed(() => {
      setVoiceInspectorOpen(false)
    })
  }, [])

  useEffect(() => {
    return window.studio.voiceInspector.onProjectUpdated((state) => {
      void loadProject(state)
    })
  }, [])

  function pauseExportPreRenders(): void {
    void window.studio.export.setPreRenderPaused(true).catch(() => undefined)
  }

  function resumeExportPreRenders(): void {
    void window.studio.export.setPreRenderPaused(false).catch(() => undefined)
  }

  function endMicSession(): void {
    hideTeleprompter()
    resumeExportPreRenders()
  }

  function stopSilenceDetection(): void {
    if (micSilencePollRef.current !== null) {
      window.clearInterval(micSilencePollRef.current)
      micSilencePollRef.current = null
    }
    const processor = micProcessorRef.current
    if (processor) {
      processor.onaudioprocess = null
      processor.disconnect()
      micProcessorRef.current = null
    }
    micSourceRef.current?.disconnect()
    micSourceRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    micKeepAliveRef.current?.disconnect()
    micKeepAliveRef.current = null
    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext && audioContext.state !== 'closed') {
      audioContextCloseRef.current = audioContext.close().then(() => undefined).catch(() => undefined)
    }
  }

  async function warmMicMonitor(stream: MediaStream): Promise<AudioContext | null> {
    stopSilenceDetection()
    await audioContextCloseRef.current
    try {
      const audioContext = new AudioContext()
      if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => undefined)
      }
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = MIC_PROCESSOR_BUFFER
      analyser.smoothingTimeConstant = 0
      const keepAlive = audioContext.createGain()
      // Tiny non-zero output keeps Chromium from treating the graph as silent
      // and suspending the AudioContext while the teleprompter is up.
      keepAlive.gain.value = 0.00003
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.value = 20
      source.connect(analyser)
      analyser.connect(keepAlive)
      oscillator.connect(keepAlive)
      keepAlive.connect(audioContext.destination)
      oscillator.start()
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      micSourceRef.current = source
      micKeepAliveRef.current = keepAlive
      return audioContext
    } catch {
      stopSilenceDetection()
      return null
    }
  }

  async function startSilenceDetection(stream: MediaStream, recorder: MediaRecorder): Promise<void> {
    const existing = audioContextRef.current
    const audioContext =
      existing && existing.state !== 'closed' ? existing : await warmMicMonitor(stream)
    const analyser = analyserRef.current
    const keepAlive = micKeepAliveRef.current
    if (!audioContext || !analyser || !keepAlive) return
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => undefined)
    }

    const tracker = createSilenceAdvanceTracker({
      sampleRate: audioContext.sampleRate,
      silenceDurationMs: MIC_SILENCE_ADVANCE_MS,
    })
    let advanced = false
    const maybeAdvance = () => {
      if (advanced || recorder.state !== 'recording') return
      advanced = true
      window.setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state === 'recording') {
          stopRecording(!recordOnceRef.current)
        }
      }, 0)
    }
    const listen = (rms: number) => {
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch(() => undefined)
        return
      }
      if (recorder.state !== 'recording') return
      if (tracker.pushRms(rms) === 'advance') maybeAdvance()
    }

    let lastAudioCallbackAt = performance.now()
    try {
      const processor = audioContext.createScriptProcessor(MIC_PROCESSOR_BUFFER, 1, 1)
      processor.onaudioprocess = (event) => {
        lastAudioCallbackAt = performance.now()
        listen(rmsFromTimeDomain(event.inputBuffer.getChannelData(0)))
      }
      analyser.disconnect()
      analyser.connect(processor)
      processor.connect(keepAlive)
      micProcessorRef.current = processor
    } catch {
      micProcessorRef.current = null
    }

    const samples = new Float32Array(analyser.fftSize)
    micSilencePollRef.current = window.setInterval(() => {
      if (recorder.state !== 'recording') return
      if (lastAudioCallbackAt && performance.now() - lastAudioCallbackAt < 180) return
      analyser.getFloatTimeDomainData(samples)
      listen(rmsFromTimeDomain(samples))
    }, 50)
  }

  async function startRecording(
    lineId: string,
    leadInSeconds = 3,
    force = false,
    sequence: SequenceId = activeSequence,
    recordOnce = false,
  ): Promise<void> {
    if (!force && (recordingLineId || countdownLineId)) return
    const line = project
      ? sequenceManifestFromProject(project.manifest, sequence).lines.find(
          (candidate) => candidate.id === lineId,
        )
      : undefined
    if (!line) return
    cancelRecordingRef.current = false
    advanceRecordingRef.current = false
    recordOnceRef.current = recordOnce
    setRecordOnceActive(recordOnce)
    pauseExportPreRenders()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      })
      const preferredMime = 'audio/webm;codecs=opus'
      const recorder = MediaRecorder.isTypeSupported(preferredMime)
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream)
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = async () => {
        const discarded = cancelRecordingRef.current
        const restartLineId = restartRecordingRef.current
        const shouldRestart = Boolean(restartLineId)
        const goingBack = Boolean(restartLineId && restartLineId !== lineId)
        const stayOnLine = recordOnceRef.current
        const shouldAdvance = advanceRecordingRef.current && !stayOnLine
        let nextLineId: string | null = null
        try {
          if (discarded) {
            if (!shouldRestart) {
              showNotice(
                'info',
                stillCastEnabledRef.current
                  ? 'Take discarded. The same stanza is ready to record again.'
                  : 'Take discarded. The same line is ready to record again.',
              )
            }
            return
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const stanzaMode = stillCastEnabledRef.current
          const recordingPayload = {
            lineId,
            sequence,
            data: await blob.arrayBuffer(),
            duration: (performance.now() - recordingStartedRef.current) / 1000,
            mimeType: blob.type,
          }
          const state = stanzaMode
            ? await window.studio.project.saveStanzaRecording(recordingPayload)
            : await window.studio.project.saveRecording(recordingPayload)
          await loadProject(state)
          const currentSequence = sequenceManifestFromProject(state.manifest, sequence)
          const recordedLine = currentSequence.lines.find((candidate) => candidate.id === lineId)
          if (recordedLine && !stanzaMode) void draftAndQueueRecordedLine(recordedLine.id, sequence)
          const nextLine = stanzaMode
            ? recordedLine
              ? nextStanzaFirstLine(recordedLine, currentSequence.lines)
              : undefined
            : currentSequence.lines.find((candidate) => candidate.index === (recordedLine?.index || 0) + 1)
          nextLineId = nextLine?.id || null
          setActiveLineId(shouldAdvance && nextLine ? nextLine.id : lineId)
          const unit = stanzaMode ? 'stanza' : 'line'
          showNotice(
            'success',
            nextLine && shouldAdvance
              ? `Saved. Starting the next ${unit}.`
              : stayOnLine
                ? stanzaMode
                  ? 'Stanza recorded. Staying on this stanza.'
                  : 'Line recorded. Staying on this line.'
                : nextLine
                  ? `Saved. The next ${unit} is ready.`
                  : stanzaMode
                    ? 'Stanza recorded.'
                    : 'Voice line recorded.',
          )
        } catch (error) {
          showNotice('error', error instanceof Error ? error.message : 'Could not save this recording.')
        } finally {
          stopSilenceDetection()
          stream.getTracks().forEach((track) => track.stop())
          streamRef.current = null
          recorderRef.current = null
          setRecordingLineId(null)
          setCountdownLineId(null)
          setCountdownValue(null)
          setCountdownLeadInSeconds(null)
          cancelRecordingRef.current = false
          restartRecordingRef.current = null
          advanceRecordingRef.current = false
          recordOnceRef.current = false
          setRecordOnceActive(false)
          if (shouldRestart && restartLineId) {
            showNotice(
              'info',
              goingBack
                ? stillCastEnabledRef.current
                  ? 'Going back one stanza. Get ready for the 1-second lead-in.'
                  : 'Going back one line. Get ready for the 1-second lead-in.'
                : stillCastEnabledRef.current
                  ? 'Redoing this stanza. Get ready for the 1-second lead-in.'
                  : 'Redoing this line. Get ready for the 1-second lead-in.',
            )
            setActiveLineId(restartLineId)
            window.setTimeout(
              () => void startRecording(restartLineId, 1, true, sequence, stayOnLine),
              0,
            )
          } else if (shouldAdvance && nextLineId) {
            window.setTimeout(() => void startRecording(nextLineId as string, 0, true, sequence), 0)
          } else {
            endMicSession()
          }
        }
      }
      streamRef.current = stream
      recorderRef.current = recorder
      await warmMicMonitor(stream)
      if (leadInSeconds > 0) {
        setCountdownLineId(lineId)
        setCountdownLeadInSeconds(leadInSeconds)
        showTeleprompter(recordingFocusPayload(line, 'countdown', leadInSeconds, leadInSeconds, sequence))
        for (let count = leadInSeconds; count > 0; count -= 1) {
          setCountdownValue(count)
          updateTeleprompter(recordingFocusPayload(line, 'countdown', count, leadInSeconds, sequence))
          await new Promise((resolve) => window.setTimeout(resolve, 1000))
          if (cancelRecordingRef.current) {
            const restartLineId = restartRecordingRef.current
            stopSilenceDetection()
            stream.getTracks().forEach((track) => track.stop())
            streamRef.current = null
            recorderRef.current = null
            setCountdownLineId(null)
            setCountdownValue(null)
            setCountdownLeadInSeconds(null)
            cancelRecordingRef.current = false
            restartRecordingRef.current = null
            if (restartLineId) {
              setActiveLineId(restartLineId)
              window.setTimeout(() => void startRecording(restartLineId, 1, true, sequence), 0)
            } else {
              endMicSession()
            }
            return
          }
        }
      }
      setCountdownLineId(null)
      setCountdownValue(null)
      setCountdownLeadInSeconds(null)
      recordingStartedRef.current = performance.now()
      setRecordingLineId(lineId)
      updateTeleprompter(recordingFocusPayload(line, 'recording', null, leadInSeconds, sequence))
      recorder.start()
      await startSilenceDetection(stream, recorder)
    } catch (error) {
      stopSilenceDetection()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      setCountdownLineId(null)
      setCountdownValue(null)
      setCountdownLeadInSeconds(null)
      cancelRecordingRef.current = false
      restartRecordingRef.current = null
      recordOnceRef.current = false
      setRecordOnceActive(false)
      endMicSession()
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Microphone permission was not granted.',
      )
    }
  }

  function stopRecording(advance = false): void {
    if (recorderRef.current?.state === 'recording') {
      advanceRecordingRef.current = advance
      stopSilenceDetection()
      hideTeleprompter()
      recorderRef.current.stop()
    }
  }

  function previousRecordingTarget(lineId: string, sequence: SequenceId): ScriptLine | undefined {
    const state = projectStateRef.current
    if (!state) return undefined
    const lines = sequenceManifestFromProject(state.manifest, sequence).lines
    const current = lines.find((candidate) => candidate.id === lineId)
    if (!current) return undefined
    return previousRecordingLine(current, lines, stillCastEnabledRef.current)
  }

  function cancelRecording(restartLineId?: string): void {
    if (!recordingLineId && !countdownLineId) return
    const lineId = recordingLineId || countdownLineId
    if (!lineId) return
    const targetLineId = restartLineId || lineId
    const goingBack = targetLineId !== lineId
    const targetLine = project ? findLineInProject(project, targetLineId, activeSequence) : undefined
    restartRecordingRef.current = targetLineId
    cancelRecordingRef.current = true
    if (goingBack) setActiveLineId(targetLineId)
    if (targetLine) updateTeleprompter(recordingFocusPayload(targetLine, 'countdown', 1, 1))
    if (recorderRef.current?.state === 'recording') {
      stopSilenceDetection()
      recorderRef.current.stop()
      return
    }

    setCountdownLineId(null)
    setCountdownValue(null)
    setCountdownLeadInSeconds(null)
    showNotice(
      'info',
      goingBack
        ? stillCastEnabledRef.current
          ? 'Going back one stanza. Get ready for the 1-second lead-in.'
          : 'Going back one line. Get ready for the 1-second lead-in.'
        : stillCastEnabledRef.current
          ? 'Redoing this stanza. Get ready for the 1-second lead-in.'
          : 'Redoing this line. Get ready for the 1-second lead-in.',
    )
  }

  async function generateScene(line: ScriptLine): Promise<ProjectState | null> {
    if (!project) return null
    setGeneratingLineId(line.id)
    try {
      const currentState = await window.studio.higgs.generateScene({
        lineId: line.id,
        sequence: activeSequence,
        prompt: line.scenePrompt,
        promptFingerprint: scenePromptFingerprint(line.scenePrompt),
        modelEndpoint: modelEndpointForProvider(studioSettings.imageGenerator, higgsStatus),
        aspectRatio: activeSequence === 'trailer' ? '9:16' : '16:9',
        resolution: '1k',
      })
      await loadProject(currentState)
      showNotice('success', `Scene ${line.index + 1} is ready.`)
      return currentState
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Scene generation failed.')
      return null
    } finally {
      setGeneratingLineId(null)
    }
  }

  async function generateAllScenes(): Promise<void> {
    if (!project) return
    const pendingLines = sequenceManifestFromProject(project.manifest, activeSequence).lines.filter(
      (line) => line.sceneStatus !== 'complete',
    )
    if (pendingLines.length === 0) {
      showNotice('info', 'Every scene already has a visual.')
      return
    }
    if (
      !window.confirm(
        `This will submit ${pendingLines.length} ${imageProviderLabel(studioSettings.imageGenerator)} generations. Continue only if the prompts and provider settings are approved.`,
      )
    ) {
      return
    }

    imageGenerationCancelledRef.current = false
    await window.studio.higgs.resume()
    for (const line of pendingLines) {
      const result = await generateScene(line)
      if (!result) break
    }
  }

  async function exportLongform(): Promise<void> {
    setExporting(true)
    try {
      const result = await window.studio.export.longform(activeSequence)
      if (result) showNotice('success', `Exported ${formatTime(result.duration)} to ${result.outputPath}.`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not export the video.')
    } finally {
      setExporting(false)
    }
  }

  async function loginHiggs(): Promise<void> {
    setHiggsAuthBusy(true)
    try {
      const status = await window.studio.settings.loginHiggs()
      setHiggsStatus(status)
      showNotice(
        status.configured ? 'success' : 'info',
        status.configured
          ? 'Higgsfield CLI OAuth connected. Your account credits are ready.'
          : status.message,
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not sign in to Higgsfield.')
    } finally {
      setHiggsAuthBusy(false)
    }
  }

  async function refreshHiggsStatus(): Promise<void> {
    setHiggsAuthBusy(true)
    try {
      setHiggsStatus(await window.studio.settings.getHiggs())
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not refresh Higgsfield status.')
    } finally {
      setHiggsAuthBusy(false)
    }
  }

  async function refreshComfyStatus(): Promise<void> {
    setComfyBusy(true)
    try {
      setComfyStatus(await window.studio.settings.getComfyStatus())
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not refresh ComfyUI status.')
    } finally {
      setComfyBusy(false)
    }
  }

  async function saveComfySettings(comfy: ComfyUiSettings): Promise<void> {
    setComfyBusy(true)
    try {
      const settings = await window.studio.settings.save({ ...studioSettings, comfy })
      setStudioSettings(settings)
      setComfyStatus(await window.studio.settings.getComfyStatus())
      showNotice('success', 'ComfyUI settings saved.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save ComfyUI settings.')
    } finally {
      setComfyBusy(false)
    }
  }

  async function saveImageGenerator(imageGenerator: ImageGenerator): Promise<void> {
    try {
      const settings = await window.studio.settings.save({ ...studioSettings, imageGenerator })
      setStudioSettings(settings)
      showNotice(
        'success',
        `${imageProviderLabel(imageGenerator)} is now the selected image generator.`,
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save image generator settings.')
    }
  }

  async function saveVoiceMode(voiceMode: VoiceMode): Promise<void> {
    try {
      const settings = await window.studio.settings.save({ ...studioSettings, voiceMode })
      setStudioSettings(settings)
      showNotice(
        'success',
        voiceMode === 'qwen'
          ? stillCastEnabled
            ? 'QWEN line voice is now selected.'
            : 'QWEN paragraph voice is now selected.'
          : 'Microphone voice is now selected.',
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save voice mode.')
    }
  }

  async function saveLlmStep(step: LlmStep, patch: Partial<LlmStepSetting>): Promise<void> {
    try {
      const current = studioSettings.llmSteps[step]
      const llmSteps = {
        ...studioSettings.llmSteps,
        [step]: { ...current, ...patch },
      }
      const settings = await window.studio.settings.save({ ...studioSettings, llmSteps })
      setStudioSettings(settings)
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not save the model setting.',
      )
    }
  }

  async function chooseQwenReference(): Promise<void> {
    setQwenReferenceBusy(true)
    try {
      const status = await window.studio.qwen.chooseReference()
      setQwenStatus(status)
      showNotice(
        'success',
        `QWEN voice reference saved${status.referenceName ? `: ${status.referenceName}` : '.'}`,
      )
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save the QWEN voice reference.')
    } finally {
      setQwenReferenceBusy(false)
    }
  }

  async function saveQwenReferenceText(text: string): Promise<void> {
    setQwenReferenceBusy(true)
    try {
      const status = await window.studio.qwen.saveReferenceText(text)
      setQwenStatus(status)
      showNotice('success', 'QWEN reference transcript saved.')
    } catch (error) {
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not save the QWEN reference transcript.',
      )
    } finally {
      setQwenReferenceBusy(false)
    }
  }

  async function generateQwen(input: QwenTtsGenerateInput): Promise<boolean> {
    if (!project || qwenBusy) return false
    setQwenBusy(true)
    setQwenProgress(null)
    try {
      const state = await window.studio.qwen.generate({
        ...input,
        sequence: input.sequence || activeSequence,
        ...(input.mode !== 'all' && input.mode !== 'resume'
          ? { lineId: input.lineId || selectedLine?.id }
          : {}),
      })
      await loadProject(state)
      setQwenStatus(await window.studio.qwen.getStatus())
      showNotice(
        'success',
        stillCastEnabledRef.current
          ? 'QWEN line voice is ready on the timeline.'
          : 'QWEN paragraph voice is ready on the timeline.',
      )
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QWEN voice generation failed.'
      showNotice(/cancelled/i.test(message) ? 'info' : 'error', message)
      return false
    } finally {
      setQwenBusy(false)
      setQwenProgress(null)
    }
  }

  async function realignQwen(): Promise<void> {
    if (!project || qwenBusy) return
    setQwenBusy(true)
    setQwenProgress(null)
    try {
      const state = await window.studio.qwen.realign({ sequence: activeSequence })
      await loadProject(state)
      setQwenStatus(await window.studio.qwen.getStatus())
      showNotice('success', 'Saved QWEN paragraph audio was re-aligned and its timeline clips were replaced.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QWEN voice re-alignment failed.'
      showNotice(/cancelled/i.test(message) ? 'info' : 'error', message)
    } finally {
      setQwenBusy(false)
      setQwenProgress(null)
    }
  }

  async function cancelQwen(): Promise<void> {
    if (!qwenBusy) return
    await window.studio.qwen.cancel().catch(() => undefined)
  }

  const projectName = project?.manifest.name || 'Untitled production'
  const sectionLabel =
    activeSection === 'overview'
      ? 'Production board'
      : activeSection === 'idea'
        ? 'Video idea'
        : activeSection === 'create'
          ? 'Script creator'
          : activeSection === 'tools'
            ? 'Tools'
            : navItems.find((item) => item.id === activeSection)?.label || 'Workflow'
  const sequenceLabel = activeSequence === 'trailer' ? '9:16 Condensed' : '16:9 Longform'
  const activeLabel =
    activeSection === 'overview' ||
    activeSection === 'idea' ||
    activeSection === 'create' ||
    activeSection === 'tools'
      ? sectionLabel
      : `${sequenceLabel} · ${sectionLabel}`
  const currentActivity = (() => {
    const lineFor = (lineId: string | null) =>
      sequenceProject?.manifest.lines.find((line) => line.id === lineId)
    const lineText = (lineId: string | null) => {
      const line = lineFor(lineId)
      return line ? `Line ${line.index + 1}: ${line.text}` : 'Current clip'
    }
    const activeImageLine = sequenceProject?.manifest.lines.find(
      (line) => line.sceneStatus === 'generating' || line.sceneStatus === 'queued',
    )
    const activeImageProvider =
      activeImageLine?.imageGenerator ||
      (activeImageLine?.higgsStatus ? 'higgsfield' : studioSettings.imageGenerator)

    if (!project) {
      return {
        active: false,
        label: 'Choose a project folder',
        detail: 'No production task is running.',
      }
    }
    if (exporting) {
      return {
        active: true,
        label: 'Exporting video',
        detail: `Rendering the ${activeSequence === 'trailer' ? '9:16 condensed' : 'longform'} timeline and mastering audio.`,
      }
    }
    if (countdownLineId) {
      return {
        active: true,
        label: 'Preparing voice recording',
        detail: lineText(countdownLineId),
      }
    }
    if (recordingLineId) {
      return {
        active: true,
        label: 'Recording voice line',
        detail: lineText(recordingLineId),
      }
    }
    if (qwenBusy) {
      return {
        active: true,
        label: stillCastEnabled
          ? 'Generating QWEN line voice'
          : 'Generating QWEN paragraph voice',
        detail: qwenProgress
          ? stillCastEnabled
            ? `Line ${qwenProgress.paragraphIndex + 1} of ${qwenProgress.paragraphCount} · ${qwenProgress.stage}`
            : `Paragraph ${qwenProgress.paragraphIndex + 1} of ${qwenProgress.paragraphCount} · ${qwenProgress.stage}`
          : 'Preparing the QWEN voice workflow.',
      }
    }
    if (contextPromptsBusy) {
      return {
        active: true,
        label:
          contextPromptProgress?.phase === 'summary'
            ? 'Preparing scene-generation context'
            : 'Generating scene directions',
        detail: contextPromptProgress
          ? contextPromptProgress.phase === 'summary'
            ? contextPromptProgress.lineText
            : `ChatGPT paragraph pass · line ${contextPromptProgress.current} of ${contextPromptProgress.total}: ${contextPromptProgress.lineText}`
          : 'ChatGPT is drafting contextual paragraph prompts.',
      }
    }

    const generatingImages =
      sequenceProject?.manifest.lines.filter((line) => line.sceneStatus === 'generating').length || 0
    const queuedImages =
      sequenceProject?.manifest.lines.filter((line) => line.sceneStatus === 'queued').length || 0
    if (imageBatchBusy || generatingImages > 0 || queuedImages > 0) {
      const imageProviderLabel = imageProviderLabelForActivity(activeImageProvider)
      return {
        active: true,
        label:
          imageBatchBusy && generatingImages === 0
            ? `Queuing ${imageProviderLabel} images`
            : `Generating ${imageProviderLabel} images`,
        detail: `${generatingImages} rendering · ${queuedImages} queued`,
      }
    }
    if (videoIdeaBusy) {
      return {
        active: true,
        label: videoIdeaResearching ? 'Researching YouTube demand' : 'Developing the video idea',
        detail: videoIdeaResearching
          ? 'Searching YouTube for subjects, outliers, and packaging clues.'
          : 'ChatGPT is walking through demand, packaging, the promised experience, and the CTA.',
      }
    }
    if (scriptDraftBusy) {
      return {
        active: true,
        label: 'Writing the script',
        detail: 'ChatGPT is drafting narration from the topic and script bible.',
      }
    }
    if (llmBusy) {
      return {
        active: true,
        label: 'Generating with ChatGPT',
        detail: 'The creative assistant is processing the current request.',
      }
    }
    if (higgsAuthBusy) {
      return {
        active: true,
        label: 'Connecting Higgsfield',
        detail: 'Waiting for the CLI OAuth connection to finish.',
      }
    }
    if (saving) {
      return {
        active: true,
        label: 'Saving project',
        detail: 'Writing the latest production changes locally.',
      }
    }

    return {
      active: false,
      label: 'Ready',
      detail: selectedLine ? `Selected clip ${selectedLine.index + 1} · ${activeLabel}` : `No clip selected · ${activeLabel}`,
    }
  })()
  const imageProviderConnected =
    studioSettings.imageGenerator === 'chatgpt'
      ? Boolean(llmStatus?.authenticated)
      : studioSettings.imageGenerator === 'comfyui'
        ? Boolean(comfyStatus?.reachable)
        : Boolean(higgsStatus?.configured)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles size={18} strokeWidth={2.5} />
          </div>
          <div>
            <div className="brand-name">Higgsfilm</div>
            <div className="brand-caption">production studio</div>
          </div>
        </div>

        <div className="workspace-pickers">
          <div className="project-picker channel-switcher" ref={channelMenuRef}>
            <div className="eyebrow">Current channel</div>
            <button
              className={`project-button ${channelMenuOpen ? 'open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={channelMenuOpen}
              onClick={() => {
                if (channelProfiles.length === 0) {
                  setSettingsOpen(true)
                  return
                }
                setChannelMenuOpen((open) => !open)
              }}
            >
              <span className="project-icon channel-icon">
                <Tv size={16} />
              </span>
              <span className="project-button-copy">
                <strong>
                  {channelProfiles.find((profile) => profile.id === activeChannelProfileId)?.name ||
                    'No channel folder'}
                </strong>
                <small>
                  {channelProfiles.find((profile) => profile.id === activeChannelProfileId)
                    ? stillCastEnabled
                      ? 'Still-cast channel folder'
                      : 'Channel folder'
                    : 'Choose a channel folder in Settings'}
                </small>
              </span>
              <ChevronRight size={15} className={`muted-icon channel-switcher-caret ${channelMenuOpen ? 'open' : ''}`} />
            </button>
            {channelMenuOpen ? (
              <div className="channel-switcher-menu" role="listbox" aria-label="YouTube channels">
                {channelProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    role="option"
                    aria-selected={profile.id === activeChannelProfileId}
                    className={`channel-switcher-option ${profile.id === activeChannelProfileId ? 'selected' : ''}`}
                    disabled={channelProfileBusy}
                    onClick={() => void applyChannelProfile(profile.id)}
                  >
                    <span>{profile.name}</span>
                    {profile.id === activeChannelProfileId ? <Check size={14} /> : null}
                  </button>
                ))}
                <button
                  type="button"
                  className="channel-switcher-option manage"
                  onClick={() => {
                    setChannelMenuOpen(false)
                    setSettingsOpen(true)
                  }}
                >
                  Channel settings…
                </button>
              </div>
            ) : null}
          </div>

          <div className="project-picker">
            <div className="eyebrow">Current project</div>
            <button className="project-button" onClick={() => void chooseProject()}>
              <span className="project-icon">
                <FolderOpen size={16} />
              </span>
              <span className="project-button-copy">
                <strong>{projectName}</strong>
                <small>{project ? 'Local project folder' : 'Choose a folder to begin'}</small>
              </span>
              <ChevronRight size={15} className="muted-icon" />
            </button>
          </div>
        </div>

        <nav className="main-nav" aria-label="Production workflow">
          <div className="eyebrow nav-eyebrow">Workflow</div>
          <button
            className={`nav-item ${activeSection === 'overview' ? 'active' : ''}`}
            onClick={() => {
              setActiveSequence('main')
              setActiveSection('overview')
            }}
          >
            <Layers3 size={17} />
            <span>Production board</span>
          </button>
          <button
            className={`nav-item ${activeSection === 'idea' ? 'active' : ''}`}
            onClick={() => {
              setActiveSequence('main')
              setActiveSection('idea')
            }}
          >
            <Lightbulb size={17} />
            <span>Video idea</span>
          </button>
          <button
            className={`nav-item ${activeSection === 'create' ? 'active' : ''}`}
            onClick={() => {
              setActiveSequence('main')
              setActiveSection('create')
            }}
          >
            <PenLine size={17} />
            <span>Script creator</span>
          </button>
          {navItems.map((item) => {
            const Icon = item.icon
            const mainLines = project?.manifest.lines || []
            const trailerLines = project?.manifest.trailer?.lines || []
            const mainVisualCount = mainLines.filter((line) => line.sceneStatus === 'complete').length
            const trailerVisualCount = trailerLines.filter((line) => line.sceneStatus === 'complete').length
            return (
              <div className="nav-group" key={item.id}>
                <div className="nav-group-heading">
                  <Icon size={14} />
                  <span>{item.label}</span>
                </div>
                <div className="nav-group-tabs" role="tablist" aria-label={`${item.label} format`}>
                  <button
                    className={`nav-tab ${
                      activeSection === item.id && activeSequence === 'main' ? 'active' : ''
                    }`}
                    role="tab"
                    aria-selected={activeSection === item.id && activeSequence === 'main'}
                    onClick={() => {
                      setActiveSequence('main')
                      setActiveSection(item.id)
                    }}
                  >
                    <span>16:9</span>
                    {item.id === 'script' && project ? (
                      <span className="nav-count">{mainLines.length}</span>
                    ) : null}
                    {item.id === 'visuals' && project ? (
                      <span className="nav-count">
                        {mainVisualCount}/{mainLines.length}
                      </span>
                    ) : null}
                  </button>
                  <button
                    className={`nav-tab ${
                      activeSection === item.id && activeSequence === 'trailer' ? 'active' : ''
                    }`}
                    role="tab"
                    aria-selected={activeSection === item.id && activeSequence === 'trailer'}
                    onClick={() => {
                      setActiveSequence('trailer')
                      setActiveSection(item.id)
                    }}
                  >
                    <span>9:16</span>
                    {item.id === 'script' && project ? (
                      <span className="nav-count">{trailerLines.length}</span>
                    ) : null}
                    {item.id === 'visuals' && project ? (
                      <span className="nav-count">
                        {trailerVisualCount}/{trailerLines.length}
                      </span>
                    ) : null}
                  </button>
                </div>
              </div>
            )
          })}
          <div className="eyebrow nav-eyebrow">Tools</div>
          <button
            className={`nav-item ${activeSection === 'tools' ? 'active' : ''}`}
            onClick={() => setActiveSection('tools')}
          >
            <Wrench size={17} />
            <span>Tools</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className={`connection-pill ${imageProviderConnected ? 'connected' : ''}`}>
            <span className="status-dot" />
            <span>
              {studioSettings.imageGenerator === 'chatgpt'
                ? imageProviderConnected
                  ? 'ChatGPT connected'
                  : 'ChatGPT not connected'
                : imageProviderConnected
                  ? 'Higgsfield connected'
                  : 'Higgsfield not connected'}
            </span>
          </div>
          <button
            className="footer-button"
            onClick={() => {
              setChannelMenuOpen(false)
              setSettingsOpen(true)
            }}
          >
            <Settings2 size={16} />
            <span>Settings</span>
          </button>
          <div className="footer-meta">
            <span>LOCAL-FIRST</span>
            <span>v0.1 prototype</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>HIGGSFILM</span>
            <ChevronRight size={14} />
            <strong>{activeLabel}</strong>
          </div>
          <div className={`activity-status ${currentActivity.active ? 'is-active' : ''}`} role="status" aria-live="polite">
            <span className="status-dot" />
            <div className="activity-copy">
              <span className="activity-kicker">{currentActivity.active ? 'Running now' : 'Current task'}</span>
              <strong>{currentActivity.label}</strong>
              <span>{currentActivity.detail}</span>
            </div>
          </div>
          <div className="topbar-actions">
            {project ? (
              <span className="save-state">
                <span className="status-dot success-dot" />
                Saved in project folder
              </span>
            ) : null}
            <button className="button button-quiet" disabled={!project || saving} onClick={() => void saveProject()}>
              {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
              Save project
            </button>
            <button className="icon-button" aria-label="Help">
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        {project ? (
          <PinnedTimeline
            project={sequenceProject || project}
            activeLineId={activeLineId}
            assetSources={assetSources}
            locked={Boolean(recordingLineId || countdownLineId)}
            imageFilter={timelineImageFilter}
            regeneratedCount={regeneratedImageCount}
            onImageFilterChange={setTimelineImageFilter}
            onSelectLine={setActiveLineId}
            onCopyImage={(line) => void copySceneImage(line)}
            onAcceptRegeneratedImage={(line) => void acceptRegeneratedImage(line.id)}
          />
        ) : null}

        {notice ? (
          <div className={`notice notice-${notice.type}`}>
            {notice.type === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}
            <span>{notice.message}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
              <X size={15} />
            </button>
          </div>
        ) : null}

        {activeSection === 'tools' ? (
          <div className="workspace">
            <ExpressionToolsPanel
              libraryPath={activeChannelProfile?.stillLibraryPath || ''}
              authenticated={Boolean(llmStatus?.authenticated)}
              onLogin={() => void startLlmLogin()}
              onNotice={showNotice}
              onSettingsSaved={setStudioSettings}
              onLibraryChanged={() => {
                const libraryPath = activeChannelProfile?.stillLibraryPath
                if (!libraryPath) return
                const scan = project
                  ? window.studio.stillCast.scanCatalog(libraryPath)
                  : window.studio.stillCast.scanLibrary(libraryPath)
                void scan.then((result) => setStillCastLibrary(result)).catch(() => undefined)
              }}
            />
          </div>
        ) : !project ? (
          <EmptyProject onChoose={() => void chooseProject()} />
        ) : (
          <div className="workspace">
            {activeSection === 'overview' ? (
              <Overview
                project={sequenceProject || project}
                recordedCount={recordedCount}
                visualCount={visualCount}
                totalDuration={totalDuration}
                higgsConfigured={Boolean(higgsStatus?.configured)}
                llmStatus={llmStatus}
                llmPrompt={llmPrompt}
                llmOutput={llmOutput}
                llmBusy={llmBusy}
                ideaLocked={Boolean(project.manifest.videoIdea?.locked)}
                onNavigate={(section) => {
                  setActiveSequence('main')
                  setActiveSection(section)
                }}
                onConnect={() => setSettingsOpen(true)}
                onLlmPromptChange={setLlmPrompt}
                onLlmLogin={() => void startLlmLogin()}
                onLlmGenerate={() => void generateWithChatGpt()}
                onExport={() => void exportLongform()}
                exporting={exporting}
              />
            ) : null}
            {activeSection === 'idea' ? (
              <VideoIdeaWorkspace
                session={currentVideoIdea()}
                seed={videoIdeaSeed}
                draft={videoIdeaDraft}
                busy={videoIdeaBusy}
                researching={videoIdeaResearching}
                llmStatus={llmStatus}
                channelName={activeChannelProfile?.name || project.manifest.visualBible.name}
                niche={activeChannelProfile?.niche || ''}
                youtubeHandle={activeChannelProfile?.youtubeHandle || ''}
                channelBrief={activeChannelProfile?.channelBrief || ''}
                channelBriefUpdatedAt={activeChannelProfile?.channelBriefUpdatedAt || ''}
                ideaGuidePath={activeChannelProfile?.ideaGuidePath || ideaGuidePathLocal}
                channelProfileBusy={channelProfileBusy}
                channelBriefBusy={channelBriefBusy}
                hasChannelProfile={Boolean(activeChannelProfile)}
                onSeedChange={setVideoIdeaSeed}
                onDraftChange={setVideoIdeaDraft}
                onLlmLogin={() => void startLlmLogin()}
                onNicheChange={(value) => void persistChannelProfilePatch({ niche: value })}
                onYoutubeHandleChange={(value) =>
                  void persistChannelProfilePatch({ youtubeHandle: value })
                }
                onRefreshChannelBrief={(handle) => void refreshChannelBrief(handle)}
                onChooseIdeaGuide={() => void chooseIdeaGuide()}
                onStart={() => {
                  setVideoIdeaDraft('')
                  void runVideoIdeaTurn({ start: true, seed: videoIdeaSeed })
                }}
                onSend={() => {
                  const text = videoIdeaDraft
                  setVideoIdeaDraft('')
                  void runVideoIdeaTurn({ userText: text })
                }}
                onCancel={() => void cancelVideoIdea()}
                onReset={() => void resetVideoIdea()}
                onFieldChange={(key, value) => patchVideoIdeaField(key, value)}
                onPersistIdea={() => void persistVideoIdea()}
                onUseForScript={sendIdeaToScriptCreator}
              />
            ) : null}
            {activeSection === 'create' ? (
              <ScriptCreator
                scriptBiblePath={activeChannelProfile?.scriptBiblePath || scriptBiblePathLocal}
                scriptBibleText={scriptBibleText}
                scriptTopic={scriptTopic}
                scriptDraft={scriptDraft}
                customOnly={isBuxFitCustomOnly(activeChannelProfile?.name, scriptBibleText)}
                sourceKnown={Boolean(scriptDraftSource)}
                draftEdited={Boolean(
                  scriptDraftSource?.draftFingerprint &&
                    scriptDraftSource.draftFingerprint !== scriptDraftFingerprint(scriptDraft),
                )}
                staleSource={Boolean(
                  scriptDraftSource &&
                    (scriptDraftSource.topic !== scriptTopic ||
                      scriptDraftSource.bible !== scriptBibleText ||
                      (scriptDraftSource.biblePath !== undefined &&
                        scriptDraftSource.biblePath !== scriptBiblePathRef.current)),
                )}
                scriptDraftBusy={scriptDraftBusy}
                channelProfileBusy={channelProfileBusy}
                llmStatus={llmStatus}
                stillCastEnabled={stillCastEnabled}
                hasExistingLines={(project.manifest.lines.length || 0) > 0}
                ideaTitle={project.manifest.videoIdea?.idea.title || ''}
                ideaLocked={Boolean(project.manifest.videoIdea?.locked)}
                onOpenIdea={() => {
                  setActiveSequence('main')
                  setActiveSection('idea')
                }}
                onTopicChange={handleScriptTopicChange}
                onDraftChange={handleScriptDraftChange}
                onChooseBible={() => void chooseScriptBible()}
                onLlmLogin={() => void startLlmLogin()}
                onGenerate={() => void generateScriptDraft()}
                onApply={() => void applyScriptDraft()}
                onCopyCustomStills={() => copyScriptCreatorStills()}
              />
            ) : null}
            {activeSection === 'script' ? (
              <ScriptWorkspace
                project={sequenceProject || project}
                sequence={activeSequence}
                activeLineId={activeLineId}
                recordingLineId={recordingLineId}
                countdownLineId={countdownLineId}
                countdownValue={countdownValue}
                countdownLeadInSeconds={countdownLeadInSeconds}
                recordOnceActive={recordOnceActive}
                audioSources={assetSources}
                voiceMode={studioSettings.voiceMode}
                qwenStatus={qwenStatus}
                qwenBusy={qwenBusy}
                qwenProgress={qwenProgress}
                onSelectLine={setActiveLineId}
                onImportScript={() => void importScript(activeSequence)}
                onImportScriptText={(script) => void importScriptText(script)}
                stillCastEnabled={stillCastEnabled}
                onStartRecording={(lineId, options) =>
                  void startRecording(lineId, 3, false, activeSequence, Boolean(options?.recordOnce))
                }
                onStopRecording={stopRecording}
                onCancelRecording={cancelRecording}
                onVoiceModeChange={(mode) => void saveVoiceMode(mode)}
                onGenerateQwen={(mode) =>
                  void generateQwen({
                    mode,
                    lineId: selectedLine?.id,
                    sequence: activeSequence,
                  })
                }
                onCancelQwen={() => void cancelQwen()}
                onTrimVoiceTake={async (lineId, trimWindow) => {
                  const state = await window.studio.project.trimVoiceTake({
                    lineId,
                    sequence: activeSequence,
                    trimStartSeconds: trimWindow.trimStartSeconds,
                    trimEndSeconds: trimWindow.trimEndSeconds,
                  })
                  await loadProject(state)
                }}
                onResetVoiceCleanup={async (lineId) => {
                  const state = await window.studio.project.resetVoiceTakeCleanup({
                    lineId,
                    sequence: activeSequence,
                  })
                  await loadProject(state)
                }}
                onOpenVoiceInspector={() => void openVoiceInspector()}
                voiceInspectorOpen={voiceInspectorOpen}
                onUpdateLine={(lineId, text) =>
                  updateManifest((manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === lineId)
                    if (line) {
                      line.text = text
                      if (line.voiceAlignmentSource) {
                        line.voicePath = undefined
                        line.voiceRawPath = undefined
                        line.voiceTrimStart = undefined
                        line.voiceTrimEnd = undefined
                        line.voiceCleanupVersion = undefined
                        line.voiceAssetVersion = undefined
                        line.voiceSourcePath = undefined
                        line.voiceCueStartMs = undefined
                        line.voiceCueEndMs = undefined
                        line.voiceAlignmentSource = undefined
                        line.voiceAlignmentConfidence = undefined
                        line.voiceTranscript = undefined
                        line.voiceAlignmentError =
                          'The script text changed; regenerate QWEN audio to refresh its alignment.'
                        line.voiceAlignmentReportPath = undefined
                        line.status = 'draft'
                      }
                      manifest.qwenParagraphMasters = manifest.qwenParagraphMasters?.filter(
                        (master) => !master.lineIds.includes(lineId),
                      )
                      line.sceneRecord = undefined
                      line.sceneDescription = undefined
                      line.scenePrompt = composeScenePrompt(text)
                      line.directionStatus = 'draft'
                      line.sceneStatus = 'draft'
                      line.imagePath = undefined
                      line.stillBeats = undefined
                    }
                    manifest.scriptSummary = undefined
                    manifest.scriptSummaryFingerprint = undefined
                    manifest.continuityCanon = undefined
                  })
                }
                trailerScriptBusy={trailerScriptBusy}
                onGenerateTrailerScript={() => void generateTrailerScript()}
                onSave={() => void saveProject()}
              />
            ) : null}
            {activeSection === 'visuals' ? (
              <VisualWorkspace
                project={sequenceProject || project}
                sequence={activeSequence}
                selectedLine={selectedLine}
                activeLineId={activeLineId}
                assetSources={assetSources}
                higgsStatus={higgsStatus}
                comfyStatus={comfyStatus}
                llmStatus={llmStatus}
                imageGenerator={studioSettings.imageGenerator}
                contextPromptsBusy={contextPromptsBusy}
                contextPromptProgress={contextPromptProgress}
                imageBatchBusy={imageBatchBusy}
                imageCancelBusy={imageCancelBusy}
                automaticImageGenerationEnabled={automaticImageGenerationEnabled}
                productionBibles={productionBibles}
                productionBibleBusy={productionBibleBusy}
                stillCastEnabled={stillCastEnabled}
                stillCastLibrary={stillCastLibrary}
                stillCastBusy={stillCastBusy}
                customImageSetup={customImageSetup}
                customImageBusy={customImageBusy}
                customImageProgress={customImageProgress}
                onChooseCustomImageGuide={() => void chooseCustomImageGuide()}
                onChooseCustomImageCharacterSheet={() => void chooseCustomImageCharacterSheet()}
                onClearCustomImageCharacterSheet={() => void clearCustomImageCharacterSheet()}
                onAddCustomImageReferences={() => void addCustomImageReferences()}
                onRemoveCustomImageReference={(filePath) => void removeCustomImageReference(filePath)}
                onGenerateCustomImages={(onlyMissing) => void generateCustomImages(onlyMissing)}
                onCopyMissingCustomStills={() => void copyMissingCustomStills()}
                onCancelCustomImages={() => void window.studio.customImages.cancel()}
                onOpenImageInspector={() => void openImageInspector()}
                imageInspectorOpen={imageInspectorOpen}
                imageFilter={timelineImageFilter}
                onSelectLine={(id) => {
                  pendingTimelineScrollRef.current = id
                  setActiveLineId(id)
                }}
                onChangeStillCastExpression={(beatId, expression) =>
                  selectedLine && void changeStillCastExpression(selectedLine.id, expression, beatId)
                }
                onSaveProductionBible={(name) => void saveProductionBible(name)}
                onLoadProductionBible={(name) => void loadProductionBible(name)}
                onUpdateBible={updateVisualBibleField}
                onUpdateShotNote={(lineId, shotNote) => {
                  const current = projectStateRef.current
                  if (!current) return
                  const next = cloneManifest(current.manifest)
                  mutateSequenceManifest(next, activeSequence, (manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === lineId)
                    if (!line) return
                    const trimmed = shotNote.trim()
                    line.shotNote = trimmed || undefined
                  })
                  const nextState = { ...current, manifest: next }
                  projectStateRef.current = nextState
                  setProject(nextState)
                  void window.studio.project
                    .save(next)
                    .then(() => refreshCustomImageSetup())
                    .catch((error) => {
                      showNotice(
                        'error',
                        error instanceof Error ? error.message : 'Could not save the shot note.',
                      )
                    })
                }}
                onUpdatePrompt={(value) =>
                  selectedLine &&
                  updateManifest((manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === selectedLine.id)
                    if (!line) return
                    line.scenePrompt = value
                    line.sceneDescription = undefined
                    line.sceneRecord = undefined
                    line.directionStatus =
                      value.trim() && value.trim() !== composeScenePrompt(line.text).trim() ? 'complete' : 'draft'
                    line.directionError = undefined
                    line.sceneStatus = 'draft'
                    line.imagePath = undefined
                  })
                }
                onPromptRefinementChange={(value) =>
                  selectedLine &&
                  updateManifest((manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === selectedLine.id)
                    if (line) line.promptRefinement = value
                  })
                }
                onSave={() => void saveProject()}
                onGenerateSelectedPrompt={() =>
                  stillCastEnabled
                    ? void generateStillCastBeats(selectedLine?.index || 0, false, selectedLine?.id)
                    : void generateSelectedPrompt()
                }
                onRegeneratePromptWithRefinement={() => void regeneratePromptWithRefinement()}
                onGenerateAllPrompts={() =>
                  stillCastEnabled ? void generateStillCastBeats(0, false) : void regenerateAllPrompts()
                }
                onGeneratePromptsFromHere={() =>
                  stillCastEnabled
                    ? selectedLine && void generateStillCastBeats(selectedLine.index, false)
                    : selectedLine &&
                      void generateContextualPrompts(
                        project,
                        selectedLine.index,
                        false,
                        undefined,
                        activeSequence,
                      )
                }
                onGenerateRemainingPrompts={() =>
                  stillCastEnabled
                    ? void generateStillCastBeats(0, true)
                    : void generateContextualPrompts(project, 0, true, undefined, activeSequence)
                }
                onGenerateSelectedImage={() =>
                  stillCastEnabled
                    ? void generateSelectedStillCastImages()
                    : void generateSelectedImage()
                }
                onAcceptRegeneratedImage={
                  selectedLine ? () => void acceptRegeneratedImage(selectedLine.id) : undefined
                }
                onGenerateAllImages={() =>
                  stillCastEnabled ? void assignStillCastImages({ reroll: true }) : void queueImageBatch('all')
                }
                onGenerateImagesFromHere={() =>
                  stillCastEnabled
                    ? selectedLine &&
                      void assignStillCastImages({
                        lineIds: (sequenceProject || project)?.manifest.lines
                          .filter((line) => line.index >= selectedLine.index)
                          .map((line) => line.id),
                        reroll: true,
                      })
                    : void queueImageBatch('from-here')
                }
                onGenerateRemainingImages={() =>
                  stillCastEnabled
                    ? void assignStillCastImages({ reroll: false })
                    : void queueImageBatch('remaining')
                }
                onCancelImages={() => void cancelImageGenerations()}
                onToggleAutomaticImageGeneration={toggleAutomaticImageGeneration}
                onCancelContextPrompts={() => void cancelContextualPrompts()}
                onLlmLogin={() => void startLlmLogin()}
                onConnect={() => setSettingsOpen(true)}
              />
            ) : null}
            {activeSection === 'timeline' ? (
              <TimelineWorkspace
                project={sequenceProject || project}
                activeLineId={activeLineId}
                assetSources={assetSources}
                imageFilter={timelineImageFilter}
                regeneratedCount={regeneratedImageCount}
                onImageFilterChange={setTimelineImageFilter}
                onSelectLine={setActiveLineId}
                onCopyImage={(line) => void copySceneImage(line)}
                onAcceptRegeneratedImage={(line) => void acceptRegeneratedImage(line.id)}
              />
            ) : null}
            {activeSection === 'export' ? (
              <ExportWorkspace
                project={sequenceProject || project}
                sequence={activeSequence}
                recordedCount={recordedCount}
                visualCount={visualCount}
                totalDuration={totalDuration}
                exporting={exporting}
                onExport={() => void exportLongform()}
              />
            ) : null}
          </div>
        )}
      </main>

      {settingsOpen ? (
        <SettingsModal
          status={higgsStatus}
          comfyStatus={comfyStatus}
          settings={studioSettings}
          projectAvailable={Boolean(project)}
          projectVisualBible={project?.manifest.visualBible}
          channelProfiles={channelProfiles}
          activeChannelProfileId={activeChannelProfileId}
          channelProfileBusy={channelProfileBusy}
          qwenStatus={qwenStatus}
          qwenReferenceBusy={qwenReferenceBusy}
          qwenBusy={qwenBusy}
          llmStatus={llmStatus}
          llmBusy={llmAuthBusy}
          comfyBusy={comfyBusy}
          busy={higgsAuthBusy}
          onLogin={() => void loginHiggs()}
          onRefresh={() => void refreshHiggsStatus()}
          onImageGeneratorChange={(imageGenerator) => void saveImageGenerator(imageGenerator)}
          onChannelProfileApply={(id) => void applyChannelProfile(id)}
          onChannelProfileSave={(name) => void saveChannelProfile(name)}
          onChannelProfileRemove={(id) => void removeChannelProfile(id)}
          onChooseChannelFolder={() => void chooseChannelFolder()}
          channelBriefBusy={channelBriefBusy}
          onChannelContextSave={(patch) => void persistChannelProfilePatch(patch)}
          onRefreshChannelBrief={(handle) => void refreshChannelBrief(handle)}
          stillCastLibrary={stillCastLibrary}
          onProductionModeChange={(mode) => void persistChannelStillCastSettings({ productionMode: mode })}
          onPrepareStillLibrary={() => void prepareStillLibrary()}
          onChooseScriptBible={() => void chooseScriptBible()}
          onChooseIdeaGuide={() => void chooseIdeaGuide()}
          onChooseQwenReference={() => void chooseQwenReference()}
          onSaveQwenReferenceText={(text) => void saveQwenReferenceText(text)}
          onRealignQwen={() => void realignQwen()}
          onComfySettingsSave={(comfy) => void saveComfySettings(comfy)}
          onComfyRefresh={() => void refreshComfyStatus()}
          onLlmLogin={() => void startLlmLogin()}
          onLlmRefresh={() => void refreshLlmStatus()}
          onLlmStepChange={(step, patch) => void saveLlmStep(step, patch)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}

function EmptyProject({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-glow" />
      <div className="empty-icon">
        <Clapperboard size={30} />
      </div>
      <div className="eyebrow">A local-first AI video studio</div>
      <h1>Turn a script into a production.</h1>
      <p>
        Start with a Windows project folder. Higgsfilm will keep your script, recordings, prompts,
        generated visuals, and exports together in one portable workspace.
      </p>
      <button className="button button-primary button-large" onClick={onChoose}>
        <FolderOpen size={17} />
        Choose project folder
      </button>
      <div className="empty-footnote">
        <span>01</span>
        <span>Idea</span>
        <ChevronRight size={13} />
        <span>02</span>
        <span>Write</span>
        <ChevronRight size={13} />
        <span>03</span>
        <span>Record</span>
        <ChevronRight size={13} />
        <span>04</span>
        <span>Generate</span>
      </div>
    </div>
  )
}

const VIDEO_IDEA_GATES: Array<{
  key: keyof VideoIdeaSession['checklist']
  label: string
}> = [
  { key: 'audienceWritten', label: 'Audience' },
  { key: 'demandEvidence', label: 'Demand evidence' },
  { key: 'failuresNoted', label: 'Failures noted' },
  { key: 'sameAudience', label: 'Same audience' },
  { key: 'thumbnailReady', label: 'Thumbnail' },
  { key: 'titleReady', label: 'Title' },
  { key: 'experienceReady', label: 'Experience' },
  { key: 'ctaReady', label: 'CTA' },
]

const VIDEO_IDEA_FIELDS: Array<{ key: keyof VideoIdeaBrief; label: string; rows: number; options?: string[] }> = [
  ...Object.entries(IDEA_REVIEW_FIELDS).map(([key, label]) => ({
    key: key as keyof VideoIdeaBrief,
    label,
    rows: 3,
    options: key === 'selectedCandidate' ? ['A', 'B', 'C']
      : key === 'evidenceConfidence' ? ['low', 'medium', 'high']
        : key === 'decision' ? ['produce', 'revise', 'research', 'park']
          : undefined,
  })),
  { key: 'audience', label: 'Audience', rows: 3 },
  { key: 'awareness', label: 'Awareness', rows: 2 },
  { key: 'subject', label: 'Subject', rows: 2 },
  { key: 'demandEvidence', label: 'Demand evidence', rows: 4 },
  { key: 'failuresNoted', label: 'Failures of this format', rows: 3 },
  { key: 'bridge', label: 'Bridge', rows: 3 },
  { key: 'sameAudienceFit', label: 'Same-audience fit', rows: 3 },
  { key: 'thumbnailConcept', label: 'Thumbnail · emotion / visual / text / open loop', rows: 5 },
  { key: 'title', label: 'Title', rows: 2 },
  { key: 'clickReason', label: 'Why they choose this video', rows: 3 },
  { key: 'promisedExperience', label: 'Promised experience', rows: 4 },
  { key: 'scriptTopic', label: 'Episode sequence that pays the promise', rows: 4 },
  { key: 'cta', label: 'Useful next step / CTA', rows: 3 },
]

function VideoIdeaWorkspace({
  session,
  seed,
  draft,
  busy,
  researching,
  llmStatus,
  channelName,
  niche,
  youtubeHandle,
  channelBrief,
  channelBriefUpdatedAt,
  ideaGuidePath,
  channelProfileBusy,
  channelBriefBusy,
  hasChannelProfile,
  onSeedChange,
  onDraftChange,
  onLlmLogin,
  onNicheChange,
  onYoutubeHandleChange,
  onRefreshChannelBrief,
  onChooseIdeaGuide,
  onStart,
  onSend,
  onCancel,
  onReset,
  onFieldChange,
  onPersistIdea,
  onUseForScript,
}: {
  session: VideoIdeaSession
  seed: string
  draft: string
  busy: boolean
  researching: boolean
  llmStatus: LlmConnectionStatus | null
  channelName: string
  niche: string
  youtubeHandle: string
  channelBrief: string
  channelBriefUpdatedAt: string
  ideaGuidePath: string
  channelProfileBusy: boolean
  channelBriefBusy: boolean
  hasChannelProfile: boolean
  onSeedChange: (value: string) => void
  onDraftChange: (value: string) => void
  onLlmLogin: () => void
  onNicheChange: (value: string) => void
  onYoutubeHandleChange: (value: string) => void
  onRefreshChannelBrief: (handle?: string) => void
  onChooseIdeaGuide: () => void
  onStart: () => void
  onSend: () => void
  onCancel: () => void
  onReset: () => void
  onFieldChange: (key: keyof VideoIdeaBrief, value: string) => void
  onPersistIdea: () => void
  onUseForScript: () => void
}) {
  const chatRef = useRef<HTMLDivElement>(null)
  const [nicheDraft, setNicheDraft] = useState(niche)
  const [handleDraft, setHandleDraft] = useState(youtubeHandle)
  const started = session.messages.length > 0
  const readyForScript = videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)
  const canContinue =
    !session.locked &&
    !readyForScript &&
    started
  const contextBusy = channelProfileBusy || channelBriefBusy
  const briefUpdatedLabel = channelBriefUpdatedAt
    ? new Date(channelBriefUpdatedAt).toLocaleString()
    : ''

  useEffect(() => {
    setNicheDraft(niche)
  }, [niche])

  useEffect(() => {
    setHandleDraft(youtubeHandle)
  }, [youtubeHandle])

  useEffect(() => {
    const node = chatRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [session.messages.length, busy, researching])

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">01 · Video idea</div>
          <h1>Compare ideas. Check the evidence. Choose what to make.</h1>
          <p>
            Compare three candidates for {channelName}, examine real research, and develop a title,
            thumbnail, and opening you can deliver. Record uncertainty before deciding to produce.
          </p>
        </div>
        <div className="heading-actions">
          {started ? (
            <button className="button button-quiet" onClick={onReset} disabled={busy}>
              <Trash2 size={15} />
              New idea
            </button>
          ) : null}
          <button
            className="button button-primary"
            onClick={onUseForScript}
            disabled={busy || !readyForScript}
          >
            <PenLine size={15} />
            {readyForScript ? 'Send to script creator' : 'Complete idea review first'}
          </button>
        </div>
      </div>

      <section className="panel video-idea-channel-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">Channel context</div>
            <h2>Set the niche before the episode seed</h2>
          </div>
          <button
            className="button button-quiet"
            onClick={() => onRefreshChannelBrief(handleDraft)}
            disabled={!hasChannelProfile || contextBusy || busy}
          >
            {channelBriefBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            Refresh from YouTube
          </button>
        </div>
        {!hasChannelProfile ? (
          <p className="panel-intro">
            Choose a channel folder in Settings first. Niche and YouTube brief are saved on the
            channel profile and reused for every episode.
          </p>
        ) : (
          <>
            <p className="panel-intro">
              Niche steers every idea toward the same audience. Optional @handle builds a cached
              brief of recent uploads so the coach knows your formats — not as demand proof for this
              episode.
            </p>
            <div className="video-idea-channel-fields">
              <label className="video-idea-field">
                <span>Channel niche / topic</span>
                <input
                  className="text-input"
                  value={nicheDraft}
                  onChange={(event) => setNicheDraft(event.target.value)}
                  onBlur={() => {
                    if (nicheDraft.trim() !== niche.trim()) onNicheChange(nicheDraft)
                  }}
                  placeholder='Example: Personal Fitness'
                  disabled={contextBusy || busy}
                />
              </label>
              <label className="video-idea-field">
                <span>YouTube handle</span>
                <input
                  className="text-input"
                  value={handleDraft}
                  onChange={(event) => setHandleDraft(event.target.value)}
                  onBlur={() => {
                    const normalized = normalizeYoutubeChannelHandle(handleDraft)
                    setHandleDraft(normalized)
                    if (normalized !== youtubeHandle) onYoutubeHandleChange(normalized)
                  }}
                  placeholder="@YourChannel"
                  disabled={contextBusy || busy}
                />
              </label>
            </div>
            <div className="video-idea-channel-brief">
              <div className="video-idea-channel-brief-header">
                <span className="field-label">Cached channel brief</span>
                {briefUpdatedLabel ? (
                  <span className="connection-summary-detail">Updated {briefUpdatedLabel}</span>
                ) : null}
              </div>
              {channelBrief ? (
                <pre className="video-idea-channel-brief-body">{channelBrief}</pre>
              ) : (
                <div className="settings-selection-note">
                  No brief yet. Enter a handle and refresh to pull recent titles and formats.
                </div>
              )}
            </div>
            <div className="settings-inline-field" style={{ marginTop: 10 }}>
              <span className="connection-summary-detail">
                {ideaGuidePath
                  ? `Idea guide: ${fileNameFromPath(ideaGuidePath)}`
                  : 'Idea guide: built-in default (load a .md/.txt to customize)'}
              </span>
              <button
                className="button button-quiet"
                onClick={onChooseIdeaGuide}
                disabled={contextBusy || busy}
              >
                <FolderOpen size={15} />
                Load guide
              </button>
            </div>
          </>
        )}
      </section>

      <div className="video-idea-gates" aria-label="Idea checklist">
        {VIDEO_IDEA_GATES.map((gate) => (
          <div
            key={gate.key}
            className={`video-idea-gate ${session.checklist[gate.key] ? 'done' : ''}`}
          >
            {session.checklist[gate.key] ? <Check size={13} /> : <span>{gate.label[0]}</span>}
            <strong>{gate.label}</strong>
          </div>
        ))}
      </div>

      <section className="panel" aria-label="Idea review status">
        <p><strong>{readyForScript ? 'Ready for Script creator' : 'Review in progress'}</strong></p>
        <p>{(session.evidence || []).length} researched videos recorded. Citations confirm a source was retrieved; relevance and conclusions still need review.</p>
        {!readyForScript ? <p>Still needed: {unpaidVideoIdeaGates(session).join('; ') || 'review all checklist items'}.</p> : null}
        {(session.evidence || []).length > 0 ? <details><summary>Review research sources</summary>
          <ul>{(session.evidence || []).map(video => <li key={video.videoId}>
            <a href={video.url} target="_blank" rel="noreferrer">{video.title}</a>
            {' - '}{video.channelName}; {video.viewCountText || video.viewCount || 'views unknown'}; {video.published || 'date unknown'}; {video.duration || 'duration unknown'}
          </li>)}</ul>
        </details> : null}
      </section>
      <div className="video-idea-grid">
        <section className="panel video-idea-chat-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Coach</div>
              <h2>{started ? 'Walk the next unpaid gate' : 'Start from a desire, not a joke'}</h2>
            </div>
            <div className={`agent-status ${llmStatus?.authenticated ? 'connected' : ''}`}>
              <span className="status-dot" />
              <span>{llmStatus?.authenticated ? 'ChatGPT connected' : 'ChatGPT not connected'}</span>
            </div>
          </div>

          {!started ? (
            <div className="video-idea-start">
              <p className="panel-intro">
                Optional starting point. Leave this blank to have the coach find the next episode
                from demand. If you already have a desire or a last episode to follow, put it here.
              </p>
              <textarea
                className="text-area video-idea-seed"
                value={seed}
                onChange={(event) => onSeedChange(event.target.value)}
                placeholder="Example: beginners start exercising enthusiastically, then quit after a few sessions."
                disabled={busy}
              />
              <div className="video-idea-start-actions">
                {!llmStatus?.authenticated ? (
                  <button className="button button-quiet" onClick={onLlmLogin} disabled={busy}>
                    <Settings2 size={15} />
                    Sign in with ChatGPT
                  </button>
                ) : null}
                <button className="button button-primary" onClick={onStart} disabled={busy}>
                  {busy ? <LoaderCircle size={15} className="spin" /> : <Lightbulb size={15} />}
                  Start idea session
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="video-idea-thread" ref={chatRef}>
                {session.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`video-idea-message ${message.role}`}
                  >
                    <span>
                      {message.role === 'research' ? <Search size={12} /> : null}
                      {message.role === 'user'
                        ? 'You'
                        : message.role === 'research'
                          ? 'YouTube research'
                          : 'Coach'}
                    </span>
                    <pre>{message.text}</pre>
                  </article>
                ))}
                {busy ? (
                  <div className="video-idea-pending">
                    <LoaderCircle size={15} className="spin" />
                    {researching
                      ? 'Searching YouTube for demand and outliers…'
                      : 'Coach is working the next gate…'}
                  </div>
                ) : null}
              </div>
              <div className="video-idea-composer">
                <textarea
                  className="text-area compact"
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      if (!busy && (draft.trim() || canContinue)) onSend()
                    }
                  }}
                  placeholder="Answer the coach, or continue into thumbnail and title."
                  disabled={busy}
                />
                <div className="video-idea-composer-actions">
                  {!llmStatus?.authenticated ? (
                    <button className="button button-quiet" onClick={onLlmLogin} disabled={busy}>
                      <Settings2 size={15} />
                      Sign in
                    </button>
                  ) : null}
                  {busy ? (
                    <button className="button button-quiet" onClick={onCancel}>
                      <Square size={15} />
                      Stop
                    </button>
                  ) : (
                    <button
                      className="button button-primary"
                      onClick={onSend}
                      disabled={!draft.trim() && !canContinue}
                    >
                      <Send size={15} />
                      {draft.trim() ? 'Send' : 'Continue'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <section className="panel video-idea-brief-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Idea brief</div>
              <h2>{session.locked ? 'Locked for script creation' : session.idea.title || 'Fills in as gates pass'}</h2>
            </div>
            <span className={`progress-badge ${session.locked ? 'ready' : ''}`}>
              {session.locked ? 'Locked' : session.phase}
            </span>
          </div>
          <p className="panel-intro">
            This brief is the handoff to Script creator. Edit anything the coach got wrong before you send it.
          </p>
          <div className="video-idea-fields">
            {VIDEO_IDEA_FIELDS.map((field) => (
              <label key={field.key} className="video-idea-field">
                <span>{field.label}</span>
                {field.options ? (
                  <select
                    className="text-input"
                    value={session.idea[field.key] || ''}
                    onChange={(event) => onFieldChange(field.key, event.target.value)}
                    onBlur={onPersistIdea}
                    disabled={busy}
                  >
                    <option value="">Choose…</option>
                    {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <textarea
                    className="text-area compact"
                    rows={field.rows}
                    value={session.idea[field.key] || ''}
                    onChange={(event) => onFieldChange(field.key, event.target.value)}
                    onBlur={onPersistIdea}
                    disabled={busy}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="paste-panel-footer video-idea-brief-footer">
            <span>
              {readyForScript
                ? 'Candidate comparison, evidence review, packaging, and production decision are complete.'
                : 'Complete the review above, then ask the coach to reassess your brief.'}
            </span>
            <button className="button button-primary" onClick={onUseForScript} disabled={busy || !readyForScript}>
              <PenLine size={15} />
              Script creator
            </button>
          </div>
        </section>
      </div>
    </>
  )
}

function scriptDraftLineCount(script: string): number {
  return script.trim() ? script.trim().split(/\n/).filter(Boolean).length : 0
}

function isBuxFitCustomOnly(channelName: string | undefined, bible: string): boolean {
  return (
    /\bbuxfit\b/i.test(channelName || '') ||
    /every spoken line (?:must be )?(?:custom|use custom)|100% of spoken lines.{0,50}custom/i.test(bible)
  )
}

function scriptDraftFingerprint(script: string): string {
  let hash = 2166136261
  for (let index = 0; index < script.length; index += 1) {
    hash = Math.imul(hash ^ script.charCodeAt(index), 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function CopyCustomStillsButton({
  lines,
  label = 'Copy stills',
  copiedLabel = 'Copied stills',
  onCopy,
}: {
  lines: ReturnType<typeof extractCustomStillCastLines>
  label?: string
  copiedLabel?: string
  onCopy?: () => Promise<void>
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <button
      className="button button-quiet"
      onClick={() => {
        const copy = onCopy
          ? onCopy()
          : copyTextToClipboard(lines.map((line) => line.fileName.replace(/\.png$/i, '')).join('\n')).then(
              (ok) => {
                if (!ok) throw new Error('Could not copy the stills.')
              },
            )
        void copy.then(() => setCopied(true)).catch(() => undefined)
      }}
      disabled={lines.length === 0}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? copiedLabel : `${label}${lines.length > 0 ? ` (${lines.length})` : ''}`}
    </button>
  )
}

function ScriptDraftReviewSummary({
  scriptDraft,
  customOnly,
  staleSource,
  sourceKnown,
  draftEdited,
}: {
  scriptDraft: string
  customOnly: boolean
  staleSource: boolean
  sourceKnown: boolean
  draftEdited: boolean
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const review = reviewScriptDraft(scriptDraft, { customOnly })
  const totalSeconds = Math.ceil(review.estimatedSeconds)
  const estimatedTime = `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
  return (
    <div className="script-draft-review">
      <div className="script-draft-review-stats">
        <span>{review.spokenWordCount} spoken words</span>
        <span>{review.sceneCount} scenes</span>
        <span>~{estimatedTime} at 150 wpm estimate</span>
      </div>
      {scriptDraft.trim() && !sourceKnown ? (
        <div className="script-draft-source-warning" role="status">
          Source unknown — review against current topic and Bible.
        </div>
      ) : null}
      {staleSource ? (
        <div className="script-draft-source-warning" role="status">
          This draft came from a different topic or script bible. Review the source before applying.
        </div>
      ) : null}
      {scriptDraft.trim() && sourceKnown && draftEdited ? (
        <div className="script-draft-source-warning" role="status">
          Draft edited since generation. Its original topic and Bible source are retained.
        </div>
      ) : null}
      <button className="text-button" type="button" onClick={() => setPreviewOpen((open) => !open)}>
        {previewOpen ? 'Hide narration-only read-aloud preview' : 'Show narration-only read-aloud preview'}
      </button>
      {previewOpen ? (
        <pre className="script-draft-read-aloud" aria-label="Narration-only read-aloud preview">
          {review.spokenText || 'No spoken narration yet.'}
        </pre>
      ) : null}
      {review.issues.length > 0 ? (
        <ul className="script-draft-issues" aria-label="Draft review issues">
          {review.issues.map((issue, index) => (
            <li className={`script-draft-issue ${issue.severity}`} key={`${issue.lineNumber}-${index}`}>
              <strong>Line {issue.lineNumber} · {issue.severity}:</strong> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ScriptDraftReader({
  scriptDraft,
  stillCastEnabled,
  customOnly,
  staleSource,
  sourceKnown,
  draftEdited,
  busy,
  hasExistingLines,
  onChange,
  onClose,
  onApply,
  onCopyCustomStills,
}: {
  scriptDraft: string
  stillCastEnabled: boolean
  customOnly: boolean
  staleSource: boolean
  sourceKnown: boolean
  draftEdited: boolean
  busy: boolean
  hasExistingLines: boolean
  onChange: (value: string) => void
  onClose: () => void
  onApply: () => void
  onCopyCustomStills?: () => Promise<void>
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineCount = scriptDraftLineCount(scriptDraft)
  const customLines = extractCustomStillCastLines(scriptDraft)
  const review = reviewScriptDraft(scriptDraft, { customOnly })

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="modal-backdrop script-draft-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal-card script-draft-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-draft-title"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">Draft script</div>
            <h2 id="script-draft-title">
              {scriptDraft.trim() ? 'Read and edit the full script' : 'The script will appear here'}
            </h2>
          </div>
          <div className="script-draft-modal-tools">
            <span className="progress-badge">{lineCount > 0 ? `${lineCount} lines` : 'Waiting'}</span>
            {stillCastEnabled ? (
              <CopyCustomStillsButton
                lines={customLines}
                label="Copy 16:9 stills"
                copiedLabel="Copied 16:9 stills"
                onCopy={onCopyCustomStills}
              />
            ) : null}
            <button className="icon-button" onClick={onClose} aria-label="Close script draft">
              <X size={18} />
            </button>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          className="text-area script-draft-reader-area"
          value={scriptDraft}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            stillCastEnabled
              ? 'Custom: Bux opened his wallet and counted one hundred dollars. | Full body, Bux counts bills beside his open wallet.\nCustom: He felt rich for a moment. | Bux smiles beside a paper hundred-dollar bill.\nCustom: Then he saw the new price of treats. | Bux looks at a treat price tag.'
              : 'The generated narration will appear here so you can edit it before creating lines.'
          }
          spellCheck={false}
        />
        <ScriptDraftReviewSummary scriptDraft={scriptDraft} customOnly={customOnly} staleSource={staleSource} sourceKnown={sourceKnown} draftEdited={draftEdited} />
        <div className="modal-actions script-draft-modal-actions">
          <span>
            {hasExistingLines
              ? 'Creating lines replaces the current 16:9 narration and regenerates the 9:16 condensed cut.'
              : 'Edits here stay in the draft. Close whenever you are done reading.'}
          </span>
          <button className="button button-quiet" onClick={onClose}>
            Close
          </button>
          <button className="button button-primary" onClick={onApply} disabled={busy || !review.canApply}>
            <Sparkles size={15} />
            Create 16:9 and 9:16 lines
          </button>
        </div>
      </section>
    </div>
  )
}

function ScriptCreator({
  scriptBiblePath,
  scriptBibleText,
  scriptTopic,
  scriptDraft,
  customOnly,
  staleSource,
  sourceKnown,
  draftEdited,
  scriptDraftBusy,
  channelProfileBusy,
  llmStatus,
  stillCastEnabled,
  hasExistingLines,
  ideaTitle,
  ideaLocked,
  onOpenIdea,
  onTopicChange,
  onDraftChange,
  onChooseBible,
  onLlmLogin,
  onGenerate,
  onApply,
  onCopyCustomStills,
}: {
  scriptBiblePath: string
  scriptBibleText: string
  scriptTopic: string
  scriptDraft: string
  customOnly: boolean
  staleSource: boolean
  sourceKnown: boolean
  draftEdited: boolean
  scriptDraftBusy: boolean
  channelProfileBusy: boolean
  llmStatus: LlmConnectionStatus | null
  stillCastEnabled: boolean
  hasExistingLines: boolean
  ideaTitle: string
  ideaLocked: boolean
  onOpenIdea: () => void
  onTopicChange: (value: string) => void
  onDraftChange: (value: string) => void
  onChooseBible: () => void
  onLlmLogin: () => void
  onGenerate: () => void
  onApply: () => void
  onCopyCustomStills: () => Promise<void>
}) {
  const [draftOpen, setDraftOpen] = useState(false)
  const draftLineCount = scriptDraftLineCount(scriptDraft)
  const customLines = extractCustomStillCastLines(scriptDraft)
  const review = reviewScriptDraft(scriptDraft, { customOnly })
  const bibleMissing = Boolean(scriptBiblePath.trim()) && !scriptBibleText.trim()
  const canGenerate = !scriptDraftBusy && Boolean(scriptBibleText.trim()) && Boolean(scriptTopic.trim())
  const generateTitle = scriptDraftBusy
    ? undefined
    : !scriptBibleText.trim()
      ? bibleMissing
        ? 'Script bible file was not found. The folder may have been renamed. Load the file again.'
        : 'Load a script bible file before generating.'
      : !scriptTopic.trim()
        ? 'Enter a topic for the script.'
        : undefined
  const bibleLabel = bibleMissing
    ? 'Script bible file not found. Load it again after the folder rename.'
    : scriptBiblePath
      ? fileNameFromPath(scriptBiblePath)
      : 'No script bible loaded yet.'

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">02 · Script creator</div>
          <h1>Write the narration from a topic.</h1>
          <p>
            {stillCastEnabled
              ? 'ChatGPT follows the loaded script bible for the 16:9 episode. Creating narration lines also writes a 9:16 condensed cut of the same lesson, about 30 seconds, with Custom-9x16 stills for every short line.'
              : 'Describe the topic, then turn the draft into narration lines. Creating lines also writes a 9:16 condensed cut of the same lesson.'}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button button-quiet" onClick={onOpenIdea}>
            <Lightbulb size={15} />
            {ideaLocked ? 'Edit video idea' : 'Create video idea'}
          </button>
          <button
            className="button button-primary"
            onClick={onGenerate}
            disabled={!canGenerate}
            title={generateTitle}
          >
            {scriptDraftBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            Generate script
          </button>
        </div>
      </div>
      {ideaTitle ? (
        <div className={`idea-handoff ${ideaLocked ? 'locked' : ''}`}>
          <Lightbulb size={15} />
          <span>
            {ideaLocked ? 'Locked video idea' : 'Video idea in progress'}: {ideaTitle}
          </span>
          <button className="text-button" onClick={onOpenIdea}>
            Open idea <ChevronRight size={14} />
          </button>
        </div>
      ) : null}

      <div className="script-creator-grid">
        <div className="script-creator-bible-strip">
          <FileText size={15} />
          <span>{bibleLabel}</span>
          <button
            className="button button-quiet"
            onClick={onChooseBible}
            disabled={channelProfileBusy || scriptDraftBusy}
          >
            <FolderOpen size={15} />
            Load file
          </button>
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Topic</div>
              <h2>What is this episode about?</h2>
            </div>
            <PenLine size={17} className="accent-icon" />
          </div>
          <p className="panel-intro">
            Be specific. The bible already owns format; the topic should own the subject, angle, and any must-include facts.
          </p>
          <textarea
            className="text-area script-creator-topic"
            value={scriptTopic}
            onChange={(event) => onTopicChange(event.target.value)}
            placeholder="Example: Why people feel powerful when they see one hundred dollars, told as a short DoggoBux episode."
            disabled={scriptDraftBusy}
          />
          <div className="script-creator-actions">
            <div className={`agent-status ${llmStatus?.authenticated ? 'connected' : ''}`}>
              <span className="status-dot" />
              <span>{llmStatus?.authenticated ? 'ChatGPT connected' : 'ChatGPT not connected'}</span>
            </div>
            <div className="agent-actions">
              {!llmStatus?.authenticated ? (
                <button className="button button-quiet" onClick={onLlmLogin} disabled={scriptDraftBusy}>
                  <Settings2 size={15} />
                  Sign in with ChatGPT
                </button>
              ) : null}
              <button
                className="button button-primary"
                onClick={onGenerate}
                disabled={!canGenerate}
                title={generateTitle}
              >
                {scriptDraftBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                Generate script
              </button>
            </div>
          </div>
        </section>

        <section className="panel script-creator-draft">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Draft</div>
              <h2>{scriptDraft.trim() ? 'Edit before creating lines' : 'The script will appear here'}</h2>
            </div>
            <div className="script-creator-draft-tools">
              <span className="progress-badge">{draftLineCount > 0 ? `${draftLineCount} lines` : 'Waiting'}</span>
              {stillCastEnabled ? (
              <CopyCustomStillsButton
                lines={customLines}
                label="Copy 16:9 stills"
                copiedLabel="Copied 16:9 stills"
                onCopy={onCopyCustomStills}
              />
            ) : null}
              <button className="button button-quiet" onClick={() => setDraftOpen(true)}>
                <Maximize2 size={15} />
                Pop out
              </button>
            </div>
          </div>
          <textarea
            className="text-area paste-area script-creator-draft-area"
            value={scriptDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={
              stillCastEnabled
                ? 'Custom: Bux opened his wallet and counted one hundred dollars. | Full body, Bux counts bills beside his open wallet.\nCustom: He felt rich for a moment. | Bux smiles beside a paper hundred-dollar bill.\nCustom: Then he saw the new price of treats. | Bux looks at a treat price tag.'
                : 'The generated narration will appear here so you can edit it before creating lines.'
            }
            spellCheck={false}
          />
          <ScriptDraftReviewSummary scriptDraft={scriptDraft} customOnly={customOnly} staleSource={staleSource} sourceKnown={sourceKnown} draftEdited={draftEdited} />
          <div className="paste-panel-footer script-creator-draft-footer">
            <span>
              {hasExistingLines
                ? 'Creating lines replaces the current 16:9 narration and regenerates the 9:16 condensed cut.'
                : 'This becomes the 16:9 project script. A 9:16 condensed cut is generated from it next.'}
            </span>
            <button
              className="button button-primary"
              onClick={onApply}
              disabled={scriptDraftBusy || !review.canApply}
            >
              <Sparkles size={15} />
              Create 16:9 and 9:16 lines
            </button>
          </div>
        </section>
      </div>
      {draftOpen ? (
        <ScriptDraftReader
          scriptDraft={scriptDraft}
          customOnly={customOnly}
          staleSource={staleSource}
          sourceKnown={sourceKnown}
          draftEdited={draftEdited}
          stillCastEnabled={stillCastEnabled}
          busy={scriptDraftBusy}
          hasExistingLines={hasExistingLines}
          onChange={onDraftChange}
          onClose={() => setDraftOpen(false)}
          onApply={onApply}
          onCopyCustomStills={onCopyCustomStills}
        />
      ) : null}
    </>
  )
}

function Overview({
  project,
  recordedCount,
  visualCount,
  totalDuration,
  higgsConfigured,
  llmStatus,
  llmPrompt,
  llmOutput,
  llmBusy,
  ideaLocked,
  onNavigate,
  onConnect,
  onLlmPromptChange,
  onLlmLogin,
  onLlmGenerate,
  onExport,
  exporting,
}: {
  project: ProjectState
  recordedCount: number
  visualCount: number
  totalDuration: number
  higgsConfigured: boolean
  llmStatus: LlmConnectionStatus | null
  llmPrompt: string
  llmOutput: string
  llmBusy: boolean
  ideaLocked: boolean
  onNavigate: (section: StudioSection) => void
  onConnect: () => void
  onLlmPromptChange: (value: string) => void
  onLlmLogin: () => void
  onLlmGenerate: () => void
  onExport: () => void
  exporting: boolean
}) {
  const progress = project.manifest.lines.length
    ? Math.round((visualCount / project.manifest.lines.length) * 100)
    : 0

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Production board</div>
          <h1>{project.manifest.name}</h1>
          <p>Move from narration to approved visuals, then export a mastered first cut.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-quiet" onClick={() => onNavigate('script')}>
            <Mic size={15} />
            Open recording
          </button>
          <button className="button button-primary" disabled={visualCount === 0 || exporting} onClick={onExport}>
            {exporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            Export first cut
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Narration lines" value={String(project.manifest.lines.length).padStart(2, '0')} detail={`${recordedCount} recorded`} icon={FileAudio} />
        <StatCard label="Visuals ready" value={`${visualCount}/${project.manifest.lines.length || 0}`} detail={`${progress}% of storyboard`} icon={ImageIcon} />
        <StatCard label="Estimated runtime" value={formatTime(totalDuration)} detail="Based on current line timing" icon={Play} />
        <StatCard label="Output format" value="16:9" detail={formatExportCanvas(project.manifest.exportSettings)} icon={Clapperboard} />
      </div>

      <div className="overview-grid">
        <section className="panel panel-large">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Workflow</div>
              <h2>Build the first cut</h2>
            </div>
            <span className="progress-badge">{progress}% complete</span>
          </div>
          <div className="workflow-list">
            <WorkflowStep number="01" title="Create the video idea" detail="Walk demand, packaging, promised experience, and CTA with ChatGPT until the brief is locked." done={ideaLocked} onClick={() => onNavigate('idea')} action="Open video idea" />
            <WorkflowStep number="02" title="Write the script" detail="Load a script bible, send the locked brief, and let ChatGPT draft a script that pays the click." done={project.manifest.lines.length > 0} onClick={() => onNavigate('create')} action="Open script creator" />
            <WorkflowStep number="03" title="Record each line" detail="Keep your natural timing as the source of truth." done={recordedCount === project.manifest.lines.length && recordedCount > 0} onClick={() => onNavigate('script')} action="Open recorder" />
            <WorkflowStep number="04" title="Generate approved visuals" detail="Edit prompts, then send only approved scenes to Higgsfield." done={visualCount === project.manifest.lines.length && visualCount > 0} onClick={() => onNavigate('visuals')} action="Open visuals" />
            <WorkflowStep number="05" title="Export the longform cut" detail="Combine visuals and voice into a 4K YouTube master with dialogue-first loudness." done={false} onClick={() => onNavigate('export')} action="Review export" />
          </div>
        </section>

        <section className="panel bible-card">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Visual bible</div>
              <h2>{project.manifest.visualBible.name}</h2>
            </div>
            <button className="icon-button" onClick={() => onNavigate('visuals')} aria-label="Edit visual bible">
              <Settings2 size={16} />
            </button>
          </div>
          <div className="bible-preview">
            <div className="bible-swatch swatch-warm" />
            <div className="bible-swatch swatch-ink" />
            <div className="bible-swatch swatch-accent" />
            <div className="bible-lines">
              <span />
              <span />
              <span />
            </div>
          </div>
          <p>{project.manifest.visualBible.style}</p>
          <div className="tag-row">
            <span className="tag">16:9 longform</span>
            <span className="tag">Character-ready</span>
            <span className="tag">Prompt editable</span>
          </div>
        </section>

        <section className="panel recent-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Scene queue</div>
              <h2>Latest scenes</h2>
            </div>
            <button className="text-button" onClick={() => onNavigate('visuals')}>
              View all <ChevronRight size={14} />
            </button>
          </div>
          {project.manifest.lines.length === 0 ? (
            <div className="mini-empty">Import a script to create the scene queue.</div>
          ) : (
            <div className="scene-mini-list">
              {project.manifest.lines.slice(0, 4).map((line) => (
                <div className="scene-mini-row" key={line.id}>
                  <div className="scene-mini-index">{String(line.index + 1).padStart(2, '0')}</div>
                  <div className="scene-mini-copy">
                    <strong>{line.text}</strong>
                    <span>{formatTime(line.startTime)} · {statusLabel(line.sceneStatus)}</span>
                  </div>
                  <div className={`mini-status ${line.sceneStatus}`} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={`panel connection-card ${higgsConfigured ? 'is-connected' : ''}`}>
          <div className="connection-art">
            <WandSparkles size={24} />
          </div>
          <div>
            <div className="eyebrow">{higgsConfigured ? 'Generation ready' : 'One setup step'}</div>
            <h2>{higgsConfigured ? 'Higgsfield is connected' : 'Connect Higgsfield'}</h2>
            <p>
              {higgsConfigured
                ? 'Prompts stay local until you approve a scene generation. Jobs use your Higgsfield account credits through CLI OAuth.'
                : 'Sign in with Higgsfield CLI OAuth to use the credits from your existing Higgsfield account.'}
            </p>
            <button className="text-button" onClick={onConnect}>
              {higgsConfigured ? 'Manage connection' : 'Open Settings'} <ChevronRight size={14} />
            </button>
          </div>
        </section>

        <section className="panel agent-card">
          <div className="panel-header agent-card-header">
            <div>
              <div className="eyebrow">Creative copilot</div>
              <h2>Use ChatGPT to shape the production.</h2>
              <p className="agent-description">
                Draft ideas, scene plans, JSON shot lists, or visual directions through your
                ChatGPT-authenticated Codex session.
              </p>
            </div>
            <div className={`agent-status ${llmStatus?.authenticated ? 'connected' : ''}`}>
              <span className="status-dot" />
              <span>{llmStatus?.authenticated ? 'ChatGPT connected' : 'ChatGPT not connected'}</span>
            </div>
          </div>
          <div className="agent-grid">
            <textarea
              className="text-area agent-input"
              value={llmPrompt}
              onChange={(event) => onLlmPromptChange(event.target.value)}
              placeholder="Example: Create 5 viral 2D cartoon explainer ideas about the history of fire. Include a hook, premise, and visual direction for each."
            />
            <div className="agent-output">
              {llmBusy ? (
                <div className="agent-loading"><LoaderCircle size={17} className="spin" /> ChatGPT is drafting...</div>
              ) : llmOutput ? (
                <pre>{llmOutput}</pre>
              ) : (
                <div className="agent-output-placeholder">
                  <Sparkles size={18} />
                  <span>Your generated creative artifact will appear here.</span>
                </div>
              )}
            </div>
          </div>
          <div className="agent-footer">
            <span>
              {llmStatus?.installed
                ? llmStatus.message
                : 'Install the official Codex CLI, then sign in with ChatGPT.'}
            </span>
            <div className="agent-actions">
              {!llmStatus?.authenticated ? (
                <button className="button button-quiet" onClick={onLlmLogin}>
                  <Settings2 size={15} />
                  Sign in with ChatGPT
                </button>
              ) : null}
              <button className="button button-primary" onClick={onLlmGenerate} disabled={llmBusy || !llmPrompt.trim()}>
                {llmBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                Generate with ChatGPT
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string
  detail: string
  icon: LucideIcon
}) {
  return (
    <div className="stat-card">
      <div className="stat-topline">
        <span>{label}</span>
        <Icon size={15} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function WorkflowStep({
  number,
  title,
  detail,
  done,
  onClick,
  action,
}: {
  number: string
  title: string
  detail: string
  done: boolean
  onClick: () => void
  action: string
}) {
  return (
    <div className={`workflow-step ${done ? 'done' : ''}`}>
      <div className="step-number">{done ? <Check size={15} /> : number}</div>
      <div className="step-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button className="text-button" onClick={onClick}>
        {done ? 'Review' : action} <ChevronRight size={14} />
      </button>
    </div>
  )
}

function ScriptWorkspace({
  project,
  sequence,
  activeLineId,
  recordingLineId,
  countdownLineId,
  countdownValue,
  countdownLeadInSeconds,
  recordOnceActive,
  audioSources,
  voiceMode,
  qwenStatus,
  qwenBusy,
  qwenProgress,
  onSelectLine,
  onImportScript,
  onImportScriptText,
  stillCastEnabled = false,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onVoiceModeChange,
  onGenerateQwen,
  onCancelQwen,
  onTrimVoiceTake,
  onResetVoiceCleanup,
  onOpenVoiceInspector,
  voiceInspectorOpen = false,
  onUpdateLine,
  onSave,
  trailerScriptBusy,
  onGenerateTrailerScript,
}: {
  project: ProjectState
  sequence: SequenceId
  activeLineId: string | null
  recordingLineId: string | null
  countdownLineId: string | null
  countdownValue: number | null
  countdownLeadInSeconds: number | null
  recordOnceActive: boolean
  audioSources: Record<string, string>
  voiceMode: VoiceMode
  qwenStatus: QwenTtsStatus | null
  qwenBusy: boolean
  qwenProgress: QwenTtsProgress | null
  onSelectLine: (id: string) => void
  onImportScript: () => void
  onImportScriptText: (script: string) => void
  stillCastEnabled?: boolean
  onStartRecording: (id: string, options?: { recordOnce?: boolean }) => void
  onStopRecording: (advance?: boolean) => void
  onCancelRecording: () => void
  onVoiceModeChange: (mode: VoiceMode) => void
  onGenerateQwen: (mode: 'paragraph' | 'all' | 'resume') => void
  onCancelQwen: () => void
  onTrimVoiceTake: (
    lineId: string,
    window: { trimStartSeconds: number; trimEndSeconds: number },
  ) => Promise<void>
  onResetVoiceCleanup: (lineId: string) => Promise<void>
  onOpenVoiceInspector?: () => void
  voiceInspectorOpen?: boolean
  onUpdateLine: (id: string, text: string) => void
  onSave: () => void
  trailerScriptBusy: boolean
  onGenerateTrailerScript: () => void
}) {
  const selectedLine = project.manifest.lines.find((line) => line.id === activeLineId) || project.manifest.lines[0]
  const selectedStanza = selectedLine ? stanzaLinesFor(selectedLine, project.manifest.lines) : []
  const [showPaste, setShowPaste] = useState(project.manifest.lines.length === 0)
  const [pastedScript, setPastedScript] = useState('')
  const [voiceEditBusy, setVoiceEditBusy] = useState(false)
  const selectedLinePosition = selectedLine
    ? project.manifest.lines.findIndex((line) => line.id === selectedLine.id)
    : -1
  const previousLine = selectedLinePosition > 0 ? project.manifest.lines[selectedLinePosition - 1] : undefined
  const nextLine =
    selectedLinePosition >= 0 && selectedLinePosition < project.manifest.lines.length - 1
      ? project.manifest.lines[selectedLinePosition + 1]
      : undefined
  const clipNavLocked = Boolean(recordingLineId || countdownLineId)

  useEffect(() => {
    if (!selectedLine) return
    const node = document.querySelector(`[data-script-line="${selectedLine.id}"]`)
    node?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [selectedLine?.id])
  const isRecording = stillCastEnabled
    ? selectedStanza.some((line) => line.id === recordingLineId)
    : recordingLineId === selectedLine?.id
  const isCountingDown = stillCastEnabled
    ? selectedStanza.some((line) => line.id === countdownLineId)
    : countdownLineId === selectedLine?.id
  const focusDuration = stillCastEnabled ? stanzaDuration(selectedStanza) : selectedLine?.duration || 0
  const stanzaNumber = (selectedLine?.paragraphIndex || 0) + 1
  const stanzaRecorded = selectedStanza.length > 0 && selectedStanza.every((line) => line.status === 'recorded')
  const stanzaExpressions = stillCastEnabled
    ? selectedStanza.map((line) => {
        const expression = line.stillBeats?.[0]?.expression
        return expression ? stillCastExpressionLabel(expression) : ''
      })
    : []
  const uniqueStanzaTones = [...new Set(stanzaExpressions.filter(Boolean))]
  const sharedStanzaTone = uniqueStanzaTones.length === 1 ? uniqueStanzaTones[0] : undefined
  const mixedStanzaTones = uniqueStanzaTones.length > 1
  const stanzaSpeakers = stillCastEnabled ? scriptSpeakerCuesForLines(selectedStanza) : []
  const uniqueStanzaSpeakers = [...new Set(stanzaSpeakers.map((cue) => cue.label))]
  const sharedStanzaSpeaker = uniqueStanzaSpeakers.length === 1 ? stanzaSpeakers[0] : undefined
  const mixedStanzaSpeakers = uniqueStanzaSpeakers.length > 1
  const qwenToneLabel = stillCastEnabled && selectedLine
    ? stillCastExpressionLabel(stillCastLineVocalExpression(selectedLine))
    : ''
  const trailerCustomLines =
    sequence === 'trailer' && stillCastEnabled
      ? spokenStillCastLinesFromScriptLines(project.manifest.lines)
      : []

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {sequence === 'trailer' ? 'CONDENSED · 9:16 · ~30 seconds' : '02 · Script & voice'}
          </div>
          <h1>
            {sequence === 'trailer'
              ? 'Build the vertical cut.'
              : voiceMode === 'qwen'
                ? 'Generate the voice timeline.'
                : 'Record the source of truth.'}
          </h1>
          <p>
            {sequence === 'trailer'
              ? stillCastEnabled
                ? 'Same lesson as the 16:9 episode, condensed to about 30 seconds. Every line needs a Custom-9x16 still named after the spoken words.'
                : 'Same lesson as the 16:9 episode, condensed to about 30 seconds. Finish with a call to watch the full video.'
              : stillCastEnabled
                ? voiceMode === 'qwen'
                  ? 'Each newline is one still. QWEN clones your reference and speaks each line as its own take. Custom stills are still spoken.'
                  : 'Each newline is one still and one recording take. Trailing commas are spoken punctuation only — they do not merge lines into a shared teleprompter stanza.'
                : voiceMode === 'qwen'
                  ? 'QWEN reads each paragraph as one natural performance, then Higgsfilm maps the resulting speech back to each line.'
                  : 'Each line becomes a timed clip. Prompts and images begin generating as soon as the script is saved, while your delivery sets the rhythm.'}
          </p>
        </div>
        <div className="heading-actions">
          {sequence === 'trailer' && stillCastEnabled ? (
            <CopyCustomStillsButton
              lines={trailerCustomLines}
              label="Copy 9:16 stills"
              copiedLabel="Copied 9:16 stills"
            />
          ) : null}
          {sequence === 'trailer' ? (
            <button
              className="button button-primary"
              onClick={onGenerateTrailerScript}
              disabled={trailerScriptBusy}
            >
              {trailerScriptBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              {trailerScriptBusy ? 'Generating condensed…' : 'Generate condensed script'}
            </button>
          ) : null}
          <button className="button button-quiet" onClick={() => setShowPaste((current) => !current)}>
            <FileText size={15} />
            {showPaste ? 'Hide paste area' : 'Paste script'}
          </button>
          <button className="button button-quiet" onClick={onImportScript}>
            <FileText size={15} />
            Replace script
          </button>
          <button className="button button-primary" onClick={onSave}>
            <Save size={15} />
            Save changes
          </button>
        </div>
      </div>

      <section className="voice-mode-bar" aria-label="Voice source">
        <div>
          <span className="eyebrow">Voice source</span>
          <strong>{voiceMode === 'qwen' ? (stillCastEnabled ? 'QWEN line TTS' : 'QWEN paragraph TTS') : 'Microphone recording'}</strong>
        </div>
        <div className="voice-mode-options" role="radiogroup" aria-label="Voice source">
          <button
            className={`button ${voiceMode === 'microphone' ? 'button-primary' : 'button-quiet'}`}
            aria-pressed={voiceMode === 'microphone'}
            disabled={Boolean(recordingLineId || countdownLineId || qwenBusy)}
            onClick={() => onVoiceModeChange('microphone')}
          >
            <Mic size={14} />
            Microphone
          </button>
          <button
            className={`button ${voiceMode === 'qwen' ? 'button-primary' : 'button-quiet'}`}
            aria-pressed={voiceMode === 'qwen'}
            disabled={Boolean(recordingLineId || countdownLineId || qwenBusy)}
            onClick={() => onVoiceModeChange('qwen')}
          >
            <Sparkles size={14} />
            QWEN TTS
          </button>
        </div>
      </section>

      {selectedLine ? (
        <section
          className={`recording-focus ${isRecording || isCountingDown ? 'is-live' : ''}`}
          aria-live="polite"
        >
          <div className="recording-focus-topline">
            <span className="eyebrow">
              {isCountingDown
                ? `Get ready · ${countdownLeadInSeconds ?? 3}-second lead-in · starting in ${countdownValue ?? 3}`
                : isRecording
                  ? stillCastEnabled
                    ? 'Recording current stanza'
                    : 'Recording current line'
                  : stillCastEnabled
                    ? `Current stanza · ${String(stanzaNumber).padStart(2, '0')}`
                    : `Current line · ${String(selectedLine.index + 1).padStart(2, '0')}`}
            </span>
            <span className="recording-focus-time">{formatTime(focusDuration)}</span>
          </div>
          <div className="recording-focus-copy">
            {isCountingDown ? <div className="recording-countdown">{countdownValue}</div> : null}
            {stillCastEnabled ? (
              <div className="stanza-script">
                {sharedStanzaSpeaker && !mixedStanzaSpeakers ? (
                  <span className={`recording-focus-speaker is-${sharedStanzaSpeaker.register}`}>
                    {sharedStanzaSpeaker.label}
                    <small>{sharedStanzaSpeaker.hint}</small>
                  </span>
                ) : null}
                {sharedStanzaTone && !mixedStanzaTones ? (
                  <span className="recording-focus-tone">{sharedStanzaTone}</span>
                ) : null}
                {selectedStanza.map((line, index) =>
                  mixedStanzaTones || mixedStanzaSpeakers ? (
                    <div className="stanza-beat" key={line.id}>
                      {mixedStanzaSpeakers && stanzaSpeakers[index] ? (
                        <span className={`recording-focus-speaker is-${stanzaSpeakers[index].register}`}>
                          {stanzaSpeakers[index].label}
                        </span>
                      ) : null}
                      {stanzaExpressions[index] ? (
                        <span className="recording-focus-tone">{stanzaExpressions[index]}</span>
                      ) : null}
                      <p>{line.text}</p>
                    </div>
                  ) : (
                    <p key={line.id}>{line.text}</p>
                  ),
                )}
              </div>
            ) : (
              <p>{selectedLine.text}</p>
            )}
          </div>
          <div className="recording-focus-hint">
            {isRecording
              ? recordOnceActive
                ? stillCastEnabled
                  ? 'Recording this stanza only · Pause to save · Enter saves · Escape redoes · Auto-skip is off'
                  : 'Recording this line only · Pause to save · Enter saves · Escape redoes · Auto-skip is off'
                : stillCastEnabled
                  ? 'Pause about a second after the last line to save · Enter does it now · Left arrow goes back one stanza · Spacebar stops · Escape redoes this stanza'
                  : 'A short pause after you finish auto-saves and starts the next line · Enter does it now · Left arrow goes back one line · Spacebar stops · Escape redoes this line'
              : isCountingDown
                ? stillCastEnabled
                  ? 'Press Escape to restart with a 1-second lead-in · Left arrow goes back one stanza'
                  : 'Press Escape to restart with a 1-second lead-in · Left arrow goes back one line'
                : voiceMode === 'qwen'
                  ? stillCastEnabled
                    ? `QWEN clones your reference and speaks this line as its own take (${qwenToneLabel || 'Neutral Talking'} still).`
                    : 'QWEN reads the complete paragraph, then assigns the generated speech back to each line.'
                  : stillCastEnabled
                    ? 'Read this line. The speaker label tells you Bux the fool vs Bux realization. Start the recording from the card below.'
                    : 'Read this line naturally. Start the take from the recording card below.'}
          </div>
        </section>
      ) : null}

      <div className="workspace-grid script-workspace">
        <section className="panel script-panel">
          <div className="scene-selector">
            <div>
              <div className="eyebrow">Voice queue</div>
              <h2>{project.manifest.lines.length} lines · {formatTime(project.manifest.lines.reduce((sum, line) => sum + line.duration, 0))}</h2>
            </div>
            <div className="scene-selector-count">
              {stillCastEnabled ? (voiceMode === 'qwen' ? 'One still per line · QWEN by line tone' : 'One still per line · one take per line') : '150 WPM estimate until recorded'}
            </div>
          </div>
          {showPaste ? (
            <div className="paste-panel">
              <div className="paste-panel-heading">
                <div>
                  <strong>{sequence === 'trailer' ? 'Paste your 9:16 script' : 'Paste your narration'}</strong>
                  <span>
                    {sequence === 'trailer'
                      ? stillCastEnabled
                        ? 'Prefix every line with Custom:. The short uses vertical Custom stills only. Finish with a call to watch the full video.'
                        : 'Use one spoken beat per line and finish with an editable call to watch the full video.'
                      : stillCastEnabled
                        ? 'Prefix almost every line with Custom:. Use an expression only when the line has nothing to show. Every newline is its own scene and recording take.'
                        : 'Paste a transcript, draft, or timestamped script. Higgsfilm will split it into editable lines.'}
                  </span>
                </div>
                <FileText size={18} />
              </div>
              <textarea
                className="text-area paste-area"
                value={pastedScript}
                onChange={(event) => setPastedScript(event.target.value)}
                placeholder={
                  stillCastEnabled
                    ? 'Custom: Bux opened his wallet and counted one hundred dollars.\nConfident: To him, that felt like a fortune.\nCustom: Then he saw the new price of treats.'
                    : 'Paste your script here...'
                }
                autoFocus
              />
              <div className="paste-panel-footer">
                <span>
                  {stillCastEnabled
                    ? 'Expression prefixes are stripped from the teleprompter. Every newline is one beat, one still, and one recording take.'
                    : 'Sentence punctuation such as .?! creates new lines.'}
                </span>
                <button
                  className="button button-primary"
                  disabled={!pastedScript.trim()}
                  onClick={() => {
                    onImportScriptText(pastedScript)
                    setShowPaste(false)
                  }}
                >
                  <Sparkles size={15} />
                  {sequence === 'trailer' ? 'Create condensed lines' : 'Create narration lines'}
                </button>
              </div>
            </div>
          ) : null}
          {project.manifest.lines.length === 0 && !showPaste ? (
            <div className="empty-panel">
              <FileText size={22} />
              <strong>{sequence === 'trailer' ? 'Your 9:16 script is waiting.' : 'Your script is waiting.'}</strong>
              <span>
                {sequence === 'trailer'
                  ? 'Generate a condensed cut from the longform script, paste one, or import a text file.'
                  : 'Paste a script or import a text file to create editable narration lines.'}
              </span>
              {sequence === 'trailer' ? (
                <button className="button button-secondary" onClick={onGenerateTrailerScript} disabled={trailerScriptBusy}>
                  <Sparkles size={15} />
                  Generate condensed script
                </button>
              ) : (
                <button className="button button-secondary" onClick={onImportScript}>Import script</button>
              )}
            </div>
          ) : project.manifest.lines.length > 0 ? (
            <div className="scene-strip line-strip">
              {project.manifest.lines.map((line) => (
                <button
                  className={`scene-card ${line.id === selectedLine?.id ? 'selected' : ''}`}
                  key={line.id}
                  data-script-line={line.id}
                  disabled={clipNavLocked}
                  onClick={() => onSelectLine(line.id)}
                  title={line.text}
                >
                  <div className="scene-card-media">
                    {line.imagePath && audioSources[line.imagePath] ? (
                      <img src={audioSources[line.imagePath]} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <div className="scene-placeholder">
                        {line.status === 'recorded' ? <Check size={18} /> : <Mic size={18} />}
                      </div>
                    )}
                    <div className="scene-card-statuses">
                      <span className={`scene-status-badge ${line.status}`}>
                        {line.status === 'recorded' ? <Check size={11} /> : null}
                        {line.status === 'recorded' ? 'Recorded' : 'Draft'}
                      </span>
                    </div>
                  </div>
                  <div className="scene-card-meta">
                    <span>
                      {String(line.index + 1).padStart(2, '0')}
                      {stillCastEnabled ? ` · S${String((line.paragraphIndex || 0) + 1).padStart(2, '0')}` : ''}
                      {' · '}
                      {formatTime(line.startTime)}
                      {line.role === 'cta' ? ' · CTA' : ''}
                    </span>
                    <strong>{line.text}</strong>
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          {selectedLine ? (
            <>
              <div className="panel-header inspector-header">
                <div>
                  <div className="eyebrow">
                    {stillCastEnabled
                      ? `Stanza ${String(stanzaNumber).padStart(2, '0')}`
                      : `Line ${String(selectedLine.index + 1).padStart(2, '0')}`}
                  </div>
                  <h2>Voice performance</h2>
                </div>
                <span className="time-chip">{formatTime(focusDuration)}</span>
              </div>
              <label className="field-label" htmlFor="line-copy">Narration copy</label>
              <textarea
                id="line-copy"
                className="text-area line-copy-area"
                value={selectedLine.text}
                onChange={(event) => onUpdateLine(selectedLine.id, event.target.value)}
              />
              {voiceMode === 'qwen' ? (
                <div className="record-card qwen-record-card">
                  <div className="record-card-top">
                    <div className="record-icon"><Sparkles size={18} /></div>
                    <div>
                      <strong>{stillCastEnabled ? 'QWEN line voice' : 'QWEN paragraph voice'}</strong>
                      <span>
                        {qwenStatus?.configured
                          ? stillCastEnabled
                            ? `${qwenStatus.referenceName || 'Reference ready'} · Clone speaks this line as its own take (${qwenToneLabel || 'Neutral Talking'} still). ${
                                qwenStatus.alignment.configured
                                  ? 'Whisper will verify the spoken words, not the expression label.'
                                  : 'Install the local Whisper alignment runtime in Settings before generating.'
                              }`
                            : `${qwenStatus.referenceName || 'Reference ready'} · QWEN reads this entire paragraph in one pass. ${
                                qwenStatus.alignment.configured
                                  ? 'Whisper will verify and align every spoken word.'
                                  : 'Install the local Whisper alignment runtime in Settings before generating.'
                              }`
                          : 'Configure a reference audio file and exact transcript in Settings first.'}
                      </span>
                    </div>
                  </div>
                  <div className="qwen-generation-actions">
                    {qwenBusy ? (
                      <button className="button button-recording" onClick={onCancelQwen}>
                        <Square size={14} fill="currentColor" />
                        Stop QWEN generation
                      </button>
                    ) : (
                      <>
                        <button
                          className="button button-primary"
                          onClick={() => onGenerateQwen('paragraph')}
                          disabled={!qwenStatus?.configured || !qwenStatus.alignment.configured}
                          title={stillCastEnabled ? 'Generate this line as its own cloned take.' : 'Generate the complete paragraph containing this line.'}
                        >
                          <Sparkles size={15} />
                          {stillCastEnabled ? 'Generate this line' : 'Generate paragraph'}
                        </button>
                        <button
                          className="button button-secondary"
                          onClick={() => onGenerateQwen('resume')}
                          disabled={!qwenStatus?.configured || !qwenStatus.alignment.configured || project.manifest.lines.length === 0}
                          title={stillCastEnabled ? 'Generate every line that does not have QWEN audio yet.' : 'Generate every paragraph that does not have QWEN audio yet.'}
                        >
                          Resume missing
                        </button>
                        <button
                          className="button button-quiet"
                          onClick={() => onGenerateQwen('all')}
                          disabled={!qwenStatus?.configured || !qwenStatus.alignment.configured || project.manifest.lines.length === 0}
                        >
                          {stillCastEnabled ? 'Generate all lines' : 'Generate all paragraphs'}
                        </button>
                      </>
                    )}
                  </div>
                  {qwenBusy && qwenProgress ? (
                    <p className="qwen-generation-status" role="status" aria-live="polite">
                      {stillCastEnabled ? 'Line' : 'Paragraph'} {qwenProgress.paragraphIndex + 1} of {qwenProgress.paragraphCount} · {qwenProgress.stage}
                    </p>
                  ) : null}
                  {selectedLine.voiceAlignmentSource ? (
                    <span className="subtle-label">
                      {selectedLine.voiceAlignmentSource === 'line-fallback'
                        ? 'Line fallback take'
                        : 'Paragraph-aligned take'}
                      {typeof selectedLine.voiceAlignmentConfidence === 'number'
                        ? ` · ${(selectedLine.voiceAlignmentConfidence * 100).toFixed(0)}% confidence`
                        : ''}
                    </span>
                  ) : null}
                  {selectedLine.voiceAlignmentError ? (
                    <span className="qwen-alignment-warning">{selectedLine.voiceAlignmentError}</span>
                  ) : null}
                </div>
              ) : (
                <div className="record-card">
                <div className="record-card-top">
                  <div className="record-icon">
                    {isCountingDown ? <LoaderCircle size={17} className="spin" /> : isRecording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
                  </div>
                  <div>
                    <strong>
                      {isCountingDown
                        ? `Starting in ${countdownValue ?? 3}`
                        : isRecording
                          ? stillCastEnabled
                            ? 'Recording this stanza'
                            : 'Recording this line'
                          : stillCastEnabled
                            ? stanzaRecorded
                              ? 'Stanza recorded'
                              : 'Record this stanza'
                            : selectedLine.voicePath
                              ? 'Take recorded'
                              : 'Record a take'}
                    </strong>
                    <span>
                      {isCountingDown
                        ? 'Get ready to speak.'
                        : isRecording
                          ? recordOnceActive
                            ? stillCastEnabled
                              ? 'Auto-skip is off. Pause or press Enter to save this line and stay here.'
                              : 'Auto-skip is off. Pause or press Enter to save this line and stay here.'
                            : stillCastEnabled
                              ? 'Pause after you finish the line to save and start the next one. Enter does it now. Left arrow goes back one line.'
                              : 'Stop speaking for a short pause to save and start the next line. Enter does it now. Left arrow goes back one line.'
                          : stillCastEnabled
                            ? 'Record this line. Audio is saved onto this beat only.'
                            : 'Record, listen back, and re-record until it feels right.'}
                    </span>
                  </div>
                </div>
                {isCountingDown ? (
                  <button className="button button-quiet" onClick={onCancelRecording}>
                    <X size={14} />
                    Restart with 1-second lead-in
                  </button>
                ) : isRecording ? (
                  <div className="record-card-actions">
                    <button
                      className="button button-recording"
                      onClick={() => onStopRecording(!recordOnceActive)}
                    >
                      <Check size={14} />
                      {recordOnceActive ? 'Save take' : 'Save take & next'}
                    </button>
                    <button className="button button-quiet" onClick={onCancelRecording}>
                      <X size={14} />
                      Redo
                    </button>
                  </div>
                ) : (
                  <div className="record-card-actions">
                    <button className="button button-primary" onClick={() => onStartRecording(selectedLine.id)}>
                      <Mic size={15} />
                      {stillCastEnabled
                        ? stanzaRecorded
                          ? 'Record stanza again'
                          : 'Start stanza recording'
                        : selectedLine.voicePath
                          ? 'Record new take'
                          : 'Start recording'}
                    </button>
                    <button
                      className="button button-quiet"
                      onClick={() => onStartRecording(selectedLine.id, { recordOnce: true })}
                    >
                      <Mic size={15} />
                      {stillCastEnabled ? 'Record this stanza only' : 'Record this line only'}
                    </button>
                  </div>
                )}
                </div>
              )}
              <div className="inspector-note">
                <AlertCircle size={15} />
                <span>
                  {voiceMode === 'qwen'
                    ? stillCastEnabled
                      ? 'QWEN keeps your cloned voice. Each still-cast line is a separate take. The clone node cannot take a silent emotion instruction, so tone follows the spoken words and the reference clip.'
                      : 'QWEN reads a complete paragraph once, then splits the resulting speech into the paragraph’s individual timeline lines.'
                    : stillCastEnabled
                      ? 'Record one take per line. Export uses that audio with the assigned still. Left arrow goes back one line.'
                      : 'After you finish the line, a short pause saves and advances automatically. Enter advances immediately; Left arrow goes back one line; Spacebar stops; Escape redoes the line with a 1-second lead-in.'}
                </span>
              </div>
            </>
          ) : project.manifest.lines.length > 0 ? (
            <div className="empty-panel">
              <Mic size={22} />
              <strong>Select a line to record.</strong>
              <span>Your recorded voice becomes the timing spine of the production.</span>
            </div>
          ) : null}
        </section>
        <section className="panel inspector-panel">
          <div className="panel-header inspector-header">
            <div>
              <div className="eyebrow">Voice preview</div>
              <h2>{selectedLine ? `Line ${selectedLine.index + 1}` : 'No line selected'}</h2>
            </div>
            <div className="voice-preview-header-actions">
              {selectedLine ? (
                <span className="time-chip">{formatTime(selectedLine.duration || 0)}</span>
              ) : null}
              <button
                className="button button-secondary"
                onClick={() => onOpenVoiceInspector?.()}
                disabled={!selectedLine?.voicePath || !onOpenVoiceInspector}
                title="Open a monitor-centered voice inspector"
              >
                <Maximize2 size={15} />
                {voiceInspectorOpen ? 'Focus inspector' : 'Inspect takes'}
              </button>
            </div>
          </div>
          {selectedLine ? (
            <>
              <VoiceWaveformPreview
                voicePath={
                  selectedLine.voicePath && !recordingLineId && !countdownLineId
                    ? selectedLine.voicePath
                    : undefined
                }
                voiceAssetVersion={selectedLine.voiceAssetVersion}
                audioUrl={
                  selectedLine.voicePath &&
                  audioSources[selectedLine.voicePath] &&
                  !recordingLineId &&
                  !countdownLineId
                    ? audioSources[selectedLine.voicePath]
                    : undefined
                }
                durationSeconds={selectedLine.duration || 0}
                voiceTrimStart={selectedLine.voiceTrimStart}
                voiceCleanupVersion={selectedLine.voiceCleanupVersion}
                voiceCleanupEndPaddingSeconds={selectedLine.voiceCleanupEndPaddingSeconds}
                voiceCleanupConfident={selectedLine.voiceCleanupConfident}
                canTrim={Boolean(selectedLine.voiceRawPath && typeof selectedLine.voiceTrimStart === 'number')}
                busy={voiceEditBusy || Boolean(recordingLineId || countdownLineId)}
                onTrim={(trimWindow) => {
                  setVoiceEditBusy(true)
                  void onTrimVoiceTake(selectedLine.id, trimWindow).finally(() => {
                    setVoiceEditBusy(false)
                  })
                }}
                onResetCleanup={() => {
                  setVoiceEditBusy(true)
                  void onResetVoiceCleanup(selectedLine.id).finally(() => {
                    setVoiceEditBusy(false)
                  })
                }}
              />
              <div className="scene-preview-navigation voice-preview-navigation">
                <button
                  className="button button-quiet"
                  onClick={() => previousLine && onSelectLine(previousLine.id)}
                  disabled={!previousLine || clipNavLocked}
                >
                  <ChevronLeft size={15} />
                  Previous take
                </button>
                <span>
                  Take {selectedLinePosition >= 0 ? selectedLinePosition + 1 : '—'} of{' '}
                  {project.manifest.lines.length}
                </span>
                <div className="scene-preview-navigation-end">
                  <button
                    className="button button-secondary"
                    onClick={() => onOpenVoiceInspector?.()}
                    disabled={!selectedLine.voicePath || !onOpenVoiceInspector}
                    title="Open a monitor-centered voice inspector"
                  >
                    <Maximize2 size={15} />
                    {voiceInspectorOpen ? 'Focus inspector' : 'Inspect takes'}
                  </button>
                  <button
                    className="button button-quiet"
                    onClick={() => nextLine && onSelectLine(nextLine.id)}
                    disabled={!nextLine || clipNavLocked}
                  >
                    Next take
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="scene-preview-large voice-preview-large">
              <div className="scene-preview-empty">
                <Mic size={28} />
                <strong>Select a line</strong>
                <span>The cleaned take waveform will appear here.</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function CustomImagePanel({
  project,
  selectedLine,
  customStills,
  setup,
  busy,
  progress,
  authenticated,
  onChooseGuide,
  onChooseCharacterSheet,
  onClearCharacterSheet,
  onAddReferences,
  onRemoveReference,
  onGenerate,
  onCopyMissing,
  onCancel,
  onLogin,
}: {
  project: ProjectState
  selectedLine?: ScriptLine
  customStills: Array<{ matchKey: string }>
  setup: CustomImageSetup | null
  busy: boolean
  progress: CustomImageProgress | null
  authenticated: boolean
  onChooseGuide: () => void
  onChooseCharacterSheet: () => void
  onClearCharacterSheet: () => void
  onAddReferences: () => void
  onRemoveReference: (filePath: string) => void
  onGenerate: (onlyMissing: boolean) => void
  onCopyMissing: () => void
  onCancel: () => void
  onLogin: () => void
}) {
  const customLines = project.manifest.lines.filter((line) =>
    (line.stillBeats || []).some((beat) => isCustomStillCastExpression(beat.expression)),
  )
  const trackedStatuses = new Map((setup?.stills || []).map((still) => [still.lineId, still.status]))
  const statusForLine = (line: ScriptLine): 'missing' | 'current' | 'stale' | 'unknown' => {
    const tracked = trackedStatuses.get(line.id)
    if (tracked) return tracked
    return matchCustomStillToLine(line.text, customStills) ? 'unknown' : 'missing'
  }
  const missingCount = customLines.filter((line) => statusForLine(line) === 'missing').length
  const staleCount = customLines.filter((line) => statusForLine(line) === 'stale').length
  const unknownCount = customLines.filter((line) => statusForLine(line) === 'unknown').length
  const needsWorkCount = missingCount + staleCount
  const selectedIsCustom = Boolean(
    selectedLine && customLines.some((line) => line.id === selectedLine.id),
  )
  const guideReady = Boolean(setup?.guidePath)
  const characterSheet = setup?.characterSheetPath || ''
  const references = setup?.referencePaths || []
  const canGenerate = authenticated && guideReady && Boolean(characterSheet) && !busy
  const selectedSourceStatus = selectedLine && selectedIsCustom ? statusForLine(selectedLine) : null
  const selectedSourceLabel = selectedSourceStatus === 'missing'
    ? 'No matching Custom image yet'
    : selectedSourceStatus === 'stale'
      ? 'Source changed · update recommended'
      : selectedSourceStatus === 'unknown'
        ? 'Source history unknown · review image manually'
        : selectedSourceStatus === 'current'
          ? 'Tracked sources match'
          : null

  return (
    <section className="custom-image-panel">
      <div className="custom-image-panel-heading">
        <div>
          <div className="eyebrow">16:9 custom stills</div>
          <h2>Generate Custom images</h2>
        </div>
        {busy ? (
          <button className="button button-quiet" onClick={onCancel}>
            <Square size={14} />
            Stop
          </button>
        ) : null}
      </div>
      <p>
        One image per Custom line, saved in this project’s Custom folder and named after the spoken
        line. The character sheet locks proportions and costume. Extra references are for the face
        and paper texture. Leave finished scene stills out of that list.
      </p>
      <p className="custom-image-source-help">
        Source tracking reports whether saved inputs changed; it does not verify visual correctness.
        Existing images with unknown source history stay usable and should be reviewed manually.
      </p>
      <div className="custom-image-source-summary" role="status">
        <span>{missingCount} missing</span>
        <span>{staleCount} needs update</span>
        <span>{unknownCount} source unknown</span>
      </div>
      {setup?.sourceError ? (
        <div className="custom-image-source-error" role="status">
          Source freshness could not be checked: {setup.sourceError}
        </div>
      ) : null}
      {selectedSourceLabel ? (
        <div className={`custom-image-selected-source custom-image-source-${selectedSourceStatus}`} role="status">
          <span className="field-label">Selected line source</span>
          <strong>{selectedSourceLabel}</strong>
          {selectedSourceStatus === 'current' ? (
            <span>Tracked inputs match the last saved generation record. Visual correctness still needs a manual check.</span>
          ) : null}
        </div>
      ) : null}
      <div className="custom-image-setup">
        <div>
          <span className="field-label">Guide</span>
          <strong title={setup?.guidePath || undefined}>
            {setup?.guidePath ? fileNameFromPath(setup.guidePath) : 'Not found yet'}
          </strong>
          <button className="button button-quiet" onClick={onChooseGuide} disabled={busy}>
            <FileText size={14} />
            Choose guide
          </button>
        </div>
        <div>
          <span className="field-label">Character sheet</span>
          <strong title={characterSheet || undefined}>
            {characterSheet ? fileNameFromPath(characterSheet) : 'Required'}
          </strong>
          <div className="custom-image-setup-actions">
            <button className="button button-quiet" onClick={onChooseCharacterSheet} disabled={busy}>
              <ImageIcon size={14} />
              {characterSheet ? 'Replace sheet' : 'Choose sheet'}
            </button>
            {characterSheet ? (
              <button className="button button-quiet" onClick={onClearCharacterSheet} disabled={busy}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
        <div>
          <span className="field-label">Face references</span>
          <strong>
            {references.length === 0 ? 'Optional' : `${references.length} of 4`}
          </strong>
          <button className="button button-quiet" onClick={onAddReferences} disabled={busy || references.length >= 4}>
            <ImageIcon size={14} />
            Add references
          </button>
        </div>
      </div>
      {references.length > 0 ? (
        <div className="custom-image-references">
          {references.map((filePath) => (
            <span className="custom-image-reference" key={filePath}>
              {fileNameFromPath(filePath)}
              <button
                type="button"
                aria-label={`Remove ${fileNameFromPath(filePath)}`}
                onClick={() => onRemoveReference(filePath)}
                disabled={busy}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {progress && busy ? (
        <div className="custom-image-progress" role="status">
          <LoaderCircle size={14} className="spin" />
          <span>
            {progress.phase === 'saving'
              ? 'Saving'
              : progress.phase === 'assigned'
                ? 'Assigned'
                : 'Generating'}{' '}
            {progress.index} of {progress.total}: {progress.fileName}
          </span>
        </div>
      ) : null}
      <div className="custom-image-actions">
        {authenticated ? null : (
          <button className="button button-secondary" onClick={onLogin} disabled={busy}>
            Sign in to ChatGPT
          </button>
        )}
        <button
          className="button button-secondary"
          onClick={() => onGenerate(false)}
          disabled={!canGenerate || !selectedIsCustom}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}
          Generate this line
        </button>
        <button
          className="button button-primary"
          onClick={() => onGenerate(true)}
          disabled={!canGenerate || needsWorkCount === 0}
        >
          Generate missing or update stale{needsWorkCount > 0 ? ` (${needsWorkCount})` : ''}
        </button>
        <button
          className="button button-quiet"
          onClick={onCopyMissing}
          disabled={busy || needsWorkCount === 0 || !guideReady}
        >
          <Copy size={14} />
          Copy missing or stale for Cursor{needsWorkCount > 0 ? ` (${needsWorkCount})` : ''}
        </button>
      </div>
    </section>
  )
}

function VisualWorkspace({
  project,
  sequence,
  selectedLine,
  activeLineId,
  assetSources,
  higgsStatus,
  comfyStatus,
  llmStatus,
  imageGenerator,
  contextPromptsBusy,
  contextPromptProgress,
  imageBatchBusy,
  imageCancelBusy,
  automaticImageGenerationEnabled,
  productionBibles,
  productionBibleBusy,
  stillCastEnabled = false,
  stillCastLibrary = null,
  stillCastBusy = false,
  customImageSetup = null,
  customImageBusy = false,
  customImageProgress = null,
  onChooseCustomImageGuide,
  onChooseCustomImageCharacterSheet,
  onClearCustomImageCharacterSheet,
  onAddCustomImageReferences,
  onRemoveCustomImageReference,
  onGenerateCustomImages,
  onCopyMissingCustomStills,
  onCancelCustomImages,
  onOpenImageInspector,
  imageInspectorOpen = false,
  imageFilter = 'all',
  onSelectLine,
  onChangeStillCastExpression,
  onSaveProductionBible,
  onLoadProductionBible,
  onUpdateBible,
  onUpdateShotNote,
  onUpdatePrompt,
  onPromptRefinementChange,
  onSave,
  onGenerateSelectedPrompt,
  onRegeneratePromptWithRefinement,
  onGenerateAllPrompts,
  onGeneratePromptsFromHere,
  onGenerateRemainingPrompts,
  onGenerateSelectedImage,
  onAcceptRegeneratedImage,
  onGenerateAllImages,
  onGenerateImagesFromHere,
  onGenerateRemainingImages,
  onCancelImages,
  onToggleAutomaticImageGeneration,
  onCancelContextPrompts,
  onLlmLogin,
  onConnect,
}: {
  project: ProjectState
  sequence: SequenceId
  selectedLine?: ScriptLine
  activeLineId: string | null
  assetSources: Record<string, string>
  higgsStatus: HiggsConnectionStatus | null
  comfyStatus: ComfyConnectionStatus | null
  llmStatus: LlmConnectionStatus | null
  imageGenerator: ImageGenerator
  contextPromptsBusy: boolean
  contextPromptProgress: ContextPromptProgress | null
  imageBatchBusy: boolean
  imageCancelBusy: boolean
  automaticImageGenerationEnabled: boolean
  productionBibles: ProductionBiblePreset[]
  productionBibleBusy: boolean
  stillCastEnabled?: boolean
  stillCastLibrary?: StillCastLibraryScan | null
  stillCastBusy?: boolean
  customImageSetup?: CustomImageSetup | null
  customImageBusy?: boolean
  customImageProgress?: CustomImageProgress | null
  onChooseCustomImageGuide?: () => void
  onChooseCustomImageCharacterSheet?: () => void
  onClearCustomImageCharacterSheet?: () => void
  onAddCustomImageReferences?: () => void
  onRemoveCustomImageReference?: (filePath: string) => void
  onGenerateCustomImages?: (onlyMissing: boolean) => void
  onCopyMissingCustomStills?: () => void
  onCancelCustomImages?: () => void
  onOpenImageInspector?: () => void
  imageInspectorOpen?: boolean
  imageFilter?: TimelineImageFilter
  onSelectLine: (id: string) => void
  onChangeStillCastExpression?: (beatId: string | undefined, expression: string) => void
  onSaveProductionBible: (name: string) => void
  onLoadProductionBible: (name: string) => void
  onUpdateBible: (key: keyof ProjectManifest['visualBible'], value: string) => void
  onUpdateShotNote?: (lineId: string, shotNote: string) => void
  onUpdatePrompt: (value: string) => void
  onPromptRefinementChange: (value: string) => void
  onSave: () => void
  onGenerateSelectedPrompt: () => void
  onRegeneratePromptWithRefinement: () => void
  onGenerateAllPrompts: () => void
  onGeneratePromptsFromHere: () => void
  onGenerateRemainingPrompts: () => void
  onGenerateSelectedImage: () => void
  onAcceptRegeneratedImage?: () => void
  onGenerateAllImages: () => void
  onGenerateImagesFromHere: () => void
  onGenerateRemainingImages: () => void
  onCancelImages: () => void
  onToggleAutomaticImageGeneration: () => void
  onCancelContextPrompts: () => void
  onLlmLogin: () => void
  onConnect: () => void
}) {
  const [showBible, setShowBible] = useState(true)
  const [productionBibleName, setProductionBibleName] = useState('')
  const [selectedProductionBibleName, setSelectedProductionBibleName] = useState('')
  const [promptElapsedSeconds, setPromptElapsedSeconds] = useState(0)

  useEffect(() => {
    setProductionBibleName(project.manifest.visualBible.name || '')
  }, [project.manifest.id, project.manifest.visualBible.name])

  useEffect(() => {
    if (!contextPromptProgress) {
      setPromptElapsedSeconds(0)
      return
    }

    const updateElapsed = () => {
      setPromptElapsedSeconds(Math.max(0, Math.floor((Date.now() - contextPromptProgress.startedAt) / 1000)))
    }
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [contextPromptProgress?.startedAt])

  const visibleLines = filterLinesForTimeline(project.manifest.lines, imageFilter)
  const selectedLinePosition = selectedLine
    ? visibleLines.findIndex((line) => line.id === selectedLine.id)
    : -1
  const previousLine = adjacentFilteredLine(
    project.manifest.lines,
    selectedLine?.id || null,
    -1,
    imageFilter,
  )
  const nextLine = adjacentFilteredLine(
    project.manifest.lines,
    selectedLine?.id || null,
    1,
    imageFilter,
  )
  const expressionFolders = stillCastLibrary?.folders || []
  const customStillsForSequence =
    sequence === 'trailer'
      ? stillCastLibrary?.trailerCustomStills || []
      : stillCastLibrary?.customStills || []
  const customStillForSelectedLine =
    selectedLine ? matchCustomStillToLine(selectedLine.text, customStillsForSequence) : undefined
  const customFolderLabel = sequence === 'trailer' ? 'Custom-9x16' : 'Custom'
  const imageProviderConfigured =
    imageGenerator === 'chatgpt'
      ? Boolean(llmStatus?.authenticated)
      : imageGenerator === 'comfyui'
        ? Boolean(comfyStatus?.reachable)
        : Boolean(higgsStatus?.configured)
  const imageProviderLabel = imageProviderLabelForActivity(imageGenerator)
  const imageModelLabel =
    imageGenerator === 'chatgpt'
      ? 'ChatGPT image generation'
      : imageGenerator === 'comfyui'
        ? comfyStatus?.selectedModel || 'ComfyUI local workflow'
        : higgsStatus?.modelEndpoint || 'nano_banana_2_lite'
  const hasActiveImageWork =
    imageBatchBusy ||
    imageCancelBusy ||
    project.manifest.lines.some((line) => line.sceneStatus === 'queued' || line.sceneStatus === 'generating')
  const trailerCustomLines =
    sequence === 'trailer' && stillCastEnabled
      ? spokenStillCastLinesFromScriptLines(project.manifest.lines)
      : []

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {sequence === 'trailer' ? 'CONDENSED · 9:16 VISUAL DIRECTION' : '03 · Visual direction'}
          </div>
          <h1>
            {stillCastEnabled
              ? sequence === 'trailer'
                ? 'Assign Custom-9x16 stills.'
                : 'Cast expressions onto the script.'
              : 'Turn narration into scenes.'}
          </h1>
          <p>
            {stillCastEnabled
              ? sequence === 'trailer'
                ? 'Every short line uses a vertical Custom-9x16 still named after the spoken words. Expression faces stay on the 16:9 episode.'
                : 'Custom: lines are the normal picture and wait for a matching image in the project Custom folder. Expression prefixes are only for a rare reaction.'
              : sequence === 'trailer'
                ? 'Keep every face and action readable in a vertical frame while preserving the shared visual bible.'
                : 'Let ChatGPT read the full script, resolve character context, refine each prompt, then approve generations one scene at a time.'}
          </p>
        </div>
        <div className="heading-actions">
          {sequence === 'trailer' && stillCastEnabled ? (
            <CopyCustomStillsButton
              lines={trailerCustomLines}
              label="Copy 9:16 stills"
              copiedLabel="Copied 9:16 stills"
            />
          ) : null}
          {contextPromptProgress ? (
            <div className="prompt-draft-progress" role="status" aria-live="polite">
              <div className="prompt-draft-progress-heading">
                <span>
                  {contextPromptProgress.phase === 'summary'
                    ? 'Reading the full script'
                    : `ChatGPT drafting line ${contextPromptProgress.current} of ${contextPromptProgress.total}`}
                </span>
                <strong>{contextPromptProgress.completed} complete</strong>
              </div>
              <div className="prompt-draft-progress-track">
                <span
                  style={{
                    width: `${(contextPromptProgress.completed / contextPromptProgress.total) * 100}%`,
                  }}
                />
              </div>
              <small>
                {contextPromptProgress.lineText} · waiting {formatTime(promptElapsedSeconds)}
              </small>
            </div>
          ) : null}
          <button className="button button-quiet" onClick={() => setShowBible((current) => !current)}>
            <PanelLeft size={15} />
            {showBible ? 'Hide visual bible' : 'Show visual bible'}
          </button>
          <button className="button button-secondary" onClick={onSave}>
            <Save size={15} />
            Save direction
          </button>
        </div>
      </div>

      {stillCastEnabled ? (
        <div className="still-cast-library-note">
          {stillCastLibrary
            ? sequence === 'trailer'
              ? stillCastLibrary.trailerCustomStills && stillCastLibrary.trailerCustomStills.length > 0
                ? `${stillCastLibrary.trailerCustomStills.length} Custom-9x16 image${stillCastLibrary.trailerCustomStills.length === 1 ? '' : 's'} named after short lines. Expression folders are not used on this cut.`
                : 'Drop vertical stills into this project’s Custom-9x16 folder, named exactly after each short spoken line.'
              : [
                  `${stillCastLibrary.folders.filter((folder) => folder.imagePaths.length > 0).length} of ${stillCastLibrary.folders.length} expression folders have stills.`,
                  stillCastLibrary.customStills && stillCastLibrary.customStills.length > 0
                    ? `${stillCastLibrary.customStills.length} Custom image${stillCastLibrary.customStills.length === 1 ? '' : 's'} named after script lines.`
                    : 'Drop episode pictures into this project’s Custom folder, named exactly after the script line they belong to.',
                ].join(' ')
            : sequence === 'trailer'
              ? '9:16 shorts use Custom-9x16 stills only. Put one vertical image per spoken line in that folder.'
              : 'Expression stills come from the channel Expressions folder. Custom stills come from this project’s Custom folder.'}
        </div>
      ) : null}

      {stillCastEnabled && sequence === 'main' ? (
        <CustomImagePanel
          project={project}
          selectedLine={selectedLine}
          customStills={stillCastLibrary?.customStills || []}
          setup={customImageSetup}
          busy={customImageBusy}
          progress={customImageProgress}
          authenticated={Boolean(llmStatus?.authenticated)}
          onChooseGuide={() => onChooseCustomImageGuide?.()}
          onChooseCharacterSheet={() => onChooseCustomImageCharacterSheet?.()}
          onClearCharacterSheet={() => onClearCustomImageCharacterSheet?.()}
          onAddReferences={() => onAddCustomImageReferences?.()}
          onRemoveReference={(filePath) => onRemoveCustomImageReference?.(filePath)}
          onGenerate={(onlyMissing) => onGenerateCustomImages?.(onlyMissing)}
          onCopyMissing={() => onCopyMissingCustomStills?.()}
          onCancel={() => onCancelCustomImages?.()}
          onLogin={onLlmLogin}
        />
      ) : null}

      <div className={`visual-layout ${showBible ? '' : 'bible-collapsed'}`}>
        {showBible ? (
          <section className="panel bible-editor">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Global rules</div>
                <h2>{project.manifest.visualBible.name}</h2>
              </div>
              <Sparkles size={17} className="accent-icon" />
            </div>
            <p className="panel-intro">These rules stay separate from the line prompts and are attached to every image-generation request.</p>
            <div className="bible-presets">
              <div className="bible-presets-label">Saved production bibles</div>
              <div className="bible-preset-controls">
                <div className="bible-preset-save">
                  <input
                    className="text-input"
                    value={productionBibleName}
                    onChange={(event) => setProductionBibleName(event.target.value)}
                    placeholder={project.manifest.visualBible.name || 'Preset name'}
                    disabled={productionBibleBusy}
                    aria-label="Production bible preset name"
                  />
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      const name = productionBibleName.trim()
                      setSelectedProductionBibleName(name)
                      onSaveProductionBible(name)
                    }}
                    disabled={!productionBibleName.trim() || productionBibleBusy}
                  >
                    Save current
                  </button>
                </div>
                <div className="bible-preset-load">
                  <select
                    className="select-input"
                    value={selectedProductionBibleName}
                    onChange={(event) => setSelectedProductionBibleName(event.target.value)}
                    disabled={productionBibleBusy}
                    aria-label="Saved production bibles"
                  >
                    <option value="">
                      {productionBibles.length > 0 ? 'Choose a saved style…' : 'No saved styles yet'}
                    </option>
                    {productionBibles.map((preset) => (
                      <option key={preset.name} value={preset.name}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button button-quiet"
                    onClick={() => onLoadProductionBible(selectedProductionBibleName)}
                    disabled={!selectedProductionBibleName || productionBibleBusy}
                  >
                    {productionBibleBusy ? <LoaderCircle size={14} className="spin" /> : null}
                    Load
                  </button>
                </div>
              </div>
              <span className="connection-summary-detail">
                Saved styles are available across projects. Loading one replaces this project’s
                visual bible and clears scene directions generated with the previous style.
              </span>
            </div>
            <div className="field-stack">
              {visualBibleFields.map((field) => (
                <label className="field-group" key={field.key}>
                  <span className="field-label">{field.label}</span>
                  <textarea
                    className="text-area compact"
                    value={project.manifest.visualBible[field.key]}
                    placeholder={field.placeholder}
                    onChange={(event) => onUpdateBible(field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>
        ) : null}

        <section className="panel scene-editor">
          <div className="scene-selector">
            <div>
              <div className="eyebrow">Scene queue</div>
              <h2>Storyboard prompts</h2>
            </div>
            <div className="scene-selector-count">{project.manifest.lines.length} scenes</div>
          </div>
          <div className="scene-strip">
            {project.manifest.lines.map((line) => (
              <button className={`scene-card ${line.id === activeLineId ? 'selected' : ''}`} key={line.id} onClick={() => onSelectLine(line.id)}>
                <div className="scene-card-media">
                  {line.imagePath && assetSources[line.imagePath] ? (
                    <img src={assetSources[line.imagePath]} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <div className="scene-placeholder"><ImageIcon size={18} /></div>
                  )}
                  <div className="scene-card-statuses">
                    <span className={`scene-status-badge direction-${directionStatusOf(line)}`}>
                      {directionStatusOf(line) === 'complete' ? <Check size={11} /> : null}
                      {directionStatusLabel(line)}
                    </span>
                    <span className={`scene-status-badge ${line.sceneStatus}`}>
                      {line.sceneStatus === 'complete' ? <Check size={11} /> : null}
                      {hasImage(line) ? 'Image ready' : statusLabel(line.sceneStatus)}
                    </span>
                  </div>
                </div>
                <div className="scene-card-meta">
                  <span>{String(line.index + 1).padStart(2, '0')} · {formatTime(line.startTime)}</span>
                  <strong>{line.text}</strong>
                </div>
              </button>
            ))}
          </div>

          {selectedLine ? (
            <div className="prompt-editor">
              <div className="prompt-editor-heading">
                <div>
                  <div className="eyebrow">Scene {String(selectedLine.index + 1).padStart(2, '0')} · {formatTime(selectedLine.startTime)}</div>
                  <h2>Voice + scene prompt</h2>
                </div>
                <span className={`status-pill ${selectedLine.sceneStatus}`}>{statusLabel(selectedLine.sceneStatus)}</span>
              </div>
              <div className="prompt-source">
                <span className="prompt-source-label">Narration</span>
                <span>{selectedLine.text}</span>
              </div>
              {stillCastEnabled &&
              (selectedLine.stillBeats || []).some((beat) =>
                isCustomStillCastExpression(beat.expression),
              ) ? (
                <label className="field-group">
                  <span className="field-label">Shot</span>
                  <textarea
                    className="text-area"
                    rows={2}
                    value={selectedLine.shotNote || ''}
                    placeholder="Full body, both heels off the mat. Crop the feet."
                    onChange={(event) => onUpdateShotNote?.(selectedLine.id, event.target.value)}
                  />
                  <span className="connection-summary-detail">
                    Not spoken. This is what the still should show. A crop note stays on this same file.
                  </span>
                </label>
              ) : null}
              {stillCastEnabled ? (
                <div className="still-cast-beats">
                  {(selectedLine.stillBeats || []).length === 0 ? (
                    <div className="still-cast-beat">
                      <div className="still-cast-beat-empty">
                        <ImageIcon size={14} />
                      </div>
                      <div>
                        <label className="field-label" htmlFor={`still-cast-expression-${selectedLine.id}`}>
                          {sequence === 'trailer' ? 'Still source' : 'Expression'}
                        </label>
                        {sequence === 'trailer' ? (
                          <>
                            <select
                              id={`still-cast-expression-${selectedLine.id}`}
                              className="still-cast-beat-expression"
                              value="custom"
                              disabled
                              aria-label="Custom-9x16 still"
                            >
                              <option value="custom">
                                {customStillForSelectedLine
                                  ? `Custom-9x16 · ${customStillForSelectedLine.fileName}`
                                  : `Waiting for ${customFolderLabel} match`}
                              </option>
                            </select>
                            <span>{selectedLine.text}</span>
                          </>
                        ) : (
                          <>
                            <select
                              id={`still-cast-expression-${selectedLine.id}`}
                              className="still-cast-beat-expression"
                              value=""
                              disabled={stillCastBusy || !onChangeStillCastExpression}
                              onChange={(event) => {
                                const value = event.target.value
                                if (value) onChangeStillCastExpression?.(undefined, value)
                              }}
                            >
                              <option value="">Choose an expression folder…</option>
                              {customStillForSelectedLine ? <option value="custom">Custom still</option> : null}
                              {expressionFolders.map((folder) => (
                                <option key={folder.id} value={folder.id} disabled={folder.imagePaths.length === 0}>
                                  {folder.folderName}
                                  {folder.imagePaths.length === 0 ? ' (empty)' : ''}
                                </option>
                              ))}
                            </select>
                            <span>{selectedLine.text}</span>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    expressionPlaybackBeats(selectedLine.stillBeats || [], selectedLine.id).map((beat) => (
                      <div className="still-cast-beat" key={beat.id}>
                        {beat.imagePath && assetSources[beat.imagePath] ? (
                          <img src={assetSources[beat.imagePath]} alt="" loading="lazy" decoding="async" />
                        ) : (
                          <div className="still-cast-beat-empty">
                            <ImageIcon size={14} />
                          </div>
                        )}
                        <div>
                          <label className="field-label" htmlFor={`still-cast-expression-${beat.id}`}>
                            {sequence === 'trailer' ? 'Still source' : 'Expression'}
                          </label>
                          {sequence === 'trailer' ? (
                            <>
                              <select
                                id={`still-cast-expression-${beat.id}`}
                                className="still-cast-beat-expression"
                                value="custom"
                                disabled
                                aria-label="Custom-9x16 still"
                              >
                                <option value="custom">
                                  {customStillForSelectedLine
                                    ? `Custom-9x16 · ${customStillForSelectedLine.fileName}`
                                    : `Waiting for ${customFolderLabel} match`}
                                </option>
                              </select>
                              <span>{beat.text}</span>
                            </>
                          ) : (
                            <>
                              <select
                                id={`still-cast-expression-${beat.id}`}
                                className="still-cast-beat-expression"
                                value={beat.expression}
                                disabled={stillCastBusy || !onChangeStillCastExpression}
                                aria-label="Change expression folder"
                                onChange={(event) => onChangeStillCastExpression?.(beat.id, event.target.value)}
                              >
                                {customStillForSelectedLine || beat.expression === 'custom' ? (
                                  <option value="custom">Custom still</option>
                                ) : null}
                                {expressionFolders.map((folder) => (
                                  <option
                                    key={folder.id}
                                    value={folder.id}
                                    disabled={folder.imagePaths.length === 0 && folder.id !== beat.expression}
                                  >
                                    {folder.folderName}
                                    {folder.imagePaths.length === 0 ? ' (empty)' : ''}
                                  </option>
                                ))}
                                {beat.expression &&
                                beat.expression !== 'custom' &&
                                !expressionFolders.some((folder) => folder.id === beat.expression) ? (
                                  <option value={beat.expression}>
                                    {stillCastExpressionLabel(beat.expression, expressionFolders)}
                                  </option>
                                ) : null}
                              </select>
                              <span>{beat.text}</span>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <>
              <textarea className="text-area prompt-area" value={selectedLine.scenePrompt} onChange={(event) => onUpdatePrompt(event.target.value)} />
              <div className="prompt-refinement">
                <label className="field-label" htmlFor={`prompt-refinement-${selectedLine.id}`}>
                  Prompt refinement
                </label>
                <textarea
                  id={`prompt-refinement-${selectedLine.id}`}
                  className="text-area compact"
                  value={selectedLine.promptRefinement || ''}
                  onChange={(event) => onPromptRefinementChange(event.target.value)}
                  placeholder="Tell ChatGPT what to change while preserving continuity, for example: make the alarm clock the visual focus and keep the cat in the background."
                  disabled={contextPromptsBusy}
                />
                <div className="prompt-refinement-actions">
                  <span>Sent with the paragraph context and this scene’s existing direction.</span>
                  <button
                    className="button button-secondary"
                    onClick={onRegeneratePromptWithRefinement}
                    disabled={contextPromptsBusy || !selectedLine.promptRefinement?.trim()}
                  >
                    {contextPromptsBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                    Regenerate refined prompt
                  </button>
                </div>
              </div>
                </>
              )}
              <div className={`scene-preview-large ${sequence === 'trailer' ? 'vertical-preview' : ''}`}>
                {selectedLine.imagePath && assetSources[selectedLine.imagePath] ? (
                  <button
                    type="button"
                    className="scene-preview-popout-target"
                    onClick={() => onOpenImageInspector?.()}
                    title="Open large inspector (← → to browse)"
                  >
                    <img
                      src={assetSources[selectedLine.imagePath]}
                      alt={`Generated scene for line ${selectedLine.index + 1}`}
                      decoding="async"
                    />
                    <span className="scene-preview-popout-hint">
                      <Maximize2 size={14} />
                      {imageInspectorOpen ? 'Inspector open' : 'Pop out'}
                    </span>
                  </button>
                ) : (
                  <div className="scene-preview-empty">
                    <ImageIcon size={28} />
                    <strong>
                      {hasDirectionPrompt(selectedLine)
                        ? stillCastEnabled
                          ? 'Stills not assigned yet'
                          : 'Image not generated yet'
                        : stillCastEnabled
                          ? 'Cast expressions first'
                          : 'Generate a direction prompt first'}
                    </strong>
                    <span>
                      {stillCastEnabled
                        ? 'Assigned expression stills will appear here.'
                        : 'The finished scene preview will appear here.'}
                    </span>
                  </div>
                )}
              </div>
              <div className="scene-preview-navigation">
                <button
                  className="button button-quiet"
                  onClick={() => previousLine && onSelectLine(previousLine.id)}
                  disabled={!previousLine}
                >
                  <ChevronLeft size={15} />
                  Previous clip
                </button>
                <span>
                  Clip {selectedLinePosition >= 0 ? selectedLinePosition + 1 : '—'} of {visibleLines.length}
                </span>
                <div className="scene-preview-navigation-end">
                  <button
                    className="button button-secondary"
                    onClick={() => onOpenImageInspector?.()}
                    disabled={!selectedLine.imagePath || !onOpenImageInspector}
                    title="Open a monitor-centered image inspector"
                  >
                    <Maximize2 size={15} />
                    {imageInspectorOpen ? 'Focus inspector' : 'Inspect images'}
                  </button>
                  <button
                    className="button button-quiet"
                    onClick={() => nextLine && onSelectLine(nextLine.id)}
                    disabled={!nextLine}
                  >
                    Next clip
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
              <div className="generation-actions">
                <div className="generation-action-group">
                  <div className="generation-action-heading">
                    <div>
                      <span className="eyebrow">
                        {stillCastEnabled
                          ? sequence === 'trailer'
                            ? 'Custom-9x16 stills'
                            : 'Expression stills'
                          : `${imageProviderLabel} images`}
                      </span>
                      <strong>
                        {project.manifest.lines.filter(hasImage).length}/{project.manifest.lines.length}{' '}
                        {stillCastEnabled ? 'lines stocked' : 'images ready'}
                      </strong>
                    </div>
                    <span className={`status-pill ${selectedLine.sceneStatus}`}>
                      {hasImage(selectedLine) ? 'Image ready' : statusLabel(selectedLine.sceneStatus)}
                    </span>
                  </div>
                  <div className="generation-action-row">
                    {stillCastEnabled ? (
                      <>
                        <button
                          className="button button-primary"
                          onClick={onGenerateSelectedImage}
                          disabled={stillCastBusy || imageBatchBusy}
                        >
                          {stillCastBusy ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
                          Assign selected stills
                        </button>
                        {isRegeneratedImage(selectedLine) && onAcceptRegeneratedImage ? (
                          <button
                            className="button button-secondary"
                            onClick={onAcceptRegeneratedImage}
                            disabled={stillCastBusy}
                          >
                            <Check size={15} />
                            Mark regeneration good
                          </button>
                        ) : null}
                        <button
                          className="button button-secondary"
                          onClick={onGenerateAllImages}
                          disabled={stillCastBusy || imageBatchBusy}
                        >
                          <WandSparkles size={15} />
                          Re-roll all stills
                        </button>
                        <button
                          className="button button-quiet"
                          onClick={onGenerateImagesFromHere}
                          disabled={stillCastBusy || imageBatchBusy}
                        >
                          <ArrowDownToLine size={15} />
                          Assign stills from here
                        </button>
                        <button
                          className="button button-quiet"
                          onClick={onGenerateRemainingImages}
                          disabled={stillCastBusy || imageBatchBusy}
                        >
                          <RefreshCw size={15} />
                          Fill missing stills
                        </button>
                      </>
                    ) : imageProviderConfigured ? (
                      <>
                        <button className="button button-primary" onClick={onGenerateSelectedImage} disabled={imageBatchBusy}>
                          {imageBatchBusy ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
                          Generate selected image
                        </button>
                        {selectedLine && isRegeneratedImage(selectedLine) && onAcceptRegeneratedImage ? (
                          <button className="button button-secondary" onClick={onAcceptRegeneratedImage}>
                            <Check size={15} />
                            Mark regeneration good
                          </button>
                        ) : null}
                        <button className="button button-secondary" onClick={onGenerateAllImages} disabled={imageBatchBusy}>
                          <WandSparkles size={15} />
                          Regenerate all images
                        </button>
                        <button className="button button-quiet" onClick={onGenerateImagesFromHere} disabled={imageBatchBusy}>
                          <ArrowDownToLine size={15} />
                          Generate images from here
                        </button>
                        <button className="button button-quiet" onClick={onGenerateRemainingImages} disabled={imageBatchBusy}>
                          <RefreshCw size={15} />
                          Generate remaining images
                        </button>
                      </>
                    ) : (
                      <button className="button button-secondary" onClick={imageGenerator === 'chatgpt' ? onLlmLogin : onConnect}>
                        <Settings2 size={15} />
                        {imageGenerator === 'chatgpt'
                          ? 'Sign in to ChatGPT'
                          : imageGenerator === 'comfyui'
                            ? 'Connect ComfyUI'
                            : 'Connect Higgsfield'}
                      </button>
                    )}
                    {hasActiveImageWork ? (
                      <button className="button button-danger" onClick={onCancelImages} disabled={imageCancelBusy}>
                        {imageCancelBusy ? <LoaderCircle size={15} className="spin" /> : <Square size={14} />}
                        Cancel image generations
                      </button>
                    ) : null}
                    {stillCastEnabled ? null : (
                    <button
                      className={`button button-quiet automatic-generation-toggle ${automaticImageGenerationEnabled ? 'enabled' : 'disabled'}`}
                      onClick={onToggleAutomaticImageGeneration}
                    >
                      <Sparkles size={14} />
                      {automaticImageGenerationEnabled ? 'Automatic generation on' : 'Automatic generation off · Manual mode'}
                    </button>
                    )}
                  </div>
                </div>
                <div className="generation-action-group">
                  <div className="generation-action-heading">
                    <div>
                      <span className="eyebrow">{stillCastEnabled ? (sequence === 'trailer' ? 'Short stills' : 'Expression beats') : 'Scene direction'}</span>
                      <strong>
                        {project.manifest.lines.filter(hasDirectionPrompt).length}/{project.manifest.lines.length}{' '}
                        {stillCastEnabled
                          ? sequence === 'trailer'
                            ? 'lines ready'
                            : 'lines cast'
                          : 'prompts ready'}
                      </strong>
                    </div>
                    <span className={`status-pill ${directionStatusOf(selectedLine)}`}>
                      {directionStatusLabel(selectedLine)}
                    </span>
                  </div>
                  {selectedLine.directionError ? (
                    <div className="direction-error" role="alert">
                      {selectedLine.directionError}
                    </div>
                  ) : null}
                  <div className="generation-action-row">
                    <button className="button button-primary" onClick={onGenerateSelectedPrompt} disabled={contextPromptsBusy}>
                      {contextPromptsBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                      {stillCastEnabled
                        ? sequence === 'trailer'
                          ? 'Assign selected stills'
                          : 'Cast selected line'
                        : 'Generate selected prompt'}
                    </button>
                    <button
                      className="button button-secondary"
                      onClick={contextPromptsBusy ? onCancelContextPrompts : onGenerateAllPrompts}
                      disabled={!contextPromptsBusy && project.manifest.lines.length === 0}
                    >
                      {contextPromptsBusy ? <X size={15} /> : <Sparkles size={15} />}
                      {contextPromptsBusy
                        ? 'Cancel drafting'
                        : stillCastEnabled
                          ? sequence === 'trailer'
                            ? 'Assign all Custom-9x16'
                            : 'Cast all expressions'
                          : 'Regenerate all prompts'}
                    </button>
                    <button className="button button-quiet" onClick={onGeneratePromptsFromHere} disabled={contextPromptsBusy}>
                      <ArrowDownToLine size={15} />
                      {stillCastEnabled
                        ? sequence === 'trailer'
                          ? 'Assign from here'
                          : 'Cast from here'
                        : 'Generate prompts from here'}
                    </button>
                    <button className="button button-quiet" onClick={onGenerateRemainingPrompts} disabled={contextPromptsBusy}>
                      <RefreshCw size={15} />
                      {stillCastEnabled
                        ? sequence === 'trailer'
                          ? 'Fill missing Custom-9x16'
                          : 'Cast remaining lines'
                        : 'Generate remaining prompts'}
                    </button>
                    {!llmStatus?.authenticated ? (
                      <button className="button button-quiet" onClick={onLlmLogin} disabled={contextPromptsBusy}>
                        <Settings2 size={15} />
                        Sign in if needed
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="prompt-footer">
                <div className="model-summary">
                  <span><Sparkles size={14} /> {imageModelLabel}</span>
                  <span>{sequence === 'trailer' ? '9:16' : '16:9'} · 1K</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-panel scene-empty">
              <ImageIcon size={22} />
              <strong>Import a script to create scenes.</strong>
              <span>Each narration line will receive an editable prompt and visual approval state.</span>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function PinnedTimeline({
  project,
  activeLineId,
  assetSources,
  locked,
  imageFilter,
  regeneratedCount,
  onImageFilterChange,
  onSelectLine,
  onCopyImage,
  onAcceptRegeneratedImage,
}: {
  project: ProjectState
  activeLineId: string | null
  assetSources: Record<string, string>
  locked: boolean
  imageFilter: TimelineImageFilter
  regeneratedCount: number
  onImageFilterChange: (filter: TimelineImageFilter) => void
  onSelectLine: (id: string) => void
  onCopyImage: (line: ScriptLine) => void
  onAcceptRegeneratedImage: (line: ScriptLine) => void
}) {
  const lines = filterLinesForTimeline(project.manifest.lines, imageFilter)
  const totalDuration = lines.reduce((sum, line) => sum + line.duration, 0)
  const regeneratedActive = imageFilter === 'regenerated'

  return (
    <section className="pinned-timeline" aria-label="Pinned voice and visual timeline">
      <div className="pinned-timeline-header">
        <div className="pinned-timeline-title">
          <span className="eyebrow">Pinned timeline</span>
          <strong>
            {lines.length
              ? regeneratedActive
                ? `${lines.length} regenerated ${lines.length === 1 ? 'image' : 'images'} · ${formatTime(totalDuration)}`
                : `${project.manifest.lines.length} voice lines · ${formatTime(project.manifest.lines.reduce((sum, line) => sum + line.duration, 0))}`
              : regeneratedActive
                ? 'No regenerated images'
                : 'Waiting for a script'}
          </strong>
        </div>
        <div className="pinned-timeline-legend">
          <span><i className="legend-dot voice-dot" /> Voice + scene clips</span>
          <button
            type="button"
            className={`timeline-filter-toggle ${regeneratedActive ? 'active' : ''}`}
            aria-pressed={regeneratedActive}
            onClick={() => onImageFilterChange(regeneratedActive ? 'all' : 'regenerated')}
          >
            <Filter size={12} />
            Regenerated{regeneratedCount ? ` · ${regeneratedCount}` : ''}
          </button>
          <span className="pinned-timeline-hint">
            {regeneratedActive ? 'Mark good or generate selected again' : 'Select a clip to inspect it'}
          </span>
        </div>
      </div>

      {lines.length ? (
        <div className="pinned-timeline-lane">
          {lines.map((line) => (
            <div
              key={`pinned-clip-${line.id}`}
              className={`pinned-clip-shell ${isRegeneratedImage(line) ? 'regenerated' : ''}`}
              data-timeline-line={line.id}
              style={{ flex: `${Math.max(line.duration / Math.max(totalDuration, 0.1), 0.02)} 1 0` }}
            >
              <button
                className={`pinned-clip ${line.id === activeLineId ? 'selected' : ''} ${line.sceneStatus === 'complete' ? 'ready' : ''} ${isRegeneratedImage(line) ? 'regenerated' : ''}`}
                disabled={locked && line.id !== activeLineId}
                onClick={() => onSelectLine(line.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onSelectLine(line.id)
                  onCopyImage(line)
                }}
                title={line.text}
              >
                <div className="pinned-clip-preview">
                  {line.imagePath && assetSources[line.imagePath] ? (
                    <img src={assetSources[line.imagePath]} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <ImageIcon size={18} />
                  )}
                  {isRegeneratedImage(line) ? (
                    <span className="pinned-clip-tag">REGEN</span>
                  ) : null}
                  <span className="pinned-clip-status">
                    {line.sceneStatus === 'complete' ? 'SCENE READY' : 'AWAITING SCENE'}
                  </span>
                </div>
                <div className="pinned-clip-footer">
                  <span className="pinned-clip-index">{String(line.index + 1).padStart(2, '0')}</span>
                  <span className="pinned-clip-copy">{line.text}</span>
                  <small>{formatTime(line.duration)}</small>
                </div>
              </button>
              {isRegeneratedImage(line) ? (
                <button
                  type="button"
                  className="pinned-clip-accept"
                  disabled={locked}
                  onClick={() => onAcceptRegeneratedImage(line)}
                >
                  <Check size={12} />
                  Good
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="pinned-timeline-empty">
          <Clapperboard size={14} />
          <span>
            {regeneratedActive
              ? 'Generate a selected image to add it to this regenerated review list.'
              : 'Import or paste a script to populate the pinned timeline.'}
          </span>
        </div>
      )}
    </section>
  )
}

function TimelineWorkspace({
  project,
  activeLineId,
  assetSources,
  imageFilter,
  regeneratedCount,
  onImageFilterChange,
  onSelectLine,
  onCopyImage,
  onAcceptRegeneratedImage,
}: {
  project: ProjectState
  activeLineId: string | null
  assetSources: Record<string, string>
  imageFilter: TimelineImageFilter
  regeneratedCount: number
  onImageFilterChange: (filter: TimelineImageFilter) => void
  onSelectLine: (id: string) => void
  onCopyImage: (line: ScriptLine) => void
  onAcceptRegeneratedImage: (line: ScriptLine) => void
}) {
  const lines = filterLinesForTimeline(project.manifest.lines, imageFilter)
  const totalDuration = lines.reduce((sum, line) => sum + line.duration, 0)
  const regeneratedActive = imageFilter === 'regenerated'
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">04 · Timeline</div>
          <h1>See the cut take shape.</h1>
          <p>Voice is the timing spine. Visuals, music, and graphics will layer on top of it.</p>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className={`timeline-filter-toggle ${regeneratedActive ? 'active' : ''}`}
            aria-pressed={regeneratedActive}
            onClick={() => onImageFilterChange(regeneratedActive ? 'all' : 'regenerated')}
          >
            <Filter size={13} />
            Regenerated{regeneratedCount ? ` · ${regeneratedCount}` : ''}
          </button>
          <span className="runtime-chip"><Play size={13} /> {formatTime(totalDuration)} runtime</span>
        </div>
      </div>
      <section className="panel timeline-panel">
        <div className="timeline-toolbar">
          <div className="timeline-legend">
            <span><i className="legend-dot voice-dot" /> Voice</span>
            <span><i className="legend-dot visual-dot" /> Visuals</span>
            <span><i className="legend-dot music-dot" /> Music & SFX</span>
          </div>
          <span className="subtle-label">
            {regeneratedActive
              ? 'Review regenerated images · mark good or generate selected again'
              : 'Click a clip to inspect it · right-click a visual clip to copy its image'}
          </span>
        </div>
        {lines.length === 0 ? (
          <div className="empty-panel timeline-empty">
            <Clapperboard size={22} />
            <strong>{regeneratedActive ? 'No regenerated images to review.' : 'Your timeline is empty.'}</strong>
            <span>
              {regeneratedActive
                ? 'Use Generate selected image on Visuals to tag a clip for this filter.'
                : 'Import a script and record your first line to establish the edit.'}
            </span>
          </div>
        ) : (
          <div className="timeline-canvas">
            <div className="timeline-ruler">
              <span>00:00</span>
              <span>{formatTime(totalDuration / 2)}</span>
              <span>{formatTime(totalDuration)}</span>
            </div>
            <TimelineTrack label="VOICE" className="voice-track">
              {lines.map((line) => (
                <TimelineClip
                  key={line.id}
                  line={line}
                  totalDuration={totalDuration}
                  selected={line.id === activeLineId}
                  onClick={() => onSelectLine(line.id)}
                  type="voice"
                />
              ))}
            </TimelineTrack>
            <TimelineTrack label="VISUALS" className="visual-track">
              {lines.map((line) => (
                <TimelineClip
                  key={line.id}
                  line={line}
                  totalDuration={totalDuration}
                  selected={line.id === activeLineId}
                  onClick={() => onSelectLine(line.id)}
                  type="visual"
                  imageSource={line.imagePath ? assetSources[line.imagePath] : undefined}
                  onContextMenu={() => {
                    onSelectLine(line.id)
                    onCopyImage(line)
                  }}
                  onAcceptRegeneratedImage={
                    isRegeneratedImage(line) ? () => onAcceptRegeneratedImage(line) : undefined
                  }
                />
              ))}
            </TimelineTrack>
            <TimelineTrack label="MUSIC + SFX" className="music-track">
              <div className="empty-track-message"><Music2 size={14} /> Add a licensed music bed in the next pass</div>
            </TimelineTrack>
          </div>
        )}
      </section>
    </>
  )
}

function TimelineTrack({
  label,
  className,
  children,
}: {
  label: string
  className: string
  children: ReactNode
}) {
  return (
    <div className={`timeline-track ${className}`}>
      <div className="track-label">{label}</div>
      <div className="track-content">{children}</div>
    </div>
  )
}

function TimelineClip({
  line,
  totalDuration,
  selected,
  onClick,
  type,
  imageSource,
  onContextMenu,
  onAcceptRegeneratedImage,
}: {
  line: ScriptLine
  totalDuration: number
  selected: boolean
  onClick: () => void
  type: 'voice' | 'visual'
  imageSource?: string
  onContextMenu?: () => void
  onAcceptRegeneratedImage?: () => void
}) {
  return (
    <div
      className={`timeline-clip-wrap ${type} ${selected ? 'selected' : ''} ${line.sceneStatus === 'complete' ? 'ready' : ''} ${isRegeneratedImage(line) ? 'regenerated' : ''}`}
      data-timeline-line={type === 'visual' ? line.id : undefined}
      style={{ flex: `${Math.max(line.duration / Math.max(totalDuration, 0.1), 0.02)} 1 0` }}
    >
      <button
        className={`timeline-clip ${type} ${selected ? 'selected' : ''} ${line.sceneStatus === 'complete' ? 'ready' : ''}`}
        onClick={onClick}
        onContextMenu={(event) => {
          if (!onContextMenu) return
          event.preventDefault()
          onContextMenu()
        }}
        title={line.text}
      >
        {type === 'visual' && imageSource ? (
          <img src={imageSource} alt="" loading="lazy" decoding="async" />
        ) : null}
        <span className="timeline-clip-index">{String(line.index + 1).padStart(2, '0')}</span>
        <span className="timeline-clip-text">
          {type === 'voice'
            ? line.text
            : isRegeneratedImage(line)
              ? 'Regenerated'
              : line.sceneStatus === 'complete'
                ? 'Visual ready'
                : 'Awaiting visual'}
        </span>
        <small>{formatTime(line.duration)}</small>
      </button>
      {type === 'visual' && onAcceptRegeneratedImage ? (
        <button
          type="button"
          className="timeline-clip-accept"
          onClick={(event) => {
            event.stopPropagation()
            onAcceptRegeneratedImage()
          }}
        >
          <Check size={12} />
          Good
        </button>
      ) : null}
    </div>
  )
}

function ExportWorkspace({
  project,
  sequence,
  recordedCount,
  visualCount,
  totalDuration,
  exporting,
  onExport,
}: {
  project: ProjectState
  sequence: SequenceId
  recordedCount: number
  visualCount: number
  totalDuration: number
  exporting: boolean
  onExport: () => void
}) {
  const lineCount = project.manifest.lines.length
  const checks = [
    { label: 'Script imported', detail: `${lineCount} narration lines`, done: lineCount > 0 },
    { label: 'Voice recorded', detail: `${recordedCount}/${lineCount} takes ready`, done: recordedCount === lineCount && lineCount > 0 },
    { label: 'Visuals approved', detail: `${visualCount}/${lineCount} images ready`, done: visualCount === lineCount && lineCount > 0 },
    { label: 'Timeline assembled', detail: `${formatTime(totalDuration)} estimated runtime`, done: lineCount > 0 },
  ]

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{sequence === 'trailer' ? 'CONDENSED · 9:16 EXPORT' : '05 · Export'}</div>
          <h1>{sequence === 'trailer' ? 'Export the vertical cut.' : 'Make the first cut.'}</h1>
          <p>Higgsfilm will hold each visual for its voice line, then apply dialogue-first mastering.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-primary button-large" onClick={onExport} disabled={exporting || visualCount === 0}>
            {exporting ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
            {exporting ? 'Rendering MP4' : `Export ${sequence === 'trailer' ? '9:16' : 'longform'} MP4`}
          </button>
        </div>
      </div>

      <div className="export-grid">
        <section className="panel export-preview">
          <div className="export-frame">
            <div className="export-frame-grid" />
            <div className="export-frame-copy">
              <span className="eyebrow">HIGGSFILM FIRST CUT</span>
              <strong>{project.manifest.name}</strong>
              <span>
                {formatTime(totalDuration)} · {formatExportCanvas(project.manifest.exportSettings)}
              </span>
            </div>
          </div>
          <div className="export-caption">
            <div>
              <div className="eyebrow">Mastering preset</div>
              <h2>Dialogue studio / YouTube 4K</h2>
            </div>
            <span className="lufs-chip">-16 LUFS</span>
          </div>
          <p className="panel-intro">Scene clips and the mastered cut are pre-rendered in the background. When that cache is warm, export is a file save. Output is 4K with a dialogue studio master: per-scene level match, cleanup, EQ, compression, two-pass loudness to -16 LUFS / -1.5 dB TP, then AAC 384 kbps.</p>
        </section>

        <section className="panel export-checklist">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Preflight</div>
              <h2>Ready to render?</h2>
            </div>
            <span className="eyebrow">{checks.filter((check) => check.done).length}/{checks.length}</span>
          </div>
          <div className="checklist">
            {checks.map((check) => (
              <div className={`check-row ${check.done ? 'done' : ''}`} key={check.label}>
                <span className="check-icon">{check.done ? <Check size={14} /> : <span />}</span>
                <span><strong>{check.label}</strong><small>{check.detail}</small></span>
              </div>
            ))}
          </div>
          <div className="export-note">
            <AlertCircle size={15} />
            <span>Images are required. Voice is optional for a silent storyboard preview, but recorded takes are recommended for final timing.</span>
          </div>
        </section>
      </div>
    </>
  )
}

function SettingsModal({
  status,
  comfyStatus,
  settings,
  projectAvailable,
  projectVisualBible,
  channelProfiles,
  activeChannelProfileId,
  channelProfileBusy,
  channelBriefBusy,
  qwenStatus,
  qwenReferenceBusy,
  qwenBusy,
  llmStatus,
  llmBusy,
  comfyBusy,
  busy,
  onLogin,
  onRefresh,
  onImageGeneratorChange,
  onChannelProfileApply,
  onChannelProfileSave,
  onChannelProfileRemove,
  onChooseChannelFolder,
  onChannelContextSave,
  onRefreshChannelBrief,
  stillCastLibrary,
  onProductionModeChange,
  onPrepareStillLibrary,
  onChooseScriptBible,
  onChooseIdeaGuide,
  onChooseQwenReference,
  onSaveQwenReferenceText,
  onRealignQwen,
  onComfySettingsSave,
  onComfyRefresh,
  onLlmLogin,
  onLlmRefresh,
  onLlmStepChange,
  onClose,
}: {
  status: HiggsConnectionStatus | null
  comfyStatus: ComfyConnectionStatus | null
  settings: StudioSettings
  projectAvailable: boolean
  projectVisualBible?: VisualBible
  channelProfiles: ChannelImageProfile[]
  activeChannelProfileId: string
  channelProfileBusy: boolean
  channelBriefBusy: boolean
  qwenStatus: QwenTtsStatus | null
  qwenReferenceBusy: boolean
  qwenBusy: boolean
  llmStatus: LlmConnectionStatus | null
  llmBusy: boolean
  comfyBusy: boolean
  busy: boolean
  onLogin: () => void
  onRefresh: () => void
  onImageGeneratorChange: (imageGenerator: ImageGenerator) => void
  onChannelProfileApply: (id: string) => void
  onChannelProfileSave: (name: string) => void
  onChannelProfileRemove: (id: string) => void
  onChooseChannelFolder: () => void
  onChannelContextSave: (patch: {
    niche?: string
    youtubeHandle?: string
  }) => void
  onRefreshChannelBrief: (handle?: string) => void
  stillCastLibrary: StillCastLibraryScan | null
  onProductionModeChange: (mode: ChannelProductionMode) => void
  onPrepareStillLibrary: () => void
  onChooseScriptBible: () => void
  onChooseIdeaGuide: () => void
  onChooseQwenReference: () => void
  onSaveQwenReferenceText: (text: string) => void
  onRealignQwen: () => void
  onComfySettingsSave: (settings: ComfyUiSettings) => void
  onComfyRefresh: () => void
  onLlmLogin: () => void
  onLlmRefresh: () => void
  onLlmStepChange: (step: LlmStep, patch: Partial<LlmStepSetting>) => void
  onClose: () => void
}) {
  const [comfyDraft, setComfyDraft] = useState<ComfyUiSettings>(
    normalizeComfyUiSettings(settings.comfy || DEFAULT_COMFY_UI_SETTINGS),
  )
  const [qwenReferenceText, setQwenReferenceText] = useState(qwenStatus?.referenceText || '')
  const activeChannelProfile = channelProfiles.find((profile) => profile.id === activeChannelProfileId)
  const [nicheDraft, setNicheDraft] = useState(activeChannelProfile?.niche || '')
  const [handleDraft, setHandleDraft] = useState(activeChannelProfile?.youtubeHandle || '')
  const channelProfileCurrent = activeChannelProfile
    ? channelProfileMatchesCurrent(activeChannelProfile, settings, projectVisualBible)
    : true
  const contextBusy = channelProfileBusy || channelBriefBusy

  useEffect(() => {
    setComfyDraft(normalizeComfyUiSettings(settings.comfy || DEFAULT_COMFY_UI_SETTINGS))
  }, [settings.comfy])

  useEffect(() => {
    setQwenReferenceText(qwenStatus?.referenceText || '')
  }, [qwenStatus?.referenceText])

  useEffect(() => {
    setNicheDraft(activeChannelProfile?.niche || '')
    setHandleDraft(activeChannelProfile?.youtubeHandle || '')
  }, [activeChannelProfile?.id, activeChannelProfile?.niche, activeChannelProfile?.youtubeHandle])

  function patchComfyDraft(patch: Partial<ComfyUiSettings>): void {
    setComfyDraft((current) => normalizeComfyUiSettings({ ...current, ...patch }))
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-header">
          <div>
            <div className="eyebrow">Settings</div>
            <h2 id="settings-title">Channel, images & connections</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </div>
        <p className="modal-intro">
          Choose a channel folder on disk. Episode projects and the Expressions folder live inside it. Selecting a project opens inside that channel folder.
        </p>
        <div className="settings-section channel-profile-section">
          <div className="eyebrow">YouTube channel</div>
          <span className="field-label">Active channel</span>
          {channelProfiles.length > 0 ? (
            <div className="channel-profile-list" role="listbox" aria-label="YouTube channel profiles">
              {channelProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={`channel-profile-chip ${profile.id === activeChannelProfileId ? 'selected' : ''}`}
                  aria-pressed={profile.id === activeChannelProfileId}
                  disabled={channelProfileBusy}
                  onClick={() => onChannelProfileApply(profile.id)}
                >
                  {profile.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="settings-selection-note">No channel folders yet. Choose a folder like DoggoBux\BuxFit.</div>
          )}
          <div className="settings-inline-field">
            <span className="connection-summary-detail">
              {activeChannelProfile?.channelFolderPath || 'No channel folder selected yet.'}
            </span>
            <button
              className="button button-secondary"
              onClick={onChooseChannelFolder}
              disabled={channelProfileBusy}
            >
              {channelProfileBusy ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}
              Choose channel folder
            </button>
            <button
              className="button button-quiet"
              onClick={() => onChannelProfileRemove(activeChannelProfileId)}
              disabled={!activeChannelProfileId || channelProfileBusy}
              aria-label="Delete channel profile"
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
          {activeChannelProfile ? (
            <div className="settings-selection-note">
              {imageProviderLabel(activeChannelProfile.imageGenerator)}
              {activeChannelProfile.imageGenerator === 'comfyui'
                ? ` · ${activeChannelProfile.comfy.diffusionModel}`
                : ''}
              {activeChannelProfile.visualBible.name ? ` · ${activeChannelProfile.visualBible.name}` : ''}
              {channelProfileCurrent ? '' : ' · current setup differs from this profile'}
              {' · '}Projects and Expressions live in this folder.
            </div>
          ) : (
            <div className="settings-selection-note">
              Pick the channel folder first. Then choose an episode project folder inside it.
            </div>
          )}
          {activeChannelProfile ? (
            <>
              <div className="eyebrow">Channel niche</div>
              <label className="field-label" htmlFor="channel-niche-input">
                Overall topic
              </label>
              <input
                id="channel-niche-input"
                className="text-input"
                value={nicheDraft}
                onChange={(event) => setNicheDraft(event.target.value)}
                onBlur={() => {
                  if (nicheDraft.trim() !== (activeChannelProfile.niche || '').trim()) {
                    onChannelContextSave({ niche: nicheDraft })
                  }
                }}
                placeholder='Example: Personal Fitness'
                disabled={contextBusy}
              />
              <label className="field-label" htmlFor="channel-handle-input">
                YouTube handle
              </label>
              <div className="settings-inline-field">
                <input
                  id="channel-handle-input"
                  className="text-input"
                  value={handleDraft}
                  onChange={(event) => setHandleDraft(event.target.value)}
                  onBlur={() => {
                    const normalized = normalizeYoutubeChannelHandle(handleDraft)
                    setHandleDraft(normalized)
                    if (normalized !== (activeChannelProfile.youtubeHandle || '')) {
                      onChannelContextSave({ youtubeHandle: normalized })
                    }
                  }}
                  placeholder="@YourChannel"
                  disabled={contextBusy}
                />
                <button
                  className="button button-quiet"
                  onClick={() => onRefreshChannelBrief(handleDraft)}
                  disabled={contextBusy}
                >
                  {channelBriefBusy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  Refresh brief
                </button>
              </div>
              <div className="settings-selection-note">
                {activeChannelProfile.channelBrief
                  ? `Channel brief cached${
                      activeChannelProfile.channelBriefUpdatedAt
                        ? ` · ${new Date(activeChannelProfile.channelBriefUpdatedAt).toLocaleString()}`
                        : ''
                    }. Used by Video idea as identity context, not demand proof.`
                  : 'Optional. Refresh pulls recent uploads so Video idea knows your formats.'}
              </div>
              <div className="settings-inline-field">
                <button
                  className="button button-quiet"
                  onClick={() => onChannelProfileSave(activeChannelProfile.name)}
                  disabled={channelProfileBusy}
                >
                  {channelProfileBusy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
                  Save channel settings
                </button>
              </div>
            </>
          ) : null}
          <div className="eyebrow">Idea guide</div>
          <div className="settings-inline-field">
            <span className="connection-summary-detail">
              {activeChannelProfile?.ideaGuidePath || 'Built-in default guide (no file loaded).'}
            </span>
            <button
              className="button button-quiet"
              onClick={onChooseIdeaGuide}
              disabled={!activeChannelProfile || channelProfileBusy}
            >
              <FolderOpen size={15} />
              Load file
            </button>
          </div>
          <div className="settings-selection-note">
            Steers the Video idea coach. Start from DoggoBux\BuxFit\Video Idea - Idea Guide.md and edit as needed.
          </div>
          <div className="eyebrow">Script bible</div>
          <div className="settings-inline-field">
            <span className="connection-summary-detail">
              {activeChannelProfile?.scriptBiblePath || 'No script bible loaded yet.'}
            </span>
            <button
              className="button button-quiet"
              onClick={onChooseScriptBible}
              disabled={!activeChannelProfile || channelProfileBusy}
            >
              <FolderOpen size={15} />
              Load file
            </button>
          </div>
          <div className="settings-selection-note">
            The script creator sends this file to ChatGPT with your topic so the draft matches the channel’s format.
          </div>
          <div className="eyebrow">Channel visuals</div>
          <div className="provider-options">
            <button
              className={`provider-option ${activeChannelProfile?.productionMode !== 'still-cast' ? 'selected' : ''}`}
              onClick={() => onProductionModeChange('generate')}
              disabled={!activeChannelProfile || channelProfileBusy}
            >
              <span className="provider-option-topline">
                <strong>Generate images</strong>
                <span className="provider-option-radio" />
              </span>
              <small>ComfyUI, ChatGPT, or Higgsfield draws each scene.</small>
            </button>
            <button
              className={`provider-option ${activeChannelProfile?.productionMode === 'still-cast' ? 'selected' : ''}`}
              onClick={() => onProductionModeChange('still-cast')}
              disabled={!activeChannelProfile || channelProfileBusy}
            >
              <span className="provider-option-topline">
                <strong>Expression stills</strong>
                <span className="provider-option-radio" />
              </span>
              <small>Prefix almost every line with Custom:. A folder name like Warm Smile: is only for a reaction line that has nothing to draw. Custom images are named after the spoken line.</small>
            </button>
          </div>
          {activeChannelProfile?.productionMode === 'still-cast' ? (
            <>
              <div className="settings-inline-field">
                <span className="connection-summary-detail">
                  {stillCastLibrary?.libraryPath ||
                    activeChannelProfile.stillLibraryPath ||
                    (activeChannelProfile.channelFolderPath
                      ? `${activeChannelProfile.channelFolderPath}\\Expressions`
                      : 'Expressions lives in the channel folder.')}
                </span>
                <button
                  className="button button-quiet"
                  onClick={onPrepareStillLibrary}
                  disabled={
                    channelProfileBusy ||
                    !(
                      stillCastLibrary?.libraryPath ||
                      activeChannelProfile.stillLibraryPath ||
                      activeChannelProfile.channelFolderPath
                    )
                  }
                >
                  Refresh folders
                </button>
              </div>
              <div className="settings-selection-note">
                {stillCastLibrary
                  ? `${stillCastLibrary.folders.filter((folder) => folder.imagePaths.length > 0).length} folders with stills: ${stillCastLibrary.folders
                      .filter((folder) => folder.imagePaths.length > 0)
                      .map((folder) => folder.folderName)
                      .join(', ')}.`
                  : 'Expression stills: channel folder / Expressions. Custom stills: project folder / Custom. 9:16 shorts: project folder / Custom-9x16. Project picker opens inside the channel folder.'}
              </div>
            </>
          ) : null}
        </div>
        <div className="settings-section">
          <div className="eyebrow">Image generator</div>
          <div className="provider-options">
            <button
              className={`provider-option ${settings.imageGenerator === 'higgsfield' ? 'selected' : ''}`}
              onClick={() => onImageGeneratorChange('higgsfield')}
            >
              <span className="provider-option-topline">
                <strong>Higgsfield</strong>
                <span className="provider-option-radio" />
              </span>
              <small>CLI OAuth and Higgsfield account credits.</small>
            </button>
            <button
              className={`provider-option ${settings.imageGenerator === 'chatgpt' ? 'selected' : ''}`}
              onClick={() => onImageGeneratorChange('chatgpt')}
            >
              <span className="provider-option-topline">
                <strong>ChatGPT</strong>
                <span className="provider-option-radio" />
              </span>
              <small>Codex OAuth and ChatGPT native image generation.</small>
            </button>
            <button
              className={`provider-option ${settings.imageGenerator === 'comfyui' ? 'selected' : ''}`}
              onClick={() => onImageGeneratorChange('comfyui')}
            >
              <span className="provider-option-topline">
                <strong>ComfyUI</strong>
                <span className="provider-option-radio" />
              </span>
              <small>Local Flux.2/Klein generation through a running ComfyUI server.</small>
            </button>
          </div>
          <div className="settings-selection-note">
            Active provider: <strong>{imageProviderLabel(settings.imageGenerator)}</strong>. Existing queued jobs finish with their assigned provider.
          </div>
        </div>
        <div className="connection-summary connection-summary-qwen">
          <div className="eyebrow">QWEN paragraph voice</div>
          <div className="connection-summary-row">
            <span className={`status-dot ${qwenStatus?.configured ? 'success-dot' : ''}`} />
            <strong>{qwenStatus?.configured ? 'Voice reference ready' : 'Voice reference needs setup'}</strong>
          </div>
          <div className="connection-summary-detail">
            QWEN3-TTS reads each complete paragraph through the existing ComfyUI connection, then Higgsfilm splits the audio across its individual timeline lines.
          </div>
          <div className="connection-summary-detail">
            Whisper alignment:{' '}
            <strong>
              {qwenStatus?.alignment?.configured
                ? `ready (${qwenStatus.alignment.model})`
                : 'needs setup'}
            </strong>
            {qwenStatus?.alignment?.message ? ` · ${qwenStatus.alignment.message}` : ''}
          </div>
          {qwenStatus?.alignment?.runtime ? (
            <div className="connection-summary-detail">
              Runtime: {qwenStatus.alignment.runtime} · Model: {qwenStatus.alignment.model}
            </div>
          ) : null}
          <div className="settings-inline-field">
            <span className="connection-summary-detail">
              {qwenStatus?.referenceName
                ? `${qwenStatus.referenceName}${qwenStatus.referenceBytes ? ` · ${(qwenStatus.referenceBytes / 1024 / 1024).toFixed(1)} MB` : ''}`
                : 'No reference audio selected.'}
            </span>
            <button
              className="button button-quiet"
              onClick={onChooseQwenReference}
              disabled={!projectAvailable || qwenReferenceBusy}
            >
              {qwenReferenceBusy ? <LoaderCircle size={15} className="spin" /> : <FileAudio size={15} />}
              {qwenStatus?.referenceName ? 'Replace reference' : 'Choose reference'}
            </button>
          </div>
          <label className="field-group">
            <span className="field-label">Exact reference transcript</span>
            <textarea
              className="text-area compact"
              value={qwenReferenceText}
              onChange={(event) => setQwenReferenceText(event.target.value)}
              placeholder="Type exactly what is spoken in the reference audio."
              disabled={!projectAvailable || qwenReferenceBusy}
            />
          </label>
          <div className="settings-connection-actions">
            <button
              className="button button-secondary"
              onClick={() => onSaveQwenReferenceText(qwenReferenceText)}
              disabled={!projectAvailable || qwenReferenceBusy || !qwenReferenceText.trim()}
            >
              {qwenReferenceBusy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
              Save transcript
            </button>
            <button
              className="button button-quiet"
              onClick={onRealignQwen}
              disabled={!projectAvailable || qwenBusy || !qwenStatus?.alignment?.configured}
            >
              {qwenBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              Re-align saved audio
            </button>
          </div>
          <div className="connection-summary-detail">
            Model: {qwenStatus?.model || 'Qwen/Qwen3-TTS-12Hz-1.7B-Base'} · ComfyUI: {qwenStatus?.comfyUrl || 'configured image server'}
          </div>
        </div>
        <div className="connection-summary">
          <div className="eyebrow">Higgsfield connection</div>
          <div className="connection-summary-row">
            <span className={`status-dot ${status?.configured ? 'success-dot' : ''}`} />
            <strong>
              {status?.configured
                ? 'Connected through Higgsfield CLI OAuth'
                : status?.installed
                  ? 'Higgsfield CLI installed, account not connected'
                  : 'Higgsfield CLI not found'}
            </strong>
          </div>
          {status?.email ? <div className="connection-summary-detail">{status.email}</div> : null}
          {status?.plan ? <div className="connection-summary-detail">Plan: {status.plan}</div> : null}
          {typeof status?.credits === 'number' ? (
            <div className="connection-summary-detail">Available credits: {status.credits}</div>
          ) : null}
          <div className="connection-summary-detail">{status?.message || 'Check the CLI connection status to begin.'}</div>
        </div>
        <div className="connection-summary connection-summary-chatgpt">
          <div className="eyebrow">ChatGPT connection</div>
          <div className="connection-summary-row">
            <span className={`status-dot ${llmStatus?.authenticated ? 'success-dot' : ''}`} />
            <strong>{llmStatus?.authenticated ? 'Connected through Codex OAuth' : 'ChatGPT not connected'}</strong>
          </div>
          <div className="connection-summary-detail">
            {llmStatus?.message || 'Sign in with ChatGPT to enable Codex image generation.'}
          </div>
          <div className="settings-connection-actions">
            <button className="button button-quiet" onClick={onLlmRefresh} disabled={llmBusy}>
              {llmBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              Refresh status
            </button>
            {!llmStatus?.authenticated ? (
              <button className="button button-secondary" onClick={onLlmLogin} disabled={llmBusy}>
                <Sparkles size={15} />
                Sign in with ChatGPT
              </button>
            ) : null}
          </div>
          <div className="llm-step-settings">
            <div className="llm-step-row llm-step-header">
              <span>Step</span>
              <span>Model</span>
              <span>Reasoning</span>
              <span>Priority</span>
            </div>
            {LLM_STEPS.map((step) => {
              const setting = settings.llmSteps[step]
              return (
                <div className="llm-step-row" key={step}>
                  <span className="llm-step-name">{LLM_STEP_LABELS[step]}</span>
                  <select
                    className="select-input"
                    aria-label={`${LLM_STEP_LABELS[step]} model`}
                    value={setting.model}
                    disabled={llmBusy}
                    onChange={(event) =>
                      onLlmStepChange(step, { model: event.target.value as LlmModel })
                    }
                  >
                    {LLM_MODELS.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {LLM_MODEL_LABELS[modelId]}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select-input"
                    aria-label={`${LLM_STEP_LABELS[step]} reasoning`}
                    value={setting.reasoningEffort}
                    disabled={llmBusy}
                    onChange={(event) =>
                      onLlmStepChange(step, {
                        reasoningEffort: event.target.value as LlmReasoningEffort,
                      })
                    }
                  >
                    {LLM_REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort === 'low'
                          ? 'Low'
                          : effort === 'max'
                            ? 'Max'
                            : effort[0].toUpperCase() + effort.slice(1)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select-input"
                    aria-label={`${LLM_STEP_LABELS[step]} priority`}
                    value={setting.serviceTier}
                    disabled={llmBusy}
                    onChange={(event) =>
                      onLlmStepChange(step, { serviceTier: event.target.value as LlmServiceTier })
                    }
                  >
                    {LLM_SERVICE_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        {tier === 'fast' ? 'Fast' : 'Standard'}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
            <span className="connection-summary-detail">
              Astra is the quality model for ideas, scripts, and trailers. Luna is the faster model
              for casting, scene direction, summaries, and image setup. Fast uses Codex priority
              and may consume more usage. Image generation still draws with the image tool; this
              row only chooses the model that calls it.
            </span>
          </div>
        </div>
        <div className="connection-summary connection-summary-comfyui">
          <div className="eyebrow">ComfyUI connection</div>
          <div className="connection-summary-row">
            <span className={`status-dot ${comfyStatus?.reachable ? 'success-dot' : ''}`} />
            <strong>{comfyStatus?.reachable ? 'ComfyUI is reachable' : 'ComfyUI is not reachable'}</strong>
          </div>
          <div className="connection-summary-detail">
            {comfyStatus?.message || 'Start ComfyUI locally, then connect using its HTTP address.'}
          </div>
          <div className="connection-summary-detail">
            For lower desktop lag, keep the text encoder on CPU and start ComfyUI with
            <code>start-comfyui.bat</code> from the Higgsfilm folder.
          </div>
          <div className="field-group">
            <span className="field-label">Server URL</span>
            <div className="settings-inline-field">
              <input
                className="text-input"
                value={comfyDraft.baseUrl}
                onChange={(event) => patchComfyDraft({ baseUrl: event.target.value })}
                placeholder="http://127.0.0.1:8188"
              />
              <button
                className="button button-quiet"
                onClick={() => onComfySettingsSave(comfyDraft)}
                disabled={comfyBusy}
              >
                {comfyBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
                Connect
              </button>
            </div>
          </div>
          <div className="field-group">
            <span className="field-label">Diffusion model</span>
            <select
              className="select-input"
              value={comfyDraft.diffusionModel}
              onChange={(event) => patchComfyDraft({ diffusionModel: event.target.value })}
            >
              {!comfyStatus?.models.length ? (
                <option value={comfyDraft.diffusionModel}>{comfyDraft.diffusionModel}</option>
              ) : null}
              {comfyStatus?.models.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>
          <div className="settings-grid-two">
            <label className="field-group">
              <span className="field-label">Steps</span>
              <input
                className="text-input"
                type="number"
                min={1}
                max={100}
                value={comfyDraft.steps}
                onChange={(event) => patchComfyDraft({ steps: Number(event.target.value) })}
              />
            </label>
            <label className="field-group">
              <span className="field-label">Guidance</span>
              <input
                className="text-input"
                type="number"
                min={0}
                max={30}
                step={0.5}
                value={comfyDraft.guidance}
                onChange={(event) => patchComfyDraft({ guidance: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="settings-grid-two">
            <label className="field-group">
              <span className="field-label">Sampler</span>
              <select
                className="select-input"
                value={comfyDraft.sampler}
                onChange={(event) => patchComfyDraft({ sampler: event.target.value })}
              >
                {COMFY_SAMPLERS.map((sampler) => <option key={sampler} value={sampler}>{sampler}</option>)}
              </select>
            </label>
            <label className="field-group">
              <span className="field-label">Text encoder</span>
              <select
                className="select-input"
                value={comfyDraft.clipDevice}
                onChange={(event) => patchComfyDraft({ clipDevice: event.target.value as ComfyUiSettings['clipDevice'] })}
              >
                <option value="gpu">GPU</option>
                <option value="cpu">CPU</option>
              </select>
            </label>
          </div>
          <div className="settings-grid-two">
            <label className="field-group">
              <span className="field-label">Scene consistency</span>
              <select
                className="select-input"
                value={comfyDraft.referenceMode}
                onChange={(event) => patchComfyDraft({ referenceMode: event.target.value as ComfyUiSettings['referenceMode'] })}
              >
                <option value="none">Text only</option>
                <option value="previous">Previous scene reference</option>
              </select>
            </label>
            <label className="field-group">
              <span className="field-label">Weight dtype</span>
              <select
                className="select-input"
                value={comfyDraft.weightDtype}
                onChange={(event) => patchComfyDraft({ weightDtype: event.target.value as ComfyUiSettings['weightDtype'] })}
              >
                {COMFY_WEIGHT_DTYPES.map((dtype) => <option key={dtype} value={dtype}>{dtype}</option>)}
              </select>
            </label>
          </div>
          <div className="settings-connection-actions">
            <button className="button button-quiet" onClick={onComfyRefresh} disabled={comfyBusy}>
              {comfyBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              Refresh status and models
            </button>
            <button className="button button-secondary" onClick={() => onComfySettingsSave(comfyDraft)} disabled={comfyBusy}>
              Save ComfyUI settings
            </button>
          </div>
        </div>
        <div className="modal-footnote">
          <span className="status-dot" />
          CLI model: {status?.modelEndpoint || 'nano_banana_2_lite'}
        </div>
        <div className="modal-actions">
          <button className="button button-quiet" onClick={onClose}>Cancel</button>
          <button className="button button-secondary" onClick={onRefresh} disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            Refresh status
          </button>
          <button className="button button-primary" onClick={onLogin} disabled={busy || !status?.installed}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            {status?.authenticated ? 'Sign in again' : 'Sign in with Higgsfield'}
          </button>
        </div>
      </section>
    </div>
  )
}

export default App
