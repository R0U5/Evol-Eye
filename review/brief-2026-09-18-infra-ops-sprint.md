# Goblin PM — SPRINT: Infrastructure / Ops Hardening

**Repo:** `~/.openclaw/workspace` (system-level, not Devils-Eye) | **Branch:** cut `fix/infra-ops-hardening` off `main`

## Context
The gateway is running but has accumulated config drift and plugin version skew. No feature work in Devils-Eye — all sprints shipped. This sprint is pure ops hygiene to prevent future instability.

## Issues to Fix

### 1. Plugin Version Drift (4 plugins)
| Plugin | Current | Expected | Fix |
|--------|---------|----------|-----|
| `@openclaw/cerebras-provider` | 2026.9.1 | 2026.9.4 | `openclaw plugins update cerebras` |
| `discord` | 2026.9.1 | 2026.9.4 | `openclaw plugins update discord` |
| `@openclaw/groq-provider` | 2026.9.1 | 2026.9.4 | `openclaw plugins update groq` |
| `@openclaw/searxng-plugin` | 2026.9.1 | 2026.9.4 | `openclaw plugins update @openclaw/searxng-plugin@2026.9.4` |

**Then:** `openclaw gateway restart`

### 2. Systemd Service Config Drift
**File:** `/home/goblin/.config/systemd/user/openclaw-gateway.service`

| Issue | Current | Required |
|-------|---------|----------|
| `KillMode` | `control-group` | `mixed` (drains active turns before cleanup) |
| `PATH` | Missing `/home/goblin/bin`, `/home/goblin/.local/share/pnpm/bin`, `/home/goblin/.local/share/pnpm` | Must include all required dirs |

**Fix options:**
- **Option A:** Run `openclaw gateway install --force` (regenerates service file from template)
- **Option B:** Manual edit + `systemctl --user daemon-reload` + restart

### 3. opencode.db Size Monitoring
- Was 2.2GB → trimmed to 661MB (Sep 10)
- Root cause: 126 `message.updated.1` events >10MB each (12.5MB) = 1.5GB
- Need: automated monitoring/alerting if it grows again

### 4. Gateway Memory Config
- `NODE_OPTIONS=--max-old-space-size=3072` set in service (good, fixed Sep 10)
- Verify it's actually effective at runtime

## Your Job (Lars)
1. **Fix plugin drift** — run the 4 update commands, verify versions, restart gateway
2. **Fix systemd service** — Option A preferred (cleanest). Run `openclaw gateway install --force`, verify service file, reload systemd, restart gateway
3. **Add opencode.db monitoring** — create a simple cron/check script that alerts if DB > 1GB
4. **Verify gateway health** — run `openclaw gateway status --deep` post-fix, confirm all green

## Constraints
- **Do NOT touch** `openclaw.json` model config (vision fixes already applied and working)
- **Do NOT touch** Devils-Eye repo (clean, tests green)
- Work in `~/.openclaw/` and systemd user space
- Conventional commits for any scripts created
- Report: commands run, before/after versions, gateway status output

## Team Assignments
- **Lars (you):** implementation — plugin updates, service fix, db monitor script
- **Hackerman:** security review — verify plugin updates don't introduce supply-chain issues, check service file permissions
- **Toby:** recon — check ClawStat.us for 2026.9.4 release notes (any breaking changes in drifted plugins?), verify backup strategy for opencode.db
- **Specs:** QA gate — run `openclaw gateway status --deep` after fixes, verify no drift, all plugins at 2026.9.4, service file has KillMode=mixed and complete PATH

## Acceptance Criteria
- [ ] All 4 drifted plugins at 2026.9.4
- [ ] `openclaw gateway status --deep` shows "Plugin version drift: 0"
- [ ] Service file has `KillMode=mixed`
- [ ] Service PATH includes all required dirs
- [ ] Gateway restart clean (no errors in logs)
- [ ] opencode.db monitor script created and tested
- [ ] Specs signs off

## Commands Reference
```bash
# Plugin updates
openclaw plugins update cerebras
openclaw plugins update discord
openclaw plugins update groq
openclaw plugins update @openclaw/searxng-plugin@2026.9.4

# Service fix (Option A)
openclaw gateway install --force
systemctl --user daemon-reload
openclaw gateway restart

# Verification
openclaw gateway status --deep
systemctl --user show openclaw-gateway.service --property=KillMode,Environment
```