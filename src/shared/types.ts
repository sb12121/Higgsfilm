export type AspectRatio = '16:9' | '9:16'
export type SequenceId = 'main' | 'trailer'
export type ScriptLineMode = 'sentences' | 'stanzas'
export type ScriptLineRole = 'content' | 'cta'

export type LineStatus = 'draft' | 'recorded' | 'ready'
export type DirectionStatus = 'draft' | 'generating' | 'complete' | 'failed'
export type SceneStatus =
  | 'draft'
  | 'prompt-approved'
  | 'queued'
  | 'generating'
  | 'complete'
  | 'failed'

export type HiggsRequestStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'nsfw'
  | 'canceled'

export interface VisualBible {
  name: string
  style: string
  characters: string
  mainCharacter: string
  supportingCharacter: string
  setting: string
  palette: string
  camera: string
  negativePrompt: string
}

export interface ProductionBiblePreset {
  name: string
  bible: VisualBible
}

export type ChannelProductionMode = 'generate' | 'still-cast'

export interface ChannelImageProfile {
  id: string
  name: string
  visualBible: VisualBible
  imageGenerator: ImageGenerator
  comfy: ComfyUiSettings
  productionMode: ChannelProductionMode
  /** Root folder for this channel. Episode projects and Expressions live inside it. */
  channelFolderPath: string
  stillLibraryPath: string
  scriptBiblePath: string
  /** Optional markdown/text guide that steers the video-idea coach. */
  ideaGuidePath: string
  /** Stable niche / topic for the channel, e.g. "Personal Fitness". */
  niche: string
  /** Optional YouTube @handle used to refresh the channel brief. */
  youtubeHandle: string
  /** Cached YouTube channel snapshot summary for the idea coach. */
  channelBrief: string
  channelBriefUpdatedAt: string
}

export interface ChannelImageProfileInput {
  id?: string
  name: string
  visualBible: VisualBible
  imageGenerator: ImageGenerator
  comfy: ComfyUiSettings
  productionMode?: ChannelProductionMode
  channelFolderPath?: string
  stillLibraryPath?: string
  scriptBiblePath?: string
  ideaGuidePath?: string
  niche?: string
  youtubeHandle?: string
  channelBrief?: string
  channelBriefUpdatedAt?: string
}

export interface ChannelProfileState {
  profiles: ChannelImageProfile[]
  activeProfileId: string
}

export interface ChannelProfileApplyResult extends ChannelProfileState {
  settings: StudioSettings
  visualBible: VisualBible | null
}

export interface ContinuityCanon {
  version: 1
  sourceFingerprint: string
  summary: string
  subject: string
  cast: string[]
  locations: string[]
  props: string[]
  visualMotifs: string[]
}

export interface SceneDirectionRecord {
  version: 1
  lineId: string
  sourceFingerprint: string
  direction: string
  /** Optional legacy metadata retained when an older structured record is loaded. */
  focalSubject?: string
  visualAction?: string
  shotType?: string
  setting?: string
  visibleCharacters?: string[]
  visibleProps?: string[]
  propState?: string
  variationReason?: string
}

export interface SceneLedgerEntry {
  lineId: string
  lineIndex: number
  direction: string
  /** Optional legacy metadata retained for older scene ledgers. */
  focalSubject?: string
  visualAction?: string
  shotType?: string
  setting?: string
  propState?: string
  variationReason?: string
}

export interface StillCastBeat {
  id: string
  text: string
  expression: string
  imagePath?: string
}

export interface StillCastLibraryFolder {
  id: string
  folderName: string
  imagePaths: string[]
  kind?: 'expression' | 'custom'
}

export interface StillCastCustomStill {
  fileName: string
  imagePath: string
  matchKey: string
}

export interface StillCastLibraryScan {
  libraryPath: string
  folders: StillCastLibraryFolder[]
  unmatchedFolders: string[]
  customFolderPath?: string
  customStills?: StillCastCustomStill[]
  /** 9:16 condensed cut stills. Named after spoken lines, like Custom/. */
  trailerCustomFolderPath?: string
  trailerCustomStills?: StillCastCustomStill[]
}

