import {
  driverKindOf,
  FULL_CATALOG_DRIVERS,
  parseCapabilities,
  type Model,
  type Provider,
  type SelectedOption,
} from "./capabilities.js";
import { classifyTask } from "./classify.js";
import { buildOptions, shiftEffort } from "./effort.js";
import { familyPattern, resolveFamily } from "./families.js";
import type { CandidateRule, Effort, Policy } from "./policy.js";
import { evaluateUsage, type ProviderUsage, type UsageSource, type UsageTier } from "./usage.js";

export type Size = "small" | "medium" | "large";
export type Criticality = "low" | "normal" | "high";

export interface RecommendInput {
  task: string;
  taskType?: string;
  size?: Size;
  criticality?: Criticality;
  /** Output of T3 Code's orchestrator_capabilities (object, JSON string, providers array or a list of outputs). */
  capabilities: unknown;
  /** Usage percentages known by the caller; they override the configured usage source. */
  usage?: ProviderUsage[];
}

/** Where a candidate came from: the task type's list, the policy fallback, the generic fallback, or the orchestrator itself. */
export type CandidateSource = "taskType" | "fallback" | "generic" | "inherited";

export interface Candidate {
  providerInstanceId: string;
  model: string;
  options: SelectedOption[];
  reason: string;
  source: CandidateSource;
  /** Same provider instance and model as the orchestrator: a native subagent would do. */
  sameAsOrchestrator: boolean;
}

export interface Recommendation {
  taskType: string;
  classification: { source: "given" | "classifier"; reason: string; matched: string[] };
  candidates: Candidate[];
  /** Why providers or policy entries were left out. */
  skipped: string[];
  /** Things the orchestrator can act on, e.g. models omitted from the short list. */
  warnings: string[];
  usageSource: string;
}

/**
 * Model ids that mean "the provider's own default" for each driver, from T3's
 * DEFAULT_MODEL_BY_PROVIDER (see docs/providers.md). Used by the generic
 * fallback. A provider that lists no models accepts any slug in T3, so the
 * first id is also used then.
 */
export const DRIVER_DEFAULT_MODELS: Readonly<Record<string, readonly string[]>> = {
  cursor: ["default", "auto"],
  grok: ["grok-build"],
  antigravity: ["antigravity-default"],
  kiro: ["default"],
  fx: ["default"],
  muse: ["default"],
  pi: ["default"],
  acpRegistry: ["default"],
};
const GENERIC_DEFAULT_IDS = ["auto", "default"];

interface Scored {
  candidate: Candidate;
  usageTier: UsageTier;
  inheritedPenalty: 0 | 1;
  order: number;
}

