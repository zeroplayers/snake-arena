/** Runs the matches `room-skew.ts` sends it, one at a time. */
import { parentPort } from "node:worker_threads";
import { type MatchOptions, runMatch } from "./room.ts";

parentPort?.on("message", (job: MatchOptions & { id: number }) => {
  parentPort?.postMessage({ id: job.id, lives: runMatch(job) });
});
