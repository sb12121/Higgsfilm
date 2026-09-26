import type { ScriptLine } from './types'
import { isCustomStillCastExpression, normalizeStillCastExpression } from './stillCast'

export type ScriptSpeakerRegister = 'fool' | 'realization'

const REALIZATION_EXPRESSION_SLUGS = new Set([
  'raised-finger',
  'neutral-talking',
  'present-open-hands',
  'realization',
  'point-at-camera',
])

export const SCRIPT_SPEAKER_LABEL: Record<ScriptSpeakerRegister, string> = {
  fool: 'BUX THE FOOL',
  realization: 'BUX REALIZATION',
}

export const SCRIPT_SPEAKER_HINT: Record<ScriptSpeakerRegister, string> = {
  fool: 'Proud, a little fast, still Bux',
  realization: 'The click. Still Bux, a little slower',
}

export interface ScriptSpeakerCue {
  register: ScriptSpeakerRegister
  label: string
  hint: string
}

export function scriptSpeakerFromExpression(expression?: string): ScriptSpeakerRegister {
  const slug = normalizeStillCastExpression(expression)
  if (!slug) return 'fool'
  if (slug === 'custom' || slug === 'custom-still' || isCustomStillCastExpression(expression)) {
    return 'fool'
  }
  return REALIZATION_EXPRESSION_SLUGS.has(slug) ? 'realization' : 'fool'
}

export function scriptSpeakerCue(expression?: string): ScriptSpeakerCue {
  const register = scriptSpeakerFromExpression(expression)
  return {
    register,
    label: SCRIPT_SPEAKER_LABEL[register],
    hint: SCRIPT_SPEAKER_HINT[register],
  }
}

export function scriptSpeakerCuesForLines(
  lines: readonly Pick<ScriptLine, 'stillBeats'>[],
): ScriptSpeakerCue[] {
  return lines.map((line) => scriptSpeakerCue(line.stillBeats?.[0]?.expression))
}
