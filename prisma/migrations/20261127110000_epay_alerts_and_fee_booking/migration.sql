-- Epay go-live prep (2026-11-27). Additive enum values only; Live-server maps neither enum.
-- Super-admin bell alerts for payments that need a person.
ALTER TYPE "ModerationNotificationType" ADD VALUE 'PAYMENT_REVIEW_NEEDED';
ALTER TYPE "ModerationNotificationType" ADD VALUE 'EPAY_PAYOUT_ATTENTION';
-- Company cash bookings for Epay fees and refunds (master ledger P&L).
ALTER TYPE "CompanyCashReason" ADD VALUE 'EPAY_FEE';
ALTER TYPE "CompanyCashReason" ADD VALUE 'EPAY_REFUND';
