export const CUSTOM_IMAGE_GUIDE_FILE = 'Visual Direction - Custom Images 16x9.txt'

export interface CustomImageVideoContext {
  niche?: string
  topic?: string
  script?: string
}

export function formatShotInstruction(shotNote?: string): string {
  const note = shotNote?.trim()
  if (!note) return ''
  return [
    'SHOT',
    note,
    'Draw this one picture. Do not generate a second pose. A crop of this file is the only second shot.',
  ].join('\n')
}

export function composeCustomImagePrompt(
  guide: string,
  spokenLine: string,
  context: CustomImageVideoContext = {},
  shotNote?: string,
): string {
  const spoken = spokenLine.trim()
  if (!spoken) throw new Error('The Custom line has no spoken text.')
  const body = guide.includes('[SPOKEN LINE]')
    ? guide.replaceAll('[SPOKEN LINE]', spoken)
    : [
        guide.trim(),
        '',
        'CURRENT REQUEST:',
        'Generate exactly one Custom still for this spoken line:',
        '',
        spoken,
      ].join('\n')
  const videoContext = formatCustomImageVideoContext(context)
  const shot = formatShotInstruction(shotNote)
  const insert = [videoContext, shot].filter(Boolean).join('\n\n')
  if (!insert) return body
  const marker = 'CURRENT REQUEST:'
  const at = body.lastIndexOf(marker)
  if (at === -1) return `${insert}\n\n${body}`
  return `${body.slice(0, at).trimEnd()}\n\n${insert}\n\n${body.slice(at)}`
}

export interface MissingCustomStillBrief {
  fileName: string
  spokenLine: string
  durationSeconds?: number
  shotNote?: string
}

export function formatMissingCustomStillsBrief(input: {
  folderPath: string
  characterSheetPath?: string
  referencePaths?: string[]
  guide: string
  context?: CustomImageVideoContext
  stills: MissingCustomStillBrief[]
}): string {
  const stills = input.stills.filter((still) => still.spokenLine.trim() && still.fileName.trim())
  if (stills.length === 0) throw new Error('Every Custom line already has an image.')
  const guide = input.guide.trim()
  if (!guide) throw new Error('The custom image guide is empty.')
  const references = (input.referencePaths || []).map((filePath) => filePath.trim()).filter(Boolean)
  const sheet = input.characterSheetPath?.trim() || ''
  const attachments = [
    'ATTACH THESE IMAGES',
    'Face references first, then the character sheet. Leave finished scene stills out.',
    references.length > 0
      ? ['Face references:', ...references.map((filePath) => `- ${filePath}`)].join('\n')
      : 'Face references: none.',
    sheet ? `Character sheet:\n- ${sheet}` : 'Character sheet: choose one and attach it.',
  ].join('\n')
  const requests = stills
    .map((still, index) => {
      const spoken = still.spokenLine.trim()
      const longHold =
        typeof still.durationSeconds === 'number' && still.durationSeconds >= 3.5
          ? `This line is ${still.durationSeconds.toFixed(1)}s. Generate one master only. A tighter crop of this same file is the second shot. Do not generate that crop.`
          : 'Generate one master only. Do not generate a second pose of this moment.'
      return [
        `${index + 1}. File: ${still.fileName}`,
        `Spoken line: ${spoken}`,
        still.shotNote?.trim() ? `Shot: ${still.shotNote.trim()}` : 'Shot: illustrate only the spoken line.',
        longHold,
        'In the full script above, mark only this line with [this still].',
      ].join('\n')
    })
    .join('\n\n')
  return [
    'Generate one 16:9 image for each missing still. One spoken line is one generation.',
    'Do not generate 01, 02, 03 animation frames. Those poses will not line up.',
    'A second shot, when a line runs long, is a tighter crop of the master you just made. Do not generate it.',
    'Follow each still’s Shot line for what is visible. Use the guide for style and identity.',
    'Replace [SPOKEN LINE] with that still’s spoken line.',
    'Illustrate only that spoken line. Do not depict the neighboring lines.',
    `Save each PNG with the file name below, in:\n${input.folderPath}`,
    '',
    attachments,
    '',
    'GUIDE',
    guide,
    '',
    formatCustomImageVideoContext({
      niche: input.context?.niche,
      topic: input.context?.topic,
      script: input.context?.script,
    }) || 'VIDEO CONTEXT\nNo niche, topic, or script was available.',
    '',
    'MISSING STILLS',
    requests,
  ].join('\n')
}

export function formatCursorCustomImagePrompts(input: {
  folderPath: string
  guidePath: string
  scriptPath: string
  topicPath?: string
  characterSheetPath?: string
  referencePaths?: string[]
  niche?: string
}): string {
  const guidePath = input.guidePath.trim()
  const scriptPath = input.scriptPath.trim()
  if (!guidePath) throw new Error('Choose the 16:9 custom image guide before copying stills.')
  if (!scriptPath) throw new Error('Save the script draft before copying stills.')
  const references = (input.referencePaths || []).map((filePath) => filePath.trim()).filter(Boolean)
  const sheet = input.characterSheetPath?.trim() || ''
  const topicPath = input.topicPath?.trim() || ''
  const niche = input.niche?.trim() || ''
  const files = [
    `Script: ${scriptPath}`,
    topicPath ? `Topic: ${topicPath}` : '',
    `Guide: ${guidePath}`,
    references.length > 0 ? ['Face references:', ...references.map((filePath) => `- ${filePath}`)].join('\n') : '',
    sheet ? `Character sheet: ${sheet}` : 'Character sheet: choose one and attach it.',
    `Save folder: ${input.folderPath}`,
  ]
    .filter(Boolean)
    .join('\n')
  return [
    'Generate one 16:9 image for each Custom: line in the script file.',
    'Read the files below. Do not invent a different style.',
    'Attach the face references first, then the character sheet.',
    'Words before | are spoken. Words after | are the shot. Illustrate only that spoken line.',
    'The PNG name is the spoken line. Do not include Custom: or the shot note in the file name.',
    'Do not generate 01, 02, 03 animation frames.',
    'A second shot is a tighter crop of that file. Do not generate the crop.',
    niche ? `Niche: ${niche}` : '',
    '',
    files,
  ]
    .filter((part) => part !== '')
    .join('\n')
}

export function formatCustomImageVideoContext(context: CustomImageVideoContext): string {
  const niche = context.niche?.trim() || ''
  const topic = context.topic?.trim() || ''
  const script = context.script?.trim() || ''
  if (!niche && !topic && !script) return ''
  const lines = [
    'VIDEO CONTEXT',
    'Use the niche, topic, and full script so this still belongs to the episode.',
    'Illustrate only the current spoken line. Do not depict neighboring lines in this frame.',
  ]
  if (niche) lines.push('', `Niche: ${niche}`)
  if (topic) lines.push('', `Topic: ${topic}`)
  if (script) lines.push('', 'Full script:', script)
  return lines.join('\n')
}
