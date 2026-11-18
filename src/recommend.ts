import { driverKindOf, parseCapabilities, type Model, type Provider, type SelectedOption } from "./capabilities.js";
import { classifyTask } from "./classify.js";
import { buildOptions, shiftEffort } from "./effort.js";
import { resolveFamily } from "./families.js";
import type { CandidateRule, Policy } from "./policy.js";
import { evaluateUsage, type ProviderUsage, type UsageSource, type UsageTier } from "./usage.js";

export type Size = "small" | "medium" | "large";
export type Criticality = "low" | "normal" | "high";

export interface RecommendInput {
  task: string;
  taskType?: string;
  size?: Size;
  criticality?: Criticality;
  /** Output of T3 Code's orchestrator_capabilities (object, JSON string or providers array). */
  capabilities: unknown;
  /** Usage percentages known by the caller; they override the configured usage source. */
  usage?: ProviderUsage[];
}

export interface Candidate {
  providerInstanceId: string;
  model: string;
  options: SelectedOption[];
  reason: string;
}

export interface Recommendation {
  taskType: string;
  classification: { source: "given" | "classifier"; reason: string; matched: string[] };
  candidates: Candidate[];
  /** Why providers or policy entries were left out. */
  skipped: string[];
  usageSource: string;
}

interface Scored {
  candidate: Candidate;
  usageTier: UsageTier;
  inheritedPenalty: 0 | 1;
  order: number;
}

function eligibleProviders(providers: Provider[], policy: Policy, inherited: string | undefined, skipped: string[]): Provider[] {
  return providers.filter((p) => {
    const id = p.providerInstanceId;
    if (!p.canRunChildTask) {
      const why = p.constraints?.length ? p.constraints.join("; ") : "canRunChildTask is false";
      skipped.push(`${id}: ${why}`);
      return false;
    }
    if (policy.excludeProviders.includes(id)) {
      skipped.push(`${id}: listed in excludeProviders`);
      return false;
    }
    if (inherited !== undefined && id !== inherited && p.canRunCrossProviderChildTask === false) {
      skipped.push(`${id}: cannot run a child task for another provider`);
      return false;
    }
    return true;
  });
}

function instancesFor(rule: CandidateRule, providers: Provider[]): Provider[] {
  if (rule.instance !== undefined) return providers.filter((p) => p.providerInstanceId === rule.instance);
  return providers.filter((p) => driverKindOf(p) === rule.provider);
}

function scoreRules(
  rules: CandidateRule[],
  label: string,
  ctx: {
    providers: Provider[];
    policy: Policy;
    input: RecommendInput;
    usage: Map<string, ProviderUsage>;
    inherited?: string;
    avoidInherited: boolean;
    skipped: string[];
  },
): Scored[] {
  const { policy, input } = ctx;
  const shift =
    (policy.effortShift.size[input.size ?? "medium"] ?? 0) +
    (policy.effortShift.criticality[input.criticality ?? "normal"] ?? 0);
  const out: Scored[] = [];
  const seen = new Set<string>();

  rules.forEach((rule, ruleIndex) => {
    const family = policy.families[rule.family];
    if (!family) return;
    const targets = instancesFor(rule, ctx.providers);
    if (targets.length === 0) {
      ctx.skipped.push(`${label} #${ruleIndex + 1} (${rule.instance ?? rule.provider}/${rule.family}): provider not available`);
      return;
    }
    for (const provider of targets) {
      const model: Model | undefined = resolveFamily(family, provider);
      if (!model) {
        ctx.skipped.push(
          `${label} #${ruleIndex + 1}: no model of family ${rule.family} on ${provider.providerInstanceId}` +
            " (orchestrator_capabilities lists a short list; pass `search` results if the model is omitted)",
        );
        continue;
      }
      const key = `${provider.providerInstanceId}\u0000${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const effort = rule.effort ? shiftEffort(rule.effort, shift) : undefined;
      const built = buildOptions(model, policy.effortOptionIds, effort, rule.options);
      const verdict = evaluateUsage(ctx.usage.get(provider.providerInstanceId), model.id, policy);
      let usageTier = verdict.tier;
      const notes = [...built.notes];
      if (verdict.note) notes.push(verdict.note);
      if (usageTier === 1 && rule.noDemote) {
        usageTier = 0;
        notes.push("noDemote: kept in place despite usage");
      } else if (usageTier > 0) {
        notes.push("demoted for usage");
      }
      const inheritedPenalty: 0 | 1 =
        ctx.avoidInherited && ctx.inherited !== undefined && provider.providerInstanceId === ctx.inherited ? 1 : 0;
      if (inheritedPenalty) notes.push("same provider as the orchestrator; demoted for an independent review");

      const effortText = built.effort ? `, effort ${built.effort}` : "";
      out.push({
        candidate: {
          providerInstanceId: provider.providerInstanceId,
          model: model.id,
          options: built.options,
          reason:
            `${label} #${ruleIndex + 1}: latest ${rule.family} on ${provider.providerInstanceId} is ${model.id}${effortText}` +
            (notes.length ? ` (${notes.join("; ")})` : ""),
        },
        usageTier,
        inheritedPenalty,
        order: out.length,
      });
    }
  });
  return out;
}

function rank(scored: Scored[]): Scored[] {
  return [...scored].sort(
    (a, b) => a.usageTier - b.usageTier || a.inheritedPenalty - b.inheritedPenalty || a.order - b.order,
  );
}

export async function recommendModel(input: RecommendInput, policy: Policy, usageSource: UsageSource): Promise<Recommendation> {
  const caps = parseCapabilities(input.capabilities);

  let classification: Recommendation["classification"];
  if (input.taskType !== undefined) {
    if (!policy.taskTypes[input.taskType]) {
      throw new Error(`Unknown taskType "${input.taskType}". Known types: ${Object.keys(policy.taskTypes).join(", ")}`);
    }
    classification = { source: "given", reason: "taskType given by the caller", matched: [] };
  } else {
    const c = classifyTask(input.task, policy);
    classification = { source: "classifier", reason: c.reason, matched: c.matched };
    input = { ...input, taskType: c.taskType };
  }
  const taskType = input.taskType as string;
  const typeDef = policy.taskTypes[taskType]!;

  const skipped: string[] = [];
  const inherited = caps.inheritedProviderInstanceId;
  const providers = eligibleProviders(caps.providers, policy, inherited, skipped);

  const ids = providers.map((p) => p.providerInstanceId);
  const usage = await usageSource.getUsage(ids);
  for (const u of input.usage ?? []) usage.set(u.providerInstanceId, u);

  const ctx = {
    providers,
    policy,
    input,
    usage,
    inherited,
    avoidInherited: typeDef.avoidInheritedProvider === true,
    skipped,
  };

  let scored = scoreRules(typeDef.candidates, taskType, ctx);
  if (scored.length === 0 && policy.fallback.length > 0) {
    scored = scoreRules(policy.fallback, "fallback", ctx);
  }

  let candidates = rank(scored)
    .slice(0, policy.maxCandidates)
    .map((s) => s.candidate);

  if (candidates.length === 0 && inherited !== undefined && caps.inheritedModel !== undefined) {
    const parent = providers.find((p) => p.providerInstanceId === inherited);
    if (parent) {
      candidates = [
        {
          providerInstanceId: inherited,
          model: caps.inheritedModel,
          options: caps.inheritedOptions ?? [],
          reason: "no policy candidate is available; same provider, model and options as the orchestrator",
        },
      ];
    }
  }

  return { taskType, classification, candidates, skipped, usageSource: input.usage?.length ? `${usageSource.name}+call` : usageSource.name };
}
