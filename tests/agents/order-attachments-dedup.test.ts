import { describe, expect, test } from 'bun:test';
import { buildAttachmentContext, readImages } from '../../src/agents/order-calc/attachment-context';
import type {
  AttachmentBundle,
  BitrixAttachment,
  DocumentParser,
  ImageReader,
} from '@business-ai/core';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const OPTIONS = { maxChars: 10_000 };

const file = (
  name: string,
  content: string,
  source: BitrixAttachment['source'],
): BitrixAttachment => ({ name, mime: 'application/octet-stream', bytes: bytes(content), source });

const bundle = (...attachments: BitrixAttachment[]): AttachmentBundle => ({
  attachments,
  errors: [],
});

describe('дедуп вложений по содержимому до парсера и ридера', () => {
  test('одна картинка из чата и задачи: одна запись, источник task, пометка с источниками', async () => {
    const context = await buildAttachmentContext(
      bundle(file('IMG_1.png', 'same', 'chat'), file('foto.png', 'same', 'task')),
      undefined,
      OPTIONS,
    );
    expect(context.images.map((image) => [image.name, image.source])).toEqual([
      ['foto.png', 'task'],
    ]);
    expect(context.notes.join('\n')).toContain('повторяется в источниках: chat, task');
    let calls = 0;
    const reader: ImageReader = {
      async describe(images) {
        calls += images.length;
        return {
          items: images.map((image) => ({
            name: image.name,
            source: image.source,
            status: 'ok' as const,
            text: 'кружка',
          })),
          usage: { inputTokens: 1, outputTokens: 1, images: images.length },
        };
      },
    };
    await readImages(context.images, reader);
    expect(calls).toBe(1);
  });

  test('одинаковый текстовый файл парсится один раз; разные файлы не склеиваются', async () => {
    let parsed = 0;
    const parser: DocumentParser = {
      async parse() {
        parsed += 1;
        return {
          text: 'позиция 300',
          tables: [],
          needsOcr: false,
          hasHiddenContent: false,
          hiddenSheets: [],
          truncated: false,
          warnings: [],
        };
      },
    };
    const context = await buildAttachmentContext(
      bundle(
        file('a.xlsx', 'one', 'task'),
        file('a-copy.xlsx', 'one', 'chat'),
        file('b.xlsx', 'two', 'deal'),
      ),
      parser,
      OPTIONS,
    );
    expect(parsed).toBe(2);
    expect(context.sections.map((section) => section.name)).toEqual(['a.xlsx', 'b.xlsx']);
  });
});
