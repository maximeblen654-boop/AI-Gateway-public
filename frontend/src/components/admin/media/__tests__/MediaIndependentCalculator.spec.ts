import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MediaIndependentCalculator from '../MediaIndependentCalculator.vue'
beforeEach(() => {
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => vi.restoreAllMocks())

it('calculates only a manual local trial and leaves unknown cost or absent sale uncomputed', async () => {
  const wrapper = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
  await wrapper.get('[data-test="independent-sale"]').setValue('1')
  expect(wrapper.get('[data-test="independent-result"]').text()).toBe('—')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('—')
  await wrapper.get('[data-test="independent-purchase"]').setValue('100')
  await wrapper.get('[data-test="independent-credits"]').setValue('1000')
  await wrapper.get('[data-test="independent-consumption"]').setValue('8')
  expect(wrapper.get('[data-test="independent-result"]').text()).toBe('0.8 元')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('0.2 元')
  expect(wrapper.get('[data-test="independent-margin"]').text()).toBe('20%')
  await wrapper.get('[data-test="independent-sale"]').setValue('')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('—')
  expect(wrapper.get('[data-test="independent-margin"]').text()).toBe('—')
  expect(wrapper.emitted('update:product')).toBeUndefined()
  expect(wrapper.find('button[data-test*="apply"]').exists()).toBe(false)
  wrapper.unmount()
})

it('retains the original independent memory, remembers the optional trial sale, and isolates admins', async () => {
  localStorage.setItem('ai-gateway:independent-calculator:v1:7', JSON.stringify({ purchase: '100', credits: '1000', consumption: '8' }))
  const wrapper = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
  expect(wrapper.get('[data-test="independent-result"]').text()).toBe('0.8 元')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('—')
  await wrapper.get('[data-test="independent-sale"]').setValue('0.70')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('−0.1 元')
  expect(wrapper.get('[data-test="independent-margin"]').text()).toBe('−14.28571429%')
  wrapper.unmount()
  const again = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
  expect(again.get('[data-test="independent-sale"]').element).toHaveProperty('value', '0.70')
  await again.setProps({ adminId: 8 })
  expect(again.get('[data-test="independent-purchase"]').element).toHaveProperty('value', '')
  expect(again.get('[data-test="independent-profit"]').text()).toBe('—')
  again.unmount()
})

it('keeps manual inputs usable when local storage is corrupt or unavailable', async () => {
  localStorage.setItem('ai-gateway:independent-calculator:v1:7', 'corrupt')
  const wrapper = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  for (const [field, value] of [['purchase', '1'], ['credits', '3'], ['consumption', '3'], ['sale', '1']]) await wrapper.get(`[data-test="independent-${field}"]`).setValue(value)
  expect(wrapper.text()).toContain('本机输入记忆不可用')
  expect(wrapper.get('[data-test="independent-result"]').text()).toBe('1 元')
  expect(wrapper.get('[data-test="independent-profit"]').text()).toBe('0 元')
  expect(wrapper.get('[data-test="independent-margin"]').text()).toBe('0%')
  expect(wrapper.emitted('update:product')).toBeUndefined()
  wrapper.unmount()
})
