import {
  driverKindOf,
  type Model,
  type Provider,
  parseCapabilities,
  type SelectedOption,
  truncatedBy,
} from "./capabilities.js";
import { classifyTask } from "./classify.js";
import { buildOptions, shiftEffort } from "./effort.js";
import { familyPattern, resolveFamily, resolveFamilyDetail } from "./families.js";
import type { CandidateRule, Effort, Family, Policy } from "./policy.js";
import {
  allowsFamily,
  describeProfile,
  evaluateProfile,
  isPaidFamily,
  isRestricted,
  type ProfileVerdict,
  type SubscriptionProfile,
  type Subscriptions,
  unknownNames,
} from "./subscriptions.js";
import { findMark, markTarget, type UnavailableMark } from "./unavailable.js";
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
  /** Marks in force (mark_unavailable): those candidates go last, with the reason. */
  unavailable?: readonly UnavailableMark[];
  /**
   * Subscription profiles by provider instance id (set_subscription). When
   * given, they rank and filter candidates, and eligible providers without one
   * are listed in `setupNeeded`. Undefined: no profiles and no setupNeeded.
   */
  subscriptions?: Readonly<Subscriptions>;
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

/** A provider instance with no subscription profile, and what to ask the user about it. */
export interface SetupProvider {
  providerInstanceId: string;
  driverKind: string;
  displayName?: string;
  /** Policy families with a model listed on it, for onlyFamilies / avoidFamilies. */
  families: string[];
  questions: string[];
}

export interface SetupNeeded {
  providers: SetupProvider[];
  instructions: string;
}

export const SETUP_INSTRUCTIONS =
  "These providers have no subscription profile, so they are ranked as if their quota were unlimited and every " +
  "model were included in the plan. Without holding up the current task (this recommendation works without them), " +
  "ask the user these questions, for every provider at once, and save each answer with set_subscription: plan and " +
  "purpose in the user's words; quota (generous, standard or tight); quotaWindow (5h, weekly or monthly), how " +
  "often its limit resets; quotaPool, the same name on every provider " +
  "that shares one quota; includedFamilies or paidFamilies when some models are billed apart from the plan; and, " +
  "if the purpose narrows it, role (primary, secondary, experimental or lastResort), onlyFamilies or avoidFamilies " +
  "and onlyTaskTypes. Families come from each provider's `families`. A cheap plan kept to try models the other " +
  'subscriptions lack is quota tight and role experimental. If the user would rather not say, save plan "not ' +
  'given" and quota standard, so they are not asked again.';

export interface Recommendation {
  taskType: string;
  classification: { source: "given" | "classifier"; reason: string; matched: string[] };
  candidates: Candidate[];
  /** Why providers or policy entries were left out. */
  skipped: string[];
  /** Things the orchestrator can act on, e.g. models omitted from the short list. */
  warnings: string[];
  usageSource: string;
  /** Eligible providers with no subscription profile; only when profiles were passed and some are missing. */
  setupNeeded?: SetupNeeded;
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
  /** Marked unavailable (a usage limit or plan): after every other candidate. */
  unavailable?: UnavailableMark;
  usageTier: UsageTier;
  inheritedPenalty: 0 | 1;
  /** From the provider's subscription profile: 0 none, up to 3 for lastResort. */
  profileTier: number;
  /** Why the candidate breaks its provider's subscription profile; empty when it fits or there is none. */
  outside: string[];
  /** Why the model costs extra on its provider's plan (billed apart); undefined when it is included. */
  extraCost?: string;
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
  /** Per family: other eligible providers that offer it and are not restricted by their profile. */
  familyHolders: Map<string, Provider[]>;
}

export function eligibleProviders(
  providers: Provider[],
  policy: Policy,
  inherited: string | undefined,
  skipped: string[],
): Provider[] {
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
  if (rule.provider === "*") return providers;
  return providers.filter((p) => driverKindOf(p) === rule.provider);
}

