PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`job_id` text NOT NULL,
	`tailored_resume_id` text,
	`cover_letter_id` text,
	`status` text DEFAULT 'matched' NOT NULL,
	`outcome` text DEFAULT 'none' NOT NULL,
	`outcome_notes` text DEFAULT '' NOT NULL,
	`ats_type` text DEFAULT 'other' NOT NULL,
	`apply_url` text DEFAULT '' NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`approved_at` text,
	`submitted_at` text,
	`confirmation_text` text,
	`confirmation_screenshot_path` text,
	`form_snapshot` text,
	`submitted_resume_path` text,
	`submitted_resume_sha256` text,
	`submitted_cover_letter_path` text,
	`submitted_cover_letter_sha256` text,
	`needs_input_reason` text,
	`pending_questions` text,
	`error_text` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tailored_resume_id`) REFERENCES `tailored_resumes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cover_letter_id`) REFERENCES `cover_letters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_applications`("id", "user_id", "job_id", "tailored_resume_id", "cover_letter_id", "status", "outcome", "outcome_notes", "ats_type", "apply_url", "dry_run", "approved_at", "submitted_at", "confirmation_text", "confirmation_screenshot_path", "form_snapshot", "submitted_resume_path", "submitted_resume_sha256", "submitted_cover_letter_path", "submitted_cover_letter_sha256", "needs_input_reason", "pending_questions", "error_text", "attempt_count", "created_at", "updated_at") SELECT "id", "user_id", "job_id", "tailored_resume_id", "cover_letter_id", "status", "outcome", "outcome_notes", "ats_type", "apply_url", "dry_run", "approved_at", "submitted_at", "confirmation_text", "confirmation_screenshot_path", "form_snapshot", "submitted_resume_path", "submitted_resume_sha256", "submitted_cover_letter_path", "submitted_cover_letter_sha256", "needs_input_reason", "pending_questions", "error_text", "attempt_count", "created_at", "updated_at" FROM `applications`;--> statement-breakpoint
DROP TABLE `applications`;--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `applications_user_job` ON `applications` (`user_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `applications_status` ON `applications` (`user_id`,`status`);