import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaModelBinding from '../MediaModelBinding.vue'

const props = {
  groups: [{ model_id: 'old-a', products: [{ id: 'p1', label: '商品一' }] }, { model_id: 'old-b', products: [{ id: 'p2', label: '商品二' }] }],
  available: ['new-a', 'existing-model'], addedModels: ['new-a', 'not-current'], initialModel: 'old-a', disabled: false
}
describe('missing model binding choices', () => {
  it('requires an explicit replacement and permits selection of another old model', async () => {
    const w = mount(MediaModelBinding, { props })
    expect(w.get('[data-test="binding-confirm"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-test="binding-new"]').text()).not.toContain('not-current')
    await w.get('[data-test="binding-old"]').setValue('old-b')
    await w.get('[data-test="binding-new"]').setValue('existing-model')
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toEqual([[{ action: 'rebind', old_model_id: 'old-b', new_model_id: 'existing-model', product_ids: ['p2'] }]])
    await w.get('[data-test="binding-old"]').setValue('old-a')
    expect(w.get('[data-test="binding-new"]').element).toHaveProperty('value', '')
  })
  it('deletes only with the explicit delete choice and preserves a visible history explanation', async () => {
    const w = mount(MediaModelBinding, { props })
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toBeUndefined()
    await w.get('[data-test="binding-new"]').setValue('__delete_product__')
    expect(w.text()).toContain('保留历史订单、任务与账务')
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toEqual([[{ action: 'delete', old_model_id: 'old-a', product_ids: ['p1'] }]])
  })
  it('rejects a replacement which disappeared from the refreshed available catalog', async () => {
    const w = mount(MediaModelBinding, { props })
    await w.get('[data-test="binding-new"]').setValue('new-a')
    await w.setProps({ available: ['existing-model'] })
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toBeUndefined()
  })
  it('defaults to the current product and never deletes its sibling without selecting it', async () => {
    const w = mount(MediaModelBinding, { props: { ...props, initialProduct: 'p1', groups: [{ model_id: 'old-a', products: [{ id: 'p1', label: '商品一' }, { id: 'p2', label: '商品二' }] }] } })
    await w.get('[data-test="binding-new"]').setValue('__delete_product__')
    expect(w.get('[data-test="binding-confirm"]').text()).toBe('确认删除 1 份商品')
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toEqual([[{ action: 'delete', old_model_id: 'old-a', product_ids: ['p1'] }]])
    await w.get('[data-test="binding-product-p2"]').setValue(true)
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')![1]).toEqual([{ action: 'delete', old_model_id: 'old-a', product_ids: ['p1', 'p2'] }])
  })
  it('does not interpret a real upstream model identifier as the delete command', async () => {
    const w = mount(MediaModelBinding, { props: { ...props, available: ['__delete_product__'] } })
    await w.get('[data-test="binding-new"]').setValue('__delete_product__')
    await w.get('[data-test="binding-confirm"]').trigger('click')
    expect(w.emitted('submit')).toEqual([[{ action: 'rebind', old_model_id: 'old-a', new_model_id: '__delete_product__', product_ids: ['p1'] }]])
  })
})
