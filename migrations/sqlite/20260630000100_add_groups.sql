CREATE TABLE IF NOT EXISTS `groupsx` (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  member_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
