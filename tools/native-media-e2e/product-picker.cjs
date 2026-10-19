// The picker exposes one representative per published product, not per price Offer.
const assert = require('node:assert/strict')
const { expect } = require('../../frontend/node_modules/@playwright/test')

module.exports = async function selectPublishedProduct(page, offers, target) {
  assert(offers.some(offer => offer.offer_id === target.offer_id), 'target Offer must belong to the captured catalog')
  const siblings = offers.filter(offer => target.product_scope
    ? offer.product_scope === target.product_scope && offer.product_id === target.product_id &&
      offer.model === target.model && offer.upstream_model === target.upstream_model && (offer.input_mode || '') === (target.input_mode || '')
    : offer.offer_id === target.offer_id)
  const ids = new Set(siblings.map(offer => offer.offer_id))
  const menu = page.locator('#studio-model-menu')
  await expect(menu).toBeVisible()
  await expect.poll(async () => (await menu.locator('button.picker-choice').all()).length).toBeGreaterThan(0)
  const visible = await menu.locator('button.picker-choice').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-offer-id')))
  const matches = visible.filter(id => ids.has(id))
  assert.equal(matches.length, 1, 'exactly one picker entry must belong to the target published product')
  await menu.locator(`button.picker-choice[data-offer-id="${matches[0]}"]`).click()
}
