// SPDX-License-Identifier: MIT
// Browser-safe identity helpers. An entity is a hint within a trusted scope, never an authorization.
export type EntityIdentity = { namespace?: string; type: string; id: string };

export function isEntityIdentity(value: unknown): value is EntityIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entity = value as Record<string, unknown>;
  return (
    Object.keys(entity).every((key) => ['namespace', 'type', 'id'].includes(key)) &&
    typeof entity.type === 'string' &&
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(entity.type) &&
    typeof entity.id === 'string' &&
    entity.id.length > 0 &&
    entity.id.length <= 128 &&
    (entity.namespace === undefined ||
      (typeof entity.namespace === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(entity.namespace)))
  );
}

/** Missing namespace is a distinct legacy identity, not a wildcard. Preserve case and opaque IDs. */
export function entityKey(entity: EntityIdentity): string {
  return JSON.stringify([entity.namespace ?? null, entity.type, entity.id]);
}

export function sameEntity(a?: EntityIdentity, b?: EntityIdentity): boolean {
  return a === undefined || b === undefined ? a === b : entityKey(a) === entityKey(b);
}

export function entityLabel(entity: EntityIdentity): string {
  return [entity.namespace, entity.type, entity.id].filter((value) => value !== undefined).join(' / ');
}
