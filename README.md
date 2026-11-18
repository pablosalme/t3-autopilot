# t3-autopilot

**What:** automatic model selection for T3 Code orchestrators: picks provider, model and effort for each delegated task.
**For:** T3 Code users who orchestrate agents across several providers and subscriptions. T3 Code only.
**Status:** pre-alpha, design phase. There is no code yet.

## Idea

When an orchestrator thread in T3 Code delegates work to a child, it has to choose a provider, a model and a reasoning effort. Today that choice is manual or hard-coded. t3-autopilot aims to recommend that choice based on the kind of task, the models actually available in your T3 Code setup, and how much usage is left on each of your subscriptions. The goal is to use the right model for each task while spreading load so no single subscription runs out first. The architecture is still being decided.

## Roadmap

1. **MVP:** a policy file that maps task types to models, plus a delegation log.
2. **MCP `recommend_model`:** a tool orchestrators call before delegating, with usage-aware balancing across subscriptions.
3. **Policy updates:** weekly proposals to update the policy based on public model leaderboards.

None of these phases is implemented yet.

## License

[MIT](LICENSE)
