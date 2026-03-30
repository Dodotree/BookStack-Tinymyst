# Tinymist JS Critical Code Review (`themes/tinymist/resources/js/tinymist`)

## Purpose

This review is a **critical best-practices/standards assessment** of Tinymist JS code to support safe npm package extraction.

- Scope: `themes/tinymist/resources/js/tinymist/**/*.ts`
- Focus: type safety, architecture boundaries, lifecycle correctness, protocol robustness, operability
- Baseline standards considered:
  - TypeScript strict mode (`tsconfig.json`: `strict: true`)
  - Existing lint expectations (`eslint.config.mjs`, including `no-console` warning policy)
  - Package extraction goals from interaction mapping

---

## Executive Summary

Current implementation is feature-rich and operational, but there are **high-risk maintainability and extraction blockers**:

1. **Type contracts are not strict enough** across core event/protocol boundaries (`any`/`unknown` overuse).
2. **Host coupling is pervasive** (`window.$tmEventBus`, `window.$http`, hard DOM querying), making package boundaries brittle.
3. **Runtime protocol parsing is under-validated** for WS control/data messages and backend responses.
4. **Logging is noisy and inconsistent** with production policy (many `console.log/debug` across hot paths).
5. **Critical queues/state machines are under-specified** and depend on implicit behavior, increasing race-condition risk.

Overall status: **Not extraction-ready yet** without a stabilization pass.

---

## Priority Matrix

| Priority | Theme | Why it matters | Extraction impact |
|---|---|---|---|
| Critical | Type/contract hardening | Prevent silent runtime corruption and version drift | Required before publishing package API |
| High | Host decoupling adapters | Remove global assumptions and hard-coded integration points | Required for reusable npm package |
| High | WS protocol validation | Prevent malformed message crashes and misordered state | Required for robust runtime behavior |
| Medium | Logging policy normalization | Reduce noise, improve supportability and security posture | Strongly recommended |
| Medium | Lifecycle/cleanup consistency | Prevent leaks/ghost listeners in long sessions | Strongly recommended |
| Medium | Test coverage of reducers/queues | Stabilize refactors and prevent regressions | Strongly recommended |

---

## Critical Findings

### C1) Weak typing at core contracts (`any` in event payloads)

**Evidence**

- `constants/custom-events.ts`
  - `Diagnostics` uses `diagnostics: any[]`
  - `LspSemanticTokensDelta` uses `edits: any[]`
  x `SyncRemoteChanges` uses `changes: any`
  x `TextDiff` uses `changes: any`

**Risk**

- Invalid payloads can silently pass compile-time checks.
- Increases probability of runtime failures in editor/preview synchronization.
- Undermines `strict: true` intent.

**Recommendation**

- Define explicit domain interfaces for diagnostics, token edits, and text changes.
- Replace all event-payload `any` with concrete types or guarded discriminated unions.
- Make event bus payloads source-of-truth API types for extraction.

---

### C2) Runtime control-plane message shaping has unsafe typing and switch fallthrough risk

**Evidence**

- `preview/control-plane.ts`
  - `sendControlMessage(message: any)` accepts untyped message.
  - `onCompileStatus(kind: string, msg?: any)` and `onSyncChanges(msg: any)` rely on unchecked shape.
  - `switch` in `sendControlMessage` has no `break` after `sourceScrollBySpan`, causing fallthrough into `panelScrollByPosition` assignment.

**Risk**

- Control messages can be malformed without compile-time error.
- Fallthrough can alter outgoing message semantics unexpectedly.
- Hard-to-reproduce preview desync behaviors.

**Recommendation**

- Change `message: any` to `TinymistControlEventPayload` and narrow by discriminated union.
- Add explicit `break` for every `switch` case.
- Add schema guards for incoming JSON control messages.

---

### C3) Global host coupling blocks package extraction

**Evidence**

- Multiple modules directly depend on globals:
  - `window.$tmEventBus` (across nearly all modules)
  - `window.$http` (`connections/fallback.ts`, `connections/token-manager.ts`)
  - direct DOM selectors (`document.querySelector`) in UI/runtime constructors

**Risk**

- Tinymist cannot run outside current BookStack host assumptions.
- Package consumers would need to replicate hidden globals and DOM contracts.

**Recommendation**

- Introduce adapter interfaces and constructor injection:
  - `eventBus`, `httpClient`, `logger`, `domAdapter`, `storageAdapter`, `runtimeConfig`
- Keep existing global behavior in a thin BookStack integration layer only.

---

## High Findings

### H1) Protocol validation is partial and inconsistent

**Evidence**

