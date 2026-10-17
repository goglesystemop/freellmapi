import { describe, expect, it } from 'vitest'
import { buildFusionModelOptions } from './fusion-model-options'

const entries = [{ modelDbId: 1, modelId: 'openai/gpt-oss-20b', displayName: 'GPT OSS 20B', platform: 'groq', groupKey: 'gptoss20b', canonicalId: 'gpt-oss-20b' }]

describe('saved Fusion model options', () => {
  it('offers canonical choices and preserves saved full IDs for panel and judge', () => {
    const options = buildFusionModelOptions(entries, true, ['openai/gpt-oss-20b', 'openai/gpt-oss-20b'])
    expect(options.map(o => o.value)).toEqual(['gpt-oss-20b', 'openai/gpt-oss-20b'])
    expect(options[1].label).toContain('groq: openai/gpt-oss-20b')
  })
  it('does not duplicate literal choices or invent unavailable entries', () => {
    expect(buildFusionModelOptions(entries, false, ['openai/gpt-oss-20b', 'missing'])).toHaveLength(1)
  })
})
