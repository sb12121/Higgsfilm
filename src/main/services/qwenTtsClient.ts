import { createHash, randomInt, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  QwenTtsGenerateInput,
  QwenTtsProgress,
  QwenParagraphMaster,
  QwenTtsStatus,
  ScriptLine,
  SequenceId,
} from '../../shared/types'
import { stillCastLineVocalExpression } from '../../shared/qwenVocalTone'
import { normalizeComfyUiSettings } from '../../shared/types'
import { splitParagraphAudio, type AudioCue } from './audioSegmenter'
import {
  shouldUseQwenLineFallback,
  verifyQwenTranscript,
  type QwenAlignmentResult,
} from './qwenAlignment'
import { QwenAligner } from './qwenAligner'
import { ProjectStore } from './projectStore'
import { AppSettingsStore } from './appSettingsStore'

export const QWEN_TTS_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base'
export const STILL_CAST_QWEN_MAX_NEW_TOKENS = 512

const QWEN_DIRECTORY = '.higgsfilm-qwen-tts'
const QWEN_CONFIG_FILE = 'config.json'
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_TEXT = 20_000
const MAX_AUDIO_BYTES = 4 * 1024 * 1024 * 1024
const POLL_MS = 1000
const TIMEOUT_MS = 30 * 60 * 1000
const REFERENCE_EXTENSIONS = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'] as const

type ReferenceExtension = (typeof REFERENCE_EXTENSIONS)[number]

interface QwenConfig {
  version: 1
  referenceText: string
  referenceFile?: string
  referenceMime?: string
  referenceOriginalName?: string
  referenceByteLength?: number
  referenceUpdatedAt?: string
}

interface QwenAudioResult {
  bytes: Buffer
  mime: string
  durationMs: number
}

interface ComfyMediaResult {
  filename?: string
  subfolder?: string
  type?: string
}

interface ComfyHistoryEntry {
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
  outputs?: Record<string, { audio?: ComfyMediaResult[] }>
}

interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
}

type Workflow = Record<string, WorkflowNode>
type ProgressListener = (progress: QwenTtsProgress) => void

export class QwenTtsError extends Error {
  override readonly name = 'QwenTtsError'

  constructor(message: string) {
    super(message)
  }
}

export interface QwenAlignerLike {
  getStatus(): ReturnType<QwenAligner['getStatus']>
  align(
    audioPath: string,
    text: string,
    signal?: AbortSignal,
    language?: string,
  ): ReturnType<QwenAligner['align']>
}

export class QwenTtsClient {
  private readonly listeners = new Set<ProgressListener>()
  private activeController: AbortController | null = null
  private readonly aligner: QwenAlignerLike

