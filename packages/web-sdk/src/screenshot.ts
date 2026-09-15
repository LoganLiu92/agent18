import html2canvasModule, { type Options } from 'html2canvas';
import { privateSelector, cleanText } from './capture.js';
const html2canvas = html2canvasModule as unknown as (
  element: HTMLElement,
  options: Partial<Options>,
) => Promise<HTMLCanvasElement>;

/** Optional separate bundle: capture the current viewport after removing private elements. */
export async function captureViewport(): Promise<string | undefined> {
  const canvas = await html2canvas(document.body, {
    logging: false,
    allowTaint: false,
    useCORS: false,
    imageTimeout: 1500,
    scale: Math.min(1, 1200 / innerWidth),
    width: innerWidth,
    height: innerHeight,
    x: scrollX,
    y: scrollY,
    backgroundColor: '#ffffff',
    ignoreElements: (e) =>
      (e.tagName !== 'STYLE' && e.matches(privateSelector)) ||
      e.closest('[data-agent18-private],[data-agent18-widget]') !== null ||
      ['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(e.tagName),
    onclone: (doc) => {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      let count = 0;
      while ((node = walker.nextNode())) {
        if (++count > 30000) throw new Error('CAPTURE_PAGE_TOO_LARGE');
        if (node.parentElement?.closest('script,style')) continue;
        node.textContent = cleanText(node.textContent ?? '', 8000);
      }
      for (const e of doc.querySelectorAll<HTMLElement>('*')) e.style.backgroundImage = 'none';
    },
  });
  for (const quality of [0.7, 0.45, 0.2]) {
    const image = canvas.toDataURL('image/jpeg', quality);
    if (image.length <= 700000) return image;
  }
  return undefined;
}
