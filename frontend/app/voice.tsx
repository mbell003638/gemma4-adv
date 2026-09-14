import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, Platform, KeyboardAvoidingView, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api, getAIConfig } from "@/src/api";
import { effectiveVoiceProvider, isOnDeviceInterpretation } from "@/src/db/ai";
import { Card } from "@/src/components/UI";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { prepareVoiceTransactionDraft } from "@/src/accountingV2/prepareVoiceTransactionDraft";
import { materializePendingVoiceParty } from "@/src/accountingV2/voicePartyResolution";
import { resolveAgainstInvoiceTarget, unpaidInvoicesForCustomer, type VoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";
import type { LocalTransactionContinuation } from "@/src/accountingV2/localTransactionParser";

import { captureVoiceRecording, cancelVoiceRecorder, friendlyVoiceError, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { getDeviceSpeechStatus, startDeviceSpeechRecognition } from "@/src/utils/deviceSpeechRecognizer";
import { gemmaPackStatus, hasReadyGemmaCapability } from "@/src/utils/gemmaNative";

import { localTodayIso } from "@/src/utils/dateValidation";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

// Source tag prefixed onto notes/memo of records created via voice (fix M-5).
const voiceNote = (note?: string) => `[Voice] ${note || ""}`.trim();

export default function VoiceModal() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ assistantText?: string }>();
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
  const deviceStopRef = useRef<(() => Promise<void>) | null>(null);
  const transcriptRef = useRef("");
  const buildVoiceDraftRef = useRef<(text: string, answer?: string) => Promise<any>>(async () => { throw new Error("Voice interpretation is not ready."); });

  useEffect(() => () => { void deviceStopRef.current?.(); deviceStopRef.current = null; void cancelVoiceRecorder(recorder); }, [recorder]);

  useEffect(() => {
    const text = typeof params.assistantText === 'string' ? params.assistantText.trim() : '';
    if (text) { setTranscript(text); void buildVoiceDraftRef.current(text).then((ready: VoiceTransactionDraft[]) => { setDrafts(ready); setParsed(ready[0]?.parsed || null); setValidatedAction(ready[0]?.validation || null); setPhase('confirm'); }).catch((error: any) => { setError(error?.message || 'Could not prepare the Assistant draft.'); setPhase('error'); }); }
  }, [params.assistantText]);


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
  const start = async () => {
    setError(""); setTranscript(""); setParsed(null); setDrafts([]); setPendingClarification(null); setClarificationAnswer("");
    try {
      if (deviceStopRef.current) { await deviceStopRef.current().catch(() => {}); deviceStopRef.current = null; }
      await cancelVoiceRecorder(recorder);
      const cfg = await getAIConfig();
      const mode = effectiveVoiceProvider(cfg);
      if (mode !== "cloud") {
        const status = await getDeviceSpeechStatus();
        if (status.available) {
          transcriptRef.current = "";
          deviceStopRef.current = await startDeviceSpeechRecognition({ onPartial: (text) => { transcriptRef.current = text; setTranscript(text); }, onFinal: (text) => { transcriptRef.current = text; setTranscript(text); }, onError: (speechError) => { setError(speechError.message); setPhase("error"); } }, { onDeviceOnly: isOnDeviceInterpretation(cfg) });
          setPhase("recording");
          return;
        }
        if (mode === "android-device") {
          const gemma = await gemmaPackStatus();
          if (!hasReadyGemmaCapability(gemma, 'audio')) throw new Error(status.reason || "Android device speech recognition and Gemma audio are unavailable.");
        }
      }
      await startVoiceRecorder(recorder);
      setPhase("recording");
    } catch (e: any) { setError(friendlyVoiceError(e, "Could not start the microphone.")); setPhase("error"); }
  };

  const stopAndProcess = async () => {
    setPhase("processing");
    try {
      let txt = "";
      if (deviceStopRef.current) { await deviceStopRef.current(); deviceStopRef.current = null; txt = transcriptRef.current.trim(); }
      else { const captured = await captureVoiceRecording(recorder); const t = await api.transcribe(captured.audioBase64, captured.mime, captured.uploadUri); txt = (t.transcript || "").trim(); }
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
    if (!txt) return;
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
      setError(e?.message || "Could not update the draft from that transcript.");
      setPhase("error");
    }
  };
  const confirmSave = async () => {
    const toSave = drafts.length ? drafts : (parsed && validatedAction?.ok ? [{ parsed, validation: validatedAction }] : []);
    if (!toSave.length) return;
    setSaving(true);
    try {
      const currency = (await api.getSettings()).currency || "USD";
      for (const draft of toSave) {
      const parsedDraft = draft.parsed;
      const date = parsedDraft.date || localTodayIso();
      if (!draft.validation || !draft.validation.ok) throw new Error("Voice action requires validation before saving.");
      await executeAssistantProposal(draft.validation, { confirmed: true }, async () => {
      const command = await materializePendingVoiceParty(parsedDraft, {
        supplier: (name) => api.createSupplier({ name }),
        customer: (name) => api.createDebtor({ name }),
      });
      Object.assign(parsedDraft, command);
      if (parsedDraft.intent === "bill") {
        const list = await api.listSuppliers();
        const match = list.filter((supplier: any) => supplier.name.trim().toLowerCase() === String(parsedDraft.supplierName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Supplier "${parsedDraft.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
        await api.createBill({
          supplierId: match[0].id, date, amount: parsedDraft.amount, currency,
          paymentType: parsedDraft.paymentType === "cash" ? "cash" : "credit",
          notes: voiceNote(parsedDraft.notes || parsedDraft.summary),
        });
      } else if (parsedDraft.intent === "sale") {
        await api.createSale({ date, amount: parsedDraft.amount, currency, notes: voiceNote(parsedDraft.notes || parsedDraft.summary) });
      } else if (parsedDraft.intent === "expense") {
        await api.createExpense({
          date, amount: parsedDraft.amount, currency,
          category: parsedDraft.category || "General",
          method: parsedDraft.method || "cash",
          notes: voiceNote(parsedDraft.notes || parsedDraft.summary),
        });
      } else if (parsedDraft.intent === "receipt") {
        let mode = parsedDraft.receiptMode || (parsedDraft.customerName ? "against_invoice" : "cash_sale");
        const method = parsedDraft.method || "cash";
        let debtorId: string | null = null;
        let allocations: { invoiceId: string; amountApplied: number }[] = [];
        if (parsedDraft.customerName) {
          const debtors = await api.listDebtors();
          const match = debtors.find((d: any) => d.name.trim().toLowerCase() === parsedDraft.customerName.trim().toLowerCase());
          if (match) debtorId = match.id;
          else throw new Error(`Customer "${parsedDraft.customerName}" was not found. Add the Customer first.`);
          if (mode === "against_invoice") {
            const unpaid = unpaidInvoicesForCustomer(await api.listInvoices(), match, parsedDraft.customerName);
            const target = resolveAgainstInvoiceTarget(parsedDraft, unpaid);
            if ("mode" in target) mode = "advance";
            else allocations = [{ invoiceId: target.invoiceId, amountApplied: parsedDraft.amount }];
          }
        }
        await api.createReceipt({
          mode, date, amount: parsedDraft.amount, method,
          debtorId, clientName: parsedDraft.customerName || "",
          allocations, notes: voiceNote(parsedDraft.notes || parsedDraft.summary),
        });
      } else if (parsedDraft.intent === "supplier_payment") {
        const list = await api.listSuppliers();
        const match = list.filter((s: any) => s.name.trim().toLowerCase() === String(parsedDraft.supplierName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Supplier "${parsedDraft.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
        await api.createPayment({
          date, amount: parsedDraft.amount, currency,
          type: "supplier_payment", supplierId: match[0].id,
          method: parsedDraft.method || "cash", notes: voiceNote(parsedDraft.notes || parsedDraft.summary),
        });
      } else if (parsedDraft.intent === "drawing") {
        const members = await api.listInvestors();
        const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsedDraft.partnerName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Capital Account "${parsedDraft.partnerName}" was not found uniquely.`);
        await api.drawInvestorFunds(match[0].id, { date, amount: parsedDraft.amount, method: parsedDraft.method || "cash", notes: voiceNote(parsedDraft.notes || parsedDraft.summary) });
      } else if (parsedDraft.intent === "capital") {
        const members = await api.listInvestors();
        const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsedDraft.partnerName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Capital Account "${parsedDraft.partnerName}" was not found uniquely.`);
        await api.depositInvestorCapital(match[0].id, { date, amount: parsedDraft.amount, notes: voiceNote(parsedDraft.notes || parsedDraft.summary) });
      } else if (parsedDraft.intent === "inventory") {
        await api.recordV2InventoryCount({ date, value: Number(parsedDraft.amount), notes: voiceNote(parsedDraft.notes || parsedDraft.summary) });
      } else {
        throw new Error("Could not determine intent. Please try again.");
      }
      });
      }
      router.back();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    void deviceStopRef.current?.(); deviceStopRef.current = null;
    void cancelVoiceRecorder(recorder);
    setPhase("idle"); setTranscript(""); setParsed(null); setDrafts([]); setValidatedAction(null); setError(""); setPendingClarification(null); setClarificationAnswer("");
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-voice" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>AI Voice Assistant</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 160 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Card>
          <Text style={styles.title}>Say a transaction</Text>
          <Text style={styles.hint}>
            {'e.g., "Paid 100 to Amit and 50 to Rahim", "Spent 20 on fuel and 30 on rent", "Sold 250 today"'}
          </Text>

          <View style={styles.micArea}>
            {phase === "recording" ? (
              <Pressable testID="btn-stop-voice" onPress={stopAndProcess} style={[styles.micBtn, styles.micRecording]}>
                <Ionicons name="stop" size={40} color="#fff" />
              </Pressable>
            ) : phase === "processing" ? (
              <View style={[styles.micBtn, { backgroundColor: theme.color.brandSecondary }]}>
                <ActivityIndicator color="#fff" size="large" />
              </View>
            ) : (
              <Pressable testID="btn-start-voice" onPress={start} style={styles.micBtn}>
                <Ionicons name="mic" size={40} color="#fff" />
              </Pressable>
            )}
            <Text style={styles.micLabel}>
              {phase === "recording" ? "Listening… tap to stop" :
                phase === "processing" ? "Transcribing…" :
                  phase === "confirm" ? "Review draft below" :
                    phase === "error" ? "Edit transcript or try again" :
                      "Tap microphone to start"}
            </Text>
          </View>

          {transcript ? (
            <View style={styles.transcriptBox}>
              <Text style={styles.transcriptLabel}>Transcript</Text>
              <TextInput accessibilityLabel="Editable voice transcript" testID="voice-transcript-input" value={transcript} onChangeText={setTranscript} multiline autoCorrect style={styles.transcript} />
              {pendingClarification ? <TextInput accessibilityLabel="Answer voice clarification" testID="voice-clarification-answer" value={clarificationAnswer} onChangeText={setClarificationAnswer} placeholder="Your answer" placeholderTextColor={theme.color.muted} style={styles.clarificationAnswer} /> : null}
              {phase === "confirm" || phase === "error" ? <Pressable testID="btn-rebuild-voice-draft" accessibilityRole="button" accessibilityLabel="Update draft from edited transcript" onPress={() => void rebuildDraft()} style={[styles.actionBtn, { marginTop: 10, backgroundColor: theme.color.brandPrimary }]}><Text style={[styles.actionText, { color: "#000" }]}>Update draft</Text></Pressable> : null}
            </View>
          ) : null}

          {phase === "confirm" && (drafts.length ? drafts : parsed ? [{ parsed, validation: validatedAction }] : []).map((draft, index, list) => {
            const row = draft.parsed;
            const isDestructive = draft.validation?.ok === true && draft.validation.action.isDestructive === true;
            return (
            <View key={`${row.intent}-${row.amount}-${index}`} style={styles.draft} testID={index === 0 ? "voice-draft" : `voice-draft-${index}`}>
              <Text style={styles.draftLabel}>Draft {list.length > 1 ? `${index + 1} of ${list.length} · ` : ""}{String(row.intent || "").replace("_", " ")}</Text>
              <Text style={styles.draftSummary}>{row.summary}</Text>
              {row.pendingPartyCreate ? <Text style={styles.hint}>Will create {row.pendingPartyCreate.role} “{row.pendingPartyCreate.name}” on save.</Text> : null}
              <View style={styles.draftGrid}>
                {row.amount != null && <DKV k="Amount" v={fmt(row.amount, row.currency || "USD")} theme={theme} />}
                {row.date && <DKV k="Date" v={row.date} theme={theme} />}
                {row.supplierName && <DKV k="Supplier" v={row.supplierName} theme={theme} />}
                {row.customerName && <DKV k="Customer" v={row.customerName} theme={theme} />}
                {row.partnerName && <DKV k="Capital Account" v={row.partnerName} theme={theme} />}
                {row.paymentType && <DKV k="Type" v={row.paymentType} theme={theme} />}
                {row.method && <DKV k="Payment method" v={row.method === "upi" ? "mobile / UPI" : row.method} theme={theme} />}
              </View>
              {isDestructive ? (
                <View style={styles.destructiveWarn} testID="voice-destructive-warn">
                  <Ionicons name="warning" size={16} color={theme.color.error} />
                  <Text style={styles.destructiveWarnText}>This closes the period permanently — it cannot be undone.</Text>
                </View>
              ) : null}
              {index === list.length - 1 ? (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <Pressable testID="btn-voice-cancel" onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                  <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Try Again</Text>
                </Pressable>
                <Pressable testID="btn-voice-confirm" onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: isDestructive ? theme.color.error : theme.color.brandPrimary, flex: 1.4 }]}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>{isDestructive ? "Close Books" : list.length > 1 ? `Confirm & Save ${list.length}` : "Confirm & Save"}</Text>}
                </Pressable>
              </View>
              ) : null}
            </View>
            );
          })}

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color={theme.color.error} />
              <View style={{ flex: 1, gap: 7 }}>
                <Text style={styles.errorText} testID="voice-error">{error}</Text>
                {/API key|Anthropic|Base URL|Advanced Settings|provider/i.test(error) ? <Pressable testID="voice-open-provider-settings" accessibilityRole="button" accessibilityLabel="Open AI provider settings" onPress={() => router.push('/advanced-settings?section=ai-provider' as any)}><Text style={styles.setupLink}>Open AI provider settings</Text></Pressable> : null}
              </View>
            </View>
          ) : null}
        </Card>
        <View style={{ height: 40 }} />
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function DKV({ k, v, theme }: { k: string; v: string; theme: any }) {
  return (
    <View style={{ width: "50%", paddingVertical: 4 }}>
      <Text style={{ fontSize: 11, color: theme.color.muted }}>{k}</Text>
      <Text style={{ fontSize: 14, color: theme.color.onSurface, fontWeight: "600" }}>{v}</Text>
    </View>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  keyboard: { flex: 1 },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  scroll: { padding: theme.spacing.lg },
  title: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface },
  hint: { fontSize: 13, color: theme.color.muted, marginTop: 6 },
  micArea: { alignItems: "center", paddingVertical: theme.spacing.xl, gap: 12 },
  micBtn: { width: 96, height: 96, borderRadius: 48, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center", ...(Platform.OS === "web" ? { boxShadow: "0 6px 24px rgba(0,0,0,0.18)" } : { shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 }) },
  micRecording: { backgroundColor: theme.color.error },
  micLabel: { color: theme.color.muted, fontSize: 13, fontWeight: "500" },
  transcriptBox: { marginTop: 8, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md },
  transcriptLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  transcript: { minHeight: 74, color: theme.color.onSurface, fontSize: 14, lineHeight: 20, marginTop: 6, padding: 10, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, textAlignVertical: "top" },
  clarificationAnswer: { minHeight: 44, color: theme.color.onSurface, fontSize: 14, marginTop: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md },
  draft: { marginTop: theme.spacing.md, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brandTertiary },
  draftLabel: { fontSize: 11, color: theme.color.brandPrimary, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  draftSummary: { fontSize: 15, color: theme.color.onSurface, fontWeight: "600", marginTop: 6 },
  draftGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  actionBtn: { flex: 1, padding: 12, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: theme.color.errorBg, borderRadius: theme.radius.md, marginTop: theme.spacing.md },
  errorText: { color: theme.color.error, fontSize: 13, flex: 1 },
  setupLink: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "800" },
  destructiveWarn: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: theme.color.errorBg, borderRadius: theme.radius.md, marginTop: theme.spacing.md, borderWidth: 1, borderColor: theme.color.error },
  destructiveWarnText: { color: theme.color.error, fontSize: 13, flex: 1, fontWeight: "600" },
}); }
