import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const imageFile=fileURLToPath(new URL('./retention-cover.jpg',import.meta.url))
const videoFile=fileURLToPath(new URL('./retention-video.mp4',import.meta.url))
async function open(page:Page,scenario='image2pro-protocol'){
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
 await page.goto('/tests/studio-workspace/index.html?scenario='+scenario)
}
const calls=(page:Page)=>page.evaluate(()=>(window as any).studioFixture.calls)
for(const width of [1440,390]){
 test(`multiple images remain in a collapsed quote at ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await open(page,'reference-offers')
  if(width===390){
   const navigation=await Promise.all(['text','edit','video','history'].map(mode=>page.getByTestId('studio-mode-'+mode).boundingBox()))
   expect(Math.max(...navigation.map(box=>box!.y))-Math.min(...navigation.map(box=>box!.y))).toBeLessThan(2)
  }
  await expect(page.getByTestId('studio-asset-input')).toHaveCount(0)
  await page.getByTestId('studio-mode-edit').click()
  expect((await page.getByTestId('studio-asset-uploader').boundingBox())!.y).toBeLessThan((await page.getByTestId('studio-prompt').boundingBox())!.y)
  await page.getByTestId('studio-asset-input').setInputFiles([imageFile,imageFile])
  await expect(page.getByTestId('studio-asset-success')).toHaveCount(2)
  await page.getByTestId('studio-assets-toggle').click();await expect(page.getByTestId('studio-assets')).toBeHidden()
  await expect(page.getByTestId('studio-asset-summary')).toContainText('2')
  await page.getByTestId('studio-prompt').fill('结合两张参考图片，创作一个新的画面')
  await page.screenshot({path:info.outputPath(`image-compose-${width}.png`),fullPage:true})
  await page.getByTestId('studio-quote').click();await expect(page.getByTestId('studio-confirm-generate')).toBeEnabled()
  const posted=await calls(page),prepare=posted.find((c:any)=>c.path.endsWith('/image/prepare'))
  expect(prepare.body.asset_refs).toHaveLength(2);expect(new Set(prepare.body.asset_refs).size).toBe(2)
  expect(posted.find((c:any)=>c.path.endsWith('/image/quotes')).body.spec.images).toBe(2)
  expect(posted.filter((c:any)=>c.method==='POST'&&c.path.endsWith('/tasks'))).toHaveLength(0)
  await page.getByRole('button',{name:'返回修改'}).click()
  await expect(page.getByTestId('studio-mode-edit')).toHaveAttribute('aria-pressed','true')
  await expect(page.getByTestId('studio-asset-summary')).toContainText('2');await page.getByTestId('studio-assets-toggle').click()
  await expect(page.getByTestId('studio-asset-success')).toHaveCount(2)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
 })
 test(`mixed media collapse preserves preparation and pauses playback at ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await open(page)
  await page.getByTestId('studio-mode-video').click()
  const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40)
  await page.getByTestId('studio-asset-input').setInputFiles([imageFile,videoFile]);await page.getByTestId('studio-asset-input').setInputFiles({name:'sound.wav',mimeType:'audio/wav',buffer:wav})
  await expect(page.getByTestId('studio-asset-success')).toHaveCount(3)
  for(const kind of ['video','audio']){const media=page.getByTestId('studio-asset-'+kind);await expect.poll(()=>media.evaluate((e:HTMLMediaElement)=>e.readyState)).toBeGreaterThan(0);await media.evaluate(async(e:HTMLMediaElement)=>{e.muted=true;e.loop=true;e.currentTime=0;await e.play()})}
  await page.screenshot({path:info.outputPath(`video-materials-${width}.png`),fullPage:true})
  await page.getByTestId('studio-assets-toggle').click()
  for(const kind of ['video','audio'])await expect(page.getByTestId('studio-asset-'+kind)).toHaveJSProperty('paused',true)
  await page.getByTestId('studio-assets-toggle').click()
  for(const kind of ['video','audio'])await page.getByTestId('studio-asset-'+kind).evaluate(async(e:HTMLMediaElement)=>{e.currentTime=0;await e.play()})
  await page.getByTestId('studio-prompt').fill('根据参考画面、动作和声音创作视频')
  await page.getByTestId('studio-quote').click();await expect(page.getByTestId('studio-confirm-generate')).toBeEnabled()
  for(const kind of ['video','audio'])await expect(page.getByTestId('studio-asset-'+kind)).toHaveJSProperty('paused',true)
  const posted=await calls(page),prepare=posted.find((c:any)=>c.path.endsWith('/video/prepare')),quote=posted.find((c:any)=>c.path.endsWith('/video/quotes'))
  expect(prepare.body.assets.map((a:any)=>a.kind)).toEqual(['image','video','audio'])
  expect(quote.body.assets).toEqual(prepare.body.assets);expect(quote.body.preparation_id).toBe('isolated-image2pro-preparation')
  expect(posted.filter((c:any)=>c.method==='POST'&&c.path.endsWith('/tasks'))).toHaveLength(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
 })
}
test('continuing across image and video history reloads the matching catalog',async({page})=>{
 await open(page,'mixed')
 for(const kind of ['video','image']){
  await page.getByTestId('studio-mode-history').click()
  await page.locator(`[data-task-id^="${kind==='video'?'op_':'img_'}"]`).first().click()
  await page.getByTestId('studio-new').click()
  await expect(page.getByTestId('studio-model-toggle')).toContainText(kind==='video'?'映像':'GPT Image 2')
  if(kind==='video')await expect(page.getByTestId('studio-duration')).toContainText('5 秒')
  expect((await calls(page)).some((call:any)=>call.path.endsWith(`/${kind}/catalog`))).toBe(true)
 }
 expect((await calls(page)).filter((call:any)=>call.method==='POST'&&call.path.endsWith('/tasks'))).toHaveLength(0)
})

test('collapsed failed upload remains visible and blocks quotation',async({page})=>{
 await open(page);await page.getByTestId('studio-mode-video').click()
 await page.evaluate(()=>{const original=window.fetch;window.fetch=async(input,init)=>String(input).endsWith('/assets/uploads')?new Response(JSON.stringify({error:'synthetic_upload_failure'}),{status:503,headers:{'Content-Type':'application/json'}}):original(input,init)})
 await page.getByTestId('studio-asset-input').setInputFiles(imageFile);await expect(page.getByTestId('studio-asset-failure')).toHaveCount(1)
 await page.getByTestId('studio-assets-toggle').click();await expect(page.getByTestId('studio-asset-summary')).toContainText('上传失败')
 await expect(page.getByTestId('studio-asset-feedback')).toBeVisible();await page.getByTestId('studio-prompt').fill('保留失败时输入的描述')
 await expect(page.getByTestId('studio-quote')).toBeDisabled();expect((await calls(page)).filter((c:any)=>c.path.endsWith('/quotes'))).toHaveLength(0)
})
