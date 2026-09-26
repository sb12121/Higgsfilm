import { describe, expect, it } from 'vitest'
import {
  composeCustomImagePrompt,
  formatCursorCustomImagePrompts,
  formatMissingCustomStillsBrief,
} from './customImagePrompt'
import { customStillOutputFileName, matchCustomStillToLine, stillCastImageMatchKey } from './stillCast'

describe('composeCustomImagePrompt', () => {
  it('fills the spoken line into the guide placeholder', () => {
    const prompt = composeCustomImagePrompt(
      'Generate exactly one Custom still for this spoken line:\n\n[SPOKEN LINE]\n',
      'Bux looks at wallet.',
    )
    expect(prompt).toContain('Bux looks at wallet.')
    expect(prompt).not.toContain('[SPOKEN LINE]')
  })

  it('places the niche, topic, and script ahead of the current spoken line', () => {
    const prompt = composeCustomImagePrompt(
      'Rules.\n\nCURRENT REQUEST:\n[SPOKEN LINE]\n',
      'Knees follow the toes.',
      {
        niche: 'Personal fitness',
        topic: 'Your first squat',
        script: '1. Stand tall.\n2. Knees follow the toes. [this still]',
      },
    )
    expect(prompt.indexOf('Niche: Personal fitness')).toBeLessThan(prompt.lastIndexOf('CURRENT REQUEST:'))
    expect(prompt).toContain('Topic: Your first squat')
    expect(prompt).toContain('2. Knees follow the toes. [this still]')
    expect(prompt).toContain('Illustrate only the current spoken line.')
  })

  it('places the unspoken shot note ahead of the current request', () => {
    const prompt = composeCustomImagePrompt(
      'Rules.\n\nCURRENT REQUEST:\n[SPOKEN LINE]\n',
      'His heels lifted.',
      {},
      'Full body, both heels off the mat. Crop the feet.',
    )
    expect(prompt.indexOf('SHOT')).toBeLessThan(prompt.lastIndexOf('CURRENT REQUEST:'))
    expect(prompt).toContain('both heels off the mat')
    expect(prompt).not.toContain('|')
  })
})

describe('formatMissingCustomStillsBrief', () => {
  it('lists only the missing stills with the guide and save folder', () => {
    const brief = formatMissingCustomStillsBrief({
      folderPath: 'C:\\Project\\Custom',
      characterSheetPath: 'C:\\refs\\character sheet.png',
      referencePaths: ['C:\\refs\\face.jpg'],
      guide: 'CURRENT REQUEST:\n[SPOKEN LINE]\n',
      context: {
        niche: 'Personal fitness',
        topic: 'Your first squat',
        script: '1. Stand tall.\n2. Knees follow the toes.',
      },
      stills: [{ fileName: 'Knees follow the toes.png', spokenLine: 'Knees follow the toes.' }],
    })

    expect(brief).toContain('C:\\Project\\Custom')
    expect(brief).toContain('C:\\refs\\face.jpg')
    expect(brief).toContain('C:\\refs\\character sheet.png')
    expect(brief).toContain('[SPOKEN LINE]')
    expect(brief).toContain('Niche: Personal fitness')
    expect(brief).toContain('File: Knees follow the toes.png')
    expect(brief).toContain('16:9')
    expect(brief).toContain('Do not generate 01, 02, 03 animation frames.')
  })

  it('tells Cursor to crop a long line instead of generating a second pose', () => {
    const brief = formatMissingCustomStillsBrief({
      folderPath: 'C:\\Project\\Custom',
      guide: 'Guide.',
      stills: [
        {
          fileName: 'He held the bottom.png',
          spokenLine: 'He held the bottom.',
          durationSeconds: 4.6,
        },
      ],
    })
    expect(brief).toContain('4.6s')
    expect(brief).toContain('Do not generate that crop.')
  })
})

describe('formatCursorCustomImagePrompts', () => {
  it('points at the script, topic, and guide files instead of pasting them', () => {
    const brief = formatCursorCustomImagePrompts({
      folderPath: 'C:\\Project\\Custom',
      guidePath: 'C:\\guides\\Bux_PaperCollage_Custom_Image_Generation_Prompt.txt',
      scriptPath: 'C:\\Project\\draft-script.txt',
      topicPath: 'C:\\Project\\draft-topic.txt',
      characterSheetPath: 'C:\\refs\\character sheet.png',
      referencePaths: ['C:\\refs\\face.jpg'],
      niche: 'Personal fitness',
    })

    expect(brief).toContain('16:9')
    expect(brief).toContain('C:\\Project\\Custom')
    expect(brief).toContain('C:\\Project\\draft-script.txt')
    expect(brief).toContain('C:\\Project\\draft-topic.txt')
    expect(brief).toContain('C:\\guides\\Bux_PaperCollage_Custom_Image_Generation_Prompt.txt')
    expect(brief).toContain('C:\\refs\\face.jpg')
    expect(brief).toContain('C:\\refs\\character sheet.png')
    expect(brief).toContain('Niche: Personal fitness')
    expect(brief).not.toContain('Spoken line:')
    expect(brief).not.toContain('[SPOKEN LINE]')
  })
})

describe('customStillOutputFileName', () => {
  it('keeps the spoken-line match key after removing characters Windows cannot save', () => {
    const spoken = 'Bux: looks at the wallet?'
    const fileName = customStillOutputFileName(spoken)
    expect(fileName).toBe('Bux looks at the wallet.png')
    expect(matchCustomStillToLine(spoken, [{ matchKey: stillCastImageMatchKey(fileName) }])).toBeTruthy()
  })
})
