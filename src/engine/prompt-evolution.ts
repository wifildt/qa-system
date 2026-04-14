/**
 * ============================================================================
 * PROMPT EVOLUTION ENGINE — Prompts That Improve Themselves
 * ============================================================================
 *
 * Reads accumulated experience from Experience Library and injects
 * learned lessons into agent prompts. Prompts get better every run.
 *
 * How it works:
 *   1. Load base prompt template (from prompts/)
 *   2. Query Experience Library for relevant entries
 *   3. Inject "## Learned from previous runs" section
 *   4. Adjust selector priority based on fix success rates
 *   5. Add project-specific anti-patterns
 *   6. Output evolved prompt
 *
 * Key principle: AUGMENT, not replace. Base prompt stays intact.
 * Experience section is injected, never overwrites core instructions.
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ExperienceLibrary } from './experience-library.js';
import { StrategyEvolutionEngine } from './strategy-evolution.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================

interface EvolutionConfig {
  basePromptPath: string;       // Path to base prompt template
  agentType: string;            // 'ui-test' | 'api-test' | 'state-test' | etc.
  projectName?: string;         // For project-specific experience
  maxExperienceLines: number;   // Cap injected experience (default: 15)
  strategyEvolutionDbPath?: string; // Path to strategy-evolution-db.json
}

interface EvolvedPrompt {
  content: string;              // Full evolved prompt
  baseLength: number;           // Original prompt length
  injectedLength: number;       // Added experience length
  experiencesUsed: number;      // How many experiences were injected
  evolutionLog: string[];       // What was changed and why
}

// ============================================================================
// EVOLUTION ENGINE
// ============================================================================

export function evolvePrompt(
  config: EvolutionConfig,
  library: ExperienceLibrary
): EvolvedPrompt {
  const log: string[] = [];

  // 1. Load base prompt
  const basePrompt = fs.readFileSync(config.basePromptPath, 'utf-8');
  const baseLength = basePrompt.length;
  log.push(`Loaded base prompt: ${path.basename(config.basePromptPath)} (${baseLength} chars)`);

  const sections: string[] = [];
  let experiencesUsed = 0;

  // 2. Inject failure patterns (for test generators)
  if (['ui-test', 'api-test', 'state-test'].includes(config.agentType)) {
    const failureContext = library.generatePromptContext(
      'failure_pattern',
      Math.ceil(config.maxExperienceLines / 3),
      config.projectName
    );
    if (failureContext) {
      sections.push(failureContext);
      experiencesUsed += failureContext.split('\n').length - 1;
      log.push(`Injected ${failureContext.split('\n').length - 1} failure patterns`);
    }
  }

  // 3. Inject fix strategies (for self-healing and test generators)
  if (['ui-test', 'state-test', 'self-healing'].includes(config.agentType)) {
    const fixContext = library.generatePromptContext(
      'fix_strategy',
      Math.ceil(config.maxExperienceLines / 3),
      config.projectName
    );
    if (fixContext) {
      sections.push(fixContext);
      experiencesUsed += fixContext.split('\n').length - 1;
      log.push(`Injected ${fixContext.split('\n').length - 1} fix strategies`);
    }
  }

  // 4. Inject anti-patterns (for test generators and validation)
  const antiPatternContext = library.generatePromptContext(
    'anti_pattern',
    Math.ceil(config.maxExperienceLines / 4),
    config.projectName
  );
  if (antiPatternContext) {
    sections.push(antiPatternContext);
    experiencesUsed += antiPatternContext.split('\n').length - 1;
    log.push(`Injected ${antiPatternContext.split('\n').length - 1} anti-patterns`);
  }

  // 5. Inject feature knowledge (for feature understanding and test strategy)
  if (['feature-understanding', 'test-strategy'].includes(config.agentType)) {
    const featureContext = library.generatePromptContext(
      'feature_knowledge',
      Math.ceil(config.maxExperienceLines / 3),
      config.projectName
    );
    if (featureContext) {
      sections.push(featureContext);
      experiencesUsed += featureContext.split('\n').length - 1;
      log.push(`Injected ${featureContext.split('\n').length - 1} feature knowledge entries`);
    }
  }

  // 6. Build selector priority string from experience
  const selectorFixes = library.getByCategory<any>('fix_strategy')
    .filter(f => f.tags.includes('selector') && f.effectivenessScore > 0.6);

  if (selectorFixes.length > 0) {
    const selectorAdvice = [
      '',
      '## Selector Strategy (evolved from experience):',
      ...selectorFixes.slice(0, 5).map(f =>
        `- ${f.strategy} (effectiveness: ${(f.effectivenessScore * 100).toFixed(0)}%)`
      ),
    ].join('\n');
    sections.push(selectorAdvice);
    log.push(`Injected ${selectorFixes.length} selector strategy learnings`);
  }

  // 7. Inject strategy mutations (for test-strategy and test generators)
  if (['test-strategy', 'ui-test', 'api-test', 'state-test'].includes(config.agentType) && config.strategyEvolutionDbPath) {
    try {
      const stratEngine = StrategyEvolutionEngine.load(config.strategyEvolutionDbPath);
      const strategySection = stratEngine.generateStrategyPromptSection();
      if (strategySection) {
        sections.push(strategySection);
        const mutationCount = stratEngine.getActiveMutations().length + stratEngine.getConfirmedMutations().length;
        log.push(`Injected ${mutationCount} strategy mutation(s)`);
      }
    } catch {
      log.push('Strategy evolution DB not found or invalid — skipping');
    }
  }

  // 8. Assemble evolved prompt
  let evolvedContent = basePrompt;

  if (sections.length > 0) {
    const experienceBlock = [
      '',
      '---',
      '',
      '# EXPERIENCE (auto-injected from previous runs — DO NOT ignore)',
      '',
      ...sections,
      '',
      `> ${experiencesUsed} experiences injected. These are real lessons from past executions.`,
      '> Apply them proactively. They exist because ignoring them caused failures.',
      '',
    ].join('\n');

    // Inject before the last "## Rules" or "## Output" section
    const rulesIndex = basePrompt.lastIndexOf('## Rules');
    const outputIndex = basePrompt.lastIndexOf('## Output');
    const insertPoint = Math.max(
      rulesIndex > -1 ? rulesIndex : 0,
      outputIndex > -1 ? outputIndex : 0
    );

    if (insertPoint > 0) {
      evolvedContent = basePrompt.slice(0, insertPoint) + experienceBlock + '\n' + basePrompt.slice(insertPoint);
    } else {
      evolvedContent = basePrompt + experienceBlock;
    }

    log.push(`Total experience block: ${experienceBlock.length} chars`);
  } else {
    log.push('No relevant experience found — using base prompt unchanged');
  }

  return {
    content: evolvedContent,
    baseLength,
    injectedLength: evolvedContent.length - baseLength,
    experiencesUsed,
    evolutionLog: log,
  };
}

/**
 * Evolve all prompts for a project and write to a temp directory.
 */
