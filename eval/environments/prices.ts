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
import { type PricesDeps } from '../../src/agents/prices/deps';
import type { PricesCase } from '../cases';
import { MANAGER_THREAD } from '../constants';
import { chatMessageCount } from '@business-ai/eval';
import { seedFiles, seedPrices, seedSuppliers } from './common';
import {
  DeckMarkdownParser,
  DeckPriceEditor,
  chatFileBytes,
  priceEditProbes,
} from './price-edit-first';
import { runProbe, splitArg, type ProbeFn } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';

/** Тестовый секрет идентификаторов файлов: в прогоне оценки перезапусков нет. */
const EVAL_FILE_REF_SECRET = 'eval-file-ref-secret';
/** Условный сотрудник, чей ход начал чат (правка файла идёт только в чате сотрудника). */
const EVAL_EMPLOYEE_USER = 'eval-employee';

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
  const { chatFiles, priceEditFirst } = testCase.state;
  const withChat = priceEditFirst || chatFiles.length > 0;
  const state = new MemoryWorkflowStateStore();
  const intake = new MemoryIntakeStore(clock);
  const editor = new DeckPriceEditor();
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
    declaration: createPricesAgent({ model, ...(priceEditFirst ? { priceEditFirst: true } : {}) }),
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
