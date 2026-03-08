import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const get_time = tool(
  () => {
    return new Date().toISOString();
  },
  {
    name: "get_time",
    description: "Get current date and time in ISO format.",
    schema: z.object({}),
  }
);
