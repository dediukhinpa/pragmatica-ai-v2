import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { knownEvents, registerEventSeverity, severityOf } from '@business-ai/adapters';
import {
  PROJECT_EVENT_SEVERITY,
  PROJECT_EVENT_SEVERITY_OVERRIDES,
} from '../../src/event-severity';
import { pragmatikaProject } from '../../src/project';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');
const SEVERITIES = ['critical', 'serious', 'warning', 'info'];

/** Все .ts-файлы каталога рекурсивно. */
function sourcesIn(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourcesIn(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** События, которые код пишет в журнал: первый аргумент `log(...)` и поле `event:`. */
function loggedEvents(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourcesIn(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\blog\??\.?\(\s*'([a-z][a-z0-9_]+)'/g)) {
      found.set(match[1] ?? '', file);
    }
    for (const match of text.matchAll(/\bevent:\s*'([a-z][a-z0-9_]+)'/g)) {
      found.set(match[1] ?? '', file);
    }
  }
  return found;
}

describe('классы событий журнала', () => {
  test('каждое событие кода входит в платформенную или проектную таблицу', () => {
    const known = new Set([...knownEvents(), ...Object.keys(PROJECT_EVENT_SEVERITY)]);
    const missing = [...loggedEvents()].filter(([event]) => !known.has(event));
    // Событие вне таблиц получило бы `info` молча: сбой не попал бы в разбор серьёзных.
    expect(missing.map(([event, file]) => `${event} (${file})`)).toEqual([]);
  });

  test('проектная таблица не повторяет платформенные события с другим классом', () => {
    const platform = new Set(knownEvents());
    for (const [event, severity] of Object.entries(PROJECT_EVENT_SEVERITY)) {
      if (platform.has(event)) expect(severityOf(event)).toBe(severity);
    }
  });

  test('классы проектных событий допустимы, а severityOf их знает (реестр подключён)', () => {
    for (const [event, severity] of Object.entries(PROJECT_EVENT_SEVERITY)) {
      expect(SEVERITIES).toContain(severity);
      expect(severityOf(event)).toBe(severity);
    }
  });

  test('класс события платформы меняется только по списку переопределений (G-7b)', () => {
    // В прежнем ядре `web_fetch_rate_limited` был `info`, в платформе - `warning`. С 1.0.1
    // манифест называет такие события в `eventSeverityOverrides`; без этого платформа
    // отвергает чужой класс платформенного события.
    expect(PROJECT_EVENT_SEVERITY_OVERRIDES).toEqual(['web_fetch_rate_limited']);
    expect(pragmatikaProject.eventSeverityOverrides).toEqual(['web_fetch_rate_limited']);
    expect(severityOf('web_fetch_rate_limited')).toBe('info');
    expect(() => registerEventSeverity({ web_fetch_rate_limited: 'serious' })).toThrow(
      /уже имеет класс платформы/,
    );
    expect(severityOf('web_fetch_rate_limited')).toBe('info');
  });
});