  constructor(
    private readonly projectStore: ProjectStore,
    private readonly settings: AppSettingsStore,
    aligner: QwenAlignerLike = new QwenAligner(),
  ) {
    this.aligner = aligner
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getStatus(): Promise<QwenTtsStatus> {
    const comfyUrl = normalizeComfyUrl(normalizeComfyUiSettings(this.settings.get().comfy).baseUrl)
    const alignment = await this.aligner.getStatus()
    const state = this.projectStore.get()
    if (!state) {
      return {
        configured: false,
        model: QWEN_TTS_MODEL,
        comfyUrl,
        alignment,
        referenceText: '',
      }
    }
    const config = await this.readConfig(state.rootPath)
    return this.statusFromConfig(config, comfyUrl, alignment)
  }

  async saveReferenceFile(filePath: string): Promise<QwenTtsStatus> {
    const rootPath = this.projectStore.getRootPath()
    const info = await fs.stat(filePath).catch(() => null)
    if (!info?.isFile()) throw new QwenTtsError('Choose a valid audio reference file.')
    if (info.size < 1) throw new QwenTtsError('The QWEN voice reference is empty.')
    if (info.size > MAX_REFERENCE_BYTES) {
      throw new QwenTtsError('Keep the QWEN voice reference under 20 MB.')
    }

    const originalName = path.basename(filePath)
    const extension = extensionForName(originalName)
    if (!extension) {
      throw new QwenTtsError('Use a WAV, MP3, M4A, FLAC, OGG, or WebM voice reference.')
    }
    const mime = mimeForExtension(extension)
    const directory = await ensureQwenDirectory(rootPath)
    const previous = await this.readConfig(rootPath)
    const referenceFile = `reference.${extension}`
    const targetPath = path.join(directory, referenceFile)
    await fs.writeFile(targetPath, await fs.readFile(filePath))
    if (previous.referenceFile && previous.referenceFile !== referenceFile) {
      await fs.rm(path.join(directory, previous.referenceFile), { force: true })
    }
    const config: QwenConfig = {
      ...previous,
      version: 1,
      referenceFile,
      referenceMime: mime,
      referenceOriginalName: safeDisplayName(originalName, referenceFile),
      referenceByteLength: info.size,
      referenceUpdatedAt: new Date().toISOString(),
    }
    await this.writeConfig(rootPath, config)
    return this.getStatus()
  }

  async saveReferenceText(referenceText: string): Promise<QwenTtsStatus> {
    const rootPath = this.projectStore.getRootPath()
    const text = referenceText.trim()
    if (text.length > MAX_REFERENCE_TEXT) {
      throw new QwenTtsError('The QWEN reference transcript is too long.')
    }
    const previous = await this.readConfig(rootPath)
    await this.writeConfig(rootPath, { ...previous, version: 1, referenceText: text })
    return this.getStatus()
  }

  async generate(input: QwenTtsGenerateInput): Promise<import('../../shared/types').ProjectState> {
    if (this.activeController) throw new QwenTtsError('QWEN voice generation is already running.')
    const state = this.projectStore.get()
    if (!state) throw new QwenTtsError('Choose a project folder before generating QWEN voice.')

    const sequence = input.sequence || 'main'
    const sequenceManifest = this.projectStore.getSequenceManifest(sequence)
    const stillCastTones = usesStillCastVoiceTones(
      sequenceManifest.lines,
      this.settings.getActiveChannelProfile()?.productionMode,
    )
    const groups = voiceGroups(sequenceManifest.lines, stillCastTones)
    const selectedGroups = selectParagraphGroups(groups, input)
    if (selectedGroups.length === 0) {
      throw new QwenTtsError('There are no paragraphs to generate for the selected action.')
    }

    const config = await this.readConfig(state.rootPath)
    if (!config.referenceFile || !config.referenceText.trim()) {
      throw new QwenTtsError('Upload a QWEN voice reference and save its exact transcript first.')
    }
    const referencePath = await referencePathForConfig(state.rootPath, config.referenceFile)
    const referenceBytes = await fs.readFile(referencePath).catch(() => null)
    if (!referenceBytes) throw new QwenTtsError('The saved QWEN voice reference is unavailable.')
    const alignmentStatus = await this.aligner.getStatus()
    if (!alignmentStatus.configured) {
      throw new QwenTtsError(
        `QWEN paragraph voice requires local Whisper alignment. ${alignmentStatus.message}`,
      )
    }

    const controller = new AbortController()
    const projectId = state.manifest.id
    this.activeController = controller
    const baseUrl = normalizeComfyUrl(normalizeComfyUiSettings(this.settings.get().comfy).baseUrl)
    try {
      this.emitProgress(input, sequence, selectedGroups, 0, 'Uploading voice reference to ComfyUI')
      const uploadedName = await uploadQwenReference(
        baseUrl,
        referenceBytes,
        config.referenceMime || 'audio/wav',
        config.referenceFile,
        controller.signal,
      )

      for (let groupIndex = 0; groupIndex < selectedGroups.length; groupIndex += 1) {
        controller.signal.throwIfAborted()
        if (this.projectStore.get()?.manifest.id !== projectId) {
          throw new QwenTtsError('The active project changed while QWEN voice was generating.')
        }
        const group = selectedGroups[groupIndex]!
        const firstLine = group.lines[0]!
        const cloneOptions = cloneOptionsForStillCast(stillCastTones)
        this.emitProgress(
          input,
          sequence,
          selectedGroups,
          groupIndex,
          stillCastTones
            ? `Queueing line ${groupIndex + 1} of ${selectedGroups.length} in ComfyUI (${stillCastLineVocalLabel(group)})`
            : `Queueing paragraph ${groupIndex + 1} of ${selectedGroups.length} in ComfyUI`,
        )
        const paragraphText = group.lines.map((line) => line.text.trim()).join('\n')
        const audio = await generateQwenParagraph(
          baseUrl,
          uploadedName,
          config.referenceText,
          paragraphText,
          controller.signal,
          (stage) =>
            this.emitProgress(input, sequence, selectedGroups, groupIndex, stage),
          cloneOptions,
        )
        const masterRelativePath = await this.saveParagraphMaster(
          state.rootPath,
          sequence,
          group,
          audio,
        )
        const masterPath = safeProjectPath(state.rootPath, masterRelativePath)
        await this.projectStore.saveQwenParagraphMaster(sequence, {
          version: 1,
          paragraphIndex: group.paragraphIndex,
          lineIds: group.lines.map((line) => line.id),
          masterPath: masterRelativePath,
          masterFingerprint: audioFingerprint(audio.bytes),
          durationMs: audio.durationMs,
          createdAt: new Date().toISOString(),
          alignmentStatus: 'pending',
        })
        this.emitProgress(
          input,
          sequence,
          selectedGroups,
          groupIndex,
          'Checking generated words and aligning paragraph cues',
        )
        const alignment = await this.alignParagraph(
          masterPath,
          group.lines,
          audio.durationMs / 1000,
          controller.signal,
        )
        if (alignment.severity === 'severe') {
          await this.projectStore.updateQwenParagraphMaster(
            sequence,
            group.paragraphIndex,
            {
              alignmentStatus: 'failed',
              alignmentError: formatAlignmentFailure(alignment),
            },
          )
          throw new QwenTtsError(
            `${stillCastTones ? 'Line' : 'Paragraph'} ${groupIndex + 1} failed transcript verification. ${formatAlignmentFailure(alignment)}`,
          )
        }
        const cues: AudioCue[] = alignment.cues.map((cue) => ({
          start: cue.start,
          end: cue.end,
          confidence: cue.confidence,
        }))
        if (cues.length !== group.lines.length) {
          await this.projectStore.updateQwenParagraphMaster(
            sequence,
            group.paragraphIndex,
            {
              alignmentStatus: 'failed',
              alignmentError: `Safe cue coverage was ${cues.length}/${group.lines.length}; retry this paragraph.`,
            },
          )
          throw new QwenTtsError(
            `Paragraph ${groupIndex + 1} could not produce a safe cue for every line. Retry the paragraph.`,
          )
        }
        const segments = await splitParagraphAudio(
          audio.bytes,
          group.lines,
          audio.durationMs / 1000,
          controller.signal,
          cues,
        )
        if (segments.length !== group.lines.length) {
          throw new QwenTtsError('QWEN audio could not be aligned to every script line.')
        }
        const fallbackLineIds = new Set(
          alignment.lines.filter(shouldUseQwenLineFallback).map((line) => line.lineId),
        )
        const alignmentReportPath = await this.saveAlignmentReport(
          state.rootPath,
          sequence,
          group,
          masterRelativePath,
          alignment,
        )
        const preparedLines: Array<{
          line: ScriptLine
          segment: (typeof segments)[number]
          sourcePath: string
          alignmentSource: 'paragraph-aligned' | 'line-fallback'
          alignmentConfidence: number
          transcript: string
          alignmentError?: string
        }> = []
        for (let lineIndex = 0; lineIndex < group.lines.length; lineIndex += 1) {
          controller.signal.throwIfAborted()
          if (this.projectStore.get()?.manifest.id !== projectId) {
            throw new QwenTtsError('The active project changed while QWEN voice was generating.')
          }
          const line = group.lines[lineIndex]!
          let segment = segments[lineIndex]!
          let sourcePath = masterRelativePath
          let alignmentSource: 'paragraph-aligned' | 'line-fallback' = 'paragraph-aligned'
          let alignmentConfidence = alignment.lines[lineIndex]?.confidence || 0
          let transcript = alignment.lines[lineIndex]?.transcriptText || ''
          let alignmentError: string | undefined
          if (fallbackLineIds.has(line.id)) {
            this.emitProgress(
              input,
              sequence,
              selectedGroups,
              groupIndex,
              `Correcting generated words for line ${line.index + 1} (${line.id})`,
              line.index,
            )
            const fallbackAudio = await generateQwenParagraph(
              baseUrl,
              uploadedName,
              config.referenceText,
              line.text,
              controller.signal,
              (stage) =>
                this.emitProgress(
                  input,
                  sequence,
                  selectedGroups,
                  groupIndex,
                  `Line ${line.index + 1} (${line.id}): ${stage}`,
                  line.index,
                ),
              cloneOptionsForStillCast(stillCastTones),
            )
            const fallbackRelativePath = await this.saveLineFallback(
              state.rootPath,
              sequence,
              line,
              fallbackAudio,
            )
            const fallbackPath = safeProjectPath(state.rootPath, fallbackRelativePath)
            const fallbackAlignment = await this.alignParagraph(
              fallbackPath,
              [line],
              fallbackAudio.durationMs / 1000,
              controller.signal,
            )
            const fallbackVerification = fallbackAlignment.lines[0]
            if (
              fallbackAlignment.severity === 'severe' ||
              fallbackAlignment.cues.length !== 1 ||
              !fallbackVerification ||
              shouldUseQwenLineFallback(fallbackVerification)
            ) {
              throw new QwenTtsError(
                `Line ${line.index + 1} still failed transcript verification after its fallback take. ${formatAlignmentFailure(fallbackAlignment)}`,
              )
            }
            segment = {
              data: fallbackAudio.bytes,
              duration: fallbackAudio.durationMs / 1000,
              start: 0,
              end: fallbackAudio.durationMs / 1000,
            }
            sourcePath = fallbackRelativePath
            alignmentSource = 'line-fallback'
            alignmentConfidence = fallbackAlignment.lines[0]?.confidence || 0
            transcript = fallbackAlignment.lines[0]?.transcriptText || ''
            alignmentError = formatLineAlignmentWarning(alignment.lines[lineIndex])
          }
          preparedLines.push({
            line,
            segment,
            sourcePath,
            alignmentSource,
            alignmentConfidence,
            transcript,
            alignmentError,
          })
        }
        for (let lineIndex = 0; lineIndex < preparedLines.length; lineIndex += 1) {
          controller.signal.throwIfAborted()
          const prepared = preparedLines[lineIndex]!
          this.emitProgress(
            input,
            sequence,
            selectedGroups,
            groupIndex,
            `Saving paragraph ${groupIndex + 1} line ${lineIndex + 1} of ${group.lines.length}`,
          )
          await this.projectStore.saveRecording({
            lineId: prepared.line.id,
            sequence,
            data: toArrayBuffer(prepared.segment.data),
            duration: prepared.segment.duration,
            mimeType: 'audio/flac',
            sourcePath: prepared.sourcePath,
            cueStartMs: Math.round(prepared.segment.start * 1000),
            cueEndMs: Math.round(prepared.segment.end * 1000),
            alignmentSource: prepared.alignmentSource,
            alignmentConfidence: prepared.alignmentConfidence,
            transcript: prepared.transcript,
            alignmentError: prepared.alignmentError,
            alignmentReportPath,
          })
        }
        await this.projectStore.updateQwenParagraphMaster(
          sequence,
          group.paragraphIndex,
          {
            alignmentStatus: 'aligned',
            alignmentReportPath,
            alignmentError: undefined,
          },
        )
        this.emitProgress(
          input,
          sequence,
          selectedGroups,
          groupIndex,
          `Paragraph ${groupIndex + 1} saved`,
          firstLine.index,
        )
      }
      return this.projectStore.get()!
    } catch (error) {
      if (isAbortError(error)) throw new QwenTtsError('QWEN voice generation was cancelled.')
      if (error instanceof QwenTtsError) throw error
      throw new QwenTtsError(error instanceof Error ? error.message : String(error))
    } finally {
      this.activeController = null
    }
  }

  async realign(
    input: import('../../shared/types').QwenTtsRealignInput,
  ): Promise<import('../../shared/types').ProjectState> {
    if (this.activeController) throw new QwenTtsError('QWEN voice work is already running.')
    const state = this.projectStore.get()
    if (!state) throw new QwenTtsError('Choose a project folder before re-aligning QWEN voice.')
    const alignmentStatus = await this.aligner.getStatus()
    if (!alignmentStatus.configured) {
      throw new QwenTtsError(
        `QWEN re-alignment requires local Whisper alignment. ${alignmentStatus.message}`,
      )
    }
    const sequence = input.sequence || 'main'
    const sequenceManifest = this.projectStore.getSequenceManifest(sequence)
    const masters = new Map(
      (sequenceManifest.qwenParagraphMasters || []).map((master) => [
        master.paragraphIndex,
        master,
      ]),
    )
    const stillCastTones = usesStillCastVoiceTones(
      sequenceManifest.lines,
      this.settings.getActiveChannelProfile()?.productionMode,
    )
    const groups = voiceGroups(sequenceManifest.lines, stillCastTones)
      .filter((group) =>
        input.lineId
          ? group.lines.some((line) => line.id === input.lineId)
          : Boolean(masters.get(group.paragraphIndex)) ||
            group.lines.some((line) => Boolean(line.voiceSourcePath)),
      )
    if (groups.length === 0) {
      throw new QwenTtsError('No saved QWEN paragraph master was found to re-align.')
    }

    const controller = new AbortController()
    this.activeController = controller
    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        controller.signal.throwIfAborted()
        const group = groups[groupIndex]!
        const master = masters.get(group.paragraphIndex)
        const sourceLine = group.lines.find(
          (line) => line.voiceSourcePath && line.voiceAlignmentSource === 'paragraph-aligned',
        ) || group.lines.find((line) => line.voiceSourcePath)
        const sourcePath = master?.masterPath || sourceLine?.voiceSourcePath
        if (!sourcePath) {
          throw new QwenTtsError(
            `Paragraph ${group.paragraphIndex + 1} has no saved paragraph master path.`,
          )
        }
        const masterPath = safeProjectPath(state.rootPath, sourcePath)
        const bytes = await fs.readFile(masterPath).catch(() => null)
        if (!bytes) {
          const missingError =
            `The saved paragraph master for paragraph ${group.paragraphIndex + 1} is unavailable; its QWEN cues were invalidated. Generate the paragraph again.`
          await this.projectStore
            .invalidateQwenParagraphCues(sequence, group.paragraphIndex, missingError)
            .catch(() => undefined)
          throw new QwenTtsError(missingError)
        }
        const currentFingerprint = audioFingerprint(bytes)
        if (master?.masterFingerprint && master.masterFingerprint !== currentFingerprint) {
          const staleError =
            `Paragraph ${group.paragraphIndex + 1} master audio changed; its saved QWEN cues were invalidated. Re-align the updated master or generate the paragraph again.`
          await this.projectStore.invalidateQwenParagraphCues(
            sequence,
            group.paragraphIndex,
            staleError,
            currentFingerprint,
          )
          throw new QwenTtsError(staleError)
        }
        const durationMs = audioDurationMs(bytes)
        if (!durationMs) {
          const durationError =
            `The saved paragraph master for paragraph ${group.paragraphIndex + 1} has an unreadable duration; its QWEN cues were invalidated. Generate the paragraph again.`
          await this.projectStore
            .invalidateQwenParagraphCues(sequence, group.paragraphIndex, durationError)
            .catch(() => undefined)
          throw new QwenTtsError(durationError)
        }
        this.emitProgress(
          { mode: 'paragraph', sequence },
          sequence,
          groups,
          groupIndex,
          'Re-aligning saved paragraph transcript',
          group.lines[0]?.index,
        )
        const alignment = await this.alignParagraph(
          masterPath,
          group.lines,
          durationMs / 1000,
          controller.signal,
        )
        if (alignment.severity === 'severe' || alignment.cues.length !== group.lines.length) {
          await this.projectStore.updateQwenParagraphMaster(
            sequence,
            group.paragraphIndex,
            {
              alignmentStatus: 'failed',
              alignmentError: formatAlignmentFailure(alignment),
            },
          ).catch(() => undefined)
          throw new QwenTtsError(
            `Paragraph ${group.paragraphIndex + 1} still fails transcript verification. ${formatAlignmentFailure(alignment)}`,
          )
        }
        const fallbackLineIds = new Set(
          alignment.lines.filter(shouldUseQwenLineFallback).map((line) => line.lineId),
        )
        const missingFallbacks = group.lines.filter(
          (line) =>
            fallbackLineIds.has(line.id) && line.voiceAlignmentSource !== 'line-fallback',
        )
        if (missingFallbacks.length > 0) {
          if (master) {
            await this.projectStore.updateQwenParagraphMaster(
              sequence,
              group.paragraphIndex,
              {
                alignmentStatus: 'failed',
                alignmentError: `Localized transcript mismatches require regenerated fallback takes: ${missingFallbacks.map((line) => line.id).join(', ')}`,
              },
            )
          }
          throw new QwenTtsError(
            `Paragraph ${group.paragraphIndex + 1} has localized transcript mismatches on ${missingFallbacks.map((line) => `line ${line.index + 1}`).join(', ')}. Generate the paragraph again to create targeted fallback takes.`,
          )
        }
        const segments = await splitParagraphAudio(
          bytes,
          group.lines,
          durationMs / 1000,
          controller.signal,
          alignment.cues,
        )
        const alignmentReportPath = await this.saveAlignmentReport(
          state.rootPath,
          sequence,
          group,
          sourcePath,
          alignment,
        )
        if (master) {
          await this.projectStore.updateQwenParagraphMaster(
            sequence,
            group.paragraphIndex,
            {
              alignmentStatus: 'aligned',
              alignmentReportPath,
              masterFingerprint: currentFingerprint,
              alignmentError: undefined,
            },
          )
        }
        for (let lineIndex = 0; lineIndex < group.lines.length; lineIndex += 1) {
          const line = group.lines[lineIndex]!
          if (fallbackLineIds.has(line.id)) continue
          const segment = segments[lineIndex]!
          const verification = alignment.lines[lineIndex]
          await this.projectStore.saveRecording({
            lineId: line.id,
            sequence,
            data: toArrayBuffer(segment.data),
            duration: segment.duration,
            mimeType: 'audio/flac',
            sourcePath,
            cueStartMs: Math.round(segment.start * 1000),
            cueEndMs: Math.round(segment.end * 1000),
            alignmentSource: 'paragraph-aligned',
            alignmentConfidence: verification?.confidence || 0,
            transcript: verification?.transcriptText || '',
            alignmentError: formatLineAlignmentWarning(verification),
            alignmentReportPath,
          })
        }
        this.emitProgress(
          { mode: 'paragraph', sequence },
          sequence,
          groups,
          groupIndex,
          'Saved re-aligned paragraph cues',
          group.lines[0]?.index,
        )
      }
      return this.projectStore.get()!
    } catch (error) {
      if (isAbortError(error)) throw new QwenTtsError('QWEN voice re-alignment was cancelled.')
      if (error instanceof QwenTtsError) throw error
      throw new QwenTtsError(error instanceof Error ? error.message : String(error))
    } finally {
      this.activeController = null
    }
  }

  async cancel(): Promise<void> {
    const controller = this.activeController
    if (!controller) return
    controller.abort()
    const baseUrl = normalizeComfyUrl(normalizeComfyUiSettings(this.settings.get().comfy).baseUrl)
    await interruptComfy(baseUrl)
  }

  private emitProgress(
    input: QwenTtsGenerateInput,
    sequence: SequenceId,
    groups: ParagraphGroup[],
    paragraphIndex: number,
    stage: string,
    lineIndex = groups[paragraphIndex]?.lines[0]?.index ?? 0,
  ): void {
    const group = groups[paragraphIndex]
    if (!group) return
    const progress: QwenTtsProgress = {
      sequence,
      mode: input.mode,
      paragraphIndex,
      paragraphCount: groups.length,
      lineIndex,
      lineCount: group.lines.length,
      stage,
    }
    this.listeners.forEach((listener) => listener(progress))
  }

  private async alignParagraph(
    audioPath: string,
    lines: readonly ScriptLine[],
    duration: number,
    signal: AbortSignal,
  ): Promise<QwenAlignmentResult> {
    const aligned = await this.aligner.align(
      audioPath,
      lines.map((line) => line.text.trim()).join('\n'),
      signal,
    )
    return verifyQwenTranscript(
      lines.map((line) => ({ id: line.id, text: line.text })),
      aligned.words,
      duration,
      aligned.transcript,
    )
  }

  private async saveParagraphMaster(
    rootPath: string,
    sequence: SequenceId,
    group: ParagraphGroup,
    audio: QwenAudioResult,
  ): Promise<string> {
    return saveQwenAudioAsset(
      rootPath,
      ['paragraphs', `master-${sequence}-${String(group.paragraphIndex + 1).padStart(4, '0')}-${randomUUID()}.${extensionForAudioMime(audio.mime)}`],
      audio.bytes,
    )
  }

  private async saveLineFallback(
    rootPath: string,
    sequence: SequenceId,
    line: ScriptLine,
    audio: QwenAudioResult,
  ): Promise<string> {
    return saveQwenAudioAsset(
      rootPath,
      ['fallbacks', `${sequence}-${String(line.index + 1).padStart(4, '0')}-${randomUUID()}.${extensionForAudioMime(audio.mime)}`],
      audio.bytes,
    )
  }

  private async saveAlignmentReport(
    rootPath: string,
    sequence: SequenceId,
    group: ParagraphGroup,
    masterPath: string,
    alignment: QwenAlignmentResult,
  ): Promise<string> {
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      sequence,
      paragraphIndex: group.paragraphIndex,
      lineIds: group.lines.map((line) => line.id),
      masterPath,
      ...alignment,
    }
    return saveQwenJsonAsset(
      rootPath,
      ['alignments', `${sequence}-${String(group.paragraphIndex + 1).padStart(4, '0')}-${randomUUID()}.json`],
      report,
    )
  }

  private async readConfig(rootPath: string): Promise<QwenConfig> {
    const configPath = path.join(rootPath, QWEN_DIRECTORY, QWEN_CONFIG_FILE)
    try {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Partial<QwenConfig>
      if (
        raw.version === 1 &&
        typeof raw.referenceText === 'string' &&
        (!raw.referenceFile || typeof raw.referenceFile === 'string')
      ) {
        return raw as QwenConfig
      }
    } catch {
      // A project without QWEN metadata starts unconfigured.
    }
    return { version: 1, referenceText: '' }
  }

  private async writeConfig(rootPath: string, config: QwenConfig): Promise<void> {
    const directory = await ensureQwenDirectory(rootPath)
    await fs.writeFile(
      path.join(directory, QWEN_CONFIG_FILE),
      JSON.stringify(config, null, 2),
      'utf8',
    )
  }

  private statusFromConfig(
    config: QwenConfig,
    comfyUrl: string,
    alignment: Awaited<ReturnType<QwenAligner['getStatus']>>,
  ): QwenTtsStatus {
    const hasReference = Boolean(config.referenceFile && config.referenceMime)
    return {
      configured: hasReference && Boolean(config.referenceText.trim()),
      model: QWEN_TTS_MODEL,
      comfyUrl,
      alignment,
      ...(config.referenceOriginalName ? { referenceName: config.referenceOriginalName } : {}),
      ...(config.referenceMime ? { referenceMime: config.referenceMime } : {}),
      ...(config.referenceByteLength ? { referenceBytes: config.referenceByteLength } : {}),
      referenceText: config.referenceText,
    }
  }
}

