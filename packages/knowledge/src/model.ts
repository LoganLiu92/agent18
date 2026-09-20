import { createHash } from 'node:crypto';
import { KnowledgeError, type ModelConfig } from './config.js';

export interface JsonModel {
  readonly identity: string;
  readonly name?: string;
  complete(
    system: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ value: unknown; tokens: number | null }>;
}
export class CompatibleModel implements JsonModel {
  readonly identity: string;
  readonly name: string;
  constructor(private readonly config: ModelConfig) {
    this.name = config.model;
    this.identity = createHash('sha256')
      .update(JSON.stringify({ ...config, apiKey: undefined }))
      .digest('hex');
  }
  async complete(system: string, input: unknown, signal: AbortSignal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: timeout,
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          [this.config.tokenLimitField]: this.config.maxTokens,
          ...(this.config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(input) },
          ],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new KnowledgeError(
          response.status === 429
            ? 'MODEL_RATE_LIMITED'
            : response.status === 401 || response.status === 403
              ? 'MODEL_AUTH_FAILED'
              : 'MODEL_UNAVAILABLE',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new KnowledgeError('MODEL_EMPTY_RESPONSE');
      const buffers: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 131072) {
          await reader.cancel();
          throw new KnowledgeError('MODEL_RESPONSE_TOO_LARGE');
        }
        buffers.push(value);
      }
      const data = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      const choice = data.choices?.[0];
      if (
        choice?.finish_reason !== 'stop' ||
        typeof choice.message?.content !== 'string' ||
        choice.message?.refusal
      )
        throw new KnowledgeError('MODEL_INCOMPLETE_RESPONSE');
      const text = choice.message.content
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '');
      return {
        value: JSON.parse(text) as unknown,
        tokens: Number.isSafeInteger(data.usage?.total_tokens) ? (data.usage.total_tokens as number) : null,
      };
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      if (timeout.aborted) throw new KnowledgeError(signal.aborted ? 'CANCELLED' : 'MODEL_TIMEOUT');
      throw new KnowledgeError('MODEL_INVALID_RESPONSE');
    }
  }
}
