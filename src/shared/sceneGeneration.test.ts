import { describe, expect, it } from 'vitest'
import type { ScriptLine } from './types'
import {
  buildSceneGenerationJobPlans,
  mergeSceneLedgers,
  sceneGenerationWaves,
  sceneLineMatchesSnapshot,
} from './sceneGeneration'

function line(index: number, paragraphIndex: number): ScriptLine {
  return {
    id: `line-${index}`,
    index,
    paragraphIndex,
    text: `Narration line ${index}`,
    startTime: index,
    endTime: index + 1,
    duration: 1,
    status: 'draft',
    scenePrompt: '',
    directionStatus: 'draft',
    sceneStatus: 'draft',
  }
}

describe('scene generation scheduling', () => {
  it('builds exact paragraph/chunk coverage without array-position assumptions', () => {
    const lines = [
      ...Array.from({ length: 9 }, (_, index) => line(index, 0)),
      line(9, 1),
    ]
    const plans = buildSceneGenerationJobPlans(
      lines,
      ['line-0', 'line-2', 'line-8', 'line-9'],
      2,
    )

    expect(plans).toEqual([
      {
        paragraphIndex: 0,
        chunkIndex: 0,
        paragraphLineIds: lines.slice(0, 9).map((item) => item.id),
        targetLineIds: ['line-0', 'line-2'],
      },
      {
        paragraphIndex: 0,
        chunkIndex: 1,
        paragraphLineIds: lines.slice(0, 9).map((item) => item.id),
        targetLineIds: ['line-8'],
      },
      {
        paragraphIndex: 1,
        chunkIndex: 0,
        paragraphLineIds: ['line-9'],
        targetLineIds: ['line-9'],
      },
    ])
  })

  it('keeps active worker waves bounded at five', () => {
    expect(sceneGenerationWaves([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7],
    ])
  })

  it('merges committed ledger entries by line ID and preserves ordered anchors', () => {
    const first = {
      lineId: 'line-2',
      lineIndex: 2,
      direction: 'A red toolbox sits open on a workbench in a close detail shot.',
      focalSubject: 'prop',
      visualAction: 'turns',
      shotType: 'close',
      setting: 'room',
      propState: 'open',
      variationReason: 'detail',
    }
    const replacement = { ...first, focalSubject: 'reaction' }
    const earlier = { ...first, lineId: 'line-1', lineIndex: 1 }
    expect(mergeSceneLedgers([first], [replacement, earlier])).toEqual([earlier, replacement])
  })

  it('detects a changed target signature before commit', () => {
    const snapshot = line(1, 0)
    expect(sceneLineMatchesSnapshot(snapshot, structuredClone(snapshot))).toBe(true)
    expect(sceneLineMatchesSnapshot({ ...snapshot, text: 'edited' }, snapshot)).toBe(false)
    expect(sceneLineMatchesSnapshot({ ...snapshot, paragraphIndex: 1 }, snapshot)).toBe(false)
  })
})
