import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAccessPolicy,
  MemoryChatChannel,
  MemoryFileAuthorship,
  MemoryStaffDirectory,
  type MemoryFileSource,
} from '@business-ai/adapters';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices/deps';
import { PRICE_FILE_AUTHORSHIP_MAX_FILES } from '../../src/agents/prices/stale-price-recipients';
import { MONITORING_NAMESPACE, monitoringKey, recordEmployeeContact } from '@business-ai/core';
import { runStalePriceFilesCheck } from '../../src/agents/prices/stale-price-files';
import { EVENT_SEVERITY } from '@business-ai/adapters';
import { directoryUnavailableDecision, type StaffPerson } from '@business-ai/core';
import type { AccessPolicy, ChatMessage, IdempotencyKey } from '@business-ai/core';
import {
  RESPONSIBLE_THREAD,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';

const TZ = 'Europe/Moscow';
const MONDAY_0900 = new Date('2026-10-12T06:00:00Z');
const DEPARTMENT = 'department:5';
const STALE_A = 'Металл/МеталлТорг/прайс_01.01.2026.xlsx';
const STALE_B = 'Крепёж/болты_15.01.2026.docx';
const STALE_C = 'Разное/цены_10.02.2026.xls';
const UNDATED = 'Разное/Прайс лист МеталлТорг.xlsx';
const FRESH = 'Свежее/прайс_01.10.2026.xlsx';
const NOT_OFFICE = 'Архив/прайс_01.01.2026.pdf';

/** Сотрудники отдела закупок: уникальные ФИО, у Петровой нет отчества. */
const IVANOV: StaffPerson = {
  userId: 'u-ivanov',
  lastName: 'Иванов',
  firstName: 'Иван',
  secondName: 'Петрович',
};
const PETROVA: StaffPerson = {
  userId: 'u-petrova',
  lastName: 'Петрова',
  firstName: 'Ольга',
};
const SIDOROV: StaffPerson = {
  userId: 'u-sidorov',
  lastName: 'Сидоров',
  firstName: 'Фёдор',
};
const TWIN_A: StaffPerson = {
  userId: 'u-twin-a',
  lastName: 'Кузнецов',
  firstName: 'Алексей',
};
const TWIN_B: StaffPerson = {
  userId: 'u-twin-b',
  lastName: 'Кузнецов',
  firstName: 'Андрей',
};
const THREADS: Record<string, string> = {
  [IVANOV.userId]: 'bot/ivanov',
  [PETROVA.userId]: 'bot/petrova',
  [SIDOROV.userId]: 'bot/sidorov',
};

/** Чат, который отказывает в доставке в заданные треды (проверка сбоя посреди рассылки). */
class FlakyChat extends MemoryChatChannel {
  readonly failFor = new Set<string>();

  override async reply(threadId: string, message: ChatMessage, key: IdempotencyKey): Promise<void> {
    if (this.failFor.has(threadId)) throw new Error('канал недоступен');
    return super.reply(threadId, message, key);
  }
}

interface World {
  deps: FullPricesDeps & {
    authorship: MemoryFileAuthorship;
    staff: MemoryStaffDirectory;
    chat: FlakyChat;
  };
  files: MemoryFileSource;
  logs: string[];
}

let world: World;

async function build(): Promise<World> {
  const base = await buildFullPricesDeps();
  const clock = new FixedClock(MONDAY_0900);
  const chat = new FlakyChat();
  const staff = new MemoryStaffDirectory();
  staff.set(DEPARTMENT, [IVANOV, PETROVA, SIDOROV, TWIN_A, TWIN_B]);
  const logs: string[] = [];
  const deps = {
    ...base,
    clock,
    chat,
    authorship: new MemoryFileAuthorship(),
    staff,
    staffDepartmentIds: [DEPARTMENT],
    log: (event: string, fields?: Record<string, string | number | boolean>) =>
      void logs.push(JSON.stringify({ event, fields })),
  };
  for (const [userId, threadId] of Object.entries(THREADS)) {
    await recordEmployeeContact(base.state, clock, { threadId, userId }, PRICES_AGENT_ID);
  }
  return { deps, files: base.files as MemoryFileSource, logs };
}

function put(path: string): void {
  world.files.put(path, encode('x'), MONDAY_0900.getTime());
}

function authors(path: string, creator: string | null, editor: string | null): void {
  world.deps.authorship.set(path, {
    creator,
    lastModifiedBy: editor,
    createdAt: null,
    modifiedAt: null,
  });
}

function run(): ReturnType<typeof runStalePriceFilesCheck> {
  return runStalePriceFilesCheck(world.deps as PricesDeps, { timezone: TZ });
}

function textOf(thread: string, index = 0): string {
  return world.deps.chat.outboxOf(thread)[index]?.message?.text ?? '';
}

beforeEach(async () => {
  world = await build();
});

describe('раздача сводки по сотрудникам', () => {
  test('каждому только его файлы; без сотрудника - ответственному', async () => {
    for (const path of [STALE_A, STALE_B, STALE_C]) put(path);
    authors(STALE_A, 'Иванов Иван', 'Иванов Иван');
    authors(STALE_B, 'Петрова Ольга', 'Петрова Ольга');
    authors(STALE_C, 'Неизвестный Человек', null);

    const result = await run();

    expect(result).toMatchObject({
      status: 'sent',
      notified: 3,
      messages: 3,
      personal: 2,
    });
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    expect(textOf('bot/ivanov')).not.toContain(STALE_B);
    expect(textOf('bot/ivanov')).not.toContain(STALE_C);
    expect(textOf('bot/petrova')).toContain(STALE_B);
    expect(textOf('bot/petrova')).not.toContain(STALE_A);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_C);
    expect(textOf(RESPONSIBLE_THREAD)).not.toContain(STALE_A);
    expect(textOf(RESPONSIBLE_THREAD)).not.toContain(STALE_B);
    expect(world.deps.chat.outbox).toHaveLength(3);
  });

  test('создатель и редактор - разные люди: файл идёт редактору, создателю нет', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван Петрович', 'Сидоров Федор');
    await run();
    expect(textOf('bot/sidorov')).toContain(STALE_A);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
  });

  test('редактор не опознан - берётся создатель', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван Петрович', 'Администратор');
    await run();
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
  });

  test('создатель и редактор - один человек в разной записи: одна строка', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', 'Иван Иванов');
    await run();
    expect(world.deps.chat.outbox).toHaveLength(1);
    const lines = textOf('bot/ivanov')
      .split('\n')
      .filter((line) => line.includes(STALE_A));
    expect(lines).toHaveLength(1);
  });

  test('один найден, другой нет: файл идёт найденному, ответственному не дублируется', async () => {
    put(STALE_A);
    authors(STALE_A, 'Администратор', 'Иванов И.П.');
    await run();
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
  });

  test('файлы «без даты» раздаются по тем же правилам', async () => {
    put(UNDATED);
    authors(UNDATED, 'Петрова О.', null);
    const result = await run();
    expect(result).toMatchObject({ status: 'sent', undated: 1, personal: 1 });
    expect(textOf('bot/petrova')).toContain('Дата в названии не найдена');
    expect(textOf('bot/petrova')).toContain(UNDATED);
  });

  test('сообщение сотруднику: его устаревшие и «без даты» файлы вместе', async () => {
    put(STALE_A);
    put(UNDATED);
    authors(STALE_A, 'Иванов Иван', null);
    authors(UNDATED, null, 'Иванов Иван');
    await run();
    expect(world.deps.chat.outbox).toHaveLength(1);
    const text = textOf('bot/ivanov');
    expect(text).toContain(STALE_A);
    expect(text).toContain(UNDATED);
  });

  test('поток ответственного получает только остаток, сводка не удваивается', async () => {
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_B);
    expect(textOf(RESPONSIBLE_THREAD)).not.toContain(STALE_A);
  });
});

