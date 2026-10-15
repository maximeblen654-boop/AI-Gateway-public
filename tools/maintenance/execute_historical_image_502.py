"""One-time 2026-10-15 production operation; no runtime deployment or SQL writes.
Requires sealed before-full.json + native-evidence.json next to this file.
Default is read-only plan. --apply is ONLY for the explicit three-task authority.
"""
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from historical_image_502 import transition

ROOT = Path('/var/lib/docker/volumes/deploy_sub2api_data/_data/studio-image-bindings')
JOURNAL = Path('/var/lib/ai-gateway/studio-v2/images/journal')
HERE = Path(__file__).resolve().parent
APPROVED = {
 'img_246553331bf3e4639ab4adbe94fcccc2': ('bdfccad4-adb0-4c1c-a67d-f89c19fc9935',2,3,3,'16:9','0.075','6ec8c567030fcc504978a734114a26504e55fe44b3840a62d6ef652e892e6d46'),
 'img_66c5f21b1cc78570f98ae244b7ce67a1': ('55bb1465-791b-4783-ab6c-822e3f19a710',2,3,1,'4:3','0.025','bcfd21f11cc1794710c89c78194df24ba9524fe481ec7bbb316546a3ff110cce'),
 'img_f372e5916f913ebc4358129c65add930': ('c49b9bed-0527-498e-ad5b-8819a2db4073',1,4,1,'16:9','0.025','c6928ef9f87521a15c5647d3a0df4d353a1f23e41b5b642c041a5075fc524206'),
}
EXPECTED_IMAGES = {
 'sub2api':'sha256:fb7b46046f8abf255ad7013c4296de24cc956b6b18e44313b7d9af38aeeae1c0',
 'studio-v2-bridge':'sha256:3d3c0a4c07ca4fc92fe5af0865d50b47f2c9783a3acb70bdc209cb5b423aded6',
 'studio-v2-bff':'sha256:c0496b56b01c7f87886e53e5d010380e3f7b73b93355f1042bbf9877da02c686',
}
def sha(b): return hashlib.sha256(b).hexdigest()
def encode(v): return json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()
def core(kind,id): return ROOT/(kind+'-'+sha(id.encode()))
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args): return subprocess.check_output(args,text=True,stderr=subprocess.PIPE,timeout=25).strip()
def read(p):
 assert p.is_file() and not p.is_symlink(), 'unsafe/missing '+str(p)
 return p.read_bytes()
def sql(q):
 s=run(['docker','exec','sub2api-postgres','psql','-X','-U','sub2api','-d','sub2api','-At','-c',"BEGIN READ ONLY; SET LOCAL statement_timeout='8s'; "+q+'; COMMIT;'])
 return [json.loads(x) for x in s.splitlines() if x.startswith('{')]
def syncdir(p):
 fd=os.open(p,os.O_RDONLY)
 try: os.fsync(fd)
 finally: os.close(fd)
def atomic(p, data, expected):
 assert sha(read(p))==expected, 'compare-and-swap failed: '+str(p)
 st=p.stat()
 fd,tmp=tempfile.mkstemp(prefix='.historical-502-',dir=p.parent)
 try:
  os.fchmod(fd,st.st_mode & 0o777);os.fchown(fd,st.st_uid,st.st_gid)
  with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
  assert sha(read(p))==expected, 'second CAS failed'
  os.replace(tmp,p);syncdir(p.parent)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def exclusive(p,data):
 with p.open('xb') as f:
  os.chmod(p,0o600);f.write(data);f.flush();os.fsync(f.fileno())
 syncdir(p.parent)
def containers(before):
 for n,image in EXPECTED_IMAGES.items():
  c=json.loads(run(['docker','inspect',n]))[0]
  assert c['Image']==image and c['Id']==before['containers'][n]['id'], 'runtime drift '+n
  assert c['State']['Running'] and not c['State']['Paused'], 'not available '+n
  assert c['State']['Health']['Status']=='healthy', 'health '+n
  # All original dispatchers died before the new 4f10 process started.
  assert c['State']['StartedAt'] > '2026-10-15T12:00:00', 'old dispatch process'
def finances(before):
 for t,expected in before['fingerprints'].items():
  got=sql("SELECT json_build_object('count',count(*),'digest',md5(COALESCE(string_agg(md5(row_to_json(t)::text),'|' ORDER BY md5(row_to_json(t)::text)),''))) FROM "+t+" t")[0]
  assert got==expected,'business drift '+t
 funds=sql("SELECT json_build_object('id',id,'balance',balance,'frozen_balance',frozen_balance) FROM users WHERE id IN(1,2) ORDER BY id")
 assert funds==before['funds'] and all(x['frozen_balance']==0 for x in funds),'funds drift/hold'
 tx=sql("SELECT json_build_object('prepared',(SELECT count(*) FROM pg_prepared_xacts),'active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'))")[0]
 assert tx=={'prepared':0,'active':0},'active database transaction'
 return {'funds':funds,'transactions':tx,'fingerprints_unchanged':True}
