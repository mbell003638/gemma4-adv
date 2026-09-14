import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";

import { useTheme, useThemeMode, useAnimations } from "@/src/context/ThemeContext";
import { useOnboardingGate } from "@/src/context/OnboardingContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { askHistoryStorageKey } from "@/src/utils/askHistory";
import { DEFAULT_ENTRY_HELP_ORDER, PROVIDERS, type EntryHelpOrder, type InterpretationProvider, type ProviderId, type VoiceProvider } from "@/src/db/ai";
import { ScreenHeader, Card } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";
import { saveJsonFile, shareJsonFile, pickJsonFile } from "@/src/utils/share";
import { deviceHasLock, requireAuth } from "@/src/utils/lock";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";
import { isValidDateString, normalizeDateInput, localTodayIso } from "@/src/utils/dateValidation";
import { getAICapabilities } from "@/src/db/aiCapabilities";
import { getDeviceSpeechStatus } from "@/src/utils/deviceSpeechRecognizer";
import { getLocalOcrStatus } from "@/src/utils/localOcr";
import { cancelOptionalOnDeviceModelDownload, deleteOptionalOnDeviceModel, downloadOptionalOnDeviceModel, getOnDeviceLlmStatus, getPreferredOnDevicePack, listOptionalOnDeviceModels, resolveOnDevicePacks, setPreferredOnDevicePack } from "@/src/utils/onDeviceLlm";
import { bundledGemmaPacks } from "@/src/accountingV2/gemma/packCatalogV2";
import { discardGemmaPartial, downloadGemmaPack, gemmaPackStatus, pauseGemmaDownload, removeGemmaPack, recoverGemmaRuntime } from "@/src/utils/gemmaNative";

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: "transparent" }}>
      <GlowPressable
        topHighlight={false}
        haptic
        animateBorder
        restingBorderColor="transparent"
        hoverBorderColor={theme.color.brandPrimary}
        pressScale={0.97}
        hoverScale={1.008}
        hoverLift={-2}
        onPress={() => setExpandedKey(isExpanded ? null : title)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 48,
          paddingVertical: 12,
          paddingHorizontal: 0,
          marginHorizontal: 0,
          borderWidth: 0,
          borderRadius: 0,
        }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </GlowPressable>
      {isExpanded && <View style={{ marginHorizontal: 0, marginBottom: 10, paddingHorizontal: 0, paddingVertical: 10, paddingTop: 4, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};

const AdvancedNavRow = ({ title, subtitle, icon, onPress, isLast = false, theme }: any) => (
  <View style={{ borderBottomWidth: isLast ? 0 : 1, borderBottomColor: theme.color.border, paddingBottom: isLast ? 0 : 10, marginBottom: isLast ? 0 : 10 }}>
    <GlowPressable
      topHighlight={false}
      haptic
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      restingBorderColor="transparent"
      hoverBorderColor={theme.color.brandPrimary}
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 8,
        borderWidth: 1,
        borderColor: "transparent",
        borderRadius: theme.radius.md,
        backgroundColor: "transparent",
      }}
    >
      <Ionicons name={icon} size={24} color={theme.color.brandPrimary} style={{ marginRight: 14 }} />
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: theme.color.onSurface }}>{title}</Text>
        <Text style={{ fontSize: 12, lineHeight: 17, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={22} color={theme.color.muted} />
    </GlowPressable>
  </View>
);

export default function AdvancedSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { setAnimationsEnabled } = useAnimations();
  const { requireOnboarding } = useOnboardingGate();
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [key, setKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [visionModelName, setVisionModelName] = useState("");
  const [transcriptionModelName, setTranscriptionModelName] = useState("whisper-1");
  const [transcriptionBaseUrl, setTranscriptionBaseUrl] = useState("");
  const [transcriptionKey, setTranscriptionKey] = useState("");
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("auto");
  const [ocrProvider, setOcrProvider] = useState<"auto" | "android-device" | "cloud">("auto");
  const [interpretationProvider, setInterpretationProvider] = useState<InterpretationProvider>("auto");
  const [entryHelpOrder, setEntryHelpOrder] = useState<EntryHelpOrder>(DEFAULT_ENTRY_HELP_ORDER);
  const [showAdvancedCapture, setShowAdvancedCapture] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [aiDataMode, setAiDataMode] = useState<'summary' | 'detailed'>('summary');
  const [aiRememberHistory, setAiRememberHistory] = useState(false);
  const [customHostConfirmed, setCustomHostConfirmed] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Members = the owners/investors who put in capital and share profit.
  // Each: { name, amount (investment), profitSharePct (optional) }.
  const [members, setMembers] = useState<{ name: string; amount: string; profitSharePct: string }[]>([]);
  const [lockEnabled, setLockEnabled] = useState(false);
  // Books = separate isolated accounts (e.g. Shop, Technician).
  const [books, setBooks] = useState<{ id: string; name: string; businessType?: string }[]>([]);
  const [activeBook, setActiveBookState] = useState("default");
  const [newBookName, setNewBookName] = useState("");
  const [addingBook, setAddingBook] = useState(false);
  const [newBookPersona, setNewBookPersona] = useState<PersonaId>("custom");
  const [loading, setLoading] = useState(true);
  const [accountingBasis, setAccountingBasis] = useState<"cash" | "accrual">("cash");
  const [accountingStyle, setAccountingStyle] = useState<"retail_partnership" | "standard">("standard");
  const [periodMode, setPeriodMode] = useState<"flexible" | "fixed">("flexible");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [selectedPersonas, setSelectedPersonas] = useState<PersonaId[]>(["custom"]);
  const [activePersona, setActivePersona] = useState<PersonaId>("custom");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [speakAnswers, setSpeakAnswers] = useState(false);
  const [needleStatus, setNeedleStatus] = useState("");
  const gbLabel = (bytes?: number) => ((bytes || 0) / (1024 ** 3)).toFixed(1);
  const [optionalModels, setOptionalModels] = useState<Awaited<ReturnType<typeof listOptionalOnDeviceModels>>>([]);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const [downloadHint, setDownloadHint] = useState("");
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  const [phoneRamGb, setPhoneRamGb] = useState<string>("");
  const installedPackBytes = optionalModels.reduce((total, model) => total + (model.installed ? (model.bytesOnDisk || model.bytes || 0) : 0), 0);
  const gemmaCatalog = useMemo(() => bundledGemmaPacks(), []);
  const [gemmaStatus, setGemmaStatus] = useState<Awaited<ReturnType<typeof gemmaPackStatus>> | null>(null);
  const [gemmaBusy, setGemmaBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!gemmaStatus?.managementOperation && !Object.values(gemmaStatus?.packs || {}).some(pack => pack.state === 'verifying')) return;
    let active = true;
    const timer = setInterval(() => {
      void gemmaPackStatus().then(status => { if (active) setGemmaStatus(status); }).catch(() => undefined);
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [gemmaStatus]);
  const params = useLocalSearchParams<{ section?: string }>();

  const chooseProvider = (nextProvider: ProviderId) => {
    const meta = PROVIDERS.find((item) => item.id === nextProvider)!;
    setProvider(nextProvider);
    setModelName(meta.defaultModel);
    setBaseUrl(meta.defaultBaseUrl);
    setCustomHostConfirmed(nextProvider === 'gemini' || (meta.defaultBaseUrl.length > 0 && !transcriptionBaseUrl.trim()));
    setTestResult(null);
  };

  const updateAccountingStyle = async (style: "retail_partnership" | "standard") => {
    setAccountingStyle(style);
    try {
      const v2 = await api.getV2BookConfig();
      if (v2) {
        await api.updateV2BookConfig({
          style,
          basis: v2.basis,
          periodPolicy: v2.periodPolicy,
          selectedPersonas: v2.selectedPersonas,
          activePersona: v2.activePersona,
          retailPartnership: {
            ...v2.retailPartnership,
            enabled: style === "retail_partnership",
          },
        });
      }
    } catch (error: any) {
      setStatus({ ok: false, msg: error?.message || "Could not update Accounting Style." });
    }
  };

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      const cfg = await getAIConfig();
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setVisionModelName(cfg.visionModel || "");
      setTranscriptionModelName(cfg.transcriptionModel || "whisper-1");
      setTranscriptionBaseUrl(cfg.transcriptionBaseUrl || "");
      setTranscriptionKey(cfg.transcriptionApiKey || "");
      setVoiceProvider(cfg.voiceProvider || "auto");
      setOcrProvider(cfg.ocrProvider || "auto");
      setInterpretationProvider(cfg.interpretationProvider || "auto");
      setEntryHelpOrder(cfg.entryHelpOrder || DEFAULT_ENTRY_HELP_ORDER);
      const [speak, needle, models, pinned] = await Promise.all([
        api.getSpeakAnswers(),
        getOnDeviceLlmStatus().catch(() => null),
        listOptionalOnDeviceModels().catch(() => []),
        getPreferredOnDevicePack().catch(() => null),
      ]);
      setSpeakAnswers(speak);
      setPreferredModel(pinned);
      // Shown alongside a pack's memory requirement so "not enough RAM" can be
      // checked rather than just asserted.
      setPhoneRamGb(needle?.totalRamBytes ? ((needle.totalRamBytes) / (1024 ** 3)).toFixed(1) : "");
      setNeedleStatus(needle?.needleAvailable ? "Needle 2 is ready on this phone." : (needle?.reason || "Needle ships in the native APK after the Cactus engine is vendored."));
      setOptionalModels(models);
      setGemmaStatus(await gemmaPackStatus().catch(() => null));
      setBaseUrl(cfg.baseUrl || "");
      setAiDataMode(s.aiDataMode === 'detailed' ? 'detailed' : 'summary');
      setAiRememberHistory(s.aiRememberHistory === true);
      const providerMeta = PROVIDERS.find((item) => item.id === cfg.provider);
      const chatBaseUrl = cfg.baseUrl?.trim() || '';
      const defaultChatBaseUrl = providerMeta?.defaultBaseUrl?.replace(/\/+$/, '') || '';
      const hasCustomChatHost = Boolean(chatBaseUrl) && chatBaseUrl.replace(/\/+$/, '') !== defaultChatBaseUrl;
      const hasCustomVoiceHost = Boolean(cfg.transcriptionBaseUrl?.trim());
      setCustomHostConfirmed(cfg.provider === 'gemini' || (!hasCustomChatHost && !hasCustomVoiceHost) || s.aiCustomHostConfirmed === true);
      setAccountingBasis(s.accountingBasis === "accrual" ? "accrual" : "cash");
      const configuredPersonas: PersonaId[] = Array.isArray(s.selectedPersonas) && s.selectedPersonas.length ? s.selectedPersonas as PersonaId[] : ["custom"];
      setSelectedPersonas(configuredPersonas);
      setActivePersona((s.activePersona as PersonaId) || configuredPersonas[0]);
      try {
        const v2 = await api.getV2BookConfig();
        if (v2) {
          setAccountingStyle(v2.style === "retail_partnership" ? "retail_partnership" : "standard");
          setAccountingBasis(v2.basis);
          setPeriodMode(v2.periodPolicy?.mode === "fixed" ? "fixed" : "flexible");
          setPeriodStart(v2.periodPolicy?.startDate || "");
          setPeriodEnd(v2.periodPolicy?.endDate || "");
          setSelectedPersonas(v2.selectedPersonas);
          setActivePersona(v2.activePersona);
          setMembers(v2.retailPartnership.members.map((m) => ({ name: m.name, amount: m.openingContribution ? String(m.openingContribution) : "", profitSharePct: m.profitSharePct ? String(m.profitSharePct) : "" })));
        }
      } catch { /* the V2 configuration remains unavailable until storage is ready */ }
      setLockEnabled(!!s.lockEnabled);
      // Load the list of books (accounts) + which one is active.
      try {
        const bks = await api.listBooks();
        setBooks(bks);
        setActiveBookState(api.activeBookId());
      } catch { /* books optional */ }
      if (s.themeMode && (s.themeMode === 'light' || s.themeMode === 'dark' || s.themeMode === 'navy_gold' || s.themeMode === 'amoled_blue' || s.themeMode === 'system')) {
        setMode(s.themeMode);
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [setMode]);

  useEffect(() => { load(); }, [load]);

  const toggleAiRememberHistory = async () => {
    const next = !aiRememberHistory;
    setAiRememberHistory(next);
    try {
      await api.updateSettings({ aiRememberHistory: next });
      if (!next) await AsyncStorage.removeItem(askHistoryStorageKey(api.activeBookId()));
      setStatus({ ok: true, msg: next ? "Ask AI history will be remembered on this device." : "Ask AI history was removed from this device." });
    } catch (e: any) {
      setAiRememberHistory(!next);
      setStatus({ ok: false, msg: e?.message || "Could not update Ask AI history setting." });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      let normalizedPeriodStart = "";
      let normalizedPeriodEnd = "";
      if (periodMode === "fixed") {
        normalizedPeriodStart = normalizeDateInput(periodStart);
        normalizedPeriodEnd = normalizeDateInput(periodEnd);
        if (!isValidDateString(normalizedPeriodStart) || !isValidDateString(normalizedPeriodEnd)) {
          throw new Error("Fixed periods require valid start and end dates in YYYY-MM-DD format.");
        }
        if (normalizedPeriodStart > normalizedPeriodEnd) throw new Error("The fixed period end date must be on or after its start date.");
        setPeriodStart(normalizedPeriodStart);
        setPeriodEnd(normalizedPeriodEnd);
      }
      if (lockEnabled && !(await deviceHasLock())) {
        throw new Error("Set up a device PIN, fingerprint, or face unlock before enabling App Lock.");
      }
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      if (isCustomProvider && (baseUrl.trim() || transcriptionBaseUrl.trim()) && !customHostConfirmed) {
        throw new Error('Confirm that you trust this custom AI host before saving its API key.');
      }
      await setAIConfig({
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        visionModel: visionModelName.trim(),
        transcriptionModel: transcriptionModelName.trim() || "whisper-1",
        transcriptionBaseUrl: transcriptionBaseUrl.trim(),
        transcriptionApiKey: transcriptionKey.trim(),
        voiceProvider,
        ocrProvider,
        interpretationProvider,
        entryHelpOrder,
        baseUrl: baseUrl.trim(),
      });
      try {
        const currentCfg = await api.getV2BookConfig().catch(() => null);
        await api.updateV2BookConfig({
          basis: accountingBasis,
          style: accountingStyle,
          periodPolicy: periodMode === "fixed"
            ? { mode: "fixed", startDate: normalizedPeriodStart, endDate: normalizedPeriodEnd }
            : { mode: "flexible" },
          selectedPersonas,
          activePersona,
          retailPartnership: {
            enabled: accountingStyle === "retail_partnership",
            commissionPct: currentCfg?.retailPartnership?.commissionPct ?? 0,
            inventoryCadence: currentCfg?.retailPartnership?.inventoryCadence ?? "irregular",
            members: members.map((m) => ({ name: m.name.trim(), openingContribution: m.amount.trim() ? parseFloat(m.amount) : 0, profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0 })).filter((m) => m.name),
          },
        });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({
        lockEnabled,
        themeMode: mode,
        aiDataMode,
        aiRememberHistory,
        aiCustomHostConfirmed: customHostConfirmed,
      });
      setStatus({ ok: true, msg: "Settings saved." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      if (isCustomProvider && (baseUrl.trim() || transcriptionBaseUrl.trim()) && !customHostConfirmed) {
        setTestResult({ ok: false, msg: 'Confirm that you trust this custom AI host first.' });
        return;
      }
      const draftConfig = {
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        visionModel: visionModelName.trim(),
        transcriptionModel: transcriptionModelName.trim() || "whisper-1",
        transcriptionBaseUrl: transcriptionBaseUrl.trim(),
        transcriptionApiKey: transcriptionKey.trim(),
        voiceProvider,
        ocrProvider,
        interpretationProvider,
        entryHelpOrder,
        baseUrl: baseUrl.trim(),
      };
      await api.testKey(draftConfig);
      setTestResult({ ok: true, msg: `✓ Chat connected` });
    } catch (e: any) {
      setTestResult({ ok: false, msg: `✗ ${e.message || "Failed"}` });
    } finally {
      setTesting(false);
    }
  };

  const draftAIConfig = () => {
    const meta = PROVIDERS.find((p) => p.id === provider)!;
    return { provider, apiKey: key.trim(), model: modelName.trim() || meta.defaultModel, visionModel: visionModelName.trim(), transcriptionModel: transcriptionModelName.trim() || "whisper-1", transcriptionBaseUrl: transcriptionBaseUrl.trim(), transcriptionApiKey: transcriptionKey.trim(), voiceProvider, ocrProvider, interpretationProvider, entryHelpOrder, baseUrl: baseUrl.trim() };
  };

  const testAllCapabilities = async () => {
    setTesting(true); setTestResult(null);
    try {
      if (isCustomProvider && (baseUrl.trim() || transcriptionBaseUrl.trim()) && !customHostConfirmed) {
        setTestResult({ ok: false, msg: 'Confirm that you trust this custom AI host first.' });
        return;
      }
      const draft = draftAIConfig();
      await api.testKey(draft);
      const [deviceVoice, deviceOcr] = await Promise.all([getDeviceSpeechStatus(), getLocalOcrStatus()]);
      const cloud = getAICapabilities(draft);
      const voiceMode = interpretationProvider === 'android-device' ? 'android-device' : voiceProvider;
      const ocrMode = interpretationProvider === 'android-device' ? 'android-device' : ocrProvider;
      const voiceReady = voiceMode === 'android-device' ? deviceVoice.available : voiceMode === 'cloud' ? cloud.transcription.configured : deviceVoice.available || cloud.transcription.configured;
      const ocrReady = ocrMode === 'android-device' ? deviceOcr.available : ocrMode === 'cloud' ? cloud.vision.configured : deviceOcr.available || cloud.vision.configured;
      const extras = [
        voiceReady ? 'voice ready' : 'voice not available on this device',
        ocrReady ? 'OCR ready' : 'OCR not available on this device',
      ];
      setTestResult({ ok: true, msg: `Chat connected. ${extras.join('; ')}.` });
    } catch (e: any) { setTestResult({ ok: false, msg: e?.message || 'Capability test failed.' }); }
    finally { setTesting(false); }
  };

  const [busy, setBusy] = useState<"export" | "save" | "import" | null>(null);

  const doExport = async (destination: "share" | "save") => {
    setBusy(destination === "save" ? "save" : "export"); setStatus(null);
    try {
      const full: any = await api.exportBackup();
      const stamp = localTodayIso();
      const filename = `ledgr-backup-${stamp}.json`;
      if (destination === "save") await saveJsonFile(filename, full);
      else await shareJsonFile(filename, full);
      setStatus({ ok: true, msg: destination === "save" ? "Backup saved locally." : "Backup ready to share." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Export failed" });
    } finally { setBusy(null); }
  };

  const doImport = async () => {
    setBusy("import"); setStatus(null);
    try {
      const picked = await pickJsonFile();
      if (!picked.ok) {
        // Cancel is a silent no-op; an unreadable/corrupted file is surfaced. [M1]
        if (picked.reason === "invalid") {
          setStatus({ ok: false, msg: "Backup file is unreadable or corrupted." });
        }
        setBusy(null); return;
      }
      const data = picked.data;
      if (!data || !data._meta || data._meta.app !== "ledgr") {
        setStatus({ ok: false, msg: "Not a Ledgr backup file." });
        setBusy(null); return;
      }
      const result: any = await api.importBackup({ ...data, mode: "replace" });
      // Surface any restore warnings (e.g. a pre-V2 backup rebuilding the ledger). [C1]
      const warn: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
      if (warn.length) {
        Alert.alert("Restore complete — please review", warn.join("\n\n"));
      }
      setStatus({ ok: true, msg: "Data restored! Restart or pull-to-refresh." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Import failed" });
    } finally { setBusy(null); }
  };

  const doReset = async () => {
    const ok = await requireAuth("Confirm to reset all accounting data");
    if (!ok) {
      setConfirmReset(false);
      return;
    }
    setResetting(true); setStatus(null);
    try {
      await api.clearAccountingData();
      setStatus({ ok: true, msg: "Accounting data cleared. Preferences and AI configuration were preserved." });
      setConfirmReset(false);
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Reset failed" });
    } finally { setResetting(false); }
  };

  const doFactoryReset = async () => {
    const ok = await requireAuth("Confirm full device factory reset");
    if (!ok) { setConfirmFactoryReset(false); return; }
    setResetting(true); setStatus(null);
    try {
      await api.factoryReset();
      // Flip the protected-route guard immediately. Expo Router removes every
      // accounting screen from navigation history before we show onboarding.
      requireOnboarding();
      // factoryReset wipes the persisted theme/animation prefs, but the live
      // ThemeContext only hydrates on mount — reset it in memory too so the app
      // returns to its pristine system-default look immediately (not the user's
      // old theme lingering until the next cold start).
      setMode('system');
      setAnimationsEnabled(false);
      router.replace('/onboarding' as any);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Factory reset failed" });
    } finally { setResetting(false); setConfirmFactoryReset(false); }
  };
  const updateMember = (i: number, field: "name" | "amount" | "profitSharePct", v: string) =>
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: v } : m)));
  const addMember = () => setMembers((prev) => [...prev, { name: "", amount: "", profitSharePct: "" }]);
  const removeMember = (i: number) => setMembers((prev) => prev.filter((_, idx) => idx !== i));

  const switchBook = async (id: string) => {
    if (id === activeBook) return;
    await api.setActiveBook(id);
    setActiveBookState(id);
    const targetBook = books.find((b) => b.id === id);
    const s = await api.getSettings();
    const bookTheme = s.themeMode || (id === "default" ? "light" : id.charCodeAt(id.length - 1) % 2 === 0 ? "amoled_blue" : "navy_gold");
    setMode(bookTheme as any);
    await api.updateSettings({ themeMode: bookTheme });
    setStatus({ ok: true, msg: `Switched to "${targetBook?.name || "Account"}". Records & theme updated.` });
    await load();
  };
  const addBook = async () => {
    if (!newBookName.trim()) return;
    setAddingBook(true);
    try {
      const meta = await api.createBook(newBookName.trim());
      setNewBookName("");
      const bks = await api.listBooks();
      setBooks(bks);
      const defaultNewTheme = bks.length % 3 === 0 ? "navy_gold" : bks.length % 2 === 0 ? "amoled_blue" : "dark";
      await api.setActiveBook(meta.id);
      setActiveBookState(meta.id);
      setMode(defaultNewTheme as any);
      await api.updateSettings({ themeMode: defaultNewTheme, businessName: meta.name });
      
      try {
        const v2 = await api.getV2BookConfig();
        if (v2) {
          await api.updateV2BookConfig({
            ...v2,
            selectedPersonas: [newBookPersona],
            activePersona: newBookPersona,
          });
        }
      } catch {}

      setStatus({ ok: true, msg: `Created & switched to new account "${meta.name}".` });
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Could not create account" });
    } finally { setAddingBook(false); }
  };
  const removeBook = async (id: string) => {
    const ok = await requireAuth("Confirm to delete this account");
    if (!ok) return;
    try {
      await api.deleteBook(id);
      const bks = await api.listBooks();
      setBooks(bks);
      setActiveBookState(api.activeBookId());
      setStatus({ ok: true, msg: "Account deleted." });
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Could not delete account" });
    }
  };

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  useEffect(() => {
    if (params.section === "ai-provider") setExpandedKey("AI Provider");
  }, [params.section]);
  const isCustomProvider = provider !== "gemini";
  const selectedProviderTitle = provider === "gemini"
    ? "Google Gemini"
    : provider === "anthropic"
      ? "Anthropic Compatible"
      : "OpenAI Compatible";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        testID="advanced-settings-header"
        title="Advanced Settings"
        subtitle="Workspace configuration and workflows"
        style={styles.advancedHeader}
        leftAction={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Settings"
            hitSlop={8}
            onPress={() => router.back()}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
          </Pressable>
        )}
      />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            
                        <Card style={styles.advancedGroup}>
              <AccordionRow title="System & Workflows" subtitle="Book health and private sync workflows" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <AdvancedNavRow title="Book Health" subtitle="Read-only ledger, backup and recovery checks" icon="shield-checkmark-outline" theme={theme} onPress={() => router.push('/backup-recovery' as any)} />
                  <AdvancedNavRow title="Self-hosted Sync" subtitle="Optional offline-first sync across your devices" icon="cloud-upload-outline" theme={theme} onPress={() => router.push('/sync-settings' as any)} />
                  <AdvancedNavRow title="Sync Conflict Inbox" subtitle="Review retained concurrent edits" icon="warning-outline" theme={theme} onPress={() => router.push('/sync-conflicts' as any)} isLast />
                </View>
              </AccordionRow>

              <AccordionRow title="Business Accounts (Books)" subtitle="Main Account (Active)" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>

                <View>
                  <Text style={styles.hint}>Switch active business account. Each account has its own isolated ledger, business profile, workflows, and theme.</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: theme.spacing.sm, padding: 10, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.success + "55", backgroundColor: theme.color.successBg }}><Ionicons name="shield-checkmark-outline" size={17} color={theme.color.success} /><Text style={{ flex: 1, color: theme.color.success, fontSize: 11, fontWeight: "700" }}>Ledger storage: {activeBook ? "Ready — SQLite V2 authoritative" : "Migration required"}</Text></View>
                  <Text style={[styles.hint, { marginTop: theme.spacing.sm }]}>Book preferences remain device-local. Accounting postings use the active SQLite V2 ledger; do not treat secondary-book preferences as a separate source of accounting truth.</Text>
                  <View style={{ gap: 8, marginTop: theme.spacing.sm }}>
                    {books.map((b) => {
                      const isActive = b.id === activeBook;
                      return (
                        <Pressable key={b.id} onPress={() => switchBook(b.id)} style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: "transparent" }, isActive && { borderColor: theme.color.brandPrimary, backgroundColor: "transparent" }]}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                            <Ionicons name={isActive ? "business" : "business-outline"} size={20} color={isActive ? theme.color.brandPrimary : theme.color.muted} />
                            <Text style={[{ fontSize: 14, fontWeight: "700", color: theme.color.onSurface }, isActive && { color: theme.color.brandPrimary }]}>{b.name}</Text>
                          </View>
                          {isActive ? (
                            <View style={{ backgroundColor: theme.color.brandPrimary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}><Text style={{ fontSize: 11, fontWeight: "700", color: theme.color.onBrandPrimary }}>Active</Text></View>
                          ) : (
                            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.color.brandPrimary }}>Switch</Text>
                          )}
                          {b.id !== "default" && !isActive && (
                            <Pressable onPress={() => removeBook(b.id)} style={{ marginLeft: 12 }}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={{ marginTop: theme.spacing.lg, paddingTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.color.border }}>
                    <Text style={[styles.label, { fontSize: 13, marginBottom: theme.spacing.xs }]}>+ Create New Business Account</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
                      {PERSONAS.map(p => (
                        <Pressable key={`new-${p.id}`} onPress={() => setNewBookPersona(p.id)} style={[{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceTertiary }, newBookPersona === p.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                          <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, newBookPersona === p.id && { color: theme.color.brandPrimary }]}>{p.label}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                    <View style={styles.entryRow}>
                      <TextInput value={newBookName} onChangeText={setNewBookName} placeholder="New account name" placeholderTextColor={theme.color.muted} style={[styles.input, styles.entryInput]} />
                      <Pressable onPress={addBook} disabled={addingBook || !newBookName.trim()} style={styles.addBtn}>
                        {addingBook ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.addText}>Add</Text></>}
                      </Pressable>
                    </View>
                  </View>
                </View>
              </AccordionRow>
              <AccordionRow title="Accounting & Workflow" subtitle={accountingStyle === 'retail_partnership' ? "Basis, Style, Capital Accounts" : "Basis, Style"} isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.label}>Accounting Basis</Text>
                  <View style={styles.modeRow}>
                    {(["cash", "accrual"] as const).map((b) => (
                      <Pressable key={b} accessibilityRole="radio" accessibilityState={{ selected: accountingBasis === b }} onPress={() => setAccountingBasis(b)} style={[styles.modeBtn, accountingBasis === b && styles.modeBtnActive]}>
                        <Text style={[styles.modeText, accountingBasis === b && styles.modeTextActive]}>{b === "cash" ? "Cash Basis" : "Accrual Basis"}</Text>
                      </Pressable>
                    ))}
                  </View>

                  <Text style={[styles.label, { marginTop: theme.spacing.lg }]}>Accounting Style</Text>
                  <View style={{ gap: 10, marginTop: theme.spacing.sm }}>
                    <Pressable accessibilityRole="radio" accessibilityState={{ selected: accountingStyle === 'retail_partnership' }} onPress={() => updateAccountingStyle('retail_partnership')} style={[styles.bookRow, accountingStyle === 'retail_partnership' && styles.bookRowActive]}>
                      <Ionicons name={accountingStyle === 'retail_partnership' ? 'radio-button-on' : 'radio-button-off'} size={20} color={accountingStyle === 'retail_partnership' ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}><Text style={styles.bookName}>Equity Split</Text></View>
                    </Pressable>
                    <Pressable accessibilityRole="radio" accessibilityState={{ selected: accountingStyle === 'standard' }} onPress={() => updateAccountingStyle('standard')} style={[styles.bookRow, accountingStyle === 'standard' && styles.bookRowActive]}>
                      <Ionicons name={accountingStyle === 'standard' ? 'radio-button-on' : 'radio-button-off'} size={20} color={accountingStyle === 'standard' ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}><Text style={styles.bookName}>Standard Entity</Text></View>
                    </Pressable>
                  </View>

                  <Text style={[styles.label, { marginTop: theme.spacing.lg }]}>Accounting Periods</Text>
                  <Text style={styles.hint}>Choose when transactions become permanently locked. Flexible is the default for ongoing books. This setting never unlocks an already-closed period.</Text>
                  <View style={{ gap: 10, marginTop: theme.spacing.sm }}>
                    <Pressable testID="period-policy-flexible" accessibilityRole="radio" accessibilityState={{ selected: periodMode === "flexible" }} onPress={() => setPeriodMode("flexible")} style={[styles.bookRow, periodMode === "flexible" && styles.bookRowActive]}>
                      <Ionicons name={periodMode === "flexible" ? "radio-button-on" : "radio-button-off"} size={20} color={periodMode === "flexible" ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.bookName}>Flexible (Recommended)</Text>
                        <Text style={styles.subLabel}>No assumed year-end. Keep entering dated records and close whenever you decide the period is complete.</Text>
                      </View>
                    </Pressable>
                    <Pressable testID="period-policy-fixed" accessibilityRole="radio" accessibilityState={{ selected: periodMode === "fixed" }} onPress={() => setPeriodMode("fixed")} style={[styles.bookRow, periodMode === "fixed" && styles.bookRowActive]}>
                      <Ionicons name={periodMode === "fixed" ? "radio-button-on" : "radio-button-off"} size={20} color={periodMode === "fixed" ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.bookName}>Fixed start and end dates</Text>
                        <Text style={styles.subLabel}>Use a formal accounting window. Closing is allowed on the configured end date.</Text>
                      </View>
                    </Pressable>
                  </View>
                  {periodMode === "fixed" ? (
                    <View style={[styles.entryRow, { marginTop: theme.spacing.sm }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>Start date</Text>
                        <TextInput testID="period-fixed-start" value={periodStart} onChangeText={setPeriodStart} onBlur={() => { if (periodStart.trim()) setPeriodStart(normalizeDateInput(periodStart)); }} autoCapitalize="none" keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>End date</Text>
                        <TextInput testID="period-fixed-end" value={periodEnd} onChangeText={setPeriodEnd} onBlur={() => { if (periodEnd.trim()) setPeriodEnd(normalizeDateInput(periodEnd)); }} autoCapitalize="none" keyboardType="numbers-and-punctuation" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                      </View>
                    </View>
                  ) : null}

                  {accountingStyle === 'retail_partnership' ? (
                    <>
                      <Text style={[styles.label, { marginTop: theme.spacing.lg }]}>Capital Accounts</Text>
                      {members.map((m, i) => (
                        <View key={`member-${i}`} style={styles.memberCard}>
                          <View style={styles.entryRow}>
                            <TextInput value={m.name} onChangeText={(v) => updateMember(i, "name", v)} placeholder="Name" placeholderTextColor={theme.color.muted} autoCapitalize="words" style={[styles.input, styles.entryInput]} />
                            <Pressable onPress={() => removeMember(i)} style={styles.removeBtn}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                          </View>
                          <View style={[styles.entryRow, { marginTop: 8 }]}>
                            <View style={{ flex: 1 }}><Text style={styles.subLabel}>Investment (opt)</Text><TextInput value={m.amount} onChangeText={(v) => updateMember(i, "amount", v)} keyboardType="decimal-pad" placeholder="e.g. 5000" placeholderTextColor={theme.color.muted} style={styles.input} /></View>
                            <View style={{ flex: 1 }}><Text style={styles.subLabel}>Profit Share %</Text><TextInput value={m.profitSharePct} onChangeText={(v) => updateMember(i, "profitSharePct", v)} keyboardType="decimal-pad" placeholder="e.g. 50" placeholderTextColor={theme.color.muted} style={styles.input} /></View>
                          </View>
                        </View>
                      ))}
                      <Pressable onPress={addMember} style={styles.addBtn}><Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.addText}>Add Member</Text></Pressable>
                    </>
                  ) : null}
                </View>
              </AccordionRow>
            </Card>

            <Card style={styles.advancedGroup}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>AI & Integrations</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Configure your AI provider and secure API access.</Text>
              <AccordionRow title="AI Provider" subtitle={selectedProviderTitle} theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  {params.section === "ai-provider" && <View testID="ai-provider-recovery-hint" style={{ marginBottom: theme.spacing.md, padding: theme.spacing.sm, borderRadius: theme.radius.md, backgroundColor: theme.color.brandPrimary + "18", borderWidth: 1, borderColor: theme.color.brandPrimary + "66" }}><Text style={{ color: theme.color.onSurface, fontSize: 12, lineHeight: 17 }}>Voice input needs a saved key and a provider with speech-to-text. Update the fields below, then tap Test Connection and Save Settings.</Text></View>}
                  <View style={styles.modeRow}>
                    <Pressable
                      onPress={() => chooseProvider("gemini")}
                      style={[styles.modeBtn, !isCustomProvider && styles.modeBtnActive]}
                    >
                      <Text style={[styles.modeText, !isCustomProvider && styles.modeTextActive]}>Google Gemini</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => { if (provider === "gemini") chooseProvider("openai"); }}
                      style={[styles.modeBtn, isCustomProvider && styles.modeBtnActive]}
                    >
                      <Text style={[styles.modeText, isCustomProvider && styles.modeTextActive]}>Custom Provider</Text>
                    </Pressable>
                  </View>
                  {isCustomProvider && (
                    <View style={[styles.modeRow, { marginTop: 8 }]}>
                      <Pressable
                        onPress={() => chooseProvider("openai")}
                        style={[styles.modeBtn, provider === "openai" && styles.modeBtnActive]}
                      >
                        <Text style={[styles.modeText, provider === "openai" && styles.modeTextActive]}>OpenAI Compatible</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => chooseProvider("anthropic")}
                        style={[styles.modeBtn, provider === "anthropic" && styles.modeBtnActive]}
                      >
                        <Text style={[styles.modeText, provider === "anthropic" && styles.modeTextActive]}>Anthropic Compatible</Text>
                      </Pressable>
                    </View>
                  )}
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Automatic order</Text>
                  <View style={styles.modeRow} testID="entry-help-order">
                    <Pressable testID="entry-help-cloud-first" onPress={() => setEntryHelpOrder("cloud-first")} style={[styles.modeBtn, entryHelpOrder === "cloud-first" && styles.modeBtnActive]}><Text style={[styles.modeText, entryHelpOrder === "cloud-first" && styles.modeTextActive]}>AI first</Text></Pressable>
                    <Pressable testID="entry-help-device-first" onPress={() => setEntryHelpOrder("device-first")} style={[styles.modeBtn, entryHelpOrder === "device-first" && styles.modeBtnActive]}><Text style={[styles.modeText, entryHelpOrder === "device-first" && styles.modeTextActive]}>On-device first</Text></Pressable>
                  </View>
                  <Text style={styles.hint}>AI first uses your configured model, then Android/local help if the key is missing, the provider is slow, or it fails. On-device first keeps speech and OCR on this device and only uses cloud when local parsing cannot finish.</Text>
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>API Key</Text>
                  <TextInput value={key} onChangeText={(v) => { setKey(v); setTestResult(null); }} placeholder={PROVIDERS.find((item) => item.id === provider)?.keyHint || "Paste your API key"} placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Model</Text>
                  <TextInput value={modelName} onChangeText={setModelName} placeholder={PROVIDERS.find((item) => item.id === provider)?.defaultModel || "model name"} placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                  <Pressable testID="toggle-advanced-capture" onPress={() => setShowAdvancedCapture((value) => !value)} style={[styles.addBtn, { marginTop: theme.spacing.md }]}>
                    <Ionicons name={showAdvancedCapture ? "chevron-up" : "chevron-down"} size={16} color={theme.color.brandPrimary} />
                    <Text style={styles.addText}>{showAdvancedCapture ? "Hide OCR & voice options" : "OCR & voice options"}</Text>
                  </Pressable>
                  {showAdvancedCapture && isCustomProvider ? (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={styles.label}>Image / OCR model (optional)</Text>
                      <TextInput testID="vision-model" value={visionModelName} onChangeText={setVisionModelName} placeholder="Leave blank to use the chat model" placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                      <Text style={styles.hint}>For receipt and image Scan & Import, choose a vision-capable model available at the chat provider. PDF upload remains Gemini-only; other providers can use page images or pasted text.</Text>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Image / OCR provider</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "auto" }} onPress={() => setOcrProvider("auto")} style={[styles.modeBtn, ocrProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "android-device" }} onPress={() => setOcrProvider("android-device")} style={[styles.modeBtn, ocrProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "android-device" && styles.modeTextActive]}>Android device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "cloud" }} onPress={() => setOcrProvider("cloud")} style={[styles.modeBtn, ocrProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View><Text style={styles.hint}>Automatic extracts text with Android ML Kit first, then falls back to the configured vision provider.</Text>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Voice input provider</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "auto" }} onPress={() => setVoiceProvider("auto")} style={[styles.modeBtn, voiceProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "android-device" }} onPress={() => setVoiceProvider("android-device")} style={[styles.modeBtn, voiceProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "android-device" && styles.modeTextActive]}>Android device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "cloud" }} onPress={() => setVoiceProvider("cloud")} style={[styles.modeBtn, voiceProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View><Text style={styles.hint}>Automatic uses Android recognition when available, then your configured cloud provider.</Text>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Transaction interpretation</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "auto" }} onPress={() => setInterpretationProvider("auto")} style={[styles.modeBtn, interpretationProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "android-device" }} onPress={() => setInterpretationProvider("android-device")} style={[styles.modeBtn, interpretationProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "android-device" && styles.modeTextActive]}>On device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "cloud" }} onPress={() => setInterpretationProvider("cloud")} style={[styles.modeBtn, interpretationProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View><Text style={styles.hint}>Automatic understands common entries locally and uses cloud AI only for complex or unclear commands. On device never sends the transcript to an AI provider.</Text><Text style={[styles.label, { marginTop: theme.spacing.md }]}>Voice-to-text model</Text>
                      <TextInput testID="voice-transcription-model" value={transcriptionModelName} onChangeText={setTranscriptionModelName} placeholder="whisper-1" placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Voice-to-text Base URL (optional)</Text>
                      <TextInput testID="voice-transcription-base-url" value={transcriptionBaseUrl} onChangeText={(value) => { setTranscriptionBaseUrl(value); setCustomHostConfirmed(false); }} placeholder="https://api.openai.com/v1 or another speech host" placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Voice-to-text API key (optional)</Text>
                      <TextInput testID="voice-transcription-api-key" value={transcriptionKey} onChangeText={setTranscriptionKey} placeholder={provider === "openai" ? "Leave blank to reuse the chat key" : "Required for a separate speech host"} placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
                      <Text style={styles.hint}>{provider === "openai" ? "Leave the voice URL and key blank only when the chat host itself supports /audio/transcriptions. OpenRouter chat commonly needs a separate OpenAI-compatible speech endpoint." : "Anthropic has no speech endpoint. Add an OpenAI-compatible speech URL and key here while keeping Anthropic for chat and image OCR."}</Text>
                    </View>
                  ) : null}
                  {showAdvancedCapture && !isCustomProvider ? (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={styles.label}>Image / OCR provider</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "auto" }} onPress={() => setOcrProvider("auto")} style={[styles.modeBtn, ocrProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "android-device" }} onPress={() => setOcrProvider("android-device")} style={[styles.modeBtn, ocrProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "android-device" && styles.modeTextActive]}>Android device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: ocrProvider === "cloud" }} onPress={() => setOcrProvider("cloud")} style={[styles.modeBtn, ocrProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, ocrProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View>
                      <Text style={styles.hint}>Automatic uses Android ML Kit first and Gemini vision as fallback.</Text>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Voice input provider</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "auto" }} onPress={() => setVoiceProvider("auto")} style={[styles.modeBtn, voiceProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "android-device" }} onPress={() => setVoiceProvider("android-device")} style={[styles.modeBtn, voiceProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "android-device" && styles.modeTextActive]}>Android device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: voiceProvider === "cloud" }} onPress={() => setVoiceProvider("cloud")} style={[styles.modeBtn, voiceProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, voiceProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View><Text style={styles.hint}>Automatic uses Android recognition when available and Gemini transcription as fallback.</Text>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Transaction interpretation</Text><View style={styles.modeRow}><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "auto" }} onPress={() => setInterpretationProvider("auto")} style={[styles.modeBtn, interpretationProvider === "auto" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "auto" && styles.modeTextActive]}>Automatic</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "android-device" }} onPress={() => setInterpretationProvider("android-device")} style={[styles.modeBtn, interpretationProvider === "android-device" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "android-device" && styles.modeTextActive]}>On device</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: interpretationProvider === "cloud" }} onPress={() => setInterpretationProvider("cloud")} style={[styles.modeBtn, interpretationProvider === "cloud" && styles.modeBtnActive]}><Text style={[styles.modeText, interpretationProvider === "cloud" && styles.modeTextActive]}>Cloud</Text></Pressable></View><Text style={styles.hint}>Automatic understands common entries locally and uses Gemini only for complex or unclear commands. On device never sends the transcript to an AI provider.</Text>
                    </View>
                  ) : null}
                  {isCustomProvider && (
                    <>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Base URL</Text>
                      <TextInput
                        value={baseUrl}
                        onChangeText={(value) => { setBaseUrl(value); setCustomHostConfirmed(false); }}
                        placeholder={provider === "openai" ? "https://openrouter.ai/api/v1 or any /v1 host" : "https://api.anthropic.com/v1"}
                        placeholderTextColor={theme.color.muted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.input}
                      />
                      <Text style={styles.hint}>Your API key and selected book context will be sent to this host over HTTPS.</Text>
                      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: customHostConfirmed }} onPress={() => setCustomHostConfirmed((value) => !value)} style={styles.securityCheckRow}>
                        <Ionicons name={customHostConfirmed ? "checkbox" : "square-outline"} size={20} color={customHostConfirmed ? theme.color.brandPrimary : theme.color.muted} />
                        <Text style={styles.securityCheckText}>I trust these custom chat, OCR, and voice hosts with the corresponding API keys and selected media or book data.</Text>
                      </Pressable>
                    </>
                  )}
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
                    <Pressable testID="btn-test-connection" onPress={key ? testAllCapabilities : testKey} disabled={testing || !key} style={({ pressed }) => [styles.secondaryBtn, { alignSelf: 'flex-start', paddingHorizontal: 16 }, (pressed || testing) && { opacity: 0.7 }]}>{testing ? <ActivityIndicator color={theme.color.brandPrimary} /> : <Text style={styles.secondaryText}>Test connection</Text>}</Pressable>
                    {testResult && <Text style={{ fontSize: 13, fontWeight: "600", color: testResult.ok ? theme.color.brandPrimary : theme.color.error, flexShrink: 1 }}>{testResult.msg}</Text>}
                  </View>
                </View>
              </AccordionRow>
              <AccordionRow title="On-device models" subtitle="Needle, Gemma downloads, speak answers" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <Text style={styles.hint}>{needleStatus}</Text>
                <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Gemma 4 · LiteRT-LM (experimental)</Text>
                <Text style={styles.hint} testID="gemma-runtime-status">{gemmaStatus?.supported ? `This build currently exposes: ${gemmaStatus.capabilities.join(", ") || "no verified modalities"}. Vision and audio stay unavailable until device validation passes.` : "Gemma downloads require a compatible native build. Needle and the current models remain unchanged."}</Text>
                {gemmaStatus?.managementOperation ? <Text style={styles.hint}>Local model operation: {gemmaStatus.managementOperation}. Verification does not download the model again.</Text> : null}
                {gemmaStatus?.recoveryRequired ? <Pressable onPress={async () => { try { await recoverGemmaRuntime(); } catch { setDownloadHint("Restart the app to recover the local model safely."); } finally { setGemmaStatus(await gemmaPackStatus().catch(() => null)); } }}><Text style={styles.hint}>Recover local model (an app restart may be required)</Text></Pressable> : null}
                {gemmaCatalog.map((pack) => {
                  const installed = gemmaStatus?.packs[pack.id]; const state = installed?.state || "not-installed"; const busy = gemmaBusy === pack.id;
                  return <View key={pack.id} style={{ marginTop: theme.spacing.sm }} testID={`gemma-pack-${pack.id}`}>
                    <Text style={styles.label}>{pack.label}</Text>
                    <Text style={styles.hint}>{gbLabel(pack.bytes)} GB · Apache 2.0 · model stays on this phone. State: {state}.{installed?.partialBytes ? ` Partial: ${gbLabel(installed.partialBytes)} GB.` : ""}</Text>
                    <Pressable onPress={() => void Linking.openURL("https://www.apache.org/licenses/LICENSE-2.0")}><Text style={[styles.hint, { color: theme.color.brandPrimary }]}>View Apache 2.0 license</Text></Pressable>
                    <View style={styles.modeRow}>
                      {Boolean(installed?.bytesOnDisk) ? <Pressable disabled={busy || state === "verifying" || Boolean(gemmaStatus?.managementOperation)} testID={`gemma-remove-${pack.id}`} onPress={() => Alert.alert("Remove downloaded model?", `This removes ${pack.label} from this phone.`, [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: async () => { setGemmaBusy(pack.id); try { await removeGemmaPack(pack.id); setGemmaStatus(await gemmaPackStatus()); } catch (error: any) { setDownloadHint(error?.message || "Model removal failed."); } finally { setGemmaStatus(await gemmaPackStatus().catch(() => null)); setGemmaBusy(null); } } }])} style={[styles.addBtn, { marginTop: 6 }]}><Text style={styles.addText}>{busy ? "Working…" : "Remove model"}</Text></Pressable>
                        : <Pressable disabled={busy || !gemmaStatus?.supported || Boolean(gemmaStatus?.managementOperation)} testID={`gemma-download-${pack.id}`} onPress={async () => { setGemmaBusy(pack.id); try { await downloadGemmaPack(pack.id); } catch (error: any) { setDownloadHint(error?.message || "Gemma download stopped."); } finally { setGemmaStatus(await gemmaPackStatus().catch(() => null)); setGemmaBusy(null); } }} style={[styles.addBtn, { marginTop: 6, opacity: gemmaStatus?.supported ? 1 : 0.5 }]}><Text style={styles.addText}>{busy ? "Downloading…" : installed?.partialBytes ? "Resume" : "Download"}</Text></Pressable>}
                      {busy ? <Pressable testID={`gemma-pause-${pack.id}`} onPress={() => void pauseGemmaDownload(pack.id)} style={[styles.addBtn, { marginTop: 6 }]}><Text style={styles.addText}>Pause</Text></Pressable> : null}
                      {!busy && Boolean(installed?.partialBytes) ? <Pressable testID={`gemma-discard-${pack.id}`} onPress={async () => { try { await discardGemmaPartial(pack.id); } catch (error: any) { setDownloadHint(error?.message || "Could not remove partial model."); } finally { setGemmaStatus(await gemmaPackStatus().catch(() => null)); } }} style={[styles.addBtn, { marginTop: 6 }]}><Text style={styles.addText}>Remove partial</Text></Pressable> : null}
                    </View>
                  </View>;
                })}
                <View style={styles.modeRow}>
                  <Pressable
                    testID="speak-answers-toggle"
                    onPress={async () => {
                      const next = !speakAnswers;
                      setSpeakAnswers(next);
                      await api.setSpeakAnswers(next);
                    }}
                    style={[styles.modeBtn, speakAnswers && styles.modeBtnActive]}
                  >
                    <Text style={[styles.modeText, speakAnswers && styles.modeTextActive]}>{speakAnswers ? "Speak answers on" : "Speak answers off"}</Text>
                  </Pressable>
                </View>
                <Text style={styles.hint}>Uses the phone speaker, not a downloaded voice model. Default is off.</Text>
                {optionalModels.some((model) => model.installed) ? (
                  <>
                    <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Which model answers</Text>
                    <View style={styles.modeRow} testID="on-device-model-picker">
                      <Pressable
                        testID="on-device-model-auto"
                        onPress={async () => { setPreferredModel(null); await setPreferredOnDevicePack(null); }}
                        style={[styles.modeBtn, preferredModel == null && styles.modeBtnActive]}
                      >
                        <Text style={[styles.modeText, preferredModel == null && styles.modeTextActive]}>Auto</Text>
                      </Pressable>
                      {optionalModels.filter((model) => model.installed && model.eligible).map((model) => (
                        <Pressable
                          key={`pick-${model.id}`}
                          testID={`on-device-model-pick-${model.id}`}
                          onPress={async () => { setPreferredModel(model.id); await setPreferredOnDevicePack(model.id); }}
                          style={[styles.modeBtn, preferredModel === model.id && styles.modeBtnActive]}
                        >
                          <Text style={[styles.modeText, preferredModel === model.id && styles.modeTextActive]}>{model.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={styles.hint}>Auto uses the best installed pack this phone can run.</Text>
                  </>
                ) : null}
                {optionalModels.map((model) => (
                  <View key={model.id} style={{ marginTop: theme.spacing.sm }}>
                    <Text style={styles.label}>{model.label}</Text>
                    <Text style={styles.hint}>
                      {model.summary}{" "}
                      {model.installed
                        ? `Downloaded, using ${gbLabel(model.bytesOnDisk || model.bytes)} GB.`
                        : model.eligible
                          ? `About ${gbLabel(model.bytes)} GB Wi-Fi download.`
                          : `Needs about ${gbLabel(model.minRamBytes)} GB of memory${phoneRamGb ? `, and this phone reports ${phoneRamGb} GB` : ""}.`}
                    </Text>
                    {model.eligible ? (
                      <View style={styles.modeRow}>
                        <Pressable
                          testID={`on-device-model-${model.id}`}
                          disabled={modelBusy != null}
                          onPress={async () => {
                            setModelBusy(model.id);
                            setDownloadHint("");
                            try {
                              if (model.installed) await deleteOptionalOnDeviceModel(model.id);
                              else await downloadOptionalOnDeviceModel(model.id, (received, total) => {
                                if (total > 0) setDownloadHint(`${model.label}: ${Math.round((received / total) * 100)}%`);
                              });
                              setOptionalModels(await listOptionalOnDeviceModels());
                            } catch (error: any) {
                              setDownloadHint(error?.message || "Could not update that model.");
                            } finally {
                              setModelBusy(null);
                            }
                          }}
                          style={[styles.addBtn, { marginTop: 6 }]}
                        >
                          <Text style={styles.addText}>{modelBusy === model.id ? "Working…" : model.installed ? "Delete model" : "Download"}</Text>
                        </Pressable>
                        {modelBusy === model.id && !model.installed ? (
                          <Pressable
                            testID={`on-device-model-cancel-${model.id}`}
                            onPress={async () => {
                              await cancelOptionalOnDeviceModelDownload(model.id);
                              setDownloadHint("Download cancelled.");
                            }}
                            style={[styles.addBtn, { marginTop: 6 }]}
                          >
                            <Text style={styles.addText}>Cancel</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ))}
                <Pressable
                  testID="on-device-refresh-packs"
                  onPress={async () => {
                    setDownloadHint("Checking for new packs…");
                    try {
                      await resolveOnDevicePacks({ refresh: true });
                      setOptionalModels(await listOptionalOnDeviceModels());
                      setDownloadHint("Pack list updated.");
                    } catch {
                      setDownloadHint("Could not reach the pack list. Showing the packs already known.");
                    }
                  }}
                  style={[styles.addBtn, { marginTop: theme.spacing.sm }]}
                >
                  <Text style={styles.addText}>Check for new packs</Text>
                </Pressable>
                {installedPackBytes > 0 ? (
                  <Text style={styles.hint} testID="on-device-storage-total">
                    Model packs are using {gbLabel(installedPackBytes)} GB on this phone.
                  </Text>
                ) : null}
                {downloadHint ? <Text style={styles.hint}>{downloadHint}</Text> : null}
              </AccordionRow>
              <AccordionRow title="AI Data & History" subtitle={aiDataMode === 'detailed' ? 'Detailed context enabled' : 'Summary only by default'} isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Summary-only mode sends totals and reports. Detailed mode may include party names, open invoices, and recent entries. Conversation history is never remembered unless you enable it.</Text>
                  <Text style={[styles.hint, { marginTop: theme.spacing.sm }]}>{Platform.OS === 'web' ? 'On web, API keys are session-only and are not stored in browser storage.' : 'On Android and iOS, API keys are stored in device secure credential storage.'}</Text>
                  <View style={styles.modeRow}>
                    <Pressable accessibilityRole="radio" accessibilityState={{ selected: aiDataMode === 'summary' }} onPress={() => setAiDataMode('summary')} style={[styles.modeBtn, aiDataMode === 'summary' && styles.modeBtnActive]}><Text style={[styles.modeText, aiDataMode === 'summary' && styles.modeTextActive]}>Summary only</Text></Pressable>
                    <Pressable accessibilityRole="radio" accessibilityState={{ selected: aiDataMode === 'detailed' }} onPress={() => setAiDataMode('detailed')} style={[styles.modeBtn, aiDataMode === 'detailed' && styles.modeBtnActive]}><Text style={[styles.modeText, aiDataMode === 'detailed' && styles.modeTextActive]}>Detailed context</Text></Pressable>
                  </View>
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: aiRememberHistory }} onPress={() => { void toggleAiRememberHistory(); }} style={styles.securityCheckRow}>
                    <Ionicons name={aiRememberHistory ? "checkbox" : "square-outline"} size={20} color={aiRememberHistory ? theme.color.brandPrimary : theme.color.muted} />
                    <Text style={styles.securityCheckText}>Remember Ask AI conversation on this device.</Text>
                  </Pressable>
                </View>
              </AccordionRow>
            </Card>

            <Card style={styles.advancedGroup}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Security & Data</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Protect your sensitive actions and backups.</Text>
              <AccordionRow title="App Lock" subtitle={lockEnabled ? "ON · Fingerprint / PIN" : "OFF · Fingerprint / PIN"} theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Use your phone’s fingerprint / face / PIN to protect sensitive actions.</Text>
                  <Pressable onPress={() => setLockEnabled((v) => !v)} style={[styles.lockToggle, lockEnabled && styles.lockToggleOn]}>
                    <Ionicons name={lockEnabled ? "lock-closed" : "lock-open-outline"} size={18} color={lockEnabled ? theme.color.onBrandPrimary : theme.color.onSurface} />
                    <Text style={[styles.lockToggleText, lockEnabled && { color: theme.color.onBrandPrimary }]}>{lockEnabled ? "App Lock ON" : "App Lock OFF"}</Text>
                  </Pressable>
                </View>
              </AccordionRow>
              <AccordionRow title="Backup & Restore" subtitle="Encrypted recovery and legacy JSON" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Use Backup & Recovery for encrypted exports, integrity checks, restore dry-runs, and recovery history. The legacy JSON buttons remain available for compatibility with older files.</Text>
                  <Pressable testID="open-backup-recovery" onPress={() => router.push('/backup-recovery' as any)} style={[styles.bookRow, { marginTop: theme.spacing.md, marginBottom: theme.spacing.md }]}><Ionicons name="shield-checkmark-outline" size={20} color={theme.color.brandPrimary} /><View style={{ flex: 1 }}><Text style={styles.bookName}>Open Backup & Recovery</Text><Text style={styles.subLabel}>Recommended for sensitive financial data</Text></View><Ionicons name="chevron-forward" size={18} color={theme.color.muted} /></Pressable>
                  <Text style={[styles.subLabel, { marginBottom: theme.spacing.sm }]}>Legacy JSON compatibility</Text>
                  <View style={styles.backupRow}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Share JSON backup" onPress={() => { void doExport("share"); }} disabled={busy !== null} style={({ pressed }) => [styles.backupBtn, styles.backupBtnPrimary, (pressed || busy === "export") && { opacity: 0.85 }]}>
                      {busy === "export" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="share-outline" size={18} color="#fff" /><Text style={styles.backupBtnTextPrimary}>Share</Text></>}
                    </Pressable>
                    <Pressable testID="legacy-save-device-button" accessibilityRole="button" accessibilityLabel="Save JSON backup to device" onPress={() => { void doExport("save"); }} disabled={busy !== null} style={({ pressed }) => [styles.backupBtn, styles.backupBtnSecondary, (pressed || busy === "save") && { opacity: 0.85 }]}>
                      {busy === "save" ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="download-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.backupBtnTextSecondary}>Save</Text></>}
                    </Pressable>
                    <Pressable onPress={doImport} disabled={busy !== null} style={({ pressed }) => [styles.backupBtn, styles.backupBtnSecondary, (pressed || busy === "import") && { opacity: 0.85 }]}>
                      {busy === "import" ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="cloud-upload-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.backupBtnTextSecondary}>Import</Text></>}
                    </Pressable>
                  </View>
                </View>
              </AccordionRow>
              <AccordionRow title="Danger Zone"
                subtitle="Clear accounting data or reset this device" isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Clear accounting data removes books, transactions, business accounts, inventory and periods while preserving preferences and AI configuration. Factory reset also removes business settings and AI credentials.</Text>
                  {!confirmReset ? (
                    <Pressable onPress={() => setConfirmReset(true)} style={styles.resetInitBtn}><Ionicons name="trash-outline" size={16} color={theme.color.error} /><Text style={styles.resetInitText}>Clear Accounting Data…</Text></Pressable>
                  ) : (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={[styles.hint, { color: theme.color.error, fontWeight: "600" }]}>This cannot be undone. Consider exporting a backup first.</Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                        <Pressable onPress={() => setConfirmReset(false)} style={styles.resetCancelBtn}><Text style={styles.resetCancelText}>Cancel</Text></Pressable>
                        <Pressable onPress={doReset} disabled={resetting} style={styles.resetConfirmBtn}>{resetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.resetConfirmText}>Yes, clear accounting data</Text>}</Pressable>
                      </View>
                    </View>
                  )}
                  {!confirmFactoryReset ? (
                    <Pressable onPress={() => setConfirmFactoryReset(true)} style={[styles.resetInitBtn, { borderColor: theme.color.error + "99" }]}><Ionicons name="warning-outline" size={16} color={theme.color.error} /><Text style={styles.resetInitText}>Factory Reset Device…</Text></Pressable>
                  ) : (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={[styles.hint, { color: theme.color.error, fontWeight: "600" }]}>This wipes everything — all books & records, business configuration, the saved AI key, and your preferences (theme, animations, dashboard layout) — then returns to onboarding.</Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                        <Pressable onPress={() => setConfirmFactoryReset(false)} style={styles.resetCancelBtn}><Text style={styles.resetCancelText}>Cancel</Text></Pressable>
                        <Pressable onPress={doFactoryReset} disabled={resetting} style={styles.resetConfirmBtn}>{resetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.resetConfirmText}>Yes, factory reset</Text>}</Pressable>
                      </View>
                    </View>
                  )}
                </View>
              </AccordionRow>
            </Card>

            {status && (
              <View style={[styles.status, { backgroundColor: status.ok ? theme.color.successBg : theme.color.errorBg }]}>
                <Ionicons name={status.ok ? "checkmark-circle" : "alert-circle"} size={18} color={status.ok ? theme.color.success : theme.color.error} />
                <Text style={[styles.statusText, { color: status.ok ? theme.color.success : theme.color.error }]}>{status.msg}</Text>
              </View>
            )}

            <Pressable testID="btn-save-settings" onPress={save} disabled={saving} style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save Settings</Text>}
            </Pressable>
            <View style={{ height: 120 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: 180 },
    advancedHeader: { paddingTop: 20, paddingBottom: 10 },
    advancedGroup: { marginTop: theme.spacing.lg, padding: 20 },
    label: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    hint: { fontSize: 12, lineHeight: 18, color: theme.color.muted, marginTop: 4 },
    input: {
      marginTop: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      backgroundColor: "transparent",
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      fontSize: 14,
      color: theme.color.onSurface,
    },
    primaryBtn: {
      backgroundColor: theme.color.brandPrimary,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.md,
      alignItems: "center",
      marginTop: theme.spacing.lg,
    },
    primaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    secondaryBtn: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      alignItems: "center",
      borderWidth: 1,
      borderColor: theme.color.brandPrimary,
    },
    secondaryText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 14 },
    status: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      marginTop: theme.spacing.md,
    },
    statusText: { fontSize: 13, fontWeight: "500", flex: 1 },
    modeRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.md },
    modeBtn: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: 6, padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: "transparent",
    },
    modeBtnActive: { backgroundColor: "transparent", borderColor: theme.color.brandPrimary },
    modeText: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    modeTextActive: { color: theme.color.brandPrimary },
    securityCheckRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: theme.spacing.md, paddingVertical: 8 },
    securityCheckText: { flex: 1, fontSize: 12, lineHeight: 18, color: theme.color.onSurface },
    currencyChip: {
      flexDirection: "row", alignItems: "center", justifyContent: "center",
      paddingVertical: 10, paddingHorizontal: 14, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
      minWidth: 88,
    },
    currencyChipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    currencyChipText: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    currencyChipTextActive: { color: theme.color.onBrandPrimary },
    backupRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.md },
    backupBtn: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
    },
    backupBtnPrimary: { backgroundColor: theme.color.brandPrimary },
    backupBtnSecondary: { borderWidth: 1, borderColor: theme.color.brandPrimary, backgroundColor: "transparent" },
    backupBtnTextPrimary: { color: "#fff", fontWeight: "600", fontSize: 13 },
    backupBtnTextSecondary: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
    resetInitBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.error, marginTop: theme.spacing.md,
    },
    resetInitText: { color: theme.color.error, fontWeight: "600", fontSize: 13 },
    resetCancelBtn: { flex: 1, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", borderWidth: 1, borderColor: theme.color.border, backgroundColor: "transparent" },
    resetCancelText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 13 },
    resetConfirmBtn: { flex: 1.4, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", backgroundColor: theme.color.error },
    resetConfirmText: { color: "#fff", fontWeight: "700", fontSize: 13 },
    entryRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    entryInput: { flex: 1 },
    entryAmount: { width: 110 },
    memberCard: { borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.spacing.md, marginTop: theme.spacing.md },
    subLabel: { fontSize: 11, lineHeight: 16, color: theme.color.muted, marginTop: 2 },
    lockToggle: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
      marginTop: theme.spacing.md,
    },
    lockToggleOn: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    lockToggleText: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    bookRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: "transparent",
      marginTop: theme.spacing.sm,
    },
    bookRowActive: { borderColor: theme.color.brandPrimary, backgroundColor: "transparent" },
    bookName: { flex: 1, fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    removeBtn: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.sm,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    addBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.brandPrimary, marginTop: theme.spacing.md,
    },
    addText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
  });
}
