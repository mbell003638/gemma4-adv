/**
 * Production JVM regressions. Uses installed dependencies only: no downloads,
 * Android stubs, model weights, or JNI inference. Invoke only when authorized.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function checkProduction(mode) {
  if (!['native', 'host', 'downloads'].includes(mode)) throw new Error('Unknown check mode');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const build = path.join(root, 'spikes/gemma4/build');
  fs.mkdirSync(build, { recursive: true });
  // Invalidate every replaced legacy report BEFORE environment/dependency checks.
  // Any failed invocation therefore leaves no old native/host/download success.
  for (const name of ['native-check.json', 'host-check.json', 'download-check.json']) {
    const previous = path.join(build, name);
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
  }
  const reportPath = path.join(build, mode === 'downloads' ? 'download-check.json' : mode + '-check.json');
  if (!fs.existsSync(path.join(root, 'ISOLATION.md'))) throw new Error('Expected an isolated Gemma lab');
  const jdk = process.env.GEMMA_JDK;
  if (!jdk) throw new Error('Set GEMMA_JDK to an installed JDK; no tools are downloaded');
  const local = path.join(root, '.local-tools');
  const p = name => path.join(local, name);
  const compilerFiles = [
    'kotlin-compiler-embeddable-2.4.0.jar', 'kotlin-build-tools-api-2.4.0.jar',
    'kotlin-stdlib-2.4.0.jar', 'kotlin-script-runtime-2.4.0.jar',
    'kotlin-daemon-embeddable-2.4.0.jar', 'kotlin-reflect-1.6.10.jar',
    'kotlinx-coroutines-core-jvm-1.8.0.jar', 'annotations-13.0.jar',
  ].map(p);
  const host = mode !== 'downloads';
  const runtime = ['kotlin-stdlib-2.4.0.jar', 'annotations-13.0.jar'].map(p);
  if (host) {
    const json = ['json-20250107.jar', 'json-20240303.jar'].map(p)
      .find(file => fs.existsSync(file) && fs.statSync(file).size > 0);
    if (!json) throw new Error('Missing installed org.json JAR (20250107 or 20240303)');
    runtime.push(p('sdk/classes.jar'), p('kotlin-reflect-2.4.0.jar'),
      p('kotlinx-coroutines-core-jvm-1.11.0.jar'), p('kotlinx-coroutines-android-1.11.0.jar'),
      p('gson-2.14.0.jar'), json);
  }
  const production = path.join(root,
    'frontend/modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai');
  const productionSources = ['GemmaPackStore.kt', 'GemmaLifecycle.kt'];
  if (host) productionSources.push('GemmaRuntime.kt', 'GemmaSessionHost.kt',
    'GemmaAttachmentStore.kt', 'GemmaCatalogAsset.kt');
  const tests = ['ProductionFixtures.kt', 'ProductionLifecycleContractCheck.kt'];
  if (mode !== 'host') tests.push('ProductionPackContractCheck.kt');
  if (host) tests.push('ProductionHostContractCheck.kt');
  const sources = [
    ...productionSources.map(name => path.join(production, name)),
    ...tests.map(name => path.join(root, 'spikes/gemma4/tests', name)),
  ];
  // Shared guards compile the shipped catalog/attachment/host, not prototype copies.
  if (host) sources.push(path.join(root, 'spikes/gemma4/tests/NativeContractCheck.kt'));
  const mains = ['ProductionLifecycleContractCheckKt'];
  if (mode !== 'host') mains.push('ProductionPackContractCheckKt');
  if (host) mains.push('ProductionHostContractCheckKt');
  const java = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  for (const file of [java, ...compilerFiles, ...runtime, ...sources]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error('Missing installed dependency/source: ' + file);
    }
  }
  const fingerprint = file => ({
    path: fs.realpathSync(file),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const sourceEvidence = sources.map(fingerprint);
  const dependencies = [...new Set([...compilerFiles, ...runtime])].map(fingerprint);
  // Fresh directory prevents stale .class files satisfying removed dependencies.
  const output = fs.mkdtempSync(path.join(build, 'production-' + mode + '-'));
  const run = args => {
    const result = spawnSync(java, args, { cwd: root, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Production JVM check failed: ' + (result.signal || result.status));
  };
  run(['-cp', compilerFiles.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-classpath', runtime.join(path.delimiter), '-d', output, ...sources]);
  for (const main of mains) {
    run(['-cp', [output, ...runtime].join(path.delimiter), 'ledgr.gemma.productionchecks.' + main]);
  }
  if (host) run(['-cp', [output, ...runtime].join(path.delimiter), 'ledgr.gemma.spike.NativeContractCheckKt']);
  // Do not attach a passing run to source edits made during compilation/execution.
  const unchanged = (files, evidence) => files.every((file, i) =>
    fingerprint(file).sha256 === evidence[i].sha256);
  if (!unchanged(sources, sourceEvidence) ||
      !unchanged([...new Set([...compilerFiles, ...runtime])], dependencies)) {
    throw new Error('Sources or dependencies changed during the check; report withheld');
  }
  fs.writeFileSync(reportPath, JSON.stringify({
    checkedAt: new Date().toISOString(), scope: 'production JVM regressions', mode,
    compilation: 'passed', contractChecks: 'passed', kotlinCompiler: '2.4.0',
    sdk: host ? 'real LiteRT-LM 0.17.0 classes.jar' : 'not needed',
    sources: sourceEvidence, dependencies,
    executedDrivers: [...mains, ...(host ? ['ledgr.gemma.spike.NativeContractCheckKt'] : [])], classes: output,
    transport: 'injected synthetic HTTPS connection; no network',
    runtime: host ? 'fake engine behind shipped runtime interface; real SDK value types' : 'no engine',
    jsonImplementation: host ? 'Maven org.json; Android implementation still requires Gradle/device acceptance' : 'not needed',
    bridgeModuleCompiled: 'not-run', gradleBuild: 'not-run', androidRuntime: 'not-run',
    jniInference: 'not-run', physicalDevice: 'not-run', guardMutationAcceptance: 'not-run',
  }, null, 2) + '\n');
  console.log('Production JVM checks passed. Android/Expo compilation and device acceptance remain separate.');
}
