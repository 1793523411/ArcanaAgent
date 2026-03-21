import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";

const MAX_WRITE_SIZE = 1024 * 1024;

/** Minimum ratio of non-empty lines that must match for fuzzy matching to succeed */
const FUZZY_MATCH_THRESHOLD = 0.8;

interface EditResult {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldLines: string[];
  newLines: string[];
  fuzzy?: boolean;
}

/**
 * Attempt fuzzy matching when exact indexOf fails.
 * Compares lines after trimming whitespace and skipping empty lines.
 * Returns the start/end indices (in the content string) of the best match, or null.
 */
function fuzzyFindText(content: string, searchText: string): { start: number; end: number } | null {
  const contentLines = content.split("\n");
  const searchLines = searchText.split("\n");

  // Filter to non-empty lines for matching
  const searchNonEmpty = searchLines
    .map((line, idx) => ({ trimmed: line.trim(), idx }))
    .filter((l) => l.trimmed.length > 0);

  if (searchNonEmpty.length === 0) return null;

  let bestMatchStart = -1;
  let bestMatchEnd = -1;
  let bestMatchCount = 0;

  // Sliding window over content lines
  for (let i = 0; i <= contentLines.length - 1; i++) {
    // Try to match searchNonEmpty lines starting from content line i
    let searchIdx = 0;
    let contentIdx = i;
    let matchCount = 0;
    let firstMatchLine = -1;
    let lastMatchLine = -1;

    while (searchIdx < searchNonEmpty.length && contentIdx < contentLines.length) {
      const contentTrimmed = contentLines[contentIdx].trim();
      // Skip empty content lines
      if (contentTrimmed.length === 0) {
        contentIdx++;
        continue;
      }

      if (contentTrimmed === searchNonEmpty[searchIdx].trimmed) {
        if (firstMatchLine === -1) firstMatchLine = contentIdx;
        lastMatchLine = contentIdx;
        matchCount++;
        searchIdx++;
        contentIdx++;
      } else {
        // Allow skipping content lines only if we haven't started matching,
        // or if we're still within a reasonable gap
        if (firstMatchLine === -1) {
          contentIdx++;
          continue;
        }
        // If we started matching but hit a mismatch, try advancing search
        searchIdx++;
        // Don't advance contentIdx — the current content line may match the next search line
      }
    }

    const matchRatio = searchNonEmpty.length > 0 ? matchCount / searchNonEmpty.length : 0;
    if (matchRatio >= FUZZY_MATCH_THRESHOLD && matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestMatchStart = firstMatchLine;
      bestMatchEnd = lastMatchLine;
    }
  }

  if (bestMatchStart < 0) return null;

  // Convert line range to character indices
  let startCharIdx = 0;
  for (let i = 0; i < bestMatchStart; i++) {
    startCharIdx += contentLines[i].length + 1; // +1 for \n
  }

  let endCharIdx = startCharIdx;
  for (let i = bestMatchStart; i <= bestMatchEnd; i++) {
    endCharIdx += contentLines[i].length + (i < contentLines.length - 1 ? 1 : 0);
  }
  // Include trailing newline if present
  if (bestMatchEnd < contentLines.length - 1) {
    // endCharIdx already includes the \n from the loop
  }

  return { start: startCharIdx, end: endCharIdx };
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
  (input: { path: string; edits: Array<{ old_text: string; new_text: string; start_line?: number; end_line?: number }>; dry_run?: boolean }) => {
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
      const { old_text, new_text, start_line, end_line } = input.edits[i];

      if (!old_text) {
        return `[error] Edit #${i + 1}: old_text cannot be empty.`;
      }

      let searchContent = currentContent;
      let searchOffset = 0;
      let usedLineRange = false;

      // If line range is specified, narrow search scope
      if (start_line !== undefined && end_line !== undefined && start_line > 0 && end_line >= start_line) {
        const lines = currentContent.split("\n");
        const startIdx = start_line - 1; // Convert to 0-based
        const endIdx = Math.min(end_line, lines.length); // end_line is 1-based inclusive

        // Calculate character offset for the start line
        searchOffset = 0;
        for (let j = 0; j < startIdx; j++) {
          searchOffset += lines[j].length + 1; // +1 for \n
        }

        // Extract the line range as search content
        const rangeLines = lines.slice(startIdx, endIdx);
        searchContent = rangeLines.join("\n");
        usedLineRange = true;
      }

      let idx = searchContent.indexOf(old_text);
      let fuzzyMatch = false;
      let matchStart: number;
      let matchLength: number;

      if (idx !== -1) {
        // Exact match found
        matchStart = searchOffset + idx;
        matchLength = old_text.length;

        // Check for multiple matches within search scope
        const secondIdx = searchContent.indexOf(old_text, idx + 1);
        if (secondIdx !== -1) {
          const lineNum1 = currentContent.slice(0, searchOffset + idx).split("\n").length;
          const lineNum2 = currentContent.slice(0, searchOffset + secondIdx).split("\n").length;
          return `[error] Edit #${i + 1}: old_text matches multiple locations (lines ${lineNum1} and ${lineNum2}). Provide more context to make the match unique.`;
        }
      } else if (usedLineRange) {
        // Line range specified but exact match not found in range — try full file
        idx = currentContent.indexOf(old_text);
        if (idx !== -1) {
          matchStart = idx;
          matchLength = old_text.length;
          // Check for multiple matches in full file
          const secondIdx = currentContent.indexOf(old_text, idx + 1);
          if (secondIdx !== -1) {
            const lineNum1 = currentContent.slice(0, idx).split("\n").length;
            const lineNum2 = currentContent.slice(0, secondIdx).split("\n").length;
            return `[error] Edit #${i + 1}: old_text matches multiple locations (lines ${lineNum1} and ${lineNum2}). Provide more context to make the match unique.`;
          }
        } else {
          // Try fuzzy match
          const fuzzy = fuzzyFindText(currentContent, old_text);
          if (fuzzy) {
            matchStart = fuzzy.start;
            matchLength = fuzzy.end - fuzzy.start;
            fuzzyMatch = true;
          } else {
            const preview = old_text.length > 80 ? old_text.slice(0, 80) + "..." : old_text;
            return `[error] Edit #${i + 1}: old_text not found in file (even with fuzzy matching).\nSearched for: ${JSON.stringify(preview)}\nHint: Ensure the text is close to actual content. Use read_file to check current content.`;
          }
        }
      } else {
        // No line range, exact match failed — try fuzzy match
        const fuzzy = fuzzyFindText(currentContent, old_text);
        if (fuzzy) {
          matchStart = fuzzy.start;
          matchLength = fuzzy.end - fuzzy.start;
          fuzzyMatch = true;
        } else {
          const preview = old_text.length > 80 ? old_text.slice(0, 80) + "..." : old_text;
          return `[error] Edit #${i + 1}: old_text not found in file.\nSearched for: ${JSON.stringify(preview)}\nHint: Ensure exact match including whitespace and indentation. Use read_file to check current content.`;
        }
      }

      // Track line positions for diff
      const beforeMatch = currentContent.slice(0, matchStart);
      const matchedText = currentContent.slice(matchStart, matchStart + matchLength);
      const oldStartLine = beforeMatch.split("\n").length - 1;
      const oldLines = matchedText.split("\n");
      const newLines = new_text.split("\n");

      editResults.push({
        oldStart: oldStartLine,
        oldEnd: oldStartLine + oldLines.length,
        newStart: oldStartLine,
        newEnd: oldStartLine + newLines.length,
        oldLines,
        newLines,
        fuzzy: fuzzyMatch,
      });

      currentContent = currentContent.slice(0, matchStart) + new_text + currentContent.slice(matchStart + matchLength);
    }

    // Generate diff
    const diff = generateDiff(content, currentContent, editResults);
    const fuzzyEdits = editResults.filter((e) => e.fuzzy);
    const fuzzyNote = fuzzyEdits.length > 0
      ? `\n[fuzzy match] ${fuzzyEdits.length} edit(s) used fuzzy matching (whitespace-tolerant). Verify the result is correct.`
      : "";

    if (input.dry_run) {
      return `[dry_run] ${input.edits.length} edit(s) would be applied to ${input.path}${fuzzyNote}\n\n${diff}`;
    }

    // Write the modified content
    try {
      writeFileSync(input.path, currentContent, "utf-8");
    } catch (e) {
      return `[error] Failed to write file: ${e instanceof Error ? e.message : String(e)}`;
    }

    const lines = currentContent.split("\n").length;
    const bytes = Buffer.byteLength(currentContent, "utf-8");
    return `OK: applied ${input.edits.length} edit(s) to ${input.path} (${lines} lines, ${bytes} bytes)${fuzzyNote}\n\n${diff}`;
  },
  {
    name: "edit_file",
    description:
      "Edit a file using search-and-replace operations. More precise than write_file for modifying existing files. " +
      "Each edit specifies exact text to find (old_text) and its replacement (new_text). " +
      "Optionally provide start_line/end_line to narrow the search scope. " +
      "If exact match fails, fuzzy matching (whitespace-tolerant) is attempted automatically. " +
      "Edits are applied sequentially. Use dry_run to preview changes.",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to edit"),
      edits: z.array(z.object({
        old_text: z.string().describe("Exact text to find (must match uniquely in the file)"),
        new_text: z.string().describe("Replacement text. Empty string to delete the matched section"),
        start_line: z.number().optional().describe("Start line number (1-based). Narrows search scope to this range"),
        end_line: z.number().optional().describe("End line number (1-based, inclusive). Used with start_line"),
      })).min(1).describe("Array of search-and-replace operations, applied sequentially"),
      dry_run: z.boolean().optional().describe("If true, preview changes without writing (default false)"),
    }),
  }
);
