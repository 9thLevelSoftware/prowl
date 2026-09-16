CREATE TABLE `ai_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`task` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`connection_label` text DEFAULT '' NOT NULL,
	`process` text NOT NULL,
	`pid` integer NOT NULL,
	`job_id` text,
	`application_id` text,
	`started_at` text NOT NULL
);