function push(
  ctx: Ctx,
  provider: Provider,
  model: Model,
  effort: Effort | undefined,
  extra: CandidateRule["options"],
  source: CandidateSource,
  why: string,
  noDemote = false,
  more: { notes?: string[]; family?: string } = {},
): void {
  const id = provider.providerInstanceId;
  const key = `${id}\u0000${model.id}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  const { policy } = ctx;
  const profile = profileFor(ctx, id);
  const fit: ProfileVerdict = profile
    ? evaluateProfile(profile, {
        family: more.family,
        taskType: ctx.input.taskType as string,
        size: ctx.input.size ?? "medium",
        criticality: ctx.input.criticality ?? "normal",
        familyElsewhere:
          more.family === undefined
            ? []
            : holdersOf(ctx, more.family)
                .filter((p) => p.providerInstanceId !== id)
                .map((p) => p.providerInstanceId),
      })
    : { tier: 0, outside: [] };
  // A model billed apart does not draw from the plan's quota, so a shared pool's limits do not apply to it.
  const pool = profile?.quotaPool !== undefined && fit.extraCost === undefined ? profile.quotaPool : undefined;
  const mates = pool === undefined ? [] : poolMates(ctx, id, pool);
  const built = buildOptions(model, policy.effortOptionIds, effort, extra);
  const verdict = evaluateUsage(poolUsage(ctx, id, mates), model.id, policy);
  let usageTier = verdict.tier;
  const notes = [...(more.notes ?? []), ...built.notes];
  const marks = ctx.input.unavailable ?? [];
  let mark = findMark(marks, id, model.id);
  if (mark) {
    notes.push(`marked unavailable until ${mark.until}: ${mark.reason}; moved to the end`);
  } else {
    // A limit on another provider of the same quota pool (a whole-provider mark) is this one's limit too.
    mark = mates.map((mate) => marks.find((m) => m.providerInstanceId === mate && m.model === undefined)).find(Boolean);
    if (mark) {
      notes.push(
        `shares quota pool "${pool}" with ${mark.providerInstanceId}, marked unavailable until ${mark.until}: ` +
          `${mark.reason}; moved to the end`,
      );
    }
  }
  if (verdict.note) notes.push(verdict.note);
  if (usageTier === 1 && noDemote) {
    usageTier = 0;
    notes.push("noDemote: kept in place despite usage");
  } else if (usageTier > 0) {
    notes.push("demoted for usage");
  }
  const inheritedPenalty: 0 | 1 = ctx.avoidInherited && ctx.inherited !== undefined && id === ctx.inherited ? 1 : 0;
  if (inheritedPenalty) notes.push("same provider as the orchestrator; demoted for an independent review");
  if (fit.note) notes.push(fit.note);
  const effortText = built.effort ? `, effort ${built.effort}` : "";
  ctx.out.push({
    candidate: {
      providerInstanceId: id,
      model: model.id,
      options: built.options,
      reason: `${why}${effortText}${notes.length ? ` (${notes.join("; ")})` : ""}`,
      source,
      sameAsOrchestrator: id === ctx.inherited && model.id === ctx.inheritedModel,
    },
    ...(mark ? { unavailable: mark } : {}),
    usageTier,
    inheritedPenalty,
    profileTier: fit.tier,
    outside: fit.outside,
    ...(fit.extraCost ? { extraCost: fit.extraCost } : {}),
    order: ctx.out.length,
  });
}

/** The subscription profile of a provider instance, if the call passed one (own keys only). */
function profileFor(ctx: Ctx, id: string): SubscriptionProfile | undefined {
  const subs = ctx.input.subscriptions;
  return subs && Object.hasOwn(subs, id) ? subs[id] : undefined;
}

/** Other provider instances (eligible or not) whose profile names the same quota pool. */
function poolMates(ctx: Ctx, id: string, pool: string): string[] {
  return Object.entries(ctx.input.subscriptions ?? {})
    .filter(([other, p]) => other !== id && p.quotaPool === pool)
    .map(([other]) => other);
}

/**
 * Usage of a provider, plus the windows of its quota pool mates that are not
 * scoped to their own models: a shared quota is used up from every app.
 */
function poolUsage(ctx: Ctx, id: string, mates: string[]): ProviderUsage | undefined {
  const own = ctx.usage.get(id);
  const shared = mates.flatMap((mate) => (ctx.usage.get(mate)?.windows ?? []).filter((w) => !w.modelIds));
  if (shared.length === 0) return own;
  return { providerInstanceId: id, windows: [...(own?.windows ?? []), ...shared] };
}

/**
 * Eligible providers that offer a family as part of their plan, and whose
 * profile neither restricts them nor rules the family out (nor bills it
 * apart), and that are not marked unavailable as a whole: where the user
 * "already has" that family now.
 */
function holdersOf(ctx: Ctx, familyName: string): Provider[] {
  const known = ctx.familyHolders.get(familyName);
  if (known) return known;
  const family = ctx.policy.families[familyName];
  const marks = ctx.input.unavailable ?? [];
  const holders = family
    ? ctx.providers.filter((p) => {
        // A provider marked unavailable as a whole cannot stand in for the restricted one now.
        if (marks.some((m) => m.providerInstanceId === p.providerInstanceId && m.model === undefined)) return false;
        const profile = profileFor(ctx, p.providerInstanceId);
        if (
          profile &&
          (isRestricted(profile) ||
            profile.role === "lastResort" ||
            !allowsFamily(profile, familyName) ||
            isPaidFamily(profile, familyName))
        ) {
          return false;
        }
        return resolveFamily(family, p) !== undefined;
      })
    : [];
  ctx.familyHolders.set(familyName, holders);
  return holders;
}

/** The first policy family (in policy order) that a model of this provider belongs to. */
function familyOfModel(policy: Policy, provider: Provider, model: Model): string | undefined {
  for (const [name, family] of Object.entries(policy.families)) {
    const re = familyPattern(family, provider);
    if (!re?.test(model.id)) continue;
    if (family.exclude && new RegExp(family.exclude, "i").test(model.id)) continue;
    return name;
  }
  return undefined;
}

/**
 * Score a list of rules. `baseEffort`, when given, replaces each rule's own
 * effort: the fallback list follows the task type's effort, so a quick task
 * does not get a fallback model at high effort.
 */
function scoreRules(
  rules: CandidateRule[],
  label: string,
  source: CandidateSource,
  ctx: Ctx,
  baseEffort?: Effort,
): void {
  const { policy } = ctx;
  rules.forEach((rule, ruleIndex) => {
    const family = policy.families[rule.family];
    if (!family) return;
    const tag = `${label} #${ruleIndex + 1}`;
    // Rules for drivers the user does not have are expected (any mix of providers); they are not reported.
    const targets = instancesFor(rule, ctx.providers);
    for (const provider of targets) {
      if (!familyPattern(family, provider)) continue;
      const resolved = resolveFamilyDetail(family, provider);
      if (!resolved) {
        if (rule.provider !== "*") {
          ctx.skipped.push(`${tag}: no ${rule.family} model listed on ${provider.providerInstanceId}`);
        }
        continue;
      }
      const wanted = baseEffort ?? rule.effort;
      const effort = wanted ? shiftEffort(wanted, ctx.shift) : undefined;
      const where = rule.provider === "*" && rule.instance === undefined ? " (any provider)" : "";
      const { model, ties } = resolved;
      // A tie is not "the latest" (T3's order broke it), and a truncated list may hide a newer model.
      const truncated = truncatedBy(provider);
      const newest = ties > 0 ? "" : truncated > 0 ? "newest listed " : "latest ";
      const why = `${tag}${where}: ${newest}${rule.family} on ${provider.providerInstanceId} is ${model.id}`;
      const notes: string[] = [];
      if (ties > 0) notes.push(`same version as ${ties} other${ties === 1 ? "" : "s"}, T3 lists this one first`);
      if (truncated > 0) notes.push(`${truncated} models left out of the list, so a newer one may exist`);
      push(ctx, provider, model, effort, rule.options, source, why, rule.noDemote, { notes, family: rule.family });
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
    const driverDefaults =
      (Object.hasOwn(DRIVER_DEFAULT_MODELS, driver) ? DRIVER_DEFAULT_MODELS[driver] : undefined) ?? [];
    const defaults = [...driverDefaults, ...GENERIC_DEFAULT_IDS];
    const listedDefault = defaults.map((id) => provider.models.find((m) => m.id === id)).find((m) => m !== undefined);
    const firstListed = provider.models[0];
    let model: Model;
    let why: string;
    if (listedDefault) {
      model = listedDefault;
      why = `the provider's default model`;
    } else if (firstListed) {
      model = firstListed;
      why = "the first model T3 lists for it";
    } else if (driverDefaults[0] !== undefined) {
      // T3 accepts any slug on a provider that lists no models.
      model = { id: driverDefaults[0] };
      why = "the driver's default model (the provider lists no models)";
    } else {
      ctx.skipped.push(
        `generic: ${provider.providerInstanceId} lists no models and its driver "${driver}" has no known default`,
      );
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
      false,
      { family: familyOfModel(ctx.policy, provider, model) },
    );
  }
}

