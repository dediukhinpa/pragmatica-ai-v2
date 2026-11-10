import { describe, expect, test } from 'bun:test';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import {
  sendTemplateFile,
  templateFileName,
} from '../../src/agents/site-export/send-template-file';
import { SITE_EXPORT_PROMPT } from '../../src/agents/site-export/prompt';
import { THREAD_ID, buildTemplateWorld } from './site-template-support';

/** Выдача файла: повторно после правок, целиком, «отправил» только после успеха. */

const flags = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;

describe('sendTemplateFile', () => {
  test('файл уходит в тред сотрудника целиком, имя осмысленное с .xlsx', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const out = await sendTemplateFile.execute({ workbookId }, world.deps, world.ctx);
    expect(out).toMatchObject({ delivered: true, sheets: 4, revision: 0 });
    expect(out.fileName).toBe('Шаблон сайта - заполнено 2026-11-02.xlsx');
    const sent = world.deps.chat.outboxOf(THREAD_ID).filter((record) => record.file !== undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.file?.name).toBe(out.fileName);
    expect(sent[0]?.file?.content.length).toBe(out.sizeBytes);
  });

  test('повторная выдача после правки: уходит новая версия, без проверок и хэшей', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const first = await sendTemplateFile.execute(
      { workbookId, fileName: 'Кепки' },
      world.deps,
      world.ctx,
    );
    await fillTemplateRows.execute(
      {
        ...flags,
        workbookId,
        items: [{ cells: [{ column: 'Название', value: 'Кепка' }] }],
      },
      world.deps,
      world.ctx,
    );
    const second = await sendTemplateFile.execute(
      { workbookId, fileName: 'Кепки' },
      world.deps,
      world.ctxOf('op-2'),
    );
    const third = await sendTemplateFile.execute({ workbookId }, world.deps, world.ctxOf('op-3'));
    expect(first.fileName).toBe('Кепки.xlsx');
    expect([first.revision, second.revision, third.revision]).toEqual([0, 1, 1]);
    // Третий вызов - та же версия в том же ходе: файл не уходит.
    const flagsSent = [first, second, third].map((out) => out.alreadySent);
    expect(flagsSent).toEqual([false, false, true]);
    expect([first, second, third].map((out) => out.sendsThisRequest)).toEqual([1, 2, 2]);
    const files = world.deps.chat.outboxOf(THREAD_ID).filter((record) => record.file !== undefined);
    expect(files).toHaveLength(2);
    // Новая версия больше пустой: в ней появилась строка.
    expect(files[1]?.file?.content.length).toBeGreaterThan(files[0]?.file?.content.length ?? 0);
  });

  test('подпись у файла есть, только если её передала модель', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const input = { workbookId, comment: 'Подпись модели' };
    await sendTemplateFile.execute(input, world.deps, world.ctx);
    const outbox = world.deps.chat.outboxOf(THREAD_ID);
    expect(outbox.map((record) => record.message?.text)).toEqual(['Подпись модели', undefined]);
    expect(outbox.filter((record) => record.file !== undefined)).toHaveLength(1);
  });

  test('та же версия в том же ходе: один файл без подписи кода, лог пропуска', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const logged: string[] = [];
    world.deps.fileLog = (event) => {
      logged.push(event);
    };
    const first = await sendTemplateFile.execute({ workbookId }, world.deps, world.ctx);
    const again = await sendTemplateFile.execute({ workbookId }, world.deps, world.ctxOf('op-2'));
    expect(first).toMatchObject({ delivered: true, alreadySent: false, sendsThisRequest: 1 });
    expect(again).toMatchObject({ delivered: true, alreadySent: true, sendsThisRequest: 1 });
    const outbox = world.deps.chat.outboxOf(THREAD_ID);
    expect(outbox.filter((record) => record.file !== undefined)).toHaveLength(1);
    expect(outbox).toHaveLength(1); // только файл первой выдачи, без подписи кода, больше ничего
    expect(logged).toContain('site_template_send_skipped');
  });

  test('новый ход сотрудника: та же версия выдаётся снова, счётчик с единицы', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    await sendTemplateFile.execute({ workbookId }, world.deps, world.ctx);
    const nextTurn = { ...world.ctxOf('op-2'), turnNumber: 2 };
    const out = await sendTemplateFile.execute({ workbookId }, world.deps, nextTurn);
    expect(out).toMatchObject({ alreadySent: false, sendsThisRequest: 1 });
    const files = world.deps.chat.outboxOf(THREAD_ID).filter((record) => record.file !== undefined);
    expect(files).toHaveLength(2);
  });

  test('fillTemplateRows после выдачи в этом же ходе напоминает про повторную выдачу', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const items = [{ cells: [{ column: 'Название', value: 'Кепка' }] }];
    const before = await fillTemplateRows.execute(
      { ...flags, workbookId, items },
      world.deps,
      world.ctx,
    );
    await sendTemplateFile.execute({ workbookId }, world.deps, world.ctxOf('op-2'));
    const after = await fillTemplateRows.execute(
      { ...flags, workbookId, items: [{ row: 12, ...items[0] }] },
      world.deps,
      world.ctxOf('op-3'),
    );
    const hint = 'Файл уже выдан';
    expect(before.warnings.join(' ')).not.toContain(hint);
    expect(after.warnings.join(' ')).toContain(hint);
  });

  test('сбой канала: «отправил» не возвращается, ошибка уходит модели', async () => {
    const world = await buildTemplateWorld();
    const { workbookId = '' } = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    world.deps.chat.sendFile = async () => {
      throw new Error('портал недоступен');
    };
    const logged: string[] = [];
    world.deps.fileLog = (event) => {
      logged.push(event);
    };
    await expect(sendTemplateFile.execute({ workbookId }, world.deps, world.ctx)).rejects.toThrow(
      'портал недоступен',
    );
    expect(logged).toContain('site_template_send_failed');
  });

  test('имя файла очищается от запрещённых знаков', () => {
    expect(templateFileName('a/b:c?', 'x')).toBe('a b c.xlsx');
    expect(templateFileName('  ', 'запас')).toBe('запас.xlsx');
    expect(templateFileName('отчёт.XLSX', 'x')).toBe('отчёт.xlsx');
  });
});

describe('промпт агента сайта: одна выдача на запрос', () => {
  test('содержит ключевые правила про единственную выдачу и честное «отправил»', () => {
    const flat = SITE_EXPORT_PROMPT.replace(/\s+/g, ' ');
    for (const rule of [
      'sendTemplateFile ОДИН раз за обращение',
      'Не выдавай файл повторно без просьбы',
      'только после delivered=true',
      'не оговаривайся, что «ничего не проверял»',
      'Итоговое сообщение одно',
    ]) {
      expect(flat).toContain(rule);
    }
    expect(flat).not.toContain('сколько нужно');
  });
});

describe('декларация агента сайта', () => {
  test('инструменты шаблона объявлены, имена уникальны, схемы входа - объекты', () => {
    const declaration = createSiteExportAgent({ model: 'm' });
    const names = declaration.tools.map((tool) => tool.name);
    for (const name of [
      'prepareCleanTemplate',
      'openChatTemplate',
      'readTemplateStructure',
      'fillTemplateRows',
      'sendTemplateFile',
      'computeSitePrice',
      'nameSitePhotos',
      'readEmployeeIdentity',
      'readChatAttachments',
      'gatherItemData',
      'createFile',
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const tool of declaration.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
