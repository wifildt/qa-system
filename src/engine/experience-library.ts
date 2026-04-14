/**
 * ============================================================================
 * EXPERIENCE LIBRARY — Structured Memory That Learns
 * ============================================================================
 *
 * The brain of the QA system. NOT a raw log dump — a curated knowledge base
 * of high-value insights extracted from real test runs.
 *
 * 4 categories of experience:
 *   1. Failure Patterns   — "button not clickable after modal" + root cause
 *   2. Fix Strategies     — proven fixes with confidence scores
 *   3. Anti-Patterns      — test code smells that always cause problems
 *   4. Feature Knowledge  — hidden behaviors discovered during testing
 *
 * Key design decisions:
 *   - Global vs Project-specific experiences (prevents overfitting)
 *   - Confidence scores decay over time (stale knowledge fades)
 *   - Deduplication by semantic similarity (no 50 entries for same issue)
 *   - Max capacity with eviction (oldest + lowest confidence first)
 *
 * Usage:
 *   const lib = ExperienceLibrary.load('path/to/experience-db.json');
 *   lib.addFailurePattern({ ... });
 *   lib.query('selector', 'modal');  // finds relevant experiences
 *   lib.save();
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

type ExperienceCategory = 'failure_pattern' | 'fix_strategy' | 'anti_pattern' | 'feature_knowledge';
type ExperienceScope = 'global' | 'project';

interface BaseExperience {
  id: string;
  category: ExperienceCategory;
  scope: ExperienceScope;
  projectName?: string;          // Only if scope === 'project'
  tags: string[];                // For semantic search
  confidence: number;            // 0-1, decays over time
  useCount: number;              // How many times this was applied
  successCount: number;          // How many times it helped
  createdAt: string;
  lastUsedAt: string;
  source: string;                // Which agent/run created this
}

export interface FailurePattern extends BaseExperience {
  category: 'failure_pattern';
  pattern: string;               // Human-readable description
  errorSignature: string;        // Regex or key phrases to match
  rootCause: string;             // Why this happens
  affectedLayers: string[];      // ['ui', 'api', 'state']
  relatedFramework?: string;     // 'antd', 'react-router', etc.
  example: {
    error: string;               // Actual error message
    context: string;             // What the test was doing
  };
}

export interface FixStrategy extends BaseExperience {
  category: 'fix_strategy';
  triggerPattern: string;        // What failure triggers this fix
  strategy: string;              // Human-readable fix description
  implementation: string;        // Code-level fix (template or snippet)
  preconditions: string[];       // When this fix applies
  contraindications: string[];   // When this fix should NOT apply
  effectivenessScore: number;    // 0-1 based on historical success
}

export interface AntiPattern extends BaseExperience {
  category: 'anti_pattern';
  pattern: string;               // What the bad code looks like
  detection: string;             // Regex or AST pattern to detect
  whyBad: string;                // Why this causes problems
  betterAlternative: string;     // What to do instead
  severity: 'error' | 'warning';
}

export interface FeatureKnowledge extends BaseExperience {
  category: 'feature_knowledge';
  feature: string;               // Feature name
  behavior: string;              // What was discovered
  trigger: string;               // How to reproduce
  implication: string;           // What this means for testing
  discoveredFrom: string;        // 'execution' | 'code_analysis' | 'manual'
}

type Experience = FailurePattern | FixStrategy | AntiPattern | FeatureKnowledge;

interface ExperienceDB {
  version: string;
  lastUpdated: string;
  stats: {
    totalExperiences: number;
    byCategory: Record<ExperienceCategory, number>;
    byScope: Record<ExperienceScope, number>;
    averageConfidence: number;
  };
  experiences: Experience[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_EXPERIENCES = 500;
const CONFIDENCE_DECAY_PER_DAY = 0.005;   // Lose 0.5% per day unused (FE tests are noisy)
const MIN_CONFIDENCE_TO_KEEP = 0.15;       // Below this → evict (raised from 0.1)
const SIMILARITY_THRESHOLD = 0.7;          // Above this → deduplicate

// ============================================================================
// EXPERIENCE LIBRARY
// ============================================================================

export class ExperienceLibrary {
  private db: ExperienceDB;
  private dbPath: string;
  private dirty: boolean = false;

  private constructor(db: ExperienceDB, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static load(dbPath: string): ExperienceLibrary {
    const absPath = path.resolve(dbPath);
    let db: ExperienceDB;

    if (fs.existsSync(absPath)) {
      db = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    } else {
      db = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        stats: {
          totalExperiences: 0,
          byCategory: { failure_pattern: 0, fix_strategy: 0, anti_pattern: 0, feature_knowledge: 0 },
          byScope: { global: 0, project: 0 },
          averageConfidence: 0,
        },
        experiences: [],
      };
    }

    const lib = new ExperienceLibrary(db, absPath);
    lib.applyConfidenceDecay();
    return lib;
  }

  // --------------------------------------------------------------------------
  // WRITE — Add experiences
  // --------------------------------------------------------------------------

  addFailurePattern(input: Omit<FailurePattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>): string {
    // Check for duplicate
    const existing = this.findSimilar('failure_pattern', input.pattern, input.errorSignature);
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1); // Reinforce
      existing.useCount++;
      existing.lastUsedAt = new Date().toISOString();
      this.dirty = true;
      return existing.id;
    }

    const exp: FailurePattern = {
      ...input,
      id: this.generateId('FP'),
      category: 'failure_pattern',
      useCount: 0,
      successCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    return this.insert(exp);
  }

  addFixStrategy(input: Omit<FixStrategy, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>): string {
    const existing = this.findSimilar('fix_strategy', input.triggerPattern, input.strategy);
    if (existing) {
      // Merge: update effectiveness based on new data
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.useCount++;
      existing.lastUsedAt = new Date().toISOString();
      this.dirty = true;
      return existing.id;
    }

    const exp: FixStrategy = {
      ...input,
      id: this.generateId('FS'),
      category: 'fix_strategy',
      useCount: 0,
      successCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    return this.insert(exp);
  }

  addAntiPattern(input: Omit<AntiPattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>): string {
    const existing = this.findSimilar('anti_pattern', input.pattern, input.detection);
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.useCount++;
      this.dirty = true;
      return existing.id;
    }

    const exp: AntiPattern = {
      ...input,
      id: this.generateId('AP'),
      category: 'anti_pattern',
      useCount: 0,
      successCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    return this.insert(exp);
  }

  addFeatureKnowledge(input: Omit<FeatureKnowledge, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>): string {
    const exp: FeatureKnowledge = {
      ...input,
      id: this.generateId('FK'),
      category: 'feature_knowledge',
      useCount: 0,
      successCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    return this.insert(exp);
  }

  // --------------------------------------------------------------------------
  // READ — Query experiences
  // --------------------------------------------------------------------------

  /**
   * Query experiences by tags and/or category. Returns sorted by relevance.
   */
  query(
    ...tags: string[]
  ): Experience[] {
    const normalizedTags = tags.map(t => t.toLowerCase());

    return this.db.experiences
      .filter(exp => exp.confidence >= MIN_CONFIDENCE_TO_KEEP)
      .map(exp => ({
        exp,
        score: this.relevanceScore(exp, normalizedTags),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ exp }) => exp);
  }

  /**
   * Get experiences for a specific category.
   */
  getByCategory<T extends Experience>(category: ExperienceCategory): T[] {
    return this.db.experiences.filter(e => e.category === category) as T[];
  }

  /**
   * Get top fix strategies for a given error pattern.
   */
  getFixesForError(errorText: string): FixStrategy[] {
    return this.getByCategory<FixStrategy>('fix_strategy')
      .filter(fix => {
        try {
          return new RegExp(fix.triggerPattern, 'i').test(errorText);
        } catch {
          return errorText.toLowerCase().includes(fix.triggerPattern.toLowerCase());
        }
      })
      .sort((a, b) => b.effectivenessScore - a.effectivenessScore);
  }

  /**
   * Get all failure patterns matching an error message.
   */
  matchFailurePatterns(errorText: string): FailurePattern[] {
    return this.getByCategory<FailurePattern>('failure_pattern')
      .filter(fp => {
        try {
          return new RegExp(fp.errorSignature, 'i').test(errorText);
        } catch {
          return errorText.toLowerCase().includes(fp.errorSignature.toLowerCase());
        }
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get anti-patterns relevant to test validation.
   */
  getAntiPatterns(scope: ExperienceScope = 'global'): AntiPattern[] {
    return this.getByCategory<AntiPattern>('anti_pattern')
      .filter(ap => ap.scope === scope || ap.scope === 'global')
      .sort((a, b) => b.confidence - a.confidence);
  }

  // --------------------------------------------------------------------------
  // FEEDBACK — Record outcomes
  // --------------------------------------------------------------------------

  /**
   * Record that an experience was used and whether it helped.
   */
  recordOutcome(experienceId: string, success: boolean): void {
    const exp = this.db.experiences.find(e => e.id === experienceId);
    if (!exp) return;

    exp.useCount++;
    exp.lastUsedAt = new Date().toISOString();

    if (success) {
      exp.successCount++;
      exp.confidence = Math.min(1, exp.confidence + 0.05);
    } else {
      exp.confidence = Math.max(0, exp.confidence - 0.1);
    }

    // Update effectiveness for fix strategies
    if (exp.category === 'fix_strategy') {
      (exp as FixStrategy).effectivenessScore = exp.useCount > 0
        ? exp.successCount / exp.useCount
        : 0;
    }

    this.dirty = true;
  }

  // --------------------------------------------------------------------------
  // CONTEXT GENERATION — For prompt injection
  // --------------------------------------------------------------------------

  /**
   * Generate a context string for injection into AI agent prompts.
   * This is the "experience section" that evolves the prompt.
   */
  generatePromptContext(category: ExperienceCategory, maxEntries: number = 10, projectName?: string): string {
    const experiences = this.db.experiences
      .filter(e => e.category === category)
      .filter(e => e.confidence >= 0.3)
      .filter(e => e.scope === 'global' || e.projectName === projectName)
      .sort((a, b) => {
        // Sort by: confidence * (successCount / max(useCount, 1))
        const aScore = a.confidence * (a.successCount / Math.max(a.useCount, 1));
        const bScore = b.confidence * (b.successCount / Math.max(b.useCount, 1));
        return bScore - aScore;
      })
      .slice(0, maxEntries);

    if (experiences.length === 0) return '';

    const lines: string[] = ['## Learned from previous runs (apply these):'];

    for (const exp of experiences) {
      switch (exp.category) {
        case 'failure_pattern': {
          const fp = exp as FailurePattern;
          lines.push(`- FAILURE: "${fp.pattern}" → Root cause: ${fp.rootCause} (confidence: ${(fp.confidence * 100).toFixed(0)}%)`);
          break;
        }
        case 'fix_strategy': {
          const fs = exp as FixStrategy;
          lines.push(`- FIX: When "${fs.triggerPattern}" → ${fs.strategy} (effectiveness: ${(fs.effectivenessScore * 100).toFixed(0)}%)`);
          if (fs.contraindications.length > 0) {
            lines.push(`  BUT NOT when: ${fs.contraindications.join(', ')}`);
          }
          break;
        }
        case 'anti_pattern': {
          const ap = exp as AntiPattern;
          lines.push(`- AVOID: ${ap.pattern} → Instead: ${ap.betterAlternative}`);
          break;
        }
        case 'feature_knowledge': {
          const fk = exp as FeatureKnowledge;
          lines.push(`- KNOW: ${fk.feature}: ${fk.behavior} → Test implication: ${fk.implication}`);
          break;
        }
      }
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // MAINTENANCE
  // --------------------------------------------------------------------------

  /**
   * Apply confidence decay based on time since last use.
   */
  private applyConfidenceDecay(): void {
    const now = Date.now();
    let changed = false;

    for (const exp of this.db.experiences) {
      const lastUsed = new Date(exp.lastUsedAt).getTime();
      const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24);

      // Low-use experiences decay 2x faster (single-occurrence flukes fade quickly)
      const useMultiplier = exp.useCount <= 1 ? 2.0 : 1.0;
      const decay = daysSinceUse * CONFIDENCE_DECAY_PER_DAY * useMultiplier;

      if (decay > 0.01) {
        exp.confidence = Math.max(0, exp.confidence - decay);
        changed = true;
      }
    }

    if (changed) {
      this.evict();
      this.dirty = true;
    }
  }

  /**
   * Remove experiences below minimum confidence or over capacity.
   */
  private evict(): void {
    // Remove below threshold
    this.db.experiences = this.db.experiences.filter(e => e.confidence >= MIN_CONFIDENCE_TO_KEEP);

    // If still over capacity, remove lowest-scored
    if (this.db.experiences.length > MAX_EXPERIENCES) {
      this.db.experiences.sort((a, b) => {
        const aScore = a.confidence * Math.log2(Math.max(a.useCount, 1) + 1);
        const bScore = b.confidence * Math.log2(Math.max(b.useCount, 1) + 1);
        return bScore - aScore;
      });
      this.db.experiences = this.db.experiences.slice(0, MAX_EXPERIENCES);
    }
  }

  // --------------------------------------------------------------------------
  // PERSISTENCE
  // --------------------------------------------------------------------------

  save(): void {
    this.updateStats();
    this.db.lastUpdated = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
    this.dirty = false;
  }

  get isDirty(): boolean { return this.dirty; }
  get stats(): ExperienceDB['stats'] { return this.db.stats; }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  private insert(exp: Experience): string {
    this.db.experiences.push(exp);
    this.dirty = true;

    if (this.db.experiences.length > MAX_EXPERIENCES) {
      this.evict();
    }

    return exp.id;
  }

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  private findSimilar(category: ExperienceCategory, text1: string, text2: string): Experience | null {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const n1 = normalize(text1);
    const n2 = normalize(text2);

    for (const exp of this.db.experiences) {
      if (exp.category !== category) continue;

      let expText1 = '';
      let expText2 = '';

      switch (exp.category) {
        case 'failure_pattern':
          expText1 = (exp as FailurePattern).pattern;
          expText2 = (exp as FailurePattern).errorSignature;
          break;
        case 'fix_strategy':
          expText1 = (exp as FixStrategy).triggerPattern;
          expText2 = (exp as FixStrategy).strategy;
          break;
        case 'anti_pattern':
          expText1 = (exp as AntiPattern).pattern;
          expText2 = (exp as AntiPattern).detection;
          break;
      }

      const sim1 = this.jaccardSimilarity(n1, normalize(expText1));
      const sim2 = this.jaccardSimilarity(n2, normalize(expText2));

      if ((sim1 + sim2) / 2 >= SIMILARITY_THRESHOLD) {
        return exp;
      }
    }

    return null;
  }

  private jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(/\s+/));
    const setB = new Set(b.split(/\s+/));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private relevanceScore(exp: Experience, tags: string[]): number {
    const expTags = exp.tags.map(t => t.toLowerCase());
    let matches = 0;
    for (const tag of tags) {
      if (expTags.includes(tag)) matches++;
      // Partial match in other fields
      const allText = JSON.stringify(exp).toLowerCase();
      if (allText.includes(tag)) matches += 0.5;
    }
    return (matches / Math.max(tags.length, 1)) * exp.confidence;
  }

  private updateStats(): void {
    const exps = this.db.experiences;
    this.db.stats = {
      totalExperiences: exps.length,
      byCategory: {
        failure_pattern: exps.filter(e => e.category === 'failure_pattern').length,
        fix_strategy: exps.filter(e => e.category === 'fix_strategy').length,
        anti_pattern: exps.filter(e => e.category === 'anti_pattern').length,
        feature_knowledge: exps.filter(e => e.category === 'feature_knowledge').length,
      },
      byScope: {
        global: exps.filter(e => e.scope === 'global').length,
        project: exps.filter(e => e.scope === 'project').length,
      },
      averageConfidence: exps.length > 0
        ? exps.reduce((sum, e) => sum + e.confidence, 0) / exps.length
        : 0,
    };
  }
}
