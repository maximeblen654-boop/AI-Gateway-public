// Independent fixture for the previously documented /v1/media/uploads protocol.
import https from 'node:https';import http from 'node:http';import fs from 'node:fs';import crypto from 'node:crypto';
const root=process.env.PHASE5_EVIDENCE_ROOT||'.evidence',file=root+'/supplier-state.json';
let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{init:0,requests:[],uploads:{}};
const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file)};
https.createServer({key:fs.readFileSync(root+'/simulator-key.pem'),cert:fs.readFileSync(root+'/simulator-cert.pem')},async(req,res)=>{const reply=(s,v)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(v))};try{
 const url=new URL(req.url,'https://localhost');state.requests.push({method:req.method,path:url.pathname});save();
 if(!req.headers.authorization?.startsWith('Bearer '))return reply(401,{error:'auth'});
 let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>2**20)return reply(413,{error:'size'});chunks.push(c)}const body=Buffer.concat(chunks);
 if(req.method==='GET'&&url.pathname==='/v1/models')return reply(200,{object:'list',data:[{id:'phase5-native-image-v1',object:'model',owned_by:'phase5-local-simulator'},{id:'phase5-native-video-v1',object:'model',owned_by:'phase5-local-simulator'},{id:'gpt-image-2',object:'model',owned_by:'phase5-local-simulator'},{id:'特价2.0-需要过人脸技术-可参考过人脸素材库',object:'model',owned_by:'phase5-local-simulator'},{id:'LOCAL TEST ONLY - reference protocol',object:'model',owned_by:'phase5-local-simulator'}]});
 if(req.method==='POST'&&url.pathname==='/v1/images/generations'){
   const v=JSON.parse(body);
   if(!['phase5-native-image-v1','gpt-image-2'].includes(v.model)||typeof v.prompt!=='string'||v.n!==1||!/^\d+x\d+$/.test(v.size)||v.response_format!==undefined&&v.response_format!=='b64_json'||v.images!==undefined&&(!Array.isArray(v.images)||v.images.some(i=>typeof i.image_url!=='string'||!i.image_url.startsWith('data:image/'))))return reply(422,{error:'image_contract'});
   state.image_posts=(state.image_posts||0)+1;
   (state.image_requests||=[]).push({model:v.model,size:v.size,n:v.n,images:v.images?.length||0,request_hash:crypto.createHash('sha256').update(body).digest('hex')});save();
   if(v.prompt.startsWith('READINESS_REJECT '))return reply(422,{error:'synthetic_rejection'});
   if(v.prompt.startsWith('READINESS_LOST ')){req.socket.destroy();return;}
   if(v.prompt.startsWith('READINESS_DELAY '))await new Promise(r=>setTimeout(r,2000));
   return reply(200,{data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}]});
 }
 if(req.method==='POST'&&url.pathname==='/v1/media/uploads'){
 const v=JSON.parse(body);if(Object.keys(v).sort().join(',')!=='mime_type,sha256,size'||!Number.isInteger(v.size)||v.size<=0||!/^[a-f0-9]{64}$/.test(v.sha256))return reply(400,{error:'init_fields'});
 const id='local-'+(++state.init);state.uploads[id]={id,...v,received:[],chunks:{},status:'uploading',chunk_size:1048576,chunk_count:Math.ceil(v.size/1048576)};save();return reply(200,{id});}
 const match=/^\/v1\/media\/uploads\/(local-\d+)(?:\/(chunks\/(\d+)|complete))?$/.exec(url.pathname);if(!match||!state.uploads[match[1]])return reply(404,{error:'route'});const u=state.uploads[match[1]];
 if(req.method==='GET'&&!match[2]){const {chunks,...view}=u;return reply(200,view)}
 if(req.method==='PUT'&&match[3]!==undefined){const i=Number(match[3]);if(req.headers['content-type']!=='application/octet-stream'||i>=u.chunk_count||body.length!==Math.min(u.chunk_size,u.size-i*u.chunk_size))return reply(400,{error:'chunk'});u.chunks[i]=body.toString('base64');if(!u.received.includes(i))u.received.push(i);save();return reply(200,{})}
 if(req.method==='POST'&&match[2]==='complete'){const all=Buffer.concat(Array.from({length:u.chunk_count},(_,i)=>Buffer.from(u.chunks[i]||'','base64')));if(all.length!==u.size||crypto.createHash('sha256').update(all).digest('hex')!==u.sha256)return reply(409,{error:'digest'});u.status='complete';u.source='https://host.docker.internal:19090/media/'+match[1];save();return reply(200,{status:"complete",source:u.source})}return reply(405,{error:'method'});
 }catch{reply(400,{error:'protocol'})}}).listen(19090,'0.0.0.0');
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({init:state.init,requests:state.requests,uploads:Object.keys(state.uploads).length,image_posts:state.image_posts||0,image_requests:state.image_requests||[]}))}).listen(19091,'127.0.0.1');
console.log('Local HTTPS protocol simulator ready');