function rank(scored: Scored[]): Scored[] {
  const marked = (s: Scored) => (s.unavailable ? 1 : 0);
  return [...scored].sort(
    (a, b) =>
      marked(a) - marked(b) ||
      a.usageTier - b.usageTier ||
      a.inheritedPenalty - b.inheritedPenalty ||
      a.profileTier - b.profileTier ||
      a.order - b.order,
  );
}

/** Families the rules would use on this provider, in rule order, without repeats. */
function familiesFor(ctx: Ctx, rules: CandidateRule[], p: Provider): { name: string; family: Family }[] {
  const driver = driverKindOf(p);
  const out = new Map<string, Family>();
  for (const rule of rules) {
    const applies =
      rule.instance !== undefined
        ? rule.instance === p.providerInstanceId
        : rule.provider === "*" || rule.provider === driver;
    const fam = ctx.policy.families[rule.family];
    if (applies && fam && familyPattern(fam, p) && !out.has(rule.family)) out.set(rule.family, fam);
  }
  return [...out].map(([name, family]) => ({ name, family }));
}

/**
 * Narrower `search` terms for a family on a provider, from its newest listed
 * model: the id (without `provider/` prefixes) up to its first version number,
 * and the same with the next number. `gemini-4-argon` gives `gemini-4` (every
 * gemini 4 model, so a tie or a 4.x is listed) and `gemini-5` (a newer one).
 */
