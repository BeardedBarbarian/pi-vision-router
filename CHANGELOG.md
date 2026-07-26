# Changelog

All notable changes to pi-vision-router will be documented in this file.

## [0.2.0] - 2026-07-26

### Changed
- **Breaking**: vision models now auto-discovered on session start, not at call time
- Model list cached per session — use `/vision-router-reload` to refresh
- Manual model selection stored as stable `provider/id` string, survives refreshes

### Added
- `/vision-router-reload` command to re-discover vision models
- `/vision-router-select` interactive model picker (same UI as `/model`)
- 30s per-candidate timeout — hung providers skipped in cascade

### Security
- 96-bit random nonce delimiters (`BEGIN_UNTRUSTED_IMAGE_<nonce>` / `END...`) prevent delimiter injection
- Budgeted truncation guarantees END delimiter always present in output
- 8KB description cap with safe UTF-8 boundary walk-back
- In-flight request deduplication via promise cache

## [0.1.1] - 2026-07-26

### Security
- Replace FNV-1a hash with SHA-256 for cache keys to prevent collisions
- Add untrusted-input warning prefix to all image descriptions to mitigate prompt injection
- Remove debug console.log statements that leaked metadata

## [0.1.0] - 2026-07-25

### Added
- Initial release
- Automatic vision model routing for image `read` results
- Transparent delegation to vision-capable models via auto-discovery from pi model registry
- LRU description cache to avoid repeated API calls for the same image
- Graceful degradation when no vision model is available
- Status line integration for active routing count
- Retry with exponential backoff for failed vision model calls
- FNV-1a hash-based cache key computation
