/** In-process counters for /me (replace with Prometheus when wired). */
export const meEndpointMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  profileUpdates: { avatar: 0, name: 0, bio: 0, gender: 0 } as Record<string, number>,
  usernameThrottled: 0,
  bumpProfileField(field: 'avatar' | 'name' | 'bio' | 'gender'): void {
    this.profileUpdates[field] += 1
  },
}
