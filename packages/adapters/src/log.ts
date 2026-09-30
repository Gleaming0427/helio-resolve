// Drivers and SDKs may echo credentials in their messages (connection URLs, tokens).
const scrub = (text: string) => text
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
  .replace(/Bearer\s+[\w.~+/-]+=*/gi, "Bearer ***");

export function loggableError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  return {
    type: error.name,
    code: "code" in error ? String(error.code) : undefined,
    message: scrub(error.message),
    stack: error.stack ? scrub(error.stack) : undefined,
  };
}

export type LogEntry = { level: "info" | "error"; event: string } & Record<string, unknown>;
export type Log = (entry: LogEntry) => void;
// One JSON object per line: CloudWatch metric filters match on $.level and $.event.
export const jsonLog: Log = entry => {
  (entry.level === "error" ? process.stderr : process.stdout).write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
};
