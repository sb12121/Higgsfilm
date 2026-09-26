import { describe, expect, it } from 'vitest'
import {
  applyStillCastBeatsToLine,
  applyStillCastScriptPrefixes,
  extractCustomStillCastLines,
  extractSpokenStillCastLines,
  lineStillCastImagesReady,
  matchCustomStillToLine,
  matchStillCastFolder,
  partitionStillCastTargets,
  parseStillCastScriptLine,
  normalizeStillCastExpression,
  pickStillImage,
  expressionPlaybackBeats,
  isStillCastImageFile,
  resolveStillCastFolder,
  spokenStillCastLinesFromScriptLines,
  stillBeatDurations,
  stillCastExpressionLabel,
  stillCastImageMatchKey,
  stillCastLineMatchKey,
} from './stillCast'
import { parseStillCastResponse } from './stillCastPrompt'
import type { ScriptLine, StillCastLibraryFolder } from './types'

function line(partial: Partial<ScriptLine> & Pick<ScriptLine, 'id' | 'text'>): ScriptLine {
  return {
    index: 0,
    paragraphIndex: 0,
    startTime: 0,
    endTime: 1,
    duration: 1,
    status: 'draft',
    scenePrompt: '',
    directionStatus: 'draft',
    sceneStatus: 'draft',
    ...partial,
  }
}

const doggoFolders: StillCastLibraryFolder[] = [
  {
    id: 'concerned',
    folderName: 'Concerned',
    imagePaths: ['/Expressions/Concerned/a.png'],
  },
  {
    id: 'confused',
    folderName: 'Confused',
    imagePaths: ['/Expressions/Confused/a.png'],
  },
  {
    id: 'neutral',
    folderName: 'Neutral',
    imagePaths: ['/Expressions/Neutral/a.png'],
  },
  {
    id: 'neutral-talking',
    folderName: 'Neutral Talking',
    imagePaths: ['/Expressions/Neutral Talking/a.png', '/Expressions/Neutral Talking/b.png'],
  },
  {
    id: 'skeptical',
    folderName: 'Skeptical',
    imagePaths: ['/Expressions/Skeptical/a.png'],
  },
  {
    id: 'warm-smile',
    folderName: 'Warm Smile',
    imagePaths: ['/Expressions/Warm Smile/a.png', '/Expressions/Warm Smile/b.png'],
  },
]