- `connections/ws-base.ts` abstract `handleMessage(data: any)`
- `connections/preview-ws.ts`, `preview/data-plane.ts`, `preview/control-plane.ts` parse dynamic input with limited schema checks
- `connections/fallback.ts` and `connections/token-manager.ts` cast backend responses with `as any`

**Risk**

- Binary/control payload shape drift can break processing silently.
- Backend contract changes can produce undefined behavior.

**Recommendation**

- Add lightweight runtime validators for:
  - WS control messages
  - WS data command envelopes
  - backend compile/token renewal responses
- Keep validation local to adapters to avoid polluting domain logic.

---

### H2) Queue/state machine complexity lacks explicit invariants

**Evidence**

- `preview/control-plane.ts` keeps `pendingRenders`, `currentRender`, `confirmedRenderVersion`, `pendingCursorRequests` with coupled timing logic.
- `preview/render.ts` has queueing + render mode heuristics (`pmewma*`, merge/reset switching) with implicit assumptions.

**Risk**

- Race conditions under reconnect/latency spikes.
- Version mismatches causing stale cursor paths or wrong render mode choice.

**Recommendation**

- Define and document invariants (e.g., monotonic docVersion expectations, queue ordering guarantees).
- Encode invariants as assertions/guards in hot-path transitions.
- Add deterministic unit tests for queue transitions and failure/recovery paths.

---

## Medium Findings

### M1) Lifecycle cleanup is mostly good but inconsistent nulling/casts remain

**Evidence**

- Repeated `null as any` patterns:
  - `preview/render.ts`
  - `editor/editor.ts`
  - `editor/editor-toolbar.ts`
  - `preview/cursor.ts`

**Risk**

- Masks true nullable type handling and can hide teardown issues.

**Recommendation**

- Prefer strict nullable fields with explicit checks over `as any` null assignment.
- Normalize `destroy/dispose` contracts with idempotency guarantees.

---

### M2) Semantic token delta handling has known unresolved TODO

**Evidence**

- `editor/semantic-tokens.ts`: TODO indicates missing snapshot tracking for robust delta validation.

**Risk**

- Delta mismatches can lead to stale/incorrect highlighting.

**Recommendation**

- Store token snapshot metadata (`resultId`, `docVersion`, token baseline hash).
- Validate delta applicability before applying edits; fallback to full token refresh on mismatch.

---

### M3) Minor code quality smells reduce confidence

**Evidence**

- `connections/fallback.ts`: `destroy()` contains `if(!this){return;}` (dead/unnecessary guard).
- Inconsistent spacing/formatting in several declarations (non-functional but noisy).

**Risk**

- Indicates weak static hygiene in critical paths.

**Recommendation**

- Remove unreachable/dead guards.
- Run targeted lint/format pass in Tinymist scope only.

---

## Standards Gap Checklist

### Type Safety

- [ ] Replace event payload `any` with domain interfaces.
- [ ] Replace WS/backend response `as any` casts with typed decode + guards.
- [ ] Remove `null as any` teardown assignments.

### Architecture

- [ ] Introduce host adapters for events/http/storage/dom.
- [ ] Keep BookStack-specific wiring outside Tinymist core package.
- [ ] Externalize runtime config (endpoints, WS routes, selectors).

### Runtime Robustness

- [ ] Add protocol validators for control/data messages.
- [ ] Add queue invariant checks and explicit error paths.
- [ ] Add fallback full-sync behavior on irrecoverable version drift.

### Observability

- [ ] Add structured logger abstraction.
- [x] Remove high-frequency debug logging from production paths.
- [x] Standardize user-facing console events vs internal diagnostics.

### Testing

- [ ] Add unit tests for:
  - event payload decoding/validation
  - control-plane queue transitions
  - semantic token delta merge logic
  - WS reconnect/token-renew scenarios

---

## Suggested Remediation Plan (Extraction-Oriented)

### Phase 1 (Critical hardening)

- Replace `any` in `constants/custom-events.ts` with explicit types.
- Type `preview/control-plane.ts` message handling and fix switch fallthrough.
- Add backend/WS message schema guards at module boundaries.

### Phase 2 (Adapter boundary)

- Create `TinymistHostAdapters` contract:
  - `eventBus`, `http`, `logger`, `storage`, `dom`
- Move global/window usage into BookStack adapter implementation.

### Phase 3 (Stability + tests)

- Add queue/state tests for preview/render control coupling.
- Add semantic-token delta consistency tests and fallback refresh behavior.
x Reduce logs to policy-compliant levels and document debug flags.

---

## Final Assessment

Tinymist JS is functionally capable, but for npm packaging it currently carries **critical contract and coupling debt**. Addressing the three top items (contract typing, control-plane hardening, host adapters) will remove most extraction risk and make further improvements incremental instead of structural.
