import fs from 'fs';
import path from 'path';
import { parseExternalIntent } from '../src/utils/externalIntent';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Android native AI integration', () => {
  it('registers speech and OCR Expo modules with the ML Kit dependency', () => {
    const config = JSON.parse(read('modules/ledgr-native-ai/expo-module.config.json'));
    expect(config.android.modules).toEqual(expect.arrayContaining([
      'expo.modules.ledgrnativeai.LedgrSpeechRecognizerModule',
      'expo.modules.ledgrnativeai.LedgrLocalOcrModule',
      'expo.modules.ledgrnativeai.LedgrOnDeviceLlmModule',
      'expo.modules.ledgrnativeai.LedgrTtsModule',
    ]));
    expect(read('modules/ledgr-native-ai/android/build.gradle')).toContain("com.google.mlkit:text-recognition");
    expect(read('modules/ledgr-native-ai/android/build.gradle')).toContain('ndkVersion rootProject.ext.ndkVersion');
    expect(read('scripts/on-device-ai/fetch-native.mjs')).toContain('shell: false');
    const speechModule = read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrSpeechRecognizerModule.kt');
    expect(speechModule).toContain('SpeechRecognizer.createSpeechRecognizer');
    expect(speechModule).toContain('this@LedgrSpeechRecognizerModule');
    expect(speechModule).not.toContain('setRecognitionListener(this)');
    expect(speechModule).not.toContain('\\n');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrLocalOcrModule.kt')).toContain('TextRecognition.getClient');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrLocalOcrModule.kt')).toContain('recognizePdf');
    expect(speechModule).toContain('EXTRA_PREFER_OFFLINE, true');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrTtsModule.kt')).toContain('TextToSpeech');
    const gradle = read('modules/ledgr-native-ai/android/build.gradle');
    expect(gradle).toContain('ledgrGemmaEnabled');
    expect(gradle).toContain("src/legacy/java");
    expect(gradle).toContain("src/gemma/java");
    // Manus keeps its proven MediaPipe/Needle host as the default source set;
    // the LiteRT-LM host is a distinct opt-in build, never two duplicate classes.
    expect(read('modules/ledgr-native-ai/android/src/legacy/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt')).toContain('needle2.cact');
    expect(read('modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt')).toContain('gemmaBegin');
    expect(read('modules/ledgr-native-ai/android/src/main/cpp/needle_jni.cpp')).toContain('needle_complete');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/NeedleJni.kt')).toContain('loadLibrary("needle_jni")');
  });

  it('parses Assistant navigation and draft URLs into review-only intents', () => {
    const plugin = read('plugins/withAndroidAssistant.js');
    expect(plugin).toContain('withStringsXml');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_ask_ai"');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_voice_assistant"');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_scan_receipt"');
    expect(plugin).not.toMatch(/android:shortcutShortLabel="(?!@string\/)/);
    expect(parseExternalIntent('ledgr://assistant?action=open_voice')).toEqual({ target: 'voice', source: 'assistant' });
    expect(parseExternalIntent('ledgr://assistant?action=record_payment&amount=100&counterparty=Amit')).toMatchObject({
      target: 'draft', action: 'payment', amount: 100, party: 'Amit', source: 'assistant',
    });
  });

  it('persists OCR mode and routes image URIs through local OCR', () => {
    const api = read('src/api.ts');
    const scan = read('app/scan-import.tsx');
    expect(api).toContain("AI_OCR_PROVIDER_KEY = 'ai_ocr_provider'");
    expect(api).toContain('recognizeLocalOcr(input.uri)');
    expect(scan).toContain('uri: asset.uri');
  });

  it('keeps Kotlin 2.4 opt-in and reproducible across Expo prebuilds', () => {
    const appConfig = JSON.parse(read('app.json'));
    expect(appConfig.expo.plugins).toContain('./plugins/withGemmaAndroidToolchain');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require('../plugins/withGemmaAndroidToolchain');
    const projectInput = "dependencies {\n    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\n}";
    const settingsInput = 'expoAutolinking.useExpoVersionCatalog()';
    const projectOutput = plugin.patchProjectBuildGradle(projectInput);
    const settingsOutput = plugin.patchSettingsGradle(settingsInput);

    expect(projectOutput).toContain("projectProperties.get('ledgrGemmaEnabled') == 'true'");
    expect(projectOutput).toContain("kotlin-gradle-plugin:2.4.0");
    expect(projectOutput).toContain("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')");
    expect(settingsOutput).toContain("version('kotlin', '2.4.0')");
    expect(settingsOutput).toContain("version('ksp', '2.3.10')");
    expect(plugin.patchProjectBuildGradle(projectOutput)).toBe(projectOutput);
    expect(plugin.patchSettingsGradle(settingsOutput)).toBe(settingsOutput);
  });
});

