import type { ScriptLine } from './types'
import { isCustomStillCastExpression, normalizeStillCastExpression } from './stillCast'

const DEFAULT_VOCAL_EXPRESSION = 'neutral-talking'

const VOCAL_INSTRUCTS: Record<string, string> = {
  concerned: 'Speak this line worried and concerned, as if something is going wrong.',
  confident: 'Speak this line sure of yourself, proud, and a little smug.',
  confused: 'Speak this line puzzled and lost, as if you do not understand yet.',
  determined: 'Speak this line firmly, with resolve, like you have made a plan.',
  disappointed: 'Speak this line let down and quietly disappointed.',
  embarrassed: 'Speak this line sheepish and embarrassed, as if you just got caught.',
  empathetic: 'Speak this line gently and kindly, as if you feel for the listener.',
  encouraging: 'Speak this line warm and encouraging, cheering the listener on.',
  excited: 'Speak this line excited, bright, and a little breathless.',
  frustrated: 'Speak this line annoyed and frustrated, like the math is cheating you.',
  'hold-on': 'Speak this line as a sudden interruption: wait, stop, hold on.',
  laughing: 'Speak this line laughing, amused, and punchy.',
  'neutral-talking': 'Speak this line in a calm, even talking tone. No extra emotion.',
  'point-at-camera': 'Speak this line straight to the listener, direct and pointed.',
  'present-open-hands': 'Speak this line as Bux showing what he just figured out, open and still in character.',
  'raised-finger': 'Speak this line as Bux landing the click, like he just got it, still in his own voice.',
  realization: 'Speak this line as a click of understanding, a sudden realization.',
  shrug: 'Speak this line casually unsure, like a shrug.',
  skeptical: 'Speak this line doubtful and skeptical.',
  surprised: 'Speak this line surprised, with a short startled lift.',
  thinking: 'Speak this line slowly, thinking it through out loud.',
  unimpressed: 'Speak this line flat and unimpressed, deadpan.',
  waiting: 'Speak this line patiently, as if waiting for time to pass.',
  'warm-smile': 'Speak this line warmly, with a small smile in the voice.',
}

export function stillCastLineVocalExpression(
  line: Pick<ScriptLine, 'stillBeats'>,
): string {
  const expression = normalizeStillCastExpression(line.stillBeats?.[0]?.expression)
  if (!expression || isCustomStillCastExpression(expression)) return DEFAULT_VOCAL_EXPRESSION
  return expression
}

export function qwenVocalInstructForExpression(expression: string | undefined): string {
  const slug = stillCastLineVocalExpression({
    stillBeats: [{ id: 'tone', text: 'tone', expression: expression || DEFAULT_VOCAL_EXPRESSION }],
  })
  return VOCAL_INSTRUCTS[slug] || VOCAL_INSTRUCTS[DEFAULT_VOCAL_EXPRESSION]!
}

export function qwenVocalInstructForLine(line: Pick<ScriptLine, 'stillBeats'>): string {
  return qwenVocalInstructForExpression(stillCastLineVocalExpression(line))
}
