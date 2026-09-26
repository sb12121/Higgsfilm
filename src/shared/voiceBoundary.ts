/** Find the outside edges of sustained speech in decoded mono PCM. */
export function detectVoiceBoundary(samples: Int16Array, sampleRate: number): {
  speechStart: number
  speechEnd: number
  confident: boolean
} {
  const duration = samples.length / sampleRate
  const frameSize = Math.max(1, Math.round(sampleRate * 0.01))
  const energies: number[] = []
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    let sum = 0
    const end = Math.min(samples.length, offset + frameSize)
    for (let i = offset; i < end; i++) {
      const value = samples[i]! / 32768
      sum += value * value
    }
    energies.push(Math.sqrt(sum / (end - offset)))
  }
  if (energies.length < 12) return { speechStart: 0, speechEnd: duration, confident: false }

  // A lower quantile remains representative of stationary room noise even when
  // the recording starts or ends on a word.
  const sorted = [...energies].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const activeThreshold = Math.max(0.001, floor * 2.5)
  const softThreshold = Math.max(0.0004, floor * 1.35)
  const active = energies.map((energy) => energy >= activeThreshold)
  const sustained: number[] = []
  for (let i = 0; i <= active.length - 5; i++) {
    let count = 0
    for (let j = i; j < i + 5; j++) if (active[j]) count++
    if (count >= 4) sustained.push(i)
  }
  if (sustained.length === 0) return { speechStart: 0, speechEnd: duration, confident: false }

  let first = sustained[0]!
  let last = sustained[sustained.length - 1]! + 5
  // Refine through low-energy phonemes. A bounded guard protects gradual
  // starts/ends if their energy blends into the noise floor.
  while (first > 0 && energies[first - 1]! >= softThreshold) first--
  while (last < energies.length && energies[last]! >= softThreshold) last++
  const speechStart = Math.max(0, first * frameSize / sampleRate - 0.01)
  const speechEnd = Math.min(duration, last * frameSize / sampleRate + 0.01)
  return { speechStart, speechEnd, confident: true }
}
