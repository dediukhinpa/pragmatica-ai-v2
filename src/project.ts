import { defineProject } from '@business-ai/core';
import { PROJECT_ACCESS_ACTIONS, PROJECT_ACCESS_RESTRICTIONS } from './access-actions';
import { assemblePragmatikaAgents } from './assembly/agents';
import {
  FILE_OWNER_AGENT_ID,
  PROJECT_BUTTONS,
  PROJECT_GREETING_ACTIONS,
  projectStateBlock,
  supplierFileHandler,
} from './chat-hooks';
import { PRAGMATIKA_MODELS, PRAGMATIKA_PII_ALLOWED_WORDS, pragmatikaConfigSchema } from './config';
import { pragmatikaEval } from './eval';
import { PROJECT_EVENT_SEVERITY } from './event-severity';
import { PRICE_UPDATE_THREAD_ID } from './agents/prices/deps';
import { ORDER_CALC_AGENT_ID } from './agents/order-calc';
import { PROJECT_EXTERNAL_TEXT_TOOL_NAMES } from './agents/shared/external-text-tools.owned';
import {
  SUPPLIER_REQUEST_STALE_AFTER_MS,
  SUPPLIER_REQUEST_STALE_SCOPE,
  WORKFLOW_STATE_STALE_SCOPE,
} from './kit/app/workflow-state-retention';
import { DAY_MS } from './kit/domain/time';
import { PRAGMATIKA_PORTS_KEY, buildPragmatikaPorts } from './ports';
import { PROJECT_SCHEDULES } from './schedules';

/** Тексты сводки при запуске для интеграций, которым нужны слова Прагматики. */
const UNCONFIGURED_TEXT = {
  exportTemplate: 'exportTemplate: временный шаблон выгрузки, формат заказчика не получен',
  staffDirectory:
    'staffDirectory: каталог сотрудников не подключён, PRICE_STAFF_DEPARTMENT и ' +
    'PRICE_STAFF_EXTRA_USER_IDS не действуют (сводка по прайсам идёт ответственному)',
  priceOpenThreadBot:
    'priceOpenThreadBot: PRICE_RECIPIENT_OPEN_THREAD включён, но у агента нет единственного ' +
    'корректного бота в CHAT_BOTS - бот первым не пишет (сводка идёт ответственному)',
  portalIntake:
    'portalIntake: чтение задач и сделок портала не подключено («не настроено»), ' +
    'заявка принимается только текстом',
} as const;

/**
 * Манифест Прагматики: четыре агента («Актуализация прайса», «Подготовка документов», «Поиск
 * поставщика», «Актуализация сайта»), их кнопки, плановые задачи и предметные переменные
 * окружения. Платформенные файлы (`compose-production.ts`, `production-config.ts`, `main.ts`)
 * о проекте ничего не знают: его передаёт запускающий.
 */
export const pragmatikaProject = defineProject({
  id: 'pragmatika',
  models: PRAGMATIKA_MODELS,
  // Запасные алиасы вспомогательных запросов, как до манифеста: поиск - «Документы», зрение -
  // «Поиск поставщика».
  fallbackModelAgents: { webSearch: 'documents', vision: ORDER_CALC_AGENT_ID },
  configSchema: pragmatikaConfigSchema,
  accessActions: PROJECT_ACCESS_ACTIONS,
  accessRestrictions: PROJECT_ACCESS_RESTRICTIONS,
  chat: {
    defaultAgentId: ORDER_CALC_AGENT_ID,
    fileOwner: FILE_OWNER_AGENT_ID,
    buttons: PROJECT_BUTTONS,
    fileHandlers: [supplierFileHandler],
    greetingActions: PROJECT_GREETING_ACTIONS,
    stateBlock: projectStateBlock,
  },
  agents: assemblePragmatikaAgents,
  schedules: PROJECT_SCHEDULES,
  ports: (env) => ({ [PRAGMATIKA_PORTS_KEY]: buildPragmatikaPorts(env) }),
  migrationsDir: 'db/app',
  eval: pragmatikaEval,
  unconfiguredText: UNCONFIGURED_TEXT,
  describe: (project) => ({
    supplierCards: project.SUPPLIER_CARDS_ENABLED,
    priceDiskSync: project.PRICE_DISK_SYNC_ENABLED,
    supplierMailProposals: project.SUPPLIER_MAIL_PROPOSALS_ENABLED,
    documentKinds: (project.DOCUMENTS_ENABLED_KINDS ?? []).join(',') || 'all',
  }),
  eventSeverity: PROJECT_EVENT_SEVERITY,
  piiAllowedWords: PRAGMATIKA_PII_ALLOWED_WORDS,
  externalTextTools: [...PROJECT_EXTERNAL_TEXT_TOOL_NAMES],
  // Снятая недельная проверка прайсов: задача с этим тредом пропускается без вызова модели.
  retiredThreads: [PRICE_UPDATE_THREAD_ID],
  staleScopes: [
    { scope: WORKFLOW_STATE_STALE_SCOPE },
    // Брошенные запросы карточек содержат ПДн контактов: чистятся вскоре после срока кнопки.
    {
      scope: SUPPLIER_REQUEST_STALE_SCOPE,
      retentionDays: Math.ceil(SUPPLIER_REQUEST_STALE_AFTER_MS / DAY_MS),
    },
  ],
});
