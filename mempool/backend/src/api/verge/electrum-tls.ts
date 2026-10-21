import { createHash, timingSafeEqual } from 'crypto';
import { checkServerIdentity, PeerCertificate } from 'tls';

export interface ElectrumTlsPeer {
  authorized: boolean;
  getPeerCertificate(): PeerCertificate;
}

/** The upstream client accepts any certificate; verify its real TLSSocket before permitting chain/address reads. */
export function assertElectrumTlsPeer(socket: ElectrumTlsPeer | undefined, hostname: string, fingerprint = ''): void {
  if (!socket || typeof socket.getPeerCertificate !== 'function') { throw new Error('Electrum TLS peer is unavailable'); }
  const certificate = socket.getPeerCertificate();
  if (!certificate?.raw?.length) { throw new Error('Electrum TLS certificate is unavailable'); }
  if (fingerprint) {
    if (!/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(fingerprint)) { throw new Error('Invalid Electrum certificate SHA256 fingerprint'); }
    const expected = Buffer.from(fingerprint.replace(/:/g, ''), 'hex');
    const actual = createHash('sha256').update(certificate.raw).digest();
    if (!timingSafeEqual(expected, actual)) { throw new Error('Electrum TLS certificate fingerprint mismatch'); }
    return;
  }
  if (socket.authorized !== true || checkServerIdentity(hostname, certificate)) {
    throw new Error('Electrum TLS certificate is untrusted or does not match the configured host');
  }
}
