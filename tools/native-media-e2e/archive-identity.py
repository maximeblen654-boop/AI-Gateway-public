"""Read exported Docker/OCI metadata; never confuse the manifest and config."""
import hashlib
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    def read(name):
        return archive.extractfile(name).read()
    manifest = json.loads(read('manifest.json'))
    assert len(manifest) == 1
    entry = manifest[0]
    config = read(entry['Config'])
    config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
    assert config_digest == sys.argv[2], (config_digest, sys.argv[2])
    result = {'config_digest': config_digest, 'config_file': entry['Config'], 'repo_tags': entry.get('RepoTags', []), 'oci_manifests': []}
    if 'index.json' in archive.getnames():
        def visit(descriptor):
            digest = descriptor['digest']
            raw = read('blobs/' + digest.replace(':', '/'))
            assert 'sha256:' + hashlib.sha256(raw).hexdigest() == digest
            value = json.loads(raw)
            for child in value.get('manifests', []):
                visit(child)
            if value.get('config', {}).get('digest') == config_digest:
                result['oci_manifests'].append({'manifest_digest': digest, 'config_digest': config_digest})
        for descriptor in json.loads(read('index.json'))['manifests']:
            visit(descriptor)
    result['format'] = 'OCI plus Docker archive' if result['oci_manifests'] else 'Docker save archive (no OCI manifest claimed)'
    print(json.dumps(result))
