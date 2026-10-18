import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaTokensField from '../MediaTokensField.vue'
const field = (modelValue = [5,10,15]) => mount(MediaTokensField, { props: { label: '时长', modelValue, numeric: true, durationRange: true, presets: ['5','10','15'] } })
async function range(w: ReturnType<typeof field>, start: number, end: number, step = 1) {
  await w.get('[data-test="duration-start"]').setValue(start)
  await w.get('[data-test="duration-end"]').setValue(end)
  await w.get('[data-test="duration-step"]').setValue(step)
  await w.get('[data-test="duration-add"]').trigger('click')
}
describe('duration range', () => {
  it('retains history on entry, merges 4..30, and removes individual seconds', async () => {
    const w = field()
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await range(w,4,30)
    const expected = Array.from({length:27},(_,i)=>i+4)
    expect(w.emitted('update:modelValue')![0]![0]).toEqual(expected)
    await w.setProps({modelValue:expected})
    await w.get('[aria-label="移除时长 17 秒"]').trigger('click')
    expect(w.emitted('update:modelValue')![1]![0]).toEqual(expected.filter(v=>v!==17))
    expect(w.text()).toContain('不代表模型支持整个区间')
  })
  it('supports interval and comma input in one value', async () => {
    const w=field([7]); await range(w,4,10,3)
    expect(w.emitted('update:modelValue')![0]![0]).toEqual([4,7,10])
    await w.get('[data-test="tokens-input"]').setValue('4,7,7,30')
    expect(w.emitted('update:modelValue')![1]![0]).toEqual([4,7,30])
  })
  it.each([[30,4,1],[4,30,0],[4,30,1.5],[1,33,1],[1,3601,1]])('rejects invalid range %s %s %s', async (a,b,c)=>{
    const w=field();await range(w,a,b,c)
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(w.get('[role="alert"]').text()).toBeTruthy()
  })
  it('limits merged values and rejects fractional input',async()=>{
    const w=field([100,101,102,103,104,105]);await range(w,4,30)
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await w.get('[data-test="tokens-input"]').setValue('4,1.5')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
  it('is opt-in and disabled with its field',async()=>{
    const ordinary=mount(MediaTokensField,{props:{label:'数量',modelValue:[1],numeric:true}})
    expect(ordinary.find('[data-test="duration-range"]').exists()).toBe(false)
    const w=field();await w.setProps({disabled:true})
    expect(w.get('[data-test="duration-add"]').attributes('disabled')).toBeDefined()
  })
})
