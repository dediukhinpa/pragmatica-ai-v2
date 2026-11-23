import { DomainError } from '@business-ai/core';
import type { DealManager, DealManagerReader } from '../../ports/deal-manager';

/** Менеджеры сделок в памяти для тестов: задаются вручную, сбой включается флагом. */
export class MemoryDealManagerReader implements DealManagerReader {
  private readonly managers = new Map<string, DealManager>();
  private readonly users = new Map<string, DealManager>();
  /** Сколько раз читали менеджера. */
  calls = 0;
  /** Сколько раз читали сотрудника по id. */
  userCalls = 0;
  /** Имитация сбоя портала. */
  failing = false;

  /** Задать менеджера сделки (служебный метод заглушки). */
  set(dealRef: string, manager: DealManager): void {
    this.managers.set(dealRef, { ...manager });
  }

  /** Задать контакт сотрудника портала по id (служебный метод заглушки). */
  setUser(userId: string, user: DealManager): void {
    this.users.set(userId, { ...user });
  }

  async findUser(userId: string): Promise<DealManager | null> {
    this.userCalls += 1;
    if (this.failing) {
      throw new DomainError('external_failure', 'Портал недоступен: сотрудника не прочитать.', {
        retryable: true,
      });
    }
    const user = this.users.get(userId);
    return user === undefined ? null : { ...user };
  }

  async findDealManager(dealRef: string): Promise<DealManager | null> {
    this.calls += 1;
    if (this.failing) {
      throw new DomainError('external_failure', 'Портал недоступен: менеджера не прочитать.', {
        retryable: true,
      });
    }
    const manager = this.managers.get(dealRef);
    return manager === undefined ? null : { ...manager };
  }
}
