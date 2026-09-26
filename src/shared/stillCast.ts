import type {
  ScriptLine,
  StillCastBeat,
  StillCastLibraryFolder,
  StillCastLibraryScan,
} from './types'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MIN_BEAT_SECONDS = 0.8

const SYNONYM_GROUPS: string[][] = [
  ['talk', 'talking', 'neutral', 'speak', 'speaking', 'neutral-talking', 'neutral-talk', 'talk-alt', 'talkalt'],
  ['smile', 'happy', 'happiness', 'warm', 'grinning', 'warm-smile'],
  ['serious', 'concerned', 'problem', 'sad'],
  ['skeptical', 'sceptical', 'doubt'],
  ['confused', 'confuse'],
  ['realize', 'realisation', 'surprise', 'shocked'],
  ['frustrated', 'angry', 'annoyed'],
  ['confident', 'smug'],
  ['empathy', 'empathetic', 'kind'],
  ['deadpan', 'unimpressed'],
  ['think', 'thinking', 'chin-think', 'chinthink', 'chin'],
  ['encourage', 'encouraging'],
  ['point', 'pointing'],
  ['stop', 'hold', 'wait'],
  ['shrug'],
  ['count', 'counting'],
  ['present', 'presenting'],
]

const TALKING_FALLBACKS = ['neutral-talking', 'talking', 'talk', 'neutral']