def control_and_holds(before):
 import urllib.request
 c=json.loads(run(['docker','inspect','sub2api']))[0]
 env=dict(v.split('=',1) for v in c['Config']['Env'])
 for kind,want in [('image',True),('video',False)]:
  req=urllib.request.Request('http://127.0.0.1:8080/api/v1/internal/studio/paid-control/'+kind,headers={'X-Studio-Service-Token':env['STUDIO_BRIDGE_SERVICE_TOKEN']})
  with urllib.request.urlopen(req,timeout=8) as response:state=json.load(response)
  assert state==before['paid'][kind] and state['mode']=='managed-v1' and state['paid_enabled'] is want,'switch drift'
 for uid in [1,2]:
  for command,key in [('ZCARD','billing:inflight:{'+str(uid)+'}'),('HLEN','billing:inflight_amt:{'+str(uid)+'}')]:
   args=['docker','exec']
   if env.get('REDIS_PASSWORD'):args+=['-e','REDISCLI_AUTH='+env['REDIS_PASSWORD']]
   args+=['sub2api-redis','redis-cli','-n',env.get('REDIS_DB','0'),'--raw',command,key]
   assert run(args)=='0','inflight reservation'
def inventory(before):
 for root,key in [(ROOT,'core_files'),(JOURNAL,'bff_files')]:
  current={p.name:sha(read(p)) for p in root.iterdir() if p.is_file()}
  assert current==before[key], 'durable inventory drift '+key
 resultroot=JOURNAL.parent/'results'
 actual={str(p.relative_to(resultroot)):sha(read(p)) for p in resultroot.rglob('*') if p.is_file()}
 assert actual==before['private_result_files'],'private results drift'
 assert not any(not (ROOT/('unit-response-'+p.name[len('unit-claim-'):])).exists() for p in ROOT.glob('unit-claim-*')),'in-flight unit'
def candidate(tid,before,evidence):
 rid,uid,kid,count,ratio,price,expected=APPROVED[tid]
 row=next(x for x in before['tasks'] if x['task_id']==tid)
 ep=next(x for x in evidence if x['task_id']==tid)
 assert ep['core_request_id']==rid and ep['response_body_preserved'] is False
 assert any(x.get('account_id')==77 and x.get('status_code')==502 for x in ep['events'])
 assert any(x.get('request_id')==rid and x.get('status_code')==409 and x.get('method')=='POST' for x in ep['events'])
 p=core('task',tid);raw=read(p);assert sha(raw)==expected,'receipt SHA changed'
 r=json.loads(raw);q=r['quote'];u=r['units'][0]
 assert r['task_id']==tid and q['owner']=={'user_id':uid,'api_key_id':kid,'group_id':31}
 assert q['binding']['offer']['account_id']==77 and q['binding']['offer']['upstream_model']=='gpt-image-2'
 spec=q['binding']['spec'];assert spec['resolution']=='4K' and spec['aspect_ratio']==ratio and spec['count']==count and spec['images']==0
 assert q['total_price']=={'amount':price,'currency':'CNY','billing_mode':'per_request'}
 body=base64.b64decode(r['request']);assert sha(body)==r['payload_hash']
 assert len(r['units'])==1 and u['payload_hash']==r['payload_hash']
 op=core('unit-response',u['id']);o=json.loads(read(op));assert sha(read(op))==row['units'][0]['outcome_sha']
 cp=Path(str(p)+'.sync-dispatch');uc=core('unit-claim',u['id'])
 assert read(cp).decode()==q['binding_hash']+'|'+r['payload_hash'] and read(uc).decode()==u['payload_hash']
 assert sha(read(cp))==row['claim']['sha256'] and sha(read(uc))==row['units'][0]['claim_sha']
 for id in [tid,u['id']]:
  assert not any(core(k,id).exists() for k in ['result','upstream','materialized']),'result present'
 assert len(row['bff'])==1
 bp=JOURNAL/row['bff'][0]['file'];j=json.loads(read(bp));assert sha(read(bp))==row['bff'][0]['sha256'],'journal drift'
 bc=Path(str(bp)+'.sync-dispatch');assert sha(read(bc))==row['bff'][0]['claim_sha']
 # Exact owner+task identity index and original client-key fingerprint.
 ip=JOURNAL/('identity-'+sha(encode([uid,tid]))+'.json');identity=json.loads(read(ip))
 assert identity[0]==uid and bp.name=='task-'+sha(encode(identity))+'.json'
 fingerprint=sha(encode({'quote_token':j['request']['quote_token'],'client_key':identity[1],'prompt':j['request']['prompt'],'references':j['request']['references']}))
 assert fingerprint==j['requestHash'] and json.loads(read(bc))['requestHash']==fingerprint
 assert j['quote']['total_price']==q['total_price']
 # Native DB row proves the original Core identity, not the lost upstream body.
 rows=sql("SELECT json_build_object('request_id',request_id,'user_id',user_id,'api_key_id',api_key_id,'group_id',group_id,'status_code',status_code) FROM ops_error_logs WHERE request_id='"+rid+"'")
 assert rows==[{'request_id':rid,'user_id':uid,'api_key_id':kid,'group_id':31,'status_code':409}]
 ids=','.join("'"+x+"'" for x in [tid,rid,sha(('studio-image:'+tid).encode())])
 for table in ['usage_logs','usage_billing_dedup','usage_billing_dedup_archive']:
  assert sql("SELECT json_build_object('count',count(*)) FROM "+table+' WHERE request_id IN ('+ids+')')[0]['count']==0,'settlement exists'
 changed=transition(r,o,j)
 changes=[(op,encode(changed['outcome'])),(p,encode(changed['receipt'])),(bp,encode(changed['journal']))]
 sources={str(x):read(x) for x in [op,p,bp,cp,uc,bc,ip]}
 return {'task_id':tid,'changes':changes,'sources':sources,'evidence':ep}
