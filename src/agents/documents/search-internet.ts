import type { ToolDefinition } from '@business-ai/core';
import { searchInternet } from '../shared/common-tools.owned';
import type { DocumentsDeps } from './deps';
import { noteWebSearchText } from './web-confirmation';

type SearchOutput = Awaited<ReturnType<typeof searchInternet.execute>>;

/**
 * Поиск в интернете для «Подготовки документов (ИИ агент)»: тот же инструмент и те же
 * ограничения, что у общего, но текст выдачи запоминается в состоянии треда. По нему код
 * опознаёт значения документа, пришедшие из интернета, даже если модель пометила их как чат
 * или базу знаний.
 */
export const searchInternetForDocuments: ToolDefinition<unknown, SearchOutput, DocumentsDeps> = {
  ...searchInternet,
  async execute(input, deps, context) {
    const output = await searchInternet.execute(input, deps, context);
    await noteWebSearchText(deps.state, context.threadId, output.results);
    return output;
  },
};
