import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('candidate_audit', Path(__file__).with_name('audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class DistributionAuditTests(unittest.TestCase):
    def test_reject_runtime_files_without_banning_public_source_examples(self):
        for name in ['app/.evidence/result.json', 'app/.env', 'app/.env.production',
                     'root/.ssh/id_rsa', 'app/data/task.json', 'state/assets/one.png',
                     'app/db.sqlite', '../elsewhere']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit.check_path(name)
        for name in ['app/studio/.env.example', 'lib/apk/db/installed', 'app/studio/bff/receipt.mjs']:
            audit.check_path(name)

    def test_secret_values_block_without_logging_them(self):
        for value in [b'ghp_' + b'A' * 40, b'GOCSPX-' + b'B' * 25,
                      b'-----BEGIN PRIVATE KEY-----\n' + b'C' * 80]:
            with self.assertRaisesRegex(ValueError, '^credential_signature_detected$'):
                audit.check_bytes(value)
        audit.check_bytes(b'GITHUB_TOKEN is passed only to a publishing step, not baked into images')

    def test_aws_ids_require_complete_tokens_not_substrings_of_binary_string_tables(self):
        value = b'AKIA' + b'A' * 16
        for surrounding in [value, b'key="' + value + b'"', b'\x00' + value + b'\x00']:
            with self.assertRaisesRegex(ValueError, '^credential_signature_detected$'):
                audit.check_bytes(surrounding)
        for surrounding in [b'PREFIX' + value + b'SUFFIX', value + b'B', b'_' + value]:
            audit.check_bytes(surrounding)

    def test_only_exact_frozen_application_paths_are_accepted(self):
        self.assertEqual(audit.source_path('bff', 'app/studio/bff/image-server.mjs'), 'studio/bff/image-server.mjs')
        self.assertEqual(audit.source_path('core', 'app/resources/config.example.yaml'), 'backend/resources/config.example.yaml')
        for component in ['core', 'bridge', 'bff']:
            with self.assertRaises(ValueError):
                audit.source_path(component, 'app/private/account.json')

    def test_alpine_build_journal_requires_known_commands_and_package_only_records(self):
        journal = (b'\nRunning `apk add --no-cache ffmpeg=8.0.1-r1 ca-certificates` at 2026-01-01 00:00:00\n'
                   b'apk-tools 3.0.8-r0, compiled for x86_64.\n'
                   b'( 1/10) Installing libgcc (15.2.0-r2)\n'
                   b'( 2/10) Upgrading ca-certificates (1-r0 -> 1-r1)\n'
                   b'Executing busybox-1.37.0-r30.trigger\nOK: 10.8 MiB in 18 packages\n')
        audit.check_path('var/log/apk.log', journal)
        for value in [journal + b'customer=private-data\n',
                      journal.replace(b'ffmpeg=8.0.1-r1 ca-certificates', b'private-package'),
                      b'x' * 65537, journal + b'ghp_' + b'A' * 40]:
            with self.subTest(value_size=len(value)), self.assertRaises(ValueError):
                audit.check_path('var/log/apk.log', value)
        for name in ['app/apk.log', 'var/log/service.log', 'var/log/apk.log']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit.check_path(name)


if __name__ == '__main__':
    unittest.main()
