import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  Mic,
  Music2,
  PanelLeft,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  WandSparkles,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  DirectionStatus,
  HiggsConnectionStatus,
  LlmConnectionStatus,
  ProjectManifest,
  ProjectState,
  RecordingFocusPayload,
  ScriptLine,
} from '../shared/types'
import { composeScenePrompt } from '../shared/promptComposer'

type StudioSection = 'overview' | 'script' | 'visuals' | 'timeline' | 'export'

interface Notice {
  type: 'success' | 'error' | 'info'
  message: string
}

interface ContextPromptProgress {
  current: number
  total: number
  completed: number
  lineText: string
  startedAt: number
}

const navItems: Array<{ id: StudioSection; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Production board', icon: Layers3 },
  { id: 'script', label: 'Script & voice', icon: FileText },
  { id: 'visuals', label: 'Visual direction', icon: ImageIcon },
  { id: 'timeline', label: 'Timeline', icon: Clapperboard },
  { id: 'export', label: 'Export', icon: Download },
]

const visualBibleFields: Array<{
  key: keyof ProjectManifest['visualBible']
  label: string
  placeholder: string
}> = [
  {
    key: 'style',
    label: 'Style language',
    placeholder: 'Hand-drawn MS Paint stickman illustration, rough black lines, white canvas...',
  },
  {
    key: 'characters',
    label: 'Characters & references',
    placeholder: 'Circular heads, expressive faces, fixed proportions, one recurring full-color protagonist...',
  },
  {
    key: 'setting',
    label: 'World & setting',
    placeholder: 'Sparse white canvas, simple black-outline props, lots of negative space...',
  },
  {
    key: 'palette',
    label: 'Palette',
    placeholder: 'Pure white, near-black linework, full-color protagonist fills, no gradients...',
  },
  {
    key: 'camera',
    label: 'Camera language',
    placeholder: 'Flat orthographic 2D view, medium/wide shots, readable 16:9 framing...',
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

function cloneManifest(manifest: ProjectManifest): ProjectManifest {
  return structuredClone(manifest)
}

function buildContextualPromptRequest(state: ProjectState, targetLine: ScriptLine): string {
  const script = state.manifest.lines
    .map(
      (line) =>
        `LINE ${line.index + 1} (id: ${line.id}, time: ${formatTime(line.startTime)}-${formatTime(line.endTime)}): ${line.text}`,
    )
    .join('\n')

  return [
    'Create only the scene direction for the target narration line in the Higgsfilm project below.',
    'You are writing scene directions for a consistent visual sequence.',
    '',
    'Use the entire script as narrative context before writing any individual prompt.',
    'Resolve pronouns and short references using the established story context. For example, if an earlier line establishes that the recurring subject is a golden retriever, a later line saying "He is happy" must explicitly describe that same golden retriever instead of saying only "he".',
    'Build a small internal cast and prop continuity list from the script, then apply it to every prompt.',
    'The scene direction must stand alone: repeat the full identity, appearance, important props, setting, and continuity details needed to render that line correctly.',
    'Do not invent a new character when the script already established one. If a reference is genuinely ambiguous, choose the most coherent interpretation from the surrounding script and keep that choice consistent.',
    'Whenever the recurring protagonist or another human appears, explicitly preserve their established solid flat colors and describe a clearly expressive face with visible eyes, eyebrows, and mouth. Never direct the protagonist as a black-and-white outline-only character.',
    'Make one clear visual moment per line. Do not merge lines or summarize the whole video.',
    'Do not render captions, logos, watermarks, or readable text unless that specific narration line requires visible text.',
    'Do not rewrite, summarize, or include the Style, Characters, Setting, Palette, Camera, or Avoid blocks. Those project-controlled style lines are added separately.',
    '',
    `TARGET LINE: ${targetLine.index + 1} (id: ${targetLine.id})`,
    targetLine.text,
    '',
    'FULL SCRIPT:',
    script,
    '',
    'Return only valid JSON in this exact shape, with no Markdown fences:',
    `{"lineId":"${targetLine.id}","prompt":"complete self-contained scene direction for line ${targetLine.index + 1}"}`,
    'The prompt field must contain only production-ready scene-direction prose, not the narration, style blocks, or an explanation of your reasoning.',
  ].join('\n')
}

function parseContextualPrompts(text: string, lines: ScriptLine[]): Map<string, string> {
  const payload = parseJsonDocument(text)
  const rows = isRecord(payload)
    ? payload.prompts || payload.scenes || payload.items
    : payload
  const result = new Map<string, string>()

  if (Array.isArray(rows)) {
    rows.forEach((row, rowIndex) => {
      const line = resolvePromptLine(row, rowIndex, lines)
      const prompt = promptText(row)
      if (line && prompt) result.set(line.id, prompt)
    })
  } else if (isRecord(rows)) {
    Object.entries(rows).forEach(([key, value]) => {
      const line = lines.find((candidate) => candidate.id === key) || lines[Number(key) - 1]
      if (line && typeof value === 'string' && value.trim()) result.set(line.id, value.trim())
    })
  }

  return result
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
    trimmed.slice(trimmed.indexOf('['), trimmed.lastIndexOf(']') + 1),
  ].filter((candidate) => candidate.length > 1)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next JSON boundary when the model added a short preamble.
    }
  }
  return null
}

function resolvePromptLine(row: unknown, rowIndex: number, lines: ScriptLine[]): ScriptLine | undefined {
  if (isRecord(row)) {
    const id = row.lineId || row.line_id || row.id
    if (typeof id === 'string') {
      const byId = lines.find((line) => line.id === id)
      if (byId) return byId
    }
    const lineNumber = row.lineNumber || row.line_number
    if (typeof lineNumber === 'number' || (typeof lineNumber === 'string' && lineNumber.trim())) {
      const index = Number(lineNumber) - 1
      if (Number.isInteger(index) && lines[index]) return lines[index]
    }
  }
  return lines[rowIndex]
}

function promptText(row: unknown): string | undefined {
  if (typeof row === 'string' && row.trim()) return row.trim()
  if (!isRecord(row)) return undefined
  for (const key of [
    'prompt',
    'sceneDescription',
    'scene_description',
    'scenePrompt',
    'scene_prompt',
    'visualPrompt',
    'visual_prompt',
  ]) {
    if (typeof row[key] === 'string' && row[key].trim()) return row[key].trim()
  }
  return undefined
}

function parseSingleContextualPrompt(text: string, line: ScriptLine): string | undefined {
  const payload = parseJsonDocument(text)
  const direct = promptText(payload)
  if (direct) return normalizeSceneDescription(direct, line)

  const mapped = parseContextualPrompts(text, [line])
  const fallback = mapped.get(line.id) || (typeof text === 'string' && text.trim() ? text.trim() : undefined)
  return fallback ? normalizeSceneDescription(fallback, line) : undefined
}

function normalizeSceneDescription(value: string, line: ScriptLine): string {
  const cleaned = value
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const sceneMatch = cleaned.match(
    /(?:scene direction|scene description)\s*:\s*([\s\S]*?)(?:\n(?:style|characters|setting|palette|camera|avoid)\s*:|$)/i,
  )
  if (sceneMatch?.[1]?.trim()) return sceneMatch[1].trim()

  const styleStart = cleaned.search(/\nstyle\s*:/i)
  if (styleStart >= 0) {
    const beforeStyle = cleaned.slice(0, styleStart).trim()
    const lines = beforeStyle.split(/\r?\n/)
    const withoutWrapper = lines.slice(1).join('\n').trim()
    return withoutWrapper || line.text
  }
  return cleaned
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
  return directionStatusOf(line) === 'complete' && Boolean(line.scenePrompt.trim())
}

