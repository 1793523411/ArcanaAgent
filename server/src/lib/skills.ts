import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const demoSkills = {
  calculator: tool(
    (input: { expression: string }) => {
      try {
        const allowed = /^[\d\s+\-*/().]+$/;
        if (!allowed.test(input.expression)) {
          return "Invalid: only numbers and + - * / ( ) allowed.";
        }
        const value = Function(`"use strict"; return (${input.expression})`)();
        return String(value);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "invalid expression"}`;
      }
    },
    {
      name: "calculator",
      description: "Evaluate a safe math expression. Input: numbers and + - * / ( ).",
      schema: z.object({
        expression: z.string().describe("Math expression to evaluate, e.g. (3+5)*2"),
      }),
    }
  ),
  get_time: tool(
    () => {
      return new Date().toISOString();
    },
    {
      name: "get_time",
      description: "Get current date and time in ISO format.",
      schema: z.object({}),
    }
  ),
  echo: tool(
    (input: { text: string }) => input.text,
    {
      name: "echo",
      description: "Echo back the given text. Useful for testing.",
      schema: z.object({
        text: z.string().describe("Text to echo back"),
      }),
    }
  ),
};

export type SkillId = keyof typeof demoSkills;

export function getSkillsByIds(ids: string[]) {
  const out: ReturnType<typeof tool>[] = [];
  for (const id of ids) {
    if (id in demoSkills) {
      out.push((demoSkills as Record<string, ReturnType<typeof tool>>)[id]);
    }
  }
  return out;
}

export function listSkillIds(): string[] {
  return Object.keys(demoSkills);
}
