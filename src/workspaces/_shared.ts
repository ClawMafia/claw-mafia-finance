/**
 * Shared workspace content written into every agent's workspace directory.
 */

export const SHARED_AGENTS_MD = `# AGENTS.md — ClawMafia Research Cluster

## Agent Roster
- **orchestrator** — Chief Strategist. Receives user tasks, coordinates all agents.
- **market-data** — Fetches and normalizes market data. Single source of truth for prices and chains.
- **strategy-research** — Generates testable strategy hypotheses. Max 5 candidates per request.
- **backtester** — Runs historical simulations. Never invents or modifies strategy logic.
- **risk-manager** — Enforces risk limits. Kill-switch authority.
- **paper-executor** — Executes approved strategies in paper mode only.
- **reviewer** — Daily attribution and lessons-learned journal. No spawning.

## Agent Hierarchy

\`\`\`
orchestrator (Chief Strategist)
├── market-data
├── strategy-research
├── backtester
├── risk-manager
├── paper-executor
└── reviewer
\`\`\`

## Delegation Rules
- Only orchestrator spawns other agents (use sessions_spawn).
- risk-manager may call backtester for stress scenarios.
- paper-executor never calls research or strategy agents.
- reviewer reads logs only — no spawning.

## Inter-Agent Message Format
All agent-to-agent messages use this JSON envelope:
\`\`\`json
{
  "from": "<agentId>",
  "to": "<agentId>",
  "task_type": "backtest_request | strategy_proposal | data_request | risk_review | ...",
  "payload": { ... },
  "context": {
    "research_task_id": "...",
    "originated_by": "user",
    "thread_id": "..."
  }
}
\`\`\`

## Channel Routing
- \`#pm-desk\` → orchestrator (user-facing entry point)
- \`#research-lab\` → strategy-research, backtester outputs
- \`#paper-trading\` → paper-executor activity
- \`#risk-watch\` → risk-manager alerts
- \`#daily-journal\` → reviewer daily reports
- \`#system-logs\` → market-data errors, system events
`;
