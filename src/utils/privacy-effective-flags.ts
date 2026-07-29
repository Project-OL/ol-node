export type PrivacyRawRow = {
  privacyInvisibleVisitor: boolean
  privacyMysteryLive: boolean
  privacyMysteryRank: boolean
  privacyInvisibleOnline: boolean
  privacyInvisibleOnlineAt?: Date | null
  privacyUpdatedAt?: Date | null
}

export type EffectivePrivacyFlags = {
  invisibleVisitor: boolean
  mysteryInLive: boolean
  mysteryOnRank: boolean
  invisibleOnline: boolean
  /** Frozen last-seen instant while invisible-online is effective; null otherwise. */
  invisibleOnlineLastSeenAt: Date | null
}

const EMPTY_FLAGS: EffectivePrivacyFlags = {
  invisibleVisitor: false,
  mysteryInLive: false,
  mysteryOnRank: false,
  invisibleOnline: false,
  invisibleOnlineLastSeenAt: null,
}

export function buildEffectivePrivacyFlags(
  row: PrivacyRawRow | undefined,
  vipActive: boolean,
): EffectivePrivacyFlags {
  if (!row) return { ...EMPTY_FLAGS }

  const invisibleOnline = row.privacyInvisibleOnline && vipActive
  return {
    invisibleVisitor: row.privacyInvisibleVisitor && vipActive,
    mysteryInLive: row.privacyMysteryLive && vipActive,
    mysteryOnRank: row.privacyMysteryRank && vipActive,
    invisibleOnline,
    invisibleOnlineLastSeenAt: invisibleOnline
      ? (row.privacyInvisibleOnlineAt ?? row.privacyUpdatedAt ?? null)
      : null,
  }
}
