import type { Job } from "bullmq";
import {
  AGENCY_LEAVE_AUTO_APPROVE_JOB,
  AGENCY_LEAVE_SAFETY_NET_JOB,
} from "../queues/agency.constants";
import { agencyHostService } from "../services/agencyHost.service";
import { agencyLeaveApplicationRepository } from "../repositories/agencyLeaveApplication.repository";

export async function processAgencyLeaveWorkerJob(
  job: Job<{ applicationId?: string }>,
): Promise<void> {
  if (job.name === AGENCY_LEAVE_SAFETY_NET_JOB) {
    const overdue = await agencyLeaveApplicationRepository.getOverdueAutoApprovals(
      new Date(),
      500,
    );
    for (const row of overdue) {
      await agencyHostService.processAutoApproveJob(row.id);
    }
    return;
  }

  if (job.name === AGENCY_LEAVE_AUTO_APPROVE_JOB && job.data.applicationId) {
    await agencyHostService.processAutoApproveJob(job.data.applicationId);
  }
}
