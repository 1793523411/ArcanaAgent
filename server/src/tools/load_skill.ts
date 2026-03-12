import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getSkillContentForAgent } from "../skills/manager.js";

export const load_skill = tool(
  (input: { name: string }) => {
    const name = input.name.trim();
    if (!name) {
      return "Error: Skill name is required.";
    }
    return getSkillContentForAgent(name);
  },
  {
    name: "load_skill",
    description:
      "Load the full instructions of a skill by exact name. " +
      "Use this before executing a task that matches an available skill.",
    schema: z.object({
      name: z.string().describe("Exact skill name from Available Skills list"),
    }),
  }
);
