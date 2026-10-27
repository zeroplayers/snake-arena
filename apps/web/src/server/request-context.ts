/**
 * Per-request facts the edge (`src/server/edge.ts`) logs once the response is ready, filled in by
 * whoever learns them: the request id and route at the edge, the user and the error code in the
 * handlers (`cli-api.ts`, `bot-admin.ts`, `moderation.ts`). Kept in an `AsyncLocalStorage`, so
 * handlers don't have to pass it around. Outside a request (tests calling a handler directly,
 * cron) the setters do nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  /** Route pattern, e.g. `/api/bots/:bot/versions`. */
  route: string;
  userId?: string;
  /** `ApiErrorBody.error` / `AdminErrorCode` of a refused request; `ok` otherwise. */
  outcome?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequest<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

export function setRequestUser(userId: string) {
  const context = storage.getStore();
  if (context) context.userId = userId;
}

export function setRequestOutcome(outcome: string) {
  const context = storage.getStore();
  if (context) context.outcome = outcome;
}
