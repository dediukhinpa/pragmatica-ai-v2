import { z } from 'zod';
import { DomainError, isIntakePath } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { extensionOf, requirePort } from '@business-ai/core';
import { SCAN_EXTENSIONS, type PricesDeps } from './deps';
import { openPriceSource } from './price-sources';
import {
  readPriceFileOutputSchema,
  readPricePage,
  type ReadPriceFileOutput,
} from './read-price-file';

const listedSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  size: z.number().int(),
  receivedAt: z.string(),
  /** Скан или фото: не обрабатывается, о нём сообщают менеджеру. */
  isScan: z.boolean(),
});
type ListedIntake = z.infer<typeof listedSchema>;

interface ListOutput {
  files: ListedIntake[];
}

/** Файлы, присланные сотрудниками в этот чат. */
export const listIntakeFiles = defineTool<Record<string, never>, ListOutput, PricesDeps>(
  {
    name: 'listIntakeFiles',
    description:
      'Список файлов с прайсами, которые сотрудники прислали в этот чат: path (идентификатор ' +
      'файла, передавайте его в readIntakeFile и stagePriceRows), имя, размер, время приёма, ' +
      'признак скана. Это не путь на диске.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ files: z.array(listedSchema) }),
    async execute(_input, deps, context) {
      const intake = requirePort(deps.intake, 'файлы от сотрудников');
      const entries = await intake.list(context.threadId);
      return {
        files: entries.map((entry) => ({
          path: entry.path,
          fileName: entry.fileName,
          size: entry.size,
          receivedAt: entry.receivedAt,
          isScan: SCAN_EXTENSIONS.includes(extensionOf(entry.fileName)),
        })),
      };
    },
  },
);

interface ReadIntakeInput {
  path: string;
  cursor?: string | undefined;
}

/** Прочитать файл от сотрудника постранично (как readPriceFile, но только из чата). */
export const readIntakeFile = defineTool<ReadIntakeInput, ReadPriceFileOutput, PricesDeps>({
  name: 'readIntakeFile',
  readsFile: true,
  description:
    'Прочитать файл, присланный сотрудником (path из listIntakeFiles или из сообщения о ' +
    'файле), постранично: markdown таблиц, tableRows, nextCursor, флаги needsOcr, truncated, ' +
    'hidden, предупреждения. Скан (needsOcr=true) не обрабатывается: сообщите менеджеру ' +
    '(scan_skipped).',
  inputSchema: z.object({ path: z.string().min(1), cursor: z.string().min(1).optional() }),
  outputSchema: readPriceFileOutputSchema,
  async execute(input, deps, context) {
    if (!isIntakePath(input.path)) {
      throw new DomainError(
        'invalid_input',
        'Нужен идентификатор файла от сотрудника (из listIntakeFiles), а не путь на диске.',
      );
    }
    const source = await openPriceSource(deps, input.path, context);
    return readPricePage(deps, source, input.cursor);
  },
});