export interface StillCastAssignInput {
  sequence?: SequenceId
  libraryPath?: string
  lineIds?: string[]
  reroll?: boolean
  skipCustom?: boolean
}

export interface StillCastExpressionInput {
  sequence?: SequenceId
  libraryPath?: string
  lineId: string
  beatId?: string
  expression: string
}

export interface QwenParagraphMaster {
  version: 1
  paragraphIndex: number
  lineIds: string[]
  masterPath: string
  masterFingerprint?: string
  durationMs: number
  createdAt: string
  alignmentStatus: 'pending' | 'aligned' | 'failed'
  alignmentReportPath?: string
  alignmentError?: string
}

export interface ScriptLine {
  id: string
  index: number
  paragraphIndex?: number
  text: string
  /** Unspoken picture direction for this line. Not recorded. */
  shotNote?: string
  startTime: number
  endTime: number
  duration: number
  status: LineStatus
  role?: ScriptLineRole
  voicePath?: string
  voiceRawPath?: string
  /** Raw-timeline speech window start used to build the cleaned take. */
  voiceTrimStart?: number
  /** Raw-timeline speech window end used to build the cleaned take. */
  voiceTrimEnd?: number
  voiceCleanupVersion?: number
  voiceCleanupEndPaddingSeconds?: number
  voiceCleanupConfident?: boolean
  voiceAssetVersion?: string
  voiceSourcePath?: string
  voiceCueStartMs?: number
  voiceCueEndMs?: number
  voiceAlignmentSource?: QwenVoiceAlignmentSource
  voiceAlignmentConfidence?: number
  voiceTranscript?: string
  voiceAlignmentError?: string
  voiceAlignmentReportPath?: string
  scenePrompt: string
  promptRefinement?: string
  sceneDescription?: string
  sceneRecord?: SceneDirectionRecord
  directionStatus: DirectionStatus
  directionError?: string
  imageGenerator?: ImageGenerator
  sceneStatus: SceneStatus
  imagePath?: string
  imageTags?: string[]
  stillBeats?: StillCastBeat[]
  higgsRequestId?: string
  higgsStatus?: HiggsRequestStatus
  comfyPromptId?: string
  error?: string
}

export type AudioMasterPreset = 'dialogue-youtube'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  audioLufs: number
  truePeak: number
  masterPreset: AudioMasterPreset
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  width: 3840,
  height: 2160,
  fps: 30,
  audioLufs: -16,
  truePeak: -1.5,
  masterPreset: 'dialogue-youtube',
}

export interface SequenceManifest {
  lines: ScriptLine[]
  scriptFile?: string
  scriptSummary?: string
  scriptSummaryFingerprint?: string
  continuityCanon?: ContinuityCanon
  qwenParagraphMasters?: QwenParagraphMaster[]
  exportSettings: ExportSettings
}

export const DEFAULT_TRAILER_EXPORT_SETTINGS: ExportSettings = {
  width: 2160,
  height: 3840,
  fps: 30,
  audioLufs: -16,
  truePeak: -1.5,
  masterPreset: 'dialogue-youtube',
}

const LEGACY_HD_EXPORT_CANVASES = new Set(['1920x1080', '1080x1920'])

export function normalizeExportSettings(
  raw: Partial<ExportSettings> | undefined,
  fallback: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): ExportSettings {
  const merged: ExportSettings = {
    ...fallback,
    ...(raw || {}),
    masterPreset:
      raw?.masterPreset === 'dialogue-youtube'
        ? 'dialogue-youtube'
        : fallback.masterPreset,
  }
  if (LEGACY_HD_EXPORT_CANVASES.has(`${merged.width}x${merged.height}`)) {
    return { ...merged, width: fallback.width, height: fallback.height }
  }
  return merged
}

export type VideoIdeaPhase =
  | 'idle'
  | 'audience'
  | 'demand'
  | 'research'
  | 'packaging'
  | 'consumption'
  | 'conversion'
  | 'locked'

