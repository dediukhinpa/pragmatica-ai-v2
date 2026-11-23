import { z } from 'zod';
import { DOCUMENT_KINDS, type DocumentKind } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import { TEMPLATE_KNOWLEDGE_LIMIT, type DocumentsDeps } from './deps';
import { disabledKindMessage } from './enabled-kinds';
import { isTemplatePathAllowed, normalizeTemplatePath } from './template-access';
import {
  contractTemplateByPath,
  matchContractTemplate,
  templateBaseName,
  type ContractTemplate,
} from './template-registry';

/** Слова, по которым вид документа узнаётся в названии файла шаблона. */
const KIND_WORDS: Readonly<Record<DocumentKind, readonly string[]>> = {
  commercial_offer: ['кп', 'коммерческ', 'предложен'],
  invoice: ['счет', 'счёт', 'invoice'],
  contract: ['договор', 'контракт', 'contract'],
  closing: ['упд', 'акт', 'накладн', 'закрывающ', 'closing'],
};

const templateSchema = z.object({ path: z.string(), hash: z.string() });
const hitSchema = z.object({ documentId: z.string(), snippet: z.string() });

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Путь файла на диске; нет - файла шаблона на диске нет. */
  path: z.string().optional(),
});
const matchSchema = z.object({
  /**
   * unique - один шаблон, берите его (при needsConfirmation назовите его сотруднику и
   * продолжайте без остановки хода);
   * ambiguous - выберите самый вероятный из candidates, назовите его и в конце ответа
   * предложите остальные (в том числе при нескольких одноимённых файлах);
   * not_found - шаблон договора не назван или такого нет; file_missing - шаблон известен, но
   * его файла нет на диске.
   */
  status: z.enum(['unique', 'ambiguous', 'not_found', 'file_missing']),
  template: candidateSchema.optional(),
  candidates: z.array(candidateSchema),
  /**
   * true: шаблон выбран по словам сотрудника, а не по названию файла; назови его (title) в
   * ответе и продолжай работу в том же ходе, не дожидаясь подтверждения (поправить сотрудник
   * сможет при проверке).
   */
  needsConfirmation: z.boolean(),
});

interface FindTemplateInput {
  query: string;
  kind?: DocumentKind | undefined;
}
interface FindTemplateOutput {
  templates: Array<z.infer<typeof templateSchema>>;
  knowledge: Array<z.infer<typeof hitSchema>>;
  /** Выбор среди шаблонов договоров и NDA по фразе сотрудника (код, не модель). */
  match: z.infer<typeof matchSchema>;
  /** Вид документа сейчас выключен (`DOCUMENTS_ENABLED_KINDS`): причина, шаблоны не ищутся. */
  disabledReason?: string | undefined;
}

type MatchResult = z.infer<typeof matchSchema>;

