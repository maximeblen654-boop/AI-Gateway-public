function normalizeGatewayBaseUrl(baseUrl: string): string {
  const fallback = typeof window !== 'undefined' ? window.location.origin : ''
  const value = (baseUrl || fallback).trim().replace(/\/+$/, '')
  return /\/v1$/i.test(value) ? value : `${value}/v1`
}

export function buildGatewayModelsUrl(baseUrl: string): string {
  return `${normalizeGatewayBaseUrl(baseUrl)}/models`
}

export async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string[]> {
  const response = await fetch(buildGatewayModelsUrl(baseUrl), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    cache: 'no-store',
    signal
  })

  if (!response.ok) {
    throw new Error(`Models request failed with status ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error('Models response is not a valid list')
  }

  return [...new Set(
    (payload as { data: unknown[] }).data
      .map((item) => typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : null)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  )]
}
