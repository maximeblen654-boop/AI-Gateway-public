const {chromium}=require('../../frontend/node_modules/@playwright/test');
const {execFileSync}=require('node:child_process');const fs=require('node:fs');
process.chdir(require('node:path').resolve(__dirname,'../..'));
const events=[];const base='http://127.0.0.1:3000';
(async()=>{const {env,emails}=await require('./local-identities.cjs')();const browser=await chromium.launch({channel:'chrome',headless:true});const ctx=await browser.newContext();const page=await ctx.newPage();
page.on('response',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/studio-v2/api/')||url.pathname==='/api/v1/auth/login'||url.pathname==='/api/v1/auth/studio-media-ticket')events.push({method:r.request().method(),path:url.pathname,status:r.status()})});
try{
await page.goto(base+'/login');await page.getByLabel('邮箱').fill(emails[0]);await page.getByLabel('密码').fill(env.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard');
await page.goto(base+'/video-studio');await page.getByTestId('studio-media-open').click();await page.getByTestId('studio-offer-select').locator('option').first().waitFor({state:'attached',timeout:15000});
console.log('catalog loaded',await page.getByTestId('studio-offer-select').innerText());
await page.getByTestId('studio-prompt').fill('Synthetic local media test');
await page.getByTestId('studio-asset-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
await page.getByTestId('studio-status').filter({hasText:'素材已保存'}).waitFor();
await page.getByTestId('studio-quote').click();await page.waitForTimeout(1500);
console.log('status',await page.getByTestId('studio-status').innerText());console.log('alerts',await page.getByRole('alert').allTextContents());
await page.getByTestId('studio-media-panel').screenshot({path:'.evidence/video-real.png'});
await page.getByTestId('studio-kind').selectOption('image');await page.waitForTimeout(1000);await page.getByTestId('studio-quote').click();await page.waitForTimeout(1000);console.log('image',await page.getByTestId('studio-status').innerText());console.log('alerts',await page.getByRole('alert').allTextContents());await page.getByTestId('studio-media-panel').screenshot({path:'.evidence/image-real.png'});

const imageStatus=await page.getByTestId('studio-status').innerText();
await page.reload();await page.getByTestId('studio-media-open').click();await page.getByTestId('studio-quote').click();await page.waitForTimeout(800);if(await page.getByTestId('studio-status').innerText()!==imageStatus)throw Error('image refresh changed operation');
require('./fixture-config.cjs').stopOwnedBff();
execFileSync(process.execPath,['tools/phase5-media-e2e/start-local.mjs'],{cwd:process.cwd(),windowsHide:true,stdio:'pipe'});
await page.waitForTimeout(1500);await page.getByTestId('studio-quote').click();await page.waitForTimeout(800);if(await page.getByTestId('studio-status').innerText()!==imageStatus)throw Error('image restart changed operation');console.log('image refresh and real BFF restart stable');
await page.getByTestId('studio-kind').selectOption('video');await page.waitForTimeout(500);await page.getByTestId('studio-quote').click();await page.waitForTimeout(800);const videoStatus=await page.getByTestId('studio-status').innerText();await page.reload();await page.getByTestId('studio-media-open').click();await page.getByTestId('studio-quote').click();await page.waitForTimeout(800);if(await page.getByTestId('studio-status').innerText()!==videoStatus)throw Error('video refresh changed operation');console.log('video refresh stable');
await page.getByTestId('studio-kind').selectOption('image');await page.waitForTimeout(500);await page.getByRole('button',{name:'移除',exact:true}).click();await page.getByTestId('studio-quote').click();await page.waitForTimeout(700);if((await page.getByRole('alert').allTextContents()).length||!(await page.getByTestId('studio-status').innerText()).includes('img_'))throw Error('text image failed');console.log('text image preparation passed');
}finally{fs.writeFileSync('.evidence/http-summary.json',JSON.stringify(events,null,2));console.log(JSON.stringify(events));await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
