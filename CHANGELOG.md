# Changelog

## [0.3.12] - 2026-03-27

### Fixed
- **Knowledge card category fix (proper approach)**: Replaced hardcoded English alias map with proper fix at source — `awareness_record` MCP tool schema now explicitly enumerates all 13 valid categories in `describe()`. LLMs read the schema and output valid values directly. `normalizeCategory()` simplified to case/whitespace normalization + strict `VALID_CATEGORIES` lookup + fallback `key_point`. No language-specific aliases needed.

## [0.3.11] - 2026-03-27

### Fixed
- **Windows Chinese/CJK text rendering**: Force UTF-8 encoding on Windows for daemon process stdout/stderr and MCP stdio stdin/stdout/stderr — prevents Chinese characters from becoming "????" on Windows systems with non-UTF-8 code pages (e.g., CP936/GBK)

### Fixed (knowledge-extractor)
- **Non-standard knowledge card categories**: `processPreExtracted()` now normalizes LLM-generated categories via `normalizeCategory()`. Maps TROUBLESHOOTING → `problem_solution`, BEST-PRACTICE → `insight`, SETUP → `workflow`, etc. — no more unlisted categories appearing in the dashboard or being silently downgraded to `key_point` during cloud sync

## [0.3.10] - 2026-03-27

### Added
- Initial CHANGELOG (backfilled from git history)
