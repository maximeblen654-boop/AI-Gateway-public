<template>
  <div class="mw-group-browser" :aria-busy="groupsLoading" data-test="site-group-browser">
    <section v-if="management" ref="managementPanel" class="mw-native-management" data-test="native-group-management">
      <button type="button" class="btn btn-secondary" :disabled="nativeManager?.busy" data-test="back-to-group-members" @click="closeManagement">← 返回分组与成员</button>
      <h3>管理本站分组</h3>
      <p class="mw-muted">创建、编辑、复制、排序和删除均使用原生分组管理，设置会作用于同一批本站分组及其 API 使用权限。</p>
      <Suspense><NativeGroups ref="nativeManager" embedded :initial-action="management.action" :initial-group-id="management.id" :initial-group-name="management.name" /><template #fallback><p role="status">正在打开分组管理…</p></template></Suspense>
    </section>
    <div v-show="!management">
    <div class="mw-group-toolbar">
      <label class="mw-field">查找本站分组<input :value="search" class="input" type="search" placeholder="分组名称或编号，如 #31" data-test="group-search" @input="emit('update:search', ($event.target as HTMLInputElement).value)" /></label>
      <button type="button" class="btn btn-secondary" data-test="create-site-group" :disabled="disabled || groupsLoading" @click="openManagement('create')">创建分组</button>
      <button type="button" class="btn btn-secondary" data-test="manage-site-groups" :disabled="disabled || groupsLoading" @click="openManagement('list')">管理本站分组</button>
      <button type="button" class="btn btn-secondary" :disabled="groupsLoading" data-test="refresh-site-groups" @click="loadGroups">{{ groupsLoading ? '正在读取…' : '刷新分组与成员' }}</button>
    </div>
    <p class="mw-muted mw-group-note">这里展示分组管理中的真实账号关联。加入分组不代表账号已开启媒体销售。</p>
    <p v-if="groupsError" class="mw-banner" role="alert" data-test="groups-error">{{ groupsError }} <button type="button" class="mw-link" :disabled="groupsLoading" @click="loadGroups">重试读取</button></p>
    <p v-if="groupsLoading" role="status">{{ groups.length ? '正在更新分组，当前仍显示上次读取结果…' : '正在读取本站分组…' }}</p>
    <p v-else-if="!groups.length && !groupsError" class="mw-muted">尚未创建本站分组。可在<router-link class="mw-link" to="/admin/groups">分组管理</router-link>中创建。</p>
    <p v-else-if="!visibleGroups.length && search.trim()" class="mw-muted" data-test="no-matching-groups">没有匹配的本站分组。<button type="button" class="mw-link" @click="emit('update:search', '')">清空搜索</button></p>
    <div class="mw-group-list">
      <details v-for="group in visibleGroups" :key="group.key" :open="expandedKeys.includes(group.key)" class="mw-site-group" :data-test="`site-group-${group.key}`">
        <summary @click.prevent="toggle(group.key)">
          <span class="mw-group-identity"><strong>{{ group.name }}</strong><span v-if="group.key !== 'ungrouped'" class="mw-group-id">分组 #{{ group.id }}</span></span>
          <span class="mw-group-summary"><span v-if="group.status === 'inactive'" class="mw-badge">分组已停用</span><span>{{ memberCount(group.key, group.account_count) }}</span></span>
        </summary>
        <div class="mw-group-content">
          <div v-if="group.key !== 'ungrouped'" class="mw-member-actions mw-group-admin-actions">
            <button type="button" class="btn btn-secondary" :disabled="disabled || groupsLoading" :data-test="`edit-site-group-${group.id}`" @click="openManagement('edit', group)">编辑分组</button>
            <button type="button" class="mw-link mw-delete-group" :disabled="disabled || groupsLoading" :data-test="`delete-site-group-${group.id}`" @click="openManagement('delete', group)">删除分组</button>
          </div>
          <p v-if="group.key === 'ungrouped'" class="mw-muted">以下账号尚未关联任何本站分组。</p>
          <template v-if="members[group.key]">
            <p v-if="members[group.key]!.loading" role="status">{{ members[group.key]!.items.length ? '正在读取更多成员…' : '正在读取账号成员…' }}</p>
            <p v-if="members[group.key]!.error" role="alert" class="mw-banner" data-test="members-error">{{ members[group.key]!.error }} <button type="button" class="mw-link" @click="loadMembers(group.key, members[group.key]!.page > 0)">重试读取成员</button></p>
            <p v-if="members[group.key]!.total === 0 && !members[group.key]!.loading && !members[group.key]!.error" class="mw-muted" data-test="empty-members">{{ group.key === 'ungrouped' ? '所有账号都已加入本站分组。' : '这个分组尚未关联账号。' }}</p>
            <ul class="mw-group-members">
              <li v-for="account in members[group.key]!.items" :key="account.id" :data-test="`group-member-${account.id}`">
                <div class="mw-member-identity"><strong>{{ account.name }}</strong><span class="mw-group-id">账号 #{{ account.id }}</span></div>
                <p class="mw-muted">{{ account.platform }} · {{ accountStatus(account) }}</p>
                <div class="mw-member-actions">
                  <button v-if="supplierIDs.has(account.id)" type="button" class="btn btn-secondary" :disabled="disabled" :data-test="`group-open-account-${account.id}`" @click="emit('open-account', account.id, group.key)">查看媒体模型</button>
                  <router-link class="mw-link" :to="{ path: '/admin/accounts', query: { account_id: String(account.id) } }">账号详情 ↗</router-link>
                </div>
              </li>
            </ul>
            <div v-if="(members[group.key]!.total ?? 0) > members[group.key]!.items.length" class="mw-member-pagination"><span>已显示 {{ members[group.key]!.items.length }} / {{ members[group.key]!.total }} 个账号</span><button type="button" class="btn btn-secondary" :disabled="members[group.key]!.loading" data-test="more-members" @click="loadMembers(group.key, true)">加载更多成员</button></div>
          </template>
        </div>
      </details>
    </div>
    <button type="button" class="mw-link mw-group-management" :disabled="disabled || groupsLoading" @click="openManagement('list')">管理全部本站分组</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as groupsAPI from '@/api/admin/groups'
