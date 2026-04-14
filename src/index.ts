/**
 * QA Agent Framework — Public API
 *
 * Self-learning, multi-agent QA framework for frontend applications.
 */

// Core engines
export { ExperienceLibrary } from './engine/experience-library.js';
export { extractExperiences } from './engine/experience-extractor.js';
export { runEngine as runValidation, validateFile, RULES } from './engine/validation-engine.js';
export { heal, diagnoseFailure, generateAutoFix } from './engine/self-healing-agent.js';
export { detectConventions } from './engine/convention-detector.js';
export { ProjectAdapter } from './engine/project-adapter.js';
export { evolvePrompt, evolveAllPrompts } from './engine/prompt-evolution.js';
export { RuleScoringSystem } from './engine/rule-scoring.js';

// Types
export type { EngineReport, ValidationResult, Violation } from './engine/validation-engine.js';
export type { HealingReport, DiagnosedFailure, AutoFix, LearningEntry } from './engine/self-healing-agent.js';
export type { DetectedConfig } from './engine/convention-detector.js';
export type {
  FailurePattern,
  FixStrategy,
  AntiPattern,
  FeatureKnowledge,
} from './engine/experience-library.js';
