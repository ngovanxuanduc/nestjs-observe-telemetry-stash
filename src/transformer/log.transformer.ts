export function mapLogLevel(level?: string): string {
  const l = String(level || "").toLowerCase();
  switch (l) {
    case "log":
      return "INFO";
    case "verbose":
      return "TRACE";
    case "warn":
      return "WARN";
    case "error":
      return "ERROR";
    case "debug":
      return "DEBUG";
    case "fatal":
      return "FATAL";
    default:
      return l.toUpperCase() || "INFO";
  }
}