export interface VideoIdeaBrief {
  candidateA?: string
  candidateB?: string
  candidateC?: string
  selectedCandidate?: string
  selectionReason?: string
  evidenceConfidence?: string
  evidenceLimitations?: string
  differentiation?: string
  productionFit?: string
  packagingAlternatives?: string
  decision?: string
  audience: string
  awareness: string
  subject: string
  demandEvidence: string
  failuresNoted: string
  bridge: string
  title: string
  thumbnailConcept: string
  clickReason: string
  promisedExperience: string
  scriptTopic: string
  sameAudienceFit: string
  cta: string
}

export interface VideoIdeaChecklist {
  audienceWritten: boolean
  demandEvidence: boolean
  failuresNoted: boolean
  sameAudience: boolean
  titleReady: boolean
  thumbnailReady: boolean
  experienceReady: boolean
  ctaReady: boolean
}

export interface VideoIdeaMessage {
  id: string
  role: 'user' | 'assistant' | 'research'
  text: string
  createdAt: string
}

export interface VideoIdeaSession {
  version: 1
  updatedAt: string
  phase: VideoIdeaPhase
  locked: boolean
  seed: string
  idea: VideoIdeaBrief
  evidence?: YouTubeVideoHit[]
  checklist: VideoIdeaChecklist
  messages: VideoIdeaMessage[]
}

export interface YouTubeVideoHit {
  videoId: string
  title: string
  channelName: string
  channelId?: string
  url: string
  viewCount?: number
  viewCountText?: string
  published?: string
  duration?: string
  description?: string
}

export interface YouTubeChannelSnapshot {
  channelId: string
  name: string
  handle?: string
  url: string
  videos: YouTubeVideoHit[]
}

export interface VideoIdeaResearchRequest {
  queries?: string[]
  channels?: string[]
}

export interface VideoIdeaResearchResult {
  queries: Array<{ query: string; videos: YouTubeVideoHit[]; error?: string }>
  channels: Array<{ channel: string; snapshot?: YouTubeChannelSnapshot; error?: string }>
}

export interface ProjectManifest {
  version: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  scriptFile?: string
  lines: ScriptLine[]
  visualBible: VisualBible
  exportSettings: ExportSettings
  scriptSummary?: string
  scriptSummaryFingerprint?: string
  continuityCanon?: ContinuityCanon
  qwenParagraphMasters?: QwenParagraphMaster[]
  trailer?: SequenceManifest
  videoIdea?: VideoIdeaSession
}

export interface ScriptCreatorDraft {
  topic: string
  draft: string
  /** Brief and script bible used to generate this draft. Missing means its source is unknown. */
  source?: {
    topic: string
    bible: string
    biblePath?: string
    draftFingerprint?: string
  }
}

export interface ProjectState {
  rootPath: string
  manifest: ProjectManifest
  /** Monotonic in-memory revision used to reject stale renderer updates. */
  revision: number
  scriptCreator?: ScriptCreatorDraft
}

export interface HiggsConnectionStatus {
  configured: boolean
  installed: boolean
  authenticated: boolean
  email?: string
  plan?: string
  credits?: number
  modelEndpoint: string
  message: string
}

export interface GenerateSceneInput {
  lineId: string
  sequence?: SequenceId
  prompt: string
  promptFingerprint?: string
  modelEndpoint: string
  aspectRatio: AspectRatio
  resolution: string
}

export interface AssetData {
  dataUrl: string
  mimeType: string
}

export interface RecordingPayload {
  lineId: string
  sequence?: SequenceId
  data: ArrayBuffer
  duration: number
  mimeType: string
  sourcePath?: string
  cueStartMs?: number
  cueEndMs?: number
  alignmentSource?: QwenVoiceAlignmentSource
  alignmentConfidence?: number
  transcript?: string
  alignmentError?: string
  alignmentReportPath?: string
}

export interface TrimVoiceTakePayload {
  lineId: string
  sequence?: SequenceId
  /** Raw-timeline start of the speech window (seconds). */
  trimStartSeconds?: number
  /** Raw-timeline end of the speech window (seconds). */
  trimEndSeconds: number
}

export interface ResetVoiceTakeCleanupPayload {
  lineId: string
  sequence?: SequenceId
}

export interface RecordingFocusPayload {
  text: string
  lines?: string[]
  expression?: string
  expressions?: string[]
  speaker?: string
  speakers?: string[]
  speakerHint?: string
  lineNumber: number
  stanzaNumber?: number
  duration: number
  state: 'countdown' | 'recording'
  countdown: number | null
  leadInSeconds: number
}

