import { test, expect } from '@playwright/test'

test('local exports preserve actual dimensions, alpha, MIME and JPEG white background', async ({ page }) => {
  await page.route('**/export-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Local export test</body></html>'}))
  await page.goto('/export-harness')
  const results = await page.evaluate(async () => {
    // Exercise the production helper in a real browser, not a canvas mock.
    const { convertImageBlob } = await import('/src/components/video/imageExport.ts')
    const outputs = []
    for (const [width, height] of [[160,90],[90,160],[100,100]]) {
      const source = document.createElement('canvas');source.width=width;source.height=height
      source.getContext('2d')!.fillRect(width/2,height/2,1,1)
      const original = await new Promise<Blob>(resolve=>source.toBlob(blob=>resolve(blob!),'image/png'))
      for(const format of ['png','jpeg','webp'] as const){
        const output = await convertImageBlob(original,format)
        const bitmap = await createImageBitmap(output)
        const check = document.createElement('canvas');check.width=width;check.height=height
        check.getContext('2d')!.drawImage(bitmap,0,0)
        outputs.push({format,width:bitmap.width,height:bitmap.height,mime:output.type,pixel:Array.from(check.getContext('2d')!.getImageData(0,0,1,1).data)})
        bitmap.close()
      }
    }
    return outputs
  })
  expect(results).toHaveLength(9)
  for (const result of results) {
    expect([[160,90],[90,160],[100,100]]).toContainEqual([result.width,result.height])
    expect(result.mime).toBe(`image/${result.format}`)
    expect(result.pixel).toEqual(result.format === 'jpeg' ? [255,255,255,255] : [0,0,0,0])
  }
})

test('protected export rejects expired, unauthorized, invalid and oversized originals without POST', async ({ page }) => {
  await page.route('**/export-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Local export test</body></html>'}))
  await page.goto('/export-harness')
  let posts=0
  page.on('request',request=>{if(request.method()==='POST')posts++})
  await page.route('**/export-check/**', async route => {
    const mode=route.request().url().split('/').pop()
    await route.fulfill({status:mode==='expired'?410:mode==='auth'?403:200,headers:{'content-type':mode==='invalid'?'text/html':'image/png',...(mode==='large'?{'content-length':'40000000'}:{})},body:'not image'})
  })
  const errors=await page.evaluate(async()=>{
    const {readExportOriginal,convertImageBlob}=await import('/src/components/video/imageExport.ts')
    const results=[]
    for(const mode of ['expired','auth','invalid','large']){
      try{await readExportOriginal(`/export-check/${mode}`,new AbortController().signal)}catch(error){results.push((error as Error).message)}
    }
    try{await convertImageBlob(new Blob(['bad'],{type:'image/png'}),'png')}catch(error){results.push((error as Error).message)}
    return results
  })
  expect(errors).toHaveLength(5)
  expect(errors[0]).toContain('过期');expect(errors[1]).toContain('权限');expect(errors[2]).toContain('格式');expect(errors[3]).toContain('过大');expect(errors[4]).toContain('解码失败')
  expect(posts).toBe(0)
})

for (const width of [1440,390]) test(`result export controls and original download remain usable ${width}px`, async ({page},info)=>{
  await page.setViewportSize({width,height:844})
  await page.goto('/tests/studio-workspace/index.html?scenario=gallery')
  await page.locator('.studio-work').first().click()
  await expect(page.getByTestId('studio-download').first()).toBeVisible()
  await page.evaluate(async()=>{
    const source=document.createElement('canvas');source.width=160;source.height=90
    const original=await new Promise<Blob>(resolve=>source.toBlob(blob=>resolve(blob!),'image/png'))
    const previous=window.fetch
    window.fetch=async(input,init)=>String(input).includes('/results/')?new Response(original,{headers:{'content-type':'image/png'}}):previous(input,init)
  })
  const control=page.locator('.image-export').first()
  await control.getByLabel('图片导出格式').selectOption('jpeg')
  await expect(control).toContainText('白色背景')
  const downloadPromise=page.waitForEvent('download')
  await control.getByRole('button',{name:'导出图片'}).click()
  const download=await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.jpg$/)
  await expect(control.getByRole('status')).toContainText('保留期限不变')
  await control.scrollIntoViewIfNeeded()
  const box=await control.boundingBox();expect(box!.width).toBeLessThanOrEqual(width);expect(box!.x).toBeGreaterThanOrEqual(0)
  await page.screenshot({path:info.outputPath(`image-export-${width}.png`)})
  const calls=await page.evaluate(()=>(window as any).studioFixture.calls as {method:string;path:string}[])
  expect(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/tasks'))).toHaveLength(0)
})
