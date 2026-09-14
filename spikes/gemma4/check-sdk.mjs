import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const local = path.join(root, '.local-tools');
const output = path.join(root, 'spikes/gemma4/build');
const javaRoot = process.env.GEMMA_JDK;
if (!javaRoot) throw new Error('Set GEMMA_JDK to a JDK (not a JRE); JAVA_HOME is not changed.');
if (!fs.existsSync(path.join(root, 'ISOLATION.md'))) throw new Error('Run only inside an isolated Gemma lab.');
const exe = name => path.join(javaRoot, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
function run(binary, args, cwd = root) {
  const r = spawnSync(binary, args, { cwd, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(binary)} failed (${r.status})`);
}
fs.mkdirSync(local, { recursive: true });
fs.mkdirSync(output, { recursive: true });
// A failed rerun must not leave a previous successful report looking current.
const reportPath = path.join(output, 'sdk-check.json');
if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
const central = 'https://repo.maven.apache.org/maven2';
const google = 'https://dl.google.com/dl/android/maven2';
const jars = [
  ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.4.0'],
  ['org.jetbrains.kotlin', 'kotlin-build-tools-api', '2.4.0'],
  ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.4.0'],
  ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.4.0'],
  ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.4.0'],
  ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'],
  ['org.jetbrains.kotlin', 'kotlin-reflect', '2.4.0'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.11.0'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-android', '1.11.0'],
  ['org.jetbrains', 'annotations', '13.0'],
  ['com.google.code.gson', 'gson', '2.14.0'],
].map(([group, artifact, version]) => ({
  name: `${artifact}-${version}.jar`,
  url: `${central}/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`,
}));
const aar = {
  name: 'litertlm-android-0.17.0.aar',
  url: `${google}/com/google/ai/edge/litertlm/litertlm-android/0.17.0/litertlm-android-0.17.0.aar`,
};
const allowDownload = process.argv.includes('--download-tools');
for (const artifact of [aar, ...jars]) {
  const target = path.join(local, artifact.name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
  if (!allowDownload) throw new Error(`Missing ${artifact.name}; rerun with --download-tools after approving tool downloads.`);
  console.log(`Fetching build dependency: ${artifact.name}`);
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error(`Artifact unavailable (${response.status}): ${artifact.name}`);
  const temporary = `${target}.download`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  fs.renameSync(temporary, target);
}
const classesDir = path.join(local, 'sdk');
fs.mkdirSync(classesDir, { recursive: true });
run(exe('jar'), ['xf', path.join(local, aar.name), 'classes.jar'], classesDir);
const p = name => path.join(local, name);
const compiler = [
  'kotlin-compiler-embeddable-2.4.0.jar', 'kotlin-build-tools-api-2.4.0.jar',
  'kotlin-stdlib-2.4.0.jar', 'kotlin-script-runtime-2.4.0.jar', 'kotlin-daemon-embeddable-2.4.0.jar',
  'kotlin-reflect-1.6.10.jar', 'kotlinx-coroutines-core-jvm-1.8.0.jar', 'annotations-13.0.jar',
].map(p).join(path.delimiter);
const runtime = [path.join(classesDir, 'classes.jar'), ...[
  'kotlin-stdlib-2.4.0.jar', 'kotlin-reflect-2.4.0.jar', 'kotlinx-coroutines-core-jvm-1.11.0.jar',
  'kotlinx-coroutines-android-1.11.0.jar', 'gson-2.14.0.jar', 'annotations-13.0.jar',
].map(p)];
const sources = ['LiteRtFeasibility.kt', 'ApiContractCheck.kt'].map(f => path.join(root, 'spikes/gemma4/src', f));
run(exe('java'), ['-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', runtime.join(path.delimiter),
  '-d', output, ...sources]);
run(exe('java'), ['-cp', [output, ...runtime].join(path.delimiter), 'ledgr.gemma.spike.ApiContractCheckKt']);
const fingerprints = [];
for (const artifact of [aar, ...jars]) {
  const target = p(artifact.name);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  fingerprints.push({ name: artifact.name, bytes: fs.statSync(target).size, sha256: hash.digest('hex') });
}
fs.writeFileSync(reportPath, JSON.stringify({
  checkedAt: new Date().toISOString(), sdk: '0.17.0', kotlinCompiler: '2.4.0',
  compilation: 'passed', contractChecks: 'passed', androidBuild: 'not-run', modelInference: 'not-run', artifacts: fingerprints,
}, null, 2));
console.log('Compiled against the real Android SDK classes. Android packaging and device inference remain unverified.');
