import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform, TextInput, Keyboard, ScrollView, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { effectiveVoiceProvider, isOnDeviceInterpretation } from "@/src/db/ai";
import { loadLocationsIfEnabled } from "@/src/components/LocationPicker";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { prepareVoiceTransactionDraft } from "@/src/accountingV2/prepareVoiceTransactionDraft";
import { materializePendingVoiceParty, suggestedVoicePartyCreateRole, voiceCommandPartyName } from "@/src/accountingV2/voicePartyResolution";
import { resolveAgainstInvoiceTarget, unpaidInvoicesForCustomer, type VoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";
import type { LocalTransactionContinuation } from "@/src/accountingV2/localTransactionParser";
import Animated, { SlideInDown } from "react-native-reanimated";
import { localTodayIso } from "@/src/utils/dateValidation";
import { isCapabilityEnabled } from "@/src/utils/capabilities";
import { VoiceOrb } from "@/src/components/VoiceOrb";
import { captureVoiceRecording, cancelVoiceRecorder, friendlyVoiceError, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { subscribeToVoiceAssistantRequest } from "@/src/utils/voiceAssistantRequest";
import { DeviceSpeechSession, getDeviceSpeechBridge, isDeviceSpeechAvailable } from "@/src/utils/deviceSpeechRecognizer";
import { speakOnDevice } from "@/src/utils/deviceTts";
import { gemmaPackStatus, hasReadyGemmaCapability } from "@/src/utils/gemmaNative";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

/**
 * `showFab={false}` mounts the voice dock without its floating button, for
 * screens that already have their own microphone control (the Ask AI input
 * bar) but want the same in-place dock instead of a full-screen detour.
 */
export default function VoiceFab({ showFab = true }: { showFab?: boolean } = {}) {
  const theme = useTheme();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<any>(null);
  const [drafts, setDrafts] = useState<VoiceTransactionDraft[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [validatedAction, setValidatedAction] = useState<AssistantProposalValidationResult | null>(null);
  const [pendingClarification, setPendingClarification] = useState<LocalTransactionContinuation | null>(null);
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const deviceSession = useRef<DeviceSpeechSession | null>(null);
  const buildVoiceDraftRef = useRef<(text: string, answer?: string) => Promise<any>>(async () => { throw new Error("Voice interpretation is not ready."); });
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const applyFrame = (e?: { endCoordinates?: { height?: number } }) => {
      const height = Math.max(0, e?.endCoordinates?.height ?? 0);
      setKeyboardHeight(height);
    };
    const shown = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      applyFrame
    );
    const hidden = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0)
    );
    const changed = Platform.OS === "android"
      ? Keyboard.addListener("keyboardDidChangeFrame", applyFrame)
      : { remove() {} };
    return () => {
      shown.remove();
      hidden.remove();
      changed.remove();
    };
  }, []);

  const defaultBottom = Math.max(92, 64 + Math.max(insets.bottom, 16) + 8);
  const dockBottom = keyboardHeight > 0 ? keyboardHeight + 10 : defaultBottom;
  const maxDockHeight = Math.max(220, windowHeight - dockBottom - Math.max(insets.top, 24) - 16);

  useFocusEffect(useCallback(() => {
    let active = true;
    api.getSettings()
      .then((settings) => { if (active) setVoiceAvailable(isCapabilityEnabled(settings, "ai_assistant")); })
      .catch(() => { if (active) setVoiceAvailable(false); });
    return () => { active = false; };
  }, []));

  useEffect(() => () => { deviceSession.current?.cancel(); deviceSession.current = null; void cancelVoiceRecorder(recorder); }, [recorder]);

  useEffect(() => {
    if (phase !== "confirm") return;
    const preview = validatedAction && validatedAction.ok ? validatedAction.action.confirmation.preview : "Draft ready for confirmation.";
    void api.getSpeakAnswers().then((enabled) => { if (enabled) return speakOnDevice(preview); }).catch(() => undefined);
  }, [phase, validatedAction]);

  const stopExistingRecorder = useCallback(() => cancelVoiceRecorder(recorder), [recorder]);

  const buildVoiceDraft = async (txt: string, answer = "", useContinuation = true) => {
    setTranscript(txt);
    const continuationToUse = (useContinuation && answer.trim()) ? pendingClarification : null;
    const result = await prepareVoiceTransactionDraft(txt, continuationToUse, answer);
    if (result.status === "clarification") {
      setPendingClarification(result.continuation);
      setClarificationAnswer("");
      throw new Error(result.question);
    }
    setPendingClarification(null);
    setClarificationAnswer("");
    return result.drafts?.length ? result.drafts : [result.draft];
  };
  buildVoiceDraftRef.current = buildVoiceDraft;

  const start = useCallback(async () => {
    setError(""); setTranscript(""); setParsed(null); setDrafts([]); setPendingClarification(null); setClarificationAnswer("");
    try {
      deviceSession.current?.cancel();
      deviceSession.current = null;
      await stopExistingRecorder();
      const config = await api.getAIConfig();
      const voiceMode = effectiveVoiceProvider(config);
      const bridge = getDeviceSpeechBridge();
      const available = bridge ? await isDeviceSpeechAvailable(bridge) : false;
      if (available && voiceMode !== "cloud") {
        if (!bridge) throw new Error("Android device speech recognition is unavailable on this device.");
        deviceSession.current = new DeviceSpeechSession(bridge, { onDeviceOnly: isOnDeviceInterpretation(config) });
        setPhase("recording");
        deviceSession.current.promise.then(async (txt) => {
          deviceSession.current = null; setTranscript(txt);
          const ready = await buildVoiceDraftRef.current(txt);
          setDrafts(ready); setParsed(ready[0]?.parsed || null); setValidatedAction(ready[0]?.validation || null); setPhase("confirm");
        }).catch((e: any) => { deviceSession.current = null; if (e?.code !== "CANCELLED") { setError(e?.message || "Device voice input failed."); setPhase("error"); } });
        return;
      }
      if (voiceMode === "android-device") {
        const gemma = await gemmaPackStatus();
        if (!hasReadyGemmaCapability(gemma, 'audio')) throw new Error("Android device speech recognition and Gemma audio are unavailable on this device.");
      }
      if (!config.apiKey.trim()) {
        setError("Android speech was unavailable and no AI key is configured. Type the transaction below, then update the draft.");
        setPhase("error");
        return;
      }
      await startVoiceRecorder(recorder);
      setPhase("recording");
    } catch (e: any) { setError(friendlyVoiceError(e, "Could not start the microphone.")); setPhase("error"); }
  }, [recorder, stopExistingRecorder]);
  const startRef = useRef(start);
  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => subscribeToVoiceAssistantRequest(() => {
    if (voiceAvailable && phase === "idle") void startRef.current();
  }), [voiceAvailable, phase]);

  const stopAndProcess = async () => {
    if (deviceSession.current) {
      setPhase("processing");
      const session = deviceSession.current;
      try {
        await session.stop();
        const txt = (await session.promise).trim();
        deviceSession.current = null;
        if (!txt) throw new Error("Nothing was heard. Try again.");
        setTranscript(txt);
        const ready = await buildVoiceDraftRef.current(txt, clarificationAnswer.trim());
        setDrafts(ready);
        setParsed(ready[0]?.parsed || null);
        setValidatedAction(ready[0]?.validation || null);
        setPhase("confirm");
      } catch (e: any) {
        deviceSession.current = null;
        if (e?.code === "CANCELLED") { setPhase("idle"); return; }
        setError(friendlyVoiceError(e, "Device voice input failed."));
        setPhase("error");
      }
      return;
    }
    setPhase("processing");
    try {
      const captured = await captureVoiceRecording(recorder);
      const t = await api.transcribe(captured.audioBase64, captured.mime, captured.uploadUri);
      const txt = (t.transcript || "").trim();
      if (!txt) throw new Error("Nothing was heard. Try again.");
      setTranscript(txt);
      const ready = await buildVoiceDraft(txt, clarificationAnswer.trim());
      setDrafts(ready);
      setParsed(ready[0]?.parsed || null);
      setValidatedAction(ready[0]?.validation || null);
      setPhase("confirm");
    } catch (e: any) {
      setError(friendlyVoiceError(e, "Voice processing failed"));
      setPhase("error");
    }
  };

  const rebuildDraft = async () => {
    const txt = transcript.trim();
    if (!txt) { setError("Enter or dictate a transaction before rebuilding the draft."); return; }
    setError(""); setPhase("processing");
    try {
      const hasAnswer = Boolean(clarificationAnswer.trim());
      if (!hasAnswer) {
        setPendingClarification(null);
      }
      const ready = await buildVoiceDraft(txt, clarificationAnswer.trim(), hasAnswer);
      setDrafts(ready);
      setParsed(ready[0]?.parsed || null);
      setValidatedAction(ready[0]?.validation || null);
      setPhase("confirm");
    } catch (e: any) {
      setError(e?.message || "Could not rebuild the draft from that transcript.");
      setPhase("error");
    }
  };

  /**
   * The unknown-party question is the one clarification a user cannot guess the
   * wording for, so offer its two answers as buttons. "supplier"/"customer" are
   * the words the parser already understands, and appending one to the
   * transcript is what marks the party for creation on save.
   */
  const partyChoice = pendingClarification?.missingField === "party_role"
    ? { name: voiceCommandPartyName(pendingClarification.partial as any), suggested: suggestedVoicePartyCreateRole(String(pendingClarification.partial?.intent || "")) }
    : null;

  const answerClarification = async (answer: string) => {
    const text = answer.trim();
    if (!text || !pendingClarification) return;
    setError(""); setPhase("processing");
    try {
      const ready = await buildVoiceDraft(transcript.trim(), text);
      setDrafts(ready);
      setParsed(ready[0]?.parsed || null);
      setValidatedAction(ready[0]?.validation || null);
      setPhase("confirm");
    } catch (e: any) {
      setError(e?.message || "Could not continue the draft.");
      setPhase("error");
    }
  };

  const confirmSave = async () => {
    const toSave = drafts.length ? drafts : (parsed && validatedAction?.ok ? [{ parsed, validation: validatedAction }] : []);
    if (!toSave.length) return;
    setSaving(true);
    try {
      const currency = (await api.getSettings()).currency || "USD";
      const locationContext = await loadLocationsIfEnabled();
      const locationId = locationContext.activeId;
      if (locationContext.enabled && locationContext.locations.length === 0) throw new Error("Add a shop in Locations before saving this voice entry.");
      if (locationContext.enabled && locationContext.locations.length > 1 && !locationId) throw new Error("Choose the active shop in Locations before saving this voice entry.");
      const locationFields = locationId ? { locationId } : {};
      for (const draft of toSave) {
      const parsed = draft.parsed;
      const date = parsed.date || localTodayIso();
      if (parsed.intent === "inventory" && locationContext.enabled && locationContext.locations.length > 1) throw new Error("Voice inventory counts are book-level. Enter a shop count from the Inventory workflow instead.");
      if (!draft.validation || !draft.validation.ok) throw new Error("Voice action requires validation before saving.");
      await executeAssistantProposal(draft.validation, { confirmed: true }, async () => {
        const command = await materializePendingVoiceParty(parsed, {
          supplier: (name) => api.createSupplier({ name }),
          customer: (name) => api.createDebtor({ name }),
        });
        parsed.supplierName = command.supplierName;
        parsed.customerName = command.customerName;
        parsed.intent = command.intent;
        if (parsed.intent === "expense") {
          await api.createExpense({ date, amount: parsed.amount, currency, category: parsed.category || "General", notes: parsed.notes || parsed.summary, method: parsed.method || "cash", ...locationFields });
        } else if (parsed.intent === "bill") {
          const list = await api.listSuppliers();
          const match = list.filter((supplier: any) => supplier.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createBill({
            supplierId: match[0].id, date, amount: parsed.amount, currency,
            paymentType: parsed.paymentType === "cash" ? "cash" : "credit",
            notes: parsed.notes || parsed.summary,
            ...locationFields,
          });
        } else if (parsed.intent === "sale") {
          await api.createSale({ date, amount: parsed.amount, currency, notes: parsed.notes || parsed.summary, ...locationFields });
        } else if (parsed.intent === "receipt") {
          let mode = parsed.receiptMode || (parsed.customerName ? "against_invoice" : "cash_sale");
          const method = parsed.method || "cash";
          if (!parsed.customerName || mode === "cash_sale") {
            await api.createSale({ date, amount: parsed.amount, currency, notes: parsed.notes || parsed.summary, method, ...locationFields });
          } else {
            let debtorId: string | null = null;
            let allocations: { invoiceId: string; amountApplied: number }[] = [];
            const debtors = await api.listDebtors();
            const match = debtors.find((d: any) => d.name.trim().toLowerCase() === parsed.customerName.trim().toLowerCase());
            if (match) debtorId = match.id;
            else throw new Error(`Customer "${parsed.customerName}" was not found. Add the Customer first.`);
            if (mode === "against_invoice") {
              const unpaid = unpaidInvoicesForCustomer(await api.listInvoices(), match, parsed.customerName);
              const target = resolveAgainstInvoiceTarget(parsed, unpaid);
              if ("mode" in target) mode = "advance";
              else allocations = [{ invoiceId: target.invoiceId, amountApplied: parsed.amount }];
            }
            await api.createReceipt({
              mode, date, amount: parsed.amount, method,
              debtorId, clientName: parsed.customerName,
                            allocations,
              notes: parsed.notes || parsed.summary,
              ...locationFields,
            });
          }
        } else if (parsed.intent === "supplier_payment") {
          const list = await api.listSuppliers();
          const match = list.filter((s: any) => s.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createPayment({
            date, amount: parsed.amount, currency,
            type: "supplier_payment", supplierId: match[0].id,
            method: parsed.method || "cash", notes: parsed.notes || parsed.summary,
            ...locationFields,
          });
        } else if (parsed.intent === "drawing") {
          const members = await api.listInvestors();
          const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsed.partnerName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Capital Account "${parsed.partnerName}" was not found uniquely.`);
          await api.drawInvestorFunds(match[0].id, { date, amount: parsed.amount, method: parsed.method || "cash", notes: parsed.notes || parsed.summary, ...locationFields });
        } else if (parsed.intent === "capital") {
          const members = await api.listInvestors();
          const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsed.partnerName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Capital Account "${parsed.partnerName}" was not found uniquely.`);
          await api.depositInvestorCapital(match[0].id, { date, amount: parsed.amount, notes: parsed.notes || parsed.summary });
        } else if (parsed.intent === "inventory") {
          await api.recordV2InventoryCount({ date, value: Number(parsed.amount), notes: parsed.notes || parsed.summary });
        } else {
          throw new Error("Could not determine intent. Please try again.");
        }
      });
      }
      reset();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    deviceSession.current?.cancel();
    deviceSession.current = null;
    void stopExistingRecorder();
    setPhase("idle"); setTranscript(""); setParsed(null); setDrafts([]); setValidatedAction(null); setError(""); setPendingClarification(null); setClarificationAnswer("");
  };

  if (!voiceAvailable) return null;

  return (
    <>
      {showFab ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voice assistant"
          accessibilityHint="Record a transaction by voice"
          testID="voice-fab"
          onPress={start}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: theme.color.brandPrimary },
            pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
          ]}
        >
          <Ionicons name="mic" size={26} color={theme.color.onBrandPrimary} />
        </Pressable>
      ) : null}

            {phase !== "idle" && (
        <Animated.View
          entering={SlideInDown.duration(260).springify()}
          style={[
            styles.voiceDock,
            {
              backgroundColor: theme.color.surfaceSecondary,
              borderColor: theme.color.border,
              bottom: dockBottom,
              maxHeight: maxDockHeight,
            },
          ]}
        >
          <View style={styles.dockHeader}>
            <Text style={[styles.dockTitle, { color: theme.color.onSurface }]}>Voice transaction</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close voice transaction" onPress={reset} hitSlop={8}>
              <Ionicons name="close" size={20} color={theme.color.muted} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.dockScroll}
            contentContainerStyle={styles.dockScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {phase === "recording" || phase === "processing" ? (
              <View style={styles.listeningDock}>
                <VoiceOrb phase={phase === "recording" ? "recording" : "processing"} theme={theme} compact />
                <View style={styles.listeningCopy}>
                  <Text style={[styles.statusLabel, { color: theme.color.brandPrimary }]}>{phase === "recording" ? "Listening…" : "Transcribing…"}</Text>
                  <Text style={[styles.dockHint, { color: theme.color.muted }]}>{phase === "recording" ? "Tap stop when you are done" : "Turning your words into a draft"}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={phase === "recording" ? "Stop recording" : "Cancel transcription"} onPress={phase === "recording" ? stopAndProcess : reset} style={[styles.stopButton, { borderColor: phase === "recording" ? theme.color.error : theme.color.border }]}>
                  <Ionicons name={phase === "recording" ? "stop" : "close"} size={18} color={phase === "recording" ? theme.color.error : theme.color.muted} />
                </Pressable>
              </View>
            ) : phase === "confirm" && parsed ? (
              <View style={styles.reviewDock}>
                {transcript ? <TextInput accessibilityLabel="Editable homepage voice transcript" testID="voice-fab-transcript-input" value={transcript} onChangeText={setTranscript} multiline autoCorrect onSubmitEditing={Keyboard.dismiss} style={[styles.transcriptInput, { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border }]} /> : null}
                {transcript ? <Pressable testID="voice-fab-rebuild-draft" accessibilityRole="button" accessibilityLabel="Update homepage voice draft from edited transcript" onPress={() => void rebuildDraft()} style={[styles.rebuildButton, { borderColor: theme.color.brandPrimary }]}><Text style={[styles.rebuildText, { color: theme.color.brandPrimary }]}>Update draft</Text></Pressable> : null}
                {(drafts.length ? drafts : [{ parsed }]).map((draft, index) => (
                  <Text key={`${draft.parsed.intent}-${draft.parsed.amount}-${index}`} numberOfLines={2} style={[styles.draftSummary, { color: theme.color.onSurface, marginTop: index ? 6 : 0 }]}>
                    {drafts.length > 1 ? `${index + 1}. ` : ""}{draft.parsed.summary}
                  </Text>
                ))}
                <View style={styles.btnRow}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Cancel voice entry" onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}><Text style={[styles.actionText, { color: theme.color.onSurface }]}>Cancel</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Save voice entry" onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>{saving ? <ActivityIndicator color={theme.color.onBrandPrimary} /> : <Text style={[styles.actionText, { color: theme.color.onBrandPrimary }]}>{drafts.length > 1 ? `Save ${drafts.length}` : "Save"}</Text>}</Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.errorDock}>
                <Ionicons name={pendingClarification ? "help-circle-outline" : "alert-circle-outline"} size={20} color={pendingClarification ? theme.color.brandPrimary : theme.color.error} />
                <View style={styles.errorCopy}>
                  {transcript ? <TextInput accessibilityLabel="Editable failed voice transcript" testID="voice-fab-error-transcript-input" value={transcript} onChangeText={setTranscript} multiline autoCorrect onSubmitEditing={Keyboard.dismiss} style={[styles.transcriptInput, { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border }]} /> : null}
                  <Text numberOfLines={4} style={[styles.errorText, { color: pendingClarification ? theme.color.onSurface : theme.color.error }]}>{error}</Text>
                  {partyChoice?.name ? (
                    <View style={styles.choiceRow}>
                      <Pressable testID="voice-fab-create-supplier" accessibilityRole="button" accessibilityLabel={`Create supplier ${partyChoice.name}`} onPress={() => void answerClarification("supplier")} style={[styles.choiceBtn, { backgroundColor: partyChoice.suggested === "supplier" ? theme.color.brandPrimary : theme.color.surfaceTertiary }]}>
                        <Text style={[styles.choiceText, { color: partyChoice.suggested === "supplier" ? theme.color.onBrandPrimary : theme.color.onSurface }]} numberOfLines={1}>Supplier “{partyChoice.name}”</Text>
                      </Pressable>
                      <Pressable testID="voice-fab-create-customer" accessibilityRole="button" accessibilityLabel={`Create customer ${partyChoice.name}`} onPress={() => void answerClarification("customer")} style={[styles.choiceBtn, { backgroundColor: partyChoice.suggested === "customer" ? theme.color.brandPrimary : theme.color.surfaceTertiary }]}>
                        <Text style={[styles.choiceText, { color: partyChoice.suggested === "customer" ? theme.color.onBrandPrimary : theme.color.onSurface }]} numberOfLines={1}>Customer “{partyChoice.name}”</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {pendingClarification ? <TextInput accessibilityLabel="Answer voice clarification" testID="voice-fab-clarification-answer" value={clarificationAnswer} onChangeText={setClarificationAnswer} placeholder="Your answer" placeholderTextColor={theme.color.muted} style={[styles.answerInput, { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border }]} /> : null}
                  {pendingClarification ? <Pressable testID="voice-fab-submit-clarification" accessibilityRole="button" accessibilityLabel="Continue voice draft with this answer" disabled={!clarificationAnswer.trim()} onPress={() => void answerClarification(clarificationAnswer)} style={[styles.rebuildButton, { borderColor: theme.color.brandPrimary, opacity: clarificationAnswer.trim() ? 1 : 0.5 }]}><Text style={[styles.rebuildText, { color: theme.color.brandPrimary }]}>Continue draft</Text></Pressable> : null}
                  {transcript ? <Pressable testID="voice-fab-error-rebuild-draft" accessibilityRole="button" accessibilityLabel="Update failed homepage voice draft from edited transcript" onPress={() => void rebuildDraft()} style={[styles.rebuildButton, { borderColor: theme.color.brandPrimary }]}><Text style={[styles.rebuildText, { color: theme.color.brandPrimary }]}>Update draft</Text></Pressable> : null}
                  {/API key|Anthropic|Base URL|Advanced Settings/i.test(error) ? <Pressable testID="voice-fab-open-provider-settings" accessibilityRole="button" accessibilityLabel="Open AI provider settings" onPress={() => router.push('/advanced-settings?section=ai-provider' as any)}><Text style={[styles.setupLink, { color: theme.color.brandPrimary }]}>Open AI provider settings</Text></Pressable> : null}
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Try voice entry again" onPress={start} style={[styles.retryButton, { borderColor: theme.color.brandPrimary }]}><Text style={[styles.retryText, { color: theme.color.brandPrimary }]}>Retry</Text></Pressable>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      )}

    </>
  );
}


const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 20,
    bottom: 112,
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 16px rgba(0,0,0,0.18)" }
      : { shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 6 }),
    zIndex: 110,
  },
  voiceDock: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 92,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 5px 20px rgba(0,0,0,0.16)" }
      : { shadowColor: "#000", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 14 }),
    zIndex: 120,
  },
  dockScroll: {
    flexShrink: 1,
  },
  dockScrollContent: {
    flexGrow: 0,
    paddingBottom: 4,
  },
  dockHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  dockTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  listeningDock: { flexDirection: "row", alignItems: "center", minHeight: 48 },
  listeningCopy: { flex: 1, minWidth: 0, marginLeft: 8 },
  dockHint: { fontSize: 11, marginTop: 2 },
  stopButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  reviewDock: { paddingTop: 4 },
  transcriptLine: { fontSize: 11, fontStyle: "italic", marginBottom: 6 },
  transcriptInput: { minHeight: 52, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, lineHeight: 17, textAlignVertical: "top" },
  rebuildButton: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderRadius: 10, marginBottom: 7 },
  rebuildText: { fontSize: 11, fontWeight: "700" },
  statusLabel: { fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
  draftLabel: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  draftSummary: { fontSize: 13, fontWeight: "600", marginTop: 4, marginBottom: 8 },
  btnRow: { flexDirection: "row", gap: 8 },
  actionBtn: { flex: 1, minHeight: 36, paddingHorizontal: 12, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  actionText: { fontWeight: "700", fontSize: 12 },
  errorDock: { flexDirection: "row", alignItems: "center", minHeight: 42, gap: 8 },
  errorCopy: { flex: 1, minWidth: 0, gap: 4 },
  errorText: { fontSize: 11, fontWeight: "600" },
  choiceRow: { flexDirection: "row", gap: 8, marginTop: 2 },
  choiceBtn: { flex: 1, minHeight: 34, paddingHorizontal: 10, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  choiceText: { fontSize: 11, fontWeight: "700" },
  answerInput: { minHeight: 38, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, fontSize: 12 },
  setupLink: { fontSize: 11, fontWeight: "800" },
  retryButton: { paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderRadius: 10 },
  retryText: { fontSize: 11, fontWeight: "700" },
});
