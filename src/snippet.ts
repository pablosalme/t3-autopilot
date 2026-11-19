/**
 * Instructions the user pastes into the orchestrator's CLAUDE.md / AGENTS.md.
 * T3 Code tells orchestrators to use their native subagent tool for children
 * on their own provider and "Provider or model unavailable: say so. Never
 * switch unasked", so the snippet asks for a recommendation before every child
 * (native ones too) and explicitly authorises switching.
 */
export const INSTRUCTIONS_SNIPPET = `## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task in T3 Code following the t3-autopilot MCP server. Switching provider or model as recommended by \`recommend_model\` counts as asked for by the user.

1. For every child task, including the ones you would start with your native subagent tool, call \`recommend_model\` first with \`task\` (one line), \`taskType\` (always; choose from the types listed in the tool description) and, if you know them, \`size\` and \`criticality\`.
2. Pass \`capabilities\` (the full output of \`orchestrator_capabilities\`) on the first call of the thread and again after an error or when providers change; the server keeps the last one, so other calls can omit it. Pass it whole, exactly as returned, never trimmed or summarised: a copy without each model's \`options\` loses the effort settings. If a call fails with "No capabilities yet", call \`orchestrator_capabilities\` and pass its full output again.
3. Use the first candidate. If it has \`sameAsOrchestrator: true\`, your native subagent tool is fine; otherwise call \`delegate_task\` with its \`providerInstanceId\`, \`model\` and \`options\` as \`target\`. If that child cannot start, or stops at once, because of a usage limit or its plan (for example "not included in your weekly usage"), call \`mark_unavailable\` with its \`providerInstanceId\`, its \`model\` (omit it if the whole provider is out), a short \`reason\` and \`until\` if you know when the limit resets, then use the next candidate.
4. Tell the user in one line which provider and model you picked, and why (the candidate's \`reason\`).
5. If \`recommend_model\` returns no candidate or fails, delegate inheriting your own provider and model, and say so.
6. If the result has \`warnings\` about omitted models, call \`orchestrator_capabilities\` with the \`search\` they suggest and pass that output to \`recommend_model\` as \`capabilities\` with \`mergeCapabilities: true\`.
7. If the user names a provider or model for a task, use theirs instead.
8. Right after delegating, call \`log_delegation\` with the \`taskType\`, \`providerInstanceId\`, \`model\` and \`options\` you used, \`recommendedRank\` (1-based rank of the candidate, or null if you chose something else) and \`childThreadId\`; keep the \`delegationId\`. After you review the child's result, call \`log_outcome\` with that \`delegationId\` and \`outcome\`: \`success\` (accepted as is), \`corrected\` (you had to fix or redo part of it) or \`failure\` (not usable; a child that could not start goes to \`mark_unavailable\` instead); add a short \`note\`.
`;
