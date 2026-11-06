/** Bound the entire operation, including response streaming and noncooperative fetches. */
export async function withDeadline<T>(
  signal: AbortSignal,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError')
  const controller = new AbortController()
  const abort = () => controller.abort()
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new DOMException('Operation aborted', 'AbortError')),
      { once: true },
    )
  })
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, ms)
  try {
    if (controller.signal.aborted)
      throw new DOMException('Operation aborted', 'AbortError')
    const result = await Promise.race([run(controller.signal), aborted])
    if (controller.signal.aborted)
      throw new DOMException('Operation aborted', 'AbortError')
    return result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
