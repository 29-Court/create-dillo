/** Rewrite SQLite numbered placeholders while preserving literals and comments. */
export function normalizeBindings(query: string, input: readonly unknown[]): { sql: string; values: unknown[] } {
  let sql = "", highest = 0, position = 0;
  const values: unknown[] = [];
  while (position < query.length) {
    const first = query[position]!;
    let end = position + 1;
    if (first === "'" || first === '"' || first === "`" || first === "[") {
      const close = first === "[" ? "]" : first;
      while (end < query.length) {
        if (query[end++] === close) {
          if (close !== "]" && query[end] === close) { end++; continue; }
          break;
        }
      }
    } else if (query.startsWith("--", position)) {
      const newline = query.indexOf("\n", position + 2);
      end = newline < 0 ? query.length : newline + 1;
    } else if (query.startsWith("/*", position)) {
      const close = query.indexOf("*/", position + 2);
      end = close < 0 ? query.length : close + 2;
    } else if (first === "?") {
      while (end < query.length && /[0-9]/.test(query[end]!)) end++;
      const index = end > position + 1 ? Number(query.slice(position + 1, end)) : highest + 1;
      if (!Number.isSafeInteger(index) || index < 1 || index > input.length) throw new TypeError(`Missing SQL binding ${index}.`);
      highest = Math.max(highest, index);
      values.push(input[index - 1]);
      sql += "?";
      position = end;
      continue;
    }
    sql += query.slice(position, end);
    position = end;
  }
  return { sql, values };
}
