import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { tempDir } from '@business-ai/testing';
import { CHAT_ATTACHMENTS_DIR } from '../../src/chat-attachments';
import { makeHarness } from './chat-attachments-support';

const WIDE_MODE = 0o755;
const OWNER_ONLY_MODE = 0o700;
const MODE_MASK = 0o777;

describe('права каталогов архива', () => {
  test('каталог, созданный раньше с широкими правами (проба патча), сужается до 700', async () => {
    const root = tempDir();
    const sub = join(root, CHAT_ATTACHMENTS_DIR);
    mkdirSync(sub);
    chmodSync(sub, WIDE_MODE);
    const { archive } = makeHarness({}, root);
    const outcome = await archive.save({
      threadId: 't1',
      userId: 'u1',
      file: { name: 'a.txt', content: new TextEncoder().encode('данные') },
    });
    expect(outcome.kind).toBe('saved');
    expect(statSync(sub).mode & MODE_MASK).toBe(OWNER_ONLY_MODE);
    expect(statSync(join(sub, 'files')).mode & MODE_MASK).toBe(OWNER_ONLY_MODE);
    expect(statSync(join(sub, 'index')).mode & MODE_MASK).toBe(OWNER_ONLY_MODE);
  });
});