export function evolveAllPrompts(
  promptsDir: string,
  library: ExperienceLibrary,
  projectName?: string,
  outputDir?: string,
  strategyEvolutionDbPath?: string,
): Map<string, EvolvedPrompt> {
  const results = new Map<string, EvolvedPrompt>();
  const outDir = outputDir || path.join(promptsDir, '.evolved');
  fs.mkdirSync(outDir, { recursive: true });

  const AGENT_TYPE_MAP: Record<string, string> = {
    '01-feature-understanding.md': 'feature-understanding',
    '02-test-strategy.md': 'test-strategy',
    '03-ui-test-generation.md': 'ui-test',
    '04-api-test-generation.md': 'api-test',
    '05-state-logic-validation.md': 'state-test',
    '06-consistency-analysis.md': 'consistency',
    '07-ux-validation.md': 'ux-validation',
    '08-report-generation.md': 'report',
  };

  for (const [file, agentType] of Object.entries(AGENT_TYPE_MAP)) {
    const promptPath = path.join(promptsDir, file);
    if (!fs.existsSync(promptPath)) continue;

    const evolved = evolvePrompt(
      {
        basePromptPath: promptPath,
        agentType,
        projectName,
        maxExperienceLines: 15,
        strategyEvolutionDbPath,
      },
      library
    );

    results.set(file, evolved);
    fs.writeFileSync(path.join(outDir, file), evolved.content);
  }

  return results;
}
