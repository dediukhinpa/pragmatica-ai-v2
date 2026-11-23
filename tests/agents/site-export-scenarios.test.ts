import { describe, expect, test } from 'bun:test';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';

describe('агент «Актуализация сайта (ИИ агент)»: сценарии', () => {
  test('модель берётся из параметра; публикации на сайт нет ни в инструментах, ни в проверках', () => {
    const declaration = createSiteExportAgent({ model: 'алиас' });
    expect(declaration.model).toBe('алиас');
    expect(declaration.tools.map((tool) => tool.name)).toEqual([
      'prepareCleanTemplate',
      'openChatTemplate',
      'readTemplateStructure',
      'fillTemplateRows',
      'sendTemplateFile',
      'computeSitePrice',
      'nameSitePhotos',
      'readEmployeeIdentity',
      'readChatAttachments',
      'gatherItemData',
      'reportToManager',
      'searchInternet',
      'searchConversationHistory',
      'createFile',
      'lookupSupplierInBase',
      'recordSupplierLookupDecision',
    ]);
    expect(declaration.validators).toEqual([]);
  });

  test('промпт агента: файл без задачи ведёт к заполнению, а не к вопросу «что сделать»', () => {
    const flat = createSiteExportAgent({ model: 'алиас' }).prompt.replace(/\s+/g, ' ');
    const ruleAt = flat.indexOf('Файл без задачи.');
    const stepsAt = flat.indexOf('Порядок работы:');
    // Правило стоит до порядка шагов и отсылает к нему; остановки на вопросе нет.
    expect(ruleAt).toBeGreaterThanOrEqual(0);
    expect(stepsAt).toBeGreaterThan(ruleAt);
    expect(flat).toContain('сразу работай по порядку шагов');
    expect(flat).not.toContain('Файл получен. Что с ним сделать?');
  });
});