export function slugStillCastName(value: string | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function isStillCastImageFile(fileName: string): boolean {
  const base = fileName.replace(/^.*[\\/]/, '')
  // Support files (e.g. _bg_plate.png) are lock helpers, not cast stills.
  if (base.startsWith('_')) return false
  return IMAGE_EXTENSIONS.has(base.slice(base.lastIndexOf('.')).toLowerCase())
}

export function normalizeStillCastExpression(value: string | undefined): string {
  return slugStillCastName(value)
}

export function stillCastLineMatchKey(value: string): string {
  return normalizeMatchText(value)
}

export function stillCastImageMatchKey(fileName: string): string {
  return normalizeMatchText(fileName.replace(/\.[^.]+$/, ''))
}

export function matchCustomStillToLine<T extends { matchKey: string }>(
  lineText: string,
  stills: readonly T[],
): T | undefined {
  const key = stillCastLineMatchKey(lineText)
  if (!key) return undefined
  return stills.find((still) => still.matchKey === key)
}

export function partitionStillCastTargets<T extends { text: string }>(
  lines: readonly T[],
  stills: readonly { matchKey: string }[],
): { custom: T[]; remaining: T[] } {
  const custom: T[] = []
  const remaining: T[] = []
  for (const line of lines) {
    if (matchCustomStillToLine(line.text, stills)) custom.push(line)
    else remaining.push(line)
  }
  return { custom, remaining }
}

export function stillCastExpressionLabel(
  expression: string,
  folders: StillCastLibraryFolder[] = [],
): string {
  const slug = slugStillCastName(expression)
  if (slug === 'custom') return 'Custom still'
  const folder = resolveStillCastFolder(expression, folders)
  if (folder) return folder.folderName
  if (!slug) return expression
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function stockedStillCastFolders(scan: StillCastLibraryScan): StillCastLibraryFolder[] {
  return scan.folders.filter((folder) => folder.kind !== 'custom' && folder.imagePaths.length > 0)
}

const MIN_PREFIX_MATCH_SCORE = 80
const SCRIPT_EXPRESSION_PREFIX = /^([^:]{1,48}):\s+(\S.*)$/

export function isCustomStillCastExpression(value: string | undefined): boolean {
  return slugStillCastName(value) === 'custom'
}

export function matchStillCastFolder(
  value: string | undefined,
  folders: StillCastLibraryFolder[],
): StillCastLibraryFolder | undefined {
  const best = scoreStillCastFolder(value, folders)
  if (!best || best.score < MIN_PREFIX_MATCH_SCORE) return undefined
  return best.folder
}

export function resolveStillCastFolder(
  value: string | undefined,
  folders: StillCastLibraryFolder[],
): StillCastLibraryFolder | undefined {
  const best = scoreStillCastFolder(value, folders)
  if (best) return best.folder
  if (folders.length === 0) return undefined
  return (
    TALKING_FALLBACKS.map((id) => folders.find((folder) => folder.id === id && folder.imagePaths.length > 0)).find(
      Boolean,
    ) ||
    TALKING_FALLBACKS.map((id) => folders.find((folder) => folder.id === id)).find(Boolean) ||
    folders.find((folder) => folder.imagePaths.length > 0) ||
    folders[0]
  )
}

export interface CustomStillCastLine {
  spoken: string
  fileName: string
  shotNote?: string
}

export function customStillCastFileName(spoken: string): string {
  const base = spoken.trim().replace(/[.?!…,;:]+$/g, '').trim()
  return `${base || spoken.trim()}.png`
}

/** Spoken-line filename that Windows can save, while keeping the custom-still match key. */
export function customStillOutputFileName(spoken: string): string {
  const preferred = customStillCastFileName(spoken).replace(/\.png$/i, '')
  const safe = preferred
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return `${safe || 'custom'}.png`
}

export function extractCustomStillCastLines(script: string): CustomStillCastLine[] {
  return script
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((raw) => parseStillCastScriptLine(raw.trim()))
    .filter((parsed) => parsed.expression === 'custom' && Boolean(parsed.text.trim()))
    .map((parsed) => ({
      spoken: parsed.text.trim(),
      fileName: customStillCastFileName(parsed.text),
      ...(parsed.shotNote ? { shotNote: parsed.shotNote } : {}),
    }))
}

/** Every spoken line in a script — used for 9:16 shorts where each line needs a Custom-9x16 still. */
export function extractSpokenStillCastLines(script: string): CustomStillCastLine[] {
  return script
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((raw) => parseStillCastScriptLine(raw.trim()))
    .filter((parsed) => Boolean(parsed.text.trim()))
    .map((parsed) => ({
      spoken: parsed.text.trim(),
      fileName: customStillCastFileName(parsed.text),
    }))
}

export function spokenStillCastLinesFromScriptLines(
  lines: ReadonlyArray<{ text: string }>,
): CustomStillCastLine[] {
  return lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .map((spoken) => ({
      spoken,
      fileName: customStillCastFileName(spoken),
    }))
}

export function splitShotNote(value: string): { text: string; shotNote?: string } {
  const pipe = value.indexOf('|')
  if (pipe === -1) return { text: value.trim() }
  const text = value.slice(0, pipe).trim()
  const shotNote = value.slice(pipe + 1).trim()
  if (!text || !shotNote) return { text: value.trim() }
  return { text, shotNote }
}

export function parseStillCastScriptLine(
  raw: string,
  folders: StillCastLibraryFolder[] = [],
): { text: string; expression?: string; shotNote?: string } {
  const text = raw.trim()
  const match = text.match(SCRIPT_EXPRESSION_PREFIX)
  if (!match) return splitShotNote(text)
  const label = match[1].trim()
  const spoken = splitShotNote(match[2].trim())
  if (!spoken.text) return { text }
  if (isCustomStillCastExpression(label)) {
    return { text: spoken.text, expression: 'custom', ...(spoken.shotNote ? { shotNote: spoken.shotNote } : {}) }
  }
  const folder = matchStillCastFolder(label, folders)
  if (folder) {
    return {
      text: spoken.text,
      expression: folder.id,
      ...(spoken.shotNote ? { shotNote: spoken.shotNote } : {}),
    }
  }
  if (folders.length === 0 && isPlausibleExpressionLabel(label)) {
    return {
      text: spoken.text,
      expression: slugStillCastName(label),
      ...(spoken.shotNote ? { shotNote: spoken.shotNote } : {}),
    }
  }
  return { text }
}

export function applyStillCastScriptPrefixes<T extends { text: string }>(
  lines: readonly T[],
  folders: StillCastLibraryFolder[] = [],
): Array<T & { expression?: string; shotNote?: string }> {
  return lines.map((line) => {
    const parsed = parseStillCastScriptLine(line.text, folders)
    return {
      ...line,
      text: parsed.text,
      ...(parsed.expression ? { expression: parsed.expression } : {}),
      ...(parsed.shotNote ? { shotNote: parsed.shotNote } : {}),
    }
  })
}

export function createStillCastBeatId(): string {
  return globalThis.crypto.randomUUID()
}

export function normalizeStillBeats(value: unknown): StillCastBeat[] {
  if (!Array.isArray(value)) return []
  const beats: StillCastBeat[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as Partial<StillCastBeat>
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (!text) continue
    const id =
      typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createStillCastBeatId()
    const imagePath = typeof raw.imagePath === 'string' ? raw.imagePath.trim() : ''
    const expression = normalizeStillCastExpression(raw.expression) || 'neutral'
    beats.push({
      id,
      text,
      expression,
      ...(imagePath ? { imagePath } : {}),
    })
  }
  return beats
}

export function lineHasStillCastBeats(line: Pick<ScriptLine, 'stillBeats'>): boolean {
  return Boolean(line.stillBeats && line.stillBeats.length > 0)
}

export function lineStillCastImagesReady(line: Pick<ScriptLine, 'stillBeats' | 'imagePath' | 'sceneStatus'>): boolean {
  if (lineHasStillCastBeats(line)) {
    return (line.stillBeats || []).every((beat) => Boolean(beat.imagePath))
  }
  return line.sceneStatus === 'complete' && Boolean(line.imagePath)
}

export function stillBeatDurations(beats: StillCastBeat[], totalDuration: number): number[] {
  if (beats.length === 0) return []
  const safeTotal = Math.max(MIN_BEAT_SECONDS, totalDuration)
  const weights = beats.map((beat) => Math.max(1, beat.text.trim().split(/\s+/).filter(Boolean).length))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const raw = weights.map((weight) => (weight / weightSum) * safeTotal)
  const minTotal = MIN_BEAT_SECONDS * beats.length
  if (minTotal <= safeTotal + 0.001) {
    const extra = safeTotal - minTotal
    const surplus = raw.map((value) => Math.max(0, value - MIN_BEAT_SECONDS))
    const surplusSum = surplus.reduce((sum, value) => sum + value, 0)
    if (surplusSum <= 0) {
      return raw.map(() => safeTotal / beats.length)
    }
    return surplus.map((value) => MIN_BEAT_SECONDS + (value / surplusSum) * extra)
  }
  return raw.map((value) => (value / raw.reduce((sum, item) => sum + item, 0)) * safeTotal)
}

export function pickStillImage(
  expression: string,
  scan: StillCastLibraryScan,
  avoidPaths: Iterable<string> = [],
): string | undefined {
  const folder = resolveStillCastFolder(expression, scan.folders)
  if (!folder || folder.imagePaths.length === 0) return undefined
  const avoided = new Set(avoidPaths)
  const unused = folder.imagePaths.filter((imagePath) => !avoided.has(imagePath))
  const pool = unused.length > 0 ? unused : folder.imagePaths
  return pool[Math.floor(Math.random() * pool.length)]
}

/** One still per expression line. Numbered files (01, 02, 03) are alternate poses, not a sequence. */
export function expressionPlaybackBeats(beats: StillCastBeat[], lineId = ''): StillCastBeat[] {
  if (beats.length <= 1) return beats
  const expression = beats[0]?.expression
  if (!expression || isCustomStillCastExpression(expression)) return beats
  if (!beats.every((beat) => beat.expression === expression)) return beats
  const index = stableVariantIndex(lineId || beats[0].id, beats.length)
  return [beats[index]]
}

function stableVariantIndex(seed: string, count: number): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33 + seed.charCodeAt(index)) >>> 0
  }
  return hash % count
}

