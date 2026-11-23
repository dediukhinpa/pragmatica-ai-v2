import {
  createSearchConversationHistoryTool,
  createSearchInternetTool,
  type RunDataScriptPresentation,
} from '@business-ai/core';
import {
  LEGACY_HISTORY_SEARCH_NOTICE,
  LEGACY_RUN_DATA_SCRIPT_DESCRIPTION,
  LEGACY_SCRIPT_EXHAUSTED_MESSAGE,
  LEGACY_SCRIPT_RECONCILE_HINT,
  LEGACY_SCRIPT_SCAN_REFUSED_MESSAGE,
  LEGACY_SEARCH_HISTORY_DESCRIPTION,
  LEGACY_SEARCH_INTERNET_DESCRIPTION,
} from '../../legacy-tool-texts';

/** Виды результата скрипта для модели в прежней схеме (`rows` модели не показывается). */
const LEGACY_RESULT_KIND_NAMES = ['price_items', 'table', 'value'] as const;

/** Редакция `runDataScript` для всех агентов: описание, виды результата, подсказки ответа. */
export const LEGACY_RUN_DATA_SCRIPT_PRESENTATION: RunDataScriptPresentation = {
  description: LEGACY_RUN_DATA_SCRIPT_DESCRIPTION,
  resultKindNames: LEGACY_RESULT_KIND_NAMES,
  messages: {
    exhausted: LEGACY_SCRIPT_EXHAUSTED_MESSAGE,
    reconcile: LEGACY_SCRIPT_RECONCILE_HINT,
    scanRefused: LEGACY_SCRIPT_SCAN_REFUSED_MESSAGE,
  },
};

/** Поиск по истории диалога с прежним описанием и пометкой ответа (КП, сделки). */
export const searchConversationHistory = createSearchConversationHistoryTool({
  description: LEGACY_SEARCH_HISTORY_DESCRIPTION,
  notice: LEGACY_HISTORY_SEARCH_NOTICE,
});

/** Поиск в интернете с прежним описанием (ИНН, поставщики). */
export const searchInternet = createSearchInternetTool({
  description: LEGACY_SEARCH_INTERNET_DESCRIPTION,
});
