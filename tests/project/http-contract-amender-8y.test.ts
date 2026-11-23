import { describe, expect, test } from 'bun:test';
import { HttpContractAmender } from '../../src/kit/adapters/http/http-contract-amender';
import type { FetchFn } from '@business-ai/adapters';

/**
 * Адаптер дополнения договора (этап 8y): правка номера, сторона и ответ с `not_found` уходят в
 * сервис и читаются обратно. Сеть не используется: ответ сервиса подставлен.
 */

const BASE = 'http://documents.test';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface Captured {
  params?: Record<string, unknown>;
}

function fakeFetch(captured: Captured, response: Record<string, unknown>): FetchFn {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = init?.body;
    if (body instanceof FormData) {
      captured.params = JSON.parse(String(body.get('params'))) as Record<string, unknown>;
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as FetchFn;
}

const BASE_RESPONSE = {
  file_name: 'Договор.docx',
  mime_type: DOCX_MIME,
  content_base64: Buffer.from('docx').toString('base64'),
  preamble_filled: false,
  customer_block_filled: false,
  placeholders_filled: 0,
  lines_added: 0,
  unfilled_placeholders: 0,
  notes: [],
};

describe('HttpContractAmender: правка номера и сторона (этап 8y)', () => {
  test('number_edit и party уходят в params, ответ с номером и not_found читается', async () => {
    const captured: Captured = {};
    const amender = new HttpContractAmender({
      baseUrl: BASE,
      fetchFn: fakeFetch(captured, {
        ...BASE_RESPONSE,
        party: 'executor',
        party_block_filled: true,
        not_found: ['signature_line'],
        number_status: 'appended',
        number_before: '103/11-26',
        number_after: '103/11-26 / 17/10',
      }),
    });
    const out = await amender.amend({
      fileName: 'Договор.docx',
      bytes: new TextEncoder().encode('x'),
      own: { name: 'ООО «Тест»', lines: ['ИНН 7701001238'] },
      party: 'executor',
      numberEdit: { mode: 'append', text: '17/10' },
    });
    expect(captured.params?.['party']).toBe('executor');
    expect(captured.params?.['number_edit']).toEqual({ mode: 'append', text: '17/10' });
    expect(out.numberStatus).toBe('appended');
    expect(out.numberAfter).toBe('103/11-26 / 17/10');
    expect(out.notFound).toEqual(['signature_line']);
    expect(out.partyBlockFilled).toBe(true);
  });

  test('только правка номера: own_requisites в params нет', async () => {
    const captured: Captured = {};
    const amender = new HttpContractAmender({
      baseUrl: BASE,
      fetchFn: fakeFetch(captured, BASE_RESPONSE),
    });
    const out = await amender.amend({
      fileName: 'Договор.docx',
      bytes: new TextEncoder().encode('x'),
      numberEdit: { mode: 'replace', text: '1535/10' },
    });
    expect(captured.params).not.toHaveProperty('own_requisites');
    expect(captured.params).not.toHaveProperty('party');
    expect(out.numberStatus).toBeUndefined();
  });

  test('ответ старого сервиса без новых полей читается как раньше', async () => {
    const amender = new HttpContractAmender({
      baseUrl: BASE,
      fetchFn: fakeFetch({}, BASE_RESPONSE),
    });
    const out = await amender.amend({
      fileName: 'Договор.docx',
      bytes: new TextEncoder().encode('x'),
      own: { name: 'ООО «Тест»', lines: [] },
    });
    expect(out.notFound).toBeUndefined();
    expect(out.numberStatus).toBeUndefined();
    expect(out.customerBlockFilled).toBe(false);
  });
});
