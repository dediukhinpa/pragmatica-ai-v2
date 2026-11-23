import { runMain } from '@business-ai/core/compose';
import { pragmatikaProject } from './project';

// Точка запуска службы: платформа проект не знает, его передаёт запускающий.
runMain(pragmatikaProject);
