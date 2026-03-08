import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const echo = tool(
  (input: { text: string }) => input.text,
  {
    name: "echo",
    description: "Echo back the given text. Useful for testing.",
    schema: z.object({
      text: z.string().describe("Text to echo back"),
    }),
  }
);
