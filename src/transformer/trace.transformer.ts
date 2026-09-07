const toHex = (uuid?: string, len?: number): string =>
  uuid ? uuid.replace(/-/g, "").slice(0, len) : "";

function formatCodeFrames(frames: any[]): string {
  if (!Array.isArray(frames) || frames.length === 0) return "";
  return frames
    .map((f) => {
      if (!f) return "";
      const filePath =
        f.filePath || f.file || f.filename || f.fileName || f.path || "unknown";
      const lineNum = f.lineNumber ?? f.line ?? f.lineNo ?? f.ln ?? "?";
      const colNum = f.columnNumber ?? f.column ?? f.col ?? "?";

      let linesText = "";
      if (Array.isArray(f.lines)) {
        linesText = f.lines
          .map((l: any) => {
            if (typeof l === "string") return `   | ${l}`;
            const isError =
              l.isErrorLine || l.isError || l.highlight || l.active || l.error;
            const line = l.line ?? l.lineNumber ?? l.lineNo ?? l.ln ?? "";
            const content =
              l.content ?? l.text ?? l.code ?? l.lineContent ?? "";
            return `${isError ? "❌ " : "   "}${String(line).padStart(4, " ")} | ${content}`;
          })
          .join("\n");
      } else if (typeof f.lines === "string") {
        linesText = f.lines;
      }

      if (filePath === "unknown" && !linesText) return "";
      return `\n---------------- [ SOURCE CODE FRAME ] ----------------\n📁 ${filePath}:${lineNum}:${colNum}\n${linesText}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function flattenSpans(
  nodes: any[],
  traceIdHex: string,
  parentSpanHex: string,
  baseNs: bigint,
  snapshotError: any,
  snapshotAttr: any,
  snapshotDuration?: number,
  spans: any[] = [],
  isJob: boolean = false,
): any[] {
  if (!Array.isArray(nodes)) return spans;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isRootSpan = !parentSpanHex && i === 0;

    const spanHex = toHex(node.s, 16);
    const startOffsetMs = node.so || 0;
    const durationMs =
      isRootSpan && snapshotDuration !== undefined
        ? snapshotDuration
        : node.d || 0;

    const startNs = baseNs + BigInt(Math.round(startOffsetMs * 1e6));
    const endNs = startNs + BigInt(Math.round(durationMs * 1e6));

    const attributes: any[] = [
      { key: "code.namespace", value: { stringValue: node.c || "" } },
      { key: "code.function", value: { stringValue: node.m || "" } },
    ];

    let spanName = `${node.c}.${node.m}`;
    let spanKind = 1;

    if (isRootSpan) {
      spanKind = 2;
      if (isJob) {
        spanName = `JOB ${snapshotAttr?.queueName || ""}/${snapshotAttr?.name || node.m}`;
        if (snapshotAttr?.queueName)
          attributes.push({
            key: "messaging.destination",
            value: { stringValue: snapshotAttr.queueName },
          });
        if (snapshotAttr?.status)
          attributes.push({
            key: "job.status",
            value: { stringValue: snapshotAttr.status },
          });
        if (snapshotAttr?.id)
          attributes.push({
            key: "job.id",
            value: { stringValue: snapshotAttr.id },
          });
      } else {
        const method = snapshotAttr?.m || "GET";
        const statusCode =
          snapshotAttr?.sc || (snapshotError || node.e ? 500 : 200);
        const targetUrl = snapshotAttr?.ou || `/${node.m}`;

        spanName = `${method} ${targetUrl}`;
        attributes.push(
          { key: "http.method", value: { stringValue: method } },
          { key: "http.target", value: { stringValue: targetUrl } },
          { key: "http.status_code", value: { intValue: Number(statusCode) } },
        );
      }
    }

    const events: any[] = [];
    let status: { code: number; message?: string } = { code: 1 };
    const errorObj =
      typeof node.e === "object" && node.e !== null
        ? node.e
        : node.e
          ? snapshotError
          : null;

    if (errorObj) {
      status = {
        code: 2,
        message:
          typeof errorObj === "object"
            ? errorObj.message || "Error"
            : String(errorObj),
      };

      if (!isRootSpan && !isJob)
        attributes.push({ key: "http.status_code", value: { intValue: 500 } });

      if (typeof errorObj === "object") {
        const formattedCodeFrames = formatCodeFrames(errorObj.codeFrames || []);
        const fullStack = (errorObj.stack || "") + formattedCodeFrames;

        attributes.push({
          key: "exception.stacktrace",
          value: { stringValue: fullStack },
        });
        events.push({
          timeUnixNano: endNs.toString(),
          name: "exception",
          attributes: [
            {
              key: "exception.type",
              value: { stringValue: errorObj.cls || "Error" },
            },
            {
              key: "exception.message",
              value: { stringValue: errorObj.message || "Error" },
            },
            { key: "exception.stacktrace", value: { stringValue: fullStack } },
          ],
        });
      }
    }

    spans.push({
      traceId: traceIdHex,
      spanId: spanHex,
      parentSpanId: parentSpanHex || undefined,
      name: spanName,
      kind: spanKind,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes,
      events,
      status,
    });

    if (node.ch && node.ch.length > 0) {
      flattenSpans(
        node.ch,
        traceIdHex,
        spanHex,
        baseNs,
        snapshotError,
        snapshotAttr,
        undefined,
        spans,
        isJob,
      );
    }
  }
  return spans;
}
