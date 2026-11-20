import { describe, expect, it } from 'vitest';
import { toApiSteps, type BuilderStep } from './automation-builder';

describe('toApiSteps', () => {
  it.each([undefined, '', 'step-id'])('includes only truthy ids: %s', (id) => {
    const input: BuilderStep = {
      cid: 'client-id',
      id,
      step_type: 'send_message',
      step_config: { text: 'Hello' },
    };

    const [step] = toApiSteps([input]);

    const expected: ReturnType<typeof toApiSteps>[number] = {
      step_type: 'send_message',
      step_config: input.step_config,
      branches: undefined,
    };

    if (id) expected.id = id;

    expect(step).toStrictEqual(expected);
    expect(step.step_config).toBe(input.step_config);
    expect(input.id).toBe(id);
  });

  it('serializes nested branch ids without changing the builder tree', () => {
    const steps: BuilderStep[] = [
      {
        cid: 'condition-client',
        id: 'condition-id',
        step_type: 'condition',
        step_config: {},
        branches: {
          yes: [
            {
              cid: 'message-client',
              step_type: 'send_message',
              step_config: { text: 'Yes' },
            },
          ],
          no: [],
        },
      },
    ];

    const original = structuredClone(steps);

    expect(toApiSteps(steps)).toStrictEqual([
      {
        id: 'condition-id',
        step_type: 'condition',
        step_config: {},
        branches: {
          yes: [
            {
              step_type: 'send_message',
              step_config: { text: 'Yes' },
              branches: undefined,
            },
          ],
          no: [],
        },
      },
    ]);
    expect(steps).toStrictEqual(original);
  });
});
