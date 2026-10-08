"""Audit only immutable image layers, never test containers or runtime mounts."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

APP = 'e49b7e0a04682dcd89637c4825c7f9e514964587'
SECRET_PATTERNS = (
    rb'GOCSPX-[A-Za-z0-9_-]{20,}', rb'gh[pousr]_[A-Za-z0-9]{30,}',
    rb'github_pat_[A-Za-z0-9_]{30,}', rb'(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])',
    rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{40,}',
)


def check_bytes(value):
    if any(re.search(pattern, value) for pattern in SECRET_PATTERNS):
        raise ValueError('credential_signature_detected')


def check_path(name):
    parts = PurePosixPath(name).parts
    if '..' in parts or any(p in {'.git', '.evidence', '.ssh', '.aws'} for p in parts):
        raise ValueError('private_or_unsafe_path')
    base = parts[-1] if parts else ''
    if base == '.env' or (base.startswith('.env.') and base != '.env.example'):
        raise ValueError('runtime_environment_file')
    if base in {'id_rsa', 'id_ed25519', 'config.local.yaml', '.installed'}:
        raise ValueError('private_configuration_file')
    if re.search(r'\.(?:sqlite3?|db|dump|p12|pfx|log)$', base, re.I):
        raise ValueError('runtime_or_private_file')
    if name.startswith(('app/data/', 'state/', 'root/.docker/')):
        raise ValueError('runtime_data_in_image')


def source_path(component, name):
    if not name.startswith('app/'):
        return None
    if component == 'core':
        if name == 'app/sub2api':
            return None
        if name == 'app/docker-entrypoint.sh':
            return 'deploy/docker-entrypoint.sh'
        if name.startswith('app/resources/'):
            return 'backend/resources/' + name.removeprefix('app/resources/')
    if component == 'bridge' and name == 'app/studio-bridge':
        return None
    if component == 'bff' and name.startswith(('app/studio/', 'app/backend/', 'app/deploy/')):
        return name.removeprefix('app/')
    raise ValueError('unexpected_application_file')


def docker(*args):
    return subprocess.run(['docker', *args], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=120).stdout


def main():
    if not (os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('GITHUB_REPOSITORY') == 'maximeblen654-boop/AI-Gateway-public'
            and os.environ.get('APPLICATION_SHA') == APP):
        raise ValueError('hosted_public_context_required')
    source = Path(os.environ['GITHUB_WORKSPACE']) / 'application'
    out = Path(os.environ['RUNNER_TEMP']) / 'phase5-candidate'
    report = {'status': 'NOT_RUN', 'application_sha': APP, 'images': [],
              'scope': 'all immutable OCI layers, config, history; no container export/commit'}
    try:
        built = json.loads((out / 'report.json').read_text())
        if built['build'] != 'BUILD_PASS':
            raise ValueError('build_not_complete')
        for image in built['images']:
            component = image['component']
            report['last_component'] = component
            record = {'component': component, 'image_id': image['docker_image_id'],
                      'layers': 0, 'files_scanned': 0, 'application_files_matched': 0}
            notices = set()
            with tarfile.open(out / f'{component}.oci.tar') as archive:
                def blob(digest):
                    return archive.extractfile('blobs/sha256/' + digest.split(':')[1])
                manifest = json.load(blob(image['oci_manifest_digest']))
                config = json.load(blob(manifest['config']['digest']))
                check_bytes(json.dumps(config).encode())
                labels = config['config'].get('Labels', {})
                if (labels.get('org.opencontainers.image.revision') != APP or
                    labels.get('org.opencontainers.image.source') != 'https://github.com/maximeblen654-boop/AI-Gateway-public' or
                    labels.get('io.ai-gateway.candidate.workflow-sha') != os.environ['CANDIDATE_WORKFLOW_SHA']):
                    raise ValueError('source_or_workflow_label_mismatch')
                env = config['config'].get('Env', [])
                allowed_env = {'PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV', 'STUDIO_IMAGE_BFF_PORT'}
                if any(item.split('=', 1)[0] not in allowed_env for item in env):
                    raise ValueError('unexpected_baked_environment')
                record['environment_names'] = [item.split('=', 1)[0] for item in env]
                record['labels'] = labels
                for descriptor in manifest['layers']:
                    report['last_layer'] = descriptor['digest']
                    record['layers'] += 1
                    with tarfile.open(fileobj=blob(descriptor['digest']), mode='r|*') as layer:
                        for member in layer:
                            if not member.isfile():
                                continue
                            name = member.name.removeprefix('./').lstrip('/')
                            report['last_path_sha256'] = hashlib.sha256(name.encode()).hexdigest()
                            check_path(name)
                            expected = source_path(component, name)
                            digest = hashlib.sha256()
                            stream = layer.extractfile(member)
                            tail = b''
                            while chunk := stream.read(1024 * 1024):
                                check_bytes(tail + chunk)
                                digest.update(chunk)
                                tail = chunk[-256:]
                            record['files_scanned'] += 1
                            if expected:
                                original = source / expected
                                if not original.is_file() or hashlib.sha256(original.read_bytes()).hexdigest() != digest.hexdigest():
                                    raise ValueError('application_file_not_from_frozen_source')
                                record['application_files_matched'] += 1
                            if name.startswith('usr/share/licenses/ai-gateway-candidate/'):
                                notice = name.rsplit('/', 1)[-1]
                                if hashlib.sha256((out / 'notices' / notice).read_bytes()).hexdigest() != digest.hexdigest():
                                    raise ValueError('notice_bytes_mismatch')
                                notices.add(notice)
            if not {'COPYING', 'COPYING.LESSER', 'SOURCE-README.md', 'NOTICE.txt'} <= notices:
                raise ValueError('distribution_notices_missing')
            ref = image['docker_image_id']
            apk = docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', ref, '/lib/apk/db/installed')
            record['apk_metadata_sha256'] = hashlib.sha256(apk).hexdigest()
            record['apk_licenses'] = sorted(set(re.findall(r'^L:(.+)$', apk.decode(), re.M)))
            if component == 'bff':
                version = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'ffmpeg', ref, '-version'],
                                         check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30).stdout
                if b'--enable-nonfree' in version:
                    raise ValueError('ffmpeg_nonredistributable_configuration')
                record['ffmpeg_build_sha256'] = hashlib.sha256(version).hexdigest()
                record['ffmpeg_nonfree'] = False
            record['status'] = 'PASS'
            report['images'].append(record)
        report['status'] = 'PASS'
    except Exception as error:
        report['status'] = 'FAIL'
        # Never emit the matched contents, raw subprocess stderr or credentials.
        report['error_category'] = str(error) if isinstance(error, ValueError) else type(error).__name__
        raise
    finally:
        (out / 'audit.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('candidate_distribution_audit_failed; see redacted report category')
