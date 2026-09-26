export const EXPRESSION_IMAGE_GUIDE_FILE = 'Tools - Regenerate Expressions.txt'

export const EXPRESSION_FRAME_COUNT = 3

const FRAME_BEATS = [
  'Alternative 01 of 3. Show one complete, independently readable reaction. Full body, both feet visible, standing unless the expression name itself is a gesture.',
  'Alternative 02 of 3. Show a different standalone pose for the same expression. Keep the same size and center. This is not the middle of a motion.',
  'Alternative 03 of 3. Show another standalone pose for the same expression. Keep the same size and center. Do not depend on the other alternatives to communicate the reaction.',
]

export function expressionFrameFileName(frame: number): string {
  return `${String(frame).padStart(2, '0')}.png`
}

export function composeExpressionImagePrompt(guide: string, expression: string, frame: number): string {
  const name = expression.trim()
  if (!name) throw new Error('Choose an expression to generate.')
  const beat = FRAME_BEATS[frame - 1]
  if (!beat) throw new Error('Expression frames are 01, 02, and 03.')
  const request = `${name}. ${beat}`
  const lock = [
    'BACKGROUND LOCK: the attached background image is the only background for every expression and every frame.',
    'Use that plate edge to edge and unchanged. Do not invent a new paper sheet.',
    'Exactly one full-body Bux. Nothing else in the frame. No text, numbers, props, or scenery.',
    'Keep Bux the same size and dead center in all three frames. Only the pose changes.',
    'The editor chooses ONE alternative per spoken reaction line. These images are not an animation sequence.',
    'Do not reproduce the character sheet, a grid, a lineup, or a turnaround.',
  ].join('\n')
  const body = guide.includes('[EXPRESSION / POSE]')
    ? guide.replaceAll('[EXPRESSION / POSE]', request)
    : [guide.trim(), '', 'CURRENT REQUEST:', request].join('\n')
  return `${lock}\n\n${body}`
}
