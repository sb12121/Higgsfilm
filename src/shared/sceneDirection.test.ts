import { describe, expect, it } from 'vitest'
import type { ContinuityCanon, ScriptLine } from './types'
import {
  parseSceneDirectionBatchResponse,
  parseSceneDirectionResponse,
  validateSceneDirection,
} from './sceneDirection'

const line: ScriptLine = {
  id: 'line-1',
  index: 0,
  paragraphIndex: 0,
  text: 'The dog waits by the door while the owner gets ready.',
  startTime: 0,
  endTime: 3,
  duration: 3,
  status: 'draft',
  scenePrompt: '',
  directionStatus: 'draft',
  sceneStatus: 'draft',
}

const canon: ContinuityCanon = {
  version: 1,
  sourceFingerprint: 'abc123',
  summary: 'A golden retriever waits in a bright apartment while the owner prepares to leave.',
  subject: 'golden retriever',
  cast: ['golden retriever with warm gold fur and a blue collar', 'owner with short brown hair'],
  locations: ['bright apartment entryway'],
  props: ['red front door', 'blue collar'],
  visualMotifs: ['anticipation at the doorway'],
}

const secondLine: ScriptLine = {
  ...line,
  id: 'line-2',
  index: 1,
  text: 'The owner reaches for the keys.',
}

function validResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lineId: line.id,
    scene: {
      focalSubject: 'golden retriever reaction',
      visualAction: 'golden retriever sits alert beside the red front door and looks toward the owner',
      shotType: 'medium reaction shot from the entryway',
      setting: 'bright apartment entryway with a closed red front door and pale floor',
      visibleCharacters: [
        'golden retriever with warm gold fur, rounded head, blue collar, two visible eyes, raised eyebrows, dark nose, and a small expectant mouth',
      ],
      visibleProps: ['closed red front door', 'blue collar'],
      propState: 'red front door is closed',
      variationReason: 'reaction shot shifts attention from prior action to anticipation',
      direction:
        'A golden retriever with warm gold fur, a rounded head, and a blue collar sits beside a closed red front door in a bright apartment entryway. The golden retriever has two visible alert eyes, raised eyebrows, a dark nose, and a small expectant mouth while looking toward an owner with short brown hair near the doorway. Pale floor and uncluttered walls frame the medium reaction shot.',
      ...overrides,
    },
  })
}

