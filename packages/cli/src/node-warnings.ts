export type WarningSource = {
  listeners(event: "warning"): ((warning: Error) => void)[];
  removeAllListeners(event: "warning"): unknown;
  on(event: "warning", listener: (warning: Error) => void): unknown;
};

export const WEB_CRYPTO_EXPERIMENTAL = /^The (X25519|Ed25519) Web Crypto API algorithm is an experimental feature/;

export const isWebCryptoExperimental = (warning: Error): boolean => warning.name === "ExperimentalWarning" && WEB_CRYPTO_EXPERIMENTAL.test(warning.message);

export function quietWebCryptoWarnings(source: WarningSource = process as unknown as WarningSource): void {
  const shown = source.listeners("warning");
  source.removeAllListeners("warning");
  source.on("warning", (warning) => {
    if (isWebCryptoExperimental(warning)) {
      return;
    }
    for (const listener of shown) {
      listener(warning);
    }
  });
}
