// SPDX-License-Identifier: MIT
// Browser-safe context helpers are also distributed with the MIT Web SDK.
import type { BusinessEvent, ClientContext } from './index.js';
import { sameEntity } from './entity.js';

export const contextEventTtlMs = 10 * 60 * 1000;
export function recentEvents(events: BusinessEvent[] = [], now = Date.now()) {
  return events
    .filter((event) => {
      const at = Date.parse(event.at);
      return at <= now + 30000 && now - at <= contextEventTtlMs;
    })
    .slice(-5);
}
/** Host hints only. A later success for the same operation/object retires its earlier failure. */
export function latestFailure(context?: ClientContext, now = Date.now()) {
  const events = recentEvents(context?.events, now);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'business.operation.failed') continue;
    if (context?.entity && event.entity && !sameEntity(context.entity, event.entity)) continue;
    if (
      events
        .slice(i + 1)
        .some((next) => next.operation === event.operation && sameEntity(next.entity, event.entity))
    )
      continue;
    return event;
  }
}
