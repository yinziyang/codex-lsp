/** 业务诊断值使用 UTF-16 零基范围，输出时转换为一基。 */
export interface Diagnostic {
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}
/** 在协议边界校验并转换诊断，畸形结果保留未知状态。 */
export function parseDiagnostics(value: unknown): Diagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Diagnostic[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return undefined;
    const d = raw as Record<string, any>;
    const message =
      typeof d.message === "string"
        ? d.message
        : typeof d.message?.value === "string"
          ? d.message.value
          : undefined;
    if (
      message === undefined ||
      !d.range ||
      ![
        d.range.start?.line,
        d.range.start?.character,
        d.range.end?.line,
        d.range.end?.character,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (d.severity !== undefined && ![1, 2, 3, 4].includes(d.severity)) ||
      (d.source !== undefined && typeof d.source !== "string") ||
      (d.code !== undefined &&
        typeof d.code !== "string" &&
        typeof d.code !== "number")
    )
      return undefined;
    result.push({
      message,
      range: d.range,
      severity: d.severity,
      source: d.source,
      code: d.code,
    });
  }
  return result;
}
