/* eslint-disable @typescript-eslint/no-require-imports */
function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

type NativeTts = {
  isAvailable?: () => Promise<boolean> | boolean;
  speak?: (text: string) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  setLocale?: (languageTag: string) => Promise<boolean> | boolean;
  openVoiceDataInstaller?: () => Promise<void> | void;
};

function nativeModule(): NativeTts | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== 'android') return null;
  try {
    return require('expo-modules-core').requireOptionalNativeModule('LedgrTts')
      || (NativeModules as any).LedgrTts
      || null;
  } catch { return (NativeModules as any).LedgrTts || null; }
}

export async function getDeviceTtsStatus(): Promise<{ supported: boolean; available: boolean; reason?: string }> {
  const { Platform } = nativeRuntime();
  const module = nativeModule();
  if (!module) {
    return {
      supported: Platform.OS === 'android',
      available: false,
      reason: Platform.OS === 'android'
        ? 'Phone speaker is available in a native Android build.'
        : 'Spoken answers use the Android phone speaker.',
    };
  }
  try {
    const available = module.isAvailable ? await module.isAvailable() : true;
    return { supported: true, available, reason: available ? undefined : 'No text-to-speech voice is installed on this phone.' };
  } catch {
    return { supported: true, available: false, reason: 'Could not query the phone speaker.' };
  }
}

export async function speakOnDevice(text: string): Promise<void> {
  const spoken = text.replace(/\s+/g, ' ').trim();
  if (!spoken) return;
  const module = nativeModule();
  if (!module?.speak) return;
  await module.speak(spoken);
}

export async function stopOnDeviceSpeech(): Promise<void> {
  const module = nativeModule();
  if (module?.stop) await module.stop();
}

export async function setDeviceTtsLocale(languageTag: string): Promise<boolean> {
  const module = nativeModule();
  return module?.setLocale ? Boolean(await module.setLocale(languageTag)) : false;
}

export async function openDeviceTtsVoiceInstaller(): Promise<void> {
  const module = nativeModule();
  if (module?.openVoiceDataInstaller) await module.openVoiceDataInstaller();
}
