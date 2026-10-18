import datetime,decimal,hashlib,json,pathlib,re,urllib.request,urllib.error
from html.parser import HTMLParser
base=pathlib.Path('/var/lib/ai-gateway/checkpoints/predeploy-8ad2eff-20261018T212207Z')
before=json.loads((base/'persistent-fingerprints.json').read_text())
roots={'core-data':pathlib.Path('/var/lib/docker/volumes/deploy_sub2api_data/_data'),'studio-data':pathlib.Path('/var/lib/ai-gateway/studio-v2')}
allowed={
 'upstream-change-monitor/image-task-reconciliations.json':r'/(?:sampled_at|tasks/0/checked_at)',
 'upstream-change-monitor/upstream-changes-baselines.json':r'/sources/[^/]+/last_success_at',
 'upstream-change-monitor/upstream-changes.json':r'/(?:sampled_at|sources/[0-9]+/last_success_at)'}
def changes(a,b,path=''):
    if type(a)!=type(b):return[(path,a,b)]
    if isinstance(a,dict):
        assert set(a)==set(b),'unexpected JSON keys changed'
        return[x for k in sorted(a)for x in changes(a[k],b[k],path+'/'+k)]
    if isinstance(a,list):
        assert len(a)==len(b),'unexpected JSON length changed'
        return[x for i,(v,w)in enumerate(zip(a,b))for x in changes(v,w,path+'/'+str(i))]
    return[]if a==b else[(path,a,b)]
out={'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'read_only':True,'persistent_files':{}}
for key,root in roots.items():
    current={}
    for p in sorted(root.rglob('*')):
        rel=str(p.relative_to(root))
        if 'logs'in p.relative_to(root).parts or rel=='server-storage.json':continue
        assert not p.is_symlink()
        if p.is_file():current[rel]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    assert set(current)==set(before[key]),'file created or removed; review required'
    observations=[]
    for rel,record in current.items():
        if record==before[key][rel]:continue
        assert key=='core-data'and rel in allowed,'business file changed'
        a=json.loads((base/'restore-files'/key/rel).read_text(),parse_float=decimal.Decimal)
        b=json.loads((root/rel).read_text(),parse_float=decimal.Decimal)
        delta=changes(a,b);assert delta,'raw bytes changed without explained JSON delta'
        for path,x,y in delta:
            assert re.fullmatch(allowed[rel],path)
            tx=datetime.datetime.fromisoformat(x.replace('Z','+00:00'));ty=datetime.datetime.fromisoformat(y.replace('Z','+00:00'))
            assert tx.tzinfo and ty.tzinfo and ty>=tx
        observations.append({'file':rel,'changed_paths':[x[0]for x in delta]})
    out['persistent_files'][key]={'files':len(current),'no_added_or_removed_files':True,'business_files_unchanged':True,'observation_timestamp_only_changes':observations}
out['http']={}
for url in ['http://laifufu.top/video-studio','http://127.0.0.1:8094/health','http://127.0.0.1:4174/health','http://127.0.0.1:8080/v1/studio/images/readiness','https://laifufu.top/v1/studio/images/readiness','https://laifufu.top/studio-v2/api/image/readiness']:
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'AI-Gateway-Predeploy-ReadOnly/1.0'}),timeout=30)as r:
            data=r.read();out['http'][url]={'status':r.status,'final_url':r.url,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'content_type':r.headers.get('Content-Type'),'cf_mitigated':r.headers.get('cf-mitigated')}
    except urllib.error.HTTPError as e:out['http'][url]={'status':e.code,'final_url':e.url,'cf_mitigated':e.headers.get('cf-mitigated')}
class Tags(HTMLParser):
    def __init__(self):super().__init__();self.tokens=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='script'and str(a.get('src','')).startswith('https://static.cloudflareinsights.com/beacon.min.js/'):
            self.tokens.append(json.loads(a['data-cf-beacon'])['token'])
with urllib.request.urlopen(urllib.request.Request('https://laifufu.top/video-studio',headers={'User-Agent':'AI-Gateway-Predeploy-ReadOnly/1.0'}),timeout=30)as r:
    p=Tags();p.feed(r.read().decode());assert len(p.tokens)==1
    out['observed_beacon_token_sha256']=hashlib.sha256(p.tokens[0].encode()).hexdigest()
out['status']='PASS'
print(json.dumps(out))