async function saveQwenAudioAsset(
  rootPath: string,
  parts: string[],
  bytes: Buffer,
): Promise<string> {
  const absolutePath = path.join(rootPath, QWEN_DIRECTORY, ...parts)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, bytes)
  return path.relative(rootPath, absolutePath).split(path.sep).join('/')
}

async function saveQwenJsonAsset(
  rootPath: string,
  parts: string[],
  value: unknown,
): Promise<string> {
  const absolutePath = path.join(rootPath, QWEN_DIRECTORY, ...parts)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, JSON.stringify(value, null, 2), 'utf8')
  return path.relative(rootPath, absolutePath).split(path.sep).join('/')
}

function safeProjectPath(rootPath: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootPath)
  const resolvedPath = path.resolve(rootPath, relativePath)
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new QwenTtsError('The saved QWEN audio path is outside the project folder.')
  }
  return resolvedPath
}

function extensionForAudioMime(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('ogg')) return 'ogg'
  return 'flac'
}

function audioFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function formatAlignmentFailure(alignment: QwenAlignmentResult): string {
  const affected = alignment.lines
    .filter((line) => line.mismatchCount > 0 || line.confidence < 0.75)
    .map(
      (line) =>
        `${line.lineId} (confidence ${(line.confidence * 100).toFixed(0)}%, missing ${line.missingCount}, substitutions ${line.substitutionCount})`,
    )
  return affected.length > 0
    ? `Affected lines: ${affected.join('; ')}. Transcript: "${alignment.transcript.slice(0, 300)}"`
    : `Transcript: "${alignment.transcript.slice(0, 300)}"`
}

