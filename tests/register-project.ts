import { registerEventSeverity } from '@business-ai/adapters';
import { useTestProject } from '@business-ai/testing';
import { pragmatikaProject } from '../src';

// Тесты агентов собирают приложение манифестом Прагматики, а классы её событий попадают в
// общий реестр до первого теста (журнал и проверки читают их при каждом вызове).
registerEventSeverity(pragmatikaProject.eventSeverity, {
  allowOverride: pragmatikaProject.eventSeverityOverrides,
});
useTestProject(pragmatikaProject);
