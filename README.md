# observational-memory

Local, subprocess-backed memory for Pi. Parallel observers summarize conversation chunks into a branch-local ledger. A consolidator promotes observations into local Markdown files.

## Installation and controls

Install this checkout with `pi install .`, then restart Pi or use `/reload`. A working Pi CLI and Node.js are required. Workers use stdin, not command-line arguments, for prompts. No terminal multiplexer is required.

Memory is enabled by default. Existing explicit off settings remain off.

| Command | Effect |
|---|---|
| `/om`, `/om on`, `/om off` | Toggle or set capture for this session |
| `/om:status` | Show effective provider/model names, data policy, worker state, coverage, costs, and errors |
| `/om:compact` | Request compaction after the current turn settles |
| `/om:consolidate` | Promote overflow without waiting for the pool threshold |

Disabling memory cancels workers. Their slots remain reserved until their processes close. Shutdown and session navigation wait for cancellation to finish.

## Data policy

Observers receive conversation text, tool arguments, and tool results. Assistant thinking blocks are omitted from captured history. Recognizable credentials are redacted before worker transport and before provider requests. This includes bearer credentials, common secret fields, private keys, and several token formats.

Redaction is best effort, not a guarantee that arbitrary secrets are absent. Use `/om off` before sensitive work. Disabling capture does not erase existing ledger records, topic files, or worker sessions.

Workers send data to the explicitly configured providers. Startup notifications and `/om:status` show the effective provider/model names without showing conversation content. The `om.data-policy` ledger entry also records these selections for headless clients, before worker dispatch. Provider selection does not change automatically when a worker fails.

Worker inputs and outputs remain ordinary local Pi session recordings under Pi's global session store. This package does not delete those recordings. Local storage does not mean inference is local: the configured provider controls where inference runs.

Memory is historical evidence, never a new user instruction or authorization.

## Coverage and compaction

Observers run on `agent_start` and `turn_end`, subject to `observerConcurrency`. Dispatch reserves source entries but does not confirm coverage. Failed ranges become eligible for retry on the next trigger event. Each evaluation attempts a source range at most once and dispatches no more workers than its initial free slots. Synchronous launch failures cannot create a retry loop. Lifecycle invalidation stops the remaining attempts. Later successful ranges cannot hide an earlier gap.

New `om.observations.recorded` entries retain the existing fields and add:

```json
{
  "coverageVersion": 2,
  "sourceEntryIds": ["source-a", "source-b"],
  "coversUpToId": "source-b",
  "observations": []
}
```

An explicit successful tool call with zero observations still records completed coverage. Missing or malformed worker output does not. Source identifiers must describe an ordered, continuous range on the current branch.

Automatic compaction runs after `agent_settled`. An observational summary can replace only a continuously covered prefix. If coverage is unknown, the hook delegates to Pi's native compactor instead of returning an empty summary or repeatedly cancelling compaction.

Legacy observations remain readable. Legacy end markers do not prove continuous coverage, so old ranges can be observed again. Compaction applies a tombstone only when its receipt matches the current session and memory scope. Persisted receipts must still match the file hash and exact quote. Explicit discard receipts require a reason. Each unavailable representation restores only its own observation. Legacy or unscoped drops do not authorize omission.

The summary has a byte cap of `4 * (poolTargetTokens + journeyTargetTokens + 2048)` (52,192 bytes with defaults). A stricter cap applies when context headroom is smaller. Headroom uses the smaller model window or compaction threshold, minus the estimated tail and reserve. The reserve is at least 4096 tokens and honors a larger native compaction reserve. The context check conservatively counts one UTF-8 byte per token. If the complete summary exceeds the budget, the hook delegates to native compaction without truncating observations or changing the ledger. Native summarization remains subject to Pi's own context handling.

## Consolidation receipts and publication

Only one consolidator runs per runtime. It edits a private staging directory, not live topic files. After all edits, it must call `report_consolidation`:

```json
{
  "receipts": [
    {
      "timestamp": "2026-11-05T10:00:00",
      "path": "auth.md",
      "quote": "Authentication uses short-lived tokens."
    },
    {
      "timestamp": "2026-11-05T10:01:00",
      "discardReason": "Repeated greeting without new facts"
    }
  ]
}
```

The tool adds SHA-256 hashes. Each report replaces the preceding report. Persisted receipts require an exact quote in a flat Markdown filename. `INDEX.md` is reserved. An explicit discard requires a nonempty reason and no file fields.

