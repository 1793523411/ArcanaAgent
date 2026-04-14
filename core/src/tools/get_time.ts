import { tool } from "@langchain/core/tools";
import { z } from "zod";

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export const get_time = tool(
  async (input: { timezone?: string }) => {
    const tz = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = Object.fromEntries(
        formatter.formatToParts(now).map((p) => [p.type, p.value])
      );

      const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
      const timeStr = `${parts.hour}:${parts.minute}:${parts.second}`;

      // Get weekday in the target timezone
      const weekdayIdx = new Date(
        now.toLocaleString("en-US", { timeZone: tz })
      ).getDay();

      return [
        `date: ${dateStr}`,
        `time: ${timeStr}`,
        `weekday: ${WEEKDAYS_EN[weekdayIdx]} (${WEEKDAYS_ZH[weekdayIdx]})`,
        `timezone: ${tz}`,
        `unix_timestamp: ${Math.floor(now.getTime() / 1000)}`,
        `iso: ${now.toISOString()}`,
      ].join("\n");
    } catch {
      return `[error] Invalid timezone: "${tz}". Use IANA format like "Asia/Shanghai", "America/New_York".`;
    }
  },
  {
    name: "get_time",
    description:
      "Get the current date, time, weekday, and timezone. " +
      "Use this when the user asks about the current time, date, or day of the week. " +
      "Optionally specify a timezone in IANA format (e.g., Asia/Shanghai, America/New_York).",
    schema: z.object({
      timezone: z
        .string()
        .optional().nullable()
        .describe("IANA timezone name (e.g., Asia/Shanghai). Defaults to system timezone."),
    }),
  }
);
