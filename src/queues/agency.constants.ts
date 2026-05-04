/** BullMQ queue for delayed leave auto-approve (+7d) and hourly safety-net dispatcher. */
export const AGENCY_LEAVE_AUTO_APPROVE_QUEUE = "agency-leave-auto-approve";

export const AGENCY_LEAVE_AUTO_APPROVE_JOB = "auto-approve";

/** Hourly UTC safety net for missed delayed jobs. */
export const AGENCY_LEAVE_SAFETY_NET_JOB = "safety-net-hourly";
