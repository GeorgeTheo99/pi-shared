import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteJson, readJsonFile, withInterprocessLock } from "./file-lock.ts";
import type { SubagentConfig } from "./subagent-config.ts";

interface SchedulerWaiter {
	id: string;
	ownerId: string;
	pid: number;
	requestedAt: number;
	heartbeatAt: number;
	label?: string;
	priority: SchedulerPriority;
	resourceKey?: string;
}

interface SchedulerLease {
	id: string;
	waiterId: string;
	ownerId: string;
	pid: number;
	acquiredAt: number;
	heartbeatAt: number;
	expiresAt: number;
	label?: string;
	priority: SchedulerPriority;
	resourceKey?: string;
}

interface SchedulerState {
	version: 2;
	limit: number;
	resourceLimits: Record<string, number>;
	waiters: SchedulerWaiter[];
	leases: SchedulerLease[];
}

export type SchedulerRunState = "queued" | "running";
export type SchedulerPriority = "foreground" | "background";

export interface SchedulerRunOptions {
	signal?: AbortSignal;
	label?: string;
	priority?: SchedulerPriority;
	resourceKey?: string;
	onState?: (state: SchedulerRunState, queueWaitMs: number) => void;
}

export interface SchedulerLeaseInfo {
	id: string;
	queueWaitMs: number;
}

