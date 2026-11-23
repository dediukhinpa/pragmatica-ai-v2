import { describe, expect, test } from 'bun:test';
import {
  AGENT_CALL_OUTPUT_MAX_CHARS,
  createToolContext,
  type AgentCallRequest,
  type AgentCaller,
} from '@business-ai/core';
import { PARENT, THREAD, USER, agentCallFixture } from '@business-ai/testing';
import { askPricesKit } from '../../kit/support/agent-call-fixtures.owned';

// Этап 177: ответ другого помощника длиннее предела не отбрасывается, а идёт с предупреждением.
describe('вызов агента: длинный ответ', () => {
  test('разбирается и сопровождается предупреждением', async () => {
    const fixture = agentCallFixture(async () => {});
    const { tool } = askPricesKit();
    const long = `{"price": 12${' '.repeat(AGENT_CALL_OUTPUT_MAX_CHARS)}}`;
    const caller = Object.assign(
      async (request: AgentCallRequest) => ({
        threadId: request.threadId,
        status: 'completed' as const,
        output: long,
      }),
      { getThread: async () => null },
    ) as AgentCaller;
    const context = createToolContext({
      threadId: THREAD,
      agentId: PARENT,
      operationId: 'op-s177',
      initiator: { kind: 'user', userId: USER },
      turnNumber: 1,
      deadlineAtMs: fixture.clock.now().getTime() + 30 * 60_000,
      callAgent: caller,
    });
    const result = await tool.execute({ position: 'болт' }, { agentCall: fixture.deps }, context);
    expect(result).toMatchObject({ status: 'done', value: { price: 12 } });
    expect(JSON.stringify(result)).toContain('сокращён');
  });
});
