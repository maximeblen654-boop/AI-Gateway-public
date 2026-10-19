import { describe, expect, it } from 'vitest'
import type { StudioOffer } from '@/api/studioMedia'
import { groupProductOffers, productDimensionValues, productReferenceOffers, resolveProductOffer, supportsProductReferences, type OfferSelection } from '../studioProductOffers'
const selection: OfferSelection = { resolution: '720p', aspect_ratio: '16:9', quality: '', duration_seconds: 5, count: 1, images: 0, videos: 0, audio: 0 }
const make = (id: string, duration = 5, scope: string | undefined = 'video-scope'): StudioOffer => ({ offer_id: id, product_scope: scope, display_name: 'Same name', model: 'site', upstream_model: 'upstream', spec: { resolution: ['720p'], aspect_ratio: ['16:9'], duration_seconds: [duration], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 1 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 1 } } })
describe('product identity and exact Offer specification selection', () => {
  it('groups three Offers while retaining their independent identities and selected member', () => {
    const offers = [make('a'), make('b', 10), make('c', 15)]
    const groups = groupProductOffers(offers, 'b')
    expect(groups).toHaveLength(1); expect(groups[0]?.selected.offer_id).toBe('b')
    expect(groups[0]?.offers.map(offer => offer.offer_id)).toEqual(['a', 'b', 'c'])
    expect(productDimensionValues(offers[0],offers,'duration_seconds').map(v=>[v,resolveProductOffer(offers[0]!,offers,{...selection,duration_seconds:Number(v)})?.offer_id])).toEqual([[5,'a'],[10,'b'],[15,'c']])
  })
  it('never groups same names across product scopes, models or unknown scopes', () => {
    const a=make('a'), b=make('b',10,'different-product'), c={...make('c'),model:'different-site'}, d={...make('d'),product_scope:undefined}, e={...make('e'),product_scope:undefined}
    expect(groupProductOffers([a,b,c,d,e], 'a')).toHaveLength(5)
    expect(productDimensionValues(a,[a,b,c,d,e],'duration_seconds')).toEqual([5])
  })
  it('resolves uploaded references to an exact sibling without changing user specifications', () => {
    const a=make('text'), b=make('refs');a.spec.references.image.max=0;b.spec.references.image.min=1
    expect(resolveProductOffer(a,[a,b],{...selection,images:1})?.offer_id).toBe('refs')
    expect(resolveProductOffer(a,[a,b],{...selection,images:2})).toBeUndefined()
  })
  it('rejects ambiguous siblings, exclusions, incompatible formats and invented combinations', () => {
    const a=make('a'), b=make('b',10), c=make('c',10), d=make('d',15);d.spec.resolution=['1080p']
    expect(resolveProductOffer(a,[a,b,c,d],{...selection,duration_seconds:10})).toBeUndefined();expect(resolveProductOffer(a,[a,b,c,d],{...selection,duration_seconds:15})).toBeUndefined()
    b.excluded=[{aspect_ratio:['16:9']}]
    expect(resolveProductOffer(a,[a,b],{...selection,duration_seconds:10})).toBeUndefined()
    b.excluded=[];b.spec.output_formats=['png']
    expect(resolveProductOffer(a,[a,b],{...selection,duration_seconds:10,output_format:'webp'})).toBeUndefined()
  })
  it('supports image resolution, quality and count price rules without merging them', () => {
    const a=make('2k',0,'image-scope'), b=make('4k',0,'image-scope');a.spec.resolution=['2K'];b.spec.resolution=['4K'];b.spec.count={min:1,max:2}
    const selected={...selection,resolution:'2K',duration_seconds:0}
    expect(groupProductOffers([a,b],'2k')).toHaveLength(1)
    expect(productDimensionValues(a,[a,b],'resolution')).toEqual(['2K','4K']);expect(resolveProductOffer(a,[a,b],{...selected,resolution:'4K'})?.offer_id).toBe('4k')
    expect(resolveProductOffer(a,[a,b],{...selected,resolution:'4K',count:2})?.offer_id).toBe('4k')
    expect(resolveProductOffer(a,[a,b],{...selected,resolution:'2K',count:2})).toBeUndefined()
  })
  it.each(['image', 'video'] as const)('admits %s inputs against one compatible sibling and resolves its exact reference count', type => {
    const a=make('one'), b=make('two')
    for(const [index,offer] of [a,b].entries()) {
      offer.spec.references.image={min:0,max:0};offer.spec.references[type]={min:index+1,max:index+1};offer.spec.references.total_max=index+1
    }
    const selected={...selection,images:type==='image'?2:0,videos:type==='video'?2:0}
    expect(productReferenceOffers(a,[a,b],selection).map(offer=>offer.offer_id)).toEqual(['one','two'])
    expect(supportsProductReferences(a,[a,b],selected)).toBe(true)
    expect(resolveProductOffer(a,[a,b],selected)?.offer_id).toBe('two')
    expect(supportsProductReferences(a,[b],{...selected,images:0,videos:0})).toBe(true)
    expect(resolveProductOffer(a,[b],{...selected,images:0,videos:0})).toBeUndefined()
    expect(supportsProductReferences(a,[a,b],{...selected,[type==='image'?'images':'videos']:3})).toBe(false)
  })
  it('never combines reference capacities across Offers, product scopes, specifications or exclusions', () => {
    const a=make('images'), b=make('videos'), other=make('other',5,'other-product'), incompatible=make('1080p')
    a.spec.references.image.max=2;a.spec.references.total_max=2
    b.spec.references.image.max=0;b.spec.references.video.max=2;b.spec.references.total_max=2
    other.spec.references.image.max=3;other.spec.references.total_max=3
    incompatible.spec.resolution=['1080p'];incompatible.spec.references.image.max=3;incompatible.spec.references.total_max=3
    const offers=[a,b,other,incompatible]
    expect(supportsProductReferences(a,offers,{...selection,images:1,videos:1})).toBe(false)
    expect(supportsProductReferences(a,offers,{...selection,images:3})).toBe(false)
    expect(productReferenceOffers(a,offers,selection).map(offer=>offer.offer_id)).toEqual(['images','videos'])
    a.excluded=[{references:{...a.spec.references,image:{min:2,max:2}}}]
    expect(supportsProductReferences(a,offers,{...selection,images:2})).toBe(false)
  })
})
