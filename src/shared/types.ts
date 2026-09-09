export type AspectRatio = '16:9' | '9:16'

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
  setting: string
  palette: string
  camera: string
  negativePrompt: string
}

export interface ScriptLine {
  id: string
  index: number
  text: string
  startTime: number
  endTime: number
  duration: number
  status: LineStatus
  voicePath?: string
  scenePrompt: string
  sceneDescription?: string
  directionStatus: DirectionStatus
  directionError?: string
  sceneStatus: SceneStatus
  imagePath?: string
  higgsRequestId?: string
  higgsStatus?: HiggsRequestStatus
  error?: string
}

export interface ExportSettings {
  width: number
  height: number
  fps: number
  audioLufs: number
  truePeak: number
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
}

export interface ProjectState {
  rootPath: string
  manifest: ProjectManifest
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
  prompt: string
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
  data: ArrayBuffer
  duration: number
  mimeType: string
}

export interface RecordingFocusPayload {
  text: string
  lineNumber: number
  duration: number
  state: 'countdown' | 'recording'
  countdown: number | null
  leadInSeconds: number
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
}

export interface LlmGenerationResult {
  text: string
}

export interface StudioApi {
  project: {
    choose: () => Promise<ProjectState | null>
    importScript: () => Promise<ProjectState | null>
    importScriptText: (script: string) => Promise<ProjectState>
    get: () => Promise<ProjectState | null>
    save: (manifest: ProjectManifest) => Promise<ProjectState>
    saveRecording: (payload: RecordingPayload) => Promise<ProjectState>
    assetDataUrl: (relativePath: string) => Promise<AssetData | null>
  }
  settings: {
    getHiggs: () => Promise<HiggsConnectionStatus>
    loginHiggs: () => Promise<HiggsConnectionStatus>
  }
  higgs: {
    generateScene: (input: GenerateSceneInput) => Promise<ProjectState>
    queueScene: (input: GenerateSceneInput) => Promise<ProjectState>
    onUpdate: (callback: (state: ProjectState) => void) => () => void
  }
  llm: {
    getStatus: () => Promise<LlmConnectionStatus>
    login: () => Promise<{ started: boolean }>
    generate: (input: LlmGenerationInput) => Promise<LlmGenerationResult>
    cancel: () => Promise<void>
  }
  teleprompter: {
    show: (payload: RecordingFocusPayload) => Promise<void>
    update: (payload: RecordingFocusPayload) => Promise<void>
    hide: () => Promise<void>
  }
  export: {
    longform: () => Promise<ExportResult | null>
  }
}

declare global {
  interface Window {
    studio: StudioApi
    teleprompterOverlay: {
      onUpdate: (callback: (payload: RecordingFocusPayload) => void) => () => void
    }
  }
}