export interface ImageInspectorItem {
  lineId: string
  lineNumber: number
  label: string
  imagePath: string
}

export interface ImageInspectorPayload {
  items: ImageInspectorItem[]
  index: number
}

export interface VoiceInspectorItem {
  lineId: string
  lineNumber: number
  label: string
  voicePath: string
  durationSeconds: number
  sequence: SequenceId
  voiceAssetVersion?: string
  voiceTrimStart?: number
  voiceTrimEnd?: number
  voiceCleanupVersion?: number
  voiceCleanupEndPaddingSeconds?: number
  voiceCleanupConfident?: boolean
  canTrim: boolean
}

export interface VoiceInspectorPayload {
  items: VoiceInspectorItem[]
  index: number
}

export interface ExportResult {
  outputPath: string
  duration: number
}

export interface LlmConnectionStatus {
  installed: boolean
  authenticated: boolean
  authMethod?: 'chatgpt' | 'api-key' | 'unknown'
  version?: string
  message: string
}

export interface LlmGenerationInput {
  prompt: string
  requestId?: string
  purpose?:
    | 'creative'
    | 'script-summary'
    | 'scene-direction'
    | 'trailer-script'
    | 'still-cast'
    | 'script-draft'
    | 'video-idea'
}

export interface LlmGenerationResult {
  text: string
}

export type ImageGenerator = 'higgsfield' | 'chatgpt' | 'comfyui'
export type VoiceMode = 'microphone' | 'qwen'
export type QwenTtsGenerationMode = 'paragraph' | 'all' | 'resume'
export type QwenVoiceAlignmentSource = 'paragraph-aligned' | 'line-fallback'
export type QwenAlignmentSeverity = 'exact' | 'localized' | 'severe'

export interface QwenAlignmentStatus {
  configured: boolean
  runtime?: string
  model: string
  message: string
}

export interface QwenTtsGenerateInput {
  sequence?: SequenceId
  mode: QwenTtsGenerationMode
  lineId?: string
}

export interface QwenTtsRealignInput {
  sequence?: SequenceId
  lineId?: string
}

export interface QwenTtsStatus {
  configured: boolean
  model: string
  comfyUrl: string
  alignment: QwenAlignmentStatus
  referenceName?: string
  referenceMime?: string
  referenceBytes?: number
  referenceText: string
}

export interface QwenTtsProgress {
  sequence: SequenceId
  mode: QwenTtsGenerationMode
  paragraphIndex: number
  paragraphCount: number
  lineIndex: number
  lineCount: number
  stage: string
}

export type ComfyWeightDtype = 'default' | 'fp8_e4m3fn' | 'fp8_e4m3fn_fast' | 'fp8_e5m2'
export type ComfyClipDevice = 'cpu' | 'gpu'
export type ComfySeedMode = 'random' | 'fixed'
export type ComfyReferenceMode = 'none' | 'previous'
export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max'
export type LlmServiceTier = 'standard' | 'fast'
export type LlmModel = 'gpt-6-astra' | 'gpt-5.6-luna' | 'gpt-5.6-sol'
export type LlmStep =
  | 'video-idea'
  | 'script-draft'
  | 'trailer-script'
  | 'script-summary'
  | 'still-cast'
  | 'scene-direction'
  | 'creative'
  | 'image'

export interface LlmStepSetting {
  model: LlmModel
  reasoningEffort: LlmReasoningEffort
  serviceTier: LlmServiceTier
}

export type LlmStepSettings = Record<LlmStep, LlmStepSetting>

