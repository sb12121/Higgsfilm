import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  channelProfileFromInput,
  normalizeChannelProfileState,
  normalizeVisualBible,
} from '../../shared/channelProfiles'
import {
  DEFAULT_COMFY_UI_SETTINGS,
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_LLM_SERVICE_TIER,
  defaultLlmStepSettings,
  normalizeComfyUiSettings,
  normalizeLlmReasoningEffort,
  normalizeLlmServiceTier,
  normalizeLlmStepSettings,
  type ChannelImageProfile,
  type ChannelImageProfileInput,
  type ChannelProfileState,
  type ImageGenerator,
  type ProductionBiblePreset,
  type StudioSettings,
  type VisualBible,
  type VoiceMode,
} from '../../shared/types'

const DEFAULT_SETTINGS: StudioSettings = {
  imageGenerator: 'higgsfield',
  voiceMode: 'microphone',
  llmReasoningEffort: DEFAULT_LLM_REASONING_EFFORT,
  llmServiceTier: DEFAULT_LLM_SERVICE_TIER,
  llmSteps: defaultLlmStepSettings(),
  comfy: { ...DEFAULT_COMFY_UI_SETTINGS },
  customImageGuidePath: '',
  customImageCharacterSheetPath: '',
  customImageReferencePaths: [],
  expressionGuidePath: '',
  expressionBackgroundPath: '',
}

type StoredSettings = Partial<StudioSettings> & {
  productionBibles?: unknown
  channelProfiles?: unknown
  activeChannelProfileId?: unknown
}

export class AppSettingsStore {
  private settings: StudioSettings = { ...DEFAULT_SETTINGS }
  private productionBibles: ProductionBiblePreset[] = []
  private channelProfiles: ChannelImageProfile[] = []
  private activeChannelProfileId = ''

  constructor(private readonly filePath: string) {}

  async load(): Promise<StudioSettings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredSettings
      this.settings = normalizeSettings(raw)
      this.productionBibles = normalizeProductionBibles(raw.productionBibles)
      const channelState = normalizeChannelProfileState(
        raw.channelProfiles,
        raw.activeChannelProfileId,
      )
      this.channelProfiles = channelState.profiles
      this.activeChannelProfileId = channelState.activeProfileId
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
      this.productionBibles = []
      this.channelProfiles = []
      this.activeChannelProfileId = ''
    }
    return this.get()
  }

  get(): StudioSettings {
    return { ...this.settings }
  }

  getProductionBibles(): ProductionBiblePreset[] {
    return structuredClone(this.productionBibles)
  }

  getChannelProfiles(): ChannelProfileState {
    return {
      profiles: structuredClone(this.channelProfiles),
      activeProfileId: this.activeChannelProfileId,
    }
  }

  getActiveChannelProfile(): ChannelImageProfile | null {
    const profile = this.channelProfiles.find(
      (candidate) => candidate.id === this.activeChannelProfileId,
    )
    return profile ? structuredClone(profile) : null
  }

  getChannelProfile(id: string): ChannelImageProfile | null {
    const profile = this.channelProfiles.find((candidate) => candidate.id === id.trim())
    return profile ? structuredClone(profile) : null
  }

  setActiveChannelProfileId(id: string): void {
    const trimmed = id.trim()
    if (trimmed && !this.channelProfiles.some((profile) => profile.id === trimmed)) {
      throw new Error('That YouTube channel profile was not found.')
    }
    this.activeChannelProfileId = trimmed
  }

  async saveChannelProfile(input: ChannelImageProfileInput): Promise<ChannelProfileState> {
    const trimmedName = input.name.trim()
    if (!trimmedName) throw new Error('Enter a name for the YouTube channel profile.')

    const requestedId = input.id?.trim() || ''
    const channelFolderPath = input.channelFolderPath?.trim() || ''
    const existingById = requestedId
      ? this.channelProfiles.find((profile) => profile.id === requestedId)
      : undefined
    const existingByFolder = channelFolderPath
      ? this.channelProfiles.find(
          (profile) =>
            profile.channelFolderPath &&
            profile.channelFolderPath.toLowerCase() === channelFolderPath.toLowerCase(),
        )
      : undefined
    const existingByName = this.channelProfiles.find(
      (profile) => profile.name.toLowerCase() === trimmedName.toLowerCase(),
    )
    const id = existingById?.id || existingByFolder?.id || existingByName?.id || randomUUID()
    const saved = channelProfileFromInput({ ...input, id, name: trimmedName }, id)
    const existingIndex = this.channelProfiles.findIndex((profile) => profile.id === saved.id)
    const nameConflict = this.channelProfiles.find(
      (profile) =>
        profile.id !== saved.id && profile.name.toLowerCase() === saved.name.toLowerCase(),
    )
    if (nameConflict) {
      throw new Error(`A channel profile named "${saved.name}" already exists.`)
    }
    if (existingIndex >= 0) {
      this.channelProfiles[existingIndex] = saved
    } else {
      this.channelProfiles.push(saved)
    }
    this.channelProfiles.sort((left, right) => left.name.localeCompare(right.name))
    this.activeChannelProfileId = saved.id
    await this.persist()
    return this.getChannelProfiles()
  }

  async removeChannelProfile(id: string): Promise<ChannelProfileState> {
    const trimmed = id.trim()
    const existing = this.channelProfiles.find((profile) => profile.id === trimmed)
    if (!existing) throw new Error('That YouTube channel profile was not found.')
    this.channelProfiles = this.channelProfiles.filter((profile) => profile.id !== trimmed)
    if (this.activeChannelProfileId === trimmed) this.activeChannelProfileId = ''
    await this.persist()
    return this.getChannelProfiles()
  }

  async saveProductionBible(
    name: string,
    bible: VisualBible,
  ): Promise<ProductionBiblePreset[]> {
    const trimmedName = name.trim()
    if (!trimmedName) throw new Error('Enter a name for the production bible.')

    const savedBible: ProductionBiblePreset = {
      name: trimmedName,
      bible: {
        ...normalizeVisualBible(bible, trimmedName),
        name: trimmedName,
      },
    }
    const existingIndex = this.productionBibles.findIndex(
      (preset) => preset.name.toLowerCase() === trimmedName.toLowerCase(),
    )
    if (existingIndex >= 0) {
      this.productionBibles[existingIndex] = savedBible
    } else {
      this.productionBibles.push(savedBible)
    }
    this.productionBibles.sort((left, right) => left.name.localeCompare(right.name))
    await this.persist()
    return this.getProductionBibles()
  }

  loadProductionBible(name: string): ProductionBiblePreset | null {
    const preset = this.productionBibles.find(
      (candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase(),
    )
    return preset ? structuredClone(preset) : null
  }

  async save(settings: StudioSettings): Promise<StudioSettings> {
    this.settings = normalizeSettings(settings)
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(
      this.filePath,
      JSON.stringify(
        {
          ...this.settings,
          productionBibles: this.productionBibles,
          channelProfiles: this.channelProfiles,
          activeChannelProfileId: this.activeChannelProfileId,
        },
        null,
        2,
      ),
      'utf8',
    )
  }
}