export class SubagentQueueTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Timed out after ${timeoutMs}ms waiting for a global subagent execution slot.`);
		this.name = "SubagentQueueTimeoutError";
	}
}

export class SubagentFanoutError extends Error {
	constructor(maxOutstanding: number) {
		super(`Subagent execution exceeds the maximum of ${maxOutstanding} outstanding agents for one request.`);
		this.name = "SubagentFanoutError";
	}
}

function abortError(message = "Subagent execution aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			cleanup();
			resolve();
		}
		function onAbort() {
			cleanup();
			reject(abortError());
		}
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

function emptyState(limit: number, resourceLimits: Record<string, number>): SchedulerState {
	return { version: 2, limit, resourceLimits: { ...resourceLimits }, waiters: [], leases: [] };
}

function normalizePriority(value: unknown): SchedulerPriority {
	return value === "background" ? "background" : "foreground";
}

function normalizeResourceKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	return /^[A-Za-z0-9._:-]{1,100}$/.test(key) ? key : undefined;
}

function normalizeResourceLimits(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const limits: Record<string, number> = {};
	for (const [key, limit] of Object.entries(value)) {
		if (/^[A-Za-z0-9._:-]{1,100}$/.test(key) && Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 32) {
			limits[key] = Number(limit);
		}
	}
	return limits;
}

function normalizeState(
	value: Partial<SchedulerState> | undefined,
	limit: number,
	resourceLimits: Record<string, number>,
): SchedulerState {
	return {
		version: 2,
		limit: Number.isInteger(value?.limit) && Number(value?.limit) > 0 ? Number(value?.limit) : limit,
		resourceLimits:
			value?.resourceLimits === undefined
				? { ...resourceLimits }
				: normalizeResourceLimits(value.resourceLimits),
		waiters: Array.isArray(value?.waiters)
			? value.waiters
					.filter((item) => item && typeof item.id === "string")
					.map((item) => ({
						...item,
						priority: normalizePriority(item.priority),
						resourceKey: normalizeResourceKey(item.resourceKey),
					}))
			: [],
		leases: Array.isArray(value?.leases)
			? value.leases
					.filter((item) => item && typeof item.id === "string")
					.map((item) => ({
						...item,
						priority: normalizePriority(item.priority),
						resourceKey: normalizeResourceKey(item.resourceKey),
					}))
			: [],
	};
}

function resourceLimitsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every(([key, limit]) => right[key] === limit)
	);
}

function reconcileLimits(state: SchedulerState, config: SubagentConfig): boolean {
	if (state.waiters.length === 0 && state.leases.length === 0) {
		const changed =
			state.limit !== config.maxConcurrency ||
			!resourceLimitsEqual(state.resourceLimits, config.resourceLimits);
		state.limit = config.maxConcurrency;
		state.resourceLimits = { ...config.resourceLimits };
		return changed;
	}
	let changed = false;
	if (state.limit > config.maxConcurrency) {
		state.limit = config.maxConcurrency;
		changed = true;
	}
	for (const [key, limit] of Object.entries(config.resourceLimits)) {
		if (state.resourceLimits[key] === undefined || state.resourceLimits[key] > limit) {
			state.resourceLimits[key] = limit;
			changed = true;
		}
	}
	return changed;
}

function pruneState(state: SchedulerState, now: number, leaseMs: number): boolean {
	const originalWaiters = state.waiters.length;
	const originalLeases = state.leases.length;
	state.waiters = state.waiters.filter(
		(waiter) => isProcessAlive(waiter.pid) && now - waiter.heartbeatAt <= leaseMs,
	);
	state.leases = state.leases.filter(
		(lease) => isProcessAlive(lease.pid) && lease.expiresAt > now,
	);
	return state.waiters.length !== originalWaiters || state.leases.length !== originalLeases;
}

class HostSubagentScheduler {
	private readonly ownerId = `${process.pid}-${crypto.randomUUID()}`;
	private readonly statePath: string;
	private readonly lockPath: string;
	private readonly config: SubagentConfig;

	constructor(config: SubagentConfig) {
		this.config = config;
		this.statePath = path.join(config.stateDir, "scheduler.json");
		this.lockPath = path.join(config.stateDir, "scheduler.lock");
	}

	private async mutate<T>(
		fn: (state: SchedulerState) => { value: T; changed: boolean },
		signal?: AbortSignal,
	): Promise<T> {
		return withInterprocessLock(
			this.lockPath,
			async () => {
				const state = normalizeState(
					readJsonFile<Partial<SchedulerState>>(
						this.statePath,
						emptyState(this.config.maxConcurrency, this.config.resourceLimits),
					),
					this.config.maxConcurrency,
					this.config.resourceLimits,
				);
				const now = Date.now();
				let changed = pruneState(state, now, this.config.leaseMs);
				changed = reconcileLimits(state, this.config) || changed;
				const result = fn(state);
				if (changed || result.changed) await atomicWriteJson(this.statePath, state);
				return result.value;
			},
			{ signal, timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
		);
	}

	private async removeWaiter(waiterId: string): Promise<void> {
		await this.mutate((state) => {
			const previous = state.waiters.length;
			state.waiters = state.waiters.filter((waiter) => waiter.id !== waiterId);
			return { value: undefined, changed: state.waiters.length !== previous };
		}).catch(() => undefined);
	}

	private async acquire(options: SchedulerRunOptions): Promise<SchedulerLeaseInfo> {
		const waiterId = crypto.randomUUID();
		const requestedAt = Date.now();
		let lastHeartbeat = 0;
		let queuedEmitted = false;

		try {
			while (true) {
				if (options.signal?.aborted) throw abortError();
				const now = Date.now();
				if (now - requestedAt >= this.config.queueTimeoutMs) {
					throw new SubagentQueueTimeoutError(this.config.queueTimeoutMs);
				}

				const lease = await this.mutate<SchedulerLease | undefined>((state) => {
					let changed = false;
					let waiter = state.waiters.find((item) => item.id === waiterId);
					if (!waiter) {
						waiter = {
							id: waiterId,
							ownerId: this.ownerId,
							pid: process.pid,
							requestedAt,
							heartbeatAt: now,
							label: options.label,
							priority: options.priority ?? "foreground",
							resourceKey: normalizeResourceKey(options.resourceKey),
						};
						state.waiters.push(waiter);
						lastHeartbeat = now;
						changed = true;
					} else if (now - lastHeartbeat >= this.config.heartbeatMs) {
						waiter.heartbeatAt = now;
						lastHeartbeat = now;
						changed = true;
					}

					const available = Math.max(0, state.limit - state.leases.length);
					const resourceUsage = new Map<string, number>();
					for (const active of state.leases) {
						if (active.resourceKey) {
							resourceUsage.set(active.resourceKey, (resourceUsage.get(active.resourceKey) ?? 0) + 1);
						}
					}
					const eligible = new Set<string>();
					const sortedWaiters = [...state.waiters].sort((left, right) => {
						const leftRank =
							left.priority === "foreground" || now - left.requestedAt >= this.config.backgroundAgingMs
								? 0
								: 1;
						const rightRank =
							right.priority === "foreground" || now - right.requestedAt >= this.config.backgroundAgingMs
								? 0
								: 1;
						return leftRank - rightRank || left.requestedAt - right.requestedAt || left.id.localeCompare(right.id);
					});
					for (const candidate of sortedWaiters) {
						if (eligible.size >= available) break;
						const resourceLimit = candidate.resourceKey
							? state.resourceLimits[candidate.resourceKey]
							: undefined;
						const inUse = candidate.resourceKey
							? resourceUsage.get(candidate.resourceKey) ?? 0
							: 0;
						if (resourceLimit !== undefined && inUse >= resourceLimit) continue;
						eligible.add(candidate.id);
						if (candidate.resourceKey) {
							resourceUsage.set(candidate.resourceKey, inUse + 1);
						}
					}
					if (!eligible.has(waiterId)) return { value: undefined, changed };

					state.waiters = state.waiters.filter((item) => item.id !== waiterId);
					const acquired: SchedulerLease = {
						id: crypto.randomUUID(),
						waiterId,
						ownerId: this.ownerId,
						pid: process.pid,
						acquiredAt: now,
						heartbeatAt: now,
						expiresAt: now + this.config.leaseMs,
						label: options.label,
						priority: options.priority ?? "foreground",
						resourceKey: normalizeResourceKey(options.resourceKey),
					};
					state.leases.push(acquired);
					return { value: acquired, changed: true };
				}, options.signal);

				if (lease) {
					const queueWaitMs = Date.now() - requestedAt;
					options.onState?.("running", queueWaitMs);
					return { id: lease.id, queueWaitMs };
				}
				if (!queuedEmitted) {
					queuedEmitted = true;
					options.onState?.("queued", Date.now() - requestedAt);
				}
				await delay(250, options.signal);
			}
		} catch (error) {
			await this.removeWaiter(waiterId);
			throw error;
		}
	}

	private startLeaseHeartbeat(leaseId: string): NodeJS.Timeout {
		const timer = setInterval(() => {
			void this.mutate((state) => {
				const lease = state.leases.find((item) => item.id === leaseId && item.ownerId === this.ownerId);
				if (!lease) return { value: undefined, changed: false };
				const now = Date.now();
				lease.heartbeatAt = now;
				lease.expiresAt = now + this.config.leaseMs;
				return { value: undefined, changed: true };
			}).catch(() => undefined);
		}, this.config.heartbeatMs);
		timer.unref?.();
		return timer;
	}

	private async release(leaseId: string): Promise<void> {
		await this.mutate((state) => {
			const previous = state.leases.length;
			state.leases = state.leases.filter(
				(lease) => !(lease.id === leaseId && lease.ownerId === this.ownerId),
			);
			return { value: undefined, changed: state.leases.length !== previous };
		}).catch(() => undefined);
	}

	async run<T>(
		options: SchedulerRunOptions,
		fn: (lease: SchedulerLeaseInfo, signal: AbortSignal | undefined) => Promise<T>,
	): Promise<T> {
		const lease = await this.acquire(options);
		const heartbeat = this.startLeaseHeartbeat(lease.id);
		try {
			if (options.signal?.aborted) throw abortError();
			return await fn(lease, options.signal);
		} finally {
			clearInterval(heartbeat);
			await this.release(lease.id);
		}
	}
}

function combineSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		const listener = () => controller.abort(signal.reason);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			for (const item of listeners) item.signal.removeEventListener("abort", item.listener);
		},
	};
}

const SCHEDULERS_SYMBOL = Symbol.for("pi-shared.subagent-schedulers.v1");

function schedulerMap(): Map<string, HostSubagentScheduler> {
	const root = globalThis as typeof globalThis & { [SCHEDULERS_SYMBOL]?: Map<string, HostSubagentScheduler> };
	if (!root[SCHEDULERS_SYMBOL]) root[SCHEDULERS_SYMBOL] = new Map();
	return root[SCHEDULERS_SYMBOL]!;
}

function getScheduler(config: SubagentConfig): HostSubagentScheduler {
	const key = config.stateDir;
	const schedulers = schedulerMap();
	let scheduler = schedulers.get(key);
	if (!scheduler) {
		scheduler = new HostSubagentScheduler(config);
		schedulers.set(key, scheduler);
	}
	return scheduler;
}

export class SubagentExecutionGroup {
	private readonly controller = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();
	private readonly config: SubagentConfig;
	private readonly label: string;
	private readonly parentSignals: AbortSignal[];
	private readonly defaults: Pick<SchedulerRunOptions, "priority" | "resourceKey">;
	private outstanding = 0;
	private closed = false;

	constructor(
		config: SubagentConfig,
		label: string,
		parentSignals?: AbortSignal | Array<AbortSignal | undefined>,
		defaults: Pick<SchedulerRunOptions, "priority" | "resourceKey"> = {},
	) {
		this.config = config;
		this.label = label;
		this.parentSignals = (Array.isArray(parentSignals) ? parentSignals : [parentSignals]).filter(
			(signal): signal is AbortSignal => Boolean(signal),
		);
		this.defaults = defaults;
	}

	run<T>(
		options: Omit<SchedulerRunOptions, "signal">,
		fn: (lease: SchedulerLeaseInfo, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (this.closed) return Promise.reject(abortError("Subagent execution group is closed."));
		if (this.outstanding >= this.config.maxFanout) {
			return Promise.reject(new SubagentFanoutError(this.config.maxFanout));
		}
		this.outstanding++;
		const combined = combineSignals([...this.parentSignals, this.controller.signal]);
		const promise = getScheduler(this.config)
			.run(
				{ ...this.defaults, ...options, label: options.label ?? this.label, signal: combined.signal },
				(lease) => fn(lease, combined.signal),
			)
			.finally(() => {
				combined.dispose();
				this.outstanding--;
				this.pending.delete(promise);
			});
		this.pending.add(promise);
		return promise;
	}

	cancel(reason?: unknown): void {
		if (!this.controller.signal.aborted) this.controller.abort(reason);
	}

	async drain(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled(Array.from(this.pending));
		}
	}

	async close(reason?: unknown): Promise<void> {
		this.closed = true;
		this.cancel(reason);
		await this.drain();
	}
}

export function createSubagentExecutionGroup(
	config: SubagentConfig,
	label: string,
	parentSignals?: AbortSignal | Array<AbortSignal | undefined>,
	defaults?: Pick<SchedulerRunOptions, "priority" | "resourceKey">,
): SubagentExecutionGroup {
	return new SubagentExecutionGroup(config, label, parentSignals, defaults);
}
