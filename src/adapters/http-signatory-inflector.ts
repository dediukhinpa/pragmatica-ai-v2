import { DomainError } from '@business-ai/core';
import { z } from 'zod';
import type { SignatoryInflector } from '../kit/ports/signatory-inflector';

/** Ответ сервиса склонения: текст в родительном падеже либо `null` (словарь не уверен). */
const inflectResponse = z.object({ text: z.string().nullable() });

/** Путь ручки склонения подписанта у сервиса псевдонимизации. */
const INFLECT_PATH = '/inflect_signatory';

/** Параметры адаптера склонения. */
export interface HttpSignatoryInflectorOptions {
  /** Адрес сервиса псевдонимизации (тот же, что у платформы). */
  baseUrl: string;
  /** Срок запроса, мс. */
  timeoutMs: number;
  /** Общий секрет доступа (Bearer); нет - заголовок не шлётся. */
  apiToken?: string | undefined;
  /** Подмена `fetch` для тестов. */
  fetchFn?: typeof fetch | undefined;
}

/**
 * Склонение должности и ФИО подписанта договора в родительный падеж сервисом псевдонимизации.
 * Платформенный клиент этой ручки не знает (она нужна только документам Прагматики), поэтому
 * проект вызывает её сам. Значения (ФИО) уходят только в тело запроса; в ошибки они не попадают.
 */
export class HttpSignatoryInflector implements SignatoryInflector {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpSignatoryInflectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async signatoryGenitive(position: string, fullName: string): Promise<string | null> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiToken !== undefined && this.options.apiToken !== '') {
      headers.authorization = `Bearer ${this.options.apiToken}`;
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${INFLECT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ position, full_name: fullName }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new DomainError('external_failure', 'Сервис склонения недоступен.', {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new DomainError('external_failure', 'Сервис склонения вернул отказ.', {
        retryable: response.status >= HTTP_SERVER_ERROR,
      });
    }
    const parsed = inflectResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new DomainError('external_failure', 'Сервис склонения вернул неверный ответ.');
    }
    return parsed.data.text;
  }
}

/** Первый код ответа сервера, после которого повтор имеет смысл. */
const HTTP_SERVER_ERROR = 500;
