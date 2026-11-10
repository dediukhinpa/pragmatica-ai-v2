import { z } from 'zod';
import {
  defineAgentCallTool,
  type AgentCallCapable,
  type AgentCallToolOptions,
} from '@business-ai/core';
import { CHILD, PARENT, POSITION_PREFIX } from '@business-ai/testing';

/**
 * Инструмент «спросить цену» у агента «Актуализация прайса (ИИ агент)» и его валидатор; опции
 * задают разрешения вызова.
 */
export function askPricesKit(
  options: Partial<
    Pick<
      AgentCallToolOptions<{ position: string }, { price: number }>,
      'allowedTargets' | 'scheduledPairs' | 'parseOutput'
    >
  > = {},
) {
  return defineAgentCallTool<{ position: string }, { price: number }, AgentCallCapable>({
    name: 'askPrices',
    description: 'Спросить актуальную цену у помощника по прайсам.',
    from: PARENT,
    target: CHILD,
    inputSchema: z.object({ position: z.string().min(1) }),
    outputSchema: z.object({ price: z.number() }),
    buildInput: (input) => `${POSITION_PREFIX}${input.position}`,
    ...options,
  });
}
