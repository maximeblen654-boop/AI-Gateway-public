// Re-accept the already exported workspace combination; never build/save images.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_REPOSITORY, 'maximeblen654-boop/AI-Gateway-public')
const adminCandidate = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'admin-media-candidate-artifact'
assert.equal(process.env.GITHUB_REF, adminCandidate ? 'refs/heads/codex/admin-media-design-review' : 'refs/heads/codex/studio-native-media')
assert.equal(process.env.NATIVE_CANDIDATE_SOURCE_SHA, adminCandidate ? '15d09689abc0b7e07269692d50e78f83859d1fb6' : '40310e2961a5e8150e0c9df4cc86bb8087406c06')
const directory = path.resolve(process.argv[2])
const output = path.join(process.env.RUNNER_TEMP, 'native-existing-acceptance-output')
const candidateOutput = path.join(process.env.RUNNER_TEMP, 'native-candidate-output')
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(candidateOutput, { recursive: true })
const hash = async file => {
  const h = createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) h.update(bytes)
  return h.digest('hex')
}
const originalManifest = path.join(directory, 'manifest.json')
assert.equal(await hash(originalManifest), adminCandidate ? '53e06af51dd95b93141f38b4a2c47285d1202d7a40c85c87a2722aaa63f371d1' : '139b8c71ced5522399576d30222fc69e4ca409ddc4bba2872e28fcf0a32b030d')
const manifest = JSON.parse(fs.readFileSync(originalManifest, 'utf8'))
assert.equal(manifest.source_sha, process.env.NATIVE_CANDIDATE_SOURCE_SHA)
assert.deepEqual(manifest.images.map(i => i.component).sort(), ['bff', 'bridge', 'core'])
for (const entry of manifest.images) {
  assert.equal(path.basename(entry.tar), entry.tar)
  const file = path.join(directory, entry.tar)
  assert.equal(await hash(file), entry.sha256)
  execFileSync('docker', ['load', '-i', file], { stdio: 'inherit' })
  const loaded = JSON.parse(execFileSync('docker', ['image', 'inspect', entry.tag], { encoding: 'utf8' }))[0]
  assert.equal(loaded.Id, entry.image_id)
  assert.equal(`${loaded.Os}/${loaded.Architecture}`, entry.platform)
  assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'], entry.source_sha)
  const archiveIdentity = JSON.parse(execFileSync('python3', ['tools/native-media-e2e/archive-identity.py', file, entry.image_id], { encoding: 'utf8' }))
  assert.deepEqual(archiveIdentity, entry.archive_identity)
}
fs.copyFileSync(originalManifest, path.join(output, 'original-build-manifest.json'))
for (const name of ['reuse-proof.json', 'core-build-metadata.json']) fs.copyFileSync(path.join(directory, name), path.join(output, name))
let passed = false
try {
  execFileSync(process.execPath, ['tools/native-media-e2e/candidate.mjs', 'verify'], { stdio: 'inherit', env: { ...process.env, NATIVE_ACCEPTANCE_SCENARIO: adminCandidate ? 'admin-ui-review' : 'studio-workspace', NATIVE_EXPORT_CANDIDATE: adminCandidate ? 'true' : 'false' } })
  if (adminCandidate) execFileSync(process.execPath, ['tools/native-media-e2e/check-admin-review.mjs', candidateOutput], { stdio: 'inherit' })
  passed = true
} finally {
  for (const name of fs.readdirSync(candidateOutput).filter(n => /\.(json|png)$/.test(n))) fs.copyFileSync(path.join(candidateOutput, name), path.join(output, name))
  manifest.original_build_manifest_sha256 = await hash(originalManifest)
  manifest.original_build_run = adminCandidate ? 38539809920 : 38477125329
  manifest.original_build_artifact = adminCandidate ? 11882680877 : 11857055200
  manifest.acceptance = passed ? 'PASS' : 'NOT_PASSED'
  manifest.acceptance_script_sha = process.env.GITHUB_SHA
  manifest.acceptance_run = process.env.GITHUB_RUN_ID
  manifest.acceptance_run_id = process.env.GITHUB_RUN_ID
  manifest.deployment_state = passed ? 'CANDIDATE_READY_NOT_DEPLOYED' : 'CANDIDATE_NOT_ACCEPTED'
  const core = manifest.images.find(i => i.component === 'core')
  if (adminCandidate) core.artifact.id = '11882680877'
  manifest.images_rebuilt_or_reexported = false
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
}
