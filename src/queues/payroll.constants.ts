export const PAYROLL_SLA_QUEUE = "payroll-sla";

export const PAYROLL_SLA_JOB = "sla";

export const PAYROLL_SAFETY_NET_JOB = "payroll-sla-safety-net";

/** BullMQ job id must avoid ':' — use hyphen form of sla:{assignmentId}. */
export const PAYROLL_SLA_JOB_ID = (assignmentId: string) =>
  `sla-${assignmentId}`;
