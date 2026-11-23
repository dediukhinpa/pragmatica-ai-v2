import { z } from 'zod';
import { BUSY_PHOTO_LINE, UNREADABLE_PHOTO_LINE, type WorkflowStateStore } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';

/**
 * Фраза о непрочитанных фото заявки (этап 189). Раньше её просили написать модель после
 * шорт-листа, но с этапа 179 шорт-лист и вопрос «Кому готовить запросы?» показывает код и тем
 * же вызовом заканчивает ход: итога модели нет, фраза терялась. Теперь её строит код (у
 * сообщения один автор): что было с фото, запоминается при чтении вложений, а в закрывающее
 * сообщение шорт-листа фраза попадает один раз на заявку.
 */

/** Что увидено при чтении фото, ключ - тред: заявка при чтении ещё не сохранена. */
export const PHOTO_SEEN_NAMESPACE = 'order-calc:photo-seen';
/** Признак «фраза уже показана», ключ - заявка: повторный показ шорт-листа её не повторяет. */
export const PHOTO_HINT_SHOWN_NAMESPACE = 'order-calc:photo-hint-shown';

/** Одна строка, по-русски, без «не вижу» в тоне ошибки и без данных заявки (ПДн нет). */
export const PHOTO_HINT_LINE =
  'В задаче есть фото, которые я не смог прочитать: опишите словами главное на них.';

/** Откуда читали фото: у каждого источника своя пара счётчиков (повторное чтение заменяет). */
export type PhotoSource = 'task' | 'deal' | 'chat';

const seenSchema = z.object({
  /** Источник -> сколько фото и сколько из них прочитано (status=ok). */
  sources: z.record(z.object({
      images: z.number().int().nonnegative(),
      read: z.number(),
      /** Сколько фото отклонено как плохо читаемые; в старых записях поля нет. */
      unreadable: z.number().int().nonnegative().optional(),
      /** Сколько фото не прочитано из-за занятого сервиса; в старых записях поля нет. */
      busy: z.number().int().nonnegative().optional(),
    }),),
});

/** Результат чтения одного изображения: нужен только статус. */
export interface PhotoReadStatus {
  status: 'ok' | 'unavailable';
  unreadable?: boolean;
  busy?: boolean;
}

/**
 * Запомнить итог чтения фото источника. `images` - сколько фото в источнике (для задачи
 * `imageCount`, иначе число результатов чтения), `reads` - результаты чтения. Сбой записи
 * чтение вложений не роняет: фраза - добавка к шорт-листу.
 */
export async function notePhotosSeen(
  store: WorkflowStateStore | undefined,
  threadId: string,
  source: PhotoSource,
  images: number,
  reads: readonly PhotoReadStatus[],
): Promise<void> {
  if (store === undefined) return;
  try {
    const stored = await readState(store, PHOTO_SEEN_NAMESPACE, threadId, seenSchema);
    const read = reads.filter((item) => item.status === 'ok').length;
    const unreadable = reads.filter((item) => item.unreadable === true).length;
    const busy = reads.filter((item) => item.busy === true).length;
    await writeState(store, PHOTO_SEEN_NAMESPACE, threadId, {
      sources: { ...(stored?.sources ?? {}), [source]: { images, read, unreadable, busy } },
    });
  } catch {
    // Хранилище недоступно: фразы не будет, остальной ход идёт как обычно.
  }
}

/**
 * Фраза о фото для закрывающего сообщения шорт-листа заявки: есть фото (imageCount > 0), а
 * прочитанных нет ни одного - строка; часть прочитана, фото нет или фраза по этой заявке уже
 * была - undefined. Показанной её надо отметить `markPhotoHintShown` после отправки.
 */
export async function photoHintLine(
  store: WorkflowStateStore,
  threadId: string,
  requestId: string,
): Promise<string | undefined> {
  try {
    if ((await store.get(PHOTO_HINT_SHOWN_NAMESPACE, requestId)) !== null) return undefined;
    const seen = await readState(store, PHOTO_SEEN_NAMESPACE, threadId, seenSchema);
    const counters = Object.values(seen?.sources ?? {});
    const images = counters.reduce((sum, item) => sum + item.images, 0);
    const read = counters.reduce((sum, item) => sum + item.read, 0);
    const unreadable = counters.reduce((sum, item) => sum + (item.unreadable ?? 0), 0);
    const busy = counters.reduce((sum, item) => sum + (item.busy ?? 0), 0);
    if (images === 0 || read > 0) return undefined;
    // Занятый сервис - не вина фото: просим прислать его снова, а не описывать словами.
    if (busy > 0 && unreadable === 0) return BUSY_PHOTO_LINE;
    // Нечитаемые в tokens: сотруднику уходит строка кода, а не общая фраза.
    return unreadable > 0 ? UNREADABLE_PHOTO_LINE : PHOTO_HINT_LINE;
  } catch {
    return undefined;
  }
}

/** Отметить, что фраза по заявке показана (один раз на заявку). */
export async function markPhotoHintShown(
  store: WorkflowStateStore,
  requestId: string,
): Promise<void> {
  await writeState(store, PHOTO_HINT_SHOWN_NAMESPACE, requestId, { shown: true });
}
