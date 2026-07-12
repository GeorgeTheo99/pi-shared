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
	inspectSelfHandoffRecords,
	latestCustomEntryData,
	latestSelfHandoffRecord,
	makeHandoffRecord,
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

test("kickoff prompt labels generated context and transferred state", () => {
	const prompt = buildKickoffPrompt(
		"## Exact next action\nRun the focused test.",
		request(),
	);
	assert.match(prompt, /explicit user-requested self-handoff/);
	assert.match(prompt, /SELF-HANDOFF-nonce-1234567890abcdef/);
	assert.match(prompt, /Run the focused test/);
	assert.match(prompt, /remaining turn budget were transferred/);
	assert.match(prompt, /non-empty work plan was transferred/);
	assert.match(prompt, /do not create a duplicate goal/);
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
	const transferred = makeHandoffRecord(expected, "transferred", {
		targetSessionFile: "/tmp/child.jsonl",
		targetSessionId: "child-session",
	});
	assert.equal(
		reduceSelfHandoffRequest(
			[
				custom(SELF_HANDOFF_STATE_TYPE, received),
				custom(SELF_HANDOFF_STATE_TYPE, transferred),
			],
			expected,
		).record?.status,
		"transferred",
	);

	const regressed = reduceSelfHandoffRequest(
		[
			custom(SELF_HANDOFF_STATE_TYPE, received),
			custom(SELF_HANDOFF_STATE_TYPE, transferred),
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

test("implementation is a stock command, not an autonomous tool or custom-core bridge", async () => {
	const indexUrl = new URL(
		"../extensions/self-handoff/index.ts",
		import.meta.url,
	);
	const source = await readFile(indexUrl, "utf8");
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
});
