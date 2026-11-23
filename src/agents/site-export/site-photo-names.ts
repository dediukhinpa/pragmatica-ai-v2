import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import type { SiteExportDeps } from './deps';

/**
 * Имена файлов фото для сайта (решение владельца, этап 158): основное фото - `<артикул>`,
 * дальше `<артикул>-1`, `-2`, `-3`, затем расширение (по умолчанию .jpg). Нет артикула - то же
 * по короткому названию позиции (`тюбинг`, `тюбинг-1`). Артикул даёт только человек.
 */

/** Фото на позицию: основное и три дополнительных (колонки «Основное фото», «Допфото 1-3»). */
export const SITE_PHOTO_MAX = 4;
/** Расширение по умолчанию. */
export const SITE_PHOTO_DEFAULT_EXTENSION = 'jpg';
/** Предел длины основы имени файла. */
export const SITE_PHOTO_BASE_MAX_CHARS = 60;
/** Предел позиций за один вызов (с запасом над 300 позиций в задаче). */
const PHOTO_ITEMS_MAX = 300;
/** Предел длины расширения. */
const EXTENSION_MAX_CHARS = 5;
/** Названия слотов фото как в шапке шаблона. */
export const SITE_PHOTO_SLOTS = ['Основное фото', 'Допфото 1', 'Допфото 2', 'Допфото 3'] as const;

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001F\u007F<>:"|?*\\/]/g;

/** Основа имени файла: без запрещённых знаков и пробелов, не длиннее предела. */
export function sanitizePhotoBase(raw: string): string {
  const cleaned = raw
    .replace(FORBIDDEN, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned.slice(0, SITE_PHOTO_BASE_MAX_CHARS);
}

/** Расширение без точки, строчными; странное заменяется расширением по умолчанию. */
export function sanitizeExtension(raw: string | undefined): string {
  const ext = (raw ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) && ext.length <= EXTENSION_MAX_CHARS
    ? ext
    : SITE_PHOTO_DEFAULT_EXTENSION;
}

const itemSchema = z.object({
  /** Артикул, который назвал человек. Не угадывай его. */
  sku: z.string().optional(),
  /** Короткое название позиции для имени, когда артикула нет (одно-два слова). */
  shortName: z.string().optional(),
  /** Сколько фото у позиции (1-4); по умолчанию 1. */
  photoCount: z.number().int().min(1).max(SITE_PHOTO_MAX).default(1),
  /** Расширение для этой позиции, например png; по умолчанию jpg. */
  extension: z.string().optional(),
});

const inputSchema = z.object({
  items: z.array(itemSchema).min(1).max(PHOTO_ITEMS_MAX),
});

const outputItemSchema = z.object({
  index: z.number().int(),
  status: z.enum(['ok', 'no_name']),
  /** Откуда основа имени: артикул или название. */
  basedOn: z.enum(['sku', 'short_name']).optional(),
  /** Имена файлов по слотам: основное, допфото 1, 2, 3. */
  photos: z.array(z.object({ slot: z.string(), fileName: z.string() })),
  /** Основа совпала с другой позицией, добавлен суффикс _N. */
  deduplicated: z.boolean().optional(),
});

const outputSchema = z.object({
  items: z.array(outputItemSchema),
});

type PhotoItemInput = z.infer<typeof itemSchema>;
type PhotoItemOutput = z.infer<typeof outputItemSchema>;

/**
 * Имена фото для списка позиций. Повторяющаяся основа у разных позиций получает суффикс
 * `_2`, `_3`, чтобы файлы не затирали друг друга в одной папке.
 */
export function namePhotos(items: readonly PhotoItemInput[]): PhotoItemOutput[] {
  const used = new Map<string, number>();
  return items.map((item, position): PhotoItemOutput => {
    const sku = sanitizePhotoBase(item.sku ?? '');
    const short = sanitizePhotoBase(item.shortName ?? '');
    const base = sku !== '' ? sku : short;
    const index = position + 1;
    if (base === '') return { index, status: 'no_name', photos: [] };
    const seen = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), seen + 1);
    const unique = seen === 0 ? base : `${base}_${seen + 1}`;
    const ext = sanitizeExtension(item.extension);
    const photos = SITE_PHOTO_SLOTS.slice(0, item.photoCount).map((slot, slotIndex) => ({
      slot,
      fileName: `${unique}${slotIndex === 0 ? '' : `-${slotIndex}`}.${ext}`,
    }));
    return {
      index,
      status: 'ok',
      basedOn: sku !== '' ? 'sku' : 'short_name',
      photos,
      ...(seen === 0 ? {} : { deduplicated: true }),
    };
  });
}

/** Имена файлов фото по артикулу или короткому названию. */
export const nameSitePhotos = defineTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'nameSitePhotos',
  description:
    'Имена файлов фото для сайта по позициям (items): основное фото - артикул, дальше ' +
    'артикул-1, артикул-2, артикул-3 и расширение (по умолчанию .jpg). Нет артикула - те же ' +
    'имена по короткому названию позиции (shortName: «тюбинг», «тюбинг-1»). Артикул даёт ' +
    'только человек: не придумывай его, без артикула передай только shortName. Имена идут в ' +
    'ячейки колонок «Основное фото» и «Допфото 1-3» через fillTemplateRows (слот совпадает ' +
    'с названием колонки). Сами файлы фото этот инструмент не переименовывает и не отправляет.',
  inputSchema,
  outputSchema,
  async execute(input) {
    return { items: namePhotos(input.items) };
  },
});
