import { z } from 'zod';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import type { DocumentsDeps } from './deps';
import { assertDocumentBuildable } from './checks';
import { fillTemplateGaps } from './template-fields';
import { renderWithMarkers } from './render-with-markers';
import { resolveRenderContext } from './contract-number';
import { buildRenderData, outputFileName } from './render-data';
import { assertTemplateOwnSideMatches } from './own-requisites';
import { applyOwnSignatory } from './own-signatory';
import { readAllowedTemplate } from './template-access';

interface FillTemplateInput {
  templatePath: string;
  document: DealDocument;
}
interface FillTemplateOutput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Пропуски (в файле маркеры) и предупреждения сборки одним списком; пусто - всё в порядке. */
  unfilled: string[];
}

/** Подготовить файл: шаблон существует, документ отрисовывается. Файл ещё никому не уходит. */
export const fillTemplate = defineTool<FillTemplateInput, FillTemplateOutput, DocumentsDeps>({
  name: 'fillTemplate',
  description:
    'Заполнить шаблон данными документа и убедиться, что файл формируется. Побочных ' +
    'эффектов нет: файл сотруднику отдаёт saveDocument. Поля без значения не ' +
    'блокируют сборку: в файле на их месте маркеры «[ЗАПОЛНИТЬ: поле]», пропуски и ' +
    'предупреждения сборки в unfilled (перечисли их сотруднику одним списком после выдачи). ' +
    'Возвращает имя и размер файла.',
  inputSchema: z.object({ templatePath: z.string().min(1), document: dealDocumentSchema }),
  outputSchema: z.object({
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    unfilled: z.array(z.string()),
  }),
  async execute(input, deps, context) {
    // Останавливает только выключенный вид; поля из интернета и прочее - предупреждения.
    await assertDocumentBuildable(input.document, deps);
    // Читаем шаблон: если его нет, будет DomainError('not_found') с понятной причиной.
    const printed = await readAllowedTemplate(deps, input.templatePath);
    // Этап 230: напечатанные в шаблоне наши реквизиты должны совпадать с записью БД.
    await assertTemplateOwnSideMatches(deps, printed, context.signal);
    // Подписант нашей стороны - из записи БД (в шаблоне на шаре напечатан прежний).
    const template = await applyOwnSignatory(deps, printed, context.signal);
    // Незаполненные плейсхолдеры шаблона = UnfilledPlaceholdersError с перечнем missing.
    // Данных шаблона договора достаточно, иначе сотрудника спросят, а не оборвут сборку.
    // Номер привязан к операции (поставщик, заявка, шаблон, год): сборка и выпуск получат тот же.
    const resolved = await resolveRenderContext(input.document, deps, template.path, 'issue', {
      initiator: context.initiator,
      parties: true,
    });
    const data = buildRenderData(resolved.document, resolved.options);
    // Пропуски не останавливают сборку: на их месте маркеры [ЗАПОЛНИТЬ: ...], сотрудник
    // видит их в файле и в списке и заполняет до подписания.
    const filled = fillTemplateGaps(template.path, data, input.document, deps.templatesPrefix);
    const rendered = await renderWithMarkers(
      deps.renderer,
      {
        template: { kind: 'bytes', content: template.content },
        templatePath: template.path,
        outputName: outputFileName(resolved.document),
      },
      filled,
    );
    const file = rendered.file;
    return {
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.content.length,
      unfilled: [...rendered.gaps.map((gap) => gap.question), ...rendered.warnings],
    };
  },
});
