import { AppError } from '../../middlewares/errorHandler'

/** F10: enforce requires a seed decision; prefer shadow history or an audited override reason. */
export function assertEnforceF10Gate(args: {
  hasSeedDecision: boolean
  hadShadowConfig: boolean
  hadShadowAudit: boolean
  enforceOverrideReason?: string
}): void {
  if (!args.hasSeedDecision) {
    throw new AppError(
      422,
      'Enforce requires a seed decision (seed, start_empty, or capped_ladder) logged for this tier (F10)',
      'LUCKY_TIER_ENFORCE_NO_SEED',
    )
  }
  if (!args.hadShadowConfig && !args.hadShadowAudit && !args.enforceOverrideReason) {
    throw new AppError(
      422,
      'Enforce requires prior shadow mode or shadow draws, or an enforceOverrideReason for audit (F10)',
      'LUCKY_TIER_ENFORCE_SHADOW_GATE',
    )
  }
}