export const DEFAULT_LLM_REASONING_EFFORT: LlmReasoningEffort = 'low'
export const LLM_REASONING_EFFORTS: LlmReasoningEffort[] = ['low', 'medium', 'high', 'max']
export const DEFAULT_LLM_SERVICE_TIER: LlmServiceTier = 'standard'
export const LLM_SERVICE_TIERS: LlmServiceTier[] = ['standard', 'fast']
export const LLM_MODELS: LlmModel[] = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna']
export const LLM_MODEL_LABELS: Record<LlmModel, string> = {
  'gpt-6-astra': 'Astra',
  'gpt-5.6-sol': 'Sol',
  'gpt-5.6-luna': 'Luna',
}
export const LLM_STEPS: LlmStep[] = [
  'video-idea',
  'script-draft',
  'trailer-script',
  'script-summary',
  'still-cast',
  'scene-direction',
  'creative',
  'image',
]
export const LLM_STEP_LABELS: Record<LlmStep, string> = {
  'video-idea': 'Video idea',
  'script-draft': 'Script',
  'trailer-script': 'Trailer script',
  'script-summary': 'Script summary',
  'still-cast': 'Still cast',
  'scene-direction': 'Scene direction',
  creative: 'Creative copilot',
  image: 'Image generation',
}

export function normalizeLlmReasoningEffort(value?: unknown): LlmReasoningEffort {
  return LLM_REASONING_EFFORTS.includes(value as LlmReasoningEffort)
    ? (value as LlmReasoningEffort)
    : DEFAULT_LLM_REASONING_EFFORT
}

export function normalizeLlmServiceTier(value?: unknown): LlmServiceTier {
  return LLM_SERVICE_TIERS.includes(value as LlmServiceTier)
    ? (value as LlmServiceTier)
    : DEFAULT_LLM_SERVICE_TIER
}

export function normalizeLlmModel(value?: unknown): LlmModel {
  return LLM_MODELS.includes(value as LlmModel) ? (value as LlmModel) : 'gpt-5.6-luna'
}

export function defaultLlmStepSettings(): LlmStepSettings {
  const luna = (reasoningEffort: LlmReasoningEffort): LlmStepSetting => ({
    model: 'gpt-5.6-luna',
    reasoningEffort,
    serviceTier: 'fast',
  })
  const astra = (reasoningEffort: LlmReasoningEffort): LlmStepSetting => ({
    model: 'gpt-6-astra',
    reasoningEffort,
    serviceTier: 'fast',
  })
  return {
    'video-idea': astra('high'),
    'script-draft': astra('max'),
    'trailer-script': astra('high'),
    'script-summary': luna('high'),
    'still-cast': luna('medium'),
    'scene-direction': luna('medium'),
    creative: luna('medium'),
    image: luna('low'),
  }
}

export function normalizeLlmStepSettings(value: unknown): LlmStepSettings {
  const defaults = defaultLlmStepSettings()
  if (!value || typeof value !== 'object') return defaults
  const raw = value as Partial<Record<LlmStep, Partial<LlmStepSetting>>>
  const next = { ...defaults }
  for (const step of LLM_STEPS) {
    const entry = raw[step]
    if (!entry || typeof entry !== 'object') continue
    next[step] = {
      model: LLM_MODELS.includes(entry.model as LlmModel)
        ? (entry.model as LlmModel)
        : defaults[step].model,
      reasoningEffort: LLM_REASONING_EFFORTS.includes(entry.reasoningEffort as LlmReasoningEffort)
        ? (entry.reasoningEffort as LlmReasoningEffort)
        : defaults[step].reasoningEffort,
      serviceTier: LLM_SERVICE_TIERS.includes(entry.serviceTier as LlmServiceTier)
        ? (entry.serviceTier as LlmServiceTier)
        : defaults[step].serviceTier,
    }
  }
  return next
}

export interface ComfyUiSettings {
  baseUrl: string
  diffusionModel: string
  steps: number
  guidance: number
  sampler: string
  weightDtype: ComfyWeightDtype
  clipDevice: ComfyClipDevice
  seedMode: ComfySeedMode
  seed: number
  referenceMode: ComfyReferenceMode
  referenceStrength: number
}

export const DEFAULT_COMFY_UI_SETTINGS: ComfyUiSettings = {
  baseUrl: 'http://127.0.0.1:8188',
  diffusionModel: 'flux-2-klein-9b-fp8.safetensors',
  steps: 8,
  guidance: 4,
  sampler: 'euler',
  weightDtype: 'default',
  clipDevice: 'cpu',
  seedMode: 'random',
  seed: 42,
  referenceMode: 'none',
  referenceStrength: 0.45,
}

export const COMFY_SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'ddim',
  'uni_pc',
] as const

