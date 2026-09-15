import { expect, it, vi } from 'vitest';
import { Dispatcher } from '@agent18/application';
import type { Database } from '@agent18/persistence';

it('resumes outbox delivery after a transient connection acquisition failure', async () => {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  const connect = vi.fn().mockRejectedValueOnce(new Error('pool unavailable')).mockResolvedValue(client);
  const dispatcher = new Dispatcher(
    { connect } as unknown as Database,
    'postgresql://unused:unused@localhost/unused',
  );
  await expect(dispatcher.flush()).rejects.toThrow('pool unavailable');
  await dispatcher.flush();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(client.query).toHaveBeenCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledOnce();
});
