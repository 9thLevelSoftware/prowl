DROP INDEX IF EXISTS `queue_tasks_dedup`;--> statement-breakpoint
CREATE UNIQUE INDEX `queue_tasks_dedup_active` ON `queue_tasks` (`dedup_key`) WHERE `status` IN ('pending', 'running');