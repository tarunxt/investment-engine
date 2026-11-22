"use client";

import { useMemo } from "react";
import MarkdownRenderer from "./MarkdownRenderer";

type ParsedLlmTable = {
  intro: string;
  headers: string[];
  rows: string[][];
  outro: string;
};

function splitPipeTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isPipeTableDivider(line: string) {
  return /^\|?[\s:-|]+\|?$/.test(line.trim());
}

function parseLlmPipeTable(content: string): ParsedLlmTable | null {
  const lines = content.split(/\r?\n/);
  const tableStart = lines.findIndex((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || splitPipeTableRow(trimmed).length < 3) return false;
    const nextLine = lines[index + 1]?.trim() ?? "";
    return isPipeTableDivider(nextLine) || nextLine.startsWith("|");
  });

  if (tableStart < 0) return null;

  const headers = splitPipeTableRow(lines[tableStart]);
  let rowStart = tableStart + 1;
  if (isPipeTableDivider(lines[rowStart] ?? "")) rowStart += 1;

  const rows: string[][] = [];
  let tableEnd = rowStart;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith("|")) {
    const cells = splitPipeTableRow(lines[tableEnd]);
    if (cells.length >= 2 && !isPipeTableDivider(lines[tableEnd])) {
      rows.push(headers.map((_, index) => cells[index] ?? ""));
    }
    tableEnd += 1;
  }

  if (rows.length === 0) return null;
  return {
    intro: lines.slice(0, tableStart).join("\n").trim(),
    headers,
    rows,
    outro: lines.slice(tableEnd).join("\n").trim(),
  };
}

function jsonValue(line: string) {
  try { return JSON.parse(line); } catch { return null; }
}

function pairAssignments(prompt: string) {
  const assignments = new Map<number, string>();
  for (const line of prompt.split("\n")) {
    if (!line.trimStart().startsWith("{") || !line.includes('"assigned_pairs"')) continue;
    const bundle = jsonValue(line);
    if (!Array.isArray(bundle?.assigned_pairs)) continue;
    for (const pair of bundle.assigned_pairs) {
      if (Number.isSafeInteger(pair?.n) && typeof pair?.pair_id === "string") assignments.set(pair.n, pair.pair_id);
    }
  }
  return assignments;
}

export function parsePairwiseOutput(content: string, prompt: string): ParsedLlmTable | null {
  const assignments = pairAssignments(prompt);
  const rows: string[][] = [];
  const other: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^```(?:jsonl?|ndjson)?$/i.test(line)) continue;
    const record = jsonValue(line);
    let number: number | undefined;
    let pairId: string | undefined;
    let result: unknown, reason: unknown, leftRefs: unknown, rightRefs: unknown;
    if (Array.isArray(record) && record.length === 5 && Number.isSafeInteger(record[0]) && record[0] > 0) {
      [number, result, reason, leftRefs, rightRefs] = record;
      pairId = assignments.get(record[0]);
    } else if (typeof record?.pair_id === "string") {
      pairId = record.pair_id;
      const [left, right] = record.pair_id.split("~");
      result = record.result;
      reason = record.rationale;
      leftRefs = record.evidence?.[left];
      rightRefs = record.evidence?.[right];
    }
    if (typeof result !== "string" || typeof reason !== "string" || !Array.isArray(leftRefs) || !Array.isArray(rightRefs)) {
      other.push(raw);
      continue;
    }
    const [left, right] = pairId?.split("~") ?? [];
    rows.push([String(number ?? "—"), left ?? "—", right ?? "—", result, reason, leftRefs.join(", "), rightRefs.join(", ")]);
  }
  return rows.length ? { headers: ["Pair #", "First listing", "Second listing", "Result", "Rationale", "First source IDs", "Second source IDs"],
    rows, intro: "", outro: other.join("\n") } : null;
}

export function StandardLlmOutputRenderer({ content, pairwisePrompt }: { content: string; pairwisePrompt?: string }) {
  const parsed = useMemo(() => (pairwisePrompt !== undefined ? parsePairwiseOutput(content, pairwisePrompt) : null)
    ?? parseLlmPipeTable(content), [content, pairwisePrompt]);

  if (!parsed) {
    return (
      <MarkdownRenderer
        content={content}
        enableValidation={false}
        className="text-xs leading-6 text-slate-700 [&_.prose]:max-w-none [&_table]:min-w-max [&_td]:align-top [&_td]:text-xs [&_th]:whitespace-nowrap [&_th]:text-[11px]"
      />
    );
  }

  return (
    <div className="space-y-5">
      {parsed.intro ? (
        <MarkdownRenderer
          content={parsed.intro}
          enableValidation={false}
          className="text-sm leading-6 text-slate-700 [&_.prose]:max-w-none"
        />
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="max-h-[62vh] w-full max-w-full overflow-auto overscroll-contain">
          <table className="min-w-max border-separate border-spacing-0 text-left text-xs text-slate-700">
            <thead className="sticky top-0 z-10 bg-slate-900 text-[11px] uppercase tracking-[0.08em] text-white">
              <tr>
                {parsed.headers.map((header, index) => (
                  <th
                    key={`${header}-${index}`}
                    scope="col"
                    className="max-w-[18rem] border-r border-slate-700 px-3 py-3 align-top font-bold last:border-r-0"
                  >
                    {header || `Column ${index + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row, rowIndex) => (
                <tr key={`llm-row-${rowIndex}`} className="odd:bg-white even:bg-slate-50 hover:bg-blue-50/70">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`llm-cell-${rowIndex}-${cellIndex}`}
                      className="min-w-36 max-w-[22rem] border-r border-t border-slate-100 px-3 py-3 align-top leading-5 last:border-r-0"
                    >
                      {cell || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {parsed.outro ? (
        <MarkdownRenderer
          content={parsed.outro}
          enableValidation={false}
          className="text-sm leading-6 text-slate-700 [&_.prose]:max-w-none"
        />
      ) : null}
    </div>
  );
}
