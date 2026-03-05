# Note Open Tracker Plus
Tracks how often notes are opened in Obsidian and generates an analytics report with:
- All-time opens
- Opens in the last 30 / 90 / 365 days
- Trending score based on 30/90/365 windows
- Most recently opened notes
## Features
- Tracks opens on desktop and mobile (if enabled on both)
- Configurable output folder (default: `_Archives/_stats`)
- Optional append-only NDJSON event log
- Configurable debounce interval to reduce sync churn
- Configurable trending weights
## Output files
All files are written under the configured **Stats folder**:
- `.note-open-tracker-plus.json` (stats database)
- `.note-open-events.ndjson` (optional raw event log)
- `Note Open Analytics.md` (generated report)
## Settings
Obsidian → Settings → Community plugins → Note Open Tracker Plus
- Stats folder
- Report filename
- Write debounce (ms)
- Track non-markdown files
- Enable event log (NDJSON)
- Trending weights (w30, w90, w365)
- Top N rows in report
## How trending is calculated
Trend score:
`opens_30d*w30 + opens_90d*w90 + opens_365d*w365`
Default: `w30=5, w90=2, w365=1`
## Notes on sync and conflicts
If you use Obsidian Sync (or iCloud/Dropbox), frequent writes can occasionally cause conflicts if two devices write at the same time.
Mitigations:
- Increase write debounce (e.g. 5000–10000ms)
- Disable NDJSON event log
## Manual report regeneration
Use the command palette:
- “Regenerate Note Open Analytics report”
