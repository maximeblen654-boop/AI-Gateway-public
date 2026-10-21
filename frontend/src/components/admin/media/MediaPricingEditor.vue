<template>
  <div class="mw-retail-pricing" data-test="pricing-editor">
    <p class="mw-muted">客户售价为每张图片的人民币金额。购买数量按单价 × 数量计算。</p>
    <div class="mw-price-table-head"><span>适用规格</span><span>客户售价（人民币 / 张）</span><span>填写状态</span></div>
    <div v-for="(rule, index) in rows" :key="`${JSON.stringify(rule.match)}:${index}`" class="mw-price-row">
      <div class="mw-price-spec"><strong>{{ labels[index] || mediaSpecLabel(rule.match) }}</strong></div>
      <label class="mw-field"><span class="mw-price-mobile-label">客户售价（人民币 / 张）</span>
        <input class="input" inputmode="decimal" placeholder="待填写" :value="rule.sale_price?.amount ?? ''" :disabled="disabled" :aria-label="`${labels[index] || mediaSpecLabel(rule.match)} 客户售价（人民币 / 张）`" :data-test="`price-${index}`" :data-field="`pricing_rules.${index}.sale_price`" :aria-invalid="!!priceError(rule)" @input="setPrice(index, ($event.target as HTMLInputElement).value)" />
      </label>
      <div class="mw-price-state"><span>{{ priceError(rule) ? '需要修正' : rule.sale_price ? '已填写' : '待填写' }}</span>
        <p v-if="priceError(rule)" class="mw-field-error">{{ priceError(rule) }}</p>
        <small v-if="rule.sale_price && (rule.sale_price.currency !== 'CNY' || rule.sale_price.billing_mode !== 'per_request')">原售价 {{ rule.sale_price.amount }} {{ rule.sale_price.currency }} / {{ rule.sale_price.billing_mode }}；重新填写后才改为人民币每张售价。</small>
      </div>
    </div>
    <p class="mw-muted">独立计算器仅供手工试算，不会填入售价或修改商品。</p>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { Product } from '@/api/admin/mediaWorkbench'
import { mediaSpecLabel } from './mediaSpecLabel'
const props = defineProps<{ product: Product; disabled: boolean; labels: string[] }>()
const emit = defineEmits<{ 'update:product': [product: Product] }>()
const rows = computed<Product['pricing_rules']>(() => props.product.pricing_rules.length ? props.product.pricing_rules : [{ match: {}, sale_price: null }])
function setPrice(index: number, amount: string) {
  if (props.disabled) return
  const pricingRules: Product['pricing_rules'] = JSON.parse(JSON.stringify(rows.value))
  pricingRules[index] = { ...pricingRules[index]!, sale_price: amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' } }
  emit('update:product', { ...props.product, pricing_rules: pricingRules })
}
function priceError(rule: Product['pricing_rules'][number]): string {
  if (!rule.sale_price) return ''
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(rule.sale_price.amount)) return '请输入有效金额，最多 8 位小数；原始输入仍保留在草稿中。'
  return /^0(?:\.0+)?$/.test(rule.sale_price.amount) ? '客户售价须大于 0 CNY；0 元可保留在草稿中，但不能发布或生成。' : ''
}
</script>
