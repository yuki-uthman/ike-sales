-- D19: the entry's optional description. The production D1 has already applied
-- 0001_init.sql, so the column arrives through this new migration and never by
-- editing 0001. NOT NULL DEFAULT '' means every row saved before this migration
-- reads as "no description" rather than as null, and the save's column-listing
-- INSERT stays valid. No index: nothing queries by description.
ALTER TABLE entry ADD COLUMN description TEXT NOT NULL DEFAULT '';
