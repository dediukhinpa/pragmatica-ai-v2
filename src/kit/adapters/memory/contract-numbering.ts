import { formatContractNumber } from '../../domain/contract-number';
import { SHARED_COUNTER_KEY } from '../../ports/contract-numbering';
import type {
  ContractNumberRequest,
  ContractNumbering,
  IssuedContractNumber,
  LatestContractNumber,
} from '../../ports/contract-numbering';

/** Длина даты `ГГГГ-ММ-ДД`. */
const DATE_LENGTH = 10;

/** Нумерация договоров в памяти (для тестов и локальной сборки). */
export class MemoryContractNumbering implements ContractNumbering {
  private readonly counters = new Map<string, number>();
  private readonly issued = new Map<string, IssuedContractNumber>();
  /** Дата договора и порядок выдачи по ключу операции (для `findLatest`). */
  private readonly meta = new Map<string, { documentDate: string; order: number }>();
  private order = 0;

  async issue(request: ContractNumberRequest): Promise<IssuedContractNumber> {
    const existing = this.issued.get(request.operationKey);
    if (existing !== undefined) return { ...existing };
    // Метод синхронный до конца: между чтением и записью счётчика других задач нет.
    // Ключ общий для юрлиц: нумерация сквозная, как в Postgres-адаптере.
    const counterKey = `${SHARED_COUNTER_KEY}:${request.year}`;
    const sequence = (this.counters.get(counterKey) ?? 0) + 1;
    const number = formatContractNumber(request.legalEntity, request.year, sequence);
    this.counters.set(counterKey, sequence);
    const entry: IssuedContractNumber = {
      operationKey: request.operationKey,
      legalEntity: request.legalEntity,
      year: request.year,
      sequence,
      number,
    };
    this.issued.set(request.operationKey, entry);
    this.order += 1;
    this.meta.set(request.operationKey, {
      documentDate: request.documentDate ?? new Date().toISOString().slice(0, DATE_LENGTH),
      order: this.order,
    });
    return { ...entry };
  }

  async find(operationKey: string): Promise<IssuedContractNumber | null> {
    const entry = this.issued.get(operationKey);
    return entry === undefined ? null : { ...entry };
  }

  async findLatest(
    operationKeyPrefix: string,
    legalEntity: string,
  ): Promise<LatestContractNumber | null> {
    let latest: LatestContractNumber | null = null;
    let latestOrder = 0;
    for (const [key, entry] of this.issued) {
      const meta = this.meta.get(key);
      if (meta === undefined || entry.legalEntity !== legalEntity) continue;
      if (!key.startsWith(operationKeyPrefix) || meta.order <= latestOrder) continue;
      latest = { ...entry, documentDate: meta.documentDate };
      latestOrder = meta.order;
    }
    return latest;
  }
}
