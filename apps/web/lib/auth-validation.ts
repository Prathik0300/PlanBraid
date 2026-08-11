import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .max(254, "Email address must be 254 characters or fewer.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(128, "Password must be 128 characters or fewer.")
  .regex(/[a-z]/, "Password must include a lowercase letter.")
  .regex(/[A-Z]/, "Password must include an uppercase letter.")
  .regex(/[0-9]/, "Password must include a number.")
  .regex(/[^A-Za-z0-9\s]/, "Password must include a special character.");

export const emailSignUpSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80, "Name must be 80 characters or fewer."),
  email: emailSchema,
  password: passwordSchema,
});

export const emailSignInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export function firstValidationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "Check the highlighted fields and try again.";
}
