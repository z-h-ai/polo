import { expect, test } from 'bun:test';
import { PostgresShareRepository } from './postgres-repository.ts';

test('decodes JSONB payloads returned as strings by Bun SQL', async () => {
  const sql = Object.assign(
    async () => [{
      id: 'share-1',
      payload: '{"name":"shared session"}',
      write_token_hash: 'token-hash',
      expires_at: '2030-01-01T00:00:00.000Z',
    }],
    { unsafe: async () => undefined },
  );
  const repository = new PostgresShareRepository(sql as any);

  await expect(repository.getActive('share-1')).resolves.toMatchObject({
    id: 'share-1',
    payload: { name: 'shared session' },
  });
});
