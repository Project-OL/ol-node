/** Lightweight auth metrics (replace with Prometheus when wired). */
export const authSessionMetrics = {
  sessionCreateCount: 0,
  refreshSuccess: 0,
  refreshFail: 0,
  refreshConflict: 0,
  revokeCount: 0,
  loginLatencyMs: [] as number[],
  refreshLatencyMs: [] as number[],
  authRedisMs: [] as number[],
  authDbMs: [] as number[],

  bumpSessionCreate(): void {
    this.sessionCreateCount += 1
  },
  bumpRevoke(): void {
    this.revokeCount += 1
  },
  recordLoginMs(ms: number): void {
    this.loginLatencyMs.push(ms)
    if (this.loginLatencyMs.length > 500) this.loginLatencyMs.shift()
  },
  recordRefreshMs(ms: number): void {
    this.refreshLatencyMs.push(ms)
    if (this.refreshLatencyMs.length > 500) this.refreshLatencyMs.shift()
  },
  recordAuthRedisMs(ms: number): void {
    this.authRedisMs.push(ms)
    if (this.authRedisMs.length > 500) this.authRedisMs.shift()
  },
  recordAuthDbMs(ms: number): void {
    this.authDbMs.push(ms)
    if (this.authDbMs.length > 500) this.authDbMs.shift()
  },
}
