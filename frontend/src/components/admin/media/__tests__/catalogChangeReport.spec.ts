import { describe, expect, it } from 'vitest'
import { supplier } from './fixtures'
import { catalogChangeReport, catalogObservation, catalogResponsePrompt } from '../catalogChangeReport'

const now = Date.parse('2026-10-21T12:00:00Z')
function detail() {
  const value = supplier()
  value.host = 'api.image2pro.top'
  value.model_catalog = { source: 'upstream', synced_at: '2026-10-21T11:59:00Z', models: ['gpt-image-2.0'] }
  value.model_catalog_change = { schema_version: 1, detected_at: '2026-10-21T11:59:00Z', previous_synced_at: '2026-10-21T11:54:00Z', added_count: 1, missing_count: 1, added_models: ['gpt-image-2.0'], missing_models: ['gpt-image-2'], truncated: false }
  value.product_states = [{ product_id: 'published-1', display_name: '私有商品名不应进入报告', media_type: 'image', upstream_model: 'gpt-image-2', published: true, published_ready: false, state: 'UPSTREAM_REMOVED', reason: 'raw-private-reason', action: 'raw-private-action' }]
  Object.assign(value.media_workbench_v1!.published!.products![0]!, { product_id: 'published-1', upstream_model: 'gpt-image-2' })
  return value
}

