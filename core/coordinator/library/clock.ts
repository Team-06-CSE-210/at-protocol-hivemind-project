// Time for the coordinator: the current time and timers for deadlines.
// The system clock runs in production; the manual clock lets tests jump to a deadline instead of
// waiting for it.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Clock
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface Clock {
	now(): Date;
	// Call `callback` at `at` (right away if that time has passed); returns a function that cancels it
	setTimer(at: Date, callback: () => void): () => void;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// System Clock
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Longest delay setTimeout accepts: 2^31 - 1 ms, about 24.8 days (Node.js timers documentation)
const MAX_TIMEOUT_MS = 2_147_483_647;

export const systemClock: Clock = {
	now: () => new Date(),
	setTimer(at, callback) {
		let handle: NodeJS.Timeout;
		// Deadlines further away than setTimeout allows are re-armed in steps
		const arm = () => {
			const remainingMs = at.getTime() - Date.now();
			if (remainingMs > MAX_TIMEOUT_MS) {
				handle = setTimeout(arm, MAX_TIMEOUT_MS);
				return;
			}
			handle = setTimeout(callback, Math.max(0, remainingMs));
		};
		arm();
		return () => clearTimeout(handle);
	},
};

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Manual Clock
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Time only moves when a test moves it; due timers then run in deadline order. A timer set for a
// moment already reached runs on the next microtask.
export class ManualClock implements Clock {
	private current: Date;
	private readonly timers = new Map<
		number,
		{ at: number; callback: () => void }
	>();
	private nextTimerId = 0;

	constructor(start: Date) {
		this.current = new Date(start);
	}

	now(): Date {
		return new Date(this.current);
	}

	setTimer(at: Date, callback: () => void): () => void {
		const timerId = this.nextTimerId++;
		this.timers.set(timerId, { at: at.getTime(), callback });
		// A deadline already reached fires right away (on the next microtask), as with the system
		// clock, instead of waiting for the next advance
		if (at.getTime() <= this.current.getTime()) {
			queueMicrotask(() => {
				if (this.timers.delete(timerId)) {
					callback();
				}
			});
		}
		return () => {
			this.timers.delete(timerId);
		};
	}

	get pendingTimers(): number {
		return this.timers.size;
	}

	advanceBy(durationMs: number): void {
		this.advanceTo(new Date(this.current.getTime() + durationMs));
	}

	advanceTo(time: Date): void {
		// Run the earliest due timer until none is left; a timer may set new ones
		for (;;) {
			const [due] = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= time.getTime())
				.sort(([, first], [, second]) => first.at - second.at);
			if (!due) {
				break;
			}
			const [timerId, timer] = due;
			this.timers.delete(timerId);
			this.current = new Date(Math.max(this.current.getTime(), timer.at));
			timer.callback();
		}
		this.current = new Date(time);
	}
}
