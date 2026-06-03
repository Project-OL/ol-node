export const PAYROLL_SLA_QUEUE = "payroll-sla";

export const PAYROLL_SLA_JOB = "sla";

export const PAYROLL_WAITING_JOB = "payroll-waiting";

export const PAYROLL_SAFETY_NET_JOB = "payroll-sla-safety-net";

/** BullMQ job id must avoid ':' — use hyphen form of sla:{assignmentId}. */
export const PAYROLL_SLA_JOB_ID = (assignmentId: string) =>
  `sla-${assignmentId}`;

/** WAITING auto-complete job id (deterministic for replace/remove). */
export const PAYROLL_WAITING_JOB_ID = (assignmentId: string) =>
  `payroll-waiting-${assignmentId}`;
