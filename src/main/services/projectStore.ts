import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AssetData,
  ProjectManifest,
  ProjectState,
  RecordingPayload,
  ScriptLine,
  VisualBible,
} from '../../shared/types'
import { composeScenePrompt, stripVisualBible } from '../../shared/promptComposer'
import { estimateTimeline, splitIntoSentences } from './scriptParser'

const MANIFEST_FILE = 'higgsfilm.json'

export const DEFAULT_VISUAL_BIBLE: VisualBible = {
  name: 'Stickman MS Paint Explainer',
  style:
    'Minimal hand-drawn MS Paint stickman illustration on a white canvas. Use rough 1–3 px near-black lines, solid flat color fills for the recurring protagonist, simple round heads, expressive poses, flat 2D shapes, intentionally crude brush edges, and a clean readable composition. Keep the protagonist colored in every scene. No realism or polished animation styling.',
  characters:
    'Use simple stick figures with circular heads, line bodies, two-line arms and legs, and clearly expressive faces with visible eyes, eyebrows, and mouths for every human character. Keep head size, limb proportions, line weight, facial design, and identifying accessories consistent in every scene. Use one recurring protagonist with the same full set of solid flat colors for their face, hair, clothing, body, and accessories in every scene; never render the protagonist as black-and-white outlines only.',
  setting:
    'Sparse white MS Paint canvas with only the simple black-outline props and environment elements needed to explain the narration. Favor recognizable silhouettes and lots of negative space.',
  palette:
    'Pure white background and near-black linework, with solid flat colors for the recurring protagonist’s face, hair, clothing, body, and identifying accessories. Use black or dark-gray text only when explicitly requested. No gradients, textures, shadows, or complex color blends.',
  camera:
    'Flat orthographic 2D view, mostly medium or wide compositions, front-facing readable staging, simple cutout-like poses, clear silhouettes, and consistent 16:9 framing. No lens blur, depth of field, cinematic lighting, or dramatic perspective.',
  negativePrompt:
    'photorealism, 3D rendering, cinematic lighting, gradients, shading, shadows, textures, painterly detail, polished vector art, realistic anatomy, realistic faces, black-and-white protagonist, monochrome protagonist, unfilled protagonist, blank faces, expressionless faces, extra limbs, duplicate characters, inconsistent proportions, inconsistent line weight, clutter, unreadable text, logos, watermarks, visual noise',
}

const LEGACY_VISUAL_BIBLE: VisualBible = {
  name: 'Clean cinematic explainer',
  style: 'Simple, high-contrast editorial animation with crisp silhouettes and deliberate motion.',
  characters: 'Use the project character references consistently. Keep proportions, clothing, and facial design stable.',
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
  setting:
    'Sparse white MS Paint canvas with only the simple black-outline props and environment elements needed to explain the narration. Favor recognizable silhouettes and lots of negative space.',
  palette:
    'Pure white background, near-black linework, black or dark-gray text only when explicitly requested, plus one or two flat accent colors. No gradients, textures, shadows, or complex color blends.',
  camera:
    DEFAULT_VISUAL_BIBLE.camera,
  negativePrompt:
    'photorealism, 3D rendering, cinematic lighting, gradients, shading, shadows, textures, painterly detail, polished vector art, realistic anatomy, realistic faces, extra limbs, duplicate characters, inconsistent proportions, inconsistent line weight, clutter, unreadable text, logos, watermarks, visual noise',
}

function createLine(
  text: string,
  index: number,
  startTime: number,
  endTime: number,
  visualBible: VisualBible,
): ScriptLine {
  return {
    id: randomUUID(),
    index,
    text,
    startTime,
    endTime,
    duration: Number((endTime - startTime).toFixed(2)),
    status: 'draft',
    scenePrompt: composeScenePrompt(text),
    directionStatus: 'draft',
    sceneStatus: 'draft',
  }
}

function createManifest(name: string): ProjectManifest {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    lines: [],
    visualBible: structuredClone(DEFAULT_VISUAL_BIBLE),
    exportSettings: {
      width: 1920,
      height: 1080,
      fps: 30,
      audioLufs: -16,
      truePeak: -1.5,
    },
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
    exportSettings: { ...base.exportSettings, ...(raw.exportSettings || {}) },
    lines,
  }
}

function normalizeLinePrompt(line: ScriptLine): ScriptLine {
  const cleanedPrompt = stripVisualBible(line.scenePrompt || composeScenePrompt(line.text))
  const sceneDescription = line.sceneDescription?.trim() || extractSceneDescription(cleanedPrompt)
  const hasManualDirection =
    line.directionStatus === 'complete' &&
    cleanedPrompt.trim() !== composeScenePrompt(line.text).trim()
  const scenePrompt = sceneDescription
    ? composeScenePrompt(line.text, sceneDescription)
    : cleanedPrompt || composeScenePrompt(line.text)

  return {
    ...line,
    scenePrompt,
    sceneDescription: sceneDescription || undefined,
    directionStatus:
      sceneDescription || hasManualDirection
        ? 'complete'
        : line.directionStatus === 'failed'
          ? 'failed'
          : 'draft',
    directionError: line.directionError,
  }
}

