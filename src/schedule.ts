/** When a scheduled check may start; pure so it can be tested. */

export interface ScheduleState {
	intervalHours: number;
	quietMinutes: number;
	/** Start of the last successful run. */
	lastRunAt: number;
	/** Start of the last run, successful or not. */
	lastAttemptAt: number;
	/** Last vault change (or plugin load). */
	lastChangeAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** After a failed run, wait at least this long (or one interval if shorter). */
export const RETRY_MS = HOUR;

export function isRunDue(state: ScheduleState, now: number): boolean {
	const interval = state.intervalHours * HOUR;
	const due = now - state.lastRunAt >= interval;
	const backoff = now - state.lastAttemptAt >= Math.min(interval, RETRY_MS);
	const quiet = now - state.lastChangeAt >= state.quietMinutes * MINUTE;
	return due && backoff && quiet;
}
