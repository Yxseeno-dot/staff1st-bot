import { queryOne, execute } from "./db.js";

const WORKFLOW_SCHEMA_VERSION = 1;
const WORKFLOW_TTL_MINUTES = 10;

export type WorkflowState<T> = {
  workflowId: string | null;
  state: T;
  version: number;
  expired: boolean;
};

export async function loadWorkflow<T>(conversationId: string, userId: string, idle: T): Promise<WorkflowState<T>> {
  const row = await queryOne<{
    workflow_id: string;
    payload: T;
    version: number;
    status: string;
    expired: boolean;
  }>(
    `SELECT workflow_id::text, payload, version, status, expires_at <= now() AS expired
     FROM locum1st.bot_workflows
     WHERE conversation_id = $1 AND auth_user_id = $2`,
    [conversationId, userId]
  );

  if (!row || row.status !== "active") {
    return { workflowId: null, state: idle, version: 0, expired: false };
  }
  if (row.expired) {
    await execute(
      `UPDATE locum1st.bot_workflows SET status = 'expired', updated_at = now(), version = version + 1
       WHERE conversation_id = $1 AND auth_user_id = $2 AND status = 'active'`,
      [conversationId, userId]
    );
    return { workflowId: row.workflow_id, state: idle, version: row.version + 1, expired: true };
  }
  return { workflowId: row.workflow_id, state: row.payload, version: row.version, expired: false };
}

export async function saveWorkflow<T extends { phase: string }>(
  conversationId: string,
  userId: string,
  state: T
): Promise<string> {
  const row = await queryOne<{ workflow_id: string }>(
    `INSERT INTO locum1st.bot_workflows
       (conversation_id, auth_user_id, schema_version, phase, payload, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now() + ($6 * interval '1 minute'))
     ON CONFLICT (conversation_id) DO UPDATE SET
       workflow_id = CASE
         WHEN locum1st.bot_workflows.status = 'active' AND locum1st.bot_workflows.expires_at > now()
           THEN locum1st.bot_workflows.workflow_id
         ELSE gen_random_uuid()
       END,
       auth_user_id = EXCLUDED.auth_user_id,
       schema_version = EXCLUDED.schema_version,
       phase = EXCLUDED.phase,
       payload = EXCLUDED.payload,
       status = 'active',
       expires_at = EXCLUDED.expires_at,
       updated_at = now(),
       version = locum1st.bot_workflows.version + 1
     RETURNING workflow_id::text`,
    [conversationId, userId, WORKFLOW_SCHEMA_VERSION, state.phase, JSON.stringify(state), WORKFLOW_TTL_MINUTES]
  );
  if (!row) throw new Error("Failed to persist bot workflow");
  return row.workflow_id;
}

export async function finishWorkflow(
  conversationId: string,
  userId: string,
  status: "completed" | "cancelled" = "completed"
): Promise<void> {
  await execute(
    `UPDATE locum1st.bot_workflows
     SET status = $3, phase = 'idle', payload = '{"phase":"idle"}'::jsonb,
         updated_at = now(), version = version + 1
     WHERE conversation_id = $1 AND auth_user_id = $2 AND status = 'active'`,
    [conversationId, userId, status]
  );
}

export async function cleanupWorkflows(): Promise<void> {
  await execute(`UPDATE locum1st.bot_workflows
    SET status = 'expired', updated_at = now(), version = version + 1
    WHERE status = 'active' AND expires_at <= now()`);
  await execute(`DELETE FROM locum1st.bot_workflows
    WHERE status <> 'active' AND updated_at < now() - interval '30 days'`);
}
