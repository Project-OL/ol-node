import { withdrawalRepository } from "../repositories/withdrawal.repository";
import { payrollAssignmentRepository } from "../repositories/payrollAssignment.repository";
import { enqueuePayrollSla } from "../queues/payroll.queue";
import { withdrawalService } from "../services/withdrawal.service";

export async function processPayrollSlaJob(data: { assignmentId: string }) {
  await withdrawalService.processSlaExpiry({ assignmentId: data.assignmentId });
}

export async function processWaitingAutoComplete(
  assignmentId: string,
): Promise<void> {
  const assignment = await payrollAssignmentRepository.getById(assignmentId);
  if (!assignment) return;
  if (assignment.status !== "WAITING") return;
  if (
    assignment.waitingExpiresAt &&
    assignment.waitingExpiresAt > new Date()
  ) {
    return;
  }
  await withdrawalService.autoCompleteWaiting(assignmentId);
}

/** Re-enqueue delayed SLA jobs if Redis/BullMQ dropped them (worker restart, etc.). */
export async function runPayrollSlaSafetyNet(): Promise<void> {
  const now = new Date();
  const overdue = await withdrawalRepository.listOverdueSlaAssignments(now, 200);
  for (const a of overdue) {
    await enqueuePayrollSla(a.id, a.expiresAt);
  }
}