The worker rejects receipt timestamps outside the handed batch before it writes a result. Its error asks for exact IDs from the supplied observations so the consolidator can retry.

The orchestrator independently verifies receipts against the handed batch and staged files. It publishes only referenced files, verifies them again, writes provenance and the index, then appends tombstones with `sessionId` and `scopeId`. These additive fields bind compaction-time receipt checks to the publishing scope. Exit zero and prose confirmation are not receipts. Unknown timestamps, changed files, missing receipts, cancellation, and stale lifecycle tokens cannot authorize tombstones.

Publication uses atomic replacement per file, not a multi-file transaction. If publication fails partway, some files can change, but the observations remain available and no batch tombstone is appended. Receipts prove persistence of quoted text, not semantic completeness of a model summary.

## Branches, persistence, and retention

New durable roots use `.memory/<sessionId>-<scopeId>/`. The ledger stores `om.memory.scope`. A `.branch.json` file records the branch identifiers associated with published files.

Tree navigation starts a new scope. Resume reuses a scope only when its provenance fits the selected branch. Historical forks do not copy the parent's current files. Ambiguous or legacy directories remain untouched but are not injected automatically. Ledger observations and raw session history remain available for reconstruction.

Workers have a ten-minute deadline. Cancellation sends TERM, then KILL after three seconds unless the process has closed. POSIX workers use a separate process group. Windows uses child-process termination.

After workers settle, retention keeps at most 100 recognized inactive IPC artifacts per scope, plus active artifacts. These include result files, cost files, and abandoned staging directories. Retention never deletes topic files, unknown files, or Pi session recordings.

File tools reject symlink components and hidden paths. Writes use random exclusive temporary files with private permissions. These checks are not an OS sandbox against concurrent hostile ancestor replacement. The single-consolidator guard is process-local: do not open the same session scope for writing in multiple Pi processes.

## Configuration

Use the `observational-memory` namespace in global Pi settings or a trusted project's `.pi/settings.json`. Project settings apply only when Pi explicitly reports project trust; older hosts without that signal use global settings. Project model overrides inherit each omitted field from global settings. Existing explicit models, including `openai-codex/gpt-6-luna`, stay unchanged unless overridden explicitly in an authorized scope.

```json
{
  "observational-memory": {
    "chunkTokens": 10000,
    "poolTargetTokens": 10000,
    "consolidateAtPoolTokens": 15000,
    "compactAtContextTokens": 150000,
    "tailTokens": 20000,
    "journeyTargetTokens": 1000,
    "observerConcurrency": 4,
    "showStatus": true,
    "models": {
      "observer": { "provider": "openai-codex", "id": "gpt-6-luna", "thinking": "high" },
      "consolidator": { "provider": "openai-codex", "id": "gpt-6-luna", "thinking": "high" }
    },
    "passive": false
  }
}
```

No configuration migration is required. This example does not change the package defaults: without explicit model settings, both roles still use `openrouter/z-ai/glm-5.3`. `PI_OM_PASSIVE=1` disables automatic triggers. `chunkOverlapTokens` remains zero in this implementation. Worker deadlines and retention limits are currently code constants, not new settings.

`showStatus` defaults to `true` and accepts only boolean values. Set `showStatus` to `false` to hide the `om` footer and `om-workers` widget. Memory capture, workers, costs, compaction, `/om:status`, and notifications remain unchanged.

Cost reporting uses Pi usage metrics. Costs from invalidated workers are not appended to another branch, so displayed totals can undercount cancelled work. There is no monetary budget cap.

## Development and verification

```bash
npm run typecheck
npm test
PI_OM_TEST_HOST=/absolute/path/to/installed/pi-coding-agent node tests/pi15-lifecycle.mjs
```

Development dependencies remain pinned to Pi 0.85.1 and TypeBox 1.3.7. The additional lifecycle probe uses the installed official Pi 1.5 loader, runner, and in-memory session manager. It isolates all settings and files in a temporary directory and makes no model calls.

`tests/audit-integrity.test.ts` covers the audit regressions with synthetic fixtures and a local TERM-ignoring worker. `tests/review-regressions.test.ts` covers selective receipt recovery, summary limits, and synchronous dispatch failures. The lifecycle probe checks registration, native-compaction fallback, covered summaries, tree invalidation, shutdown, receipt tools, and provider-payload redaction. Synthetic subprocesses also verify partial-publication failure, active-staging retention, deadlines, and stale compaction callbacks.
