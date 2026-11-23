/**
 * Ограниченная память последних ключей: по ней отсеивается повторная доставка того же
 * события. Старые ключи вытесняются по порядку добавления.
 */
export class RecentKeys {
  private readonly limit: number;
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Помнится ли ключ. */
  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Запомнить ключ; при переполнении забывается самый старый. */
  add(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Сколько ключей помнится. */
  get size(): number {
    return this.seen.size;
  }
}
