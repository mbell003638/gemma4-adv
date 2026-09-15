import fs from 'fs';
import path from 'path';

const screen = fs.readFileSync(path.join(__dirname, '..', 'app', 'sync-settings.tsx'), 'utf8');

describe('sync settings offers all three transports', () => {
  it('lets the user choose between cloud, Wi-Fi and a self-hosted server', () => {
    expect(screen).toContain('sync-tab-cloud');
    expect(screen).toContain('sync-tab-wifi');
    expect(screen).toContain('sync-tab-self-hosted');
  });

  it('keeps the self-hosted path reachable rather than replacing it', () => {
    // The server transport is the audited one and stays available; the new
    // transports sit beside it.
    expect(screen).toContain("activeTab === 'self_hosted'");
    expect(screen).toContain('serverUrl');
  });

  it('wires cloud sync to a passphrase the user can generate', () => {
    expect(screen).toContain('cloud-passphrase');
    expect(screen).toContain('cloud-generate-passphrase');
    expect(screen).toContain('generateSyncPassphrase');
    expect(screen).toContain('saveCloudSyncConfig');
  });

  it('offers a second device a way in with the passphrase alone', () => {
    expect(screen).toContain('cloud-join');
    expect(screen).toContain('adoptCloudSyncKey');
  });

  it('warns that the passphrase cannot be recovered', () => {
    expect(screen).toMatch(/only thing that unlocks|nobody can recover/i);
  });

  it('wires Wi-Fi pairing, which needs no internet', () => {
    expect(screen).toContain('wifi-create-session');
    expect(screen).toContain('createWifiP2pSession');
    expect(screen).toContain('parseWifiP2pQr');
    expect(screen).toMatch(/no internet/i);
  });

  it('does not claim a nearby Wi-Fi book transfer succeeded', () => {
    expect(screen).toContain('parseWifiP2pQr');
    expect(screen).not.toContain('Synchronized successfully with nearby phone over Wi-Fi.');
    expect(screen).toContain('Nearby Wi-Fi book transfer is not available yet. Pairing QR is not a completed sync.');
  });

  it('does not present a local Drive passphrase save as live Google sync', () => {
    expect(screen).not.toContain('Connect Google Drive');
    expect(screen).not.toContain('Save & Sync Google Drive');
    expect(screen).toContain('Save passphrase locally');
    expect(screen).toContain('Passphrase and Cloud Drive configuration saved locally. Google Drive transfer is not active until OAuth exists.');
  });
});
