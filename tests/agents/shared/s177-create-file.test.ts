import { describe, expect, test } from 'bun:test';
import { MemoryChatChannel, MemoryTableExporter } from '@business-ai/adapters';
import {
  FILE_MAX_CELL_CHARS,
  FILE_MAX_COLUMNS,
  FILE_MAX_ROWS,
  createFileWarningsTool as createFileTool,
  createToolContext,
  type CreateFileHost,
} from '@business-ai/core';

// Этап 177: пределы createFile не отказ, а обрезка с предупреждением.
const context = createToolContext({
  threadId: 'documents/42',
  agentId: 'documents',
  operationId: 'call-s177',
  initiator: { kind: 'user', userId: '42' },
});
type Input = Parameters<typeof createFileTool.execute>[0];

function setup(): { chat: MemoryChatChannel; deps: CreateFileHost } {
  const chat = new MemoryChatChannel();
  return { chat, deps: { chat, tableExporter: new MemoryTableExporter() } };
}

const run = (deps: CreateFileHost, input: unknown) =>
  createFileTool.execute(input as Input, deps, context);

describe('createFile: предупреждения вместо отказов', () => {
  test('строк больше предела: файл уходит, лишние отброшены', async () => {
    const { chat, deps } = setup();
    const rows = Array.from({ length: FILE_MAX_ROWS + 3 }, () => ['x']);
    const out = await run(deps, { kind: 'csv', fileName: 'a', columns: ['a'], rows });
    expect(out.rows).toBe(FILE_MAX_ROWS);
    expect(out.warnings?.join(' ')).toContain('Строк слишком много');
    expect(chat.outbox.some((record) => record.file !== undefined)).toBe(true);
  });

  test('длинная ячейка, лишние столбцы, кривая строка', async () => {
    const { deps } = setup();
    const columns = Array.from({ length: FILE_MAX_COLUMNS + 2 }, () => 'c');
    const rows = [['x'.repeat(FILE_MAX_CELL_CHARS + 5), 1], ['1']];
    const out = await run(deps, { kind: 'xlsx', fileName: 'a', columns, rows });
    const text = out.warnings?.join('\n') ?? '';
    expect(text).toContain('Столбцов больше');
    expect(text).toContain('Длинных значений обрезано');
    expect(text).toContain('выровнены');
  });

  test('большой текст по размеру: сокращается, а не отказ', async () => {
    const { deps } = setup();
    const paragraphs = Array.from({ length: 1_500 }, () => 'я'.repeat(1_000));
    const out = await run(deps, { kind: 'txt', fileName: 'a', paragraphs });
    expect(out.sizeBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(out.warnings?.join(' ')).toContain('ограничен по размеру');
  });

  test('чистый файл без предупреждений', async () => {
    const { deps } = setup();
    const out = await run(deps, { kind: 'csv', fileName: 'a', columns: ['a'], rows: [['1']] });
    expect(out.warnings).toBeUndefined();
  });
});