function formatLineAlignmentWarning(
  line: QwenAlignmentResult['lines'][number] | undefined,
): string | undefined {
  if (!line || (line.mismatchCount === 0 && line.confidence >= 0.75)) return undefined
  return `Paragraph transcript mismatch: confidence ${(line.confidence * 100).toFixed(0)}%, ${line.mismatchCount} mismatch(es).`
}

interface ParagraphGroup {
  paragraphIndex: number
  lines: ScriptLine[]
}

interface QwenCloneOptions {
  maxNewTokens?: number
}

function usesStillCastVoiceTones(
  lines: readonly ScriptLine[],
  productionMode: string | undefined,
): boolean {
  if (productionMode === 'still-cast') return true
  return lines.some((line) => (line.stillBeats || []).length > 0)
}

function voiceGroups(lines: readonly ScriptLine[], stillCastTones: boolean): ParagraphGroup[] {
  if (!stillCastTones) return paragraphGroups(lines)
  return [...lines]
    .sort((left, right) => left.index - right.index)
    .map((line) => ({
      paragraphIndex: line.index,
      lines: [line],
    }))
}

function cloneOptionsForStillCast(stillCastTones: boolean): QwenCloneOptions | undefined {
  if (!stillCastTones) return undefined
  return {
    maxNewTokens: STILL_CAST_QWEN_MAX_NEW_TOKENS,
  }
}

