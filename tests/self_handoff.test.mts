import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildKickoffPrompt,
	collectTransferState,
	GOAL_STATE_TYPE,
	handoffBashOutput,
	inspectChildHandoffOrientation,
	inspectOrientationOutcome,
	inspectSelfHandoffRecords,
	isOrientationKickoff,
	latestCustomEntryData,
	latestSelfHandoffRecord,
	makeHandoffRecord,
	orientationKickoffHash,
	pausedGoalAfterHandoffFailure,
	redactSensitiveText,
	reduceSelfHandoffRequest,
	SELF_HANDOFF_STATE_TYPE,
	type SelfHandoffRequest,
	type SessionEntryLike,
	transferredGoal,
	transferringGoal,
	validateGoalTransfer,
	WORK_PLAN_STATE_TYPE,
	withSelfHandoffLock,
} from "../extensions/self-handoff/state.ts";

function custom(customType: string, data: unknown): SessionEntryLike {
	return { type: "custom", customType, data };
}

function request(
	overrides: Partial<SelfHandoffRequest> = {},
): SelfHandoffRequest {
	return {
		version: 1,
		id: "handoff-123",
		createdAt: 1,
		originSessionId: "session-parent",
		originSessionFile: "/tmp/parent.jsonl",
		contextNonce: "nonce-1234567890abcdef",
		goalTransferred: true,
		goalId: "goal-1",
		workPlanTransferred: true,
		...overrides,
	};
}

test("latest custom entry treats a later null as authoritative", () => {
	const entries = [
		custom(GOAL_STATE_TYPE, { status: "active" }),
		custom(GOAL_STATE_TYPE, null),
	];
	assert.equal(latestCustomEntryData(entries, GOAL_STATE_TYPE), null);
	assert.deepEqual(collectTransferState(entries), {});
});

test("collectTransferState copies only the latest active goal and non-empty plan", () => {
	const originalPlan = {
		version: 1,
		nextId: 2,
		activeId: 1,
		createdAt: 1,
		updatedAt: 1,
		items: [
			{
				id: 1,
				title: "Implement",
				status: "active",
				blockedBy: [],
				createdAt: 1,
				updatedAt: 1,
				runStartedAt: 123,
				activeMs: 50,
			},
		],
	};
	const entries = [
		custom(GOAL_STATE_TYPE, { id: "old", status: "complete" }),
		custom(GOAL_STATE_TYPE, {
			id: "goal-1",
			objective: "Implement",
			status: "active",
			createdAt: 1,
			updatedAt: 1,
			turnsCompleted: 4,
			maxTurns: 10,
			progressLog: [],
		}),
		custom(WORK_PLAN_STATE_TYPE, originalPlan),
	];
	const transfer = collectTransferState(entries);
	assert.equal(transfer.goal?.id, "goal-1");
	assert.equal(transfer.goal?.turnsCompleted, 4);
	assert.equal(transfer.workPlan?.items.length, 1);
	assert.equal(transfer.workPlan?.items[0].runStartedAt, undefined);
	assert.equal(
		originalPlan.items[0].runStartedAt,
		123,
		"selection must not mutate parent state",
	);
});