function narrowerTerms(family: Family, p: Provider): string[] {
  const model = resolveFamily(family, p);
  const pattern = familyPattern(family, p);
  if (!model || !pattern) return [];
  const m = new RegExp(pattern.source, "id").exec(model.id);
  const at = m?.indices?.findIndex((range, i) => i > 0 && range !== undefined && /^\d+$/.test(m[i] ?? ""));
  const range = at !== undefined && at > 0 ? m?.indices?.[at] : undefined;
  if (!range) return [];
  const [start, end] = range;
  const head = model.id.slice(0, start);
  const cut = head.lastIndexOf("/") + 1;
  const prefix = head.slice(cut);
  const version = Number.parseInt(model.id.slice(start, end), 10);
  return [`${prefix}${version}`, `${prefix}${version + 1}`];
}

const MERGE_HINT = "and pass each output to recommend_model with mergeCapabilities: true.";

/**
 * Warn about providers whose latest list was truncated, so a newer model of a
 * family the policy would use may be missing: the full output's short list
 * until a search that lists the provider's models is merged, and a search that
 * itself had more than 8 matches.
 */
function omittedWarnings(ctx: Ctx, rules: CandidateRule[]): string[] {
  const warnings: string[] = [];
  for (const p of ctx.providers) {
    const omitted = truncatedBy(p);
    if (omitted === 0) continue;
    const id = p.providerInstanceId;
    const families = familiesFor(ctx, rules, p);
    const last = p.lastOutput;
    if (last === undefined) {
      const terms = [...new Set(families.map((f) => f.family.search ?? f.name))];
      const searches = terms.slice(0, 2).map((t) => `"${id} ${t}"`);
      warnings.push(
        `${id}: orchestrator_capabilities left out ${omitted} models, so a newer model may be missing.` +
          (searches.length ? ` Call orchestrator_capabilities with search ${searches.join(", ")} ${MERGE_HINT}` : ""),
      );
      continue;
    }
    // A truncated search: suggest narrower ones for the families it listed models of.
    const searched = families.filter(({ family }) => {
      const re = familyPattern(family, p);
      const exclude = family.exclude ? new RegExp(family.exclude, "i") : undefined;
      return last.models.some((m) => re?.test(m) && !exclude?.test(m));
    });
    const narrower = [...new Set(searched.slice(0, 2).flatMap(({ family }) => narrowerTerms(family, p)))];
    warnings.push(
      `${id}: the last orchestrator_capabilities output for it listed ${last.models.length} models and left out ` +
        `${omitted} more (T3 lists at most 8 matches), so a newer model may be missing. ` +
        (narrower.length
          ? `Narrow the search: call orchestrator_capabilities with search ${narrower.map((t) => `"${id} ${t}"`).join(", ")} ${MERGE_HINT}`
          : `Narrow the search with a more specific term, such as a version, ${MERGE_HINT}`),
    );
  }
  return warnings;
}

