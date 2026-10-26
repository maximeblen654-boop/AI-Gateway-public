import { defineComponent, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaGroupBrowser from '../MediaGroupBrowser.vue'
import * as groupsAPI from '@/api/admin/groups'
import * as accountsAPI from '@/api/admin/accounts'
import type { AdminGroup, AccountListItem } from '@/types'
import type { SupplierDetail } from '@/api/admin/mediaWorkbench'

vi.mock('@/api/admin/groups', () => ({ list: vi.fn() }))
vi.mock('@/api/admin/accounts', () => ({ list: vi.fn() }))
const groupAPI = vi.mocked(groupsAPI.list)
const accountAPI = vi.mocked(accountsAPI.list)
const group = (id = 31, count: number | undefined = 2) => ({ id, name: `创作分组 ${id}`, status: 'active', account_count: count }) as AdminGroup
const member = (id: number, ids = [31]) => ({ id, name: `账号名称 ${id}`, platform: 'openai', status: 'active', schedulable: true, group_ids: ids }) as AccountListItem
const result = <T>(items: T[], total = items.length, page = 1) => ({ items, total, page, page_size: 50, pages: Math.ceil(total / 50) })
let wrapper: VueWrapper
async function start(expanded: string[] = []) {
  wrapper = mount(defineComponent({
    components: { MediaGroupBrowser },
    setup: () => ({ expanded: ref(expanded), search: ref(''), suppliers: [{ id: 77 }] as SupplierDetail[] }),
    template: '<MediaGroupBrowser v-model:expanded-keys="expanded" v-model:search="search" :suppliers="suppliers" :disabled="false" />'
  }), { global: { stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' } } } })
  await flushPromises()
}
async function expand(key = '31') { await wrapper.get(`[data-test="site-group-${key}"] summary`).trigger('click'); await flushPromises() }
beforeEach(() => { vi.resetAllMocks(); groupAPI.mockResolvedValue(result([group(), group(32, 0)])); accountAPI.mockResolvedValue(result([member(77), member(44)])) })
afterEach(() => wrapper?.unmount())

describe('native site group membership browser', () => {
  it.each([
    { total: 2, failSecond: false, pages: [1, 2], members: 2 },
    { total: 1, failSecond: false, pages: [1], members: 1 },
    { total: 2, failSecond: true, pages: [1, 2], members: 1 }
  ])('restores remembered pages with current total=$total and read failure=$failSecond', async ({ total, failSecond, pages, members }) => {
    accountAPI.mockResolvedValueOnce(result([member(77)], total))
    if (total > 1) {
      if (failSecond) accountAPI.mockRejectedValueOnce(new Error('offline'))
      else accountAPI.mockResolvedValueOnce(result([member(44)], total, 2))
    }
    wrapper = mount(MediaGroupBrowser, {
      props: { suppliers: [{ id: 77 }] as SupplierDetail[], disabled: false, expandedKeys: ['31'], search: '', memberPages: { '31': 2 } },
      global: { stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    expect(accountAPI.mock.calls.map(call => call[0])).toEqual(pages)
    expect(wrapper.findAll('[data-test^="group-member-"]')).toHaveLength(members)
    expect(wrapper.find('[data-test="members-error"]').exists()).toBe(failSecond)
    expect(wrapper.emitted('ready')).toHaveLength(1)
  })

  it('shows group identities and empty groups; reads memberships only on expansion', async () => {
    await start()
    expect(wrapper.text()).toContain('分组 #31')
    expect(wrapper.text()).toContain('分组 #32')
    expect(wrapper.text()).toContain('未加入本站分组的账号')
    expect(accountAPI).not.toHaveBeenCalled()
    await expand()
    expect(accountAPI).toHaveBeenCalledWith(1, 50, { group: '31', lite: 'true', include_scheduler_score: 'false', sort_by: 'id', sort_order: 'asc' }, { signal: expect.any(AbortSignal) })
    expect(wrapper.text()).toContain('账号 #77')
    expect(wrapper.text()).toContain('账号名称 44')
    expect(wrapper.find('[data-test="group-open-account-77"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="group-open-account-44"]').exists()).toBe(false)
    await expand(); await expand()
    expect(accountAPI).toHaveBeenCalledTimes(1)
  })
  it('opens media via the existing account event without a write', async () => {
    await start(); await expand()
    await wrapper.get('[data-test="group-open-account-77"]').trigger('click')
    expect(wrapper.getComponent(MediaGroupBrowser).emitted('open-account')).toEqual([[77, '31']])
  })
  it('matches numeric group IDs exactly and preserves the query on no result', async () => {
    await start()
    await wrapper.get('[data-test="group-search"]').setValue('#31')
    expect(wrapper.find('[data-test="site-group-31"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="site-group-32"]').exists()).toBe(false)
    await wrapper.get('[data-test="group-search"]').setValue('3')
    expect(wrapper.find('[data-test="site-group-31"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="group-search"]').element).toHaveProperty('value', '3')
    expect(wrapper.get('[data-test="no-matching-groups"]').text()).toContain('清空搜索')
  })
  it('never invents zero when the group count is absent', async () => {
    groupAPI.mockResolvedValue(result([{ ...group(), account_count: undefined }]))
    await start()
    expect(wrapper.get('[data-test="site-group-31"] summary').text()).toContain('展开查看成员')
    await expand()
    expect(wrapper.get('[data-test="site-group-31"] summary').text()).toContain('2 个账号')
  })
  it('keeps a failed member read distinct from an empty group and retries in place', async () => {
    accountAPI.mockRejectedValueOnce(new Error('forbidden')).mockResolvedValueOnce(result([]))
    await start(); await expand()
    expect(wrapper.find('[data-test="empty-members"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="members-error"]').text()).toContain('暂时无法确认完整名单')
    await wrapper.get('[data-test="members-error"] button').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="empty-members"]').text()).toContain('尚未关联账号')
  })
  it('rejects a response whose Accounts do not belong to the requested group', async () => {
    accountAPI.mockResolvedValue(result([member(77, [999])]))
    await start(); await expand()
    expect(wrapper.find('[data-test="group-member-77"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="members-error"]').exists()).toBe(true)
  })
  it('uses the native ungrouped filter and refuses a grouped Account in that result', async () => {
    accountAPI.mockResolvedValueOnce(result([member(88, [])])).mockResolvedValueOnce(result([member(77)]))
    await start(); await expand('ungrouped')
    expect(accountAPI.mock.calls[0]![2]?.group).toBe('ungrouped')
    expect(wrapper.find('[data-test="group-member-88"]').exists()).toBe(true)
    await wrapper.get('[data-test="refresh-site-groups"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="group-member-77"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="members-error"]').exists()).toBe(true)
  })
  it('retains page one after a page two failure and retries the same page once', async () => {
    accountAPI.mockResolvedValueOnce(result([member(77)], 2)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result([member(44)], 2, 2))
    await start(); await expand()
    await wrapper.get('[data-test="more-members"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="group-member-77"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已显示 1 / 2')
    await wrapper.get('[data-test="members-error"] button').trigger('click'); await flushPromises()
    expect(accountAPI.mock.calls.map(call => call[0])).toEqual([1, 2, 2])
    expect(wrapper.findAll('[data-test^="group-member-"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="more-members"]').exists()).toBe(false)
  })
  it('does not accept an incomplete or duplicate page as a complete membership list', async () => {
    accountAPI.mockResolvedValueOnce(result([member(77)], 2)).mockResolvedValueOnce(result([member(77)], 2, 2))
    await start(); await expand()
    await wrapper.get('[data-test="more-members"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="members-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="group-member-77"]')).toHaveLength(1)
  })
  it('reads every native group page instead of silently truncating the group list', async () => {
    groupAPI.mockResolvedValueOnce(result([group()], 2)).mockResolvedValueOnce(result([group(32, 0)], 2, 2))
    await start()
    expect(groupAPI.mock.calls.map(call => call[0])).toEqual([1, 2])
    expect(wrapper.find('[data-test="site-group-32"]').exists()).toBe(true)
  })
  it('keeps last read groups when a refresh fails and labels them as previous results', async () => {
    await start(); await expand()
    groupAPI.mockRejectedValueOnce(new Error('offline'))
    await wrapper.get('[data-test="refresh-site-groups"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="groups-error"]').text()).toContain('上次读取结果')
    expect(wrapper.find('[data-test="group-member-77"]').exists()).toBe(true)
  })
  it('restores expanded groups and aborts pending reads on unmount', async () => {
    accountAPI.mockImplementation(() => new Promise(() => undefined))
    await start(['31'])
    const signal = accountAPI.mock.calls[0]![3]!.signal!
    expect(wrapper.get('[data-test="site-group-31"]').attributes('open')).toBeDefined()
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })
})