function extractSceneDescription(prompt: string): string | undefined {
  const marker = prompt.match(/\nScene direction\s*:\s*([\s\S]*)$/i)
  return marker?.[1]?.trim() || undefined
}

function isLegacyVisualBible(value: Partial<VisualBible>): boolean {
  return [LEGACY_VISUAL_BIBLE, LEGACY_STICKMAN_VISUAL_BIBLE].some(
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
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4')) return 'm4a'
  return 'webm'
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

export class ProjectStore {
  private rootPath: string | null = null
  private manifest: ProjectManifest | null = null

  async open(folderPath: string): Promise<ProjectState> {
    await fs.mkdir(folderPath, { recursive: true })
    const manifestPath = path.join(folderPath, MANIFEST_FILE)
    let manifest: ProjectManifest

    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<ProjectManifest>
      manifest = normalizeManifest(raw, path.basename(folderPath))
    } catch {
      manifest = createManifest(path.basename(folderPath))
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    }

    this.rootPath = path.resolve(folderPath)
    this.manifest = manifest
    return this.state()
  }

  get(): ProjectState | null {
    return this.rootPath && this.manifest ? this.state() : null
  }

  async importScript(filePath: string): Promise<ProjectState> {
    this.requireProject()
    const rawScript = await fs.readFile(filePath, 'utf8')
    return this.importScriptText(rawScript)
  }

  async importScriptText(rawScript: string): Promise<ProjectState> {
    this.requireProject()
    const sentences = splitIntoSentences(rawScript)
    const timeline = estimateTimeline(sentences)
    const visualBible = this.manifest!.visualBible

    this.manifest!.lines = sentences.map((text, index) =>
      createLine(text, index, timeline[index].startTime, timeline[index].endTime, visualBible),
    )
    this.manifest!.scriptFile = 'script.txt'
    this.touch()

    await fs.writeFile(path.join(this.rootPath!, 'script.txt'), rawScript, 'utf8')
    return this.save()
  }

  async save(manifest = this.manifest!): Promise<ProjectState> {
    this.requireProject()
    this.manifest = normalizeManifest(manifest, path.basename(this.rootPath!))
    this.touch()
    await fs.writeFile(
      path.join(this.rootPath!, MANIFEST_FILE),
      JSON.stringify(this.manifest, null, 2),
      'utf8',
    )
    return this.state()
  }

  async saveRecording(payload: RecordingPayload): Promise<ProjectState> {
    this.requireProject()
    const line = this.manifest!.lines.find((candidate) => candidate.id === payload.lineId)
    if (!line) throw new Error('The selected script line no longer exists.')

    const sceneDirectory = path.join(
      this.rootPath!,
      'scenes',
      String(line.index + 1).padStart(3, '0'),
    )
    await fs.mkdir(sceneDirectory, { recursive: true })
    const extension = extensionForMime(payload.mimeType)
    const fileName = `voice.${extension}`
    const absolutePath = path.join(sceneDirectory, fileName)
    await fs.writeFile(absolutePath, Buffer.from(payload.data))

    line.voicePath = this.relativePath(absolutePath)
    line.duration = Number(Math.max(0.1, payload.duration).toFixed(2))
    line.status = 'recorded'
    line.error = undefined
    this.recalculateTimeline()
    return this.save()
  }

  async saveImage(lineId: string, data: Buffer, extension = 'jpg'): Promise<ProjectState> {
    this.requireProject()
    const line = this.manifest!.lines.find((candidate) => candidate.id === lineId)
    if (!line) throw new Error('The selected scene no longer exists.')

    const sceneDirectory = path.join(
      this.rootPath!,
      'scenes',
      String(line.index + 1).padStart(3, '0'),
    )
    await fs.mkdir(sceneDirectory, { recursive: true })
    const absolutePath = path.join(sceneDirectory, `image-01.${extension}`)
    await fs.writeFile(absolutePath, data)
    line.imagePath = this.relativePath(absolutePath)
    line.sceneStatus = 'complete'
    line.error = undefined
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

  getRootPath(): string {
    this.requireProject()
    return this.rootPath!
  }

  getManifest(): ProjectManifest {
    this.requireProject()
    return this.manifest!
  }

  private recalculateTimeline(): void {
    let cursor = 0
    this.manifest!.lines.forEach((line, index) => {
      const duration = Math.max(0.1, line.duration || 0.8)
      line.index = index
      line.startTime = Number(cursor.toFixed(2))
      line.endTime = Number((cursor + duration).toFixed(2))
      cursor = line.endTime
    })
  }

  private relativePath(absolutePath: string): string {
    return path.relative(this.rootPath!, absolutePath).split(path.sep).join('/')
  }

  private touch(): void {
    this.manifest!.updatedAt = new Date().toISOString()
  }

  private state(): ProjectState {
    this.requireProject()
    return {
      rootPath: this.rootPath!,
      manifest: structuredClone(this.manifest!),
    }
  }

  private requireProject(): void {
    if (!this.rootPath || !this.manifest) {
      throw new Error('Open a project folder first.')
    }
  }
}
