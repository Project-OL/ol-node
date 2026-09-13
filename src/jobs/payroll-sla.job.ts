import { withdrawalRepository } from '../repositories/withdrawal.repository'
import { payrollAssignmentRepository } from '../repositories/payrollAssignment.repository'
import { enqueuePayrollSla, enqueuePlatformWaiting } from '../queues/payroll.queue'
import { withdrawalService } from '../services/withdrawal.service'

export async function processPayrollSlaJob(data: { assignmentId: string }) {
  await withdrawalService.processSlaExpiry({ assignmentId: data.assignmentId })
}

export async function processWaitingAutoComplete(assignmentId: string): Promise<void> {
  const assignment = await payrollAssignmentRepository.getById(assignmentId)
  if (!assignment) return
  if (assignment.status !== 'WAITING') return
  if (assignment.waitingExpiresAt && assignment.waitingExpiresAt > new Date()) {
    return
  }
  await withdrawalService.autoCompleteWaiting(assignmentId)
}

export async function processPlatformWaitingAutoComplete(withdrawalId: string): Promise<void> {
  const row = await withdrawalRepository.getById(withdrawalId)
  if (!row) return
  if (row.status !== 'WAITING') return
  if (row.waitingExpiresAt && row.waitingExpiresAt > new Date()) return
  if (row.payoutHandler === 'PLATFORM' || row.methodType === 'EPAY') {
    await withdrawalService.autoCompletePlatformWaiting(withdrawalId)
    return
  }
  await withdrawalService.autoCompleteTakeoverWaiting(withdrawalId)
}

/** Re-enqueue delayed SLA / platform-waiting jobs if Redis/BullMQ dropped them. */
export async function runPayrollSlaSafetyNet(): Promise<void> {
  const now = new Date()
  const overdue = await withdrawalRepository.listOverdueSlaAssignments(now, 200)
  for (const a of overdue) {
    await enqueuePayrollSla(a.id, a.expiresAt)
  }
  const overduePlatform = await withdrawalRepository.listOverduePlatformWaiting(now, 200)
  for (const w of overduePlatform) {
    await enqueuePlatformWaiting(w.id, w.waitingExpiresAt ?? now)
  }

  // Catches withdrawals left PENDING with no open assignment - e.g. processSlaExpiry expired
  // the old assignment but the follow-up assignToAgency call never completed (crash/error
  // between the two steps). Not caught by the overdue-assignment sweep above since the
  // assignment itself is already EXPIRED, not PENDING.
  const stuckPending = await withdrawalRepository.listStuckPendingNoOpenAssignment(200)
  for (const w of stuckPending) {
    await withdrawalService.assignToAgency(w.id).catch(() => {})
  }
}
