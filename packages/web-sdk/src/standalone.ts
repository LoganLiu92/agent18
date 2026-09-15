import type { Agent18Options } from './index.js';
/** Call from a user click. Credentials use origin-bound postMessage, never URL/storage. */
export function openSupportPage(options: Agent18Options) {
  const base = new URL(options.baseUrl || location.origin, location.href);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('SUPPORT_URL_INVALID');
  const channel = crypto.randomUUID();
  const url = new URL('/support', base);
  url.searchParams.set('project', options.projectKey);
  url.searchParams.set('origin', location.origin);
  url.searchParams.set('channel', channel);
  let child: Window | null = null,
    closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Coalesce simultaneous requests from the page without silently dropping a valid request.
  let pending: Promise<string> | undefined;
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (
      closed ||
      !child ||
      event.source !== child ||
      event.origin !== base.origin ||
      !data ||
      data.type !== 'agent18:request-token' ||
      data.channel !== channel ||
      data.projectKey !== options.projectKey ||
      typeof data.requestId !== 'string' ||
      !data.requestId ||
      data.requestId.length > 100
    )
      return;
    pending ??= Promise.resolve()
      .then(options.getToken)
      .finally(() => {
        pending = undefined;
      });
    void pending
      .then((token) => {
        if (!closed && !child?.closed)
          child?.postMessage(
            { type: 'agent18:token', channel, requestId: data.requestId, token },
            base.origin,
          );
      })
      .catch(() => {
        if (!closed && !child?.closed)
          child?.postMessage(
            { type: 'agent18:identity-error', channel, requestId: data.requestId },
            base.origin,
          );
      });
  };
  const destroy = () => {
    closed = true;
    window.removeEventListener('message', handler);
    clearInterval(timer);
  };
  window.addEventListener('message', handler);
  try {
    child = window.open(url.href, '_blank');
  } catch (error) {
    destroy();
    throw error;
  }
  if (!child) {
    destroy();
    throw new Error('POPUP_BLOCKED');
  }
  timer = setInterval(() => {
    if (child?.closed) destroy();
  }, 1500);
  return { window: child, destroy };
}
