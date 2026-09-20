import { z } from 'zod';
export const conversationInput = z.object({ title: z.string().trim().min(1).max(120) }).strict();
export const conversationReferenceSchema = z
  .object({
    kind: z.enum(['knowledge', 'query', 'action', 'ticket']),
    id: z.string().regex(/^[a-zA-Z0-9:_.\/-]{1,200}$/),
    observedAt: z.string().datetime(),
  })
  .strict();
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;
export const conversationMessageInput = z
  .object({
    role: z.enum(['user', 'assistant']),
    body: z.string().trim().min(1).max(8000),
    references: z.array(conversationReferenceSchema).max(5).default([]),
  })
  .strict();
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string };
export type ConversationMessage = {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  body: string;
  origin: 'client_display';
  references: ConversationReference[];
  createdAt: string;
};
export type ConversationDetail = {
  conversation: Conversation;
  messages: ConversationMessage[];
  nextAfter: number | null;
  cases: { id: string; title: string; status: string }[];
};