function stillCastLineVocalLabel(group: ParagraphGroup): string {
  const line = group.lines[0]
  return line ? stillCastLineVocalExpression(line).replace(/-/g, ' ') : 'neutral talking'
}

function paragraphGroups(lines: readonly ScriptLine[]): ParagraphGroup[] {
  const groups = new Map<number, ScriptLine[]>()
  for (const line of lines) {
    const paragraphIndex =
      Number.isInteger(line.paragraphIndex) && (line.paragraphIndex || 0) >= 0
        ? line.paragraphIndex || 0
        : 0
    const group = groups.get(paragraphIndex) || []
    group.push(line)
    groups.set(paragraphIndex, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([paragraphIndex, groupLines]) => ({
      paragraphIndex,
      lines: groupLines.sort((left, right) => left.index - right.index),
    }))
}

function selectParagraphGroups(
  groups: ParagraphGroup[],
  input: QwenTtsGenerateInput,
): ParagraphGroup[] {
  if (input.mode === 'all') return groups
  if (input.mode === 'resume') {
    return groups.filter((group) =>
      group.lines.some((line) => !line.voicePath || line.status !== 'recorded'),
    )
  }
  if (!input.lineId) throw new QwenTtsError('Select a line before generating its paragraph.')
  const selectedIndex = groups.findIndex((group) =>
    group.lines.some((line) => line.id === input.lineId),
  )
  if (selectedIndex < 0) throw new QwenTtsError('The selected line is not in the active sequence.')
  return input.mode === 'paragraph' ? [groups[selectedIndex]!] : groups.slice(selectedIndex)
}

async function uploadQwenReference(
  baseUrl: string,
  bytes: Buffer,
  mime: string,
  extensionSource: string,
  signal: AbortSignal,
): Promise<string> {
  const extension = extensionForName(extensionSource) || 'wav'
  const filename = `higgsfilm-qwen-reference-${randomUUID()}.${extension}`
  const form = new FormData()
  form.append(
    'image',
    new Blob([new Uint8Array(bytes)], { type: mime || 'application/octet-stream' }),
    filename,
  )
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const response = await comfyFetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
    signal,
  })
  const text = await response.text()
  const data = parseJson(text)
  if (!response.ok) {
    throw new QwenTtsError(`ComfyUI reference upload failed (${response.status}): ${formatError(data, text)}`)
  }
  if (!isRecord(data) || typeof data.name !== 'string' || !data.name) {
    throw new QwenTtsError('ComfyUI did not return an uploaded QWEN reference filename.')
  }
  return data.name
}