interface Ctx {
  providers: Provider[];
  policy: Policy;
  input: RecommendInput;
  usage: Map<string, ProviderUsage>;
  inherited?: string;
  inheritedModel?: string;
  avoidInherited: boolean;
  skipped: string[];
  /** provider instance + model already recommended, across stages. */
  seen: Set<string>;
  out: Scored[];
  shift: number;
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

function ruleTarget(rule: CandidateRule): string {
  return rule.instance ?? rule.provider ?? "?";
}

function instancesFor(rule: CandidateRule, providers: Provider[]): Provider[] {
  if (rule.instance !== undefined) return providers.filter((p) => p.providerInstanceId === rule.instance);
  if (rule.provider === "*") return providers;
  return providers.filter((p) => driverKindOf(p) === rule.provider);
}

function push(ctx: Ctx, provider: Provider, model: Model, effort: Effort | undefined, extra: CandidateRule["options"], source: CandidateSource, why: string, noDemote = false): void {
  const key = `${provider.providerInstanceId}\u0000${model.id}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  const { policy } = ctx;
  const built = buildOptions(model, policy.effortOptionIds, effort, extra);
  const verdict = evaluateUsage(ctx.usage.get(provider.providerInstanceId), model.id, policy);
  let usageTier = verdict.tier;
  const notes = [...built.notes];
  if (verdict.note) notes.push(verdict.note);
  if (usageTier === 1 && noDemote) {
    usageTier = 0;
    notes.push("noDemote: kept in place despite usage");
  } else if (usageTier > 0) {
    notes.push("demoted for usage");
  }
  const inheritedPenalty: 0 | 1 =
    ctx.avoidInherited && ctx.inherited !== undefined && provider.providerInstanceId === ctx.inherited ? 1 : 0;
  if (inheritedPenalty) notes.push("same provider as the orchestrator; demoted for an independent review");
  const effortText = built.effort ? `, effort ${built.effort}` : "";
  ctx.out.push({
    candidate: {
      providerInstanceId: provider.providerInstanceId,
      model: model.id,
      options: built.options,
      reason: `${why}${effortText}` + (notes.length ? ` (${notes.join("; ")})` : ""),
      source,
      sameAsOrchestrator: provider.providerInstanceId === ctx.inherited && model.id === ctx.inheritedModel,
    },
    usageTier,
    inheritedPenalty,
    order: ctx.out.length,
  });
}

/**
 * Score a list of rules. `baseEffort`, when given, replaces each rule's own
 * effort: the fallback list follows the task type's effort, so a quick task
 * does not get a fallback model at high effort.
 */
function scoreRules(rules: CandidateRule[], label: string, source: CandidateSource, ctx: Ctx, baseEffort?: Effort): void {
  const { policy } = ctx;
  rules.forEach((rule, ruleIndex) => {
    const family = policy.families[rule.family];
    if (!family) return;
    const tag = `${label} #${ruleIndex + 1}`;
    // Rules for drivers the user does not have are expected (any mix of providers); they are not reported.
    const targets = instancesFor(rule, ctx.providers);
    for (const provider of targets) {
      if (!familyPattern(family, provider)) continue;
      const model = resolveFamily(family, provider);
      if (!model) {
        if (rule.provider !== "*") {
          ctx.skipped.push(`${tag}: no ${rule.family} model listed on ${provider.providerInstanceId}`);
        }
        continue;
      }
      const wanted = baseEffort ?? rule.effort;
      const effort = wanted ? shiftEffort(wanted, ctx.shift) : undefined;
      const where = rule.provider === "*" && rule.instance === undefined ? " (any provider)" : "";
      push(ctx, provider, model, effort, rule.options, source, `${tag}${where}: latest ${rule.family} on ${provider.providerInstanceId} is ${model.id}`, rule.noDemote);
    }
  });
}

/**
 * Generic fallback for providers no policy family covers: the provider's own
 * default model ("auto"/"default"/driver default) if listed, else the first
 * model T3 lists (T3 orders models by the user's preference). Low confidence.
 */
function scoreGeneric(ctx: Ctx, effort: Effort | undefined): void {
  for (const provider of ctx.providers) {
    const driver = driverKindOf(provider);
    const defaults = [...(Object.hasOwn(DRIVER_DEFAULT_MODELS, driver) ? DRIVER_DEFAULT_MODELS[driver]! : []), ...GENERIC_DEFAULT_IDS];
    let model: Model | undefined;
    let why: string;
    const listedDefault = defaults.map((id) => provider.models.find((m) => m.id === id)).find((m) => m !== undefined);
    if (listedDefault) {
      model = listedDefault;
      why = `the provider's default model`;
    } else if (provider.models.length > 0) {
      model = provider.models[0]!;
      why = "the first model T3 lists for it";
    } else if (Object.hasOwn(DRIVER_DEFAULT_MODELS, driver)) {
      // T3 accepts any slug on a provider that lists no models.
      model = { id: DRIVER_DEFAULT_MODELS[driver]![0]! };
      why = "the driver's default model (the provider lists no models)";
    } else {
      ctx.skipped.push(`generic: ${provider.providerInstanceId} lists no models and its driver "${driver}" has no known default`);
      continue;
    }
    push(
      ctx,
      provider,
      model,
      effort ? shiftEffort(effort, ctx.shift) : undefined,
      undefined,
      "generic",
      `generic fallback (low confidence, not chosen by a policy family): ${model.id} is ${why} on ${provider.providerInstanceId}`,
    );
  }
}

function rank(scored: Scored[]): Scored[] {
  return [...scored].sort(
    (a, b) => a.usageTier - b.usageTier || a.inheritedPenalty - b.inheritedPenalty || a.order - b.order,
  );
}

