// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How much has been downloaded since the page opened – the program, the
 * map, the tiles, the pictures – for the loading screens ("12.4 MB").
 * Counted from the browser's own resource timing (the bytes that came over
 * the network; what came from the cache counts as nothing).
 */

let bytes = 0;
let started = false;

/** Begin counting (once; harmless where the browser cannot tell). */
export function startNetStats(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    // (the default buffer holds 250 entries: a map in tiles asks for many more)
    performance.setResourceTimingBufferSize?.(100000);
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) bytes += size(e);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) bytes += size(e);
    }).observe({ type: 'resource', buffered: false });
    performance.addEventListener?.('resourcetimingbufferfull', () => performance.clearResourceTimings());
  } catch {
    /* (no resource timing: nothing is shown) */
  }
}

function size(e: PerformanceResourceTiming): number {
  // transferSize: header and body as they came; 0 from the cache (or across origins without permission)
  return e.transferSize > 0 ? e.transferSize : 0;
}

/** Bytes downloaded so far. */
export function downloaded(): number {
  return bytes;
}

/** "12.4 MB" (or kB below one megabyte), in the language's number format. */
export function formatBytes(n: number, locale = 'en'): string {
  const mb = n / 1e6;
  const f = (v: number, d: number): string => v.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  return mb >= 1 ? `${f(mb, mb >= 100 ? 0 : 1)} MB` : `${f(n / 1e3, 0)} kB`;
}
