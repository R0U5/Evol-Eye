# Goblin PM — SPRINT: Smart Model Router v2 (Adaptive, Learning, Telemetry-Driven)

**Repo:** `~/.openclaw/workspace` (system-level) | **Branch:** cut `feat/smart-model-router-v2` off `main`

## Context
Our current `hybrid-model-router` skill has the right architecture (free-tier drain ladder, task taxonomy, health checks, budget enforcement) but **lacks learning from outcomes**. It's static — same fallback order, same routing decisions, no adaptation from success/failure data.

**Research synthesis** (academic + industry):
- **RouteLLM** (LMSYS): 85% cost reduction, 95% GPT-4 performance via preference-trained router
- **NSGA-II multi-objective** (arXiv:2507.15553v1): 95.2% latency improvement, 34.9% cost reduction via Pareto-optimal routing across cloud-edge
- **Bifrost/Maxim**: Production gateway with semantic caching, cascading fallbacks, adaptive load balancing, circuit breakers
- **PolyRouter/GraphRouter**: Domain-specific classifiers + graph neural nets for inductive edge prediction
- **IBM Research**: 11-model cascade, waterfall pattern with quality gates
- **Eagle**: Training-free router using ELO ranking from historical feedback

**Our gaps to close:**
1. No per-model telemetry (latency, success rate, tokens, cost, task-type)
2. No context-size awareness → Groq overflow on large contexts
3. Ollama cold-starts (qwen3:8b connection refused)
4. No provider health polling (Nemotron 503s surprise us)
5. No token-budget forecasting (Gemini 20/day exhausted)
6. No outcome feedback loop (Execution Outcome Tracker → Router weight updates)
7. No adaptive fallback reordering (circuit breaker + success-rate ranking)

---

## Your Job (Lars — Lead Dev)

### Phase 1: Telemetry Infrastructure (Days 1-2)
**Create:** `~/.openclaw/workspace/scripts/model_telemetry.py`
- Append-only JSONL: `~/.openclaw/data/model_telemetry.jsonl`
- Fields: `timestamp, model, provider, task_type, estimated_tokens, actual_tokens_in, actual_tokens_out, latency_ms, success, error_type, cost_usd, fallback_depth`
- HTTP endpoint or CLI for OpenClaw to call post-request
- Rotation: daily files, 30-day retention

### Phase 2: Context-Aware Router Core (Days 2-3)
**Modify:** `~/.openclaw/workspace/skills/hybrid-model-router/SKILL.md` + implementation
- Add `estimate_tokens(task, context)` helper
- Routing logic:
  ```python
  if estimated_tokens > 8000: exclude groq (TPM overflow)
  if task_type == "vision": require vision_capable
  if budget_tier == "free": prefer local → gemini-flash-lite → groq-120b
  if task_type == "code": prefer groq-gpt-oss-120b / deepseek
  ```
- Circuit breaker: 3 failures in 10min → model quarantined for 5min
- Adaptive fallback order: sort by `success_rate_10min` descending

### Phase 3: Ollama Keep-Alive + Pre-warm (Day 3)
**Systemd drop-in:** `/home/goblin/.config/systemd/user/ollama.service.d/keepalive.conf`
```ini
Environment=OLLAMA_KEEP_ALIVE=30m
Environment=OLLAMA_MAX_LOADED_MODELS=2
```
**Pre-warm script:** `~/.openclaw/workspace/scripts/prewarm_models.py`
- Run 5min before each cron: `ollama run qwen3:8b "ping"` (keep hot)
- Triggered by systemd timer or cron pre-hook

### Phase 4: Feedback Loop Integration (Days 3-4)
**Wire to existing systems:**
- **Execution Outcome Tracker** → on `track_outcome.py` success: increment model success counter
- **Closed-Loop Learner** → Bayesian weight update per `(model, task_type)` pair
- **World Model** → store routing decision quality as training signal
- Daily cron: recompute model rankings, persist to `~/.openclaw/data/model_rankings.json`

### Phase 5: Provider Health Polling (Day 4)
**Add to heartbeat cron (every 2h):**
- Poll OpenRouter `/models` endpoint for Nemotron status
- Poll Groq `/models` for rate-limit headers
- Poll Google for quota remaining (if API exposes)
- Update `~/.openclaw/data/provider_health.json` with `healthy/degraded/down`

---

## Constraints
- **Zero paid dependencies** — all free-tier or local
- **Backward compatible** — existing cron model assignments work unchanged
- **Observability first** — every decision logged with reasoning
- **Rollback safe** — feature flag `SMART_ROUTER_V2_ENABLED=false` killswitch

---

## Team Assignments

| Agent | Role | Deliverable |
|-------|------|-------------|
| **Lars** (you) | Lead Dev | Phases 1-5 implementation, SKILL.md update |
| **Hackerman** | Security | Audit telemetry for PII leakage, circuit breaker DoS resistance, provider health endpoint auth |
| **Toby** | Recon | Spike: benchmark NSGA-II vs simple heuristic on our workload (simulate 1000 requests) |
| **Specs** | QA | Test: context overflow handling, circuit breaker trips, fallback chain exhaust, rollback flag |

---

## Acceptance Criteria
- [ ] Telemetry captures 100% of cron model calls (verify via cron list)
- [ ] Context overflow errors → 0 (Groq excluded for >8K tokens)
- [ ] Ollama cold-starts → 0 (pre-warm + keep-alive verified)
- [ ] Fallback chain reorders by success rate (log shows reorder events)
- [ ] Daily ranking file updated with Bayesian weights from Closed-Loop Learner
- [ ] Provider health JSON shows real-time status
- [ ] `SMART_ROUTER_V2_ENABLED=false` reverts to original hybrid-model-router behavior
- [ ] Specs signs off on all test scenarios

---

## References
- RouteLLM: https://arxiv.org/abs/2406.18665
- NSGA-II Cloud-Edge: https://arxiv.org/html/2507.15553v1
- Bifrost docs: https://docs.getbifrost.ai/features/
- vLLM Semantic Router: https://blog.vllm.ai/2025/09/11/semantic-router.html
- PolyRouter: https://arxiv.org/abs/2406.18665 (sec 4.2)
- Eagle: https://arxiv.org/abs/2406.18665 (sec 4.3)