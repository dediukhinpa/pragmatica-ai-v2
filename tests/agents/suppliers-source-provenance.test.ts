import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  VALUE_NOT_IN_SOURCE,
  enforceSourceProvenance,
} from '../../src/agents/suppliers/source-provenance';
import { createSupplierFromAttachment } from '../../src/agents/suppliers/attachment-create';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import {
  BOT_PRICES,
  INN_ALPHA,
  INN_BETA,
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/** Реквизиты принимаются только дословно из вложения или сообщения (синтетические данные). */

const FILE_TEXT = [
  'Карточка предприятия',
  'ООО «Бета Трейд»',
  `ИНН ${INN_BETA.slice(0, 4)} ${INN_BETA.slice(4)}`,
  'КПП 7707-01001',
  'ОГРН 1 02 770 000 0000',
  'р/с 40702810900000000001 в банке «Тест-Банк», БИК 044525000',
  'Директор: Иванов Иван Иванович',
  'Тел.: +7 (495) 123-45-67',
].join('\n');

describe('enforceSourceProvenance', () => {
  test('значение есть в файле: принимается', () => {
    const out = enforceSourceProvenance({ inn: INN_BETA, kpp: '770701001' }, [FILE_TEXT]);
    expect(out.rejected).toEqual([]);
    expect(out.fields.inn).toBe(INN_BETA);
  });

  test('другое форматирование: пробелы, дефисы, кавычки, регистр, NBSP', () => {
    const out = enforceSourceProvenance(
      {
        name: 'ооо "бета трейд"',
        inn: INN_BETA,
        kpp: '770701001',
        ogrn: '1027700000000',
        bankName: 'ТЕСТ БАНК',
        bik: '044 525 000',
        settlementAccount: '40702 810 9000 0000 0001',
        directorName: 'иванов иван иванович',
        contacts: [{ phone: '8 495 123 45 67' }],
      },
      [FILE_TEXT],
    );
    expect(out.rejected).toEqual([]);
  });

  test('выдуманный ИНН отклоняется, остальное остаётся', () => {
    const out = enforceSourceProvenance({ name: 'Бета Трейд', inn: INN_ALPHA, kpp: '770701001' }, [
      FILE_TEXT,
    ]);
    expect(out.rejected).toEqual([{ field: 'inn', code: VALUE_NOT_IN_SOURCE }]);
    expect(out.fields.inn).toBeUndefined();
    expect(out.fields.kpp).toBe('770701001');
    expect(out.fields.name).toBe('Бета Трейд');
  });

  test('смесь верных и выдуманных значений, в том числе в контактах', () => {
    const out = enforceSourceProvenance(
      {
        bik: '044525000',
        settlementAccount: '40702810900000000999',
        contacts: [{ fullName: 'Петров Пётр Петрович', phone: '+7 495 123 45 67' }],
      },
      [FILE_TEXT],
    );
    expect(out.rejected.map((item) => item.field)).toEqual([
      'settlementAccount',
      'contacts[0].fullName',
    ]);
    expect(out.fields.bik).toBe('044525000');
    expect(out.fields.contacts?.[0]?.phone).toBe('+7 495 123 45 67');
    expect(out.fields.contacts?.[0]?.fullName).toBeUndefined();
  });

  test('соседние числа не склеиваются в выдуманный номер', () => {
    const out = enforceSourceProvenance({ inn: '1234567890' }, ['ИНН 12345 КПП 67890']);
    expect(out.rejected.map((item) => item.field)).toEqual(['inn']);
  });

  test('сообщение сотрудника служит источником наравне с файлом', () => {
    const out = enforceSourceProvenance({ inn: INN_ALPHA }, [FILE_TEXT, `ИНН ${INN_ALPHA}`]);
    expect(out.rejected).toEqual([]);
  });
});

describe('createSupplierFromAttachment: выдуманные реквизиты', () => {
  let world: SupplierWorld;
  beforeEach(() => {
    world = buildSupplierWorld();
    const access = new MemoryAccessPolicy();
    access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
    world.deps.access = access;
  });
  const ctx = () => turnContext(USER_A, THREAD_A);

  test('этап 177: выдуманный ИНН не записывается, карточка без него (warning)', async () => {
    const out = await createSupplierFromAttachment.execute(
      { name: 'Бета Трейд', inn: INN_ALPHA, sourceText: 'ООО «Бета Трейд», КПП 770701001' },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('created');
    expect(out.rejected).toEqual([{ field: 'inn', code: VALUE_NOT_IN_SOURCE }]);
    expect(out.warnings.join(' ')).toContain(VALUE_NOT_IN_SOURCE);
    expect(out.warnings.join(' ')).toContain('ИНН не найден');
    const [card] = await world.suppliers.searchCards({ limit: 10 });
    expect(card?.name).toBe('Бета Трейд');
    expect(card?.inn).toBeUndefined();
  });

  test('верные значения проходят, выдуманный КПП отклонён без блокировки карточки', async () => {
    const out = await createSupplierFromAttachment.execute(
      { inn: INN_BETA, kpp: '999999999', sourceText: FILE_TEXT },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('created');
    expect(out.rejected).toEqual([{ field: 'kpp', code: VALUE_NOT_IN_SOURCE }]);
    const [card] = await world.suppliers.searchCards({ limit: 10 });
    expect(card?.inn).toBe(INN_BETA);
    expect(card?.kpp).toBeUndefined();
  });

  test('без источника значения модели не принимаются', async () => {
    const out = await createSupplierFromAttachment.execute(
      { name: 'Бета Трейд', inn: INN_BETA },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('not_recognized');
    expect(out.rejected.map((item) => item.field)).toEqual(['name', 'inn']);
  });
});
