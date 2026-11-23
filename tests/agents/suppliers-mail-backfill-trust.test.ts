import { beforeEach, describe, expect, test } from 'bun:test';
import type { SupplierMailEnrichDeps } from '../../src/agents/suppliers/mail-enrich';
import { renderBackfillReport } from '../../src/agents/suppliers/mail-backfill-report';
import { INN_ALPHA } from './suppliers-support';
import {
  SOURCE_ID,
  allCards,
  build,
  letter,
  run,
  seed,
  type World,
} from './suppliers-mail-backfill-support';

/**
 * Разовый проход по info@ с моделью доверия (этап 233): карточка доверенного отправителя
 * дополняется, реквизиты письма - только на подтверждение в отчёте, непроверенный - только отчёт.
 */

const STRICT = { policy: { websiteDomain: false, replyThread: false } };

let world: World;
beforeEach(() => {
  world = build();
});

function withTrust(extra: Partial<SupplierMailEnrichDeps> = {}): void {
  world.deps = { ...world.deps, senderTrust: STRICT, ...extra };
}

const VEGA = { name: 'ООО «Вега Трейд»', contacts: [{ email: 'boss@vega-trade.test' }] };

describe('info@ с моделью доверия', () => {
  test('без модели доверия существующая карточка не меняется (как раньше)', async () => {
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const result = await run(world);
    expect(result.enrichedExisting).toBe(0);
    expect(result.proposalLetters).toBe(1);
    expect((await world.suppliers.getCard(card.id))?.website).toBeUndefined();
  });

  test('домен отправителя есть в карточке: сайт дописан, ИНН - только в отчёт с пометкой', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const result = await run(world);
    expect(result).toMatchObject({ enrichedExisting: 1, trustedCardDomain: 1, requisiteLetters: 1 });
    const saved = await world.suppliers.getCard(card.id);
    expect(saved?.website).toContain('vega-trade.test');
    expect(saved?.inn).toBeUndefined();
    expect(saved?.notes.some((n) => n.text.includes('Реквизиты изменились'))).toBe(true);
    const item = world.file.report?.items.find((entry) => entry.field === 'inn');
    expect(item?.requisites).toBe(true);
    expect(item?.approved).toBe(false);
    expect(renderBackfillReport(world.file.report ?? ({} as never))).toContain(
      '[реквизиты изменились]',
    );
  });

  test('повторный запуск не плодит дубли пунктов и пометок', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world);
    const first = world.file.report?.items.length;
    await run(world);
    expect(world.file.report?.items.length).toBe(first);
    const saved = await world.suppliers.getCard(card.id);
    expect(saved?.notes.filter((n) => n.text.includes('Реквизиты изменились')).length).toBe(1);
  });

  test('чужой домен без DKIM: непроверенный, карточка не меняется, предложение в отчёте', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1', { from: 'sales@intruder.test' }));
    const result = await run(world);
    expect(result.enrichedExisting).toBe(0);
    expect(result.proposalLetters).toBe(1);
    expect((await world.suppliers.getCard(card.id))?.website).toBeUndefined();
  });

  test('чужой домен, но DKIM выровнен (проверка по требованию): дополняется, контакты чужого домена - нет', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m1', { from: 'sales@intruder.test', dkim: 'aligned' }),
    );
    const result = await run(world);
    expect(result).toMatchObject({ trustedDkim: 1, requisiteLetters: 1 });
    const saved = await world.suppliers.getCard(card.id);
    expect(saved?.contacts.some((c) => c.email === 'sales@intruder.test')).toBe(false);
    expect(saved?.inn).toBeUndefined();
  });

  test('сервер сказал pass, своего DKIM нет: чужой домен остаётся непроверенным', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m1', { from: 'sales@intruder.test', senderAuth: 'verified', serverAuth: 'verified' }),
    );
    const result = await run(world);
    expect(result).toMatchObject({ enrichedExisting: 0, trustedDkim: 0, proposalLetters: 1 });
    expect((await world.suppliers.getCard(card.id))?.website).toBeUndefined();
  });

  test('новая карточка из письма непроверенного создаётся без признака черновика', async () => {
    withTrust();
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const result = await run(world);
    expect(result.created).toBe(1);
    expect((await allCards(world))[0]).not.toHaveProperty('isDraft');
  });

  test('пробный запуск считает, но не пишет', async () => {
    withTrust();
    const card = await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const result = await run(world, { dryRun: true });
    expect(result.enrichedExisting).toBe(1);
    const saved = await world.suppliers.getCard(card.id);
    expect(saved?.website).toBeUndefined();
    expect(saved?.notes.some((n) => n.text.includes('Реквизиты изменились'))).toBe(false);
    expect(INN_ALPHA).toBeDefined();
  });

  test('в журнале нет адресов и значений реквизитов', async () => {
    withTrust();
    await seed(world, VEGA);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world);
    const dump = JSON.stringify(world.logs);
    expect(dump).not.toContain('vega-trade');
    expect(dump).not.toContain(INN_ALPHA);
    expect(world.logs.some((entry) => entry.event === 'supplier_mail_requisites_withheld')).toBe(true);
  });
});