def main():
 assert socket.gethostname()=='vps-d6b91174' and os.geteuid()==0,'wrong host/user'
 assert sys.argv[1:] in ([],['--apply']), 'invalid mode'
 before=json.loads(read(HERE/'before-full.json'));evidence=json.loads(read(HERE/'native-evidence.json'))
 report={'started_at':stamp(),'mode':'apply' if '--apply' in sys.argv else 'plan','skipped':[],'tasks':[]}
 paused=[]
 with open('/var/lock/ai-gateway-deploy.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  containers(before);inventory(before);finances(before)
  control_and_holds(before)
  plans=[]
  for tid in APPROVED:
   try:plans.append(candidate(tid,before,evidence))
   except (AssertionError,KeyError,ValueError,OSError) as error:report['skipped'].append({'task_id':tid,'reason':str(error)})
  if report['mode']=='plan':
   report['eligible']=[p['task_id'] for p in plans];print(json.dumps(report));return
  assert plans,'no eligible tasks'
  backup=HERE/'originals';backup.mkdir(mode=0o700,exist_ok=False);syncdir(HERE)
  for plan in plans:
   for path,data in plan['sources'].items():
    exclusive(backup/(sha(path.encode())+'.original'),data)
  intent={'started_at':report['started_at'],'plans':[{'task_id':p['task_id'],'sources':{path:sha(data) for path,data in p['sources'].items()},'changes':[{'path':str(path),'before':sha(p['sources'][str(path)]),'after':sha(data)} for path,data in p['changes']],'evidence':p['evidence']} for p in plans]}
  exclusive(HERE/'intent.json',encode(intent))
  try:
   # Real process exclusion, no restart/configuration or managed-state change.
   # All original dispatchers exited on previous deploy; claims are permanent.
   for name in ['studio-v2-bff','studio-v2-bridge','sub2api']:
    run(['docker','pause',name]);paused.append(name)
   report['paused_at']=stamp()
   inventory(before);report['finance_check']=finances(before)
   # Second full byte comparison while every application writer is frozen.
   for plan in plans:
    assert all(read(Path(path))==data for path,data in plan['sources'].items()),'precommit source drift'
   for plan in plans:
    entries=[]
    for path,data in plan['changes']:
     original=plan['sources'][str(path)];atomic(path,data,sha(original))
     assert read(path)==data
     entries.append({'file':str(path),'before':sha(original),'after':sha(data)})
    report['tasks'].append({'task_id':plan['task_id'],'status':'failed','billing_state':'not_charged','delivered_count':0,'files':entries})
    exclusive(HERE/(plan['task_id']+'.committed.json'),encode(report['tasks'][-1]))
  finally:
   resume_errors=[]
   for name in reversed(paused):
    try:run(['docker','unpause',name])
    except Exception as error:resume_errors.append(name+': '+type(error).__name__)
   if resume_errors:raise RuntimeError('UNPAUSE REQUIRED '+','.join(resume_errors))
   report['unpaused_at']=stamp()
  report['finished_at']=stamp();exclusive(HERE/'applied.json',encode(report));print(json.dumps(report))

if __name__=='__main__':main()
