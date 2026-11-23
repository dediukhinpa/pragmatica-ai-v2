import type { PriceSteps } from '../../kit/domain/price-diff';

/** Отдать управление циклу событий: таймеры и ввод-вывод других задач успевают выполниться. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Пройти пошаговый расчёт прайса, отдавая управление циклу событий после каждого шага
 * (R9-A1-01). Все боты живут в одном процессе ядра: сверка прайса в 100 тыс. позиций одним
 * синхронным куском замораживала насос чата, опрос портала, планировщик и `/ready` на секунды.
 * Результат тот же, что у синхронной функции: шаги - та же реализация.
 *
 * Входные массивы принадлежат вызывающему (свежие копии из базы и состояния): между шагами их
 * никто не меняет.
 */
export async function runPriceStepsYielding<T>(steps: PriceSteps<T>): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    await yieldToEventLoop();
  }
}
