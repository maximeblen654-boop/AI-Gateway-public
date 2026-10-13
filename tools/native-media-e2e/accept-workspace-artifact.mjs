// Re-accept the already exported workspace combination; never build/save images.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_REPOSITORY, 'maximeblen654-boop/AI-Gateway-public')
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/studio-native-media')
assert.equal(process.env.NATIVE_CANDIDATE_SOURCE_SHA, '40310e2961a5e8150e0c9df4cc86bb8087406c06')
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
assert.equal(await hash(originalManifest), '139b8c71ced5522399576d30222fc69e4ca409ddc4bba2872e28fcf0a32b030d')
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
  execFileSync(process.execPath, ['tools/native-media-e2e/candidate.mjs', 'verify'], { stdio: 'inherit', env: { ...process.env, NATIVE_ACCEPTANCE_SCENARIO: 'studio-workspace' } })
  passed = true
} finally {
  for (const name of fs.readdirSync(candidateOutput).filter(n => /\.(json|png)$/.test(n))) fs.copyFileSync(path.join(candidateOutput, name), path.join(output, name))
  manifest.original_build_manifest_sha256 = await hash(originalManifest)
  manifest.original_build_run = 38477125329
  manifest.original_build_artifact = 11857055200
  manifest.acceptance = passed ? 'PASS' : 'NOT_PASSED'
  manifest.acceptance_script_sha = process.env.GITHUB_SHA
  manifest.acceptance_run = process.env.GITHUB_RUN_ID
  manifest.images_rebuilt_or_reexported = false
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
}
