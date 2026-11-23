import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentParser,
  MemoryFileSource,
  MemoryIntakeStore,
  MemoryTableExporter,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryImportStaging } from '../../src/kit/adapters/memory/import-staging';
import {
  MemoryPriceRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import {
  employeeEditKey,
  saveEmployeeFileEdits,
  type EmployeeFileEdit,
} from '../../src/employee-file-edits';
import { type PricesDeps } from '../../src/agents/prices/deps';
import type { PricesCase } from '../cases';
import { MANAGER_THREAD } from '../constants';
import { chatMessageCount } from '@business-ai/eval';
import { seedFiles, seedPrices, seedSuppliers } from './common';
import {
  DeckMarkdownParser,
  DeckPriceEditor,
  StubPriceSpotReader,
  chatFileBytes,
  priceEditProbes,
} from './price-edit-first';
import { runProbe, splitArg, type ProbeFn } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';

/** Тестовый секрет идентификаторов файлов: в прогоне оценки перезапусков нет. */
const EVAL_FILE_REF_SECRET = 'eval-file-ref-secret';
/** Тред чата сотрудника в реестре правок: автор записи (в eval отдельного треда у записи нет). */
const EVAL_EMPLOYEE_AUTHOR = 'eval-employee-thread';
/** Условный сотрудник, чей ход начал чат (правка файла идёт только в чате сотрудника). */
const EVAL_EMPLOYEE_USER = 'eval-employee';

/**
 * Записать в состояние реестр правок сотрудника из кейса (этап 9q). Цену берёт из строки `prices`
 * той же позиции; дата строки должна совпадать с `editedAt`, иначе защита от старого файла не
 * сработает (запись реестра считалась бы устаревшей), и кейс сообщает об этом сразу.
 */
async function seedEmployeeFileEdits(
  state: MemoryWorkflowStateStore,
  testCase: PricesCase,
  now: Date,
): Promise<void> {
  const bySupplier = new Map<string, Record<string, EmployeeFileEdit>>();
  for (const edit of testCase.state.employeeFileEdits) {
    const row = testCase.state.prices.find(
      (candidate) =>
        candidate.supplierId === edit.supplierId &&
        candidate.productName === edit.productName &&
        candidate.sku === edit.sku,
    );
    if (row === undefined || Date.parse(row.date) !== Date.parse(edit.editedAt)) {
      throw new Error(
        `Кейс ${testCase.id}: для «${edit.productName}» нужна строка prices с date = editedAt`,
      );
    }
    const entries = bySupplier.get(edit.supplierId) ?? {};
    entries[employeeEditKey(edit)] = {
      editedAt: edit.editedAt,
      fileName: edit.fileName,
      author: EVAL_EMPLOYEE_AUTHOR,
      price: row.price,
    };
    bySupplier.set(edit.supplierId, entries);
  }
  for (const [supplierId, entries] of bySupplier) {
    await saveEmployeeFileEdits(state, supplierId, entries, now);
  }
}

/** Окружение агента «Актуализация прайса (ИИ агент)» из начального состояния кейса. */
export async function buildPricesEnvironment(
  testCase: PricesCase,
  model: string,
): Promise<EvalEnvironment> {
  const suppliers = new MemorySupplierRepository();
  const prices = new MemoryPriceRepository();
  const files = new MemoryFileSource();
  const chat = new MemoryChatChannel();
  await seedSuppliers(suppliers, testCase.state.suppliers);
  await seedPrices(prices, testCase.state.prices);
  seedFiles(files, testCase.state.files);
  const clock =
    testCase.state.now === undefined
      ? new FixedClock()
      : new FixedClock(new Date(testCase.state.now));
  // Файлы чата и правка файла сразу (этап 9p): состояние сценариев, приём файлов, парсер
  // презентаций и редактор-заглушка - только у кейсов с флагом или файлами чата; у остальных
  // зависимости прежние.
  const { chatFiles, priceEditFirst, priceEditDbWrite, priceTextBlocks, priceSpots } =
    testCase.state;
  const withChat = priceEditFirst || chatFiles.length > 0;
  const state = new MemoryWorkflowStateStore();
  const intake = new MemoryIntakeStore(clock);
  const editor = new DeckPriceEditor(priceSpots);
  await seedEmployeeFileEdits(state, testCase, clock.now());
  const deps: PricesDeps = {
    files,
    fileRefSecret: EVAL_FILE_REF_SECRET,
    parser: withChat ? new DeckMarkdownParser() : new MemoryDocumentParser(),
    prices,
    staging: new MemoryImportStaging(),
    suppliers,
    chat,
    clock,
    managerThreadId: MANAGER_THREAD,
    ...(withChat
      ? { state, intake, tableExporter: new MemoryTableExporter(), priceFileEditor: editor }
      : {}),
    // Числа вне таблиц слайдов (этап 9q): порт карты мест, как при PRICE_EDIT_TEXT_BLOCKS_ENABLED.
    ...(priceEditFirst && priceTextBlocks
      ? { priceSpots: new StubPriceSpotReader(priceSpots) }
      : {}),
  };
  const supplierIds = [
    ...new Set([
      ...testCase.state.suppliers.map((supplier) => supplier.id),
      ...testCase.state.prices.map((row) => row.supplierId),
    ]),
  ];
  const probes: Record<string, ProbeFn> = {
    chatMessages: () => chatMessageCount(chat),
    storedPriceCount: async () => {
      let total = 0;
      for (const id of supplierIds) total += (await prices.listBySupplier(id)).length;
      return total;
    },
    storedPrice: async (arg) => {
      const [supplierId, productName] = splitArg('storedPrice', arg);
      const items = await prices.listBySupplier(supplierId);
      return items.find((item) => item.productName === productName)?.price ?? null;
    },
    // Число тиражей позиции (0 - тиражей нет): основная цена при этом - минимального тиража.
    storedPriceTiers: async (arg) => {
      const [supplierId, productName] = splitArg('storedPriceTiers', arg);
      const items = await prices.listBySupplier(supplierId);
      const item = items.find((candidate) => candidate.productName === productName);
      return item === undefined ? null : (item.priceTiers?.length ?? 0);
    },
    ...(priceEditFirst ? priceEditProbes(chat, editor, state) : {}),
  };
  return {
    declaration: createPricesAgent({
      model,
      ...(priceEditFirst ? { priceEditFirst: true } : {}),
      ...(priceEditFirst && priceEditDbWrite ? { priceEditDbWrite: true } : {}),
      ...(priceEditFirst && priceTextBlocks ? { priceTextBlocks: true } : {}),
    }),
    toolDeps: deps,
    probe: (name, arg) => runProbe('prices', probes, name, arg),
    ...(withChat
      ? {
          // Ход начат сотрудником в чате: правка файла и ответ «да»/«нет» идут в его треде.
          runContext: { initiator: { kind: 'user' as const, userId: EVAL_EMPLOYEE_USER } },
          // Файлы чата лежат в хранилище приёма этого треда до первого хода.
          beforeRun: async (threadId: string) => {
            for (const file of chatFiles) {
              await intake.put(threadId, file.path, chatFileBytes(file.path, file.text));
            }
          },
          // Ответ сотрудника («да», «нет») - новый ход после завершённого.
          followUpsAfterCompletedTurn: true,
        }
      : {}),
  };
}
