import { z } from "zod";

export const BindEpaySchema = z.object({
  epayEmail: z.string().email().max(255),
});

export const BindBankSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  bankName: z.string().min(1).max(150),
  branch: z.string().max(150).optional(),
  ifscCode: z.string().min(4).max(20),
  accountNumber: z.string().min(5).max(30),
  upiId: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(30).optional(),
});

export type BindBankInput = z.infer<typeof BindBankSchema>;
