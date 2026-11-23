import type { DealDocument } from '../../kit/domain/models';
import { stableHash } from '@business-ai/core';

/** Поля документа, которые не входят в отпечаток: не меняют смысл документа. */
const EXCLUDED_FIELDS: ReadonlySet<string> = new Set(['id', 'fieldSources']);

/**
 * Отпечаток данных документа для ключей идемпотентности. Не входят `id` (производный
 * идентификатор) и отметки источников (меняются без смены документа); позиции - множество:
 * порядок строк отпечаток не меняет. Реквизиты - запись, её ключи сортирует `stableHash`.
 */
export function documentFingerprint(doc: DealDocument): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!EXCLUDED_FIELDS.has(key)) body[key] = value;
  }
  const lines = doc.lines.map((line) => stableHash(line)).sort();
  return stableHash({ ...body, lines });
}