export function mergeLibraryFolders(folders: StillCastLibraryFolder[]): StillCastLibraryFolder[] {
  const byId = new Map<string, StillCastLibraryFolder>()
  for (const folder of folders) {
    const id = slugStillCastName(folder.id) || slugStillCastName(folder.folderName)
    if (!id) continue
    const existing = byId.get(id)
    if (existing) {
      existing.imagePaths = [...new Set([...existing.imagePaths, ...folder.imagePaths])]
      continue
    }
    byId.set(id, {
      id,
      folderName: folder.folderName,
      imagePaths: [...folder.imagePaths],
      ...(folder.kind ? { kind: folder.kind } : {}),
    })
  }
  return [...byId.values()].sort((left, right) => left.folderName.localeCompare(right.folderName))
}

export interface StillCastLineBeats {
  lineId: string
  beats: Array<{ text: string; expression: string }>
}

export function applyStillCastBeatsToLine(
  line: ScriptLine,
  beats: Array<{ text: string; expression: string }>,
  folders: StillCastLibraryFolder[] = [],
): StillCastBeat[] {
  const fallback = resolveStillCastFolder('neutral-talking', folders)?.id || 'neutral'
  const normalized = beats
    .map((beat) => ({
      text: beat.text.trim(),
      expression: resolveStillCastFolder(beat.expression, folders)?.id || normalizeStillCastExpression(beat.expression) || fallback,
    }))
    .filter((beat) => beat.text)
  if (normalized.length === 0) {
    return [
      {
        id: createStillCastBeatId(),
        text: line.text.trim(),
        expression: fallback,
      },
    ]
  }
  return normalized.map((beat) => ({
    id: createStillCastBeatId(),
    text: beat.text,
    expression: beat.expression,
  }))
}

export function stillCastDirectionSummary(beats: StillCastBeat[]): string {
  return beats.map((beat) => `${beat.expression}: ${beat.text}`).join(' · ')
}

function scoreStillCastFolder(
  value: string | undefined,
  folders: StillCastLibraryFolder[],
): { folder: StillCastLibraryFolder; score: number } | undefined {
  if (folders.length === 0) return undefined
  const query = slugStillCastName(value)
  if (!query) return undefined
  let best: { folder: StillCastLibraryFolder; score: number } | undefined
  const expanded = synonymKeys(query)
  for (const folder of folders) {
    const id = folder.id
    const name = slugStillCastName(folder.folderName)
    let score = 0
    if (id === query || name === query) score = 100
    else if (expanded.has(id) || expanded.has(name)) {
      score = 80
      if (id.includes(query) || name.includes(query)) score += 10
    } else if (
      [...expanded].some(
        (key) =>
          key.length >= 4 &&
          (id.includes(key) || name.includes(key) || key.includes(id) || key.includes(name)),
      )
    ) {
      score = 40
    }
    if (score > 0 && (!best || score > best.score || (score === best.score && id.length > best.folder.id.length))) {
      best = { folder, score }
    }
  }
  return best
}

function isPlausibleExpressionLabel(label: string): boolean {
  return /^[A-Za-z][A-Za-z0-9' -]{0,47}$/.test(label) && label.split(/\s+/).filter(Boolean).length <= 5
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[''`´‘’“”"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function synonymKeys(slug: string): Set<string> {
  const keys = new Set<string>([slug])
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(slug)) {
      for (const key of group) keys.add(key)
    }
  }
  return keys
}