async function generateQwenParagraph(
  baseUrl: string,
  referenceName: string,
  referenceText: string,
  text: string,
  signal: AbortSignal,
  onStage: (stage: string) => void,
  options?: QwenCloneOptions,
): Promise<QwenAudioResult> {
  const clientId = randomUUID()
  const workflow = buildQwenWorkflow(referenceName, referenceText, text, options)
  const outputId = '11'
  const abortComfy = () => {
    void interruptComfy(baseUrl)
  }
  signal.addEventListener('abort', abortComfy, { once: true })
  try {
    signal.throwIfAborted()
    onStage('Queueing QWEN paragraph workflow')
    const promptId = await queuePrompt(baseUrl, workflow, clientId, signal)
    onStage('Generating paragraph audio in ComfyUI')
    const media = await waitForAudio(baseUrl, promptId, outputId, signal, onStage)
    onStage('Downloading generated paragraph audio')
    return await downloadAudio(baseUrl, media, signal)
  } finally {
    signal.removeEventListener('abort', abortComfy)
  }
}

export function buildQwenWorkflow(
  referenceName: string,
  referenceText: string,
  text: string,
  options?: QwenCloneOptions,
): Workflow {
  return {
    '1': {
      class_type: 'Qwen3Loader',
      inputs: {
        repo_id: QWEN_TTS_MODEL,
        source: 'HuggingFace',
        precision: 'bf16',
        attention: 'auto',
        local_model_path: '',
      },
    },
    '2': {
      class_type: 'LoadAudio',
      inputs: { audio: referenceName },
    },
    '10': {
      class_type: 'Qwen3VoiceClone',
      inputs: {
        model: ['1', 0],
        text,
        seed: randomInt(1, 2_000_000_000),
        language: 'Auto',
        ref_audio: ['2', 0],
        ref_text: referenceText,
        max_new_tokens: options?.maxNewTokens ?? 2048,
        ref_audio_max_seconds: 30,
      },
    },
    '11': {
      class_type: 'PreviewAudio',
      inputs: { audio: ['10', 0] },
    },
  }
}

