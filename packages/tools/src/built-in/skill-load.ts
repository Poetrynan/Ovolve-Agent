/**
 * @oa/tools — Skill Loading Tool (built-in)
 *
 * Loads and activates skills during agent execution.
 * Skills can provide additional tools, knowledge, or behaviors.
 */

import { ToolDefinitionBuilder } from '../tool-definition';
import { ToolExecutionMode, ToolScope } from '../types';
import { RiskLevel } from '@oa/plugins';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../types';
import { createSuccessResult, createErrorResult, textContent, jsonContent } from '../tool-definition';

/**
 * Arguments for the skill_load tool.
 */
export interface SkillLoadArgs {
  /** Name of the skill to load. */
  skill_name: string;
  /** Optional version constraint. */
  version?: string;
  /** Optional configuration to pass to the skill. */
  config?: Record<string, unknown>;
}

/**
 * Skill metadata returned after loading.
 */
export interface SkillInfo {
  name: string;
  version: string;
  description: string;
  tools: string[];
  status: 'loaded' | 'already_loaded' | 'failed';
}

/**
 * Create the skill_load tool definition.
 */
export function createSkillLoadTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'skill_load',
    'Load and activate a skill to extend capabilities. Skills provide additional tools, knowledge, or specialized behaviors for specific tasks.'
  )
    .addString('skill_name', 'The name of the skill to load.', true)
    .addString('version', 'Optional version constraint (e.g., ">=1.0.0").', false)
    .addObject('config', 'Optional configuration to pass to the skill.', false)
    .setRiskLevel(RiskLevel.MEDIUM)
    .setExecutionMode(ToolExecutionMode.SEQUENTIAL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(60000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { skill_name, version, config } = args as unknown as SkillLoadArgs;

      try {
        // Check if skill is already loaded (via metadata).
        const loadedSkills = context.pluginContext.metadata['loadedSkills'] as string[] | undefined;
        if (loadedSkills?.includes(skill_name)) {
          const info: SkillInfo = {
            name: skill_name,
            version: version || 'latest',
            description: 'Skill was already loaded',
            tools: [],
            status: 'already_loaded',
          };
          return createSuccessResult(
            [textContent(`Skill "${skill_name}" is already loaded.`), jsonContent(info)],
            { toolName: 'skill_load' }
          );
        }

        // Simulate skill loading — in production this would:
        // 1. Resolve the skill from a registry or filesystem
        // 2. Validate version constraints
        // 3. Initialize the skill with config
        // 4. Register any tools the skill provides

        // Track loaded skills in metadata.
        const currentSkills = (context.pluginContext.metadata['loadedSkills'] as string[]) || [];
        currentSkills.push(skill_name);
        context.pluginContext.metadata['loadedSkills'] = currentSkills;

        const info: SkillInfo = {
          name: skill_name,
          version: version || 'latest',
          description: `Skill "${skill_name}" loaded successfully`,
          tools: [], // Would be populated by actual skill.
          status: 'loaded',
        };

        context.pluginContext.logger.info(`skill_load: loaded skill "${skill_name}"`);

        return createSuccessResult(
          [
            textContent(`Skill "${skill_name}" loaded successfully.`),
            jsonContent(info),
          ],
          { toolName: 'skill_load' }
        );
      } catch (err) {
        return createErrorResult(
          'SKILL_LOAD_FAILED',
          err instanceof Error ? err.message : String(err),
          true,
          { skillName: skill_name },
          { toolName: 'skill_load' }
        );
      }
    })
    .build();
}

/**
 * Create the skill_unload tool definition.
 */
export function createSkillUnloadTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'skill_unload',
    'Unload a previously loaded skill, freeing its resources and removing its tools.'
  )
    .addString('skill_name', 'The name of the skill to unload.', true)
    .setRiskLevel(RiskLevel.MEDIUM)
    .setExecutionMode(ToolExecutionMode.SEQUENTIAL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { skill_name } = args as unknown as { skill_name: string };

      try {
        const loadedSkills = context.pluginContext.metadata['loadedSkills'] as string[] | undefined;
        if (!loadedSkills?.includes(skill_name)) {
          return createErrorResult(
            'SKILL_NOT_LOADED',
            `Skill "${skill_name}" is not currently loaded.`,
            false,
            { loadedSkills: loadedSkills || [] },
            { toolName: 'skill_unload' }
          );
        }

        // Remove from loaded skills.
        const updatedSkills = loadedSkills.filter((s) => s !== skill_name);
        context.pluginContext.metadata['loadedSkills'] = updatedSkills;

        context.pluginContext.logger.info(`skill_unload: unloaded skill "${skill_name}"`);

        return createSuccessResult(
          textContent(`Skill "${skill_name}" unloaded successfully.`),
          { toolName: 'skill_unload' }
        );
      } catch (err) {
        return createErrorResult(
          'SKILL_UNLOAD_FAILED',
          err instanceof Error ? err.message : String(err),
          true,
          { skillName: skill_name },
          { toolName: 'skill_unload' }
        );
      }
    })
    .build();
}

/**
 * Create the skill_list tool definition.
 */
export function createSkillListTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'skill_list',
    'List all currently loaded skills and their status.'
  )
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(10000)
    .setExecutor(async (_args, context): Promise<ToolResult> => {
      try {
        const loadedSkills = (context.pluginContext.metadata['loadedSkills'] as string[]) || [];

        return createSuccessResult(
          [
            textContent(
              loadedSkills.length > 0
                ? `Loaded skills: ${loadedSkills.join(', ')}`
                : 'No skills currently loaded.'
            ),
            jsonContent({ skills: loadedSkills, count: loadedSkills.length }),
          ],
          { toolName: 'skill_list' }
        );
      } catch (err) {
        return createErrorResult(
          'SKILL_LIST_FAILED',
          err instanceof Error ? err.message : String(err),
          true,
          {},
          { toolName: 'skill_list' }
        );
      }
    })
    .build();
}
