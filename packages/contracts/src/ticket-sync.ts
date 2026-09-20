import { z } from 'zod';
import { analyticsConfigSchema } from './analytics.js';
export const ticketSyncConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: analyticsConfigSchema.shape.baseUrl,
    credentialEnv: z.string().regex(/^AGENT18_SYNC_[A-Z0-9_]{1,60}$/),
    tenantIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
  })
  .strict();
export type TicketSyncConfig = z.infer<typeof ticketSyncConfigSchema>;
export const externalTicketEventSchema = z
  .object({
    eventId: z.string().uuid(),
    organizationId: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().min(1).max(128),
    ticketId: z.string().uuid(),
    externalId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    version: z.number().int().positive().max(2147483647),
    status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']),
    origin: z.enum(['external', 'agent18']),
  })
  .strict();
