let source: () => AbortSignal | undefined = () => undefined;

export const stopsFrom = (next: () => AbortSignal | undefined): void => {
  source = next;
};

export const scopedStop = (): AbortSignal | undefined => source();
