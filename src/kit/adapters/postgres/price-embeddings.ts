import { z } from 'zod';
import type { Embedder } from '@business-ai/core';
import { type PgClient } from '@business-ai/adapters';
import { assertDimensions } from '@business-ai/adapters';
import { parseRows } from '@business-ai/adapters';

/** Сколько строк прайса берётся из базы и уходит эмбеддеру за один проход. */
export const PRICE_EMBED_BATCH_ROWS = 200;
/** Сколько начальных символов названия идёт в эмбеддинг: хвост длинной ячейки не нужен. */
export const PRICE_EMBED_MAX_TEXT_CHARS = 500;

/** Запись журнала: только числа и коды, без названий товаров. */
export type PriceEmbedLog = (
  event: string,
  fields: Readonly<Record<string, string | number>>,
) => void;

/** Условия дозаполнения эмбеддингов строк прайса. */
export interface FillPriceEmbeddingsOptions {
  /** Только строки этого поставщика (после импорта); нет - вся таблица (дозагрузка). */
  supplierId?: string | undefined;
  /** Не больше стольких строк за вызов; нет - все строки без вектора. */
  maxRows?: number | undefined;
  /** Размер прохода; по умолчанию {@link PRICE_EMBED_BATCH_ROWS}. */
  batchRows?: number | undefined;
  /** Вызывается после каждого прохода: счётчики прогресса дозагрузки. */
  onBatch?: ((progress: PriceEmbedProgress) => void) | undefined;
}

/** Счётчики дозаполнения. */
export interface PriceEmbedProgress {
  /** Строки, получившие вектор. */
  filled: number;
  /** Строки, пропущенные из-за сбоя эмбеддера или записи (останутся без вектора). */
  failed: number;
}

const batchRow = z.object({ id: z.coerce.number(), product_name: z.string() });

/**
 * Посчитать и записать эмбеддинги строк прайса, у которых их ещё нет (`embedding IS NULL`).
 * Идемпотентно: заполненные строки не трогаются и не пересчитываются, повторный запуск
 * продолжает с того места, где остановились. Сбой эмбеддера на проходе не бросается: строки
 * прохода остаются без вектора (их найдёт следующая дозагрузка), счёт идёт дальше по id.
 * Одинаковые названия внутри прохода считаются один раз.
 */
export async function fillPriceEmbeddings(
  db: PgClient,
  embedder: Embedder,
  options: FillPriceEmbeddingsOptions = {},
): Promise<PriceEmbedProgress> {
  const batchRows = options.batchRows ?? PRICE_EMBED_BATCH_ROWS;
  const progress: PriceEmbedProgress = { filled: 0, failed: 0 };
  let lastId = 0;
  for (;;) {
    const room = (options.maxRows ?? Number.POSITIVE_INFINITY) - progress.filled - progress.failed;
    if (room <= 0) break;
    const rows = parseRows(
      batchRow,
      await db.query(
        `SELECT id, product_name FROM price_items
         WHERE embedding IS NULL AND id > $1::bigint
           AND ($2::text IS NULL OR supplier_id = $2::text)
         ORDER BY id LIMIT $3::int`,
        [lastId, options.supplierId ?? null, Math.min(batchRows, room)],
      ),
    );
    if (rows.length === 0) break;
    lastId = Math.max(...rows.map((row) => row.id));
    try {
      progress.filled += await embedRows(db, embedder, rows);
    } catch {
      // Недоступный сервис эмбеддингов не роняет импорт: строки дозаполнятся позже.
      progress.failed += rows.length;
    }
    options.onBatch?.({ ...progress });
  }
  return progress;
}

/** Эмбеддинги уникальных названий прохода -> UPDATE строк; возвращает число записанных. */
async function embedRows(
  db: PgClient,
  embedder: Embedder,
  rows: ReadonlyArray<{ id: number; product_name: string }>,
): Promise<number> {
  const textOf = (row: { product_name: string }): string =>
    row.product_name.slice(0, PRICE_EMBED_MAX_TEXT_CHARS);
  const texts = [...new Set(rows.map(textOf))];
  const vectors = await embedder.embedPassages(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`Эмбеддер вернул ${vectors.length} векторов на ${texts.length} текстов`);
  }
  const byText = new Map<string, string>();
  for (const [index, text] of texts.entries()) {
    const vector = vectors[index] ?? [];
    assertDimensions(vector);
    byText.set(text, `[${vector.join(',')}]`);
  }
  const payload = rows.map((row) => ({
    id: row.id,
    vec: byText.get(textOf(row)),
  }));
  // `embedding IS NULL` в условии: строка могла получить вектор из параллельного прохода.
  const written = await db.query(
    `UPDATE price_items p SET embedding = e.vec::vector
     FROM jsonb_to_recordset($1::text::jsonb) AS e(id bigint, vec text)
     WHERE p.id = e.id AND p.embedding IS NULL
     RETURNING p.id`,
    [JSON.stringify(payload)],
  );
  return written.length;
}
