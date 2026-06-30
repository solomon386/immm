CREATE TABLE IF NOT EXISTS `groupsx` (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  member_ids_json JSON NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
