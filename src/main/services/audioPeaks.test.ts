import { describe, expect, it } from 'vitest'
import { bucketPeaks } from './audioPeaks'

describe('audioPeaks', () => {
  it('normalizes bucket peaks to the loudest sample', () => {
    const samples = new Float32Array([0, 0.25, -0.5, 0.1, 0, 0])
    expect(bucketPeaks(samples, 3)).toEqual([0.5, 1, 0])
  })
})
