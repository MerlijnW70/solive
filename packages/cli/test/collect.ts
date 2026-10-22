export const COLLECT_EVERY = 8;

let built = 0;

export function collectDropped(): void {
  built++;
  if (built % COLLECT_EVERY === 0) {
    (globalThis as { gc?: () => void }).gc?.();
  }
}
