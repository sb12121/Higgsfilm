import { describe, expect, it } from 'vitest'
import type { ContinuityCanon, SceneLedgerEntry, ScriptLine, VisualBible } from './types'
import { buildSceneDirectionPrompt } from './sceneDirectionPrompt'

const visualBible: VisualBible = {
  name: 'Test bible',
  style: 'clean rounded 2D cartoon',
  characters: 'golden retriever with a blue collar and owner with short brown hair',
  mainCharacter: 'Male golden retriever with warm gold fur and a blue collar.',
  supportingCharacter: 'Owner with short brown hair, a green sweater, and round glasses.',
  setting: 'bright apartment entryway',
  palette: 'warm flat colors',
  camera: 'readable cinematic compositions',
  negativePrompt: 'extra limbs, text, watermarks',
}

const canon: ContinuityCanon = {
  version: 1,
  sourceFingerprint: 'canon-1',
  summary: 'A golden retriever waits in a bright apartment while the owner prepares to leave.',
  subject: 'golden retriever',
  cast: ['golden retriever with warm gold fur and a blue collar'],
  locations: ['bright apartment entryway'],
  props: ['red front door'],
  visualMotifs: ['anticipation at the doorway'],
}

function line(index: number, text: string, paragraphIndex = 0): ScriptLine {
  return {
    id: `line-${index}`,
    index,
    paragraphIndex,
    text,
    startTime: index,
    endTime: index + 1,
    duration: 1,
    status: 'draft',
    scenePrompt: '',
    directionStatus: 'draft',
    sceneStatus: 'draft',
  }
}

describe('scene direction prompt', () => {
  it('includes full script, paragraph, target, canon, ledger, and plain-text output rules', () => {
    const target = line(1, 'The owner reaches for the keys.')
    const prompt = buildSceneDirectionPrompt({
      sequence: 'main',
      targetLine: target,
      sequenceLines: [
        line(0, 'The golden retriever waits by the door.'),
        target,
        line(2, 'The apartment grows quiet.', 1),
      ],
      visualBible,
      canon,
      acceptedLedger: [
        {
          lineId: 'line-0',
          lineIndex: 0,
          direction:
            'A golden retriever with warm gold fur and a blue collar waits beside a closed red front door in a medium entryway shot.',
        },
      ] satisfies SceneLedgerEntry[],
    })

    expect(prompt).toContain('The golden retriever waits by the door.')
    expect(prompt).toContain('The owner reaches for the keys.')
    expect(prompt).toContain('The apartment grows quiet.')
    expect(prompt).toContain(canon.summary)
    expect(prompt).toContain('A golden retriever with warm gold fur')
    expect(prompt).toContain('AUTHORITATIVE MAIN CHARACTER LOCK')
    expect(prompt).toContain('Owner with short brown hair')
    expect(prompt).toContain('Return only one highly detailed')
    expect(prompt).toContain('Exactly zero characters:')
    expect(prompt).toContain('Never include more than three characters')
    expect(prompt).toContain('CONCRETE CHARACTER REFERENCE')
    expect(prompt).not.toContain('Style: clean rounded 2D cartoon')
    expect(prompt).not.toContain('Palette:')
    expect(prompt).not.toContain('Camera:')
    expect(prompt).not.toContain('Avoid:')
    expect(prompt).toContain('Do not return JSON')
  })

  it('includes refinements and retry feedback without changing the output contract', () => {
    const target = line(0, 'The dog notices a new package.')
    const prompt = buildSceneDirectionPrompt({
      sequence: 'main',
      targetLine: target,
      sequenceLines: [target],
      visualBible,
      acceptedLedger: [],
      refinement: 'Use a low camera angle and keep the package on the floor.',
      retryFeedback: 'The previous response was empty.',
    })

    expect(prompt).toContain('USER REFINEMENT')
    expect(prompt).toContain('low camera angle')
    expect(prompt).toContain('CORRECTIVE RETRY FEEDBACK')
    expect(prompt).toContain('The previous response was empty.')
    expect(prompt).toContain('Do not return JSON')
  })

  it('uses the Z-Image Turbo director recipe when that workflow is selected', () => {
    const target = line(0, 'The dog brings back a sock.')
    const prompt = buildSceneDirectionPrompt({
      sequence: 'main',
      targetLine: target,
      sequenceLines: [target],
      visualBible,
      canon,
      acceptedLedger: [],
      promptingWorkflow: 'z-image-turbo',
    })

    expect(prompt).toContain('Z-Image Turbo')
    expect(prompt).toContain('70–110 words')
    expect(prompt).toContain('Exactly one character:')
    expect(prompt).toContain('At most three')
    expect(prompt).toContain('bite geometry')
    expect(prompt).toContain('jaws parted')
    expect(prompt).toContain('head attached to a neck')
    expect(prompt).toContain('between the natural jaws')
    expect(prompt).toContain('clothed bipedal adult')
    expect(prompt).toContain('two different species')
    expect(prompt).toContain('The word "owner" is not enough')
    expect(prompt).toContain('Leave people, animals, silhouettes, and walking figures unmentioned')
    expect(prompt).not.toContain('80–150 words')
    expect(prompt).not.toContain('should the object appear between the natural jaws')
    expect(prompt).not.toContain('highly detailed, self-contained paragraph')
    expect(prompt).not.toContain('should the object appear between the natural jaws')
    expect(prompt).not.toContain('highly detailed, self-contained paragraph')
  })
})