test("collectTransferState does not resurrect paused goals or cleared plans", () => {
	const entries = [
		custom(GOAL_STATE_TYPE, {
			id: "goal-1",
			objective: "Paused",
			status: "active",
			createdAt: 1,
			updatedAt: 1,
			turnsCompleted: 1,
			maxTurns: 5,
			progressLog: [],
		}),
		custom(GOAL_STATE_TYPE, {
			id: "goal-1",
			objective: "Paused",
			status: "paused",
			createdAt: 1,
			updatedAt: 1,
			turnsCompleted: 1,
			maxTurns: 5,
			progressLog: [],
		}),
		custom(WORK_PLAN_STATE_TYPE, {
			version: 1,
			items: [
				{
					id: 1,
					title: "Old",
					status: "todo",
					blockedBy: [],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			nextId: 2,
			createdAt: 1,
			updatedAt: 1,
		}),
		custom(WORK_PLAN_STATE_TYPE, {
			version: 1,
			items: [],
			nextId: 1,
			createdAt: 1,
			updatedAt: 1,
		}),
	];
	assert.deepEqual(collectTransferState(entries), {});
});

test("malformed goal retry metadata is not treated as transferable state", () => {
	const entries = [
		custom(GOAL_STATE_TYPE, {
			id: "goal-1",
			objective: "Malformed",
			status: "active",
			createdAt: 1,
			updatedAt: 1,
			turnsCompleted: 1,
			maxTurns: 5,
			progressLog: [],
			emptyStopStreak: "2",
		}),
	];
	assert.deepEqual(collectTransferState(entries), {});
});

test("malformed work-plan items are not treated as transferable state", () => {
	const entries = [
		custom(WORK_PLAN_STATE_TYPE, {
			version: 1,
			items: [null],
			nextId: 2,
			createdAt: 1,
			updatedAt: 1,
		}),
	];
	assert.deepEqual(collectTransferState(entries), {});

	const inconsistentIdentity = [
		custom(WORK_PLAN_STATE_TYPE, {
			version: 1,
			items: [
				{
					id: 1,
					title: "Active",
					status: "active",
					blockedBy: [],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			nextId: 1,
			createdAt: 1,
			updatedAt: 1,
		}),
	];
	assert.deepEqual(collectTransferState(inconsistentIdentity), {});
});

test("active goal transfer preserves identity and budget while terminalizing the parent", () => {
	const active = {
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		turnsCompleted: 7,
		maxTurns: 12,
		progressLog: [],
	};
	assert.equal(validateGoalTransfer(active), undefined);
	const transferring = transferringGoal(active, "handoff-123");
	assert.equal(transferring.status, "transferring");
	assert.equal(transferring.id, "goal-1");
	assert.equal(transferring.turnsCompleted, 7);
	assert.equal(transferring.maxTurns, 12);
	assert.equal(transferring.handoffId, "handoff-123");

	const transferred = transferredGoal(
		transferring,
		"handoff-123",
		"/tmp/child.jsonl",
	);
	assert.equal(transferred.status, "transferred");
	assert.equal(transferred.id, "goal-1");
	assert.equal(transferred.turnsCompleted, 7);
	assert.equal(transferred.maxTurns, 12);
	assert.equal(transferred.handoffTargetSessionFile, "/tmp/child.jsonl");
	assert.ok(Array.isArray(transferred.progressLog));

	const paused = pausedGoalAfterHandoffFailure(active, "handoff-123");
	assert.equal(paused.status, "paused");
	assert.equal(paused.id, "goal-1");
	assert.equal(paused.turnsCompleted, 7);
	assert.equal(paused.maxTurns, 12);
	assert.equal(paused.handoffId, "handoff-123");
});

test("invalid or exhausted active goal budgets block transfer", () => {
	const base = {
		id: "goal-1",
		objective: "Budget",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		turnsCompleted: 1,
		maxTurns: 5,
		progressLog: [],
	};
	assert.match(
		validateGoalTransfer({ ...base, turnsCompleted: Number.NaN }) ?? "",
		/invalid turn-budget/,
	);
	assert.match(
		validateGoalTransfer({ ...base, turnsCompleted: 5, maxTurns: 5 }) ?? "",
		/no remaining turn budget/,
	);
});

test("kickoff prompt labels context and requires a waiting orientation", () => {
	const prompt = buildKickoffPrompt(
		"## Exact next action\nRun the focused test.",
		request(),
	);
	assert.match(prompt, /explicit user-requested self-handoff/);
	assert.match(prompt, /SELF-HANDOFF-nonce-1234567890abcdef/);
	assert.match(prompt, /Run the focused test/);
	assert.match(prompt, /remaining turn budget were transferred/);
	assert.match(prompt, /non-empty work plan was transferred/);
	assert.match(prompt, /## Handoff summary/);
	assert.match(prompt, /numbered "## Proposed next steps" list/);
	assert.match(prompt, /reply "Proceed" or provide adjustments/);
	assert.match(prompt, /Do not call tools/);
	assert.match(prompt, /wait.*new explicit user message/is);
	assert.match(prompt, /do not create a duplicate goal/);
	assert.doesNotMatch(prompt, /Continue immediately/);
});

test("orientation completion is bound to the exact kickoff and required response", () => {
	const draftRequest = request();
	const kickoff = buildKickoffPrompt("Continue the focused fix.", draftRequest);
	const expected = request({ kickoffHash: orientationKickoffHash(kickoff) });
	assert.equal(buildKickoffPrompt("Continue the focused fix.", expected), kickoff);
	assert.equal(isOrientationKickoff(kickoff, expected), true);
	assert.equal(isOrientationKickoff(`${kickoff}\nAltered`, expected), false);
	const delimiter = `SELF-HANDOFF-${expected.contextNonce}`;
	assert.equal(
		isOrientationKickoff(
			`--- END ${delimiter} ---\n--- BEGIN ${delimiter} ---`,
			request(),
		),
		false,
	);
	const userEntry: SessionEntryLike = {
		type: "message",
		message: { role: "user", content: kickoff },
	};
	const successEntry: SessionEntryLike = {
		type: "message",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: "## Handoff summary\nThe fix is ready to continue.\n\n## Proposed next steps\n1. Re-ground the failing test.\n2. Apply and verify the fix.\n\nReply Proceed or provide adjustments.",
				},
			],
		},
	};
	assert.equal(
		inspectOrientationOutcome([userEntry, successEntry], expected).status,
		"success",
	);

	const errorEntry: SessionEntryLike = {
		type: "message",
		message: { role: "assistant", stopReason: "error", content: [] },
	};
	const providerError = inspectOrientationOutcome(
		[userEntry, errorEntry],
		expected,
	);
	assert.equal(providerError.status, "incomplete");
	if (providerError.status === "incomplete") {
		assert.match(providerError.reason, /ended with error/);
		assert.equal(providerError.kickoff, kickoff);
	}

	const malformedEntry: SessionEntryLike = {
		type: "message",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "I will begin now." }],
		},
	};
	const malformed = inspectOrientationOutcome(
		[userEntry, malformedEntry],
		expected,
	);
	assert.equal(malformed.status, "incomplete");
	if (malformed.status === "incomplete") {
		assert.match(malformed.reason, /required summary/);
	}

	const queuedUser: SessionEntryLike = {
		type: "message",
		message: { role: "user", content: "Proceed" },
	};
	const unrelated = inspectOrientationOutcome(
		[userEntry, successEntry, queuedUser, successEntry],
		expected,
	);
	assert.equal(unrelated.status, "incomplete");
	if (unrelated.status === "incomplete") {
		assert.match(unrelated.reason, /unexpected user message/);
	}
});