export const COMFY_WEIGHT_DTYPES: ComfyWeightDtype[] = [
  'default',
  'fp8_e4m3fn',
  'fp8_e4m3fn_fast',
  'fp8_e5m2',
]

export function normalizeComfyUiSettings(
  partial?: Partial<ComfyUiSettings> | null,
): ComfyUiSettings {
  const merged = {
    ...DEFAULT_COMFY_UI_SETTINGS,
    ...(partial || {}),
  }
  const steps = Number(merged.steps)
  const guidance = Number(merged.guidance)
  const seed = Number(merged.seed)
  const referenceStrength = Number(merged.referenceStrength)
  let baseUrl = DEFAULT_COMFY_UI_SETTINGS.baseUrl
  try {
    const parsed = new URL(String(merged.baseUrl || DEFAULT_COMFY_UI_SETTINGS.baseUrl).trim())
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      baseUrl = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`
    }
  } catch {
    // Keep the local default when the persisted endpoint is invalid.
  }
  return {
    baseUrl,
    diffusionModel:
      typeof merged.diffusionModel === 'string' && merged.diffusionModel.trim()
        ? merged.diffusionModel.trim()
        : DEFAULT_COMFY_UI_SETTINGS.diffusionModel,
    steps: Number.isFinite(steps)
      ? Math.min(100, Math.max(1, Math.round(steps)))
      : DEFAULT_COMFY_UI_SETTINGS.steps,
    guidance: Number.isFinite(guidance)
      ? Math.min(30, Math.max(0, guidance))
      : DEFAULT_COMFY_UI_SETTINGS.guidance,
    sampler:
      typeof merged.sampler === 'string' && merged.sampler.trim()
        ? merged.sampler.trim()
        : DEFAULT_COMFY_UI_SETTINGS.sampler,
    weightDtype: COMFY_WEIGHT_DTYPES.includes(merged.weightDtype as ComfyWeightDtype)
      ? (merged.weightDtype as ComfyWeightDtype)
      : DEFAULT_COMFY_UI_SETTINGS.weightDtype,
    // "default" was the original GPU setting. Treat it as the legacy default
    // and migrate existing settings to CPU text encoding to avoid VRAM thrash.
    clipDevice: merged.clipDevice === 'gpu' ? 'gpu' : 'cpu',
    seedMode: merged.seedMode === 'fixed' ? 'fixed' : 'random',
    seed: Number.isFinite(seed) ? Math.max(0, Math.floor(seed)) : DEFAULT_COMFY_UI_SETTINGS.seed,
    referenceMode: merged.referenceMode === 'previous' ? 'previous' : 'none',
    referenceStrength: Number.isFinite(referenceStrength)
      ? Math.min(1, Math.max(0, referenceStrength))
      : DEFAULT_COMFY_UI_SETTINGS.referenceStrength,
  }
}

export interface ComfyConnectionStatus {
  configured: boolean
  reachable: boolean
  baseUrl: string
  models: string[]
  selectedModel: string
  message: string
}

export interface StudioSettings {
  imageGenerator: ImageGenerator
  voiceMode: VoiceMode
  llmReasoningEffort: LlmReasoningEffort
  llmServiceTier: LlmServiceTier
  llmSteps: LlmStepSettings
  comfy: ComfyUiSettings
  /** Absolute path to the 16:9 custom-image guide. Empty uses the guide found above the project. */
  customImageGuidePath: string
  /** Absolute path of the proportion and costume character sheet. */
  customImageCharacterSheetPath: string
  /** Absolute paths of optional face and style references. Scene stills do not belong here. */
  customImageReferencePaths: string[]
  /** Absolute path to the expression-still guide. Empty uses the guide found near the channel. */
  expressionGuidePath: string
  /** One empty background plate shared by every regenerated expression still. */
  expressionBackgroundPath: string
}

export interface CustomImageSetup {
  guidePath: string
  characterSheetPath: string
  referencePaths: string[]
  stills?: Array<{ lineId: string; status: 'missing' | 'current' | 'stale' | 'unknown' }>
  sourceError?: string
}

export interface CustomImageGenerateInput {
  lineIds?: string[]
  onlyMissing?: boolean
}

export interface CustomImageGenerateResult {
  state: ProjectState
  stopped: boolean
}

export interface CustomImageProgress {
  index: number
  total: number
  spoken: string
  fileName: string
  phase: 'generating' | 'saving' | 'assigned'
}

export interface ExpressionImageSetup {
  guidePath: string
  characterSheetPath: string
  referencePaths: string[]
  backgroundPath: string
  libraryPath: string
  expressions: string[]
}

export interface ExpressionImageGenerateInput {
  expressions: string[]
}

export interface ExpressionImageGenerateResult {
  written: string[]
  stopped: boolean
}

export interface ExpressionImageProgress {
  index: number
  total: number
  expression: string
  frame: number
  fileName: string
  phase: 'generating' | 'saving'
}

export interface StudioApi {
  project: {
    choose: () => Promise<ProjectState | null>
    importScript: (
      sequence?: SequenceId,
      lineMode?: ScriptLineMode,
      stillLibraryPath?: string,
    ) => Promise<ProjectState | null>
    importScriptText: (
      script: string,
      sequence?: SequenceId,
      lineMode?: ScriptLineMode,
      stillLibraryPath?: string,
    ) => Promise<ProjectState>
    get: () => Promise<ProjectState | null>
    close: () => Promise<void>
    save: (manifest: ProjectManifest) => Promise<ProjectState>
    resetSceneGenerationCache: (sequence?: SequenceId) => Promise<ProjectState>
    saveRecording: (payload: RecordingPayload) => Promise<ProjectState>
    saveStanzaRecording: (payload: RecordingPayload) => Promise<ProjectState>
    trimVoiceTake: (payload: TrimVoiceTakePayload) => Promise<ProjectState>
    resetVoiceTakeCleanup: (payload: ResetVoiceTakeCleanupPayload) => Promise<ProjectState>
    assetDataUrl: (relativePath: string) => Promise<AssetData | null>
    audioPeaks: (relativePath: string, bucketCount?: number) => Promise<number[] | null>
    assetThumbDataUrl: (relativePath: string, maxEdge?: number) => Promise<AssetData | null>
    copyImageToClipboard: (relativePath: string) => Promise<void>
    saveScriptCreator: (
      draft: ScriptCreatorDraft & { expectedProjectId?: string; expectedRootPath?: string },
    ) => Promise<void>
  }
  productionBibles: {
    list: () => Promise<ProductionBiblePreset[]>
    save: (name: string, bible: VisualBible) => Promise<ProductionBiblePreset[]>
    load: (name: string) => Promise<ProductionBiblePreset | null>
  }
  channelProfiles: {
    list: () => Promise<ChannelProfileState>
    save: (input: ChannelImageProfileInput) => Promise<ChannelProfileState>
    remove: (id: string) => Promise<ChannelProfileState>
    apply: (id: string) => Promise<ChannelProfileApplyResult>
    chooseFolder: () => Promise<ChannelProfileState | null>
  }
  stillCast: {
    chooseLibrary: () => Promise<string | null>
    scanLibrary: (libraryPath: string) => Promise<StillCastLibraryScan>
    scanCatalog: (libraryPath?: string) => Promise<StillCastLibraryScan>
    prepareLibrary: (libraryPath: string) => Promise<StillCastLibraryScan>
    assignImages: (input: StillCastAssignInput) => Promise<ProjectState>
    setExpression: (input: StillCastExpressionInput) => Promise<ProjectState>
  }
  customImages: {
    getSetup: () => Promise<CustomImageSetup>
    chooseGuide: () => Promise<string | null>
    chooseCharacterSheet: () => Promise<string | null>
    chooseReferences: () => Promise<string[] | null>
    generate: (input: CustomImageGenerateInput) => Promise<CustomImageGenerateResult>
    missingBrief: () => Promise<string>
    scriptCreatorBrief: (input: { script: string; topic?: string }) => Promise<string>
    cancel: () => Promise<void>
    onProgress: (callback: (progress: CustomImageProgress) => void) => () => void
  }
  expressionImages: {
    getSetup: () => Promise<ExpressionImageSetup>
    chooseGuide: () => Promise<string | null>
    chooseBackground: () => Promise<string | null>
    generate: (input: ExpressionImageGenerateInput) => Promise<ExpressionImageGenerateResult>
    cancel: () => Promise<void>
    onProgress: (callback: (progress: ExpressionImageProgress) => void) => () => void
  }
  scriptBible: {
    choose: () => Promise<string | null>
    read: (filePath: string) => Promise<{ path: string; text: string }>
  }
  ideaGuide: {
    choose: () => Promise<string | null>
    read: (filePath: string) => Promise<{ path: string; text: string }>
  }
  settings: {
    get: () => Promise<StudioSettings>
    save: (settings: StudioSettings) => Promise<StudioSettings>
    getHiggs: () => Promise<HiggsConnectionStatus>
    loginHiggs: () => Promise<HiggsConnectionStatus>
    getComfyStatus: () => Promise<ComfyConnectionStatus>
  }
  higgs: {
    generateScene: (input: GenerateSceneInput) => Promise<ProjectState>
    queueScene: (input: GenerateSceneInput) => Promise<ProjectState>
    cancel: () => Promise<void>
    resume: () => Promise<void>
    onUpdate: (callback: (state: ProjectState) => void) => () => void
  }
  llm: {
    getStatus: () => Promise<LlmConnectionStatus>
    login: () => Promise<{ started: boolean }>
    generate: (input: LlmGenerationInput) => Promise<LlmGenerationResult>
    cancel: (requestId?: string) => Promise<void>
  }
  youtube: {
    research: (input: VideoIdeaResearchRequest) => Promise<VideoIdeaResearchResult>
  }
  teleprompter: {
    show: (payload: RecordingFocusPayload) => Promise<void>
    update: (payload: RecordingFocusPayload) => Promise<void>
    hide: () => Promise<void>
  }
  imageInspector: {
    show: (payload: ImageInspectorPayload) => Promise<void>
    update: (payload: ImageInspectorPayload) => Promise<void>
    hide: () => Promise<void>
    onNavigate: (callback: (delta: number) => void) => () => void
    onClosed: (callback: () => void) => () => void
  }
  voiceInspector: {
    show: (payload: VoiceInspectorPayload) => Promise<void>
    update: (payload: VoiceInspectorPayload) => Promise<void>
    hide: () => Promise<void>
    onNavigate: (callback: (delta: number) => void) => () => void
    onClosed: (callback: () => void) => () => void
    onProjectUpdated: (callback: (state: ProjectState) => void) => () => void
  }
  export: {
    longform: (sequence?: SequenceId) => Promise<ExportResult | null>
    setPreRenderPaused: (paused: boolean) => Promise<void>
  }
  qwen: {
    getStatus: () => Promise<QwenTtsStatus>
    chooseReference: () => Promise<QwenTtsStatus>
    saveReferenceText: (text: string) => Promise<QwenTtsStatus>
    generate: (input: QwenTtsGenerateInput) => Promise<ProjectState>
    realign: (input: QwenTtsRealignInput) => Promise<ProjectState>
    cancel: () => Promise<void>
    onProgress: (callback: (progress: QwenTtsProgress) => void) => () => void
  }
}

declare global {
  interface Window {
    studio: StudioApi
    teleprompterOverlay: {
      onUpdate: (callback: (payload: RecordingFocusPayload) => void) => () => void
    }
    imageInspector: {
      onUpdate: (callback: (payload: ImageInspectorPayload) => void) => () => void
      navigate: (delta: number) => Promise<void>
      close: () => Promise<void>
      loadImage: (relativePath: string) => Promise<AssetData | null>
    }
    voiceInspector: {
      onUpdate: (callback: (payload: VoiceInspectorPayload) => void) => () => void
      navigate: (delta: number) => Promise<void>
      close: () => Promise<void>
      loadAudio: (relativePath: string) => Promise<AssetData | null>
      audioPeaks: (relativePath: string, bucketCount?: number) => Promise<number[] | null>
      trimVoiceTake: (payload: TrimVoiceTakePayload) => Promise<ProjectState>
      resetVoiceTakeCleanup: (payload: ResetVoiceTakeCleanupPayload) => Promise<ProjectState>
    }
  }
}
