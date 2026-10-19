import { emptyCostMemory, readCostMemory, type CostMemory } from './costCalculator'

export const maxCostInputLength = 128
export const maxRememberedConsumptions = 256
const maxEnumeratedStorageKeys = 4096
export type CostMemoryField = 'purchase' | 'credits' | 'consumption'
type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
const prefixFor = (identity: string) => `${identity.replace(':v1:', ':v2:')}:`
const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= maxCostInputLength
export function costFieldKey(identity: string, field: CostMemoryField, specKey?: string): string {
  if (!['purchase', 'credits', 'consumption'].includes(field)) throw new Error('invalid_field')
  if (field === 'consumption' && (!specKey || specKey.length >= 16000)) throw new Error('invalid_spec')
  return `${prefixFor(identity)}${field}${field === 'consumption' ? `:${specKey}` : ''}`
}
function consumptionKeys(storage: MemoryStorage, identity: string): string[] {
  // Do not enumerate arbitrary browser storage without a fixed bound.
  if (storage.length > maxEnumeratedStorageKeys) throw new Error('storage_enumeration_limit')
  const prefix = `${prefixFor(identity)}consumption:`
  const result: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) result.push(key.slice(prefix.length))
  }
  return result
}
export function loadCostMemory(storage: MemoryStorage, identity: string): { memory: CostMemory; warning: string } {
  let memory = emptyCostMemory()
  const warnings: string[] = []
  try { memory = readCostMemory(storage.getItem(identity)) } catch { warnings.push('旧版浏览器试算记忆已损坏，已忽略旧值。') }
  for (const field of ['purchase', 'credits'] as const) {
    const value = storage.getItem(costFieldKey(identity, field))
    if (value === null) continue
    if (validText(value)) memory[field] = value
    else warnings.push('部分试算输入超过记忆长度限制，已保留浏览器记录供核对。')
  }
  for (const specKey of consumptionKeys(storage, identity)) {
    if (!specKey || specKey.length >= 16000) { warnings.push('部分规格试算标识无效，已保留浏览器记录供核对。'); continue }
    const value = storage.getItem(costFieldKey(identity, 'consumption', specKey))
    if (!validText(value)) { warnings.push('部分规格试算记忆不可用，已保留浏览器记录供核对。'); continue }
    if (!Object.prototype.hasOwnProperty.call(memory.consumption, specKey) && Object.keys(memory.consumption).length >= maxRememberedConsumptions) {
      warnings.push('本账号试算记忆超过 256 个规格；超出项仍保留在浏览器，请核对后再新增。'); continue
    }
    memory.consumption[specKey] = value
  }
  return { memory, warning: [...new Set(warnings)].join(' ') }
}
/** A keystroke writes only its own field. Other tabs' snapshots are never written back. */
export function writeCostMemoryField(storage: MemoryStorage, identity: string, field: CostMemoryField, value: string, specKey?: string): void {
  if (!validText(value)) throw new Error('input_too_long')
  const key = costFieldKey(identity, field, specKey)
  if (field === 'consumption' && storage.getItem(key) === null) {
    let legacy = emptyCostMemory()
    try { legacy = readCostMemory(storage.getItem(identity)) } catch { /* V2 fields remain usable when legacy memory is corrupt. */ }
    const remembered = new Set([...Object.keys(legacy.consumption), ...consumptionKeys(storage, identity)])
    if (!remembered.has(specKey!) && remembered.size >= maxRememberedConsumptions) throw new Error('consumption_limit')
  }
  storage.setItem(key, value)
}