describe('scene direction contract', () => {
  it('accepts one exact, self-contained structured scene', () => {
    const parsed = parseSceneDirectionResponse(validResponse(), line, 'abc123', {
      canon,
      acceptedLedger: [],
      narration: line.text,
    })

    expect(parsed.record.lineId).toBe(line.id)
    expect(parsed.record.version).toBe(1)
    expect(parsed.record.focalSubject).toContain('reaction')
  })

  it('accepts an empty prop state when the scene has no props', () => {
    const parsed = parseSceneDirectionResponse(
      validResponse({ visibleProps: [], propState: '' }),
      line,
      'abc123',
      {
        canon,
        acceptedLedger: [],
        narration: line.text,
      },
    )

    expect(parsed.record.visibleProps).toBeUndefined()
    expect(parsed.record.propState).toBeUndefined()
  })

  it('accepts a complete paragraph batch in target-line order', () => {
    const first = JSON.parse(validResponse()) as {
      lineId: string
      scene: Record<string, unknown>
    }
    const second = structuredClone(first)
    second.lineId = secondLine.id
    second.scene.focalSubject = 'owner and key detail'
    second.scene.visualAction =
      'owner with short brown hair reaches toward a brass key ring on a narrow entryway shelf'
    second.scene.shotType = 'close prop interaction shot'
    second.scene.setting = 'bright apartment entryway with a narrow shelf beside a closed red front door'
    second.scene.visibleCharacters = [
      'owner with short brown hair, rounded face, two visible eyes, raised eyebrows, dark nose, and focused mouth',
    ]
    second.scene.visibleProps = ['brass key ring', 'narrow shelf', 'closed red front door']
    second.scene.propState = 'brass key ring rests on the narrow shelf'
    second.scene.variationReason = 'prop-focused beat shifts attention to departure preparation'
    second.scene.direction =
      'An owner with short brown hair and a rounded face reaches toward a brass key ring on a narrow shelf in a bright apartment entryway. The owner has two visible focused eyes, raised eyebrows, a dark nose, and a determined mouth. A closed red front door stands beside the shelf in a close prop interaction shot.'

    const records = parseSceneDirectionBatchResponse(
      JSON.stringify({ scenes: [second, first] }),
      [line, secondLine],
      'abc123',
      { canon, acceptedLedger: [], narration: line.text },
    )

    expect(records.map((record) => record.lineId)).toEqual([line.id, secondLine.id])
  })

  it('rejects missing, duplicate, and unknown IDs in a paragraph batch', () => {
    const first = JSON.parse(validResponse())
    expect(() =>
      parseSceneDirectionBatchResponse(
        JSON.stringify({ scenes: [first, { ...first, lineId: 'unknown' }] }),
        [line, secondLine],
        'abc123',
        { canon, narration: line.text },
      ),
    ).toThrow(/unknown line ID|omitted/i)

    expect(() =>
      parseSceneDirectionBatchResponse(
        JSON.stringify({ scenes: [first, first] }),
        [line, secondLine],
        'abc123',
        { canon, narration: line.text },
      ),
    ).toThrow(/duplicate line ID|omitted/i)
  })

  it('accepts plain text and rejects malformed structured responses', () => {
    const plain = parseSceneDirectionResponse(
      'A golden retriever sits beside a closed red front door in a bright apartment entryway, looking toward the owner in a medium reaction shot.',
      line,
      'abc123',
      { canon, narration: line.text },
    )
    expect(plain.record.direction).toContain('golden retriever')

    const compactJson = parseSceneDirectionResponse(
      JSON.stringify({
        lineId: line.id,
        direction:
          'A golden retriever pauses beside the closed red front door in the bright apartment entryway, framed in a medium profile shot.',
      }),
      line,
      'abc123',
      { canon, narration: line.text },
    )
    expect(compactJson.record.direction).toContain('medium profile shot')

    const fenced = parseSceneDirectionResponse(
      '```text\nA golden retriever watches the bright entryway from beside the closed red front door in a calm medium shot.\n```',
      line,
      'abc123',
      { canon, narration: line.text },
    )
    expect(fenced.record.direction).not.toContain('```')

    expect(() =>
      parseSceneDirectionResponse('too short', line, 'abc123', {
        canon,
        narration: line.text,
      }),
    ).toThrow(/too short|empty/i)

    expect(() =>
      parseSceneDirectionResponse(
        validResponse().replace('"line-1"', '"line-2"'),
        line,
        'abc123',
        { canon, narration: line.text },
      ),
    ).toThrow(/wrong line ID/i)

    expect(() =>
      parseSceneDirectionResponse(
        JSON.stringify({ lineId: line.id, scenes: [JSON.parse(validResponse())] }),
        line,
        'abc123',
        { canon, narration: line.text },
      ),
    ).toThrow(/empty visual direction/i)
  })

  it('returns warnings without rejecting usable visual prose', () => {
    const payload = JSON.parse(validResponse()) as {
      scene: Record<string, unknown>
    }
    payload.scene.direction = 'The same dog does the same thing as before because it is familiar.'
    const parsed = parseSceneDirectionResponse(
      JSON.stringify({ lineId: line.id, scene: payload.scene }),
      line,
      'abc123',
      {
        canon,
        narration: line.text,
      },
    )
    expect(parsed.record.direction).toContain('same dog')
    expect(parsed.warnings.join(' ')).toMatch(/continuity shorthand|pronoun/i)

    payload.scene.direction = line.text
    const copied = parseSceneDirectionResponse(
      JSON.stringify({ lineId: line.id, scene: payload.scene }),
      line,
      'abc123',
      {
        canon,
        narration: line.text,
      },
    )
    expect(copied.warnings.join(' ')).toMatch(/copies the narration/i)
  })

  it('warns about animal carrying without rejecting the visual direction', () => {
    const carrying = JSON.parse(validResponse()) as {
      lineId: string
      scene: Record<string, unknown>
    }
    carrying.scene.visualAction = 'golden retriever carries a red ball across the entryway'
    carrying.scene.direction =
      'A golden retriever with warm gold fur and a blue collar carries a red ball between natural jaws across the bright apartment entryway. Two visible eyes, raised eyebrows, a dark nose, and a focused mouth show purposeful movement. The red front door remains closed in the medium side shot.'
    const accepted = parseSceneDirectionResponse(
      JSON.stringify(carrying),
      line,
      'abc123',
      {
        canon,
        narration: line.text,
      },
    )
    expect(accepted.record.direction).toContain('natural jaws')

    carrying.scene.direction =
      'A golden retriever with warm gold fur and a blue collar carries a red ball across the bright apartment entryway. Two visible eyes, raised eyebrows, a dark nose, and a focused mouth show purposeful movement. The red front door remains closed in the medium side shot.'
    const missingMouth = parseSceneDirectionResponse(
      JSON.stringify(carrying),
      line,
      'abc123',
      {
        canon,
        narration: line.text,
      },
    )
    expect(missingMouth.warnings.join(' ')).toMatch(/natural mouth or jaws/i)
  })

  it('warns when the full direction is repeated', () => {
    const record = JSON.parse(validResponse()).scene
    const warnings = validateSceneDirection(
      {
        version: 1,
        lineId: line.id,
        sourceFingerprint: 'abc123',
        direction: record.direction,
      },
      {
        canon,
        narration: line.text,
        acceptedLedger: [
          {
            lineId: 'line-0',
            lineIndex: 0,
            direction: record.direction as string,
          },
        ],
      },
    )
    expect(warnings.join(' ')).toMatch(/exactly repeats/i)
  })

  it('warns when the direction omits or exceeds the three-character cap', () => {
    const missing = validateSceneDirection(
      {
        version: 1,
        lineId: line.id,
        sourceFingerprint: 'abc123',
        direction:
          'A golden retriever with warm gold fur sits beside a closed red front door in a bright apartment entryway.',
      },
      { canon, narration: line.text },
    )
    expect(missing.join(' ')).toMatch(/exact character count/i)

    const over = validateSceneDirection(
      {
        version: 1,
        lineId: line.id,
        sourceFingerprint: 'abc123',
        direction:
          'Exactly four characters: a golden retriever, an owner, a neighbor, and a mail carrier stand in a bright apartment entryway beside a closed red front door.',
        visibleCharacters: ['retriever', 'owner', 'neighbor', 'mail carrier'],
      },
      { canon, narration: line.text },
    )
    expect(over.join(' ')).toMatch(/more than three characters/i)

    const ok = validateSceneDirection(
      {
        version: 1,
        lineId: line.id,
        sourceFingerprint: 'abc123',
        direction:
          'Exactly two characters: a golden retriever with warm gold fur and an owner with short brown hair sit beside a closed red front door in a bright apartment entryway.',
        visibleCharacters: ['golden retriever', 'owner'],
      },
      { canon, narration: line.text },
    )
    expect(ok.join(' ')).not.toMatch(/exact character count|more than three characters/i)
  })
})
