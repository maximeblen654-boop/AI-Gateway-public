"""Narrow read-only proof for the actually observed CSP/RUM transformation."""
import base64,datetime,hashlib,json,re,urllib.request
from html.parser import HTMLParser
SRC='https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092'
INTEGRITY_SHA256='ee5d34692196c0a96f911cd94cb5b4c38992452e06571c8151daeae019bbd650'
TOKEN_SHA256='51dad60d4a093269b5b41e408ef3ecd3c46d50a826c9810f8b11d4f0be477a45'
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'AI-Gateway-Release-Verification/1.0','Accept-Encoding':'identity'}),timeout=30)as r:return r.read(),r.headers
class Tags(HTMLParser):
    def __init__(self):super().__init__();self.beacons=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='script'and str(a.get('src','')).startswith('https://static.cloudflareinsights.com/beacon.min.js/'):
            assert len(attrs)==len(a),'duplicate attribute'
            self.beacons.append((self.get_starttag_text(),a))
def normalize(body,headers,beacon):
    ns=set(re.findall(r"'nonce-([A-Za-z0-9+/]{22}==)'",headers.get('Content-Security-Policy','')))
    assert len(ns)==1
    nonce=next(iter(ns));assert len(base64.b64decode(nonce,validate=True))==16
    attrs=re.findall(rb'nonce="([^"]+)"',body)
    assert attrs and len(attrs)<=8 and set(attrs)=={nonce.encode()},'nonce not authorized by response CSP'
    body=body.replace(b'nonce="'+nonce.encode()+b'"',b'nonce="__VERIFIED_CSP_NONCE__"')
    p=Tags();p.feed(body.decode());assert len(p.beacons)==(1 if beacon else 0)
    integrity=None
    if beacon:
        raw,a=p.beacons[0]
        assert set(a)=={'crossorigin','data-cf-beacon','integrity','nonce','src','type'}
        assert a['src']==SRC and a['type']=='module'and a['crossorigin']=='anonymous'and a['nonce']=='__VERIFIED_CSP_NONCE__'
        assert hashlib.sha256(a['integrity'].encode()).hexdigest()==INTEGRITY_SHA256
        config=json.loads(a['data-cf-beacon'])
        assert set(config)=={'r','spa','token','version'}and config['version']=='2024.11.0'
        assert type(config['r'])is int and config['r']==1 and type(config['spa'])is int and config['spa']==2
        assert re.fullmatch('[0-9a-f]{32}',config['token'])
        assert hashlib.sha256(config['token'].encode()).hexdigest()==TOKEN_SHA256,'unreviewed beacon token'
        full=(raw+'</script>\n').encode();assert body.count(full)==1
        pos=body.index(full);assert body[pos+len(full):].startswith(b'</body>'),'unexpected injection position'
        body=body[:pos]+body[pos+len(full):];integrity=a['integrity']
    return body,integrity
origin,oh=fetch('http://127.0.0.1:8080/video-studio');public,ph=fetch('https://laifufu.top/video-studio')
o,_=normalize(origin,oh,False);p,sri=normalize(public,ph,True)
assert p==o,'unexplained HTML bytes remain'
cdn,_=fetch(SRC);assert sri=='sha512-'+base64.b64encode(hashlib.sha512(cdn).digest()).decode(),'beacon SRI content mismatch'
parser=Tags();parser.feed(public.decode());raw,attrs=parser.beacons[0];full=(raw+'</script>\n').encode()
mutations={
 'changed_asset':public.replace(b'/assets/index-',b'/assets/wrong-',1),
 'unknown_script':public.replace(b'</body>',b'<script src="https://invalid.example/unreviewed.js"></script></body>',1),
 'duplicate_beacon':public.replace(full,full+full,1),
 'different_beacon_version':public.replace(SRC.encode(),(SRC+'x').encode(),1),
 'wrong_integrity':public.replace(attrs['integrity'].encode(),b'sha512-invalid',1),
 'changed_beacon_token':public.replace(json.loads(attrs['data-cf-beacon'])['token'].encode(),b'0'*32,1),
 'extra_whitespace':public.replace(b'</body>',b'\n</body>',1),
 'wrong_nonce':public.replace(b'nonce="',b'nonce="invalid',1)}
rejected=[]
for name,value in mutations.items():
    assert value!=public,'counterexample not applied'
    try:result,_=normalize(value,ph,True);bad=result!=o
    except (AssertionError,ValueError,TypeError):bad=True
    assert bad,'invalid HTML accepted: '+name
    rejected.append(name)
print(json.dumps({'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'PASS','path':'/video-studio','normal_url':True,
 'scope':'all HTML bytes after response-bound 16-byte CSP nonce and one exact pinned end-of-body RUM script plus one LF; static JS/CSS checked independently',
 'normalized_sha256':hashlib.sha256(o).hexdigest(),'beacon_src':SRC,'beacon_sri_content_verified':True,'beacon_integrity_sha256':INTEGRITY_SHA256,
 'beacon_token_sha256':TOKEN_SHA256,'counterexamples_rejected':rejected,'server_or_proxy_modified':False,
 'official_basis':'https://developers.cloudflare.com/speed/observatory/rum-beacon/'}))
