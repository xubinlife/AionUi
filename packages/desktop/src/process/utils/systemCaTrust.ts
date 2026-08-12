/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import { app, session, type Certificate, type Session } from 'electron';

let linuxSystemCaPem: string[] | undefined;
let linuxSystemCaCertificates: X509Certificate[] | undefined;
const configuredSessions = new WeakSet<Session>();

function getLinuxSystemCaPem(): string[] {
  if (process.platform !== 'linux' || typeof tls.getCACertificates !== 'function') return [];
  if (linuxSystemCaPem) return linuxSystemCaPem;

  try {
    linuxSystemCaPem = tls.getCACertificates('system');
  } catch {
    linuxSystemCaPem = [];
  }
  return linuxSystemCaPem;
}

function getLinuxSystemCaCertificates(): X509Certificate[] {
  if (linuxSystemCaCertificates) return linuxSystemCaCertificates;

  linuxSystemCaCertificates = getLinuxSystemCaPem().flatMap((pem) => {
    try {
      return [new X509Certificate(pem)];
    } catch {
      return [];
    }
  });
  return linuxSystemCaCertificates;
}

function configureNodeSystemCaTrust(): void {
  if (process.platform !== 'linux') return;

  // Child Node runtimes (AionCore-managed MCP tools included) inherit this.
  process.env.NODE_USE_SYSTEM_CA = '1';

  // NODE_USE_SYSTEM_CA is read at Node startup, so update this already-running
  // Electron main process explicitly as well.
  if (typeof tls.setDefaultCACertificates !== 'function') return;
  const systemCerts = getLinuxSystemCaPem();
  if (!systemCerts.length) return;

  try {
    const defaultCerts = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...new Set([...defaultCerts, ...systemCerts])]);
  } catch {
    // Keep Node's bundled CA set if the runtime cannot read the system store.
  }
}

function isTrustedByLinuxSystemCa(certificate: Certificate, hostname: string): boolean {
  try {
    const systemCas = getLinuxSystemCaCertificates();
    if (!systemCas.length) return false;

    const leaf = new X509Certificate(certificate.data);
    if (!leaf.checkHost(hostname)) return false;

    const seen = new Set<string>();
    let current: Certificate | undefined = certificate;
    while (current?.data && !seen.has(current.data)) {
      seen.add(current.data);
      const currentCert = new X509Certificate(current.data);
      const now = Date.now();
      if (now < Date.parse(currentCert.validFrom) || now > Date.parse(currentCert.validTo)) return false;

      const issuer = current.issuerCert;
      if (issuer?.data && issuer.data !== current.data) {
        const issuerCert = new X509Certificate(issuer.data);
        if (!currentCert.verify(issuerCert.publicKey)) return false;
        current = issuer;
        continue;
      }

      for (const ca of systemCas) {
        if (currentCert.raw.equals(ca.raw)) return true;
        if (currentCert.issuer === ca.subject && currentCert.verify(ca.publicKey)) return true;
      }
      return false;
    }
  } catch {
    return false;
  }

  return false;
}

function configureElectronSessionSystemCaTrust(ses: Session): void {
  if (process.platform !== 'linux' || configuredSessions.has(ses) || !getLinuxSystemCaPem().length) return;
  configuredSessions.add(ses);

  ses.setCertificateVerifyProc((request, callback) => {
    if (!request.verificationResult.includes('CERT_AUTHORITY_INVALID')) {
      callback(-3);
      return;
    }

    const certificate = request.validatedCertificate || request.certificate;
    callback(isTrustedByLinuxSystemCa(certificate, request.hostname) ? 0 : -3);
  });
}

if (process.platform === 'linux') {
  configureNodeSystemCaTrust();

  // Apply the same system-CA trust policy to every Electron/Chromium session,
  // including electron-updater's dedicated session and future custom sessions.
  app.on('session-created', configureElectronSessionSystemCaTrust);
  void app.whenReady().then(() => configureElectronSessionSystemCaTrust(session.defaultSession));
}