function normalizeSettings(settings: Partial<StudioSettings>): StudioSettings {
  const imageGenerator: ImageGenerator =
    settings.imageGenerator === 'chatgpt' || settings.imageGenerator === 'comfyui'
      ? settings.imageGenerator
      : DEFAULT_SETTINGS.imageGenerator
  return {
    imageGenerator,
    voiceMode: settings.voiceMode === 'qwen' ? ('qwen' as VoiceMode) : DEFAULT_SETTINGS.voiceMode,
    llmReasoningEffort: normalizeLlmReasoningEffort(settings.llmReasoningEffort),
    llmServiceTier: normalizeLlmServiceTier(settings.llmServiceTier),
    llmSteps: normalizeLlmStepSettings(settings.llmSteps),
    comfy: normalizeComfyUiSettings(settings.comfy),
    customImageGuidePath:
      typeof settings.customImageGuidePath === 'string' ? settings.customImageGuidePath.trim() : '',
    ...splitCharacterSheet(
      typeof settings.customImageCharacterSheetPath === 'string'
        ? settings.customImageCharacterSheetPath.trim()
        : '',
      normalizeReferencePaths(settings.customImageReferencePaths),
    ),
    expressionGuidePath:
      typeof settings.expressionGuidePath === 'string' ? settings.expressionGuidePath.trim() : '',
    expressionBackgroundPath:
      typeof settings.expressionBackgroundPath === 'string' ? settings.expressionBackgroundPath.trim() : '',
  }
}

function splitCharacterSheet(
  characterSheetPath: string,
  referencePaths: string[],
): Pick<StudioSettings, 'customImageCharacterSheetPath' | 'customImageReferencePaths'> {
  let sheet = characterSheetPath
  const references: string[] = []
  for (const filePath of referencePaths) {
    if (!sheet && /character\s*sheet/i.test(path.basename(filePath))) {
      sheet = filePath
      continue
    }
    if (sheet && filePath.toLowerCase() === sheet.toLowerCase()) continue
    references.push(filePath)
  }
  return {
    customImageCharacterSheetPath: sheet,
    customImageReferencePaths: references.slice(0, 4),
  }
}

function normalizeReferencePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(trimmed)
    if (paths.length === 8) break
  }
  return paths
}

function normalizeProductionBibles(value: unknown): ProductionBiblePreset[] {
  if (!Array.isArray(value)) return []
  const presets: ProductionBiblePreset[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as { name?: unknown; bible?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name || !raw.bible || typeof raw.bible !== 'object') continue
    const bible = normalizeVisualBible(raw.bible as Partial<VisualBible>, name)
    if (presets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) continue
    presets.push({ name, bible })
  }
  return presets.sort((left, right) => left.name.localeCompare(right.name))
}
