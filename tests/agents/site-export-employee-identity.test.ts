import { describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryEmployeeIdentity,
  MemoryStaffDirectory,
  STAFF_IDENTITY_TTL_MS,
  StaffEmployeeIdentity,
} from '@business-ai/adapters';
import { resolveEmployeeIdentity } from '../../src/agents/site-export/employee-identity';
import { createToolContext } from '@business-ai/core';

/** Имя сотрудника для поля «менеджер»: из каталога по userId, не из текста сообщения. */

const employeeTurn = (userId: string) =>
  createToolContext({
    threadId: 'orders/2002',
    agentId: 'site-export',
    operationId: 'op',
    initiator: { kind: 'user', userId },
  });

describe('resolveEmployeeIdentity', () => {
  test('известный сотрудник: «Имя Фамилия» из личности', async () => {
    const employeeIdentity = new MemoryEmployeeIdentity();
    employeeIdentity.set('2002', { firstName: 'Иван', lastName: 'Тестов' });
    const result = await resolveEmployeeIdentity({ employeeIdentity }, employeeTurn('2002'));
    expect(result).toEqual({
      status: 'known',
      fullName: 'Иван Тестов',
      firstName: 'Иван',
      lastName: 'Тестов',
    });
  });

  test('чужое имя в тексте не влияет: берётся userId хода', async () => {
    const employeeIdentity = new MemoryEmployeeIdentity();
    employeeIdentity.set('2002', { firstName: 'Иван', lastName: 'Тестов' });
    employeeIdentity.set('3003', { firstName: 'Пётр', lastName: 'Другой' });
    const result = await resolveEmployeeIdentity({ employeeIdentity }, employeeTurn('2002'));
    expect(result).toMatchObject({ fullName: 'Иван Тестов' });
  });

  test('нет в каталоге, нет каталога, каталог упал: явный unknown с причиной', async () => {
    const employeeIdentity = new MemoryEmployeeIdentity();
    expect(await resolveEmployeeIdentity({ employeeIdentity }, employeeTurn('9'))).toEqual({
      status: 'unknown',
      reason: 'not_in_directory',
    });
    expect(await resolveEmployeeIdentity({}, employeeTurn('9'))).toEqual({
      status: 'unknown',
      reason: 'not_configured',
    });
    const staff = new MemoryStaffDirectory();
    staff.failing = true;
    const broken = new StaffEmployeeIdentity({ staff, clock: new FixedClock() });
    expect(await resolveEmployeeIdentity({ employeeIdentity: broken }, employeeTurn('9'))).toEqual({
      status: 'unknown',
      reason: 'directory_unavailable',
    });
  });

  test('ход не сотрудника (плановый запуск): отказ, имя не определяется', async () => {
    const system = createToolContext({ threadId: 't', agentId: 'a', operationId: 'o' });
    await expect(resolveEmployeeIdentity({}, system)).rejects.toThrow();
  });
});

describe('StaffEmployeeIdentity', () => {
  const people = [
    { userId: '1', firstName: 'Анна', lastName: 'Образцова', login: 'a' },
    { userId: '2', firstName: '', lastName: 'БезИмени', login: 'b' },
    { userId: '3', firstName: 'БезФамилии', lastName: '  ', login: 'c' },
  ];

  test('имя и фамилия обязательны: карточка без одного из них - null', async () => {
    const staff = new MemoryStaffDirectory();
    staff.set('department:1', people);
    const identity = new StaffEmployeeIdentity({ staff, clock: new FixedClock() });
    expect(await identity.nameOf('1')).toEqual({ firstName: 'Анна', lastName: 'Образцова' });
    expect(await identity.nameOf('2')).toBeNull();
    expect(await identity.nameOf('3')).toBeNull();
    expect(await identity.nameOf('404')).toBeNull();
  });

  test('каталог читается один раз на срок кэша, потом заново', async () => {
    const staff = new MemoryStaffDirectory();
    staff.set('department:1', people);
    const clock = new FixedClock();
    const identity = new StaffEmployeeIdentity({ staff, clock });
    await Promise.all([identity.nameOf('1'), identity.nameOf('1'), identity.nameOf('2')]);
    expect(staff.allCalls).toBe(1);
    clock.advance(STAFF_IDENTITY_TTL_MS + 1);
    await identity.nameOf('1');
    expect(staff.allCalls).toBe(2);
  });
});
