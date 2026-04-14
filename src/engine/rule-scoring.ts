/**
 * ============================================================================
 * RULE SCORING SYSTEM — Rules Compete, Best Ones Survive
 * ============================================================================
 *
 * Tracks effectiveness of each validation rule and each detection pattern.
 * Rules that catch real bugs get higher scores. Rules that only produce
 * false positives get demoted or disabled.
 *
 * Also includes AGENT TOPOLOGY PRUNER — disables unnecessary agents
 * based on project complexity and historical value.
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

interface RuleScore {
  ruleId: string;
  totalTriggered: number;       // How many times this rule flagged a violation
  truePositives: number;        // Violations that led to real bug fixes
  falsePositives: number;       // Violations that were overridden/ignored
  precision: number;            // truePositives / totalTriggered
  lastTriggered: string;
  enabled: boolean;
  severity: 'error' | 'warning';
  notes: string[];
}

interface AgentScore {
  agentId: string;
  totalRuns: number;
  findingsProduced: number;     // How many issues this agent found
  actionableFindings: number;   // Findings that led to real fixes
  averageRunTimeMs: number;
  estimatedTokenCost: number;   // Rough token count per run
  valueScore: number;           // actionableFindings / estimatedTokenCost
  enabled: boolean;
  disableReason?: string;
}

interface ScoringDB {
  version: string;
  lastUpdated: string;
  rules: Record<string, RuleScore>;
  agents: Record<string, AgentScore>;
}

// ============================================================================
// RULE SCORING
// ============================================================================

export class RuleScoringSystem {
  private db: ScoringDB;
  private dbPath: string;

  private constructor(db: ScoringDB, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static load(dbPath: string): RuleScoringSystem {
    const absPath = path.resolve(dbPath);
    let db: ScoringDB;

    if (fs.existsSync(absPath)) {
      db = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    } else {
      db = { version: '1.0.0', lastUpdated: new Date().toISOString(), rules: {}, agents: {} };
    }

    return new RuleScoringSystem(db, absPath);
  }

  // --------------------------------------------------------------------------
  // Rule operations
  // --------------------------------------------------------------------------

  recordRuleTriggered(ruleId: string, severity: 'error' | 'warning' = 'warning'): void {
    if (!this.db.rules[ruleId]) {
      this.db.rules[ruleId] = {
        ruleId,
        totalTriggered: 0,
        truePositives: 0,
        falsePositives: 0,
        precision: 0,
        lastTriggered: new Date().toISOString(),
        enabled: true,
        severity,
        notes: [],
      };
    }
    this.db.rules[ruleId].totalTriggered++;
    this.db.rules[ruleId].lastTriggered = new Date().toISOString();
  }

  /**
   * Mark a rule trigger as true positive (the violation was a real issue).
   */
  recordTruePositive(ruleId: string): void {
    const rule = this.db.rules[ruleId];
    if (!rule) return;
    rule.truePositives++;
    rule.precision = rule.totalTriggered > 0 ? rule.truePositives / rule.totalTriggered : 0;
  }

  /**
   * Mark a rule trigger as false positive (violation was ignored/overridden).
   */
  recordFalsePositive(ruleId: string): void {
    const rule = this.db.rules[ruleId];
    if (!rule) return;
    rule.falsePositives++;
    rule.precision = rule.totalTriggered > 0 ? rule.truePositives / rule.totalTriggered : 0;

    // Auto-demote rules with very low precision
    if (rule.totalTriggered >= 10 && rule.precision < 0.2) {
      if (rule.severity === 'error') {
        rule.severity = 'warning';
        rule.notes.push(`${new Date().toISOString()}: Demoted to warning (precision ${(rule.precision * 100).toFixed(0)}%)`);
      }
    }

    // Auto-disable rules with persistent false positives
    if (rule.totalTriggered >= 20 && rule.precision < 0.1) {
      rule.enabled = false;
      rule.notes.push(`${new Date().toISOString()}: Disabled (precision ${(rule.precision * 100).toFixed(0)}% after ${rule.totalTriggered} triggers)`);
    }
  }

  /**
   * Get rules sorted by effectiveness for the validation engine.
   */
  getActiveRules(): RuleScore[] {
    return Object.values(this.db.rules)
      .filter(r => r.enabled)
      .sort((a, b) => b.precision - a.precision);
  }

  /**
   * Get rules that should be promoted from warning to error (high precision).
   */
  getPromotionCandidates(): RuleScore[] {
    return Object.values(this.db.rules)
      .filter(r => r.severity === 'warning' && r.precision >= 0.8 && r.totalTriggered >= 5);
  }

  // --------------------------------------------------------------------------
  // Agent Topology operations
  // --------------------------------------------------------------------------

  recordAgentRun(agentId: string, findings: number, actionable: number, runTimeMs: number, tokenEstimate: number): void {
    if (!this.db.agents[agentId]) {
      this.db.agents[agentId] = {
        agentId,
        totalRuns: 0,
        findingsProduced: 0,
        actionableFindings: 0,
        averageRunTimeMs: 0,
        estimatedTokenCost: 0,
        valueScore: 0,
        enabled: true,
      };
    }

    const agent = this.db.agents[agentId];
    agent.totalRuns++;
    agent.findingsProduced += findings;
    agent.actionableFindings += actionable;
    agent.averageRunTimeMs = (agent.averageRunTimeMs * (agent.totalRuns - 1) + runTimeMs) / agent.totalRuns;
    agent.estimatedTokenCost = (agent.estimatedTokenCost * (agent.totalRuns - 1) + tokenEstimate) / agent.totalRuns;
    agent.valueScore = agent.estimatedTokenCost > 0 ? agent.actionableFindings / agent.estimatedTokenCost : 0;
  }

  /**
   * Determine which agents should be disabled for a given project.
   * Returns agent IDs that provide low value relative to cost.
   */
  pruneTopology(projectComplexity: 'simple' | 'medium' | 'complex'): string[] {
    const disabled: string[] = [];

    for (const agent of Object.values(this.db.agents)) {
      // Never disable core agents
      if (['feature-understanding', 'test-strategy', 'execution-engine', 'validation-engine'].includes(agent.agentId)) {
        continue;
      }

      // Disable if: ran 5+ times with 0 actionable findings
      if (agent.totalRuns >= 5 && agent.actionableFindings === 0) {
        agent.enabled = false;
        agent.disableReason = `Zero actionable findings after ${agent.totalRuns} runs`;
        disabled.push(agent.agentId);
        continue;
      }

      // For simple projects: disable advanced agents
      if (projectComplexity === 'simple') {
        if (['state-logic', 'consistency-analyzer'].includes(agent.agentId)) {
          agent.enabled = false;
          agent.disableReason = 'Project too simple — agent not needed';
          disabled.push(agent.agentId);
        }
      }

      // Cost-effectiveness check: if value score is bottom 25%
      const allScores = Object.values(this.db.agents).map(a => a.valueScore).sort((a, b) => a - b);
      const threshold = allScores[Math.floor(allScores.length * 0.25)] || 0;
      if (agent.totalRuns >= 10 && agent.valueScore < threshold && agent.valueScore > 0) {
        // Don't disable, but flag
        agent.disableReason = `Low value score: ${agent.valueScore.toFixed(4)} (threshold: ${threshold.toFixed(4)})`;
      }
    }

    return disabled;
  }

  /**
   * Get recommended agent topology for a run.
   */
  getActiveAgents(): AgentScore[] {
    return Object.values(this.db.agents).filter(a => a.enabled);
  }

  /**
   * Generate a report for the orchestrator.
   */
  generateReport(): string {
    const lines: string[] = [
      'Rule Scoring Report',
      '═'.repeat(50),
      '',
      'Rules (sorted by precision):',
    ];

    const rules = Object.values(this.db.rules).sort((a, b) => b.precision - a.precision);
    for (const rule of rules) {
      const status = rule.enabled ? (rule.precision >= 0.5 ? '✓' : '~') : '✗';
      lines.push(`  ${status} ${rule.ruleId.padEnd(12)} precision: ${(rule.precision * 100).toFixed(0)}%  triggered: ${rule.totalTriggered}  ${rule.enabled ? '' : '(DISABLED)'}`);
    }

    lines.push('');
    lines.push('Agent Topology:');

    const agents = Object.values(this.db.agents).sort((a, b) => b.valueScore - a.valueScore);
    for (const agent of agents) {
      const status = agent.enabled ? '✓' : '✗';
      lines.push(`  ${status} ${agent.agentId.padEnd(25)} value: ${agent.valueScore.toFixed(4)}  findings: ${agent.actionableFindings}/${agent.findingsProduced}  ${agent.disableReason || ''}`);
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  save(): void {
    this.db.lastUpdated = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
  }
}
