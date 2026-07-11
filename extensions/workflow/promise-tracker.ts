export interface PromiseDrainResult {
	failed: boolean;
	error?: unknown;
}

/** Tracks promises that callers may intentionally not await and remembers
 * failures even when a promise settles before the final drain begins. */
export class PromiseTracker<T> {
	private readonly pending = new Set<Promise<T>>();
	private hasError = false;
	private firstError: unknown;

	private rememberError(error: unknown): void {
		if (this.hasError) return;
		this.hasError = true;
		this.firstError = error;
	}

	track(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		void promise.then(
			() => this.pending.delete(promise),
			(error) => {
				this.rememberError(error);
				this.pending.delete(promise);
			},
		);
		return promise;
	}

	async drain(): Promise<PromiseDrainResult> {
		while (this.pending.size > 0) {
			const settled = await Promise.allSettled(Array.from(this.pending));
			for (const result of settled) {
				if (result.status === "rejected") this.rememberError(result.reason);
			}
		}
		return { failed: this.hasError, error: this.firstError };
	}
}
