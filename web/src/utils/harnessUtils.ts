export interface HarnessEvent {
  kind: string;
  data: Record<string, unknown>;
  timestamp?: string;
}

export interface DriverEvent {
  phase: string;
  iteration: number;
  maxRetries: number;
  harnessEventsInIteration?: HarnessEvent[];
  timestamp: string;
}

export interface HarnessIteration {
  iteration: number;
  events: HarnessEvent[];
  isTerminal: boolean;
  finalVerdict?: string;
  failedStepIndex?: number;
}

export function groupByDriverIteration(
  events: HarnessEvent[],
  driverEvents?: DriverEvent[],
): HarnessIteration[] {
  const iterEndEvents = (driverEvents ?? []).filter(
    (d) => d.phase === "iteration_end" && Array.isArray(d.harnessEventsInIteration),
  );

  if (iterEndEvents.length > 0) {
    const iterations: HarnessIteration[] = iterEndEvents.map((d) => {
      const evts = d.harnessEventsInIteration!;
      return buildIteration(d.iteration, evts);
    });

    const coveredCount = iterEndEvents.reduce(
      (sum, d) => sum + (d.harnessEventsInIteration?.length ?? 0),
      0,
    );
    if (coveredCount < events.length) {
      const tail = events.slice(coveredCount);
      if (tail.length > 0) {
        const nextIdx = iterations.length > 0
          ? iterations[iterations.length - 1].iteration + 1
          : 0;
        iterations.push(buildIteration(nextIdx, tail));
      }
    }

    return iterations;
  }

  if (events.length === 0) return [];
  return [buildIteration(0, events)];
}

function buildIteration(iteration: number, events: HarnessEvent[]): HarnessIteration {
  const lastEval = [...events].reverse().find((e) => e.kind === "eval");
  const hasReplan = events.some((e) => e.kind === "replan" && e.data.shouldReplan);
  return {
    iteration,
    events,
    isTerminal: !hasReplan,
    finalVerdict: lastEval?.data.verdict as string | undefined,
    failedStepIndex: lastEval?.data.stepIndex as number | undefined,
  };
}

export function iterationSummary(iter: HarnessIteration): string {
  if (iter.events.length === 0) {
    return `第 ${iter.iteration + 1} 轮：无评估事件`;
  }
  const stepLabel = iter.failedStepIndex != null ? `步骤 ${iter.failedStepIndex + 1}` : "步骤";
  const verdictLabel = iter.finalVerdict === "fail" ? "评估失败"
    : iter.finalVerdict === "weak" ? "评估薄弱"
    : iter.finalVerdict === "pass" ? "评估通过"
    : iter.finalVerdict === "inconclusive" ? "评估不确定"
    : "评估";
  const suffix = !iter.isTerminal ? " → 已重试" : "";
  return `第 ${iter.iteration + 1} 轮：${stepLabel} ${verdictLabel}${suffix}`;
}
