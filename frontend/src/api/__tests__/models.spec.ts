import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGatewayModelsUrl, fetchGatewayModels } from '@/api/models'

describe('gateway models API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the standard models endpoint and sends the key only in Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'allowed-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchGatewayModels('https://gateway.example/v1', 'sk-test-key')).resolves.toEqual(['allowed-model'])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test-key' }) })
    )
    expect(fetchMock.mock.calls[0][0]).not.toContain('sk-test-key')
  })

  it('normalizes a root gateway URL and rejects invalid responses', async () => {
    expect(buildGatewayModelsUrl('https://gateway.example/')).toBe('https://gateway.example/v1/models')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }))

    await expect(fetchGatewayModels('https://gateway.example', 'sk-test-key')).rejects.toThrow('valid list')
  })
})
