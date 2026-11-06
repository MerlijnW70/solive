export type Elapsed = () => number;

export const monotonic: Elapsed = () => performance.now();

export const elapsedOf = (clock: { elapsed?: Elapsed }): number => (clock.elapsed === undefined ? monotonic() : clock.elapsed());

export function secondsLeft(seconds: number, elapsed: Elapsed = monotonic): () => number {
  const deadline = elapsed() + seconds * 1000;
  return () => Math.max(0, deadline - elapsed()) / 1000;
}
