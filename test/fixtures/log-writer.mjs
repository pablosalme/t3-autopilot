// Child process for the JSONL concurrency test: appends delegations and
// outcomes with the real log module. Usage: node log-writer.mjs <log> <worker> <count>
const [logPath, worker, count] = process.argv.slice(2);
const { logDelegation, logOutcome } = await import(new URL("../../src/log.ts", import.meta.url).href);
for (let i = 0; i < Number(count); i++) {
  const d = logDelegation(logPath, {
    taskType: "code",
    providerInstanceId: `w${worker}`,
    model: "m",
    recommendedRank: 1,
    summary: "s".repeat(150),
  });
  logOutcome(logPath, { delegationId: d.id, outcome: i % 2 ? "success" : "corrected", note: "n".repeat(150) });
}
