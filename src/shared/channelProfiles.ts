import {
  DEFAULT_COMFY_UI_SETTINGS,
  normalizeComfyUiSettings,
  type ChannelImageProfile,
  type ChannelImageProfileInput,
  type ChannelProductionMode,
  type ChannelProfileState,
  type ComfyUiSettings,
  type ImageGenerator,
  type StudioSettings,
  type VisualBible,
} from './types'

const IMAGE_GENERATORS: ImageGenerator[] = ['higgsfield', 'chatgpt', 'comfyui']

export function emptyVisualBible(name = ''): VisualBible {
  return {
    name,
    style: '',
    characters: '',
    mainCharacter: '',
    supportingCharacter: '',
    setting: '',
    palette: '',
    camera: '',
    negativePrompt: '',
  }
}

export function normalizeVisualBible(
  value: Partial<VisualBible> | null | undefined,
  fallbackName: string,
): VisualBible {
  const source = value || {}
  const text = (field: keyof VisualBible): string =>
    typeof source[field] === 'string' ? (source[field] as string) : ''
  return {
    name: text('name').trim() || fallbackName,
    style: text('style'),
    characters: text('characters'),
    mainCharacter: text('mainCharacter'),
    supportingCharacter: text('supportingCharacter'),
    setting: text('setting'),
    palette: text('palette'),
    camera: text('camera'),
    negativePrompt: text('negativePrompt'),
  }
}

export function normalizeChannelImageProfile(
  value: unknown,
): ChannelImageProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ChannelImageProfile> & { bible?: unknown }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
  if (!id) return null
  const bibleSource =
    raw.visualBible && typeof raw.visualBible === 'object'
      ? raw.visualBible
      : raw.bible && typeof raw.bible === 'object'
        ? (raw.bible as Partial<VisualBible>)
        : null
  if (!bibleSource) return null
  const imageGenerator = IMAGE_GENERATORS.includes(raw.imageGenerator as ImageGenerator)
    ? (raw.imageGenerator as ImageGenerator)
    : 'higgsfield'
  const productionMode: ChannelProductionMode =
    raw.productionMode === 'still-cast' ? 'still-cast' : 'generate'
  const channelFolderPath =
    typeof raw.channelFolderPath === 'string' ? raw.channelFolderPath.trim() : ''
  const stillLibraryPath =
    typeof raw.stillLibraryPath === 'string' ? raw.stillLibraryPath.trim() : ''
  const scriptBiblePath =
    typeof raw.scriptBiblePath === 'string' ? raw.scriptBiblePath.trim() : ''
  const ideaGuidePath =
    typeof raw.ideaGuidePath === 'string' ? raw.ideaGuidePath.trim() : ''
  return {
    id,
    name,
    visualBible: normalizeVisualBible(bibleSource, name),
    imageGenerator,
    comfy: normalizeComfyUiSettings(raw.comfy),
    productionMode,
    channelFolderPath,
    stillLibraryPath,
    scriptBiblePath,
    ideaGuidePath,
    niche: typeof raw.niche === 'string' ? raw.niche.trim() : '',
    youtubeHandle: normalizeYoutubeChannelHandle(
      typeof raw.youtubeHandle === 'string' ? raw.youtubeHandle : '',
    ),
    channelBrief: typeof raw.channelBrief === 'string' ? raw.channelBrief.trim() : '',
    channelBriefUpdatedAt:
      typeof raw.channelBriefUpdatedAt === 'string' ? raw.channelBriefUpdatedAt.trim() : '',
  }
}

/** Normalize handles like "Graham Stephan", "@nischa", or youtube.com/@nischa URLs. */
export function normalizeYoutubeChannelHandle(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^UC[\w-]{20,}$/.test(trimmed)) return trimmed
  const fromUrl = trimmed.match(/youtube\.com\/(?:@|c\/|channel\/)?([^/?#\s]+)/i)?.[1]
  const raw = (fromUrl || trimmed).replace(/^@/, '').replace(/[^\w.-]+/g, '')
  if (!raw) return ''
  if (/^UC[\w-]{20,}$/.test(raw)) return raw
  return `@${raw}`
}

export function normalizeChannelProfileState(
  profiles: unknown,
  activeProfileId: unknown,
): ChannelProfileState {
  if (!Array.isArray(profiles)) {
    return { profiles: [], activeProfileId: '' }
  }
  const normalized: ChannelImageProfile[] = []
  for (const candidate of profiles) {
    const profile = normalizeChannelImageProfile(candidate)
    if (!profile) continue
    if (normalized.some((existing) => existing.id === profile.id)) continue
    if (
      normalized.some((existing) => existing.name.toLowerCase() === profile.name.toLowerCase())
    ) {
      continue
    }
    normalized.push(profile)
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name))
  const requestedId = typeof activeProfileId === 'string' ? activeProfileId.trim() : ''
  const activeProfileIdResolved = normalized.some((profile) => profile.id === requestedId)
    ? requestedId
    : ''
  return { profiles: normalized, activeProfileId: activeProfileIdResolved }
}

export function applyChannelProfileToSettings(
  settings: StudioSettings,
  profile: ChannelImageProfile,
): StudioSettings {
  return {
    ...settings,
    imageGenerator: profile.imageGenerator,
    comfy: normalizeComfyUiSettings({
      ...profile.comfy,
      baseUrl: settings.comfy.baseUrl || DEFAULT_COMFY_UI_SETTINGS.baseUrl,
    }),
  }
}

export function channelProfileFromInput(
  input: ChannelImageProfileInput,
  existingId?: string,
): ChannelImageProfile {
  const name = input.name.trim()
  const id = (input.id || existingId || '').trim()
  if (!name) throw new Error('Enter a name for the YouTube channel profile.')
  if (!id) throw new Error('The channel profile is missing an id.')
  return {
    id,
    name,
    visualBible: normalizeVisualBible(input.visualBible, name),
    imageGenerator: IMAGE_GENERATORS.includes(input.imageGenerator)
      ? input.imageGenerator
      : 'higgsfield',
    comfy: normalizeComfyUiSettings(input.comfy),
    productionMode: input.productionMode === 'still-cast' ? 'still-cast' : 'generate',
    channelFolderPath: input.channelFolderPath?.trim() || '',
    stillLibraryPath: input.stillLibraryPath?.trim() || '',
    scriptBiblePath: input.scriptBiblePath?.trim() || '',
    ideaGuidePath: input.ideaGuidePath?.trim() || '',
    niche: input.niche?.trim() || '',
    youtubeHandle: normalizeYoutubeChannelHandle(input.youtubeHandle || ''),
    channelBrief: input.channelBrief?.trim() || '',
    channelBriefUpdatedAt: input.channelBriefUpdatedAt?.trim() || '',
  }
}

export function channelProfileMatchesCurrent(
  profile: ChannelImageProfile,
  settings: StudioSettings,
  visualBible?: VisualBible,
): boolean {
  if (profile.imageGenerator !== settings.imageGenerator) return false
  if (comfySnapshot(profile.comfy) !== comfySnapshot(settings.comfy)) return false
  if (!visualBible) return true
  return JSON.stringify(profile.visualBible) === JSON.stringify(visualBible)
}

function comfySnapshot(comfy: ComfyUiSettings): string {
  const normalized = normalizeComfyUiSettings(comfy)
  const { baseUrl: _baseUrl, ...rest } = normalized
  return JSON.stringify(rest)
}