export async function recommendModel(
  input: RecommendInput,
  policy: Policy,
  usageSource: UsageSource,
): Promise<Recommendation> {
  const caps = parseCapabilities(input.capabilities);

  let classification: Recommendation["classification"];
  if (input.taskType !== undefined) {
    if (!Object.hasOwn(policy.taskTypes, input.taskType)) {
      throw new Error(`Unknown taskType "${input.taskType}". Known types: ${Object.keys(policy.taskTypes).join(", ")}`);
    }
    classification = { source: "given", reason: "taskType given by the caller", matched: [] };
  } else {
    const c = classifyTask(input.task, policy);
    classification = {
      source: "classifier",
      reason: `${c.reason} (pass taskType for a reliable choice)`,
      matched: c.matched,
    };
    input = { ...input, taskType: c.taskType };
  }
  const taskType = input.taskType as string;
  const typeDef = policy.taskTypes[taskType];
  if (!typeDef)
    throw new Error(`Unknown taskType "${taskType}". Known types: ${Object.keys(policy.taskTypes).join(", ")}`);

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
  // Usage passed in the call replaces the source's for that provider. A provider may come in several
  // entries (one per window): their windows add up, or the last entry would hide a busy window before it.
  const fromCall = new Map<string, ProviderUsage>();
  for (const u of input.usage ?? []) {
    const earlier = fromCall.get(u.providerInstanceId);
    fromCall.set(u.providerInstanceId, earlier ? { ...u, windows: [...earlier.windows, ...u.windows] } : u);
  }
  for (const [id, u] of fromCall) usage.set(id, u);

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
    familyHolders: new Map(),
  };

  // Every stage is scored, then ranked: the task type's candidates come first,
  // the fallback list and the generic fallback fill the remaining slots.
  scoreRules(typeDef.candidates, taskType, "taskType", ctx);
  scoreRules(policy.fallback, "fallback", "fallback", ctx, typeDef.candidates[0]?.effort);
  if (policy.genericFallback) scoreGeneric(ctx, typeDef.candidates[0]?.effort);

  const profileWarnings = applyProfiles(ctx);
  const ranked = rank(ctx.out);
  let candidates = ranked.slice(0, policy.maxCandidates).map((s) => s.candidate);
  // Marked candidates that did not make the list are reported once per mark.
  const cut = new Set(ranked.slice(policy.maxCandidates).flatMap((s) => (s.unavailable ? [s.unavailable] : [])));
  for (const mark of cut) {
    skipped.push(`${markTarget(mark)}: marked unavailable until ${mark.until} (${mark.reason})`);
  }

  if (candidates.length === 0 && inherited !== undefined && caps.inheritedModel) {
    const parent = providers.find((p) => p.providerInstanceId === inherited);
    if (parent) {
      candidates = [
        {
          providerInstanceId: inherited,
          model: caps.inheritedModel,
          options: caps.inheritedOptions ?? [],
          reason:
            "low confidence: no policy or generic candidate is available; same provider, model and options as the orchestrator",
          source: "inherited",
          sameAsOrchestrator: true,
        },
      ];
    }
  }

  const warnings = [...omittedWarnings(ctx, [...typeDef.candidates, ...policy.fallback]), ...profileWarnings];
  for (const [id, profile] of Object.entries(input.subscriptions ?? {})) {
    if (!ids.includes(id)) continue;
    const unknown = unknownNames(profile, policy);
    if (unknown.length) {
      warnings.push(
        `${id}: its subscription profile names ${unknown.slice(0, -2).join("; ")}; those names never match. ` +
          "Ask the user and save the profile again with set_subscription.",
      );
    }
  }
  const setupNeeded = input.subscriptions ? setupFor(ctx, input.subscriptions) : undefined;

  return {
    taskType,
    classification,
    candidates,
    skipped,
    warnings,
    usageSource: input.usage?.length ? `${usageSource.name}+call` : usageSource.name,
    ...(setupNeeded ? { setupNeeded } : {}),
  };
}