async function queuePrompt(
  baseUrl: string,
  workflow: Workflow,
  clientId: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await comfyFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal,
  })
  const text = await response.text()
  const data = parseJson(text)
  if (!response.ok) {
    throw new QwenTtsError(`ComfyUI rejected the QWEN workflow (${response.status}): ${formatError(data, text)}`)
  }
  if (!isRecord(data) || typeof data.prompt_id !== 'string' || !data.prompt_id) {
    throw new QwenTtsError(`ComfyUI did not accept the QWEN workflow: ${formatError(data, text)}`)
  }
  return data.prompt_id
}

async function waitForAudio(
  baseUrl: string,
  promptId: string,
  outputId: string,
  signal: AbortSignal,
  onStage: (stage: string) => void,
): Promise<ComfyMediaResult> {
  const startedAt = Date.now()
  let loadedStageSent = false
  while (Date.now() - startedAt < TIMEOUT_MS) {
    signal.throwIfAborted()
    const response = await comfyFetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal })
    const text = await response.text()
    if (response.ok) {
      const history = parseJson(text)
      const entry =
        isRecord(history) && isRecord(history[promptId])
          ? (history[promptId] as ComfyHistoryEntry)
          : undefined
      if (entry) {
        const media = findAudio(entry.outputs, outputId)
        if (media) return media
        const status = entry.status?.status_str
        if (
          status === 'error' ||
          status === 'failed' ||
          (entry.status?.completed === true && status !== 'success')
        ) {
          throw new QwenTtsError(`QWEN TTS failed in ComfyUI: ${formatHistoryFailure(entry)}`)
        }
        if (!loadedStageSent) {
          loadedStageSent = true
          onStage('QWEN model loaded; waiting for paragraph audio')
        }
      }
    } else if (response.status >= 400 && response.status !== 404) {
      throw new QwenTtsError(`ComfyUI history request failed (${response.status}): ${text.slice(0, 500)}`)
    }
    await wait(POLL_MS, signal)
  }
  throw new QwenTtsError('Timed out waiting for QWEN paragraph audio from ComfyUI.')
}

function findAudio(
  outputs: Record<string, { audio?: ComfyMediaResult[] }> | undefined,
  outputId: string,
): ComfyMediaResult | undefined {
  return outputs?.[outputId]?.audio?.find(isMediaResult)
}

