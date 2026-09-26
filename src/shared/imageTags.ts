import type { ScriptLine } from './types'

export const REGENERATED_IMAGE_TAG = 'regenerated'

export type TimelineImageFilter = 'all' | 'regenerated'

export function lineImageTags(line: Pick<ScriptLine, 'imageTags'>): string[] {
  return (line.imageTags || []).map((tag) => tag.trim()).filter(Boolean)
}

export function lineHasImageTag(line: Pick<ScriptLine, 'imageTags'>, tag: string): boolean {
  return lineImageTags(line).includes(tag)
}

export function isRegeneratedImage(line: Pick<ScriptLine, 'imageTags'>): boolean {
  return lineHasImageTag(line, REGENERATED_IMAGE_TAG)
}

export function withImageTag(line: ScriptLine, tag: string): ScriptLine {
  const trimmed = tag.trim()
  if (!trimmed) return line
  const tags = lineImageTags(line)
  if (tags.includes(trimmed)) return line
  return { ...line, imageTags: [...tags, trimmed] }
}

export function withoutImageTag(line: ScriptLine, tag: string): ScriptLine {
  const tags = lineImageTags(line).filter((item) => item !== tag)
  if (tags.length === lineImageTags(line).length) return line
  return { ...line, imageTags: tags.length > 0 ? tags : undefined }
}

export function lineIdsWithImageTag<T extends Pick<ScriptLine, 'id' | 'imageTags'>>(
  lines: T[],
  tag: string,
): string[] {
  return lines.filter((line) => lineHasImageTag(line, tag)).map((line) => line.id)
}

export function filterLinesForTimeline<T extends Pick<ScriptLine, 'imageTags'>>(
  lines: T[],
  filter: TimelineImageFilter,
): T[] {
  if (filter === 'regenerated') return lines.filter(isRegeneratedImage)
  return lines
}

export function nextRegeneratedLine<T extends Pick<ScriptLine, 'id' | 'index' | 'imageTags'>>(
  lines: T[],
  afterLineId: string,
): T | undefined {
  const remaining = lines
    .filter((line) => line.id !== afterLineId && isRegeneratedImage(line))
    .slice()
    .sort((left, right) => left.index - right.index)
  if (remaining.length === 0) return undefined
  const afterIndex = lines.find((line) => line.id === afterLineId)?.index ?? -1
  return remaining.find((line) => line.index > afterIndex) || remaining[0]
}

export function adjacentFilteredLine<T extends Pick<ScriptLine, 'id' | 'index' | 'imageTags'>>(
  lines: T[],
  currentId: string | null,
  direction: -1 | 1,
  filter: TimelineImageFilter,
): T | undefined {
  const visible = filterLinesForTimeline(lines, filter)
    .slice()
    .sort((left, right) => left.index - right.index)
  if (visible.length === 0) return undefined
  const currentIndex = visible.findIndex((line) => line.id === currentId)
  if (currentIndex < 0) return direction === 1 ? visible[0] : visible[visible.length - 1]
  return visible[currentIndex + direction]
}
