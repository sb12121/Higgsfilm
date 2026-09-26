import { describe, expect, it } from 'vitest'
import {
  DOGGOBUX_SCRIPT_CLOSER,
  ensureDoggoBuxScriptCloser,
  isDoggoBuxChannel,
  scriptEndsWithDoggoBuxCloser,
} from './doggoBuxCloser'

describe('doggoBuxCloser', () => {
  it('detects DoggoBux from the channel name or script bible', () => {
    expect(isDoggoBuxChannel('DoggoBux')).toBe(true)
    expect(isDoggoBuxChannel('Finance Fox')).toBe(false)
    expect(isDoggoBuxChannel('', 'The character is always Bux. Never use DB.')).toBe(true)
    expect(isDoggoBuxChannel('', 'Always use the name Bux. Never use DB.')).toBe(true)
  })

  it('appends the fixed closer after the lesson lands', () => {
    const script = [
      'Custom: Bux opened his wallet and checked what it could buy.',
      'Raised finger: From then on, he compared buying power instead of the number alone.',
      'Realization: Bux finally understood what inflation had changed.',
    ].join('\n')
    const withCloser = ensureDoggoBuxScriptCloser(script)
    expect(withCloser.startsWith(script)).toBe(true)
    expect(withCloser.endsWith(DOGGOBUX_SCRIPT_CLOSER.join('\n'))).toBe(true)
    expect(scriptEndsWithDoggoBuxCloser(withCloser)).toBe(true)
  })

  it('does not duplicate the closer', () => {
    const withCloser = ensureDoggoBuxScriptCloser(
      'Realization: Bux finally understood what inflation had changed.',
    )
    expect(ensureDoggoBuxScriptCloser(withCloser)).toBe(withCloser)
  })

  it('replaces an LLM subscribe outro with the canonical closer', () => {
    const script = [
      'Realization: Bux finally understood what inflation had changed.',
      'Point at camera: Subscribe to DoggoBux.',
      'Warm Smile: Bux has many more terrible money decisions to explain.',
    ].join('\n')
    const withCloser = ensureDoggoBuxScriptCloser(script)
    expect(withCloser).toContain('Realization: Bux finally understood what inflation had changed.')
    expect(withCloser).not.toContain('Subscribe to DoggoBux.')
    expect(withCloser.endsWith(DOGGOBUX_SCRIPT_CLOSER.join('\n'))).toBe(true)
  })
})
