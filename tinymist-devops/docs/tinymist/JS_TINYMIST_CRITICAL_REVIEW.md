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

4. **Critical queues/state machines are under-specified** and depend on implicit behavior, increasing race-condition risk.

## Critical Findings

### C2) Runtime control-plane message shaping has unsafe typing and switch fallthrough risk

**Evidence**

- `preview/control-plane.ts`
  - `sendControlMessage(message: any)` accepts untyped message.
  - `onCompileStatus(kind: string, msg?: any)` and `onSyncChanges(msg: any)` rely on unchecked shape.

**Risk**

- Control messages can be malformed without compile-time error.
- Fallthrough can alter outgoing message semantics unexpectedly.
- Hard-to-reproduce preview desync behaviors.

**Recommendation**

- Change `message: any` to `TinymistControlEventPayload` and narrow by discriminated union.
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

## Standards Gap Checklist

### Architecture

- [ ] Introduce host adapters for events/http/storage/dom.
- [ ] Keep BookStack-specific wiring outside Tinymist core package.
- [ ] Externalize runtime config (endpoints, WS routes, selectors).

### Runtime Robustness

- [ ] Add protocol validators for control/data messages.
- [ ] Add queue invariant checks and explicit error paths.
- [ ] Add fallback full-sync behavior on irrecoverable version drift.

### Testing

- [ ] Add unit tests for:
  - event payload decoding/validation
  - control-plane queue transitions
  - semantic token delta merge logic
  - WS reconnect/token-renew scenarios

---

## Suggested Remediation Plan (Extraction-Oriented)

### Phase 2 (Adapter boundary)

- Create `TinymistHostAdapters` contract:
  - `eventBus`, `http`, `logger`, `storage`, `dom`
- Move global/window usage into BookStack adapter implementation.

### Phase 3 (Stability + tests)

- Add queue/state tests for preview/render control coupling.
- Add semantic-token delta consistency tests and fallback refresh behavior.
