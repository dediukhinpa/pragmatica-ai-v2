import { describe, expect, test } from 'bun:test';
import {
  ModelSupplierSiteChooser,
  type WebPagePiiStripReport,
} from '../../../src/kit/adapters/litellm/web-candidate-model';
import type { ModelGateway, ModelRequest, ModelStopReason } from '@business-ai/core';

const TIMEOUT_MS = 5_000;

/** Шлюз-заглушка: запоминает запросы и отдаёт заданный ответ. */
function gatewayOf(content: string, stopReason: ModelStopReason = 'end_turn') {
  const seen: ModelRequest[] = [];
  const gateway: ModelGateway = {
    async complete(request) {
      seen.push(request);
      return { model: request.model, content, stopReason };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('не используется');
    },
  };
  return { gateway, seen };
}

const signal = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(TIMEOUT_MS) });
const INPUT = {
  name: 'мед Перони',
  products: ['Мёд липовый'],
  hits: [{ title: 'Peroni Honey', url: 'https://peronihoney.ru/', snippet: 'мёд' }],
};

describe('ModelSupplierSiteChooser', () => {
  test('ответ в блоке кода разбирается, в запросе только карточка и выдача', async () => {
    const { gateway, seen } = gatewayOf('```json\n{"site":"https://peronihoney.ru/"}\n```');
    const chooser = new ModelSupplierSiteChooser(gateway, 'alias');
    expect(await chooser.chooseSite(INPUT, signal())).toEqual({ site: 'https://peronihoney.ru/' });
    expect(seen[0]?.model).toBe('alias');
    expect(seen[0]?.messages[1]?.content).toContain('peronihoney.ru');
  });

  test('обрыв лимитом токенов или не JSON: null (вызывающий код идёт запасным путём)', async () => {
    const cut = new ModelSupplierSiteChooser(gatewayOf('{"site":"htt', 'max_tokens').gateway, 'a');
    expect(await cut.checkName(INPUT, signal())).toBeNull();
    const text = new ModelSupplierSiteChooser(gatewayOf('не знаю').gateway, 'a');
    expect(await text.chooseSite(INPUT, signal())).toBeNull();
  });
});

/** Выдача-ловушка: во фрагменте ФИО директора и его личный телефон. */
const TRAP_INPUT = {
  ...INPUT,
  hits: [
    {
      title: 'Peroni Honey - мёд',
      url: 'https://peronihoney.ru/',
      snippet: 'Директор Сидоров Пётр Алексеевич, моб. +7 916 555-12-34, г. Тула. Мёд от 850 руб.',
    },
  ],
};
const TRAP_VALUES = ['Сидоров', 'Алексеевич', '555-12-34'];
const bodyOf = (seen: ModelRequest[]): string =>
  seen.map((request) => request.messages.map((message) => message.content).join('\n')).join('\n');

describe('ModelSupplierSiteChooser: очистка фрагментов выдачи от ПДн', () => {
  test('enforce: ФИО и телефон из фрагмента модели не уходят, цена и город на месте', async () => {
    const { gateway, seen } = gatewayOf('{"site":"https://peronihoney.ru/"}');
    const reports: WebPagePiiStripReport[] = [];
    const chooser = new ModelSupplierSiteChooser(gateway, 'a', {
      mode: 'enforce',
      onReport: (report) => reports.push(report),
    });
    expect(await chooser.chooseSite(TRAP_INPUT, signal())).toEqual({
      site: 'https://peronihoney.ru/',
    });
    const body = bodyOf(seen);
    for (const value of TRAP_VALUES) expect(body).not.toContain(value);
    expect(body).toContain('г. Тула');
    expect(body).toContain('850 руб');
    expect(body).toContain('https://peronihoney.ru/');
    expect(reports[0]).toMatchObject({ mode: 'enforce', scope: 'snippets', failed: 0 });
    expect(reports[0]?.counts.fio).toBe(1);
    expect(reports[0]?.counts.phone).toBe(1);
  });

  test('log_only: запрос прежний, но находки посчитаны', async () => {
    const { gateway, seen } = gatewayOf('{"site":null}');
    const reports: WebPagePiiStripReport[] = [];
    const chooser = new ModelSupplierSiteChooser(gateway, 'a', {
      mode: 'log_only',
      onReport: (report) => reports.push(report),
    });
    await chooser.chooseSite(TRAP_INPUT, signal());
    expect(bodyOf(seen)).toContain('Сидоров');
    expect(reports[0]?.counts.fio).toBe(1);
  });

  test('off и без настройки: запрос прежний, отчётов нет', async () => {
    const { gateway, seen } = gatewayOf('{"site":null}');
    const reports: WebPagePiiStripReport[] = [];
    const chooser = new ModelSupplierSiteChooser(gateway, 'a', {
      mode: 'off',
      onReport: (report) => reports.push(report),
    });
    await chooser.chooseSite(TRAP_INPUT, signal());
    expect(bodyOf(seen)).toContain('Сидоров');
    expect(reports).toHaveLength(0);
  });

  test('enforce: сбой очистки - модель не вызывается, ответ null (fail closed)', async () => {
    const { gateway, seen } = gatewayOf('{"site":"https://peronihoney.ru/"}');
    const chooser = new ModelSupplierSiteChooser(gateway, 'a', {
      mode: 'enforce',
      sanitize: () => {
        throw new Error('detector_down');
      },
    });
    expect(await chooser.chooseSite(TRAP_INPUT, signal())).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
