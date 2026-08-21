export function shiftSaveIdentity(workflowId: string, proposalId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(workflowId) || !/^[0-9a-f-]{36}$/i.test(proposalId)) {
    throw new Error("Workflow and proposal IDs must be UUIDs");
  }
  return {
    workflow_id: workflowId,
    proposal_id: proposalId,
    idempotency_key: `${workflowId}:${proposalId}:save`,
  };
}

export function looksLikeExpiredActionReply(input: string): boolean {
  const trimmed = input.trim();
  if (/^(yes|y|confirm|log|accept|ok|all)\b/i.test(trimmed)) return true;
  if (trimmed.length > 40) return false;
  const stripped = trimmed
    .replace(/\b(and|the)\b/gi, ",")
    .replace(/(st|nd|rd|th)\b/gi, "");
  return /\d/.test(stripped) && /^[\d,\-\s]+$/.test(stripped);
}
