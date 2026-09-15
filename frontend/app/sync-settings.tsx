import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';
import { decodeLedgrSyncQrInvite } from '@/src/sync/qrEnrollment';
import { api } from '@/src/api';
import { ScreenHeader } from '@/src/components/UI';
import { HostingModeCard } from '@/src/components/HostingModeCard';
import { useTheme } from '@/src/context/ThemeContext';
import { useResponsiveDevice } from '@/src/hooks/useResponsiveDevice';
import { activeBookId, activeSqlRunner } from '@/src/db/backend';
import { advanceSyncEpoch, enrollSyncDevice, listSyncDevices, revokeSyncDevice, type SyncDevice } from '@/src/sync/recovery';
import { generateSyncPassphrase } from '@/src/sync/e2ee';
import { parseWifiP2pQr, type WifiP2pSession } from '@/src/sync/wifiP2pSync';

type ConnectionPath = 'join' | 'admin';
type SyncModeTab = 'cloud' | 'wifi' | 'self_hosted';

export default function SyncSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { compactPhone } = useResponsiveDevice();
  const params = useLocalSearchParams<{ invite?: string }>();

  const [activeTab, setActiveTab] = useState<SyncModeTab>('cloud');

  // Cloud Drive State
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassphrase, setCloudPassphrase] = useState('');
  const [cloudAutoSync, setCloudAutoSync] = useState(true);
  const [cloudConfigSaved, setCloudConfigSaved] = useState(false);

  // Wi-Fi P2P State
  const [wifiSession, setWifiSession] = useState<WifiP2pSession | null>(null);
  const [wifiQrUri, setWifiQrUri] = useState<string | null>(null);
  const [wifiQrSvg, setWifiQrSvg] = useState('');
  const [wifiScanning, setWifiScanning] = useState(false);
  const [wifiScanLocked, setWifiScanLocked] = useState(false);
  const [, requestCameraPermission] = useCameraPermissions();

  // Self-Hosted Server State (Existing)
  const [serverUrl, setServerUrl] = useState('');
  const [userId, setUserId] = useState('');
  const [token, setToken] = useState('');
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcScopes, setOidcScopes] = useState('openid profile offline_access');
  const [status, setStatus] = useState<any>(null);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const [oneTimeCode, setOneTimeCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [inviteLocationCount, setInviteLocationCount] = useState(0);
  const [connectionPath, setConnectionPath] = useState<ConnectionPath>('join');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getSyncStatus();
      setStatus(next);
      if (next.serverUrl) setServerUrl((current) => current || next.serverUrl || '');
      if (next.userId) setUserId((current) => current || next.userId || '');
      if (next.oidcIssuer) setOidcIssuer((current) => current || next.oidcIssuer || '');
      if (next.oidcClientId) setOidcClientId((current) => current || next.oidcClientId || '');
      if (next.oidcScopes) setOidcScopes((current) => current || next.oidcScopes || '');
      const db = activeSqlRunner();
      setDevices(db && next.configured ? await listSyncDevices(db, activeBookId()).catch(() => []) : []);

      // Load Cloud Drive configuration
      const cloudCfg = await api.getCloudSyncConfig();
      if (cloudCfg) {
        setCloudEmail(cloudCfg.accountEmail || '');
        setCloudPassphrase(cloudCfg.passphrase || '');
        setCloudAutoSync(cloudCfg.autoSyncEnabled ?? true);
        setCloudConfigSaved(!!cloudCfg.accountEmail);
      } else {
        setCloudPassphrase(generateSyncPassphrase());
      }

      // If already configured for self-hosted, default to self-hosted tab
      if (next.configured) {
        setActiveTab('self_hosted');
      }
    } catch (error: any) {
      setMessage(error?.message || 'Sync is unavailable until SQLite is ready.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!wifiQrUri) {
      setWifiQrSvg('');
      return;
    }
    let active = true;
    QRCode.toString(wifiQrUri, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (active) setWifiQrSvg(svg);
      })
      .catch(() => {
        if (active) setWifiQrSvg('');
      });
    return () => {
      active = false;
    };
  }, [wifiQrUri]);

  useEffect(() => {
    const encoded = typeof params.invite === 'string' ? params.invite : '';
    if (!encoded) return;
    try {
      const invite = decodeLedgrSyncQrInvite(decodeURIComponent(encoded));
      setActiveTab('self_hosted');
      setConnectionPath('join');
      setWorkflowsOpen(true);
      setServerUrl(invite.serverUrl);
      setOneTimeCode(invite.code);
      setInviteRole(invite.role);
      setInviteLocationCount(invite.locationIds.length);
      if (invite.oidcIssuer) setOidcIssuer(invite.oidcIssuer);
      if (invite.oidcClientId) setOidcClientId(invite.oidcClientId);
      if (invite.oidcScopes) setOidcScopes(invite.oidcScopes);
      setMessage(
        invite.role === 'owner'
          ? 'Owner setup QR ready. Sign in with the owner identity to create the first owner device.'
          : `Invitation ready: ${invite.role}${invite.locationIds.length ? ` · ${invite.locationIds.length} location scope(s)` : ''}. Sign in with your own identity, then join.`
      );
    } catch (error: any) {
      setMessage(error?.message || 'This QR invitation could not be used.');
    }
  }, [params.invite]);

  // Cloud Drive handlers
  const handleSaveCloudConfig = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.saveCloudSyncConfig({
        provider: 'google_drive',
        accountEmail: cloudEmail || 'user@example.com',
        passphrase: cloudPassphrase,
        autoSyncEnabled: cloudAutoSync,
      });
      setCloudConfigSaved(true);
      setMessage('Passphrase and Cloud Drive configuration saved locally. Google Drive transfer is not active until OAuth exists.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not save Cloud Drive configuration.');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateNewPassphrase = () => {
    Alert.alert(
      'Generate New Passphrase?',
      'Only devices with the matching passphrase can read this business account. Existing remote copies must also use this key.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Generate', onPress: () => setCloudPassphrase(generateSyncPassphrase()) },
      ]
    );
  };

  const handleJoinWithPassphrase = async () => {
    const passphrase = cloudPassphrase.trim();
    if (!passphrase) return;
    setBusy(true);
    setMessage('');
    try {
      const key = await api.adoptCloudSyncKey(passphrase);
      setMessage(key
        ? 'Joined the existing encrypted book. Pull to sync when you are ready.'
        : 'No encrypted book was found for that passphrase on this Drive account.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not join with that passphrase.');
    } finally {
      setBusy(false);
    }
  };

  // Wi-Fi P2P handlers
  const handleStartWifiShare = async () => {
    setBusy(true);
    setMessage('');
    try {
      const { session, qrCodeUri } = api.createWifiP2pSession();
      setWifiSession(session);
      setWifiQrUri(qrCodeUri);
      setMessage('Wi-Fi pairing code created. Scan it on your receiving phone.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not start Wi-Fi pairing session.');
    } finally {
      setBusy(false);
    }
  };

  const openWifiScanner = async () => {
    const permission = await requestCameraPermission();
    if (!permission.granted) {
      setMessage('Camera permission is required to scan Wi-Fi sync codes.');
      return;
    }
    setMessage('');
    setWifiScanLocked(false);
    setWifiScanning(true);
  };

  const onWifiQrScanned = async (result: BarcodeScanningResult) => {
    if (wifiScanLocked) return;
    setWifiScanLocked(true);
    try {
      const parsed = parseWifiP2pQr(result.data);
      setWifiScanning(false);
      setMessage(`Wi-Fi pairing session detected from ${parsed.hostIp}.`);
      Alert.alert(
        'Pair Device Over Wi-Fi',
        `Pairing QR from ${parsed.hostIp} is valid. Nearby Wi-Fi book transfer is not available yet.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setWifiScanLocked(false) },
          {
            text: 'Synchronize',
            onPress: () => {
              setMessage('Nearby Wi-Fi book transfer is not available yet. Pairing QR is not a completed sync.');
            },
          },
        ]
      );
    } catch (error: any) {
      setWifiScanLocked(false);
      setMessage(error?.message || 'Invalid Wi-Fi pairing QR code.');
    }
  };

  // Self-Hosted Server handlers (Existing)
  const enroll = async () => {
    setBusy(true);
    setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) {
        throw new Error(
          !prerequisites.integrity.ok
            ? prerequisites.integrity.issues.join(' ')
            : 'Create and verify an encrypted backup before connecting private sync.'
        );
      }
      await api.configureSync({ serverUrl, userId, accessToken: token, enabled: false, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner();
      if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await enrollSyncDevice(db, activeBookId());
      setToken('');
      const next = await api.getSyncStatus();
      setStatus(next);
      setMessage(
        next.bootstrapRequired
          ? 'Device enrolled against an empty server. Review the destination, then publish the first snapshot.'
          : next.recoveryRequired
          ? `Device enrolled in epoch ${enrolled.epochNumber}. Export a backup, then install the validated server snapshot.`
          : 'Device enrolled. Local writes remain available offline.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not enroll this device.');
    } finally {
      setBusy(false);
    }
  };

  const enrollOidc = async () => {
    setBusy(true);
    setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) {
        throw new Error(
          !prerequisites.integrity.ok
            ? prerequisites.integrity.issues.join(' ')
            : 'Create and verify an encrypted backup before connecting private sync.'
        );
      }
      await api.authorizeSyncOidc({ serverUrl, userId, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner();
      if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await enrollSyncDevice(db, activeBookId());
      const next = await api.getSyncStatus();
      setStatus(next);
      setMessage(
        next.bootstrapRequired
          ? 'Sign-in succeeded. Review the destination, then publish the first snapshot.'
          : next.recoveryRequired
          ? `Sign-in succeeded for epoch ${enrolled.epochNumber}. Export a backup, then install the validated server snapshot.`
          : 'Sign-in and device enrollment completed. Local writes remain available offline.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not sign in and enroll this device.');
    } finally {
      setBusy(false);
    }
  };

  const redeemCode = async () => {
    setBusy(true);
    setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) {
        throw new Error(
          !prerequisites.integrity.ok
            ? prerequisites.integrity.issues.join(' ')
            : 'Create and verify an encrypted backup before connecting private sync.'
        );
      }
      await api.configureSync({ serverUrl, userId, accessToken: token, enabled: false, oidcIssuer, oidcClientId, oidcScopes });
      await api.redeemSyncEnrollmentCode(oneTimeCode, deviceName || 'Ledgr device', Platform.OS);
      setOneTimeCode('');
      setToken('');
      setStatus(await api.getSyncStatus());
      setMessage('This device joined the business. Its role and location access came from the administrator.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'The one-time enrollment code could not be redeemed.');
    } finally {
      setBusy(false);
    }
  };

  const signInAndJoin = async () => {
    setBusy(true);
    setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) {
        throw new Error(
          !prerequisites.integrity.ok
            ? prerequisites.integrity.issues.join(' ')
            : 'Create and verify an encrypted backup before joining private sync.'
        );
      }
      await api.authorizeAndRedeemSyncEnrollmentCode({
        serverUrl,
        userId,
        code: oneTimeCode,
        displayName: deviceName || 'Ledgr device',
        platform: Platform.OS,
        oidcIssuer,
        oidcClientId,
        oidcScopes,
      });
      setOneTimeCode('');
      setStatus(await api.getSyncStatus());
      setMessage(
        inviteRole === 'owner'
          ? 'You are now the owner of this Business Account. Local writes remain available offline.'
          : 'Sign-in and invitation redemption completed. Local writes remain available offline.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not sign in and join this business.');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await api.syncNow());
      setMessage('Sync completed.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Sync could not reach the server; local data is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await api.retrySyncNow());
      setMessage('Retry completed.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Retry could not reach the server; local data is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const advanceEpoch = () =>
    Alert.alert(
      'Advance server epoch?',
      'Use this only when reset, restore, or deletion intentionally replaces the shared Business Account. All devices will be revoked and must re-enroll.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Advance epoch',
          style: 'destructive',
          onPress: async () => {
            const db = activeSqlRunner();
            if (!db) return;
            setBusy(true);
            try {
              await advanceSyncEpoch(db, activeBookId(), status?.recoveryReason || 'Explicit recovery');
              setMessage('Server epoch advanced. Re-enroll this device, sync the empty epoch, then publish a recovery snapshot.');
              await load();
            } catch (error: any) {
              setMessage(error?.message || 'Could not advance the server epoch.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  const installSnapshot = async () => {
    setBusy(true);
    setMessage('');
    try {
      const fn = (api as any).installSyncSnapshot;
      if (typeof fn !== 'function') throw new Error('Snapshot installer is not registered in this build');
      await fn();
      setMessage('Validated snapshot installed and preserved local work replayed atomically.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Snapshot recovery failed; local data was rolled back.');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.publishSyncSnapshot();
      setMessage('Recovery snapshot published for this canonical checkpoint.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not publish the recovery snapshot.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.verifySyncCheckpoint();
      setMessage(
        result.eventHashMatches && result.projectionHashMatches !== false
          ? 'Checkpoint verified.'
          : 'Checkpoint mismatch detected; recovery is required.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Checkpoint verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await api.disableSync();
      setMessage('Sync disabled. Pending local work is retained.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not disable sync.');
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      await api.enableSync();
      setMessage('Sync enabled. Local writes remain offline-first.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not enable sync.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = (device: SyncDevice) =>
    Alert.alert(
      'Revoke device?',
      device.current
        ? 'This device will stop syncing and must be explicitly re-enrolled.'
        : `Device ${device.deviceId.slice(0, 12)}… will no longer access this Business Account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            const db = activeSqlRunner();
            if (!db) return;
            setBusy(true);
            try {
              await revokeSyncDevice(db, activeBookId(), device.deviceId);
              setMessage('Device revoked.');
              await load();
            } catch (error: any) {
              setMessage(error?.message || 'Could not revoke device.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  const inputStyle = styles.input;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScreenHeader compact={compactPhone}
        title="Self-hosted Sync"
        subtitle="Keep your accounts in sync securely"
        leftAction={
          <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
          </Pressable>
        }
      />
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
          <HostingModeCard compact />

          {/* Top Segmented Tab Switcher */}
          <View style={styles.tabBar}>
            <Pressable accessibilityRole="button" accessibilityLabel="Google Drive Tab" testID="sync-tab-cloud" onPress={() => setActiveTab('cloud')} style={[styles.tabItem, activeTab === 'cloud' && styles.tabItemActive]}>
              <Ionicons name="logo-google" size={16} color={activeTab === 'cloud' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'cloud' && styles.tabTextActive]}>Google Drive</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Nearby Wi-Fi Tab" testID="sync-tab-wifi" onPress={() => setActiveTab('wifi')} style={[styles.tabItem, activeTab === 'wifi' && styles.tabItemActive]}>
              <Ionicons name="wifi-outline" size={16} color={activeTab === 'wifi' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'wifi' && styles.tabTextActive]}>Nearby Wi-Fi</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Self-Hosted Tab" testID="sync-tab-self-hosted" onPress={() => setActiveTab('self_hosted')} style={[styles.tabItem, activeTab === 'self_hosted' && styles.tabItemActive]}>
              <Ionicons name="server-outline" size={16} color={activeTab === 'self_hosted' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'self_hosted' && styles.tabTextActive]}>Self-Hosted</Text>
            </Pressable>
          </View>

          {/* TAB 1: GOOGLE DRIVE SYNC (E2EE) */}
          {activeTab === 'cloud' && (
            <View style={styles.card}>
              <View style={styles.badgeRow}>
                <Ionicons name="shield-checkmark" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.badgeText}>AES-256-GCM Zero-Knowledge Encryption</Text>
              </View>
              <Text style={styles.sectionTitle}>Google Drive Sync & Backup</Text>
              <Text style={styles.hint}>
                Sync seamlessly across your devices and keep an automatic encrypted backup in your private Google Drive app folder. All ledger numbers are end-to-end encrypted on this phone before uploading. Google cannot read your financial records.
              </Text>

              <Text style={styles.label}>Google Account</Text>
              <TextInput
                value={cloudEmail}
                onChangeText={setCloudEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@gmail.com"
                placeholderTextColor={theme.color.muted}
                style={inputStyle}
              />

              <View style={styles.passphraseHeader}>
                <Text style={styles.label}>Secret Sync Passphrase</Text>
                <Pressable testID="cloud-generate-passphrase" onPress={handleGenerateNewPassphrase}>
                  <Text style={styles.inlineAction}>Generate New</Text>
                </Pressable>
              </View>
              <TextInput
                value={cloudPassphrase}
                testID="cloud-passphrase"
                onChangeText={setCloudPassphrase}
                autoCapitalize="none"
                placeholder="24-character security key"
                placeholderTextColor={theme.color.muted}
                style={inputStyle}
              />
              <Text style={styles.subHint}>
                Keep this passphrase safe! You must enter this same passphrase on your other devices to decrypt this business account. It is the only thing that unlocks the backup, and nobody can recover it for you.
              </Text>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save passphrase locally"
                disabled={busy || !cloudPassphrase.trim()}
                onPress={handleSaveCloudConfig}
                style={[styles.primary, (busy || !cloudPassphrase.trim()) && styles.disabled]}
              >
                <Text style={styles.primaryText}>{busy ? 'Saving...' : cloudConfigSaved ? 'Update saved configuration' : 'Save passphrase locally'}</Text>
              </Pressable>

              {/* api.adoptCloudSyncKey existed but nothing called it, so a second
                  phone had no way to join an existing encrypted book with just
                  the passphrase. */}
              <Pressable
                testID="cloud-join"
                accessibilityRole="button"
                accessibilityLabel="Join this book with the passphrase"
                disabled={busy || !cloudPassphrase.trim()}
                onPress={handleJoinWithPassphrase}
                style={[styles.secondary, (busy || !cloudPassphrase.trim()) && styles.disabled]}
              >
                <Text style={styles.secondaryText}>This is my second phone - join with the passphrase</Text>
              </Pressable>
            </View>
          )}

          {/* TAB 2: NEARBY WI-FI P2P SYNC */}
          {activeTab === 'wifi' && (
            <View style={styles.card}>
              <View style={styles.badgeRow}>
                <Ionicons name="flash-outline" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.badgeText}>Direct Local Wi-Fi (No Cloud Needed)</Text>
              </View>
              <Text style={styles.sectionTitle}>Nearby Phone Sync</Text>
              <Text style={styles.hint}>
                Transfer or sync directly between two phones on the same home or office Wi-Fi network. Works with no internet at all, so it suits a market stall or a warehouse. Instant, and zero setup required.
              </Text>

              <View style={styles.actionBlock}>
                <Text style={styles.packageTitle}>1. Share to another phone</Text>
                <Text style={styles.packageHint}>Show a secure QR code on this screen. Your second phone can scan it to import this account.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Create Pairing QR Code"
                  disabled={busy}
                  testID="wifi-create-session" onPress={handleStartWifiShare}
                  style={[styles.secondaryButtonRow, busy && styles.disabled]}
                >
                  <Ionicons name="qr-code-outline" size={20} color={theme.color.brandPrimary} />
                  <Text style={styles.secondaryButtonText}>{busy ? 'Preparing QR...' : 'Create Pairing QR Code'}</Text>
                </Pressable>

                {wifiQrUri && (
                  <View style={styles.qrPreview}>
                    <Text style={styles.qrTitle}>Scan on Receiving Phone</Text>
                    {wifiSession?.sessionId ? <Text style={styles.mono}>Session: {wifiSession.sessionId}</Text> : null}
                    <Text style={styles.qrHint}>Expires in 15 minutes. Data is transferred directly over Wi-Fi with end-to-end encryption.</Text>
                    <View style={styles.qrSurface}>
                      {wifiQrSvg ? <SvgXml xml={wifiQrSvg} width="220" height="220" /> : <ActivityIndicator color={theme.color.brandPrimary} />}
                    </View>
                    <Pressable accessibilityRole="button" accessibilityLabel="Close QR" onPress={() => setWifiQrUri(null)} style={styles.closeQr}>
                      <Text style={styles.closeScannerText}>Done / Close QR</Text>
                    </Pressable>
                  </View>
                )}
              </View>

              <View style={styles.actionBlock}>
                <Text style={styles.packageTitle}>2. Receive from another phone</Text>
                <Text style={styles.packageHint}>Scan the pairing QR code displayed on your other phone to import the account data.</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Scan Pairing QR Code" onPress={openWifiScanner} style={styles.scanButton}>
                  <Ionicons name="camera-outline" size={20} color={theme.color.brandPrimary} />
                  <Text style={styles.scanButtonText}>Scan Pairing QR Code</Text>
                </Pressable>

                {wifiScanning && (
                  <View style={styles.scanner}>
                    <CameraView
                      style={styles.camera}
                      facing="back"
                      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                      onBarcodeScanned={wifiScanLocked ? undefined : onWifiQrScanned}
                    />
                    <View style={styles.scannerOverlay}>
                      <Text style={styles.scannerText}>Align the Wi-Fi pairing QR inside the frame</Text>
                      <Pressable accessibilityRole="button" accessibilityLabel="Close Scanner" onPress={() => setWifiScanning(false)} style={styles.closeScanner}>
                        <Text style={styles.closeScannerText}>Close Scanner</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* TAB 3: SELF-HOSTED SERVER (EXISTING MANUS COMPONENT) */}
          {activeTab === 'self_hosted' && (
            <>
              <View style={styles.intro}>
                <Text style={styles.eyebrow}>Simple setup</Text>
                <Text style={styles.heroTitle}>Use your own server only when you need more than one device.</Text>
                <Text style={styles.hint}>
                  Ledgr still saves every sale, expense, payment, and stock change on this device first. Nothing here creates a Ledgr cloud account.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Read the simple Private sync guide"
                  testID="open-private-sync-guide"
                  onPress={() => router.push('/private-sync-guide' as any)}
                  style={styles.guideLink}
                >
                  <Text style={styles.disclosureText}>Read the simple guide first</Text>
                  <Ionicons name="arrow-forward" size={16} color={theme.color.brandPrimary} />
                </Pressable>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open guided self-host setup"
                testID="download-self-host-package"
                onPress={() => router.push('/private-sync-guide' as any)}
                style={styles.packageCard}
              >
                <View style={styles.packageCopy}>
                  <Text style={styles.packageTitle}>Download Self-host Package</Text>
                  <Text style={styles.hint}>Windows, macOS, Linux, and Docker bundle</Text>
                  <Text style={styles.packageHint}>Open the guide first. It shows the right one-click installer for your computer, VPS, or NAS.</Text>
                </View>
                <View style={styles.packageAction}>
                  <Ionicons name="download-outline" size={22} color={theme.color.brandPrimary} />
                  <Ionicons name="arrow-forward-outline" size={17} color={theme.color.muted} />
                </View>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open self-host setup guide"
                testID="open-self-host-setup-guide"
                onPress={() => router.push('/private-sync-guide' as any)}
                style={styles.packageGuide}
              >
                <Text style={styles.disclosureText}>Choose your computer, VPS, or NAS setup</Text>
                <Ionicons name="arrow-forward" size={16} color={theme.color.brandPrimary} />
              </Pressable>

              <View style={styles.accordion}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={workflowsOpen ? 'Collapse sync workflows' : 'Expand sync workflows'}
                  onPress={() => setWorkflowsOpen((current) => !current)}
                  style={styles.accordionHeader}
                >
                  <View style={styles.accordionTitleRow}>
                    <Ionicons name="git-network-outline" size={20} color={theme.color.brandPrimary} />
                    <View style={styles.choiceCopy}>
                      <Text style={styles.sectionTitle}>Workflows</Text>
                      <Text style={styles.hint}>Choose a setup path, join devices, and review recovery.</Text>
                    </View>
                  </View>
                  <Ionicons name={workflowsOpen ? 'chevron-up' : 'chevron-down'} size={18} color={theme.color.muted} />
                </Pressable>
                {workflowsOpen ? (
                  <View style={styles.accordionBody}>
                    <View style={styles.steps}>
                      <View style={styles.step}>
                        <Text style={styles.stepNumber}>1</Text>
                        <Text style={styles.stepText}>Choose a path</Text>
                      </View>
                      <View style={styles.step}>
                        <Text style={styles.stepNumber}>2</Text>
                        <Text style={styles.stepText}>Enter a few details</Text>
                      </View>
                      <View style={styles.step}>
                        <Text style={styles.stepNumber}>3</Text>
                        <Text style={styles.stepText}>Review before sync</Text>
                      </View>
                    </View>

                    <View style={styles.card}>
                      <Text style={styles.sectionTitle}>Step 1 · Choose a path</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Join a business with a one-time code"
                        onPress={() => setConnectionPath('join')}
                        style={[styles.choice, connectionPath === 'join' && styles.choiceSelected]}
                      >
                        <Ionicons name="person-add-outline" size={22} color={connectionPath === 'join' ? theme.color.brandPrimary : theme.color.muted} />
                        <View style={styles.choiceCopy}>
                          <Text style={styles.choiceTitle}>Join an existing business</Text>
                          <Text style={styles.hint}>Your administrator gives you a short one-time code.</Text>
                        </View>
                        <Ionicons name={connectionPath === 'join' ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={connectionPath === 'join' ? theme.color.brandPrimary : theme.color.muted} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Set up my own private sync server"
                        onPress={() => setConnectionPath('admin')}
                        style={[styles.choice, connectionPath === 'admin' && styles.choiceSelected]}
                      >
                        <Ionicons name="server-outline" size={22} color={connectionPath === 'admin' ? theme.color.brandPrimary : theme.color.muted} />
                        <View style={styles.choiceCopy}>
                          <Text style={styles.choiceTitle}>Set up my own server</Text>
                          <Text style={styles.hint}>For the owner or administrator who already has a server.</Text>
                        </View>
                        <Ionicons name={connectionPath === 'admin' ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={connectionPath === 'admin' ? theme.color.brandPrimary : theme.color.muted} />
                      </Pressable>
                    </View>

                    {connectionPath === 'join' ? (
                      <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Step 2 · Join your business</Text>
                        <Text style={styles.hint}>Scan the administrator’s QR invitation to fill the server and one-time code. You will still sign in with your own account.</Text>
                        {inviteRole ? (
                          <View style={styles.inviteCallout}>
                            <Ionicons name={inviteRole === 'owner' ? 'shield-checkmark-outline' : 'people-outline'} size={20} color={theme.color.brandPrimary} />
                            <View style={styles.choiceCopy}>
                              <Text style={styles.choiceTitle}>{inviteRole === 'owner' ? 'Owner setup invitation' : `Joining as ${inviteRole}`}</Text>
                              <Text style={styles.hint}>
                                {inviteRole === 'owner'
                                  ? 'You will become the owner of this Business Account.'
                                  : inviteLocationCount
                                  ? `Access is limited to ${inviteLocationCount} selected location${inviteLocationCount === 1 ? '' : 's'}.`
                                  : 'The administrator controls your role and shop/location access.'}
                              </Text>
                            </View>
                          </View>
                        ) : null}
                        <Pressable accessibilityRole="button" accessibilityLabel="Scan QR invitation" testID="scan-sync-invitation" onPress={() => router.push('/sync-scan' as any)} style={styles.primary}>
                          <Ionicons name="qr-code-outline" size={20} color={theme.color.onBrandPrimary} />
                          <Text style={styles.primaryText}>Scan QR invitation</Text>
                        </Pressable>
                        <Text style={styles.label}>Server address</Text>
                        <TextInput accessibilityLabel="Server address" value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder="https://sync.example.com" placeholderTextColor={theme.color.muted} style={inputStyle} />
                        <Text style={styles.label}>Your user ID</Text>
                        <TextInput accessibilityLabel="Your user ID" value={userId} onChangeText={setUserId} autoCapitalize="none" placeholder="you@example.com" placeholderTextColor={theme.color.muted} style={inputStyle} />
                        <Text style={styles.label}>One-time code</Text>
                        <TextInput testID="sync-enrollment-code" accessibilityLabel="One-time enrollment code" value={oneTimeCode} onChangeText={setOneTimeCode} autoCapitalize="characters" placeholder="LGR-…" placeholderTextColor={theme.color.muted} style={inputStyle} />
                        <Text style={styles.label}>Name this device</Text>
                        <TextInput accessibilityLabel="Device name" value={deviceName} onChangeText={setDeviceName} placeholder="Front counter tablet" placeholderTextColor={theme.color.muted} style={inputStyle} />
                        {oidcIssuer.trim() && oidcClientId.trim() ? (
                          <Pressable
                            testID="sign-in-and-join-sync"
                            accessibilityRole="button"
                            accessibilityLabel={inviteRole === 'owner' ? 'Sign in and become owner' : 'Sign in and join business'}
                            disabled={busy || !oneTimeCode.trim() || !serverUrl.trim() || !userId.trim()}
                            onPress={signInAndJoin}
                            style={[styles.primary, (busy || !oneTimeCode.trim() || !serverUrl.trim() || !userId.trim()) && styles.disabled]}
                          >
                            <Text style={styles.primaryText}>{busy ? 'Signing in…' : inviteRole === 'owner' ? 'Sign in and become owner' : 'Sign in and join'}</Text>
                          </Pressable>
                        ) : null}
                        <Text style={styles.label}>Temporary access token fallback</Text>
                        <TextInput
                          accessibilityLabel="Temporary access token fallback"
                          value={token}
                          onChangeText={setToken}
                          autoCapitalize="none"
                          secureTextEntry
                          returnKeyType="done"
                          onSubmitEditing={Keyboard.dismiss}
                          onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120)}
                          placeholder="Used only for custom or manual sign-in"
                          placeholderTextColor={theme.color.muted}
                          style={inputStyle}
                        />
                        <Pressable
                          testID="redeem-sync-enrollment-code"
                          accessibilityRole="button"
                          accessibilityLabel="Join business with one-time code"
                          disabled={busy || !oneTimeCode.trim() || !serverUrl.trim() || !userId.trim() || !token.trim()}
                          onPress={redeemCode}
                          style={[styles.primary, (busy || !oneTimeCode.trim() || !serverUrl.trim() || !userId.trim() || !token.trim()) && styles.disabled]}
                        >
                          <Text style={styles.primaryText}>{busy ? 'Joining…' : 'Join this business'}</Text>
                        </Pressable>
                      </View>
                    ) : (
                      <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Step 2 · Owner setup</Text>
                        <Text style={styles.hint}>Use the guided migration if this is your first device. It checks your backup before anything is shared.</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel="Open guided private sync migration" onPress={() => router.push('/private-sync-migration' as any)} style={styles.primary}>
                          <Text style={styles.primaryText}>Open guided setup</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={advancedOpen ? 'Hide administrator sign-in fields' : 'Show administrator sign-in fields'}
                          onPress={() => setAdvancedOpen((current) => !current)}
                          style={styles.disclosure}
                        >
                          <Text style={styles.disclosureText}>{advancedOpen ? 'Hide administrator sign-in fields' : 'I already have a server — show sign-in fields'}</Text>
                          <Ionicons name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={17} color={theme.color.brandPrimary} />
                        </Pressable>
                        {advancedOpen ? (
                          <>
                            <Text style={styles.label}>Server address</Text>
                            <TextInput accessibilityLabel="Server address" value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder="https://sync.example.com" placeholderTextColor={theme.color.muted} style={inputStyle} />
                            <Text style={styles.label}>Your user ID</Text>
                            <TextInput accessibilityLabel="Your user ID" value={userId} onChangeText={setUserId} autoCapitalize="none" placeholder="you@example.com" placeholderTextColor={theme.color.muted} style={inputStyle} />
                            <Text style={styles.label}>Identity provider address</Text>
                            <TextInput accessibilityLabel="Identity provider address" value={oidcIssuer} onChangeText={setOidcIssuer} autoCapitalize="none" keyboardType="url" placeholder="https://identity.example.com/realms/ledgr" placeholderTextColor={theme.color.muted} style={inputStyle} />
                            <Text style={styles.label}>Application ID</Text>
                            <TextInput accessibilityLabel="Application ID" value={oidcClientId} onChangeText={setOidcClientId} autoCapitalize="none" placeholder="ledgr-mobile" placeholderTextColor={theme.color.muted} style={inputStyle} />
                            <Text style={styles.label}>Permissions</Text>
                            <TextInput accessibilityLabel="Permissions" value={oidcScopes} onChangeText={setOidcScopes} autoCapitalize="none" placeholder="openid profile offline_access" placeholderTextColor={theme.color.muted} style={inputStyle} />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Sign in and enroll this device"
                              disabled={busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()}
                              onPress={enrollOidc}
                              style={[styles.secondary, (busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()) && styles.disabled]}
                            >
                              <Text style={styles.secondaryText}>{busy ? 'Working…' : 'Sign in and enroll'}</Text>
                            </Pressable>
                            <Text style={styles.hint}>The identity provider uses Authorization Code + PKCE. Ask your administrator for the redirect address if needed.</Text>
                            <Text style={styles.label}>Manual token fallback</Text>
                            <TextInput
                              accessibilityLabel="Manual access token fallback"
                              value={token}
                              onChangeText={setToken}
                              autoCapitalize="none"
                              secureTextEntry
                              returnKeyType="done"
                              onSubmitEditing={Keyboard.dismiss}
                              onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120)}
                              placeholder="Stored only in SecureStore"
                              placeholderTextColor={theme.color.muted}
                              style={inputStyle}
                            />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Enroll with manual token"
                              disabled={busy || !serverUrl.trim() || !userId.trim() || !token.trim()}
                              onPress={enroll}
                              style={[styles.secondary, (busy || !serverUrl.trim() || !userId.trim() || !token.trim()) && styles.disabled]}
                            >
                              <Text style={styles.secondaryText}>{status?.configured ? 'Update token and re-enroll' : 'Enroll with manual token'}</Text>
                            </Pressable>
                          </>
                        ) : null}
                      </View>
                    )}
                  </View>
                ) : null}
              </View>

              <View style={styles.accordion}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={systemOpen ? 'Collapse sync system settings' : 'Expand sync system settings'}
                  onPress={() => setSystemOpen((current) => !current)}
                  style={styles.accordionHeader}
                >
                  <View style={styles.accordionTitleRow}>
                    <Ionicons name="server-outline" size={20} color={theme.color.brandPrimary} />
                    <View style={styles.choiceCopy}>
                      <Text style={styles.sectionTitle}>System</Text>
                      <Text style={styles.hint}>Review status, recovery, health, and enrolled devices.</Text>
                    </View>
                  </View>
                  <Ionicons name={systemOpen ? 'chevron-up' : 'chevron-down'} size={18} color={theme.color.muted} />
                </Pressable>
                {systemOpen ? (
                  <View style={styles.accordionBody}>
                    <View style={styles.card}>
                      <Text style={styles.sectionTitle}>Step 3 · Review and finish</Text>
                      <Text style={styles.hint}>The server never replaces this device’s raw SQLite file. If something is wrong, Ledgr stops and asks you what to do.</Text>
                      {status?.configured ? (
                        <>
                          <View style={styles.statusSummary}>
                            <View
                              style={[
                                styles.statusDot,
                                {
                                  backgroundColor: status.recoveryRequired || status.conflicts
                                    ? theme.color.warning || theme.color.brandPrimary
                                    : theme.color.success || theme.color.brandPrimary,
                                },
                              ]}
                            />
                            <View style={styles.choiceCopy}>
                              <Text style={styles.choiceTitle}>
                                {status.bootstrapRequired
                                  ? 'Ready for first snapshot review'
                                  : status.recoveryRequired
                                  ? 'Recovery needs your approval'
                                  : status.enabled
                                  ? 'Private sync is on'
                                  : 'Device is enrolled but sync is off'}
                              </Text>
                              <Text style={styles.hint}>
                                {status.pending} waiting · {status.conflicts} conflicts · cursor {status.cursor ?? 0}
                              </Text>
                            </View>
                          </View>
                          <View style={styles.row}>
                            <Pressable accessibilityRole="button" accessibilityLabel="Sync now" disabled={busy || !status.enabled} onPress={sync} style={styles.primarySmall}>
                              <Text style={styles.primaryText}>Sync now</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" accessibilityLabel="Retry sync" disabled={busy || !status.enabled || !status.retryable} onPress={retry} style={styles.secondary}>
                              <Text style={styles.secondaryText}>Retry</Text>
                            </Pressable>
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={recoveryOpen ? 'Hide advanced recovery actions' : 'Show advanced recovery actions'}
                            onPress={() => setRecoveryOpen((current) => !current)}
                            style={styles.disclosure}
                          >
                            <Text style={styles.disclosureText}>{recoveryOpen ? 'Hide advanced recovery actions' : 'Show advanced recovery actions'}</Text>
                            <Ionicons name={recoveryOpen ? 'chevron-up' : 'chevron-down'} size={17} color={theme.color.brandPrimary} />
                          </Pressable>
                          {recoveryOpen ? (
                            <View style={styles.recoveryBox}>
                              <Text style={styles.hint}>
                                {status.bookEpoch ? `Epoch ${status.bookEpoch}` : 'No epoch reported'}
                                {status.lastSyncAt ? ` · last sync ${new Date(status.lastSyncAt).toLocaleString()}` : ''}
                                {status.lastSyncError ? ` · error: ${status.lastSyncError}` : ''}
                              </Text>
                              <View style={styles.row}>
                                <Pressable accessibilityRole="button" accessibilityLabel="Verify checkpoint" disabled={busy || !status.enabled} onPress={verify} style={styles.secondary}>
                                  <Text style={styles.secondaryText}>Verify</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" accessibilityLabel="Publish snapshot" disabled={busy || (!status.enabled && !status.bootstrapRequired)} onPress={publish} style={styles.secondary}>
                                  <Text style={styles.secondaryText}>{status.bootstrapRequired ? 'Publish first snapshot' : 'Publish snapshot'}</Text>
                                </Pressable>
                              </View>
                              {status.recoveryRequired && !status.bootstrapRequired ? (
                                <>
                                  <Pressable accessibilityRole="button" accessibilityLabel="Open encrypted backup" disabled={busy} onPress={() => router.push('/backup-recovery' as any)} style={styles.linkButton}>
                                    <Text style={styles.disclosureText}>1. Make sure you have an encrypted backup</Text>
                                  </Pressable>
                                  <Pressable accessibilityRole="button" accessibilityLabel="Install validated server snapshot" disabled={busy} onPress={installSnapshot} style={styles.linkButton}>
                                    <Text style={styles.disclosureText}>2. Install validated server snapshot</Text>
                                  </Pressable>
                                  <Pressable accessibilityRole="button" accessibilityLabel="Replace shared epoch" disabled={busy} onPress={advanceEpoch} style={styles.linkButton}>
                                    <Text style={styles.disclosureText}>3. Replace shared epoch</Text>
                                  </Pressable>
                                </>
                              ) : null}
                              <View style={styles.row}>
                                {!status.enabled && !status.recoveryRequired ? (
                                  <Pressable accessibilityRole="button" accessibilityLabel="Turn on private sync" disabled={busy} onPress={enable} style={styles.secondary}>
                                    <Text style={styles.secondaryText}>Turn on sync</Text>
                                  </Pressable>
                                ) : (
                                  <Pressable accessibilityRole="button" accessibilityLabel="Turn off private sync" disabled={busy || !status.enabled} onPress={disable} style={styles.secondary}>
                                    <Text style={styles.secondaryText}>Turn off sync</Text>
                                  </Pressable>
                                )}
                              </View>
                            </View>
                          ) : null}
                        </>
                      ) : (
                        <Text style={styles.hint}>Nothing is connected yet. Choose a path above when you are ready.</Text>
                      )}
                    </View>

                    <Pressable accessibilityRole="button" accessibilityLabel="Open Sync Health" testID="open-sync-health" onPress={() => router.push('/sync-health' as any)} style={styles.adminLink}>
                      <Ionicons name="pulse-outline" size={21} color={theme.color.brandPrimary} />
                      <View style={styles.choiceCopy}>
                        <Text style={styles.choiceTitle}>Sync Health</Text>
                        <Text style={styles.hint}>See waiting work, errors, and server status.</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel="Open Sync Administration" testID="open-sync-admin" onPress={() => router.push('/sync-admin' as any)} style={styles.adminLink}>
                      <Ionicons name="people-outline" size={21} color={theme.color.brandPrimary} />
                      <View style={styles.choiceCopy}>
                        <Text style={styles.choiceTitle}>Sync Administration</Text>
                        <Text style={styles.hint}>Manage devices, roles, and locations.</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
                    </Pressable>
                    {status?.configured ? (
                      <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Enrolled devices</Text>
                        <Text style={styles.hint}>Revoking a device stops its future sync without deleting the business book.</Text>
                        {devices.length ? (
                          devices.map((device) => (
                            <View key={device.deviceId} style={styles.device}>
                              <View style={styles.choiceCopy}>
                                <Text style={styles.choiceTitle}>{device.current ? 'This device' : `Device ${device.deviceId.slice(0, 12)}…`}</Text>
                                <Text style={styles.hint}>
                                  {device.revokedAt ? 'Revoked' : device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Enrolled'}
                                  {device.expiresAt && !device.revokedAt ? ` · expires ${new Date(device.expiresAt).toLocaleDateString()}` : ''}
                                </Text>
                              </View>
                              {!device.revokedAt ? (
                                <Pressable accessibilityRole="button" accessibilityLabel={`Revoke ${device.current ? 'this device' : 'device'}`} disabled={busy} onPress={() => revoke(device)} style={styles.revoke}>
                                  <Text style={styles.revokeText}>Revoke</Text>
                                </Pressable>
                              ) : null}
                            </View>
                          ))
                        ) : (
                          <Text style={styles.hint}>Device list is unavailable or empty.</Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </>
          )}

          {message ? <Text style={styles.message}>{message}</Text> : null}
          <View style={{ height: 38 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: any) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    keyboard: { flex: 1 },
    scroll: { padding: theme.spacing.lg, paddingBottom: 40, gap: 12 },
    tabBar: { flexDirection: 'row', backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: 4, borderWidth: 1, borderColor: theme.color.border, marginBottom: 4 },
    tabItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: theme.radius.sm },
    tabItemActive: { backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1 },
    tabText: { color: theme.color.muted, fontSize: 13, fontWeight: '700' },
    tabTextActive: { color: theme.color.onSurface, fontWeight: '800' },
    badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 2 },
    badgeText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800' },
    passphraseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
    inlineAction: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800' },
    subHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
    actionBlock: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 14, marginTop: 6, gap: 8 },
    secondaryButtonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 12, marginTop: 4 },
    secondaryButtonText: { color: theme.color.onSurface, fontWeight: '800' },
    qrPreview: { alignItems: 'center', gap: 8, borderTopColor: theme.color.border, borderTopWidth: 1, marginTop: 8, paddingTop: 14 },
    qrTitle: { color: theme.color.onSurface, fontWeight: '800', textAlign: 'center' },
    qrHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
    qrSurface: { padding: 14, backgroundColor: '#fff', borderRadius: theme.radius.md, marginVertical: 6 },
    closeQr: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingHorizontal: 16, paddingVertical: 9 },
    scanButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 12, marginTop: 4 },
    scanButtonText: { color: theme.color.brandPrimary, fontWeight: '800' },
    scanner: { height: 280, overflow: 'hidden', borderRadius: theme.radius.md, backgroundColor: '#000', marginTop: 8 },
    camera: { flex: 1 },
    scannerOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', alignItems: 'center', padding: 16, backgroundColor: 'transparent' },
    scannerText: { color: '#fff', textAlign: 'center', fontWeight: '800', textShadowColor: '#000', textShadowRadius: 4 },
    closeScanner: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingHorizontal: 16, paddingVertical: 9, marginTop: 10 },
    closeScannerText: { color: theme.color.onBrandPrimary, fontWeight: '800' },
    mono: { color: theme.color.muted, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    intro: { paddingHorizontal: 3, paddingTop: 3, gap: 6 },
    guideLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
    eyebrow: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
    heroTitle: { color: theme.color.onSurface, fontSize: 22, lineHeight: 28, fontWeight: '800' },
    steps: { flexDirection: 'row', backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 11, gap: 8 },
    step: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    stepNumber: { width: 22, height: 22, borderRadius: 11, textAlign: 'center', textAlignVertical: 'center', backgroundColor: theme.color.brandPrimary, color: theme.color.onBrandPrimary, fontWeight: '800', fontSize: 12 },
    stepText: { color: theme.color.muted, fontSize: 11, lineHeight: 14, flexShrink: 1 },
    card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 12 },
    accordion: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, overflow: 'hidden' },
    accordionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, gap: 12 },
    accordionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
    accordionBody: { gap: 12, paddingHorizontal: 12, paddingBottom: 12 },
    inviteCallout: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: theme.color.surfaceTertiary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12 },
    packageCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16 },
    packageCopy: { flex: 1, gap: 4 },
    inlineCode: { color: theme.color.onSurface, fontWeight: '800' },
    packageTitle: { color: theme.color.onSurface, fontSize: 16, fontWeight: '800' },
    packageHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16 },
    packageAction: { width: 54, minHeight: 54, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', gap: 2 },
    packageGuide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingVertical: 2 },
    sectionTitle: { color: theme.color.onSurface, fontSize: 17, fontWeight: '800' },
    hint: { color: theme.color.muted, fontSize: 13, lineHeight: 18 },
    label: { color: theme.color.onSurface, fontSize: 12, fontWeight: '700', marginTop: 8, marginBottom: 2 },
    input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11, marginTop: 2 },
    choice: { flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12 },
    choiceSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceTertiary },
    choiceCopy: { flex: 1, gap: 2 },
    choiceTitle: { color: theme.color.onSurface, fontWeight: '800', fontSize: 14 },
    statusSummary: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 3 },
    statusDot: { width: 11, height: 11, borderRadius: 6 },
    primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 5 },
    primarySmall: { flex: 1, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 11, alignItems: 'center' },
    primaryText: { color: theme.color.onBrandPrimary, fontWeight: '800' },
    disabled: { opacity: 0.45 },
    secondary: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
    secondaryText: { color: theme.color.onSurface, fontWeight: '700' },
    disclosure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9 },
    disclosureText: { color: theme.color.brandPrimary, fontWeight: '800', fontSize: 13 },
    recoveryBox: { borderTopColor: theme.color.border, borderTopWidth: 1, paddingTop: 10, gap: 8 },
    linkButton: { paddingVertical: 6 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 4 },
    adminLink: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 14 },
    device: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 11, marginTop: 5 },
    revoke: { padding: 9 },
    revokeText: { color: theme.color.danger || '#c53b3b', fontWeight: '800' },
    message: { color: theme.color.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: 3 },
  });
