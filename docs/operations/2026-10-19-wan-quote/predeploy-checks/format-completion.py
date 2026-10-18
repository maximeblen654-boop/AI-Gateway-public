import collections,datetime,hashlib,json,pathlib,re,subprocess
def run(a):
    p=subprocess.run(a,capture_output=True)
    if p.returncode:raise RuntimeError('read-only format check failed: '+a[0])
    return p.stdout
core=json.loads(run(['docker','inspect','sub2api']))[0]
root=pathlib.Path(next(m['Source']for m in core['Mounts']if m['Destination']=='/app/data'))
summary=collections.Counter();unknown=[];markers=[]
for folder in ['studio-image-bindings','studio-video-bindings','image-receipts']:
    for p in sorted((root/folder).rglob('*')):
        if not p.is_file():continue
        assert not p.is_symlink()
        data=p.read_bytes()
        try:json.loads(data);summary['json_records']+=1;continue
        except (ValueError,UnicodeError):pass
        kind=None
        if re.fullmatch(r'unit-claim-[a-f0-9]{64}',p.name) and re.fullmatch(b'[a-f0-9]{64}',data):
            unit_hash=p.name[len('unit-claim-'):]
            # A claim is raw payload hash, not JSON. Bind to its actual immutable task unit.
            matches=[]
            for task in (root/folder).glob('task-*'):
                if not re.fullmatch(r'task-[a-f0-9]{64}',task.name):continue
                obj=json.loads(task.read_bytes())
                matches += [u for u in obj.get('units',[])if hashlib.sha256(u.get('id','').encode()).hexdigest()==unit_hash and u.get('payload_hash','').encode()==data]
            if len(matches)==1:kind='unit_claim_bound_to_receipt'
        elif folder=='image-receipts' and re.fullmatch(r'[0-9]+_img_[a-f0-9]{32}\.claim',p.name) and data==b'':
            owner,client_key=p.stem.split('_',1)
            matches=[]
            for receipt in (root/folder).glob(owner+'_*_'+client_key+'.json'):
                obj=json.loads(receipt.read_bytes())
                if obj.get('UserID')==int(owner) and obj.get('ClientKey')==client_key:matches.append(obj)
            if len(matches)==1:kind='empty_legacy_claim_bound_to_receipt'
        elif p.name.endswith('.sync-dispatch') and re.fullmatch(b'[a-f0-9]{64}\\|[a-f0-9]{64}',data):
            receipt=pathlib.Path(str(p)[:-len('.sync-dispatch')])
            obj=json.loads(receipt.read_bytes())
            if (obj['quote']['binding_hash']+'|'+obj['payload_hash']).encode()==data:kind='dispatch_claim_bound_to_receipt'
        elif p.suffix in ['.result','.upstream']:
            receipt=pathlib.Path(str(p)[:-len(p.suffix)])
            obj=json.loads(receipt.read_bytes())
            key='result_hash'if p.suffix=='.result'else'upstream_response_hash'
            if hashlib.sha256(data).hexdigest()==obj.get(key):kind='receipt'+p.suffix+'_hash_verified'
        if kind:
            summary[kind]+=1
            markers.append({'kind':kind,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        else:unknown.append({'relative_path':str(p.relative_to(root)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
print(json.dumps({'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'read_only':True,'counts':dict(summary),'non_json_files':markers,'unclassified_files':unknown,'status':'PASS'if not unknown else'BLOCKED'}))
