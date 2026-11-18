/**
 * Instructions the user pastes into the orchestrator's CLAUDE.md / AGENTS.md.
 * T3 Code tells orchestrators "Provider or model unavailable: say so. Never
 * switch unasked", so the snippet explicitly authorises switching.
 */
export const INSTRUCTIONS_SNIPPET = `## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task you delegate in T3 Code, following the t3-autopilot MCP server. Switching provider or model as recommended by \`recommend_model\` counts as asked for by the user.

1. Before each \`delegate_task\`, call \`recommend_model\` with \`task\` (one line describing the child's job), \`capabilities\` (the full JSON output of \`orchestrator_capabilities\`; one call per thread is enough, call it again after an error) and, if you know them, \`taskType\`, \`size\` and \`criticality\`.
2. Use the first candidate: pass its \`providerInstanceId\`, \`model\` and \`options\` as \`delegate_task.target\`. If that child cannot start or stops on a usage limit, use the next candidate.
3. If the user names a provider or model for a task, use theirs instead.
4. After you review the child's result, call \`log_outcome\` with the \`taskType\` returned by \`recommend_model\`, the \`providerInstanceId\` and \`model\` you used, and \`outcome\`: \`success\` (accepted as is), \`corrected\` (you had to fix or redo part of it) or \`failure\`; add a short \`note\`.
`;
