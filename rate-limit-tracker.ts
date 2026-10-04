// rate-limit-tracker.ts — ~800 chars
interface RateLimitState {
  dailyRequests: Record<string, number>; // model → request count
  resetTime: Record<string, number>; // model → unix timestamp (ms)
}

export class RateLimitTracker {
  private state: RateLimitState = {
    dailyRequests: {},
    resetTime: {},
  };

  canRequest(model: string, limit: number): boolean {
    const now = Date.now();
    const resetAt = this.state.resetTime[model] ?? 0;

    if (now >= resetAt) {
      // Day boundary crossed → reset
      this.state.dailyRequests[model] = 0;
      this.state.resetTime[model] = now + 86400000; // +1 day
    }

    const current = this.state.dailyRequests[model] ?? 0;
    return current < limit;
  }

  recordRequest(model: string) {
    this.state.dailyRequests[model] = (this.state.dailyRequests[model] ?? 0) +
      1;
  }

  remaining(model: string, limit: number): number {
    return Math.max(0, limit - (this.state.dailyRequests[model] ?? 0));
  }
}