/**
 * 执行增强 system prompt 片段 — 根据启用的特性动态拼接
 *
 * 不再绑定到单一"harness"模式，而是作为独立增强注入到任意 mode 的 system prompt。
 */

import type { ExecutionEnhancementsConfig } from "../../config/userConfig.js";

function buildEvalGuardPrompt(): string {
  return `
### Evidence-Driven Execution (Eval Guard)
An external middleware evaluates the quality of your evidence for each plan step.

**Protocol:**
1. **Follow the plan step by step.** Do NOT skip steps or work on multiple steps simultaneously.
2. **Collect concrete evidence** for each step's acceptance checks before moving on:
   - Command outputs, test results, file contents, API responses — anything verifiable.
   - Vague statements like "it should work" or "I believe this is correct" are NOT evidence.
3. **One step at a time.** After completing a step's acceptance checks, the middleware will evaluate. Wait for implicit approval before proceeding.

**Responding to Eval Signals:**
- **\`[Harness Eval] ... evidence is weak\`**: Evidence is insufficient. Run additional verification immediately. Do NOT proceed.
- **\`[Harness Eval] ... cannot be verified\`**: Environment limitation. Acceptable — move to next step.

**Evidence Quality:**
- **Pass**: Concrete, verifiable artifact (test output, file diff, exit code 0)
- **Weak**: Indirect or partial evidence — needs strengthening
- **Fail**: No evidence, contradictory, or check not satisfied
- **Inconclusive**: Cannot verify in current environment (external services, SSO, etc.)`;
}

function buildLoopDetectionPrompt(): string {
  return `
### Loop Detection
The middleware monitors your tool calls for repetitive patterns.
- **\`[Harness] Loop detected\`**: You are repeating actions without progress. STOP your current approach entirely. Analyze why it's failing, then try a fundamentally different strategy.
- Do NOT repeat the exact same command after it failed.`;
}

function buildReplanPrompt(): string {
  return `
### Dynamic Replanning
When execution fails or loops, the middleware may revise the plan.
- **\`[Harness] Plan has been revised\`**: Read the new plan carefully and continue from the first uncompleted step. Do NOT re-execute completed steps.`;
}

export function buildEnhancementsPrompt(config: ExecutionEnhancementsConfig): string {
  const sections: string[] = [];
  if (config.evalGuard) sections.push(buildEvalGuardPrompt());
  if (config.loopDetection) sections.push(buildLoopDetectionPrompt());
  if (config.replan) sections.push(buildReplanPrompt());

  if (sections.length === 0) return "";

  return `

## Execution Enhancements — Active Monitoring
${sections.join("\n")}

### Anti-Patterns (Must Avoid)
- Claiming a step is done without running verification commands
- Repeating the exact same command after it failed
- Assuming edits are correct without checking the file
- Ignoring middleware warnings and moving to the next step`;
}
