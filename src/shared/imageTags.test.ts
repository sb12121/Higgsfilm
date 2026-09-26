import { describe, expect, it } from 'vitest'
import type { ScriptLine } from './types'
import {
  adjacentFilteredLine,
  filterLinesForTimeline,
  isRegeneratedImage,
  lineIdsWithImageTag,
  nextRegeneratedLine,
  REGENERATED_IMAGE_TAG,
  withImageTag,
  withoutImageTag,
} from './imageTags'

function line(id: string, index = 0, tags?: string[]): ScriptLine {
  return {
    id,
    index,
    text: id,
    startTime: 0,
    endTime: 1,
    duration: 1,
    status: 'draft',
    scenePrompt: '',
    directionStatus: 'draft',
    sceneStatus: 'complete',
    imageTags: tags,
  }
}

describe('imageTags', () => {
  it('tags a regenerated image without duplicating the tag', () => {
    const tagged = withImageTag(line('a'), REGENERATED_IMAGE_TAG)
    expect(isRegeneratedImage(tagged)).toBe(true)
    expect(withImageTag(tagged, REGENERATED_IMAGE_TAG).imageTags).toEqual([REGENERATED_IMAGE_TAG])
  })

  it('clears the regenerated tag when the image is marked good', () => {
    const tagged = withImageTag(line('a'), REGENERATED_IMAGE_TAG)
    expect(withoutImageTag(tagged, REGENERATED_IMAGE_TAG).imageTags).toBeUndefined()
  })

  it('collects regenerated line ids so a full regenerate can clear the review filter', () => {
    const lines = [
      withImageTag(line('keep'), REGENERATED_IMAGE_TAG),
      line('skip'),
      withImageTag(line('also'), REGENERATED_IMAGE_TAG),
    ]
    expect(lineIdsWithImageTag(lines, REGENERATED_IMAGE_TAG)).toEqual(['keep', 'also'])
  })

  it('filters the timeline down to regenerated images', () => {
    const lines = [
      withImageTag(line('keep'), REGENERATED_IMAGE_TAG),
      line('skip'),
      withImageTag(line('also'), REGENERATED_IMAGE_TAG),
    ]
    expect(filterLinesForTimeline(lines, 'all')).toHaveLength(3)
    expect(filterLinesForTimeline(lines, 'regenerated').map((item) => item.id)).toEqual([
      'keep',
      'also',
    ])
  })

  it('moves to the next regenerated clip after one is marked good', () => {
    const remaining = [
      line('accepted', 1),
      withImageTag(line('later', 4), REGENERATED_IMAGE_TAG),
      line('plain', 5),
      withImageTag(line('earlier', 0), REGENERATED_IMAGE_TAG),
    ]
    expect(nextRegeneratedLine(remaining, 'accepted')?.id).toBe('later')
    expect(nextRegeneratedLine(remaining, 'later')?.id).toBe('earlier')
    expect(nextRegeneratedLine([line('accepted', 1)], 'accepted')).toBeUndefined()
  })

  it('steps previous and next within the regenerated filter', () => {
    const lines = [
      withImageTag(line('a', 0), REGENERATED_IMAGE_TAG),
      line('b', 1),
      withImageTag(line('c', 2), REGENERATED_IMAGE_TAG),
      line('d', 3),
      withImageTag(line('e', 4), REGENERATED_IMAGE_TAG),
    ]
    expect(adjacentFilteredLine(lines, 'a', 1, 'regenerated')?.id).toBe('c')
    expect(adjacentFilteredLine(lines, 'c', 1, 'regenerated')?.id).toBe('e')
    expect(adjacentFilteredLine(lines, 'e', 1, 'regenerated')).toBeUndefined()
    expect(adjacentFilteredLine(lines, 'c', -1, 'regenerated')?.id).toBe('a')
    expect(adjacentFilteredLine(lines, 'b', 1, 'all')?.id).toBe('c')
  })
})
