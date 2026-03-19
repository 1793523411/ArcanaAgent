import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";

const MAX_WRITE_SIZE = 1024 * 1024;

interface EditResult {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldLines: string[];
  newLines: string[];
}

function generateDiff(original: string, modified: string, edits: EditResult[]): string {
  const lines: string[] = [];
  for (const edit of edits) {
    const contextBefore = Math.max(0, edit.oldStart - 3);
    const contextAfter = Math.min(original.split("\n").length, edit.oldEnd + 3);
    lines.push(`@@ -${edit.oldStart + 1},${edit.oldLines.length} +${edit.newStart + 1},${edit.newLines.length} @@`);
    // Context before
    const origLines = original.split("\n");
    for (let i = contextBefore; i < edit.oldStart; i++) {
      lines.push(` ${origLines[i]}`);
    }
    // Removed lines
    for (const l of edit.oldLines) {
      lines.push(`-${l}`);
    }
    // Added lines
    for (const l of edit.newLines) {
      lines.push(`+${l}`);
    }
    // Context after
    const modLines = modified.split("\n");
    for (let i = edit.newEnd; i < Math.min(modLines.length, edit.newEnd + 3); i++) {
      lines.push(` ${modLines[i]}`);
    }
  }
  return lines.join("\n");
}

export const edit_file = tool(
  (input: { path: string; edits: Array<{ old_text: string; new_text: string }>; dry_run?: boolean }) => {
    // Safety check: block system directories
    const blocked = ["/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/proc/", "/sys/"];
    if (blocked.some((prefix) => input.path.startsWith(prefix))) {
      return `[error] Editing files in system directory is not allowed: ${input.path}`;
    }

    if (!existsSync(input.path)) {
      return `[error] File not found: ${input.path}`;
    }

    let content: string;
    try {
      content = readFileSync(input.path, "utf-8");
    } catch (e) {
      return `[error] Failed to read file: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (content.length > MAX_WRITE_SIZE) {
      return `[error] File too large (${content.length} chars, max ${MAX_WRITE_SIZE}). Use smaller edits or write_file.`;
    }

    const editResults: EditResult[] = [];
    let currentContent = content;

    for (let i = 0; i < input.edits.length; i++) {
      const { old_text, new_text } = input.edits[i];

      if (!old_text) {
        return `[error] Edit #${i + 1}: old_text cannot be empty.`;
      }

      const idx = currentContent.indexOf(old_text);
      if (idx === -1) {
        // Try to provide context for debugging
        const preview = old_text.length > 80 ? old_text.slice(0, 80) + "..." : old_text;
        return `[error] Edit #${i + 1}: old_text not found in file.\nSearched for: ${JSON.stringify(preview)}\nHint: Ensure exact match including whitespace and indentation. Use read_file to check current content.`;
      }

      // Check for multiple matches
      const secondIdx = currentContent.indexOf(old_text, idx + 1);
      if (secondIdx !== -1) {
        const lineNum1 = currentContent.slice(0, idx).split("\n").length;
        const lineNum2 = currentContent.slice(0, secondIdx).split("\n").length;
        return `[error] Edit #${i + 1}: old_text matches multiple locations (lines ${lineNum1} and ${lineNum2}). Provide more context to make the match unique.`;
      }

      // Track line positions for diff
      const beforeMatch = currentContent.slice(0, idx);
      const oldStartLine = beforeMatch.split("\n").length - 1;
      const oldLines = old_text.split("\n");
      const newLines = new_text.split("\n");

      editResults.push({
        oldStart: oldStartLine,
        oldEnd: oldStartLine + oldLines.length,
        newStart: oldStartLine,
        newEnd: oldStartLine + newLines.length,
        oldLines,
        newLines,
      });

      currentContent = currentContent.slice(0, idx) + new_text + currentContent.slice(idx + old_text.length);
    }

    // Generate diff
    const diff = generateDiff(content, currentContent, editResults);

    if (input.dry_run) {
      return `[dry_run] ${input.edits.length} edit(s) would be applied to ${input.path}\n\n${diff}`;
    }

    // Write the modified content
    try {
      writeFileSync(input.path, currentContent, "utf-8");
    } catch (e) {
      return `[error] Failed to write file: ${e instanceof Error ? e.message : String(e)}`;
    }

    const lines = currentContent.split("\n").length;
    const bytes = Buffer.byteLength(currentContent, "utf-8");
    return `OK: applied ${input.edits.length} edit(s) to ${input.path} (${lines} lines, ${bytes} bytes)\n\n${diff}`;
  },
  {
    name: "edit_file",
    description:
      "Edit a file using search-and-replace operations. More precise than write_file for modifying existing files. " +
      "Each edit specifies exact text to find (old_text) and its replacement (new_text). " +
      "Edits are applied sequentially. Use dry_run to preview changes.",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to edit"),
      edits: z.array(z.object({
        old_text: z.string().describe("Exact text to find (must match uniquely in the file)"),
        new_text: z.string().describe("Replacement text. Empty string to delete the matched section"),
      })).min(1).describe("Array of search-and-replace operations, applied sequentially"),
      dry_run: z.boolean().optional().describe("If true, preview changes without writing (default false)"),
    }),
  }
);
