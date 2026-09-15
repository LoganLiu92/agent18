import { z } from 'zod';
const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,49}$/),
    label: z.string().min(1).max(100),
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().default(true),
    enum: z.array(z.string().max(200)).min(1).max(50).optional(),
  })
  .strict();
export const actionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/),
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(1000),
    roles: z.array(z.string().min(1).max(50)).min(1).max(20),
    fields: z.array(fieldSchema).max(20),
    enabled: z.boolean().default(false),
  })
  .strict()
  .refine((x) => new Set(x.fields.map((f) => f.name)).size === x.fields.length, 'Duplicate fields');
export const bridgeSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((raw) => {
        const u = new URL(raw);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'identity-demo'].includes(
                u.hostname,
              )))
        );
      }),
    actions: z.array(actionSchema).max(50),
  })
  .strict()
  .refine((x) => new Set(x.actions.map((a) => a.id)).size === x.actions.length, 'Duplicate actions');
export type BridgeConfig = z.infer<typeof bridgeSchema>;
