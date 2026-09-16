CREATE TABLE `application_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`payload` text,
	`screenshot_path` text,
	`at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_events_app` ON `application_events` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `applications` (
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
	`dry_run` integer DEFAULT false NOT NULL,
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
CREATE UNIQUE INDEX `applications_user_job` ON `applications` (`user_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `applications_status` ON `applications` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `cover_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`job_id` text NOT NULL,
	`tailored_resume_id` text,
	`content` text NOT NULL,
	`audit` text,
	`audit_status` text DEFAULT 'pending' NOT NULL,
	`pdf_path` text,
	`file_name` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tailored_resume_id`) REFERENCES `tailored_resumes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `job_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`job_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`score_total` real NOT NULL,
	`breakdown` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_matches_job_profile` ON `job_matches` (`job_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `job_matches_score` ON `job_matches` (`user_id`,`score_total`);--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`last_run_status` text,
	`last_run_message` text,
	`last_run_job_count` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`source_id` text,
	`source_type` text NOT NULL,
	`external_id` text NOT NULL,
	`dedup_key` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`remote` integer,
	`salary_min` real,
	`salary_max` real,
	`description_text` text DEFAULT '' NOT NULL,
	`requirements` text,
	`ats_type` text DEFAULT 'other' NOT NULL,
	`apply_url` text NOT NULL,
	`posting_url` text DEFAULT '' NOT NULL,
	`posted_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`processing_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `job_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_dedup` ON `jobs` (`user_id`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `jobs_user_seen` ON `jobs` (`user_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`job_id` text,
	`application_id` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_calls_at` ON `llm_calls` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`stats` text,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_user_id_unique` ON `preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `profile_facts` (
	`id` text NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`ref_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_facts_pk` ON `profile_facts` (`profile_id`,`id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`version` integer NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`data` text NOT NULL,
	`source_text` text DEFAULT '' NOT NULL,
	`source_file_name` text DEFAULT '' NOT NULL,
	`baseline_pdf_path` text,
	`baseline_docx_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profiles_user_active` ON `profiles` (`user_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `qa_bank` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`question_key` text NOT NULL,
	`question_text` text NOT NULL,
	`answer` text NOT NULL,
	`answer_type` text DEFAULT 'text' NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`times_used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qa_bank_user_key` ON `qa_bank` (`user_id`,`question_key`);--> statement-breakpoint
CREATE TABLE `queue_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` text NOT NULL,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`dedup_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `queue_tasks_pick` ON `queue_tasks` (`status`,`run_after`,`priority`);--> statement-breakpoint
CREATE INDEX `queue_tasks_dedup` ON `queue_tasks` (`dedup_key`,`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_user_key` ON `settings` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `tailored_resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`job_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`content` text NOT NULL,
	`keyword_coverage_before` real,
	`keyword_coverage_after` real,
	`keyword_report` text,
	`semantic_before` real,
	`semantic_after` real,
	`audit` text,
	`audit_status` text DEFAULT 'pending' NOT NULL,
	`structural_errors` text,
	`pdf_path` text,
	`docx_path` text,
	`file_name` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`last_beat_at` text NOT NULL,
	`current_task` text
);
