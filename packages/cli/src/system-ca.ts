import tls from "node:tls";

export type TlsLike = {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

export function trustSystemCertificates(store: TlsLike = tls as TlsLike): boolean {
  if (typeof store.getCACertificates !== "function" || typeof store.setDefaultCACertificates !== "function") {
    return false;
  }
  try {
    store.setDefaultCACertificates([...new Set([...store.getCACertificates("default"), ...store.getCACertificates("system")])]);
    return true;
  } catch {
    return false;
  }
}
