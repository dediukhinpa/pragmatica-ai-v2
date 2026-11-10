import type { AgentGreeting } from '@business-ai/core';
import type { DocumentKind } from '../../kit/domain/models';
import { allKindsEnabled, kindsText } from './enabled-kinds';

/** Приветствие при всех включённых видах (поведение по умолчанию). */
export const DOCUMENTS_GREETING: AgentGreeting = {
  role:
    'Я помощник «Подготовка документов (ИИ агент)»: готовлю коммерческие предложения, счета, ' +
    'договоры и ' +
    'закрывающие документы из шаблонов компании. Данные беру из нашего чата и базы знаний ' +
    '(карточки поставщиков, КП, прайсы, документы), реквизиты могу поискать в интернете. ' +
    'Чего не хватает, спрошу у вас. Проверяют, согласуют и подписывают документ люди.',
  examples: [
    'Подготовь коммерческое предложение для ООО Заказчик: болт М8, 100 шт по 12 руб.',
    'Подготовь проект договора с поставщиком МеталлТорг по его КП к заявке 567',
    'Подготовь счёт, реквизиты возьми из карточки поставщика',
  ],
  buttons: [
    {
      id: 'kinds',
      label: 'Какие документы готовите',
      prompt: 'Перечисли, какие виды документов ты готовишь.',
    },
    {
      id: 'needed-data',
      label: 'Что нужно от меня',
      prompt: 'Какие данные нужны, чтобы подготовить документ, и откуда ты их берёшь?',
    },
  ],
};

/** Примеры запросов по видам; для включённых видов берутся именно они. */
const KIND_EXAMPLES: Readonly<Record<DocumentKind, string>> = {
  commercial_offer: DOCUMENTS_GREETING.examples[0] ?? '',
  contract: DOCUMENTS_GREETING.examples[1] ?? '',
  invoice: DOCUMENTS_GREETING.examples[2] ?? '',
  closing: '',
};

/** Примеры для договоров и NDA, когда включён только этот вид. */
const CONTRACT_ONLY_EXAMPLES: readonly string[] = [
  'Подготовь проект договора с поставщиком МеталлТорг по его КП к заявке 567',
  'Подготовь NDA с поставщиком МеталлТорг',
];

/**
 * Приветствие по включённым видам (`DOCUMENTS_ENABLED_KINDS`): роль и примеры говорят только о
 * них. Все виды включены - прежнее приветствие.
 */
export function buildDocumentsGreeting(kinds: readonly DocumentKind[]): AgentGreeting {
  if (allKindsEnabled(kinds)) return DOCUMENTS_GREETING;
  const examples =
    kinds.length === 1 && kinds[0] === 'contract'
      ? CONTRACT_ONLY_EXAMPLES
      : kinds.map((kind) => KIND_EXAMPLES[kind]).filter((text) => text !== '');
  return {
    ...DOCUMENTS_GREETING,
    role:
      `Я помощник «Подготовка документов (ИИ агент)»: готовлю ${kindsText(kinds)} из ` +
      'шаблонов компании. Данные беру из нашего чата и базы знаний (карточки поставщиков, КП, ' +
      'прайсы, документы), реквизиты могу поискать в интернете. Чего не хватает, спрошу у ' +
      'вас. Проверяют, согласуют и подписывают документ люди.',
    examples: [...examples],
  };
}