function hasImage(line: ScriptLine): boolean {
  return line.sceneStatus === 'complete' && Boolean(line.imagePath)
}

function App() {
  const [project, setProject] = useState<ProjectState | null>(null)
  const [activeSection, setActiveSection] = useState<StudioSection>('overview')
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [higgsStatus, setHiggsStatus] = useState<HiggsConnectionStatus | null>(null)
  const [llmStatus, setLlmStatus] = useState<LlmConnectionStatus | null>(null)
  const [llmPrompt, setLlmPrompt] = useState('')
  const [llmOutput, setLlmOutput] = useState('')
  const [llmBusy, setLlmBusy] = useState(false)
  const [contextPromptsBusy, setContextPromptsBusy] = useState(false)
  const [contextPromptProgress, setContextPromptProgress] = useState<ContextPromptProgress | null>(null)
  const [imageBatchBusy, setImageBatchBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [higgsAuthBusy, setHiggsAuthBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generatingLineId, setGeneratingLineId] = useState<string | null>(null)
  const [recordingLineId, setRecordingLineId] = useState<string | null>(null)
  const [countdownLineId, setCountdownLineId] = useState<string | null>(null)
  const [countdownValue, setCountdownValue] = useState<number | null>(null)
  const [countdownLeadInSeconds, setCountdownLeadInSeconds] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [assetSources, setAssetSources] = useState<Record<string, string>>({})
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingStartedRef = useRef<number>(0)
  const cancelRecordingRef = useRef(false)
  const restartRecordingRef = useRef<string | null>(null)
  const advanceRecordingRef = useRef(false)
  const cancelContextPromptsRef = useRef(false)
  const activeDirectionLinesRef = useRef(new Set<string>())
  const promptSaveQueueRef = useRef(Promise.resolve())
  const imageSubmitQueueRef = useRef(Promise.resolve())
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const silenceCheckTimerRef = useRef<number | null>(null)

  const selectedLine = useMemo(
    () => project?.manifest.lines.find((line) => line.id === activeLineId) || project?.manifest.lines[0],
    [activeLineId, project],
  )

  const totalDuration = useMemo(
    () => project?.manifest.lines.reduce((total, line) => total + line.duration, 0) || 0,
    [project],
  )

  const recordedCount = project?.manifest.lines.filter((line) => line.status === 'recorded' || line.status === 'ready').length || 0
  const visualCount = project?.manifest.lines.filter((line) => line.sceneStatus === 'complete').length || 0

  useEffect(() => {
    void (async () => {
      try {
        const [existingProject, status] = await Promise.all([
          window.studio.project.get(),
          window.studio.settings.getHiggs(),
        ])
        setLlmStatus(await window.studio.llm.getStatus())
        if (existingProject) {
          setProject(existingProject)
          setActiveLineId(existingProject.manifest.lines[0]?.id || null)
          await loadAssets(existingProject)
        }
        setHiggsStatus(status)
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : 'Could not load Higgsfilm.')
      }
    })()
  }, [])

  useEffect(() => {
    return window.studio.higgs.onUpdate((state) => {
      void loadProject(state)
    })
  }, [])

  useEffect(() => {
    const handleRecordingKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (event.key === 'Enter' && recordingLineId) {
        event.preventDefault()
        stopRecording(true)
      }
      if ((event.code === 'Space' || event.key === ' ') && recordingLineId) {
        event.preventDefault()
        stopRecording()
      }
      if (event.key === 'Escape' && (recordingLineId || countdownLineId)) {
        event.preventDefault()
        cancelRecording()
      }
    }

    window.addEventListener('keydown', handleRecordingKey)
    return () => window.removeEventListener('keydown', handleRecordingKey)
  }, [countdownLineId, recordingLineId])

  async function loadAssets(state: ProjectState): Promise<void> {
    const paths = state.manifest.lines.flatMap((line) =>
      [line.imagePath, line.voicePath].filter((value): value is string => Boolean(value)),
    )
    const entries = await Promise.all(
      paths.map(async (assetPath) => [assetPath, await window.studio.project.assetDataUrl(assetPath)] as const),
    )
    setAssetSources((current) => {
      const next = { ...current }
      entries.forEach(([assetPath, asset]) => {
        if (asset) next[assetPath] = asset.dataUrl
      })
      return next
    })
  }

  function showNotice(type: Notice['type'], message: string): void {
    setNotice({ type, message })
    window.setTimeout(() => setNotice(null), 5000)
  }

  async function loadProject(state: ProjectState): Promise<void> {
    setProject(state)
    setActiveLineId((current) => current || state.manifest.lines[0]?.id || null)
    await loadAssets(state)
  }

  async function chooseProject(): Promise<void> {
    try {
      const state = await window.studio.project.choose()
      if (!state) return
      await loadProject(state)
      showNotice('success', 'Project folder is ready.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not open that folder.')
    }
  }

  async function importScript(): Promise<void> {
    try {
      const state = await window.studio.project.importScript()
      if (!state) return
      await loadProject(state)
      setActiveSection('script')
      showNotice('success', `${state.manifest.lines.length} narration lines created.`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not import that script.')
    }
  }

  async function importScriptText(script: string): Promise<void> {
    try {
      const state = await window.studio.project.importScriptText(script)
      await loadProject(state)
      setActiveSection('script')
      showNotice('success', `${state.manifest.lines.length} narration lines created.`)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not create narration lines.')
    }
  }

  async function startLlmLogin(): Promise<void> {
    try {
      await window.studio.llm.login()
      showNotice('info', 'A Codex login window opened. Finish ChatGPT sign-in, then reopen Higgsfilm.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not start ChatGPT sign-in.')
    }
  }

  async function generateWithChatGpt(): Promise<void> {
    if (!llmPrompt.trim()) {
      showNotice('info', 'Describe what you want ChatGPT to create first.')
      return
    }
    setLlmBusy(true)
    try {
      const result = await window.studio.llm.generate({ prompt: llmPrompt })
      setLlmOutput(result.text)
      showNotice('success', 'ChatGPT returned a creative draft.')
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'ChatGPT generation failed.')
    } finally {
      setLlmBusy(false)
    }
  }

  async function updateDirectionStatus(
    lineId: string,
    status: DirectionStatus,
    error?: string,
  ): Promise<ProjectState> {
    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = await window.studio.project.get()
      if (!currentState) throw new Error('Choose a project folder first.')
      const manifest = cloneManifest(currentState.manifest)
      const line = manifest.lines.find((candidate) => candidate.id === lineId)
      if (!line) throw new Error('The selected narration line no longer exists.')
      line.directionStatus = status
      line.directionError = error
      const state = await window.studio.project.save(manifest)
      setProject(state)
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
  ): Promise<{ state: ProjectState; line: ScriptLine }> {
    const workingState = await updateDirectionStatus(lineId, 'generating')
    const line = workingState.manifest.lines.find((candidate) => candidate.id === lineId)
    if (!line) throw new Error('The selected narration line no longer exists.')

    const result = await window.studio.llm.generate({
      prompt: buildContextualPromptRequest(fullState, line),
    })
    const prompt = parseSingleContextualPrompt(result.text, line)
    if (!prompt) {
      throw new Error(`ChatGPT did not return a usable prompt for line ${line.index + 1}.`)
    }

    const saveTask = promptSaveQueueRef.current.then(async () => {
      const currentState = (await window.studio.project.get()) || fullState
      const manifest = cloneManifest(currentState.manifest)
      const currentLine = manifest.lines.find((candidate) => candidate.id === lineId)
      if (!currentLine) throw new Error('The selected narration line no longer exists.')
      currentLine.sceneDescription = prompt
      currentLine.scenePrompt = composeScenePrompt(currentLine.text, prompt)
      currentLine.directionStatus = 'complete'
      currentLine.directionError = undefined
      currentLine.sceneStatus = 'draft'
      currentLine.error = undefined
      const state = await window.studio.project.save(manifest)
      setProject(state)
      const savedLine = state.manifest.lines.find((candidate) => candidate.id === lineId)
      if (!savedLine) throw new Error('The drafted narration line could not be saved.')
      return { state, line: savedLine }
    })
    promptSaveQueueRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    )
    return saveTask
  }

  async function generateContextualPrompts(
    baseState = project,
    startIndex = 0,
    onlyMissing = false,
  ): Promise<void> {
    if (!baseState || baseState.manifest.lines.length === 0) {
      showNotice('info', 'Import a script before drafting contextual scene prompts.')
      return
    }
    if (contextPromptsBusy) {
      showNotice('info', 'A scene direction is already being drafted. Wait for it to finish or cancel it first.')
      return
    }
    if (!llmStatus?.authenticated) {
      showNotice('info', 'Sign in to ChatGPT before drafting contextual scene prompts.')
      return
    }

    setContextPromptsBusy(true)
    cancelContextPromptsRef.current = false
    try {
      const linesToDraft = baseState.manifest.lines
        .slice(Math.max(0, startIndex))
        .filter((line) => !onlyMissing || !hasDirectionPrompt(line))
      if (linesToDraft.length === 0) {
        showNotice('info', 'There are no scenes to draft from the selected line.')
        return
      }
      const startedAt = Date.now()
      setContextPromptProgress({
        current: 0,
        total: linesToDraft.length,
        completed: 0,
        lineText: linesToDraft[0].text,
        startedAt,
      })
      let nextLineIndex = 0
      let completedCount = 0
      let failedCount = 0
      const runWorker = async (): Promise<void> => {
        while (true) {
          if (cancelContextPromptsRef.current) return
          const line = linesToDraft[nextLineIndex]
          nextLineIndex += 1
          if (!line) return

          setContextPromptProgress((current) => ({
            ...(current || {
              current: line.index + 1,
              total: linesToDraft.length,
              completed: completedCount,
              lineText: line.text,
              startedAt,
            }),
            current: line.index + 1,
            lineText: line.text,
            completed: completedCount,
          }))

          try {
            const drafted = await draftSingleLinePrompt(baseState, line.id)
            completedCount += 1
            if (!cancelContextPromptsRef.current) {
              void queueSceneForLine(drafted.state, drafted.line)
            }
          } catch (error) {
            failedCount += 1
            await updateDirectionStatus(
              line.id,
              cancelContextPromptsRef.current ? 'draft' : 'failed',
              error instanceof Error ? error.message : 'Direction generation failed.',
            ).catch(() => undefined)
          } finally {
            setContextPromptProgress((current) =>
              current
                ? {
                    ...current,
                    current: line.index + 1,
                    completed: completedCount,
                    lineText: line.text,
                  }
                : current,
            )
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(5, linesToDraft.length) }, () => runWorker()),
      )
      if (cancelContextPromptsRef.current) {
        showNotice('info', `Contextual prompt drafting cancelled. ${completedCount} completed lines were saved.`)
      } else if (failedCount > 0) {
        showNotice(
          'error',
          `ChatGPT drafted ${completedCount} scene prompt(s); ${failedCount} failed and can be retried.`,
        )
      } else {
        showNotice(
          'success',
          `ChatGPT drafted ${completedCount} contextual prompts across ${Math.min(5, linesToDraft.length)} concurrent agents.`,
        )
      }
    } catch (error) {
      if (cancelContextPromptsRef.current) {
        showNotice('info', 'Contextual prompt drafting cancelled. Completed lines were saved.')
        return
      }
      showNotice(
        'error',
        error instanceof Error ? error.message : 'Could not draft contextual scene prompts.',
      )
    } finally {
      cancelContextPromptsRef.current = false
      setContextPromptsBusy(false)
      setContextPromptProgress(null)
    }
  }

  async function cancelContextualPrompts(): Promise<void> {
    if (!contextPromptsBusy) return
    cancelContextPromptsRef.current = true
    await window.studio.llm.cancel().catch(() => undefined)
  }

  async function draftAndQueueRecordedLine(lineId: string): Promise<void> {
    if (activeDirectionLinesRef.current.has(lineId)) return
    if (!llmStatus?.authenticated) {
      showNotice('info', 'Voice line saved. Sign in to ChatGPT before generating its scene direction.')
      return
    }

    const state = await window.studio.project.get()
    const line = state?.manifest.lines.find((candidate) => candidate.id === lineId)
    if (!state || !line) return

    activeDirectionLinesRef.current.add(lineId)
    cancelContextPromptsRef.current = false
    setContextPromptsBusy(true)
    const startedAt = Date.now()
    setContextPromptProgress({
      current: line.index + 1,
      total: state.manifest.lines.length,
      completed: 0,
      lineText: line.text,
      startedAt,
    })

    try {
      if (cancelContextPromptsRef.current) return
      let drafted: { state: ProjectState; line: ScriptLine }
      try {
        drafted = await draftSingleLinePrompt(state, lineId)
      } catch (error) {
        if (!cancelContextPromptsRef.current) {
          await updateDirectionStatus(
            lineId,
            'failed',
            error instanceof Error ? error.message : 'Direction generation failed.',
          ).catch(() => undefined)
        }
        throw error
      }
      if (cancelContextPromptsRef.current) return
      setContextPromptProgress({
        current: drafted.line.index + 1,
        total: state.manifest.lines.length,
        completed: 1,
        lineText: drafted.line.text,
        startedAt,
      })
      const queued = await queueSceneForLine(drafted.state, drafted.line)
      if (queued) showNotice('success', `Scene ${drafted.line.index + 1} direction ready; image queued.`)
    } catch (error) {
      if (!cancelContextPromptsRef.current) {
        showNotice(
          'error',
          error instanceof Error ? error.message : `Could not draft scene ${line.index + 1}.`,
        )
      }
    } finally {
      activeDirectionLinesRef.current.delete(lineId)
      const stillDrafting = activeDirectionLinesRef.current.size > 0
      setContextPromptsBusy(stillDrafting)
      if (!stillDrafting) setContextPromptProgress(null)
    }
  }

  async function queueSceneForLine(state: ProjectState, line: ScriptLine): Promise<boolean> {
    const submitTask = imageSubmitQueueRef.current.then(async () => {
      try {
        const queuedState = await window.studio.higgs.queueScene({
          lineId: line.id,
          prompt: line.scenePrompt,
          modelEndpoint: higgsStatus?.modelEndpoint || 'nano_banana_2_lite',
          aspectRatio: '16:9',
          resolution: '1k',
        })
        setProject(queuedState)
        return true
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : `Could not queue scene ${line.index + 1}.`)
        return false
      }
    })
    imageSubmitQueueRef.current = submitTask.then(
      () => undefined,
      () => undefined,
    )
    return submitTask
  }

  async function queueImageBatch(scope: 'all' | 'from-here' | 'remaining'): Promise<void> {
    if (!project) return
    const state = (await window.studio.project.get()) || project
    const selectedIndex = selectedLine?.index || 0
    const scopedLines =
      scope === 'from-here'
        ? state.manifest.lines.slice(selectedIndex)
        : state.manifest.lines
    const candidates = scopedLines.filter((line) => {
      if (!hasDirectionPrompt(line)) return false
      return scope === 'remaining' ? !hasImage(line) : true
    })

    if (candidates.length === 0) {
      showNotice(
        'info',
        scope === 'remaining'
          ? 'There are no remaining direction-ready images to generate.'
          : 'There are no direction-ready scenes in that range.',
      )
      return
    }

    if (
      scope !== 'remaining' &&
      candidates.some((line) => hasImage(line)) &&
      !window.confirm(
        `This will regenerate ${candidates.filter((line) => hasImage(line)).length} existing image(s) and generate the rest. Continue?`,
      )
    ) {
      return
    }

    setImageBatchBusy(true)
    try {
      const results = await Promise.all(candidates.map((line) => queueSceneForLine(state, line)))
      const queuedCount = results.filter(Boolean).length
      showNotice('info', `${queuedCount} image generation(s) added to the Higgsfield queue.`)
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

  function updateManifest(mutator: (manifest: ProjectManifest) => void): void {
    setProject((current) => {
      if (!current) return current
      const next = cloneManifest(current.manifest)
      mutator(next)
      return { ...current, manifest: next }
    })
  }

  function recordingFocusPayload(
    line: ScriptLine,
    state: RecordingFocusPayload['state'],
    countdown: number | null,
    leadInSeconds: number,
  ): RecordingFocusPayload {
    return {
      text: line.text,
      lineNumber: line.index + 1,
      duration: line.duration,
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

  function stopSilenceDetection(): void {
    if (silenceCheckTimerRef.current !== null) {
      window.clearInterval(silenceCheckTimerRef.current)
      silenceCheckTimerRef.current = null
    }
    analyserRef.current = null
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }
  }

  function startSilenceDetection(stream: MediaStream, recorder: MediaRecorder): void {
    stopSilenceDetection()
    try {
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const startedAt = performance.now()
      const silenceDurationMs = 1000
      const minimumRecordingMs = 500
      let noiseFloor = 0.008
      let speechFrames = 0
      let speechDetected = false
      let silenceStartedAt: number | null = null

      audioContextRef.current = audioContext
      analyserRef.current = analyser
      void audioContext.resume().catch(() => undefined)
      silenceCheckTimerRef.current = window.setInterval(() => {
        if (recorder.state !== 'recording') return

        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
          const centered = (sample - 128) / 128
          sum += centered * centered
        }
        const volume = Math.sqrt(sum / samples.length)
        const threshold = Math.max(0.03, noiseFloor * 3)

        if (!speechDetected) {
          if (volume > threshold) {
            speechFrames += 1
          } else {
            speechFrames = 0
            noiseFloor = noiseFloor * 0.95 + volume * 0.05
          }
          if (speechFrames >= 3) speechDetected = true
          return
        }

        if (volume <= threshold) {
          silenceStartedAt ??= performance.now()
          if (
            performance.now() - silenceStartedAt >= silenceDurationMs &&
            performance.now() - startedAt >= minimumRecordingMs
          ) {
            stopRecording(true)
          }
        } else {
          silenceStartedAt = null
        }
      }, 50)
    } catch {
      // Recording still works if voice-activity monitoring is unavailable.
      stopSilenceDetection()
    }
  }

  async function startRecording(lineId: string, leadInSeconds = 3, force = false): Promise<void> {
    if (!force && (recordingLineId || countdownLineId)) return
    const line = project?.manifest.lines.find((candidate) => candidate.id === lineId)
    if (!line) return
    cancelRecordingRef.current = false
    advanceRecordingRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
        const shouldRestart = restartRecordingRef.current === lineId
        const shouldAdvance = advanceRecordingRef.current
        let nextLineId: string | null = null
        try {
          if (discarded) {
            if (!shouldRestart) {
              showNotice('info', 'Take discarded. The same line is ready to record again.')
            }
            return
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const state = await window.studio.project.saveRecording({
            lineId,
            data: await blob.arrayBuffer(),
            duration: (performance.now() - recordingStartedRef.current) / 1000,
            mimeType: blob.type,
          })
          await loadProject(state)
          const recordedLine = state.manifest.lines.find((candidate) => candidate.id === lineId)
          if (recordedLine) void draftAndQueueRecordedLine(recordedLine.id)
          const currentIndex = state.manifest.lines.find((line) => line.id === lineId)?.index || 0
          const nextLine = state.manifest.lines.find((line) => line.index === currentIndex + 1)
          nextLineId = nextLine?.id || null
          setActiveLineId(nextLine?.id || lineId)
          showNotice(
            'success',
            nextLine && shouldAdvance ? 'Saved. Starting the next line.' : nextLine ? 'Saved. The next line is ready.' : 'Voice line recorded.',
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
          if (shouldRestart) {
            showNotice('info', 'Redoing this line. Get ready for the 1-second lead-in.')
            window.setTimeout(() => void startRecording(lineId, 1, true), 0)
          } else if (shouldAdvance && nextLineId) {
            window.setTimeout(() => void startRecording(nextLineId as string, 0, true), 0)
          } else {
            hideTeleprompter()
          }
        }
      }
      streamRef.current = stream
      recorderRef.current = recorder
      if (leadInSeconds > 0) {
        setCountdownLineId(lineId)
        setCountdownLeadInSeconds(leadInSeconds)
        showTeleprompter(recordingFocusPayload(line, 'countdown', leadInSeconds, leadInSeconds))
        for (let count = leadInSeconds; count > 0; count -= 1) {
          setCountdownValue(count)
          updateTeleprompter(recordingFocusPayload(line, 'countdown', count, leadInSeconds))
          await new Promise((resolve) => window.setTimeout(resolve, 1000))
          if (cancelRecordingRef.current) {
            const shouldRestart = restartRecordingRef.current === lineId
            stream.getTracks().forEach((track) => track.stop())
            streamRef.current = null
            recorderRef.current = null
            setCountdownLineId(null)
            setCountdownValue(null)
            setCountdownLeadInSeconds(null)
            cancelRecordingRef.current = false
            restartRecordingRef.current = null
            if (shouldRestart) {
              window.setTimeout(() => void startRecording(lineId, 1, true), 0)
            } else {
              hideTeleprompter()
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
      updateTeleprompter(recordingFocusPayload(line, 'recording', null, leadInSeconds))
      recorder.start()
      startSilenceDetection(stream, recorder)
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
      hideTeleprompter()
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

  function cancelRecording(): void {
    if (!recordingLineId && !countdownLineId) return
    const lineId = recordingLineId || countdownLineId
    if (!lineId) return
    const line = project?.manifest.lines.find((candidate) => candidate.id === lineId)
    restartRecordingRef.current = lineId
    cancelRecordingRef.current = true
    if (line) updateTeleprompter(recordingFocusPayload(line, 'countdown', 1, 1))
    if (recorderRef.current?.state === 'recording') {
      stopSilenceDetection()
      recorderRef.current.stop()
      return
    }

    setCountdownLineId(null)
    setCountdownValue(null)
    setCountdownLeadInSeconds(null)
    showNotice('info', 'Redoing this line. Get ready for the 1-second lead-in.')
  }

  async function generateScene(line: ScriptLine): Promise<ProjectState | null> {
    if (!project) return null
    setGeneratingLineId(line.id)
    try {
      const currentState = await window.studio.higgs.generateScene({
        lineId: line.id,
        prompt: line.scenePrompt,
        modelEndpoint: higgsStatus?.modelEndpoint || 'nano_banana_2_lite',
        aspectRatio: '16:9',
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
    const pendingLines = project.manifest.lines.filter((line) => line.sceneStatus !== 'complete')
    if (pendingLines.length === 0) {
      showNotice('info', 'Every scene already has a visual.')
      return
    }
    if (
      !window.confirm(
        `This will submit ${pendingLines.length} Higgsfield generations. Continue only if the prompts and credit budget are approved.`,
      )
    ) {
      return
    }

    for (const line of pendingLines) {
      const result = await generateScene(line)
      if (!result) break
    }
  }

  async function exportLongform(): Promise<void> {
    setExporting(true)
    try {
      const result = await window.studio.export.longform()
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

  const projectName = project?.manifest.name || 'Untitled production'
  const activeLabel = navItems.find((item) => item.id === activeSection)?.label || 'Production board'
  const currentActivity = (() => {
    const lineFor = (lineId: string | null) => project?.manifest.lines.find((line) => line.id === lineId)
    const lineText = (lineId: string | null) => {
      const line = lineFor(lineId)
      return line ? `Line ${line.index + 1}: ${line.text}` : 'Current clip'
    }

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
        detail: 'Rendering the longform timeline and mastering audio.',
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
    if (contextPromptsBusy) {
      return {
        active: true,
        label: 'Generating scene directions',
        detail: contextPromptProgress
          ? `Up to 5 agents · line ${contextPromptProgress.current} of ${contextPromptProgress.total}: ${contextPromptProgress.lineText}`
          : 'Up to 5 ChatGPT agents are drafting contextual prompts.',
      }
    }

    const generatingImages = project.manifest.lines.filter((line) => line.sceneStatus === 'generating').length
    const queuedImages = project.manifest.lines.filter((line) => line.sceneStatus === 'queued').length
    if (imageBatchBusy || generatingImages > 0 || queuedImages > 0) {
      return {
        active: true,
        label: imageBatchBusy && generatingImages === 0 ? 'Queuing Higgsfield images' : 'Generating Higgsfield images',
        detail: `${generatingImages} rendering · ${queuedImages} queued`,
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

        <nav className="main-nav" aria-label="Production workflow">
          <div className="eyebrow nav-eyebrow">Workflow</div>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`nav-item ${activeSection === item.id ? 'active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.id === 'script' && project ? <span className="nav-count">{project.manifest.lines.length}</span> : null}
                {item.id === 'visuals' && project ? <span className="nav-count">{visualCount}/{project.manifest.lines.length}</span> : null}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <div className={`connection-pill ${higgsStatus?.configured ? 'connected' : ''}`}>
            <span className="status-dot" />
            <span>{higgsStatus?.configured ? 'Higgsfield connected' : 'Higgsfield not connected'}</span>
          </div>
          <button className="footer-button" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} />
            <span>Connection settings</span>
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
            project={project}
            activeLineId={activeLineId}
            assetSources={assetSources}
            locked={Boolean(recordingLineId || countdownLineId)}
            onSelectLine={setActiveLineId}
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

        {!project ? (
          <EmptyProject onChoose={() => void chooseProject()} />
        ) : (
          <div className="workspace">
            {activeSection === 'overview' ? (
              <Overview
                project={project}
                recordedCount={recordedCount}
                visualCount={visualCount}
                totalDuration={totalDuration}
                higgsConfigured={Boolean(higgsStatus?.configured)}
                llmStatus={llmStatus}
                llmPrompt={llmPrompt}
                llmOutput={llmOutput}
                llmBusy={llmBusy}
                onImportScript={() => void importScript()}
                onNavigate={setActiveSection}
                onConnect={() => setSettingsOpen(true)}
                onLlmPromptChange={setLlmPrompt}
                onLlmLogin={() => void startLlmLogin()}
                onLlmGenerate={() => void generateWithChatGpt()}
                onExport={() => void exportLongform()}
                exporting={exporting}
              />
            ) : null}
            {activeSection === 'script' ? (
              <ScriptWorkspace
                project={project}
                activeLineId={activeLineId}
                recordingLineId={recordingLineId}
                countdownLineId={countdownLineId}
                countdownValue={countdownValue}
                countdownLeadInSeconds={countdownLeadInSeconds}
                audioSources={assetSources}
                onSelectLine={setActiveLineId}
                onImportScript={() => void importScript()}
                onImportScriptText={(script) => void importScriptText(script)}
                onStartRecording={(lineId) => void startRecording(lineId)}
                onStopRecording={stopRecording}
                onCancelRecording={cancelRecording}
                onUpdateLine={(lineId, text) =>
                  updateManifest((manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === lineId)
                    if (line) line.text = text
                  })
                }
                onSave={() => void saveProject()}
              />
            ) : null}
            {activeSection === 'visuals' ? (
              <VisualWorkspace
                project={project}
                selectedLine={selectedLine}
                activeLineId={activeLineId}
                assetSources={assetSources}
                higgsStatus={higgsStatus}
                llmStatus={llmStatus}
                contextPromptsBusy={contextPromptsBusy}
                contextPromptProgress={contextPromptProgress}
                imageBatchBusy={imageBatchBusy}
                onSelectLine={setActiveLineId}
                onUpdateBible={(key, value) =>
                  updateManifest((manifest) => {
                    manifest.visualBible[key] = value
                  })
                }
                onUpdatePrompt={(value) =>
                  selectedLine &&
                  updateManifest((manifest) => {
                    const line = manifest.lines.find((candidate) => candidate.id === selectedLine.id)
                    if (line) {
                      line.scenePrompt = value
                      line.sceneDescription = undefined
                      line.directionStatus =
                        value.trim() && value.trim() !== composeScenePrompt(line.text).trim() ? 'complete' : 'draft'
                      line.directionError = undefined
                      line.sceneStatus = 'draft'
                    }
                  })
                }
                onSave={() => void saveProject()}
                onGenerateAllPrompts={() => void generateContextualPrompts(project, 0, false)}
                onGeneratePromptsFromHere={() =>
                  selectedLine && void generateContextualPrompts(project, selectedLine.index, false)
                }
                onGenerateRemainingPrompts={() => void generateContextualPrompts(project, 0, true)}
                onGenerateSelectedImage={() =>
                  selectedLine && project && void queueSceneForLine(project, selectedLine)
                }
                onGenerateAllImages={() => void queueImageBatch('all')}
                onGenerateImagesFromHere={() => void queueImageBatch('from-here')}
                onGenerateRemainingImages={() => void queueImageBatch('remaining')}
                onCancelContextPrompts={() => void cancelContextualPrompts()}
                onLlmLogin={() => void startLlmLogin()}
                onConnect={() => setSettingsOpen(true)}
              />
            ) : null}
            {activeSection === 'timeline' ? (
              <TimelineWorkspace
                project={project}
                activeLineId={activeLineId}
                assetSources={assetSources}
                onSelectLine={setActiveLineId}
              />
            ) : null}
            {activeSection === 'export' ? (
              <ExportWorkspace
                project={project}
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
          busy={higgsAuthBusy}
          onLogin={() => void loginHiggs()}
          onRefresh={() => void refreshHiggsStatus()}
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
        <span>Plan</span>
        <ChevronRight size={13} />
        <span>02</span>
        <span>Record</span>
        <ChevronRight size={13} />
        <span>03</span>
        <span>Generate</span>
      </div>
    </div>
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
  onImportScript,
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
  onImportScript: () => void
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
        <StatCard label="Output format" value="16:9" detail="1920 × 1080 · 30 fps" icon={Clapperboard} />
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
            <WorkflowStep number="01" title="Import the narration" detail="Split your script into editable voice lines." done={project.manifest.lines.length > 0} onClick={onImportScript} action="Import script" />
            <WorkflowStep number="02" title="Record each line" detail="Keep your natural timing as the source of truth." done={recordedCount === project.manifest.lines.length && recordedCount > 0} onClick={() => onNavigate('script')} action="Open recorder" />
            <WorkflowStep number="03" title="Generate approved visuals" detail="Edit prompts, then send only approved scenes to Higgsfield." done={visualCount === project.manifest.lines.length && visualCount > 0} onClick={() => onNavigate('visuals')} action="Open visuals" />
            <WorkflowStep number="04" title="Export the longform cut" detail="Combine visuals and voice with dialogue-first mastering." done={false} onClick={() => onNavigate('export')} action="Review export" />
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
              {higgsConfigured ? 'Manage connection' : 'Open connection settings'} <ChevronRight size={14} />
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
              placeholder="Example: Create 5 viral stickman explainer ideas about the history of fire. Include a hook, premise, and visual direction for each."
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
              <button className="button button-primary" onClick={onLlmGenerate} disabled={llmBusy || !llmStatus?.authenticated || !llmPrompt.trim()}>
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
  activeLineId,
  recordingLineId,
  countdownLineId,
  countdownValue,
  countdownLeadInSeconds,
  audioSources,
  onSelectLine,
  onImportScript,
  onImportScriptText,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onUpdateLine,
  onSave,
}: {
  project: ProjectState
  activeLineId: string | null
  recordingLineId: string | null
  countdownLineId: string | null
  countdownValue: number | null
  countdownLeadInSeconds: number | null
  audioSources: Record<string, string>
  onSelectLine: (id: string) => void
  onImportScript: () => void
  onImportScriptText: (script: string) => void
  onStartRecording: (id: string) => void
  onStopRecording: (advance?: boolean) => void
  onCancelRecording: () => void
  onUpdateLine: (id: string, text: string) => void
  onSave: () => void
}) {
  const selectedLine = project.manifest.lines.find((line) => line.id === activeLineId) || project.manifest.lines[0]
  const [showPaste, setShowPaste] = useState(project.manifest.lines.length === 0)
  const [pastedScript, setPastedScript] = useState('')
  const isRecording = recordingLineId === selectedLine?.id
  const isCountingDown = countdownLineId === selectedLine?.id

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">02 · Script & voice</div>
          <h1>Record the source of truth.</h1>
          <p>Each line becomes a timed clip. Your real delivery sets the rhythm for every visual.</p>
        </div>
        <div className="heading-actions">
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
                  ? 'Recording current line'
                  : `Current line · ${String(selectedLine.index + 1).padStart(2, '0')}`}
            </span>
            <span className="recording-focus-time">{formatTime(selectedLine.duration)}</span>
          </div>
          <div className="recording-focus-copy">
            {isCountingDown ? <div className="recording-countdown">{countdownValue}</div> : null}
            <p>{selectedLine.text}</p>
          </div>
          <div className="recording-focus-hint">
            {isRecording
              ? 'Silence auto-saves and starts the next line · Enter does it now · Spacebar stops · Escape redoes this line'
              : isCountingDown
                ? 'Press Escape to restart with a 1-second lead-in'
                : 'Read this line naturally. Start the take from the recording card below.'}
          </div>
        </section>
      ) : null}

      <div className="workspace-grid script-workspace">
        <section className="panel script-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Narration queue</div>
              <h2>{project.manifest.lines.length} lines · {formatTime(project.manifest.lines.reduce((sum, line) => sum + line.duration, 0))}</h2>
            </div>
            <span className="subtle-label">150 WPM estimate until recorded</span>
          </div>
          {showPaste ? (
            <div className="paste-panel">
              <div className="paste-panel-heading">
                <div>
                  <strong>Paste your narration</strong>
                  <span>Paste a transcript, draft, or timestamped script. Higgsfilm will split it into editable lines.</span>
                </div>
                <FileText size={18} />
              </div>
              <textarea
                className="text-area paste-area"
                value={pastedScript}
                onChange={(event) => setPastedScript(event.target.value)}
                placeholder="Paste your script here..."
                autoFocus
              />
              <div className="paste-panel-footer">
                <span>Sentence punctuation such as .?! creates new lines.</span>
                <button
                  className="button button-primary"
                  disabled={!pastedScript.trim()}
                  onClick={() => {
                    onImportScriptText(pastedScript)
                    setShowPaste(false)
                  }}
                >
                  <Sparkles size={15} />
                  Create narration lines
                </button>
              </div>
            </div>
          ) : null}
          {project.manifest.lines.length === 0 && !showPaste ? (
            <div className="empty-panel">
              <FileText size={22} />
              <strong>Your script is waiting.</strong>
              <span>Paste a script or import a text file to create editable narration lines.</span>
              <button className="button button-secondary" onClick={onImportScript}>Import script</button>
            </div>
          ) : project.manifest.lines.length > 0 ? (
            <div className="line-list">
              {project.manifest.lines.map((line) => (
                <button
                  className={`line-row ${line.id === selectedLine?.id ? 'selected' : ''}`}
                  key={line.id}
                  disabled={Boolean(recordingLineId || countdownLineId)}
                  onClick={() => onSelectLine(line.id)}
                >
                  <span className="line-index">{String(line.index + 1).padStart(2, '0')}</span>
                  <span className="line-row-copy">
                    <strong>{line.text}</strong>
                    <span>{formatTime(line.startTime)} → {formatTime(line.endTime)}</span>
                  </span>
                  <span className={`line-status ${line.status}`}>
                    {line.status === 'recorded' ? <Check size={13} /> : <span className="status-dot" />}
                    {line.status === 'recorded' ? 'Recorded' : 'Draft'}
                  </span>
                  <ChevronRight size={15} className="line-chevron" />
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel inspector-panel">
          {selectedLine ? (
            <>
              <div className="panel-header inspector-header">
                <div>
                  <div className="eyebrow">Line {String(selectedLine.index + 1).padStart(2, '0')}</div>
                  <h2>Voice performance</h2>
                </div>
                <span className="time-chip">{formatTime(selectedLine.duration)}</span>
              </div>
              <label className="field-label" htmlFor="line-copy">Narration copy</label>
              <textarea
                id="line-copy"
                className="text-area line-copy-area"
                value={selectedLine.text}
                onChange={(event) => onUpdateLine(selectedLine.id, event.target.value)}
              />
              <div className="record-card">
                <div className="record-card-top">
                  <div className="record-icon">
                    {isCountingDown ? <LoaderCircle size={17} className="spin" /> : isRecording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
                  </div>
                  <div>
                    <strong>{isCountingDown ? `Starting in ${countdownValue ?? 3}` : isRecording ? 'Recording this line' : selectedLine.voicePath ? 'Take recorded' : 'Record a take'}</strong>
                    <span>{isCountingDown ? 'Get ready to speak.' : isRecording ? 'Stop speaking for about 1 second to save and start the next line. Enter does it now.' : 'Record, listen back, and re-record until it feels right.'}</span>
                  </div>
                </div>
                {isCountingDown ? (
                  <button className="button button-quiet" onClick={onCancelRecording}>
                    <X size={14} />
                    Restart with 1-second lead-in
                  </button>
                ) : isRecording ? (
                  <div className="record-card-actions">
                    <button className="button button-recording" onClick={() => onStopRecording(true)}>
                      <Check size={14} />
                      Save take &amp; next
                    </button>
                    <button className="button button-quiet" onClick={onCancelRecording}>
                      <X size={14} />
                      Redo
                    </button>
                  </div>
                ) : (
                  <button className="button button-primary" onClick={() => onStartRecording(selectedLine.id)}>
                    <Mic size={15} />
                    {selectedLine.voicePath ? 'Record new take' : 'Start recording'}
                  </button>
                )}
                {selectedLine.voicePath && audioSources[selectedLine.voicePath] ? (
                  <audio className="audio-player" controls src={audioSources[selectedLine.voicePath]} />
                ) : null}
              </div>
              <div className="inspector-note">
                <AlertCircle size={15} />
                <span>After you speak, about 1 second of silence saves and advances automatically. Enter advances immediately; Spacebar stops; Escape redoes the line with a 1-second lead-in.</span>
              </div>
            </>
          ) : (
            <div className="empty-panel">
              <Mic size={22} />
              <strong>Select a line to record.</strong>
              <span>Your recorded voice becomes the timing spine of the production.</span>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function VisualWorkspace({
  project,
  selectedLine,
  activeLineId,
  assetSources,
  higgsStatus,
  llmStatus,
  contextPromptsBusy,
  contextPromptProgress,
  imageBatchBusy,
  onSelectLine,
  onUpdateBible,
  onUpdatePrompt,
  onSave,
  onGenerateAllPrompts,
  onGeneratePromptsFromHere,
  onGenerateRemainingPrompts,
  onGenerateSelectedImage,
  onGenerateAllImages,
  onGenerateImagesFromHere,
  onGenerateRemainingImages,
  onCancelContextPrompts,
  onLlmLogin,
  onConnect,
}: {
  project: ProjectState
  selectedLine?: ScriptLine
  activeLineId: string | null
  assetSources: Record<string, string>
  higgsStatus: HiggsConnectionStatus | null
  llmStatus: LlmConnectionStatus | null
  contextPromptsBusy: boolean
  contextPromptProgress: ContextPromptProgress | null
  imageBatchBusy: boolean
  onSelectLine: (id: string) => void
  onUpdateBible: (key: keyof ProjectManifest['visualBible'], value: string) => void
  onUpdatePrompt: (value: string) => void
  onSave: () => void
  onGenerateAllPrompts: () => void
  onGeneratePromptsFromHere: () => void
  onGenerateRemainingPrompts: () => void
  onGenerateSelectedImage: () => void
  onGenerateAllImages: () => void
  onGenerateImagesFromHere: () => void
  onGenerateRemainingImages: () => void
  onCancelContextPrompts: () => void
  onLlmLogin: () => void
  onConnect: () => void
}) {
  const [showBible, setShowBible] = useState(true)
  const [promptElapsedSeconds, setPromptElapsedSeconds] = useState(0)

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

  const selectedLinePosition = selectedLine
    ? project.manifest.lines.findIndex((line) => line.id === selectedLine.id)
    : -1
  const previousLine = selectedLinePosition > 0 ? project.manifest.lines[selectedLinePosition - 1] : undefined
  const nextLine =
    selectedLinePosition >= 0 && selectedLinePosition < project.manifest.lines.length - 1
      ? project.manifest.lines[selectedLinePosition + 1]
      : undefined

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">03 · Visual direction</div>
          <h1>Turn narration into scenes.</h1>
            <p>Let ChatGPT read the full script, resolve character context, refine each prompt, then approve generations one scene at a time.</p>
        </div>
        <div className="heading-actions">
          {contextPromptProgress ? (
            <div className="prompt-draft-progress" role="status" aria-live="polite">
              <div className="prompt-draft-progress-heading">
                <span>
                  ChatGPT drafting line {contextPromptProgress.current} of {contextPromptProgress.total}
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
                    <img src={assetSources[line.imagePath]} alt="" />
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
              <textarea className="text-area prompt-area" value={selectedLine.scenePrompt} onChange={(event) => onUpdatePrompt(event.target.value)} />
              <div className="scene-preview-large">
                {selectedLine.imagePath && assetSources[selectedLine.imagePath] ? (
                  <img src={assetSources[selectedLine.imagePath]} alt={`Generated scene for line ${selectedLine.index + 1}`} />
                ) : (
                  <div className="scene-preview-empty">
                    <ImageIcon size={28} />
                    <strong>{hasDirectionPrompt(selectedLine) ? 'Image not generated yet' : 'Generate a direction prompt first'}</strong>
                    <span>The finished scene preview will appear here.</span>
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
                  Clip {selectedLinePosition + 1} of {project.manifest.lines.length}
                </span>
                <button
                  className="button button-quiet"
                  onClick={() => nextLine && onSelectLine(nextLine.id)}
                  disabled={!nextLine}
                >
                  Next clip
                  <ChevronRight size={15} />
                </button>
              </div>
              <div className="generation-actions">
                <div className="generation-action-group">
                  <div className="generation-action-heading">
                    <div>
                      <span className="eyebrow">Scene direction</span>
                      <strong>
                        {project.manifest.lines.filter(hasDirectionPrompt).length}/{project.manifest.lines.length} prompts ready
                      </strong>
                    </div>
                    <span className={`status-pill ${directionStatusOf(selectedLine)}`}>
                      {directionStatusLabel(selectedLine)}
                    </span>
                  </div>
                  <div className="generation-action-row">
                    {llmStatus?.authenticated ? (
                      <>
                        <button
                          className="button button-secondary"
                          onClick={contextPromptsBusy ? onCancelContextPrompts : onGenerateAllPrompts}
                          disabled={!contextPromptsBusy && project.manifest.lines.length === 0}
                        >
                          {contextPromptsBusy ? <X size={15} /> : <Sparkles size={15} />}
                          {contextPromptsBusy ? 'Cancel drafting' : 'Generate all prompts'}
                        </button>
                        <button className="button button-quiet" onClick={onGeneratePromptsFromHere} disabled={contextPromptsBusy}>
                          <Sparkles size={15} />
                          Generate prompts from here
                        </button>
                        <button className="button button-quiet" onClick={onGenerateRemainingPrompts} disabled={contextPromptsBusy}>
                          <RefreshCw size={15} />
                          Generate remaining prompts
                        </button>
                      </>
                    ) : (
                      <button className="button button-secondary" onClick={onLlmLogin} disabled={contextPromptsBusy}>
                        <Sparkles size={15} />
                        Sign in to generate prompts
                      </button>
                    )}
                  </div>
                </div>
                <div className="generation-action-group">
                  <div className="generation-action-heading">
                    <div>
                      <span className="eyebrow">Higgsfield images</span>
                      <strong>
                        {project.manifest.lines.filter(hasImage).length}/{project.manifest.lines.length} images ready
                      </strong>
                    </div>
                    <span className={`status-pill ${selectedLine.sceneStatus}`}>
                      {hasImage(selectedLine) ? 'Image ready' : statusLabel(selectedLine.sceneStatus)}
                    </span>
                  </div>
                  <div className="generation-action-row">
                    {higgsStatus?.configured ? (
                      <>
                        <button className="button button-primary" onClick={onGenerateSelectedImage} disabled={imageBatchBusy}>
                          {imageBatchBusy ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
                          Generate selected image
                        </button>
                        <button className="button button-secondary" onClick={onGenerateAllImages} disabled={imageBatchBusy}>
                          <WandSparkles size={15} />
                          Generate all images
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
                      <button className="button button-secondary" onClick={onConnect}>
                        <Settings2 size={15} />
                        Connect Higgsfield
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="prompt-footer">
                <div className="model-summary">
                  <span><Sparkles size={14} /> {higgsStatus?.modelEndpoint || 'nano_banana_2_lite'}</span>
                  <span>16:9 · 1K</span>
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
  onSelectLine,
}: {
  project: ProjectState
  activeLineId: string | null
  assetSources: Record<string, string>
  locked: boolean
  onSelectLine: (id: string) => void
}) {
  const lines = project.manifest.lines
  const totalDuration = lines.reduce((sum, line) => sum + line.duration, 0)

  return (
    <section className="pinned-timeline" aria-label="Pinned voice and visual timeline">
      <div className="pinned-timeline-header">
        <div className="pinned-timeline-title">
          <span className="eyebrow">Pinned timeline</span>
          <strong>{lines.length ? `${lines.length} voice lines · ${formatTime(totalDuration)}` : 'Waiting for a script'}</strong>
        </div>
        <div className="pinned-timeline-legend">
          <span><i className="legend-dot voice-dot" /> Voice + scene clips</span>
          <span className="pinned-timeline-hint">Select a clip to inspect it</span>
        </div>
      </div>

      {lines.length ? (
        <div className="pinned-timeline-lane">
          {lines.map((line) => (
            <button
              key={`pinned-clip-${line.id}`}
              className={`pinned-clip ${line.id === activeLineId ? 'selected' : ''} ${line.sceneStatus === 'complete' ? 'ready' : ''}`}
              style={{ flex: `${Math.max(line.duration / Math.max(totalDuration, 0.1), 0.02)} 1 0` }}
              disabled={locked && line.id !== activeLineId}
              onClick={() => onSelectLine(line.id)}
              title={line.text}
            >
              <div className="pinned-clip-preview">
                {line.imagePath && assetSources[line.imagePath] ? (
                  <img src={assetSources[line.imagePath]} alt="" />
                ) : (
                  <ImageIcon size={18} />
                )}
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
          ))}
        </div>
      ) : (
        <div className="pinned-timeline-empty">
          <Clapperboard size={14} />
          <span>Import or paste a script to populate the pinned timeline.</span>
        </div>
      )}
    </section>
  )
}

function TimelineWorkspace({
  project,
  activeLineId,
  assetSources,
  onSelectLine,
}: {
  project: ProjectState
  activeLineId: string | null
  assetSources: Record<string, string>
  onSelectLine: (id: string) => void
}) {
  const totalDuration = project.manifest.lines.reduce((sum, line) => sum + line.duration, 0)
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">04 · Timeline</div>
          <h1>See the cut take shape.</h1>
          <p>Voice is the timing spine. Visuals, music, and graphics will layer on top of it.</p>
        </div>
        <div className="heading-actions">
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
          <span className="subtle-label">Click any clip to inspect it</span>
        </div>
        {project.manifest.lines.length === 0 ? (
          <div className="empty-panel timeline-empty">
            <Clapperboard size={22} />
            <strong>Your timeline is empty.</strong>
            <span>Import a script and record your first line to establish the edit.</span>
          </div>
        ) : (
          <div className="timeline-canvas">
            <div className="timeline-ruler">
              <span>00:00</span>
              <span>{formatTime(totalDuration / 2)}</span>
              <span>{formatTime(totalDuration)}</span>
            </div>
            <TimelineTrack label="VOICE" className="voice-track">
              {project.manifest.lines.map((line) => (
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
              {project.manifest.lines.map((line) => (
                <TimelineClip
                  key={line.id}
                  line={line}
                  totalDuration={totalDuration}
                  selected={line.id === activeLineId}
                  onClick={() => onSelectLine(line.id)}
                  type="visual"
                  imageSource={line.imagePath ? assetSources[line.imagePath] : undefined}
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
}: {
  line: ScriptLine
  totalDuration: number
  selected: boolean
  onClick: () => void
  type: 'voice' | 'visual'
  imageSource?: string
}) {
  return (
    <button
      className={`timeline-clip ${type} ${selected ? 'selected' : ''} ${line.sceneStatus === 'complete' ? 'ready' : ''}`}
      style={{ flex: `${Math.max(line.duration / Math.max(totalDuration, 0.1), 0.02)} 1 0` }}
      onClick={onClick}
      title={line.text}
    >
      {type === 'visual' && imageSource ? <img src={imageSource} alt="" /> : null}
      <span className="timeline-clip-index">{String(line.index + 1).padStart(2, '0')}</span>
      <span className="timeline-clip-text">{type === 'voice' ? line.text : line.sceneStatus === 'complete' ? 'Visual ready' : 'Awaiting visual'}</span>
      <small>{formatTime(line.duration)}</small>
    </button>
  )
}

function ExportWorkspace({
  project,
  recordedCount,
  visualCount,
  totalDuration,
  exporting,
  onExport,
}: {
  project: ProjectState
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
          <div className="eyebrow">05 · Export</div>
          <h1>Make the first cut.</h1>
          <p>Higgsfilm will hold each visual for its voice line, then apply dialogue-first mastering.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-primary button-large" onClick={onExport} disabled={exporting || visualCount === 0}>
            {exporting ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
            {exporting ? 'Rendering MP4' : 'Export longform MP4'}
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
              <span>{formatTime(totalDuration)} · 1920 × 1080 · 30 fps</span>
            </div>
          </div>
          <div className="export-caption">
            <div>
              <div className="eyebrow">Mastering preset</div>
              <h2>Dialogue-first / YouTube safe</h2>
            </div>
            <span className="lufs-chip">-16 LUFS</span>
          </div>
          <p className="panel-intro">The local FFmpeg renderer normalizes the voice track and limits true peak to -1.5 dB before writing the MP4.</p>
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
  busy,
  onLogin,
  onRefresh,
  onClose,
}: {
  status: HiggsConnectionStatus | null
  busy: boolean
  onLogin: () => void
  onRefresh: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-header">
          <div>
            <div className="eyebrow">Connection settings</div>
            <h2 id="settings-title">Higgsfield CLI OAuth</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </div>
        <p className="modal-intro">
          Sign in through the official Higgsfield CLI. Higgsfilm never asks for or stores an API key, so generation uses the credits attached to your Higgsfield account.
        </p>
        <div className="connection-summary">
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
