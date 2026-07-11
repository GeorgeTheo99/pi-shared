/**
 * Example workflow: fan out read-only reconnaissance across N independent
 * questions in parallel, then have a planner synthesize them.
 *
 * Run from Pi:
 *   workflow({ name: "research-fanout", args: { questions: [
 *     "How does spawn_subagent route tasks?",
 *     "Where is the job store persisted?",
 *   ] } })
 *
 * Each question runs as a `scout` subagent (read-only). The planner then
 * turns the gathered findings into a single implementation plan.
 */
phase("scout");

const questions = Array.isArray(args.questions) && args.questions.length
  ? args.questions.map(String)
  : ["Summarize the purpose of this repository."];

if (questions.length > 16) throw new Error("research-fanout supports at most 16 questions");

const findings = await parallel(
  questions.map((q) => () => agent(q, { agent: "scout" })),
);

phase("plan");

const bundled = findings
  .map((text, i) => `### Question ${i + 1}\n${questions[i]}\n\n### Findings\n${text}`)
  .join("\n\n---\n\n");

const plan = await agent(
  `Synthesize the following reconnaissance findings into a concise implementation plan. ` +
    `Highlight the key files, recommended edit points, verification commands, and risks.\n\n${bundled}`,
  { agent: "planner" },
);

return { questions, plan };
