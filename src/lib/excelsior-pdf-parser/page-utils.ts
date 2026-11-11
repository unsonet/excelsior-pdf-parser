
  // Gives control to the browser (paint/input) between pieces of heavy synchronous work.
  // MessageChannel provides minimal latency and works in both the browser and node18 (nodeConfig).
  export function yieldToMain(): Promise<void> {
    if (typeof MessageChannel !== 'undefined') {
      return new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port2.onmessage = () => resolve();
        channel.port1.postMessage(null);
      });
    }
    return new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  // Turns the pages option into a specific list of page numbers (1-based).
  // Without pages, the behavior is the same as before: all pages.
  export function resolvePagesToProcess(numPages: number, pages?: number[] | { from?: number; to?: number }): number[] {
    if (!pages) {
      return Array.from({ length: numPages }, (_, i) => i + 1);
    }
    if (Array.isArray(pages)) {
      return pages.filter(p => p >= 1 && p <= numPages);
    }
    const from = Math.max(1, pages.from || 1);
    const to = Math.min(numPages, pages.to || numPages);
    const arr: number[] = [];
    for (let p = from; p <= to; p++) arr.push(p);
    return arr;
  }