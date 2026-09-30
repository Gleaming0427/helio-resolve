import { jsonLog, loggableError, processNextDocument } from "@helio/adapters";
import { setTimeout } from "node:timers/promises";

jsonLog({ level: "info", event: "document_worker_started" });
for (;;) {
  try {
    if (!await processNextDocument()) await setTimeout(2000);
  } catch (error) {
    // Usually the database is unreachable; claimed jobs are reclaimed after their lease.
    jsonLog({ level: "error", event: "document_worker_unavailable", error: loggableError(error) });
    await setTimeout(5000);
  }
}