import * as accountsAPI from '@/api/admin/accounts'
import type { AdminGroup, AccountListItem } from '@/types'
import type { SupplierDetail } from '@/api/admin/mediaWorkbench'

const props = defineProps<{ suppliers: SupplierDetail[]; disabled: boolean; expandedKeys: string[]; search: string; memberPages?: Record<string, number> }>()
const emit = defineEmits<{ 'open-account': [id: number, groupKey: string]; ready: []; 'member-page': [key: string, page: number]; 'update:expandedKeys': [keys: string[]]; 'update:search': [value: string] }>()
type Member = Pick<AccountListItem, 'id' | 'name' | 'platform' | 'status' | 'schedulable'>
type MemberPage = { items: Member[]; total?: number; page: number; loading: boolean; error: string }
const NativeGroups = defineAsyncComponent(() => import('@/views/admin/GroupsView.vue'))
const nativeManager = ref<{ busy: boolean }>()
const managementPanel = ref<HTMLElement>()
const management = ref<{ action: 'list' | 'create' | 'edit' | 'delete'; id?: number; name?: string } | null>(null)
let managementOrigin: HTMLElement | null = null
async function openManagement(action: 'list' | 'create' | 'edit' | 'delete', group?: Pick<AdminGroup, 'id' | 'name'>) {
  if (props.disabled) return
  managementOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  management.value = { action, id: group?.id, name: group?.name }
  await nextTick()
  managementPanel.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
}
async function closeManagement() {
  if (nativeManager.value?.busy) return
  management.value = null
  await loadGroups()
  await nextTick()
  const target = managementOrigin?.isConnected ? managementOrigin : document.querySelector<HTMLElement>('[data-test="manage-site-groups"]')
  target?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  target?.focus({ preventScroll: true })
}
const groups = ref<AdminGroup[]>([])
const groupsLoading = ref(false)
const groupsError = ref('')
const members = ref<Record<string, MemberPage>>({})
const requests = new Map<string, AbortController>()
const supplierIDs = computed(() => new Set(props.suppliers.map(account => account.id)))
const visibleGroups = computed(() => {
  const query = props.search.trim().toLowerCase()
  const number = query.match(/^(?:分组\s*)?#?(\d+)$/)?.[1]
  const rows = groups.value.filter(group => !query || (number ? group.id === Number(number) : group.name.toLowerCase().includes(query))).map(group => ({ ...group, key: String(group.id) }))
  if (!query) rows.push({ id: 0, name: '未加入本站分组的账号', key: 'ungrouped', status: 'active' } as typeof rows[number])
  return rows
})
const blankPage = (): MemberPage => ({ items: [], page: 0, loading: false, error: '' })
function memberCount(key: string, count?: number) {
  const total = members.value[key]?.total ?? count
  return total === undefined ? '展开查看成员' : `${total} 个账号`
}
function toggle(key: string) {
  const open = props.expandedKeys.includes(key)
  emit('update:expandedKeys', open ? props.expandedKeys.filter(item => item !== key) : [...props.expandedKeys, key])
  if (!open && !members.value[key]) void loadMembers(key)
}
async function loadGroups() {
  if (groupsLoading.value) return
  const controller = new AbortController()
  requests.set('groups', controller)
  groupsLoading.value = true
  groupsError.value = ''
  try {
    const all: AdminGroup[] = []
    let page = 1
    while (true) {
      const result = await groupsAPI.list(page, 100, { sort_by: 'sort_order', sort_order: 'asc' }, { signal: controller.signal })
      if (controller.signal.aborted) return
      all.push(...result.items)
      if (all.length >= result.total) break
      if (!result.items.length || result.page !== page) throw new Error('Incomplete group list')
      page++
    }
    groups.value = all
    // A successful refresh invalidates cached memberships; refresh open groups
    // in place. A failed list read leaves the previous information intact.
    for (const [key, request] of requests) if (key !== 'groups') request.abort()
    const pagesToRestore = { ...props.memberPages }
    members.value = {}
    await Promise.all(props.expandedKeys.filter(key => key === 'ungrouped' || all.some(group => String(group.id) === key)).map(async key => {
      await loadMembers(key)
      while (!controller.signal.aborted && members.value[key] && !members.value[key]!.error && members.value[key]!.page < (pagesToRestore[key] ?? 1) && members.value[key]!.items.length < (members.value[key]!.total ?? 0)) await loadMembers(key, true)
    }))
    if (!controller.signal.aborted) emit('ready')
  } catch {
    if (!controller.signal.aborted) groupsError.value = groups.value.length ? '更新分组失败，当前仍显示上次读取结果。' : '读取本站分组失败，暂时无法确认分组列表。'
  } finally {
    if (requests.get('groups') === controller) { requests.delete('groups'); groupsLoading.value = false }
  }
}
async function loadMembers(key: string, append = false) {
  const previous = members.value[key] ?? blankPage()
  if (previous.loading) return
  const page = append ? previous.page + 1 : 1
  const controller = new AbortController()
  requests.set(key, controller)
  members.value[key] = { ...previous, loading: true, error: '' }
  try {
    const result = await accountsAPI.list(page, 50, { group: key, lite: 'true', include_scheduler_score: 'false', sort_by: 'id', sort_order: 'asc' }, { signal: controller.signal })
    if (controller.signal.aborted) return
    // Verify the native filter before describing any Account as a member.
    if (result.items.some(account => key === 'ungrouped' ? (account.group_ids?.length ?? 0) > 0 : !account.group_ids?.includes(Number(key)))) throw new Error('Membership mismatch')
    const items: Member[] = result.items.map(({ id, name, platform, status, schedulable }) => ({ id, name, platform, status, schedulable }))
    const combined = append ? [...previous.items, ...items] : items
    if (result.page !== page || (!items.length && combined.length < result.total) || new Set(combined.map(account => account.id)).size !== combined.length) throw new Error('Incomplete member page')
    members.value[key] = { items: combined, total: result.total, page, loading: false, error: '' }
    emit('member-page', key, page)
  } catch {
    if (!controller.signal.aborted) members.value[key] = { ...previous, loading: false, error: '读取成员失败，暂时无法确认完整名单。请重试。' }
  } finally {
    if (requests.get(key) === controller) requests.delete(key)
  }
}
function accountStatus(account: Member) {
  const status = ({ active: '账号正常', inactive: '账号已停用', error: '账号异常' } as Record<string, string>)[account.status] ?? '账号状态待核对'
  return `${status} · ${account.schedulable ? '可调度' : '已停止调度'}`
}
onMounted(() => { void loadGroups() })
onBeforeUnmount(() => { for (const request of requests.values()) request.abort() })
</script>

<style scoped>
.mw-native-management { scroll-margin-top: 6rem; }
.mw-native-management h3 { margin: 1rem 0 .5rem; }
.mw-native-management > .mw-muted { margin-bottom: 1rem; }
.mw-group-admin-actions { margin-bottom: .5rem; }
.mw-delete-group { color: #b91c1c; min-height: 44px; }
.dark .mw-delete-group { color: #fca5a5; }
.mw-group-toolbar { display: flex; align-items: end; gap: .75rem; flex-wrap: wrap; margin-bottom: .75rem; }
.mw-group-toolbar .mw-field { flex: 1; min-width: min(100%, 16rem); margin: 0; }
.mw-group-note { margin: .75rem 0 1rem; }
.mw-group-list { display: grid; gap: .65rem; }
.mw-site-group { border: 1px solid var(--mw-border); border-radius: .75rem; overflow: clip; }
.mw-site-group summary { display: flex; align-items: center; gap: .75rem; padding: 1rem; cursor: pointer; background: var(--mw-soft); list-style: none; min-height: 3.5rem; }
.mw-site-group summary::-webkit-details-marker { display: none; }
.mw-site-group summary::before { content: '›'; flex-shrink: 0; font-size: 1.25rem; transition: transform .15s ease; }
.mw-site-group[open] summary::before { transform: rotate(90deg); }
.mw-group-identity { min-width: 0; display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
.mw-group-identity strong { overflow-wrap: anywhere; }
.mw-group-id { color: var(--mw-muted); font-size: .85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mw-group-summary { margin-left: auto; display: flex; align-items: center; gap: .6rem; flex-shrink: 0; font-size: .85rem; color: var(--mw-muted); }
.mw-group-content { padding: .25rem 1rem 1rem 2.25rem; }
.mw-group-management { display: inline-flex; align-items: center; min-height: 44px; margin-top: .75rem; }
.mw-group-members { list-style: none; padding: 0; margin: 0; }
.mw-group-members li { padding: 1rem 0; border-bottom: 1px solid var(--mw-border); }
.mw-group-members li:last-child { border-bottom: 0; }
.mw-member-identity { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; overflow-wrap: anywhere; }
.mw-group-members p { font-size: .85rem; margin: .4rem 0; }
.mw-member-actions, .mw-member-pagination { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: .6rem; }
.mw-member-actions .btn { min-height: 44px; }
.mw-member-pagination { justify-content: space-between; font-size: .85rem; }
@media (max-width: 600px) {
  .mw-site-group summary { flex-wrap: wrap; padding: .85rem; gap: .5rem; }
  .mw-group-identity { flex: 1; min-width: 0; flex-basis: calc(100% - 2rem); }
  .mw-group-summary { margin-left: 1.1rem; flex-basis: 100%; }
  .mw-group-content { padding: .25rem .85rem .85rem; }
}
</style>
