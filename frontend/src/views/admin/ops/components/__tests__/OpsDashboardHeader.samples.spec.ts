import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, enableAutoUnmount, flushPromises } from '@vue/test-utils'
import OpsDashboardHeader from '../OpsDashboardHeader.vue'
import type { OpsDashboardOverview } from '@/api/admin/ops'
vi.mock('vue-i18n', async (importOriginal) => ({ ...await importOriginal<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string, args?: unknown) => key + (args ? JSON.stringify(args) : '') }) }))
vi.mock('@/api', () => ({ adminAPI: { groups: { getAll: vi.fn().mockResolvedValue([]) } } }))
vi.mock('@/api/admin/ops', () => ({ opsAPI: {} }))
vi.mock('@/stores', () => ({ useAdminSettingsStore: () => ({ opsRealtimeMonitoringEnabled: false }) }))
enableAutoUnmount(afterEach)
describe('SLA request sample evidence', () => {
 it('does not present no traffic as a 0% failure or a recovery; shows the actual SLA denominator', async () => {
  const overview = { request_count_sla: 0, request_count_total: 9, success_count: 0, error_count_sla: 0, sla: 0, error_rate: 0, upstream_error_rate: 0 } as OpsDashboardOverview
  const w=shallowMount(OpsDashboardHeader,{props:{overview,platform:'',groupId:null,timeRange:'5m',queryMode:'raw',loading:false,lastUpdated:null}})
  await flushPromises()
  const vm=w.vm as unknown as {slaPercent:number|null;errorRatePercent:number|null;upstreamErrorRatePercent:number|null}
  expect(vm.slaPercent).toBeNull();expect(vm.errorRatePercent).toBeNull();expect(vm.upstreamErrorRatePercent).toBeNull()
  expect(w.text()).toContain('admin.ops.noRequestSamples')
  await w.setProps({overview:{...overview,request_count_sla:1,error_count_sla:1,error_rate:1,upstream_error_rate:1}})
  expect(vm.errorRatePercent).toBe(100);expect(vm.slaPercent).toBe(0)
  expect(w.get('[data-testid="ops-sla-samples"]').text()).toContain('"total":1')
  await w.setProps({overview:{...overview,request_count_sla:1000,success_count:1000,sla:1}})
  expect(vm.slaPercent).toBe(100);expect(vm.errorRatePercent).toBe(0)
 })
})
