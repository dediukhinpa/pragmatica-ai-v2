-- Расписание «в часы дня по поясу» для повторяющихся задач очереди: `daily_at` хранит времена
-- суток `HH:MM` по возрастанию через запятую, `time_zone` - IANA-пояс. У такой задачи
-- `repeat_every_ms` пуст, а `due_at` - плановый срез (то, что код отдаёт как `slotAt`);
-- следующий срок считает код по сетке часов пояса и пишет в `due_at` при завершении запуска.
--
-- Идемпотентна и безопасна на непустой таблице: столбцы добавляются пустыми, существующие строки
-- (разовые и по интервалу) не меняются и ограничению отвечают. Новое поведение выключено, пока
-- ни одна задача не создана через `scheduleDaily`.
-- Откат образа на код без этой миграции: строки с `daily_at` старый код прочтёт как разовые
-- задачи (выполнит один раз и закроет), поэтому перед откатом снимите такие серии
-- (`DELETE FROM jobs WHERE daily_at IS NOT NULL`, docs/RUNBOOK.md).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS daily_at text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS time_zone text;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_daily_schedule_check;
-- Либо оба поля расписания заданы, либо оба пусты; интервал и часы дня вместе не бывают.
ALTER TABLE jobs ADD CONSTRAINT jobs_daily_schedule_check CHECK (
  (daily_at IS NULL) = (time_zone IS NULL)
  AND (daily_at IS NULL OR repeat_every_ms IS NULL)
);
