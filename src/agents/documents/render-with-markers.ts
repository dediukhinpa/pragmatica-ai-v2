import { isUnfilledPlaceholdersError } from '@business-ai/core';
import type { DocumentRenderer, RenderedDocument, RenderRequest } from '@business-ai/core';
import { unknownLabelGap, type GapFilledData, type TemplateGap } from './template-fields';

/** Сколько раз повторяем сборку с маркерами: одной достаточно, вторая - страховка. */
const MAX_MARKER_RETRIES = 2;

/** Результат сборки: файл, пропуски (известные и найденные рендерером) и предупреждения. */
export interface RenderedWithGaps {
  file: RenderedDocument;
  /** Известные пропуски плюс метки, которые шаблон потребовал при рендере. */
  gaps: TemplateGap[];
  /** Тексты предупреждений сборки (лишние ключи и т. п.). */
  warnings: string[];
}

/**
 * Собрать файл из данных с маркерами. Если рендерер вернул 422 `unfilled_placeholders` для
 * метки, которой нет в списке кода (боевой шаблон новее списка, КП и счёт без реестра меток),
 * сборка повторяется с маркером «[ЗАПОЛНИТЬ: <метка>]» на месте каждой такой метки: договор
 * не блокируется из-за незнакомой метки (решение владельца 03.11). Остальные ошибки рендера
 * (шаблон не открылся, сервис недоступен) пробрасываются: это техническая причина.
 */
export async function renderWithMarkers(
  renderer: DocumentRenderer,
  request: Omit<RenderRequest, 'data'>,
  filled: GapFilledData,
): Promise<RenderedWithGaps> {
  const extra = new Map<string, TemplateGap>();
  const fields = { ...filled.data.fields };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const file = await renderer.render({ ...request, data: { ...filled.data, fields } });
      return {
        file,
        gaps: [...filled.gaps, ...extra.values()],
        warnings: filled.warnings.map((issue) => issue.message),
      };
    } catch (error) {
      if (!isUnfilledPlaceholdersError(error) || attempt >= MAX_MARKER_RETRIES) throw error;
      const fresh = error.missing.filter((label) => !extra.has(label));
      // Рендерер повторно назвал уже закрытую метку: маркер не помог, это не пропуск данных.
      if (fresh.length === 0) throw error;
      for (const label of fresh) {
        const gap = unknownLabelGap(label);
        extra.set(label, gap);
        fields[label] = gap.marker;
      }
    }
  }
}

