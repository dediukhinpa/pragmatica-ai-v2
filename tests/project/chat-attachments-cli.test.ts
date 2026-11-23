import { describe, expect, test } from 'bun:test';
import { tempDir } from '@business-ai/testing';
import {
  CLI_EXIT_ERROR,
  CLI_EXIT_OK,
  CLI_EXIT_USAGE,
  ChatAttachmentArchive,
  dayRangeIn,
  runChatAttachmentsCli,
  type CliIo,
} from '../../src/chat-attachments';
import { testConfig } from './chat-attachments-support';

const MS_PER_HOUR = 3_600_000;

interface Captured extends CliIo {
  lines: string[];
  errors: string[];
}

function capture(): Captured {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

/** Архив с двумя файлами разных сотрудников и ботов в разные сутки. */
async function seeded() {
  const root = tempDir();
  const clock = { now: new Date('2026-11-05T09:30:00Z') };
  const archive = new ChatAttachmentArchive({
    intakeRoot: root,
    config: testConfig(),
    clock: () => new Date(clock.now),
  });
  await archive.save({
    threadId: 't1',
    userId: '777',
    botId: 'bot-docs',
    agentId: 'documents',
    file: { name: 'Счёт 5.pdf', content: new TextEncoder().encode('счёт') },
  });
  clock.now = new Date('2026-11-06T10:00:00Z');
  await archive.save({
    threadId: 't2',
    userId: '888',
    botId: 'bot-prices',
    agentId: 'prices',
    file: { name: 'Прайс.xlsx', content: new TextEncoder().encode('прайс') },
  });
  return { root, env: { INTAKE_ROOT: root } as Record<string, string> };
}

describe('команды владельца для архива файлов чатов', () => {
  test('find по дню, боту и сотруднику находит одну запись с путём для docker cp', async () => {
    const { env } = await seeded();
    const io = capture();
    const code = await runChatAttachmentsCli(
      ['find', '--date', '2026-11-05', '--bot', 'bot-docs', '--user', '777'],
      env,
      io,
    );
    expect(code).toBe(CLI_EXIT_OK);
    expect(io.lines).toHaveLength(2);
    expect(io.lines[0]).toContain('Счёт 5.pdf');
    expect(io.lines[0]).toContain('documents');
    expect(io.lines[0]).toContain('abs=');
    expect(io.lines[1]).toBe('Найдено записей: 1');
  });

  test('find --json даёт строки JSON с абсолютным путём', async () => {
    const { env, root } = await seeded();
    const io = capture();
    await runChatAttachmentsCli(['find', '--json', '--name', 'прайс'], env, io);
    const parsed = JSON.parse(io.lines[0] ?? '{}') as { name: string; abs: string };
    expect(parsed.name).toBe('Прайс.xlsx');
    expect(parsed.abs.startsWith(root)).toBe(true);
  });

  test('--date считается по поясу BUSINESS_TIMEZONE', async () => {
    const { env } = await seeded();
    const io = capture();
    // 09:30 UTC 05.11 = 14:30 в Екатеринбурге (UTC+5): тот же день; 10:00 UTC 06.11 - уже 06.11.
    await runChatAttachmentsCli(
      ['find', '--date', '2026-11-06'],
      { ...env, BUSINESS_TIMEZONE: 'Asia/Yekaterinburg' },
      io,
    );
    expect(io.lines[0]).toContain('Прайс.xlsx');
    expect(io.lines.at(-1)).toBe('Найдено записей: 1');
  });

  test('path даёт абсолютный путь; чужой и несуществующий путь - ошибка', async () => {
    const { env, root } = await seeded();
    const found = capture();
    await runChatAttachmentsCli(['find', '--json', '--user', '777'], env, found);
    const record = JSON.parse(found.lines[0] ?? '{}') as { path: string };
    const ok = capture();
    expect(await runChatAttachmentsCli(['path', record.path], env, ok)).toBe(CLI_EXIT_OK);
    expect(ok.lines[0]?.startsWith(root)).toBe(true);
    const bad = capture();
    expect(await runChatAttachmentsCli(['path', '../../etc/passwd'], env, bad)).toBe(
      CLI_EXIT_ERROR,
    );
    expect(await runChatAttachmentsCli(['path'], env, capture())).toBe(CLI_EXIT_USAGE);
  });

  test('stats: число файлов, объём и разбивка по ботам', async () => {
    const { env } = await seeded();
    const io = capture();
    expect(await runChatAttachmentsCli(['stats'], env, io)).toBe(CLI_EXIT_OK);
    expect(io.lines[0]).toContain('файлов: 2');
    expect(io.lines.join('\n')).toContain('бот bot-docs: 1');
    expect(io.lines.join('\n')).toContain('бот bot-prices: 1');
  });

  test('purge удаляет по сроку: через 31 сутки архив пуст, раньше - нет', async () => {
    const { env } = await seeded();
    const early = capture();
    const soon = () => new Date('2026-11-20T00:00:00Z');
    expect(await runChatAttachmentsCli(['purge'], env, early, soon)).toBe(CLI_EXIT_OK);
    const kept = capture();
    await runChatAttachmentsCli(['find'], env, kept);
    expect(kept.lines.at(-1)).toBe('Найдено записей: 2');
    const io = capture();
    const later = () => new Date('2026-12-20T00:00:00Z');
    expect(await runChatAttachmentsCli(['purge'], env, io, later)).toBe(CLI_EXIT_OK);
    const after = capture();
    await runChatAttachmentsCli(['find'], env, after);
    expect(after.lines.at(-1)).toBe('Найдено записей: 0');
  });

  test('ошибки вызова: нет команды, неизвестная, плохие флаги, нет INTAKE_ROOT', async () => {
    const { env } = await seeded();
    expect(await runChatAttachmentsCli([], env, capture())).toBe(CLI_EXIT_USAGE);
    expect(await runChatAttachmentsCli(['boom'], env, capture())).toBe(CLI_EXIT_USAGE);
    expect(await runChatAttachmentsCli(['find', '--user'], env, capture())).toBe(CLI_EXIT_USAGE);
    expect(await runChatAttachmentsCli(['find', '--date', '2026-13-40'], env, capture())).toBe(
      CLI_EXIT_USAGE,
    );
    expect(await runChatAttachmentsCli(['find', '--limit', '0'], env, capture())).toBe(
      CLI_EXIT_USAGE,
    );
    expect(await runChatAttachmentsCli(['find', '--from', 'вчера'], env, capture())).toBe(
      CLI_EXIT_USAGE,
    );
    expect(await runChatAttachmentsCli(['find'], {}, capture())).toBe(CLI_EXIT_ERROR);
  });

  test('--help печатает справку и завершается успехом', async () => {
    const io = capture();
    expect(await runChatAttachmentsCli(['--help'], {}, io)).toBe(CLI_EXIT_OK);
    expect(io.lines[0]).toContain('Использование');
  });
});

describe('границы календарного дня в поясе', () => {
  test('UTC: сутки целиком', () => {
    const range = dayRangeIn('2026-11-05', 'UTC');
    expect(range?.from.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(range?.to.toISOString()).toBe('2026-11-05T23:59:59.999Z');
  });

  test('Екатеринбург (UTC+5): день начинается в 19:00 UTC предыдущего', () => {
    const range = dayRangeIn('2026-11-05', 'Asia/Yekaterinburg');
    expect(range?.from.getTime()).toBe(Date.UTC(2026, 10, 4, 19));
    expect((range?.to.getTime() ?? 0) - (range?.from.getTime() ?? 0)).toBe(24 * MS_PER_HOUR - 1);
  });

  test('мусорные дата и пояс - null', () => {
    expect(dayRangeIn('05.11.2026', 'UTC')).toBeNull();
    expect(dayRangeIn('2026-02-31', 'UTC')).toBeNull();
    expect(dayRangeIn('2026-11-05', 'Mars/Phobos')).toBeNull();
  });
});
