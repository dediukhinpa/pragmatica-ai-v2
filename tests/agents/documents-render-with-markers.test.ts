import { describe, expect, test } from 'bun:test';
import { renderWithMarkers } from '../../src/agents/documents/render-with-markers';
import { gapMarker } from '../../src/agents/documents/template-fields';
import { UnfilledPlaceholdersError } from '@business-ai/core';
import type { DocumentRenderer, RenderedDocument, RenderRequest } from '@business-ai/core';
import type { GapFilledData } from '../../src/agents/documents/template-fields';

const FILE: RenderedDocument = {
  name: 'doc.docx',
  mimeType: 'application/octet-stream',
  content: new Uint8Array([1, 2, 3]),
};

const REQUEST: Omit<RenderRequest, 'data'> = {
  template: { kind: 'bytes', content: new Uint8Array([9]) },
  outputName: 'doc.docx',
};

/** Исходные данные: одно поле, один известный пропуск и одно предупреждение. */
function filledData(): GapFilledData {
  return {
    data: { fields: { known: 'значение' }, lists: {} },
    gaps: [{ label: 'g', title: 'g', marker: gapMarker('g'), question: 'q' }],
    warnings: [{ code: 'extra_key', message: 'лишний ключ' }],
  };
}

/** Рендерер-заглушка: на каждый вызов берёт следующее действие и пишет запрос в журнал. */
function scriptedRenderer(steps: Array<() => RenderedDocument>): {
  renderer: DocumentRenderer;
  calls: RenderRequest[];
} {
  const calls: RenderRequest[] = [];
  const renderer: DocumentRenderer = {
    render: async (request) => {
      // Копия полей: код переиспользует один объект и дописывает в него маркеры.
      calls.push({ ...request, data: { ...request.data, fields: { ...request.data.fields } } });
      const step = steps[calls.length - 1];
      if (!step) throw new Error('лишний вызов рендера');
      return step();
    },
  };
  return { renderer, calls };
}

const failWith = (...missing: string[]) => (): RenderedDocument => {
  throw new UnfilledPlaceholdersError(missing);
};

describe('renderWithMarkers', () => {
  test('успех с первого раза: один вызов, известные пропуски и предупреждения', async () => {
    const { renderer, calls } = scriptedRenderer([() => FILE]);
    const result = await renderWithMarkers(renderer, REQUEST, filledData());
    expect(calls).toHaveLength(1);
    expect(result.file).toBe(FILE);
    expect(result.gaps.map((gap) => gap.label)).toEqual(['g']);
    expect(result.warnings).toEqual(['лишний ключ']);
  });

  test('unfilled: повтор с маркерами на месте x и y, метки добавлены в пропуски', async () => {
    const { renderer, calls } = scriptedRenderer([failWith('x', 'y'), () => FILE]);
    const result = await renderWithMarkers(renderer, REQUEST, filledData());
    expect(calls).toHaveLength(2);
    expect(calls[0]?.data.fields).toEqual({ known: 'значение' });
    expect(calls[1]?.data.fields).toEqual({
      known: 'значение',
      x: gapMarker('x'),
      y: gapMarker('y'),
    });
    expect(result.file).toBe(FILE);
    expect(result.gaps.map((gap) => gap.label)).toEqual(['g', 'x', 'y']);
    expect(result.gaps[1]?.marker).toBe(gapMarker('x'));
    expect(result.warnings).toEqual(['лишний ключ']);
  });

  test('исходные данные вызывающего не мутируются', async () => {
    const filled = filledData();
    const { renderer } = scriptedRenderer([failWith('x'), () => FILE]);
    await renderWithMarkers(renderer, REQUEST, filled);
    expect(filled.data.fields).toEqual({ known: 'значение' });
  });

  test('другая ошибка рендера пробрасывается как есть, без повтора', async () => {
    const boom = new Error('сервис недоступен');
    const { renderer, calls } = scriptedRenderer([
      () => {
        throw boom;
      },
    ]);
    await expect(renderWithMarkers(renderer, REQUEST, filledData())).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  test('повтор называет те же метки: ошибка пробрасывается без третьего вызова', async () => {
    const { renderer, calls } = scriptedRenderer([failWith('x'), failWith('x')]);
    const error = await renderWithMarkers(renderer, REQUEST, filledData()).catch((e) => e);
    expect(error).toBeInstanceOf(UnfilledPlaceholdersError);
    expect((error as UnfilledPlaceholdersError).missing).toEqual(['x']);
    expect(calls).toHaveLength(2);
  });

  test('повтор называет новую метку: второй повтор закрывает и её', async () => {
    const { renderer, calls } = scriptedRenderer([failWith('x'), failWith('z'), () => FILE]);
    const result = await renderWithMarkers(renderer, REQUEST, filledData());
    expect(calls).toHaveLength(3);
    expect(result.gaps.map((gap) => gap.label)).toEqual(['g', 'x', 'z']);
  });

  test('новые метки и после лимита повторов: ошибка пробрасывается', async () => {
    const { renderer, calls } = scriptedRenderer([failWith('a'), failWith('b'), failWith('c')]);
    await expect(renderWithMarkers(renderer, REQUEST, filledData())).rejects.toBeInstanceOf(
      UnfilledPlaceholdersError,
    );
    expect(calls).toHaveLength(3);
  });
});
