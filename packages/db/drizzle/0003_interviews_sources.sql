CREATE TABLE `interviews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`profile_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`messages` text NOT NULL,
	`draft` text NOT NULL,
	`career_summary` text DEFAULT '' NOT NULL,
	`source_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interviews_user_status` ON `interviews` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `source_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`run_id` text,
	`origin` text NOT NULL,
	`company` text NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`jobs_open` integer,
	`jobs_matching` integer,
	`sample_titles` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_suggestions_user_key` ON `source_suggestions` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `source_suggestions_status` ON `source_suggestions` (`user_id`,`status`);