describe('файлы уходят в общий поток', () => {
  test.each([
    ['авторство пустое', null, null],
    ['имя не из отдела закупок', 'Бухгалтеров Борис', 'Касса Клавдия'],
    ['неоднозначное имя (два Кузнецова)', 'Кузнецов А.', null],
    ['служебное имя', 'admin', 'User'],
  ])('%s', async (_title, creator, editor) => {
    put(STALE_A);
    authors(STALE_A, creator, editor);
    const result = await run();
    expect(result).toMatchObject({ status: 'sent', personal: 0 });
    expect(world.deps.chat.outbox).toHaveLength(1);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('повреждённый файл и сбой сервиса авторства', async () => {
    put(STALE_A);
    put(STALE_B);
    world.deps.authorship.setCorrupt(STALE_A);
    authors(STALE_B, 'Иванов Иван', null);
    world.deps.authorship.failing = true;
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_B);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
  });

  test('каталог сотрудников недоступен: всё ответственному', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    world.deps.staff.failing = true;
    expect(await run()).toMatchObject({ status: 'sent', personal: 0 });
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('сотрудник ни разу не писал боту (нет личного треда): ответственному', async () => {
    put(STALE_A);
    world.deps.staff.set(DEPARTMENT, [
      ...[IVANOV, PETROVA, SIDOROV],
      { userId: 'u-new', lastName: 'Новиков', firstName: 'Николай' },
    ]);
    authors(STALE_A, 'Новиков Николай', null);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('у сотрудника нет права писать агенту: ответственному', async () => {
    const access = new MemoryAccessPolicy();
    access.allow({
      userId: PETROVA.userId,
      botId: PRICES_AGENT_ID,
      action: 'chat.message',
    });
    world.deps = { ...world.deps, access };
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван', null);
    authors(STALE_B, 'Петрова Ольга', null);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
    expect(textOf('bot/petrova')).toContain(STALE_B);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
  });

  test('адресат совпал с ответственным: одно сообщение со всеми файлами', async () => {
    world.deps = { ...world.deps, responsibleThreadId: 'bot/ivanov' };
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    expect(world.deps.chat.outbox).toHaveLength(1);
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    expect(textOf('bot/ivanov')).toContain(STALE_B);
  });
});

describe('вызов сервиса авторства', () => {
  test('только для устаревших и «без даты» офисных файлов недели', async () => {
    for (const path of [STALE_A, UNDATED, FRESH, NOT_OFFICE]) put(path);
    await run();
    expect(world.deps.authorship.calls).toBe(2);
  });

  test('файл с датой без года: свойства читаются один раз - и для года, и для адресата', async () => {
    const path = 'Склад/Прайс Иванова 31.12.xlsx';
    world.files.put(path, encode('x'), MONDAY_0900.getTime());
    world.deps.authorship.set(path, {
      creator: 'Иванов Иван',
      lastModifiedBy: null,
      createdAt: null,
      modifiedAt: '2024-01-10T09:00:00Z',
    });
    await run();
    expect(world.deps.authorship.calls).toBe(1);
    expect(textOf('bot/ivanov')).toContain('31.12.2023 (год по дате сохранения в свойствах файла)');
  });

  test('нет устаревших и «без даты» - сервис не вызывается, молчим', async () => {
    put(FRESH);
    expect(await run()).toMatchObject({ status: 'nothing' });
    expect(world.deps.authorship.calls).toBe(0);
    expect(world.deps.staff.calls).toBe(0);
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('сверх предела файлы идут в общий поток', async () => {
    const total = PRICE_FILE_AUTHORSHIP_MAX_FILES + 2;
    for (let i = 0; i < total; i += 1) {
      const path = `Архив/${String(i).padStart(3, '0')}/прайс_01.01.2026.xlsx`;
      put(path);
      authors(path, 'Иванов Иван', null);
    }
    await run();
    expect(world.deps.authorship.calls).toBe(PRICE_FILE_AUTHORSHIP_MAX_FILES);
    expect(textOf(RESPONSIBLE_THREAD)).toContain('/100/');
  });

  test('адресная раздача не подключена: всё ответственному, сервис не вызывается', async () => {
    const { authorship: _a, staff: _s, staffDepartmentIds: _d, ...bare } = world.deps;
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    await runStalePriceFilesCheck(bare as PricesDeps, { timezone: TZ });
    expect(world.deps.authorship.calls).toBe(0);
    expect(world.deps.chat.outbox).toHaveLength(1);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('не хватает любой из трёх настроек - раздачи нет', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    world.deps = { ...world.deps, staffDepartmentIds: undefined };
    await run();
    expect(world.deps.authorship.calls).toBe(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });
});

describe('идемпотентность по получателям', () => {
  test('повтор в тот же понедельник ничего не шлёт', async () => {
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    expect((await run()).status).toBe('already_done');
    expect(world.deps.chat.outbox).toHaveLength(2);
  });

  test('потерян слот дня (рестарт): получатели не получают повторно', async () => {
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    await world.deps.state.delete(
      MONITORING_NAMESPACE,
      monitoringKey.slot('stale-price-files', '2026-10-12'),
    );
    const again = await run();
    expect(again).toMatchObject({ status: 'sent', messages: 2 });
    expect(world.deps.chat.outbox).toHaveLength(2);
  });

  test('сбой одному получателю: остальным доставлено, повтор дошлёт только ему', async () => {
    put(STALE_A);
    put(STALE_B);
    put(STALE_C);
    authors(STALE_A, 'Иванов Иван', null);
    authors(STALE_B, 'Петрова Ольга', null);
    world.deps.chat.failFor.add('bot/petrova');

    await expect(run()).rejects.toThrow();
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(1);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(1);
    expect(world.deps.chat.outboxOf('bot/petrova')).toHaveLength(0);

    world.deps.chat.failFor.clear();
    expect(await run()).toMatchObject({ status: 'sent', messages: 3 });
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(1);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(1);
    expect(world.deps.chat.outboxOf('bot/petrova')).toHaveLength(1);
    expect((await run()).status).toBe('already_done');
  });

  test('следующий понедельник - новая рассылка всем', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    (world.deps.clock as FixedClock).advance(7 * 24 * 60 * 60 * 1000);
    expect((await run()).status).toBe('sent');
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(2);
  });
});

describe('ПДн: ФИО не в журналах, сообщениях и состоянии', () => {
  test('имена из свойств файла нигде не остаются', async () => {
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, 'Иванов Иван Петрович', 'Сидоров Фёдор');
    authors(STALE_B, 'Секретнов Тайн', null);
    await run();
    const names = ['Иванов', 'Сидоров', 'Секретнов', 'Тайн', 'Петрова'];
    const outgoing = JSON.stringify(world.deps.chat.outbox);
    const stored = JSON.stringify(await world.deps.state.list(MONITORING_NAMESPACE, null, 1000));
    for (const name of names) {
      expect(world.logs.join('\n')).not.toContain(name);
      expect(outgoing).not.toContain(name);
      expect(stored).not.toContain(name);
    }
  });

  test('в журнал идут только счётчики', async () => {
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    const entry = world.logs.find((line) => line.includes('price_file_authorship'));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry ?? '{}')).toEqual({
      event: 'price_file_authorship',
      fields: {
        asked: 1,
        resolved: 1,
        unmatched: 0,
        ambiguous: 0,
        failed: 0,
        noThread: 0,
        denied: 0,
        opened: 0,
        pathResolved: 0,
        officeModified: 0,
        officeCreated: 1,
        fallback: 0,
        otherDepartment: 0,
        excluded: 0,
      },
    });
  });
});

describe('адресат по фамилии в пути', () => {
  const PATH_IVANOV = 'Металл/2 Метизы_Иванов/прайс_01.01.2026.xlsx';

  test('фамилия в папке: свойства файла не читаются, сводка сотруднику', async () => {
    put(PATH_IVANOV);
    authors(PATH_IVANOV, 'Сидоров Фёдор', 'Сидоров Фёдор');
    await run();
    expect(textOf('bot/ivanov')).toContain(PATH_IVANOV);
    expect(world.deps.chat.outboxOf('bot/sidorov')).toHaveLength(0);
    expect(world.deps.authorship.calls).toBe(0);
  });

  test('не Office-файл тоже определяется по пути', async () => {
    const path = 'Металл/Петрова/прайс_01.01.2026.pdf';
    put(path);
    await run();
    expect(textOf('bot/petrova')).toContain(path);
    expect(world.deps.authorship.calls).toBe(0);
  });

  test('самая глубокая папка; две фамилии - оба получают', async () => {
    const deep = 'Иванов/Керамика_Петрова_Сидоров/прайс_01.01.2026.xlsx';
    put(deep);
    await run();
    expect(textOf('bot/petrova')).toContain(deep);
    expect(textOf('bot/sidorov')).toContain(deep);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
  });

  test('решённые по пути файлы не тратят лимит чтений', async () => {
    const byPath = Array.from(
      { length: PRICE_FILE_AUTHORSHIP_MAX_FILES },
      (_, i) => `Иванов/прайс_${i}_01.01.2026.xlsx`,
    );
    for (const path of byPath) put(path);
    put(STALE_A);
    authors(STALE_A, null, 'Сидоров Фёдор');
    await run();
    expect(world.deps.authorship.calls).toBe(1);
    expect(textOf('bot/sidorov')).toContain(STALE_A);
  });

  test('фамилия общая у двух сотрудников: путь не угадывается, идёт шаг Office', async () => {
    const path = 'Кузнецов/прайс_01.01.2026.xlsx';
    put(path);
    authors(path, null, 'Сидоров Фёдор');
    await run();
    expect(textOf('bot/sidorov')).toContain(path);
  });

  test('сотрудник по пути без личного треда: файл ответственному', async () => {
    const silent: StaffPerson = {
      userId: 'u-silent',
      lastName: 'Молчанов',
      firstName: 'Глеб',
    };
    world.deps.staff.set(DEPARTMENT, [IVANOV, silent]);
    const path = 'Склад/Молчанов/прайс_01.01.2026.xlsx';
    put(path);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(path);
    expect(world.deps.authorship.calls).toBe(0);
  });

  test('журнал: счётчики шагов без имён и путей', async () => {
    put(PATH_IVANOV);
    put(STALE_B);
    authors(STALE_B, 'Петрова Ольга', 'Сидоров Фёдор');
    put(STALE_C);
    await run();
    const entry = JSON.parse(
      world.logs.find((line) => line.includes('price_file_authorship')) ?? '{}',
    ) as { fields: Record<string, number> };
    expect(entry.fields).toMatchObject({
      pathResolved: 1,
      officeModified: 1,
      officeCreated: 0,
      fallback: 1,
    });
    expect(world.logs.join('\n')).not.toContain('Иванов');
  });
});

const PATH_FILE = 'Металл/2 Метизы_Иванов/прайс_01.01.2026.xlsx';

describe('шаг Office: сотрудник любого отдела', () => {
  const SALES_DEPARTMENT = 'department:7';
  const SALESMAN: StaffPerson = {
    userId: 'u-sales',
    lastName: 'Громов',
    firstName: 'Артём',
  };
  const OLD_TWIN: StaffPerson = {
    userId: 'u-twin-sales',
    lastName: 'Иванов',
    firstName: 'Иван',
  };

  async function withSalesThread(): Promise<void> {
    world.deps.staff.set(SALES_DEPARTMENT, [SALESMAN]);
    await recordEmployeeContact(
      world.deps.state,
      world.deps.clock,
      { threadId: 'bot/gromov', userId: SALESMAN.userId },
      PRICES_AGENT_ID,
    );
  }

  test('сотрудник другого отдела получает файл через Office; счётчик otherDepartment', async () => {
    await withSalesThread();
    put(STALE_A);
    authors(STALE_A, null, 'Громов Артём');
    await run();
    expect(textOf('bot/gromov')).toContain(STALE_A);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
    const entry = JSON.parse(
      world.logs.find((line) => line.includes('price_file_authorship')) ?? '{}',
    ) as { fields: Record<string, number> };
    expect(entry.fields).toMatchObject({
      officeModified: 1,
      otherDepartment: 1,
    });
    expect(world.logs.join('\n')).not.toContain('Громов');
  });

  test('сотрудник закупок на шаге Office не считается «другим отделом»', async () => {
    put(STALE_A);
    authors(STALE_A, null, 'Иванов Иван');
    await run();
    const entry = JSON.parse(
      world.logs.find((line) => line.includes('price_file_authorship')) ?? '{}',
    ) as { fields: Record<string, number> };
    expect(entry.fields).toMatchObject({
      officeModified: 1,
      otherDepartment: 0,
    });
  });

  test('неактивный (его нет в каталоге) - ответственному', async () => {
    put(STALE_A);
    authors(STALE_A, null, 'Громов Артём');
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('одно имя у двух сотрудников вне закупок - неоднозначно, ответственному', async () => {
    world.deps.staff.set(SALES_DEPARTMENT, [
      { userId: 'u-g1', lastName: 'Громов', firstName: 'Артём' },
      { userId: 'u-g2', lastName: 'Громов', firstName: 'Артём' },
    ]);
    put(STALE_A);
    authors(STALE_A, null, 'Громов Артём');
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });

  test('путь ищет только в отделе закупок', async () => {
    await withSalesThread();
    const path = 'Склад/Громов/прайс_01.01.2026.xlsx';
    put(path);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(path);
    expect(world.deps.chat.outboxOf('bot/gromov')).toHaveLength(0);
  });

  test('каталог всех сотрудников недоступен для Office: ответственному, путь работает', async () => {
    put(PATH_FILE);
    world.deps.staff.set('department:7', [SALESMAN]);
    put(STALE_A);
    authors(STALE_A, null, 'Громов Артём');
    const original = world.deps.staff.allActiveMembers.bind(world.deps.staff);
    world.deps.staff.allActiveMembers = async () => {
      throw new Error('сбой');
    };
    await run();
    world.deps.staff.allActiveMembers = original;
    expect(textOf('bot/ivanov')).toContain(PATH_FILE);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });
});

describe('исключённые получатели', () => {
  function exclude(...ids: string[]): void {
    world.deps.recipientExcludeUserIds = new Set(ids);
  }
  function counters(): Record<string, number> {
    const line = world.logs.find((entry) => entry.includes('price_file_authorship'));
    return (JSON.parse(line ?? '{}') as { fields: Record<string, number> }).fields;
  }

  test('путь: исключённый убран, остальные фамилии папки остаются', async () => {
    const path = 'Керамика_Иванов_Сидоров/прайс_01.01.2026.xlsx';
    put(path);
    exclude(IVANOV.userId);
    await run();
    expect(textOf('bot/sidorov')).toContain(path);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
    expect(counters()).toMatchObject({ pathResolved: 1, excluded: 1 });
  });

  test('путь: после исключения пусто - идём в Office', async () => {
    const path = 'Керамика_Иванов/прайс_01.01.2026.xlsx';
    put(path);
    authors(path, null, 'Сидоров Фёдор');
    exclude(IVANOV.userId);
    await run();
    expect(textOf('bot/sidorov')).toContain(path);
    expect(counters()).toMatchObject({ pathResolved: 0, officeModified: 1, excluded: 1 });
  });

  test('Office: «изменён» исключён - пробуем «создан»', async () => {
    put(STALE_A);
    authors(STALE_A, 'Петрова Ольга', 'Иванов Иван');
    exclude(IVANOV.userId);
    await run();
    expect(textOf('bot/petrova')).toContain(STALE_A);
    expect(world.deps.chat.outboxOf('bot/ivanov')).toHaveLength(0);
    expect(counters()).toMatchObject({ officeModified: 0, officeCreated: 1, excluded: 1 });
  });

  test('Office: оба исключены - ответственному, имён в журнале нет', async () => {
    put(STALE_A);
    authors(STALE_A, 'Петрова Ольга', 'Иванов Иван');
    exclude(IVANOV.userId, PETROVA.userId);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
    expect(counters()).toMatchObject({ excluded: 2, fallback: 1 });
    expect(world.logs.join('\n')).not.toContain(IVANOV.userId);
  });
});

describe('Office: два прохода сопоставления', () => {
  const SALES_DEPARTMENT = 'department:7';
  const SALESMAN: StaffPerson = { userId: 'u-sales', lastName: 'Громов', firstName: 'Артём' };
  const NAMESAKE: StaffPerson = { userId: 'u-namesake', lastName: 'Иванов', firstName: 'Иван' };

  test('однофамилец в другом отделе не ломает однозначное совпадение в закупках', async () => {
    world.deps.staff.set(SALES_DEPARTMENT, [NAMESAKE]);
    put(STALE_A);
    authors(STALE_A, null, 'Иванов Иван');
    await run();
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    expect(world.deps.staff.allCalls).toBe(0);
  });

  test('автор только в другом отделе находится вторым проходом, запрос один', async () => {
    world.deps.staff.set(SALES_DEPARTMENT, [SALESMAN]);
    await recordEmployeeContact(
      world.deps.state,
      world.deps.clock,
      { threadId: 'bot/gromov', userId: SALESMAN.userId },
      PRICES_AGENT_ID,
    );
    put(STALE_A);
    put(STALE_B);
    authors(STALE_A, null, 'Громов Артём');
    authors(STALE_B, 'Громов Артём', null);
    await run();
    expect(textOf('bot/gromov')).toContain(STALE_A);
    expect(textOf('bot/gromov')).toContain(STALE_B);
    expect(world.deps.staff.allCalls).toBe(1);
  });
});

/** Сотрудники вне отдела закупок (этап 217): соседний отдел и корень компании. */
const NEIGHBOUR_DEPARTMENT = 'department:8';
const ROOT_DEPARTMENT = 'department:1';
const DALMATOV: StaffPerson = { userId: 'u-dalmatov', lastName: 'Далматов', firstName: 'Денис' };
const CHERNOV: StaffPerson = { userId: 'u-chernov', lastName: 'Чернов', firstName: 'Михаил' };
const OTHER_ROOT: StaffPerson = { userId: 'u-orlov', lastName: 'Орлов', firstName: 'Олег' };
const DALMATOV_PATH = 'Склад/Далматов/прайс_01.01.2026.xlsx';
const CHERNOV_PATH = 'Склад/Чернов/прайс_01.01.2026.xlsx';
const ORLOV_PATH = 'Склад/Орлов/прайс_01.01.2026.xlsx';

/** Личные треды новых сотрудников: сотрудник уже писал боту (запись в реестре обращений). */
async function knowThreads(...people: StaffPerson[]): Promise<void> {
  for (const person of people) {
    await recordEmployeeContact(
      world.deps.state,
      world.deps.clock,
      { threadId: `bot/${person.userId}`, userId: person.userId },
      PRICES_AGENT_ID,
    );
  }
}

function setupExtraStaff(): void {
  world.deps.staff.set(NEIGHBOUR_DEPARTMENT, [DALMATOV]);
  world.deps.staff.set(ROOT_DEPARTMENT, [CHERNOV, OTHER_ROOT]);
}

describe('состав сотрудников для фамилии в пути (этап 217)', () => {
  test('по умолчанию - только отдел закупок: чужая папка уходит ответственному', async () => {
    setupExtraStaff();
    await knowThreads(DALMATOV, CHERNOV);
    put(DALMATOV_PATH);
    put(CHERNOV_PATH);
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(CHERNOV_PATH);
    expect(world.deps.chat.outboxOf('bot/u-dalmatov')).toHaveLength(0);
  });

  test('несколько отделов: папка сотрудника второго отдела сопоставляется по фамилии', async () => {
    setupExtraStaff();
    await knowThreads(DALMATOV);
    world.deps = { ...world.deps, staffDepartmentIds: [DEPARTMENT, NEIGHBOUR_DEPARTMENT] };
    put(DALMATOV_PATH);
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    expect(textOf('bot/u-dalmatov')).toContain(DALMATOV_PATH);
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    // Фамилия в пути решила дело: свойства файла читались только у второго файла.
    expect(world.deps.authorship.calls).toBe(1);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
  });

  test('отдельные id: из корневого отдела берутся только перечисленные', async () => {
    setupExtraStaff();
    await knowThreads(CHERNOV, OTHER_ROOT);
    world.deps = { ...world.deps, staffExtraUserIds: new Set([CHERNOV.userId]) };
    put(CHERNOV_PATH);
    put(ORLOV_PATH);
    await run();
    expect(textOf('bot/u-chernov')).toContain(CHERNOV_PATH);
    expect(world.deps.chat.outboxOf('bot/u-orlov')).toHaveLength(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(ORLOV_PATH);
    expect(textOf(RESPONSIBLE_THREAD)).not.toContain(CHERNOV_PATH);
  });

  test('только отдельные id, без отдела: раздача включена', async () => {
    setupExtraStaff();
    await knowThreads(CHERNOV);
    world.deps = {
      ...world.deps,
      staffDepartmentIds: undefined,
      staffExtraUserIds: new Set([CHERNOV.userId]),
    };
    put(CHERNOV_PATH);
    await run();
    expect(textOf('bot/u-chernov')).toContain(CHERNOV_PATH);
  });

  test('неактивный id из списка молча пропускается (его нет среди активных)', async () => {
    setupExtraStaff();
    world.deps = { ...world.deps, staffExtraUserIds: new Set(['u-gone']) };
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    await run();
    expect(textOf('bot/ivanov')).toContain(STALE_A);
  });

  test('каталог недоступен при втором отделе: всё ответственному, без падения', async () => {
    setupExtraStaff();
    world.deps = { ...world.deps, staffDepartmentIds: [DEPARTMENT, NEIGHBOUR_DEPARTMENT] };
    world.deps.staff.failing = true;
    put(STALE_A);
    expect(await run()).toMatchObject({ status: 'sent', personal: 0 });
    expect(textOf(RESPONSIBLE_THREAD)).toContain(STALE_A);
  });
});

describe('каталог всех сотрудников: ленивая загрузка и сбой (ревью 217)', () => {
  beforeEach(() => {
    setupExtraStaff();
  });

  test('без отдельных id и без шага Office каталог всех не запрашивается', async () => {
    put(PATH_FILE);
    await run();
    expect(textOf('bot/ivanov')).toContain(PATH_FILE);
    expect(world.deps.staff.allCalls).toBe(0);
  });

  test('сбой запроса отдельных id не отключает шаг по отделам', async () => {
    world.deps = { ...world.deps, staffExtraUserIds: new Set([CHERNOV.userId]) };
    world.deps.staff.allActiveMembers = async () => {
      throw new Error('сбой');
    };
    put(PATH_FILE);
    put(CHERNOV_PATH);
    await run();
    // Отдел закупок сопоставлен по фамилии в пути, отдельный id (недоступен) - ответственному.
    expect(textOf('bot/ivanov')).toContain(PATH_FILE);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(CHERNOV_PATH);
    expect(textOf(RESPONSIBLE_THREAD)).not.toContain(PATH_FILE);
  });
});

describe('личный тред без обращения к боту (этап 217)', () => {
  /** Построенный тред требует политики доступа: без неё бот не пишет первым (ревью 217). */
  function allowedFor(...people: StaffPerson[]): MemoryAccessPolicy {
    const policy = new MemoryAccessPolicy();
    for (const person of people) {
      policy.allow({ userId: person.userId, botId: PRICES_AGENT_ID, action: 'chat.message' });
    }
    return policy;
  }
  const OPEN = { recipientOpenThread: true, botId: 'prices' } as const;

  beforeEach(() => {
    setupExtraStaff();
    world.deps = { ...world.deps, staffDepartmentIds: [DEPARTMENT, NEIGHBOUR_DEPARTMENT] };
    put(DALMATOV_PATH);
  });

  test('без флага: сотрудник не писал боту - файл ответственному (прежнее поведение)', async () => {
    world.deps = { ...world.deps, botId: 'prices' };
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    expect(world.deps.chat.outbox).toHaveLength(1);
  });

  test('с флагом: бот пишет первым в тред связки <бот>/<id>', async () => {
    world.deps = { ...world.deps, ...OPEN, access: allowedFor(DALMATOV) };
    await run();
    expect(textOf('prices/u-dalmatov')).toContain(DALMATOV_PATH);
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(0);
    const stats = JSON.parse(world.logs.find((l) => l.includes('price_file_authorship')) ?? '{}');
    expect(stats.fields).toMatchObject({ opened: 1, resolved: 1, noThread: 0 });
  });

  test('с флагом: известный тред из реестра важнее построенного', async () => {
    world.deps = { ...world.deps, ...OPEN, access: allowedFor(DALMATOV) };
    await knowThreads(DALMATOV);
    await run();
    expect(textOf('bot/u-dalmatov')).toContain(DALMATOV_PATH);
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
  });

  test('с флагом, но без ключа бота: писать некуда - ответственному', async () => {
    world.deps = { ...world.deps, recipientOpenThread: true, access: allowedFor(DALMATOV) };
    await run();
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
  });

  test('с флагом, но без политики доступа: бот первым не пишет, файл ответственному', async () => {
    world.deps = { ...world.deps, ...OPEN };
    await run();
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    const event = world.logs.find((l) => l.includes('price_file_authorship')) ?? '';
    expect(JSON.parse(event).fields).toMatchObject({ opened: 0, resolved: 0 });
  });

  test('с флагом: каталог политики недоступен - сообщения нет, файл ответственному', async () => {
    const access: AccessPolicy = {
      isAllowed: async () => false,
      decide: async () => directoryUnavailableDecision(),
    };
    world.deps = { ...world.deps, ...OPEN, access };
    await run();
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    const event = world.logs.find((l) => l.includes('price_file_authorship')) ?? '';
    expect(JSON.parse(event).fields).toMatchObject({ denied: 0, opened: 0, noThread: 1 });
  });

  test('с флагом: политика бросает исключение - сообщения нет, сводка не падает', async () => {
    const access: AccessPolicy = {
      isAllowed: async () => true,
      decide: async () => {
        throw new Error('сбой политики');
      },
    };
    world.deps = { ...world.deps, ...OPEN, access };
    expect(await run()).toMatchObject({ status: 'sent' });
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
  });

  test('сбой отправки в построенный тред: файлы ответственному, слот закрыт', async () => {
    world.deps = { ...world.deps, ...OPEN, access: allowedFor(DALMATOV, IVANOV) };
    world.deps.chat.failFor.add('prices/u-dalmatov');
    put(STALE_A);
    authors(STALE_A, 'Иванов Иван', null);
    expect(await run()).toMatchObject({ status: 'sent' });
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
    // Файл сотрудника не потерян: ушёл ответственному вместе с остальными.
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    expect(textOf('bot/ivanov')).toContain(STALE_A);
    // Слот дня закрыт: повторный тик не пересканирует и не шлёт.
    expect((await run()).status).toBe('already_done');
    expect(world.deps.chat.outboxOf(RESPONSIBLE_THREAD)).toHaveLength(1);
    // Переадресация - info-событие без путей и идентификаторов.
    const event = world.logs.find((l) => l.includes('price_stale_files_opened_redirected')) ?? '';
    expect(JSON.parse(event).fields).toMatchObject({ threads: 1, files: 1 });
    expect(event).not.toContain('u-dalmatov');
    expect(EVENT_SEVERITY['price_stale_files_opened_redirected']).toBe('info');
  });

  test('сбой отправки в известный тред из реестра бросает, повтор дошлёт', async () => {
    world.deps = { ...world.deps, ...OPEN, access: allowedFor(DALMATOV) };
    await knowThreads(DALMATOV);
    world.deps.chat.failFor.add('bot/u-dalmatov');
    await expect(run()).rejects.toThrow();
    world.deps.chat.failFor.clear();
    expect(await run()).toMatchObject({ status: 'sent' });
    expect(textOf('bot/u-dalmatov')).toContain(DALMATOV_PATH);
  });

  test('с флагом: запрет политикой доступа - сообщения нет, это info, а не ошибка', async () => {
    const access = new MemoryAccessPolicy();
    access.allow({ userId: IVANOV.userId, botId: PRICES_AGENT_ID, action: 'chat.message' });
    world.deps = { ...world.deps, ...OPEN, access };
    await run();
    expect(world.deps.chat.outboxOf('prices/u-dalmatov')).toHaveLength(0);
    expect(textOf(RESPONSIBLE_THREAD)).toContain(DALMATOV_PATH);
    const event = world.logs.find((l) => l.includes('price_file_authorship')) ?? '';
    expect(JSON.parse(event).fields).toMatchObject({ denied: 1, opened: 0, resolved: 0 });
    expect(EVENT_SEVERITY['price_file_authorship']).toBe('info');
  });
});
