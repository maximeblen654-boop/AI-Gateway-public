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

    def test_only_exact_frozen_application_paths_are_accepted(self):
        self.assertEqual(audit.source_path('bff', 'app/studio/bff/image-server.mjs'), 'studio/bff/image-server.mjs')
        self.assertEqual(audit.source_path('core', 'app/resources/config.example.yaml'), 'backend/resources/config.example.yaml')
        for component in ['core', 'bridge', 'bff']:
            with self.assertRaises(ValueError):
                audit.source_path(component, 'app/private/account.json')


if __name__ == '__main__':
    unittest.main()