describe('stillCast', () => {
  it('keeps folder names as the catalog and maps common aliases onto them', () => {
    expect(normalizeStillCastExpression('Warm Smile')).toBe('warm-smile')
    expect(resolveStillCastFolder('Happy', doggoFolders)?.folderName).toBe('Warm Smile')
    expect(resolveStillCastFolder('concerned', doggoFolders)?.folderName).toBe('Concerned')
    expect(resolveStillCastFolder('talking', doggoFolders)?.folderName).toBe('Neutral Talking')
    expect(resolveStillCastFolder('Laugh', doggoFolders)?.folderName).toBe('Neutral Talking')
    expect(
      resolveStillCastFolder('Laugh', [
        ...doggoFolders,
        { id: 'laugh', folderName: 'Laugh', imagePaths: ['/Expressions/Laugh/a.png'] },
      ])?.folderName,
    ).toBe('Laugh')
  })

  it('splits line duration across beats by word count', () => {
    const durations = stillBeatDurations(
      [
        { id: 'a', text: 'Skinny fat is', expression: 'concerned' },
        { id: 'b', text: 'not', expression: 'confused' },
        { id: 'c', text: 'a diet problem at all', expression: 'warm-smile' },
      ],
      4,
    )
    expect(durations).toHaveLength(3)
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(4, 5)
    expect(durations[2]!).toBeGreaterThan(durations[1]!)
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(0.8)
  })

  it('picks from the matching folder and avoids the previous still when possible', () => {
    const scan = {
      libraryPath: '/Expressions',
      folders: doggoFolders,
      unmatchedFolders: [],
    }
    const first = pickStillImage('happy', scan)
    expect(first).toMatch(/Warm Smile/)
    const second = pickStillImage('Warm Smile', scan, first ? [first] : [])
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })

  it('parses one expression per line onto the live folder names', () => {
    const target = line({ id: 'line-1', text: 'Beautiful.' })
    const parsed = parseStillCastResponse(
      JSON.stringify({
        lines: [{ lineId: 'line-1', expression: 'Warm Smile' }],
      }),
      [target],
      doggoFolders,
    )
    expect(parsed[0]?.beats).toEqual([{ text: 'Beautiful.', expression: 'warm-smile' }])
    const beats = applyStillCastBeatsToLine(target, parsed[0]!.beats, doggoFolders)
    expect(beats).toHaveLength(1)
    expect(lineStillCastImagesReady({ stillBeats: beats, sceneStatus: 'draft' })).toBe(false)
    expect(
      lineStillCastImagesReady({
        stillBeats: beats.map((beat) => ({ ...beat, imagePath: 'stills/a.png' })),
        sceneStatus: 'draft',
      }),
    ).toBe(true)
  })

  it('matches Custom images to script lines by filename', () => {
    expect(stillCastLineMatchKey('One hundred dollars.')).toBe('one hundred dollars')
    expect(stillCastImageMatchKey('One hundred dollars.png')).toBe('one hundred dollars')
    expect(stillCastImageMatchKey('one-hundred-dollars.webp')).toBe('one hundred dollars')
    expect(stillCastExpressionLabel('custom', doggoFolders)).toBe('Custom still')
    expect(
      matchCustomStillToLine('Beautiful.', [
        { matchKey: 'beautiful', fileName: 'Beautiful.png' },
        { matchKey: 'one hundred dollars', fileName: 'One hundred dollars.png' },
      ])?.fileName,
    ).toBe('Beautiful.png')
    expect(
      matchCustomStillToLine('Life good.', [{ matchKey: 'beautiful', fileName: 'Beautiful.png' }]),
    ).toBeUndefined()
    expect(
      matchCustomStillToLine('DB look at wallet.', [
        { matchKey: stillCastImageMatchKey('db look at wallet.png'), fileName: 'db look at wallet.png' },
      ])?.fileName,
    ).toBe('db look at wallet.png')
    const split = partitionStillCastTargets(
      [{ text: 'DB look at wallet.' }, { text: 'Beautiful.' }],
      [{ matchKey: stillCastImageMatchKey('db look at wallet.png') }],
    )
    expect(split.custom.map((line) => line.text)).toEqual(['DB look at wallet.'])
    expect(split.remaining.map((line) => line.text)).toEqual(['Beautiful.'])
  })

  it('strips script expression prefixes and keeps spoken text', () => {
    expect(parseStillCastScriptLine('Custom: Bux look at wallet.', doggoFolders)).toEqual({
      text: 'Bux look at wallet.',
      expression: 'custom',
    })
    expect(
      parseStillCastScriptLine(
        'Custom: As he squatted, his heels lifted. | Full body, both heels off the mat. Crop the feet.',
        doggoFolders,
      ),
    ).toEqual({
      text: 'As he squatted, his heels lifted.',
      expression: 'custom',
      shotNote: 'Full body, both heels off the mat. Crop the feet.',
    })
    expect(
      extractCustomStillCastLines(
        'Custom: As he squatted, his heels lifted. | Full body, both heels off the mat.',
      ),
    ).toEqual([
      {
        spoken: 'As he squatted, his heels lifted.',
        fileName: 'As he squatted, his heels lifted.png',
        shotNote: 'Full body, both heels off the mat.',
      },
    ])
    expect(parseStillCastScriptLine('Warm Smile: Beautiful.', doggoFolders)).toEqual({
      text: 'Beautiful.',
      expression: 'warm-smile',
    })
    expect(parseStillCastScriptLine('Happy: Crisp.', doggoFolders)).toEqual({
      text: 'Crisp.',
      expression: 'warm-smile',
    })
    expect(parseStillCastScriptLine('Note: this stays spoken.', doggoFolders)).toEqual({
      text: 'Note: this stays spoken.',
    })
    expect(matchStillCastFolder('Laugh', doggoFolders)).toBeUndefined()
    expect(
      extractCustomStillCastLines(
        [
          'Custom: Bux look at wallet,',
          'Warm Smile: Beautiful.',
          '',
          'custom: One hundred dollars.',
          'Note: this stays spoken.',
          'Custom: Bux go store.',
        ].join('\n'),
      ),
    ).toEqual([
      { spoken: 'Bux look at wallet,', fileName: 'Bux look at wallet.png' },
      { spoken: 'One hundred dollars.', fileName: 'One hundred dollars.png' },
      { spoken: 'Bux go store.', fileName: 'Bux go store.png' },
    ])
    expect(
      extractSpokenStillCastLines(
        [
          'Custom: Bux look at wallet.',
          'Warm Smile: Beautiful.',
          'See the full video to learn more.',
        ].join('\n'),
      ),
    ).toEqual([
      { spoken: 'Bux look at wallet.', fileName: 'Bux look at wallet.png' },
      { spoken: 'Beautiful.', fileName: 'Beautiful.png' },
      { spoken: 'See the full video to learn more.', fileName: 'See the full video to learn more.png' },
    ])
    expect(
      spokenStillCastLinesFromScriptLines([
        { text: 'Bux look at wallet.' },
        { text: 'See the full video to learn more.' },
      ]),
    ).toEqual([
      { spoken: 'Bux look at wallet.', fileName: 'Bux look at wallet.png' },
      { spoken: 'See the full video to learn more.', fileName: 'See the full video to learn more.png' },
    ])
    expect(
      applyStillCastScriptPrefixes(
        [
          { text: 'Custom: Bux look at wallet.', paragraphIndex: 0 },
          { text: 'Warm Smile: Beautiful.', paragraphIndex: 0 },
          { text: 'Confident: Powerful.', paragraphIndex: 1 },
        ],
        [
          ...doggoFolders,
          { id: 'confident', folderName: 'Confident', imagePaths: ['/Expressions/Confident/a.png'] },
        ],
      ),
    ).toEqual([
      { text: 'Bux look at wallet.', paragraphIndex: 0, expression: 'custom' },
      { text: 'Beautiful.', paragraphIndex: 0, expression: 'warm-smile' },
      { text: 'Powerful.', paragraphIndex: 1, expression: 'confident' },
    ])
  })

  it('holds one numbered expression variant instead of playing 01, 02, and 03', () => {
    const beats = [
      { id: 'a', text: 'Wait.', expression: 'concerned', imagePath: 'stills/01.png' },
      { id: 'b', text: 'Wait.', expression: 'concerned', imagePath: 'stills/02.png' },
      { id: 'c', text: 'Wait.', expression: 'concerned', imagePath: 'stills/03.png' },
    ]
    const chosen = expressionPlaybackBeats(beats, 'line-1')
    expect(chosen).toHaveLength(1)
    expect(beats.map((beat) => beat.imagePath)).toContain(chosen[0]?.imagePath)
    expect(expressionPlaybackBeats(beats, 'line-1')).toEqual(chosen)
    expect(
      expressionPlaybackBeats(
        [
          { id: 'custom', text: 'Look.', expression: 'custom', imagePath: 'stills/wallet.png' },
          { id: 'custom-2', text: 'Look.', expression: 'custom', imagePath: 'stills/wallet-crop.png' },
        ],
        'line-2',
      ),
    ).toHaveLength(2)
  })

  it('ignores underscore support files like _bg_plate as cast stills', () => {
    expect(isStillCastImageFile('01.png')).toBe(true)
    expect(isStillCastImageFile('_bg_plate.png')).toBe(false)
    expect(isStillCastImageFile('_scale_ref.png')).toBe(false)
  })
})
