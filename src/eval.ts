import type { ProjectEval } from '@business-ai/core';

/**
 * Описание проекта для eval: агенты, которых гоняет раннер, и имена проверок состояния «после
 * прогона» по каждому. Реализации проверок лежат рядом с окружениями eval; схема кейса сверяется
 * с этим списком, чтобы опечатка не превращалась в тихий пропуск. Списки сняты с прежнего eval
 * (коммит-источник синхронизации агентов).
 */
export const pragmatikaEval: ProjectEval = {
  agentIds: ['prices', 'documents', 'order-calc', 'site-export'],
  probeNames: {
    prices: ['chatMessages', 'storedPriceCount', 'storedPrice', 'storedPriceTiers'],
    documents: [
      'chatMessages',
      'chatFiles',
      // Состояние карточек поставщиков после прогона (а не текст ответа модели).
      'openSupplierOffers',
      'supplierCardCount',
      'supplierCardFieldFilled',
      // Сколько файлов, отправленных в чат, содержат подстроку (текст исполнителя цел).
      'chatFileContains',
    ],
    'order-calc': [
      'chatMessages',
      'scheduledTasks',
      'proposedSupplierCount',
      'selectedSupplierCount',
      'confirmedSupplierCount',
      'selectionMatchesConfirmation',
      'draftsShown',
      'mailSent',
      'requestTextsShown',
      'preparedSupplierCount',
      'chatTextContains',
      'webSearchCount',
      'webSearchContains',
      'webPlannerCalls',
      'webPlannerFieldCount',
      'completenessKindIs',
      'storedReplyCount',
      'storedQuoteCount',
      // Карточки поставщиков после прогона (заведена ли карточка по фото визитки).
      'supplierCardCount',
      'supplierCardNamedFieldFilled',
    ],
    'site-export': ['chatMessages', 'chatFiles', 'draftsShown', 'mailSent'],
  },
};