async function downloadAudio(
  baseUrl: string,
  media: ComfyMediaResult,
  signal: AbortSignal,
): Promise<QwenAudioResult> {
  if (!media.filename) throw new QwenTtsError('ComfyUI returned QWEN audio without a filename.')
  const params = new URLSearchParams({
    filename: media.filename,
    subfolder: media.subfolder || '',
    type: media.type || 'temp',
  })
  const response = await comfyFetch(`${baseUrl}/view?${params.toString()}`, { signal })
  if (!response.ok) {
    throw new QwenTtsError(`ComfyUI QWEN audio download failed (${response.status}).`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 32 || bytes.length > MAX_AUDIO_BYTES) {
    throw new QwenTtsError('ComfyUI returned empty or oversized QWEN audio.')
  }
  const durationMs = audioDurationMs(bytes)
  if (!durationMs || durationMs <= 0) {
    throw new QwenTtsError('ComfyUI returned QWEN audio with an unreadable duration.')
  }
  return {
    bytes,
    durationMs,
    mime: normalizeAudioMime(response.headers.get('content-type'), media.filename),
  }
}

async function comfyFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new QwenTtsError('Could not reach ComfyUI. Start it and check the configured URL.')
  }
}

async function interruptComfy(baseUrl: string): Promise<void> {
  await Promise.allSettled([
    fetch(`${baseUrl}/interrupt`, { method: 'POST' }),
    fetch(`${baseUrl}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }),
  ])
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      reject(new DOMException('QWEN voice generation was cancelled.', 'AbortError'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizeComfyUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
  } catch {
    throw new QwenTtsError('The configured ComfyUI URL is invalid.')
  }
}

function normalizeAudioMime(raw: string | null, filename: string): string {
  const value = raw?.split(';', 1)[0]?.trim().toLowerCase()
  if (value?.startsWith('audio/')) return value === 'audio/x-flac' ? 'audio/flac' : value
  return filename.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/flac'
}

function audioDurationMs(bytes: Uint8Array): number | undefined {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return wavDurationMs(bytes)
  }
  if (bytes.length < 8 || ascii(bytes, 0, 4) !== 'fLaC') return undefined
  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]!
    const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    offset += 4
    if (offset + length > bytes.length) return undefined
    if ((header & 0x7f) === 0 && length >= 18) {
      const sampleRate =
        bytes[offset + 10]! * 4096 +
        bytes[offset + 11]! * 16 +
        (bytes[offset + 12]! >> 4)
      const totalSamples =
        (bytes[offset + 13]! & 0x0f) * 0x1_0000_0000 +
        bytes[offset + 14]! * 0x1_000_000 +
        bytes[offset + 15]! * 0x10_000 +
        bytes[offset + 16]! * 0x100 +
        bytes[offset + 17]!
      return sampleRate > 0 && totalSamples > 0
        ? Math.round(totalSamples * 1000 / sampleRate)
        : undefined
    }
    offset += length
    if ((header & 0x80) !== 0) break
  }
  return undefined
}

function wavDurationMs(bytes: Uint8Array): number | undefined {
  let offset = 12
  let byteRate: number | undefined
  let dataLength: number | undefined
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4)
    const chunkLength = uint32LittleEndian(bytes, offset + 4)
    const dataOffset = offset + 8
    if (dataOffset + chunkLength > bytes.length) return undefined
    if (chunkType === 'fmt ' && chunkLength >= 12) {
      byteRate = uint32LittleEndian(bytes, dataOffset + 8)
    } else if (chunkType === 'data') {
      dataLength = chunkLength
      break
    }
    offset = dataOffset + chunkLength + (chunkLength % 2)
  }
  return byteRate && dataLength ? Math.round(dataLength * 1000 / byteRate) : undefined
}

function uint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0
}

function ensureQwenDirectory(rootPath: string): Promise<string> {
  const directory = path.join(rootPath, QWEN_DIRECTORY)
  return fs.mkdir(directory, { recursive: true }).then(() => directory)
}

async function referencePathForConfig(rootPath: string, referenceFile: string): Promise<string> {
  const extension = extensionForName(referenceFile)
  if (!extension || path.basename(referenceFile) !== referenceFile) {
    throw new QwenTtsError('The saved QWEN voice reference metadata is invalid.')
  }
  return path.join(await ensureQwenDirectory(rootPath), referenceFile)
}

function extensionForName(name: string): ReferenceExtension | undefined {
  const extension = path.extname(name).slice(1).toLowerCase()
  return (REFERENCE_EXTENSIONS as readonly string[]).includes(extension)
    ? extension as ReferenceExtension
    : undefined
}

function mimeForExtension(extension: ReferenceExtension): string {
  switch (extension) {
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'flac':
      return 'audio/flac'
    case 'ogg':
      return 'audio/ogg'
    case 'webm':
      return 'audio/webm'
  }
}

function safeDisplayName(name: string, fallback: string): string {
  const base = path.basename(name).trim()
  return /^[A-Za-z0-9._-]{1,256}$/.test(base) ? base : fallback
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function formatError(data: unknown, fallback: string): string {
  if (isRecord(data)) {
    const bits: string[] = []
    if (typeof data.error === 'string') bits.push(data.error)
    if (data.node_errors && typeof data.node_errors === 'object') {
      bits.push(JSON.stringify(data.node_errors).slice(0, 500))
    }
    if (bits.length > 0) return bits.join(' — ')
  }
  return fallback.slice(0, 500) || 'Unknown ComfyUI error'
}

function formatHistoryFailure(entry: ComfyHistoryEntry): string {
  if (entry.status?.messages !== undefined) {
    return JSON.stringify(entry.status.messages).slice(0, 700)
  }
  return entry.status?.status_str || 'Unknown ComfyUI error'
}

function isMediaResult(value: unknown): value is ComfyMediaResult {
  return (
    isRecord(value) &&
    (value.filename === undefined || typeof value.filename === 'string') &&
    (value.subfolder === undefined || typeof value.subfolder === 'string') &&
    (value.type === undefined || typeof value.type === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /cancelled|aborted/i.test(error.message))
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0)
  }
  return value
}
