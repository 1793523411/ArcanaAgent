import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const calculator = tool(
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
);
