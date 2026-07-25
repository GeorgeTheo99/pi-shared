/**
 * Implement workflow — the composite coding pipeline.
 *
 * Composes the four phases of a coding task so the caller doesn't re-specify
 * the agent roster each time:
 *
 *   1. recon   — `scout` (parallel over optional `questions`)         [read-only]
 *   2. plan    — `planner` turns recon + task into an implementation plan [read-only]
 *   3. build   — `worker` implements the plan                           [writes]
 *   4. review  — `reviewer` judges the build against a rubric;          [read-only]
 *                on REVISE the worker retries with the redirect, up to
 *                `maxRounds`. Accepted (or max-round) build is returned.
 *
 * The worker defaults to the OpenAI Codex subscription model
 * `openai-codex/gpt-5.6-sol`, auto-routed through the `~/.pi/agent` profile
 * by spawn_subagent's GPT-family subscription routing. Override per call via
 * `args.workerModel`. Reviewer/planner/scout inherit the parent session model
 * — on a resident local model that keeps spawn cost at ~0 swap, which is the
 * whole point of not auto-routing those roles (see AGENTS.md residency note).
 *
 * Run from Pi:
 *   workflow({ name: "implement", args: {
 *     task: "Implement X in file Y and explain the change",
 *     questions: [ "Where is the auth module?", "How are errors propagated?" ], // optional
 *     rubric: "Must edit the real file, run a verification command, report the diff", // optional
 *     maxRounds: 2,                 // optional, default 2, clamped 1..6
 *     scoutModel:   "ls99-models/qwen3.6-27b-mlx",  // optional, default = inherit parent
 *     plannerModel: "ls99-models/glm-5.2-mxfp4",    // optional, default = inherit parent
 *     reviewerModel:"ls99-models/qwen3.6-27b-mlx",  // optional, default = inherit parent
 *     workerModel:  "openai-codex/gpt-5.6-sol",      // optional, default = Codex 5.6 Sol
 *   } })
 *
 * Returns { phases, rounds, accepted, plan, finalOutput, recon, history }.
 * Each phase is wrapped in `cache()` so a run with `args._journal` replays
 * completed phases and resumes at the first incomplete one.
 */

const task = String(args.task ?? "").trim();
if (!task) throw new Error("implement: args.task is required (the work to implement).");

const questions = Array.isArray(args.questions) ? args.questions.map(String).map((s) => s.trim()).filter(Boolean) : [];
if (questions.length > 16) throw new Error("implement: args.questions supports at most 16 recon questions.");

const rubric = String(args.rubric ?? "The implementation must fully and correctly satisfy the task, edit the real files, run a verification command, and report what changed.").trim();
const maxRounds = Math.max(1, Math.min(6, Number(args.maxRounds ?? 2) || 2));

// Per-stage model selection. Each defaults to undefined, which means that
// stage inherits the parent session model (the residency-preserving default:
// on a resident local model those phases cost ~0 swap). Set any of them to a
// `provider/model` id to route that stage elsewhere — e.g. offload read-only
// recon/review to a free local gateway model when the parent is a metered
// cloud model. The worker defaults to Codex 5.6 Sol via the OpenAI Codex
// subscription provider (auto-routed through ~/.pi/agent, no agentDir needed).
const modelFor = (stage) => {
  const raw = String(args[`${stage}Model`] ?? "").trim();
  return raw || undefined;
};
const scoutModel = modelFor("scout");
const plannerModel = modelFor("planner");
const reviewerModel = modelFor("reviewer");
const workerModel = modelFor("worker") ?? "openai-codex/gpt-5.6-sol";

const reviewerAgent = "reviewer";
const plannerAgent = "planner";
const scoutAgent = "scout";
const workerAgent = "worker";

const recon = [];
const history = [];
let plan = "";
let accepted = false;
let finalOutput = "";

// --- Phase 1: recon (optional, parallel, read-only) -------------------------
if (questions.length) {
  phase(`recon: ${questions.length} question${questions.length > 1 ? "s" : ""}`);
  const findings = await cache(
    "recon",
    () =>
      parallel(
        questions.map((q) => () =>
          agent(q, { agent: scoutAgent, model: scoutModel, onProgress: (t) => log(`scout streamed ${t.length} chars`) }),
        ),
      ),
  );
  recon.push(...findings);
  log(`recon: ${findings.length} scout report${findings.length > 1 ? "s" : ""} gathered`);
} else {
  phase("recon: skipped (no questions)");
  log("recon: no questions supplied — proceeding directly to plan");
}

