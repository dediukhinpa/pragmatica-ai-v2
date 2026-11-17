import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpContractAmender } from '../../src/kit/adapters/http/http-contract-amender';

/**
 * Контрактный тест адаптера дополнения договора против живого сервиса документов проекта
 * (образ `pragmatika-documents` или тот же код из venv). Запускается только с окружением
 * `DOCUMENTS_CONTRACT_URL` (базовый адрес) и `DOCUMENTS_CONTRACT_FIXTURES` (каталог с
 * синтетическими docx из `services/documents-docx/tests/make_contract_fixtures.py`); без него
 * пропускается, как интеграционные тесты. Данные заказчика не используются.
 *
 * `DOCUMENTS_CONTRACT_EXPECT=missing` проверяет обратное: на платформенном документах без
 * проектного слоя все четыре маршрута `/docx/*` отвечают 404 (красный до исправления).
 */

const baseUrl = process.env['DOCUMENTS_CONTRACT_URL'];
const fixturesDir = process.env['DOCUMENTS_CONTRACT_FIXTURES'];
const expectMissing = process.env['DOCUMENTS_CONTRACT_EXPECT'] === 'missing';
const enabled = baseUrl !== undefined && baseUrl !== '' && fixturesDir !== undefined;
// Конвертация RTF/.doc идёт через LibreOffice: в образе проекта он есть, на хосте с venv нет.
const convertEnabled = process.env['DOCUMENTS_CONTRACT_CONVERT'] === '1';

const DOCX_ROUTES = ['amend', 'party-block', 'replace-signatory', 'classify'] as const;
const STATUS_NOT_FOUND = 404;
const STATUS_OK = 200;
const ZIP_MAGIC = [0x50, 0x4b];
const TIMEOUT_MS = 120_000;
const metaSchema = z.object({
  ownName: z.string(),
  ownInn: z.string(),
  ownLines: z.array(z.string()),
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir ?? '', name)));
}

function isDocx(bytes: Uint8Array): boolean {
  return bytes[0] === ZIP_MAGIC[0] && bytes[1] === ZIP_MAGIC[1];
}

describe.skipIf(!enabled || expectMissing)('HttpContractAmender против сервиса проекта', () => {
  const amender = new HttpContractAmender({ baseUrl: baseUrl ?? '', timeoutMs: TIMEOUT_MS });
  // Тело describe выполняется и у пропущенного набора: файл читаем только по требованию теста.
  const loadMeta = (): z.infer<typeof metaSchema> =>
    metaSchema.parse(JSON.parse(readFileSync(join(fixturesDir ?? '', 'meta.json'), 'utf8')));

  test('replace-signatory подставляет подписанта и отдаёт docx', async () => {
    const result = await amender.replaceSignatory({
      bytes: fixture('signatory-template.docx'),
      forms: {
        nominativeShort: 'Образцова А.С.',
        nominativeReversed: 'А.С. Образцова',
        genitiveFull: 'Образцовой Анны Сергеевны',
        genitiveShort: 'Образцовой А.С.',
      },
    });
    expect(result.unchanged).toBe(false);
    expect(result.replaced).toBeGreaterThan(0);
    expect(isDocx(result.bytes)).toBe(true);
  });

  test('amend дополняет блок заказчика, party-block читает его обратно', async () => {
    const meta = loadMeta();
    const amended = await amender.amend({
      fileName: 'Договор.docx',
      bytes: fixture('contract.docx'),
      own: { name: meta.ownName, lines: meta.ownLines },
    });
    expect(amended.customerBlockFilled).toBe(true);
    expect(isDocx(amended.bytes)).toBe(true);
    const block = await amender.readPartyBlock({ bytes: amended.bytes, role: 'Заказчик' });
    expect(block.name).toBe(meta.ownName);
    expect(block.lines.length).toBeGreaterThan(0);
  });

  test.skipIf(!convertEnabled)(
    'RTF приводится к docx (LibreOffice): party-block читает блок, amend отдаёт docx',
    async () => {
      const meta = loadMeta();
      const amended = await amender.amend({
        fileName: 'Договор.rtf',
        bytes: fixture('contract.rtf'),
        own: { name: meta.ownName, lines: meta.ownLines },
      });
      expect(amended.convertedFrom).toBe('rtf');
      expect(isDocx(amended.bytes)).toBe(true);
      const block = await amender.readPartyBlock({ bytes: amended.bytes, role: 'Заказчик' });
      expect(block.name).toBe(meta.ownName);
    },
  );

  test('classify: чужой договор — supplier, наш шаблон — own_template', async () => {
    const meta = loadMeta();
    const common = {
      templates: [fixture('own-template.docx')],
      ownInns: [meta.ownInn],
      ownNames: [meta.ownName],
    };
    const supplier = await amender.classify({
      fileName: 'supplier.docx',
      bytes: fixture('supplier.docx'),
      ...common,
    });
    expect(supplier.verdict).toBe('supplier');
    const own = await amender.classify({
      fileName: 'own.docx',
      bytes: fixture('own-template.docx'),
      ...common,
    });
    expect(own.verdict).toBe('own_template');
  });

  test('платформенные маршруты работают как в 1.1.3: health, render и parse не 404', async () => {
    const health = await fetch(`${baseUrl ?? ''}/health`);
    expect(health.status).toBe(STATUS_OK);
    for (const route of ['/render', '/parse']) {
      const response = await fetch(`${baseUrl ?? ''}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).not.toBe(STATUS_NOT_FOUND);
    }
  });
});

describe.skipIf(!enabled || !expectMissing)('платформенный documents без проектного слоя', () => {
  test.each([...DOCX_ROUTES])('/docx/%s отвечает 404', async (route) => {
    const response = await fetch(`${baseUrl ?? ''}/docx/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(STATUS_NOT_FOUND);
  });
});
