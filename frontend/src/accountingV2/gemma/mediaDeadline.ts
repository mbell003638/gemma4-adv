export async function bounded<T>(work: () => Promise<T>, ms: number, code: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = Date.now() + ms;
  try {
    if (signal?.aborted) throw new Error('CANCELLED');
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(code);
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error('CANCELLED');
        if (Date.now() >= deadline) throw new Error(code);
        return work();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
        abort = () => reject(new Error('CANCELLED'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('GEMMA_MEDIA_TIMEOUT');
  return ms;
}