/** Warn about providers whose short list may hide a newer model of a family the policy would use. */
function omittedWarnings(ctx: Ctx, rules: CandidateRule[]): string[] {
  const warnings: string[] = [];
  for (const p of ctx.providers) {
    const omitted = p.omittedModels ?? 0;
    const driver = driverKindOf(p);
    if (omitted === 0 || FULL_CATALOG_DRIVERS.has(driver) || (p.mergedOutputs ?? 1) > 1) continue;
    const terms = new Set<string>();
    for (const rule of rules) {
      const applies =
        rule.instance !== undefined ? rule.instance === p.providerInstanceId : rule.provider === "*" || rule.provider === driver;
      const fam = ctx.policy.families[rule.family];
      if (!applies || !fam || !familyPattern(fam, p)) continue;
      terms.add(fam.search ?? rule.family);
    }
    const searches = [...terms].slice(0, 2).map((t) => `"${p.providerInstanceId} ${t}"`);
    warnings.push(
      `${p.providerInstanceId}: orchestrator_capabilities left out ${omitted} models, so a newer model may be missing.` +
        (searches.length
          ? ` Call orchestrator_capabilities with search ${searches.join(", ")} and pass each output to recommend_model with mergeCapabilities: true.`
          : ""),
    );
  }
  return warnings;
}

export async function recommendModel(input: RecommendInput, policy: Policy, usageSource: UsageSource): Promise<Recommendation> {
  const caps = parseCapabilities(input.capabilities);

  let classification: Recommendation["classification"];
  if (input.taskType !== undefined) {
    if (!Object.hasOwn(policy.taskTypes, input.taskType)) {
      throw new Error(`Unknown taskType "${input.taskType}". Known types: ${Object.keys(policy.taskTypes).join(", ")}`);
    }
    classification = { source: "given", reason: "taskType given by the caller", matched: [] };
  } else {
    const c = classifyTask(input.task, policy);
    classification = { source: "classifier", reason: `${c.reason} (pass taskType for a reliable choice)`, matched: c.matched };
    input = { ...input, taskType: c.taskType };
  }
  const taskType = input.taskType as string;
  const typeDef = policy.taskTypes[taskType]!;

  if (caps.providers.length === 0) {
    throw new Error(
      "orchestrator_capabilities lists no provider, so there is nothing to recommend. Call it again without `search`, or delegate inheriting your own model.",
    );
  }
  const skipped: string[] = [];
  const inherited = caps.inheritedProviderInstanceId ?? undefined;
  const providers = eligibleProviders(caps.providers, policy, inherited, skipped);
  if (providers.length === 0) {
    throw new Error(
      `No provider instance can run a child task (${skipped.map((x) => x.replace(/\.$/, "")).join("; ")}). ` +
        "Enable or sign in to a provider in T3 Code (Settings → Providers), or remove it from excludeProviders.",
    );
  }

  const ids = providers.map((p) => p.providerInstanceId);
  const usage = await usageSource.getUsage(ids);
  for (const u of input.usage ?? []) usage.set(u.providerInstanceId, u);

  const ctx: Ctx = {
    providers,
    policy,
    input,
    usage,
    inherited,
    inheritedModel: caps.inheritedModel ?? undefined,
    avoidInherited: typeDef.avoidInheritedProvider === true,
    skipped,
    seen: new Set(),
    out: [],
    shift:
      (policy.effortShift.size[input.size ?? "medium"] ?? 0) +
      (policy.effortShift.criticality[input.criticality ?? "normal"] ?? 0),
  };

  // Every stage is scored, then ranked: the task type's candidates come first,
  // the fallback list and the generic fallback fill the remaining slots.
  scoreRules(typeDef.candidates, taskType, "taskType", ctx);
  scoreRules(policy.fallback, "fallback", "fallback", ctx, typeDef.candidates[0]?.effort);
  if (policy.genericFallback) scoreGeneric(ctx, typeDef.candidates[0]?.effort);

  let candidates = rank(ctx.out)
    .slice(0, policy.maxCandidates)
    .map((s) => s.candidate);

  if (candidates.length === 0 && inherited !== undefined && caps.inheritedModel) {
    const parent = providers.find((p) => p.providerInstanceId === inherited);
    if (parent) {
      candidates = [
        {
          providerInstanceId: inherited,
          model: caps.inheritedModel,
          options: caps.inheritedOptions ?? [],
          reason: "low confidence: no policy or generic candidate is available; same provider, model and options as the orchestrator",
          source: "inherited",
          sameAsOrchestrator: true,
        },
      ];
    }
  }

  const warnings = omittedWarnings(ctx, [...typeDef.candidates, ...policy.fallback]);

  return {
    taskType,
    classification,
    candidates,
    skipped,
    warnings,
    usageSource: input.usage?.length ? `${usageSource.name}+call` : usageSource.name,
  };
}
