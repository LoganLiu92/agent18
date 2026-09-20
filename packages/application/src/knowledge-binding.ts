import { randomUUID } from 'node:crypto';
import { safeCitationSchema } from '@agent18/contracts';
import {
  builtInTools,
  knowledgeInputSchema,
  evidenceBatchSchema,
  validateCitations,
  assertCapability,
  type KnowledgeProvider,
  type RegisteredProvider,
} from '@agent18/provider-contracts';
export function knowledgeBinding(knowledge: KnowledgeProvider): RegisteredProvider {
  const descriptor = builtInTools.find((t) => t.id === 'knowledge.search')!;
  return {
    manifest: {
      id: 'knowledge',
      version: '1.0.0',
      capabilities: ['knowledge.search'],
      mode: knowledge.manifest.mode,
    },
    transport: 'native',
    tools: [
      {
        descriptor,
        inputSchema: knowledgeInputSchema,
        outputSchema: evidenceBatchSchema,
        async invoke(input, context) {
          assertCapability(knowledge, 'knowledge.search');
          const raw = await knowledge.search(knowledgeInputSchema.parse(input), context);
          return validateCitations(raw, context.scope).map((c) => ({
            id: randomUUID(),
            kind: 'knowledge' as const,
            source: c.source,
            observedAt: c.observedAt,
            resource: { type: 'knowledge', id: c.id },
            summary: c.excerpt,
            artifactRef: null,
            visibility: c.visibility,
            sensitivity: c.visibility === 'PUBLIC' ? ('PUBLIC' as const) : ('CONFIDENTIAL' as const),
            scope: context.scope,
            provenance: {
              providerId: descriptor.provider,
              toolId: descriptor.id,
              toolVersion: descriptor.version,
              sourceVersion: c.version,
              requestId: context.requestId,
            },
            citation: safeCitationSchema.parse({
              id: c.id,
              title: c.title,
              excerpt: c.excerpt,
              source: c.source,
              version: c.version,
              observedAt: c.observedAt,
            }),
          }));
        },
      },
    ],
    async visible(scope, evidence) {
      const citations = evidence.flatMap((e) => (e.citation ? [e.citation] : []));
      const visible = knowledge.visible ? await knowledge.visible(scope, citations) : citations;
      return evidence.flatMap((e) => {
        const citation = visible.find((c) => c.id === e.citation?.id && c.source === e.citation?.source);
        if (!citation) return [];
        // Indexed publications re-project legacy citations after current authorization.
        // Other providers still require the exact original version.
        if (!citation.source.startsWith('knowledge://') && citation.version !== e.citation?.version)
          return [];
        return [
          {
            ...e,
            citation,
            summary: citation.excerpt,
            provenance: { ...e.provenance, sourceVersion: citation.version },
          },
        ];
      });
    },
  };
}
