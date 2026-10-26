/** Enqueued by the deploy API in apps/web once a version's bundle is in R2. */
export interface CheckJob {
  versionId: string;
}

/**
 * Queue consumer for version checks (SPEC §6): load in QuickJS, run fixed seeds, qualify.
 * Stub: acknowledges every message so nothing piles up in the dead-letter queue.
 */
export async function handleChecks(batch: MessageBatch<CheckJob>, _env: Env): Promise<void> {
  for (const message of batch.messages) {
    console.log("check job (stub)", message.body.versionId);
    message.ack();
  }
}
