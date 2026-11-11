import { describe, expect, test } from 'bun:test';
import { supplierSenderLookup } from '../../src/mail-sender-lookup';
import type { SupplierRepository } from '../../src/kit/ports/repositories.owned';

/** Репозиторий с одним известным адресом; остальное тесту не нужно. */
function repositoryWith(known: string, fail = false): SupplierRepository {
  const stub = {
    async findByAddresses(addresses: readonly string[]) {
      if (fail) throw new Error('db down');
      return addresses
        .filter((address) => address.toLowerCase() === known)
        .map((address) => ({ address, supplier: { id: 'sup-1', name: 'Поставщик' } }));
    },
  };
  return stub as unknown as SupplierRepository;
}

describe('допуск отправителей почты по базе поставщиков', () => {
  test('адрес поставщика допущен независимо от регистра и пробелов', async () => {
    const lookup = supplierSenderLookup(repositoryWith('sales@supplier.example'));
    expect(await lookup('  Sales@Supplier.example ')).toBe(true);
  });

  test('чужой и пустой адрес не допущены', async () => {
    const lookup = supplierSenderLookup(repositoryWith('sales@supplier.example'));
    expect(await lookup('other@elsewhere.example')).toBe(false);
    expect(await lookup('   ')).toBe(false);
  });

  test('сбой базы пробрасывается: платформа отвечает отказом по адресу', async () => {
    const lookup = supplierSenderLookup(repositoryWith('x@y.example', true));
    await expect(lookup('x@y.example')).rejects.toThrow('db down');
  });
});
