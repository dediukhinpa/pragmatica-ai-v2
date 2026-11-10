import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentParser,
  MemoryFileSource,
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
import { runProbe, splitArg, type ProbeFn } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';

/** Тестовый секрет идентификаторов файлов: в прогоне оценки перезапусков нет. */
const EVAL_FILE_REF_SECRET = 'eval-file-ref-secret';

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
  const deps: PricesDeps = {
    files,
    fileRefSecret: EVAL_FILE_REF_SECRET,
    parser: new MemoryDocumentParser(),
    prices,
    staging: new MemoryImportStaging(),
    suppliers,
    chat,
    clock:
      testCase.state.now === undefined
        ? new FixedClock()
        : new FixedClock(new Date(testCase.state.now)),
    managerThreadId: MANAGER_THREAD,
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
  };
  return {
    declaration: createPricesAgent({ model }),
    toolDeps: deps,
    probe: (name, arg) => runProbe('prices', probes, name, arg),
  };
}