// --- Phase 2: plan (read-only) ----------------------------------------------
phase("plan");
const reconBlock = recon.length
  ? recon.map((text, i) => `### Recon ${i + 1}: ${questions[i] ?? "(scout)"}\n${text}`).join("\n\n---\n\n") + "\n\n"
  : "";
plan = await cache(
  "plan",
  () =>
    agent(
      `Turn the following task${recon.length ? " plus reconnaissance" : ""} into a concise, ordered implementation plan. ` +
        `Call out the key files, recommended edit points, verification commands, and risks.\n\n` +
        `## Task\n${task}\n\n${reconBlock}` +
        `## Output\nProduce the plan only; do not edit files.`,
      { agent: plannerAgent, model: plannerModel },
    ),
);
log("plan: implementation plan produced");

// --- Phase 3 + 4: build ↔ review loop --------------------------------------
let workerPrompt =
  `## Task\n${task}\n\n## Plan\n${plan}\n\n` +
  `Implement the plan. Make focused, minimal changes following existing project patterns. ` +
  `Run targeted verification (tests/typecheck/lint/smoke) when feasible. ` +
  `Report exactly what changed and what was verified. ` +
  `Do not push, deploy, merge, or perform irreversible/external actions.`;

for (let round = 1; round <= maxRounds; round++) {
  phase(`build round ${round}/${maxRounds}`);
  const buildKey = `build-${round}`;
  const output = await cache(buildKey, () =>
    agent(workerPrompt, { agent: workerAgent, model: workerModel }),
  );
  finalOutput = output;

  phase(`review round ${round}/${maxRounds}`);
  const verdictRaw = await cache(
    `review-${round}`,
    () =>
      agent(
        `You are supervising a worker agent. Judge ONLY whether its latest build satisfies the rubric.\n\n` +
          `## Rubric\n${rubric}\n\n` +
          `## Original task\n${task}\n\n` +
          `## Plan the worker was given\n${plan}\n\n` +
          `## Worker build (round ${round})\n${output}\n\n` +
          `Reply on the FIRST line with exactly one of:\n` +
          `  ACCEPT\n` +
          `  REVISE: <a single concrete instruction telling the worker what to fix or do next>\n` +
          `Keep any explanation to later lines. Be strict: only ACCEPT if the rubric is fully met.`,
        { agent: reviewerAgent, model: reviewerModel },
      ),
  );

  const verdict = parseVerdict(verdictRaw);
  history.push({ round, verdict: verdict.kind, instruction: verdict.instruction ?? null });
  log(`review round ${round}: ${verdict.kind}${verdict.instruction ? ` — ${truncate(verdict.instruction, 80)}` : ""}`);

  if (verdict.kind === "ACCEPT") {
    accepted = true;
    break;
  }

  // REVISE: steer the next build round. Keep the task + plan in view while
  // addressing the reviewer's redirect.
  workerPrompt =
    `## Task\n${task}\n\n## Plan\n${plan}\n\n` +
    `## Reviewer feedback on your previous build (address this specifically)\n${verdict.instruction}\n\n` +
    `Re-attempt the implementation incorporating the feedback. Run verification and report what changed.`;
}

phase(accepted ? "accepted" : "max rounds reached");

return {
  phases: ["recon", "plan", "build", "review"],
  rounds: history.length,
  accepted,
  plan,
  finalOutput,
  recon: recon.map((text, i) => ({ question: questions[i] ?? "(scout)", preview: truncate(text, 400) })),
  history,
};

function parseVerdict(text) {
  const normalized = String(text ?? "").trim();
  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  // Protocol: the FIRST line is the verdict. Honor a first-line ACCEPT even when
  // the reviewer adds explanation on later lines. This is still strict: the
  // verdict word must occupy the whole first line (no prefix/suffix prose).
  if (/^accept$/i.test(firstLine)) return { kind: "ACCEPT" };
  const m = firstLine.match(/^revise\s*:\s*(.+)$/i);
  if (m && m[1].trim()) return { kind: "REVISE", instruction: m[1].trim() };
  // Whole-reply single-word ACCEPT (legacy/no-explanation form).
  if (/^accept$/i.test(normalized)) return { kind: "ACCEPT" };
  // Malformed verdict: never silently accept. Steer using the whole reply.
  const fallback = String(text ?? "").trim();
  return { kind: "REVISE", instruction: fallback || "Re-attempt the build and satisfy the rubric." };
}

function truncate(s, n) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}