/** Файлы на диске с именем шаблона реестра, без повторов (одна запись на одно имя в NFC). */
function sameNamePaths(template: ContractTemplate, paths: readonly string[]): string[] {
  const wanted = template.fileName.normalize('NFC');
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = normalizeTemplatePath(path);
    if (templateBaseName(path) !== wanted || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Путь файла шаблона на диске. Только точный относительный путь (каталог шаблонов плюс имя):
 * одноимённый файл в другом каталоге его не заменяет. Несколько одноимённых файлов - путь
 * не однозначен, он не возвращается.
 */
function withDiskPath(
  template: ContractTemplate,
  paths: readonly string[],
  prefix: string,
): z.infer<typeof candidateSchema> {
  const named = sameNamePaths(template, paths);
  const [path] = named;
  const exact =
    named.length === 1 && path !== undefined && contractTemplateByPath(path, prefix) !== undefined;
  return { id: template.id, title: template.title, ...(exact ? { path } : {}) };
}

/**
 * Однозначный шаблон, список кандидатов или «не найдено» по фразе сотрудника. Файл должен
 * лежать в разрешённом перечне: иначе однозначный выбор превращается в file_missing. Несколько
 * одноимённых файлов - не unique: сотрудник выбирает, какой из них.
 */
function resolveMatch(
  query: string,
  diskPaths: readonly string[],
  deps: DocumentsDeps,
): MatchResult {
  const prefix = deps.templatesPrefix ?? '';
  const allowed = diskPaths.filter((path) => isTemplatePathAllowed(deps, path));
  const found = matchContractTemplate(query);
  if (found.status === 'not_found') {
    return { status: 'not_found', candidates: [], needsConfirmation: false };
  }
  if (found.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: found.candidates.map((template) => withDiskPath(template, allowed, prefix)),
      needsConfirmation: false,
    };
  }
  const copies = sameNamePaths(found.template, allowed);
  if (copies.length > 1) {
    const { id, title } = found.template;
    return {
      status: 'ambiguous',
      candidates: copies.map((path) => ({ id, title, path })),
      needsConfirmation: false,
    };
  }
  const template = withDiskPath(found.template, allowed, prefix);
  return template.path === undefined
    ? { status: 'file_missing', template, candidates: [], needsConfirmation: false }
    : {
        status: 'unique',
        template,
        candidates: [],
        needsConfirmation: found.needsConfirmation,
      };
}

/** Найти шаблон документа на диске и подсказки в базе знаний. */
export const findTemplate = defineTool<FindTemplateInput, FindTemplateOutput, DocumentsDeps>({
  name: 'findTemplate',
  description:
    'Найти шаблон документа: по словам запроса и виду документа (commercial_offer, invoice, ' +
    'contract). Возвращает файлы шаблонов и фрагменты базы знаний. Пустой список = шаблона нет. ' +
    'Для договоров и NDA в query передай фразу сотрудника как есть: match.status=unique - ' +
    'шаблон выбран (match.template.path; при match.needsConfirmation=true назови ' +
    'его сотруднику и продолжай в том же ходе), ambiguous - выбери вероятный из ' +
    'match.candidates, назови его и предложи остальные в конце ответа, not_found или ' +
    'file_missing - шаблона нет, скажи об этом.',
  inputSchema: z.object({ query: z.string().min(1), kind: z.enum(DOCUMENT_KINDS).optional() }),
  outputSchema: z.object({
    templates: z.array(templateSchema),
    knowledge: z.array(hitSchema),
    match: matchSchema,
    disabledReason: z.string().optional(),
  }),
  async execute(input, deps) {
    // Выключенный вид отклоняется кодом; схема входа от флага не зависит.
    const disabled =
      input.kind === undefined ? undefined : disabledKindMessage(deps, input.kind);
    if (disabled !== undefined) {
      return {
        templates: [],
        knowledge: [],
        match: { status: 'not_found', candidates: [], needsConfirmation: false },
        disabledReason: disabled,
      };
    }
    const words = input.query.toLowerCase().split(/\s+/).filter((word) => word !== '');
    const kindWords = input.kind === undefined ? [] : KIND_WORDS[input.kind];
    const entries = await deps.files.list();
    const templates = entries
      // Тот же перечень, что у чтения шаблона: найденное всегда можно открыть.
      .filter((entry) => isTemplatePathAllowed(deps, entry.path))
      .filter((entry) => {
        const path = entry.path.toLowerCase();
        const byKind = kindWords.length === 0 || kindWords.some((word) => path.includes(word));
        return byKind && words.some((word) => path.includes(word));
      })
      .map((entry) => ({ path: entry.path, hash: entry.hash }));
    const hits = await deps.knowledge.search(input.query, TEMPLATE_KNOWLEDGE_LIMIT);
    return {
      templates,
      knowledge: hits.map((hit) => ({ documentId: hit.documentId, snippet: hit.snippet })),
      match: resolveMatch(input.query, entries.map((entry) => entry.path), deps),
    };
  },
});
