import type { PageCapture } from '@agent18/contracts';

export type CaptureOptions = { enabled?: boolean; pageText?: boolean; screenshot?: boolean };
export const privateSelector =
  'input,textarea,select,[contenteditable],script,style,noscript,iframe,[data-agent18-private],[data-agent18-widget],[data-html2canvas-ignore]';
export function cleanText(text: string, limit = 500) {
  return text
    .replace(/Bearer\s+[^\s]+/gi, '[token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(
      /((?:password|secret|api[_-]?key|token|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi,
      '$1[redacted]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/[^\s"']+/g, (v) => {
      try {
        return new URL(v).pathname;
      } catch {
        return '[url]';
      }
    })
    .slice(0, limit);
}
export function captureCollector(options: CaptureOptions = {}) {
  const errors: string[] = [],
    breadcrumbs: PageCapture['breadcrumbs'] = [],
    requests: PageCapture['requests'] = [];
  if (typeof window === 'undefined' || options.enabled === false)
    return { dispose() {}, snapshot: (): PageCapture | undefined => undefined };
  const path = (url: string) => {
    try {
      return new URL(url, location.href).pathname.slice(0, 256);
    } catch {
      return '';
    }
  };
  const error = (e: ErrorEvent) => {
    errors.push(cleanText(e.message));
    if (errors.length > 10) errors.shift();
  };
  const rejection = (e: PromiseRejectionEvent) => {
    errors.push(cleanText(e.reason instanceof Error ? e.reason.message : 'Unhandled promise rejection'));
    if (errors.length > 10) errors.shift();
  };
  const add = (type: 'click' | 'navigation', detail: string) => {
    breadcrumbs.push({ at: new Date().toISOString(), type, detail: cleanText(detail, 200) });
    if (breadcrumbs.length > 20) breadcrumbs.shift();
  };
  const click = (e: MouseEvent) => {
    const node = e.target instanceof Element ? e.target : null;
    if (!node || node.closest(privateSelector)) return;
    const button = node.closest('button,a,[role=button]');
    if (button) add('click', button.textContent?.trim().slice(0, 100) || button.tagName);
  };
  const navigation = () => add('navigation', path(location.href));
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  document.addEventListener('click', click, true);
  window.addEventListener('popstate', navigation);
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const item of list.getEntries() as PerformanceResourceTiming[]) {
        const status = item.responseStatus ?? 0;
        if (status < 400) continue;
        requests.push({
          path: path(item.name),
          status,
          durationMs: Math.min(3600000, Math.round(item.duration)),
        });
        if (requests.length > 10) requests.shift();
      }
    });
    observer.observe({ type: 'resource', buffered: false });
  } catch {
    /* Older browsers can still report page and error context. */
  }
  return {
    dispose() {
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', navigation);
      observer?.disconnect();
      errors.length = breadcrumbs.length = requests.length = 0;
    },
    snapshot(): PageCapture {
      let text = '';
      if (options.pageText !== false) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let visited = 0,
          node: Node | null;
        while ((node = walker.nextNode()) && visited++ < 15000 && text.length < 8000) {
          const parent = node.parentElement;
          if (!parent || parent.closest(privateSelector) || !parent.getClientRects().length) continue;
          const style = getComputedStyle(parent);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          text += ' ' + (node.textContent ?? '').trim();
        }
      }
      return {
        capturedAt: new Date().toISOString(),
        page: {
          title: cleanText(document.title, 200),
          path: path(location.href),
          language: navigator.language.slice(0, 32),
          width: Math.min(10000, innerWidth),
          height: Math.min(10000, innerHeight),
          online: navigator.onLine,
        },
        text: cleanText(text.trim(), 8000),
        errors: [...errors],
        breadcrumbs: [...breadcrumbs],
        requests: [...requests],
        notice:
          '已排除表单值、标记的私密区域、Cookie、存储和网络正文；请检查预览。页面文本和浏览器可观测错误受长度与兼容性限制。',
      };
    },
  };
}