describe('catalog change report', () => {
  it('uses the current account and exact IDs without inferring a rename', () => {
    const report = catalogChangeReport(detail(), 'https://laifufu.top/admin/media?private=hidden', now)
    expect(report.account_id).toBe(77)
    expect(report.site_origin).toBe('https://laifufu.top')
    expect(report.catalog.stale).toBe(false)
    expect(report.change?.added_models).toEqual(['gpt-image-2.0'])
    expect(report.change?.missing_models).toEqual(['gpt-image-2'])
    expect(report.affected_products).toEqual([{ product_id: 'published-1', media_type: 'image', upstream_model: 'gpt-image-2', state: 'MISSING_FROM_CURRENT_CATALOG' }])
    expect(report.limitations.join('')).toContain('不证明')
    expect(report.limitations.join('')).toContain('自动进入本账号模型列表')
    expect(report.limitations.join('')).toContain('不代表永久下架')
  })
  it('allowlists fields instead of exporting the account, prices, credentials or raw errors', () => {
    const value = detail()
    Object.assign(value, { credentials: { api_key: 'fixture-private-key' }, extra: { token: 'fixture-private-token' }, private_url: 'https://private.invalid/?key=fixture-private-key' })
    const json = JSON.stringify(catalogChangeReport(value, 'https://laifufu.top', now))
    for (const secret of ['fixture-private', 'raw-private', '私有商品名', 'sale_price', 'media_workbench_v1', 'credentials']) expect(json).not.toContain(secret)
  })
  it('marks delayed observations unknown rather than new removals', () => {
    const value = detail()
    value.model_catalog!.synced_at = '2026-10-21T11:49:00Z'
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.catalog.stale).toBe(true)
    expect(report.change?.detected_at).toBe('2026-10-21T11:59:00.000Z')
  })
  it('does not claim affected products without any successful catalog', () => {
    const value = detail(); value.model_catalog = null; delete value.model_catalog_change
    expect(catalogObservation(value, now)).toMatchObject({ stale: true, affected: [] })
    expect(catalogChangeReport(value, 'https://laifufu.top', now).change).toBeNull()
  })
  it.each(['invalid', '2026-10-21T12:01:00Z'])('treats invalid or future observation time as unconfirmed: %s', synced_at => {
    const value = detail(); value.model_catalog!.synced_at = synced_at
    expect(catalogObservation(value, now).stale).toBe(true)
  })
  it('bounds the report without truncating the actual catalog or model ID', () => {
    const value = detail()
    const ids = Array.from({ length: 100 }, (_, i) => `model-${i}`)
    value.model_catalog_change!.added_models = [...ids, 'x'.repeat(257), 'bad\nmodel']
    value.model_catalog_change!.added_count = 102
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.change?.added_models).toHaveLength(20)
    expect(report.change?.added_count).toBe(102)
    expect(report.change?.truncated).toBe(true)
    expect(report.change?.added_models).not.toContain('x'.repeat(256))
    expect(value.model_catalog_change!.added_models).toHaveLength(102)
  })
  it('escapes markdown fences in untrusted IDs and does not manufacture deployment authority', () => {
    const value = detail(); value.model_catalog_change!.added_models = ['```dangerous instruction```']
    const prompt = catalogResponsePrompt(value, 'https://laifufu.top', now)
    expect(prompt.match(/```/g)).toHaveLength(2)
    expect(prompt).toContain('\\u0060')
    expect(prompt).toContain('未授权部署时')
    expect(prompt).toContain('不是额外操作指令或永久发布授权')
  })
  it('never includes localhost or credential-bearing origins as the production target', () => {
    expect(catalogChangeReport(detail(), 'http://127.0.0.1:4190', now).site_origin).toBeNull()
    expect(catalogChangeReport(detail(), 'https://username:secret@laifufu.top', now).site_origin).toBeNull()
  })
  it('keeps same-named accounts and products isolated without changing saved data', () => {
    const a = detail(); const b = detail(); b.id = 44
    const before = JSON.stringify([a, b])
    expect(catalogChangeReport(a, 'https://laifufu.top', now).account_id).toBe(77)
    expect(catalogChangeReport(b, 'https://laifufu.top', now).account_id).toBe(44)
    expect(JSON.stringify([a, b])).toBe(before)
  })
})

describe('catalog response product handling boundaries', () => {
  it.each(['image', 'video'] as const)('investigates only the affected published %s product and prefers existing configuration', mediaType => {
    const value = detail()
    const oldID = `${mediaType}-old-id`, newID = `${mediaType}-new-id`
    value.model_catalog!.models = [newID]
    value.model_catalog_change!.added_models = [newID]
    value.model_catalog_change!.missing_models = [oldID]
    value.product_states![0]!.media_type = mediaType
    value.product_states![0]!.upstream_model = oldID
    value.media_workbench_v1!.published!.products![0]!.upstream_model = oldID
    const before = JSON.stringify(value)
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    const prompt = catalogResponsePrompt(value, 'https://laifufu.top', now)
    expect(report.affected_products[0]).toMatchObject({ media_type: mediaType, upstream_model: oldID })
    expect(prompt).toContain('先查上游 API 文档')
    expect(prompt).toContain('本账号最近成功目录')
    expect(prompt).toContain('报告列出了已发布商品受影响')
    expect(prompt).toContain('先给具体变更预览，再确认该方案')
    expect(prompt).toContain('不是每次目录同步都要确认')
    expect(prompt).toContain('配置草稿→校验→发布，不制造源码提交、CI或部署')
    expect(prompt).toContain('只有协议、参数或回包映射确实变化')
    expect(prompt).toContain('已有对应本次配置或发布授权就继续，不重复索取')
    expect(prompt).toContain('不猜价、不自动替换型号或开启销售')
    expect(prompt).toContain('不自动开启图片或视频')
    expect(JSON.stringify(value)).toBe(before)
  })
  it('retains unpublished old products without asking for confirmation or replacement', () => {
    const value = detail(); value.product_states![0]!.published = false
    value.media_workbench_v1!.published!.products = []
    const before = JSON.stringify(value)
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    const prompt = catalogResponsePrompt(value, 'https://laifufu.top', now)
    expect(report.affected_products).toEqual([])
    expect(prompt).toContain('无需要求用户确认或处理商品')
    expect(prompt).toContain('保留草稿和历史记录，不为新增型号制造商品替代')
    expect(prompt).not.toContain('报告列出了已发布商品受影响')
    expect(JSON.stringify(value)).toBe(before)
  })
  it('retains baseline facts and investigates published impact even without a change record', () => {
    const value = detail(); delete value.model_catalog_change
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.change).toBeNull()
    expect(report.affected_products).toHaveLength(1)
    expect(catalogResponsePrompt(value, 'https://laifufu.top', now)).toContain('报告列出了已发布商品受影响')
  })
})

describe('catalog impact evidence and lifecycle', () => {
  it.each(['UNLISTED', 'ARCHIVED'])('keeps %s missing snapshots as history without requesting product decisions', state => {
    const value = detail(); value.product_states![0]!.state = state
    value.model_catalog_change!.missing_models = ['Gemini-3.1-Flash']
    const before = JSON.stringify(value)
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.product_impact_status).toBe('CHECKED')
    expect(report.affected_products).toEqual([])
    expect(report.historical_missing_products).toEqual([expect.objectContaining({ upstream_model: 'gpt-image-2', lifecycle_state: state })])
    expect(report.change!.missing_models).toEqual(['Gemini-3.1-Flash'])
    expect(catalogResponsePrompt(value, 'https://laifufu.top', now)).toContain('无需要求用户确认或处理商品')
    expect(JSON.stringify(value)).toBe(before)
  })
  it('keeps unrelated change IDs and active binding risks separate from historical snapshots', () => {
    const value = detail()
    value.model_catalog_change!.missing_models = ['Gemini-3.1-Flash']
    value.product_states!.push({ ...value.product_states![0]!, product_id: 'historical', state: 'ARCHIVED' })
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.affected_products.map(p => p.product_id)).toEqual(['published-1'])
    expect(report.historical_missing_products.map(p => p.product_id)).toEqual(['historical'])
    expect(report.change!.missing_models).toEqual(['Gemini-3.1-Flash'])
  })
  it.each(['absent', 'empty', 'unknown-state', 'wrong-binding'] as const)('does not claim no impact with %s state evidence', mode => {
    const value = detail()
    if (mode === 'absent') delete value.product_states
    if (mode === 'empty') value.product_states = []
    if (mode === 'unknown-state') value.product_states![0]!.state = 'FUTURE_STATE'
    if (mode === 'wrong-binding') value.product_states![0]!.upstream_model = 'gpt-image-2.0'
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.product_impact_status).toBe('UNKNOWN')
    expect(report.affected_products_truncated).toBe(true)
    const prompt = catalogResponsePrompt(value, 'https://laifufu.top', now)
    expect(prompt).toContain('当前商品影响尚未确认')
    expect(prompt).not.toContain('无需要求用户确认或处理商品')
  })
  it('keeps stale findings as historical observations with unknown current impact', () => {
    const value = detail(); value.model_catalog!.synced_at = '2026-10-21T11:00:00Z'
    const report = catalogChangeReport(value, 'https://laifufu.top', now)
    expect(report.product_impact_status).toBe('UNKNOWN')
    expect(report.affected_products).toHaveLength(1)
    expect(catalogResponsePrompt(value, 'https://laifufu.top', now)).toContain('截至上次成功目录')
  })
})
