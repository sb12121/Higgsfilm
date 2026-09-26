import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  EXPRESSION_FRAME_COUNT,
  EXPRESSION_IMAGE_GUIDE_FILE,
  composeExpressionImagePrompt,
  expressionFrameFileName,
} from '../../shared/expressionImagePrompt'
import type {
  ExpressionImageGenerateInput,
  ExpressionImageGenerateResult,
  ExpressionImageProgress,
  ExpressionImageSetup,
} from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import type { CodexClient } from './codexClient'
import { ensurePngExportCanvas } from './imageUpscale'
import { scanStillCastLibrary } from './stillCastLibrary'

const MAX_GUIDE_WALK = 6

export class ExpressionImageClient {
  private stopRequested = false

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly codex: Pick<CodexClient, 'generateImage' | 'cancelImageGeneration'>,
  ) {}

  async getSetup(): Promise<ExpressionImageSetup> {
    const saved = this.settings.get()
    const libraryPath = this.settings.getActiveChannelProfile()?.stillLibraryPath?.trim() || ''
    const guidePath = await resolveExpressionImageGuide(libraryPath, saved.expressionGuidePath).catch(() => '')
    const expressions = libraryPath ? await listExpressionFolders(libraryPath) : []
    return {
      guidePath,
      characterSheetPath: saved.customImageCharacterSheetPath,
      referencePaths: saved.customImageReferencePaths,
      backgroundPath: saved.expressionBackgroundPath,
      libraryPath,
      expressions,
    }
  }

  cancel(): void {
    this.stopRequested = true
    void this.codex.cancelImageGeneration()
  }

  async generate(
    input: ExpressionImageGenerateInput,
    onProgress?: (progress: ExpressionImageProgress) => void,
  ): Promise<ExpressionImageGenerateResult> {
    this.stopRequested = false
    const saved = this.settings.get()
    const libraryPath = this.settings.getActiveChannelProfile()?.stillLibraryPath?.trim() || ''
    if (!libraryPath) {
      throw new Error('Choose a channel folder first so Expressions can be found.')
    }
    const available = await listExpressionFolders(libraryPath)
    const requested = (input.expressions || []).map((name) => name.trim()).filter(Boolean)
    const expressions = available.filter((name) =>
      requested.some((candidate) => candidate.toLowerCase() === name.toLowerCase()),
    )
    if (requested.length === 0 || expressions.length === 0) {
      throw new Error('Choose at least one expression to regenerate.')
    }

    const guidePath = await resolveExpressionImageGuide(libraryPath, saved.expressionGuidePath)
    const guide = await fs.readFile(guidePath, 'utf8')
    if (!guide.trim()) throw new Error('The expression image guide is empty.')
    const characterSheetPath = await existingFile(saved.customImageCharacterSheetPath)
    if (!characterSheetPath) throw new Error('Choose a character sheet before regenerating expressions.')
    const backgroundPath = await existingFile(saved.expressionBackgroundPath)
    if (!backgroundPath) throw new Error('Choose one empty background plate before regenerating expressions.')
    const referencePaths = await existingFiles(saved.customImageReferencePaths)
    const background = await fs.readFile(backgroundPath)
    const plate = await ensurePngExportCanvas(background, path.extname(backgroundPath), '16:9')

    const written: string[] = []
    const total = expressions.length * EXPRESSION_FRAME_COUNT
    let index = 0
    for (const expression of expressions) {
      if (this.stopRequested) break
      const folderPath = path.join(libraryPath, expression)
      await fs.mkdir(folderPath, { recursive: true })
      await fs.writeFile(path.join(folderPath, '_bg_plate.png'), plate)
      for (let frame = 1; frame <= EXPRESSION_FRAME_COUNT; frame += 1) {
        if (this.stopRequested) break
        index += 1
        const fileName = expressionFrameFileName(frame)
        onProgress?.({
          index,
          total,
          expression,
          frame,
          fileName,
          phase: 'generating',
        })
        let image: { data: Buffer; extension: string }
        try {
          image = await this.codex.generateImage({
            prompt: composeExpressionImagePrompt(guide, expression, frame),
            aspectRatio: '16:9',
            referenceImagePaths: referencePaths,
            characterSheetPath,
            backgroundImagePath: backgroundPath,
          })
        } catch (error) {
          if (this.stopRequested || isCancellation(error)) {
            return { written, stopped: true }
          }
          throw error
        }
        if (this.stopRequested) return { written, stopped: true }
        onProgress?.({
          index,
          total,
          expression,
          frame,
          fileName,
          phase: 'saving',
        })
        const prepared = await ensurePngExportCanvas(image.data, image.extension || 'png', '16:9')
        const outputPath = path.join(folderPath, fileName)
        await fs.writeFile(outputPath, prepared)
        written.push(outputPath)
      }
    }

    return { written, stopped: this.stopRequested }
  }
}

export async function resolveExpressionImageGuide(
  libraryPath: string,
  configuredPath?: string,
): Promise<string> {
  const configured = configuredPath?.trim()
  if (configured) {
    try {
      await fs.access(configured)
    } catch {
      throw new Error('Could not read the expression image guide. Choose it again.')
    }
    return path.resolve(configured)
  }

  const starts = [libraryPath, libraryPath ? path.dirname(libraryPath) : ''].filter(Boolean)
  for (const start of starts) {
    const found = await findGuideNear(start)
    if (found) return found
  }
  throw new Error(`Choose the expression image guide (${EXPRESSION_IMAGE_GUIDE_FILE}).`)
}

async function findGuideNear(start: string): Promise<string> {
  let current = path.resolve(start)
  for (let depth = 0; depth < MAX_GUIDE_WALK; depth += 1) {
    const guideNames = [EXPRESSION_IMAGE_GUIDE_FILE, 'Bux_PaperCollage_Image_Generation_Master_Prompt.txt']
    for (const name of guideNames) {
      const direct = path.join(current, name)
      try {
        await fs.access(direct)
        return direct
      } catch {
        // Keep walking.
      }
    }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      for (const name of guideNames) {
        const nested = path.join(current, entry.name, name)
        try {
          await fs.access(nested)
          return nested
        } catch {
          // The guide may live in another sibling folder.
        }
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}

async function listExpressionFolders(libraryPath: string): Promise<string[]> {
  try {
    const scan = await scanStillCastLibrary(libraryPath)
    return scan.folders
      .map((folder) => folder.folderName)
      .filter((name) => !name.startsWith('_'))
  } catch {
    return []
  }
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

async function existingFiles(paths: string[]): Promise<string[]> {
  const existing: string[] = []
  for (const filePath of paths) {
    const found = await existingFile(filePath)
    if (found) existing.push(found)
  }
  return existing
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && /cancelled/i.test(error.message)
}