test("exact child state gates orientation and waiting until explicit release", () => {
	const expected = request();
	const received = makeHandoffRecord(expected, "received", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const receivedEntry = custom(SELF_HANDOFF_STATE_TYPE, received);
	const pending = inspectChildHandoffOrientation(
		[receivedEntry],
		[receivedEntry],
		"child-session",
		"/tmp/child.jsonl",
		"goal-1",
	);
	assert.equal(pending.status, "pending");
	if (pending.status === "pending") {
		assert.equal(pending.phase, "orienting");
		assert.equal(pending.record.request.id, received.request.id);
		assert.equal(pending.record.targetSessionFile, "/tmp/child.jsonl");
	}
	assert.equal(
		inspectChildHandoffOrientation(
			[receivedEntry],
			[receivedEntry],
			"child-session",
			"/tmp/child.jsonl",
			"other-goal",
		).status,
		"none",
	);
	const preAuditBranch = inspectChildHandoffOrientation(
		[receivedEntry],
		[],
		"child-session",
		"/tmp/child.jsonl",
		"goal-1",
	);
	assert.equal(preAuditBranch.status, "invalid");
	if (preAuditBranch.status === "invalid") {
		assert.match(preAuditBranch.reason, /predates the pending self-handoff audit/);
	}

	const awaitingEntry = custom(
		SELF_HANDOFF_STATE_TYPE,
		makeHandoffRecord(expected, "awaiting_user", {
			targetSessionFile: "/tmp/child.jsonl",
			targetSessionId: "child-session",
		}),
	);
	const waiting = inspectChildHandoffOrientation(
		[receivedEntry, awaitingEntry],
		[receivedEntry, awaitingEntry],
		"child-session",
		"/tmp/child.jsonl",
		"goal-1",
	);
	assert.equal(waiting.status, "pending");
	if (waiting.status === "pending") {
		assert.equal(waiting.phase, "awaiting_user");
	}
	const historicalWaiting = inspectChildHandoffOrientation(
		[receivedEntry, awaitingEntry],
		[receivedEntry],
		"child-session",
		"/tmp/child.jsonl",
		"goal-1",
	);
	assert.equal(historicalWaiting.status, "pending");
	if (historicalWaiting.status === "pending") {
		assert.equal(
			historicalWaiting.phase,
			"awaiting_user",
			"session-wide waiting state must dominate a historical received branch",
		);
	}

	const transferredEntry = custom(
		SELF_HANDOFF_STATE_TYPE,
		makeHandoffRecord(expected, "transferred", {
			targetSessionFile: "/tmp/child.jsonl",
			targetSessionId: "child-session",
		}),
	);
	assert.equal(
		inspectChildHandoffOrientation(
			[receivedEntry, awaitingEntry, transferredEntry],
			[receivedEntry, awaitingEntry],
			"child-session",
			"/tmp/child.jsonl",
			"goal-1",
		).status,
		"none",
		"session-wide transferred state must release a historical waiting branch",
	);
});

test("malformed child audit fails the orientation gate closed", () => {
	const malformed = custom(SELF_HANDOFF_STATE_TYPE, {
		version: 1,
		request: null,
	});
	const state = inspectChildHandoffOrientation(
		[malformed],
		[malformed],
		"child-session",
		"/tmp/child.jsonl",
	);
	assert.equal(state.status, "invalid");
	if (state.status === "invalid") assert.match(state.reason, /malformed/);
});

test("hashed received records persist the exact retry kickoff", () => {
	const draft = request();
	const kickoff = buildKickoffPrompt("Continue safely.", draft);
	const hashed = request({ kickoffHash: orientationKickoffHash(kickoff) });
	const missing = makeHandoffRecord(hashed, "received", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	assert.equal(
		latestSelfHandoffRecord([custom(SELF_HANDOFF_STATE_TYPE, missing)]),
		undefined,
	);
	const exact = makeHandoffRecord(hashed, "received", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
		kickoff,
		retryAllowed: true,
	});
	assert.equal(
		latestSelfHandoffRecord([custom(SELF_HANDOFF_STATE_TYPE, exact)])?.kickoff,
		kickoff,
	);
});

test("handoff audit records round-trip through custom entries", () => {
	const record = makeHandoffRecord(request(), "child_created", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const latest = latestSelfHandoffRecord([
		custom(SELF_HANDOFF_STATE_TYPE, record),
	]);
	assert.equal(latest?.request.id, "handoff-123");
	assert.equal(latest?.status, "child_created");
	assert.equal(latest?.targetSessionFile, "/tmp/child.jsonl");
	assert.equal(latest?.targetSessionId, "child-session");
});

test("session-wide handoff audit preserves later terminal records and flags malformed entries", () => {
	const child = makeHandoffRecord(request(), "child_created", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const transferred = makeHandoffRecord(request(), "transferred", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const audit = inspectSelfHandoffRecords([
		custom(SELF_HANDOFF_STATE_TYPE, child),
		custom(SELF_HANDOFF_STATE_TYPE, transferred),
		custom(SELF_HANDOFF_STATE_TYPE, { version: 1, request: null }),
	]);
	assert.equal(audit.records.length, 2);
	assert.equal(audit.records.at(-1)?.status, "transferred");
	assert.equal(audit.malformed, true);
});

test("per-request reduction rejects identity conflicts and terminal regressions", () => {
	const expected = request();
	const received = makeHandoffRecord(expected, "received", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const awaiting = makeHandoffRecord(expected, "awaiting_user", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	const transferred = makeHandoffRecord(expected, "transferred", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	assert.match(
		reduceSelfHandoffRequest(
			[
				custom(SELF_HANDOFF_STATE_TYPE, received),
				custom(SELF_HANDOFF_STATE_TYPE, transferred),
			],
			expected,
		).conflict ?? "",
		/received -> transferred/,
	);
	const transferredAfterWaiting = makeHandoffRecord(expected, "transferred", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	assert.equal(
		reduceSelfHandoffRequest(
			[
				custom(SELF_HANDOFF_STATE_TYPE, received),
				custom(SELF_HANDOFF_STATE_TYPE, awaiting),
				custom(SELF_HANDOFF_STATE_TYPE, transferredAfterWaiting),
			],
			expected,
		).record?.status,
		"transferred",
	);

	const regressed = reduceSelfHandoffRequest(
		[
			custom(SELF_HANDOFF_STATE_TYPE, received),
			custom(SELF_HANDOFF_STATE_TYPE, awaiting),
			custom(SELF_HANDOFF_STATE_TYPE, transferredAfterWaiting),
			custom(
				SELF_HANDOFF_STATE_TYPE,
				makeHandoffRecord(expected, "failed", {
					targetSessionFile: "/tmp/child.jsonl",
					targetSessionId: "child-session",
				}),
			),
		],
		expected,
	);
	assert.match(regressed.conflict ?? "", /transferred -> failed/);

	const missingTarget = reduceSelfHandoffRequest(
		[
			custom(SELF_HANDOFF_STATE_TYPE, received),
			custom(SELF_HANDOFF_STATE_TYPE, makeHandoffRecord(expected, "failed")),
		],
		expected,
	);
	assert.match(missingTarget.conflict ?? "", /child identity disappeared/);

	const conflictingRequest = request({ contextNonce: "different-1234567890" });
	const conflict = reduceSelfHandoffRequest(
		[
			custom(SELF_HANDOFF_STATE_TYPE, received),
			custom(
				SELF_HANDOFF_STATE_TYPE,
				makeHandoffRecord(conflictingRequest, "transferred", {
					targetSessionFile: "/tmp/child.jsonl",
					targetSessionId: "child-session",
				}),
			),
		],
		expected,
	);
	assert.match(conflict.conflict ?? "", /request identity changed/);
});

test("malformed handoff records are rejected before they can name a parent path", () => {
	const malformed = makeHandoffRecord(request(), "received");
	delete (malformed.request as Partial<SelfHandoffRequest>).contextNonce;
	assert.equal(
		latestSelfHandoffRecord([custom(SELF_HANDOFF_STATE_TYPE, malformed)]),
		undefined,
	);
});

test("ownership lock serializes parent finalization and reclaim", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-handoff-lock-"));
	const sessionFile = join(directory, "parent.jsonl");
	try {
		withSelfHandoffLock(sessionFile, () => {
			assert.throws(
				() => withSelfHandoffLock(sessionFile, () => undefined),
				/ownership update is in progress/,
			);
		});
		assert.equal(existsSync(`${sessionFile}.self-handoff.lock`), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("shell output excluded by stock Pi never reaches handoff generation", () => {
	const sentinel = "npm_bare_secret_that_redaction_does_not_recognize";
	assert.equal(
		handoffBashOutput({ output: sentinel, excludeFromContext: true }),
		undefined,
	);
	assert.equal(handoffBashOutput({ output: `  ${sentinel}  ` }), sentinel);
});

test("common credentials are redacted before generation or persistence", () => {
	const value = redactSensitiveText(
		'{"Authorization":"Bearer top secret token","password":"hunter two","AccessKeyId":"AKIAABCDEFGHIJKLMNOP","SecretAccessKey":"aws secret with spaces","SessionToken":"sts token with spaces"} AWS_SECRET_ACCESS_KEY=aws-secret api_key=sk-1234567890abcdefghijkl MY_SERVICE_TOKEN=generic-token https://alice:password@example.com glpat-1234567890abcdef npm_1234567890abcdefghijkl eyJabcdefgh.eyJijklmnop.qrstuvwxyz',
	);
	assert.doesNotMatch(
		value,
		/top secret token|hunter two|AKIAABCDEFGHIJKLMNOP|aws secret with spaces|sts token with spaces|aws-secret|sk-1234567890abcdefghijkl|generic-token|alice:password|glpat-1234567890abcdef|npm_1234567890abcdefghijkl|eyJabcdefgh/,
	);
	assert.match(value, /\[REDACTED/);
});

test("implementation is a stock command with a settled orientation gate", async () => {
	const indexUrl = new URL(
		"../extensions/self-handoff/index.ts",
		import.meta.url,
	);
	const goalUrl = new URL("../extensions/goal/index.ts", import.meta.url);
	const workPlanUrl = new URL(
		"../extensions/work-plan/index.ts",
		import.meta.url,
	);
	const [source, goalSource, workPlanSource] = await Promise.all([
		readFile(indexUrl, "utf8"),
		readFile(goalUrl, "utf8"),
		readFile(workPlanUrl, "utf8"),
	]);
	assert.match(source, /registerCommand\("self-handoff"/);
	assert.match(source, /ctx\.mode !== "tui"/);
	assert.match(source, /requires an existing persisted session/);
	assert.match(source, /rawGoalState !== null/);
	assert.match(source, /--no-session/);
	assert.match(source, /ctx\.ui\.editor\(/);
	assert.doesNotMatch(source, /registerTool\s*\(/);
	assert.doesNotMatch(source, /queueExtensionCommand/);
	assert.match(source, /ctx\.newSession\s*\(/);
	assert.match(source, /setup:/);
	assert.match(source, /withSession:/);
	assert.match(source, /pi\.on\("input"/);
	assert.match(source, /orientation\.phase === "orienting"/);
	assert.match(source, /event\.source === "extension"/);
	assert.match(source, /orientation\.record\.retryAllowed === true/);
	assert.match(source, /event\.images\?\.length/);
	assert.match(source, /Orientation kickoff retries cannot include images/);
	assert.match(source, /pendingReleaseRequestId/);
	assert.match(source, /makeHandoffRecord\([^)]*"transferred"/s);
	assert.match(source, /pi\.on\("tool_call"/);
	assert.match(source, /Self-handoff orientation is read-only/);
	assert.match(source, /pi\.on\("agent_settled"/);
	assert.match(source, /if \(!ctx\.isIdle\(\)\) return/);
	assert.match(source, /inspectOrientationOutcome\(/);
	assert.doesNotMatch(source, /pi\.on\("agent_end"/);

	const agentEnd = goalSource.indexOf('pi.on("agent_end"');
	const orientationGuard = goalSource.indexOf(
		"inspectChildHandoffOrientation(",
		agentEnd,
	);
	const turnIncrement = goalSource.indexOf("goal.turnsCompleted += 1", agentEnd);
	assert.ok(agentEnd >= 0);
	assert.ok(orientationGuard > agentEnd);
	assert.ok(turnIncrement > orientationGuard);
	assert.match(
		goalSource.slice(orientationGuard, turnIncrement),
		/orientation\.status !== "none"\) return/,
	);
	assert.match(goalSource, /Goal changes are held until the self-handoff/);
	assert.match(workPlanSource, /if \(selfHandoffPending\(ctx\)\) return/);
	assert.match(
		workPlanSource,
		/Work-plan changes are held until the self-handoff/,
	);
});
