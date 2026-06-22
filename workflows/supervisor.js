/**
 * Supervisor workflow — checkpoint-based steering of a worker by a reviewer.
 *
 * This is the safe, recommended form of "orchestrator steers mid-session":
 * the worker is steered BETWEEN bounded steps, not mid-token. A reviewer agent
 * inspects each worker iteration and either accepts it (`CONTINUE`) or returns
 * a redirect instruction that becomes the worker's next prompt. The loop is
 * bounded by `maxRounds` so it always terminates.
 *
 * Run from Pi:
 *   workflow({ name: "supervisor", args: {
 *     task: "Implement X in file Y and explain the change",
 *     rubric: "Must edit the real file, run a verification command, and report the diff",
 *     maxRounds: 3,
 *     worker: "worker",      // optional, default "worker"
 *     reviewer: "reviewer",  // optional, default "reviewer"
 *   } })
 *
 * Returns { rounds, accepted, finalOutput, history } where history is the
 * per-round worker output + reviewer verdict, so the decision trail is auditable.
 *
 * Steering protocol: the reviewer MUST reply on its FIRST line with either:
 *   ACCEPT                      -> work meets the rubric; stop.
 *   REVISE: <instruction>       -> redirect; <instruction> becomes the next
 *                                  worker prompt (prepended to the original task).
 * Any other shape is treated as REVISE using the whole reviewer text, so a
 * malformed verdict still steers rather than silently accepting.
 */

const task = String(args.task ?? "").trim();
if (!task) throw new Error('supervisor: args.task is required (the work to perform).');

const rubric = String(args.rubric ?? "The result must fully and correctly satisfy the task.").trim();
const maxRounds = Math.max(1, Math.min(8, Number(args.maxRounds ?? 3) || 3));
const workerAgent = String(args.worker ?? "worker");
const reviewerAgent = String(args.reviewer ?? "reviewer");

const history = [];
let workerPrompt = task;
let accepted = false;
let finalOutput = "";

for (let round = 1; round <= maxRounds; round++) {
  phase(`round ${round}/${maxRounds}: work`);
  const output = await agent(workerPrompt, { agent: workerAgent });
  finalOutput = output;

  phase(`round ${round}/${maxRounds}: review`);
  const verdictRaw = await agent(
    `You are supervising a worker agent. Judge ONLY whether its latest output satisfies the rubric.\n\n` +
      `## Rubric\n${rubric}\n\n` +
      `## Original task\n${task}\n\n` +
      `## Worker output (round ${round})\n${output}\n\n` +
      `Reply on the FIRST line with exactly one of:\n` +
      `  ACCEPT\n` +
      `  REVISE: <a single concrete instruction telling the worker what to fix or do next>\n` +
      `Keep any explanation to later lines. Be strict: only ACCEPT if the rubric is fully met.`,
    { agent: reviewerAgent },
  );

  const verdict = parseVerdict(verdictRaw);
  history.push({ round, workerPrompt, output, verdict: verdict.kind, instruction: verdict.instruction ?? null, reviewerRaw: verdictRaw });
  log(`round ${round}: reviewer => ${verdict.kind}${verdict.instruction ? ` (${truncate(verdict.instruction, 80)})` : ""}`);

  if (verdict.kind === "ACCEPT") {
    accepted = true;
    break;
  }

  // REVISE: steer the next round. Carry the original task plus the redirect so
  // the worker keeps the goal in view while addressing the supervisor's note.
  workerPrompt =
    `${task}\n\n## Supervisor feedback on your previous attempt (address this specifically)\n${verdict.instruction}`;
}

phase(accepted ? "accepted" : "max rounds reached");

return {
  rounds: history.length,
  accepted,
  finalOutput,
  history: history.map((h) => ({
    round: h.round,
    verdict: h.verdict,
    instruction: h.instruction,
    outputPreview: truncate(h.output, 400),
  })),
};

function parseVerdict(text) {
  const firstLine = String(text ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (/^accept\b/i.test(firstLine)) return { kind: "ACCEPT" };
  const m = firstLine.match(/^revise\s*:\s*(.+)$/i);
  if (m && m[1].trim()) return { kind: "REVISE", instruction: m[1].trim() };
  // Malformed verdict: never silently accept. Steer using the whole reply.
  const fallback = String(text ?? "").trim();
  return { kind: "REVISE", instruction: fallback || "Re-attempt the task and satisfy the rubric." };
}

function truncate(s, n) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}