/** Whether a scored candidate can run now: not marked unavailable and its usage not exhausted. */
const usable = (s: Scored) => !s.unavailable && s.usageTier < 2;

/** Why a candidate should not be used while another can: outside its profile, or billed apart from the plan. */
function blockers(s: Scored): string[] {
  return [...s.outside, ...(s.extraCost ? [`extra cost: ${s.extraCost}`] : [])];
}

/**
 * Candidates outside their provider's subscription profile, or billed apart
 * from its plan, are dropped (and named in `skipped`) while any other
 * candidate can run. If none can, they stay, with a warning per provider:
 * they are the only option.
 */
function applyProfiles(ctx: Ctx): string[] {
  const blocked = ctx.out.filter((s) => blockers(s).length > 0);
  if (blocked.length === 0) return [];
  const profileOf = (id: string) => {
    const profile = profileFor(ctx, id);
    return profile ? ` (${describeProfile(profile)})` : "";
  };
  if (ctx.out.some((s) => blockers(s).length === 0 && usable(s))) {
    ctx.out = ctx.out.filter((s) => blockers(s).length === 0);
    for (const s of blocked) {
      const { providerInstanceId: id, model } = s.candidate;
      ctx.skipped.push(
        `${id}/${model}: left out by its subscription profile${profileOf(id)}: ${blockers(s).join("; ")}`,
      );
    }
    return [];
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const s of blocked) {
    const id = s.candidate.providerInstanceId;
    s.candidate.reason += " Used only because no candidate within the subscription profiles can run.";
    const warnKey = `${id}\u0000${s.extraCost ? s.candidate.model : ""}`;
    if (seen.has(warnKey)) continue;
    seen.add(warnKey);
    if (s.extraCost) {
      warnings.push(
        `${id}/${s.candidate.model}${profileOf(id)} costs extra: ${s.extraCost}, so it is paid at API prices or ` +
          "from prepaid credit. It is recommended only because no included model can run. Ask the user before delegating.",
      );
      continue;
    }
    const tight = profileFor(ctx, id)?.quota === "tight" ? " Its quota is tight and may run out quickly." : "";
    warnings.push(
      `${id}${profileOf(id)} is recommended outside its subscription profile (${s.outside.join("; ")}) because no ` +
        `other candidate can run.${tight} Tell the user before delegating.`,
    );
  }
  return warnings;
}

/** Eligible providers with no subscription profile, with the questions to ask the user. */
function setupFor(ctx: Ctx, subscriptions: Readonly<Subscriptions>): SetupNeeded | undefined {
  const missing = ctx.providers.filter((p) => !Object.hasOwn(subscriptions, p.providerInstanceId));
  if (missing.length === 0) return undefined;
  return {
    providers: missing.map((p) => {
      const id = p.providerInstanceId;
      const name = p.displayName && p.displayName !== id ? `${p.displayName} (${id})` : id;
      const families = Object.entries(ctx.policy.families)
        .filter(([, family]) => resolveFamily(family, p) !== undefined)
        .map(([familyName]) => familyName);
      return {
        providerInstanceId: id,
        driverKind: driverKindOf(p),
        ...(p.displayName ? { displayName: p.displayName } : {}),
        families,
        questions: [
          `Which plan do you have on ${name}? For example a monthly subscription such as "Claude Max" or "OpenCode Go", a free tier, or pay per use.`,
          `Is its quota generous (you rarely hit the limit), standard, or tight (it runs out quickly)? Does the limit reset every 5 hours, weekly or monthly?`,
          `Does the same plan cover another provider, so they share one quota (for example one plan for Grok and Cursor)?`,
          `Which models does the plan include, and are any billed apart at API prices or from prepaid credit?`,
          `What do you want ${name} for: any task, as a backup, or only something specific (for example trying models your other subscriptions do not have)?`,
        ],
      };
    }),
    instructions: SETUP_INSTRUCTIONS,
  };
}
