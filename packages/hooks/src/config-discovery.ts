/**
 * @oa/hooks — Config file discovery
 *
 * Discovers hook configuration files from:
 * - <project>/.agents/hooks.json (project scope)
 * - ~/.agents/hooks.json (user scope)
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { HookConfig, ConfigLocation } from './types.js';

/** Default project config path */
export const PROJECT_CONFIG_PATH = '.agents/hooks.json';

/** Default user config path */
export const USER_CONFIG_PATH = '.agents/hooks.json';

/**
 * Discover config file locations.
 * Returns both project and user config locations with existence info.
 */
export function discoverConfigLocations(projectDir?: string): ConfigLocation[] {
  const locations: ConfigLocation[] = [];

  // Project config
  const projectPath = projectDir
    ? resolve(join(projectDir, PROJECT_CONFIG_PATH))
    : resolve(PROJECT_CONFIG_PATH);

  locations.push({
    path: projectPath,
    exists: existsSync(projectPath),
    scope: 'project',
  });

  // User config
  const userPath = resolve(join(homedir(), USER_CONFIG_PATH));

  locations.push({
    path: userPath,
    exists: existsSync(userPath),
    scope: 'user',
  });

  return locations;
}

/**
 * Find all existing config file paths.
 */
export function findConfigFiles(projectDir?: string): string[] {
  return discoverConfigLocations(projectDir)
    .filter((loc) => loc.exists)
    .map((loc) => loc.path);
}

/**
 * Load and parse a single config file.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadConfigFile(path: string): HookConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as HookConfig;

    // Basic validation
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load and merge config from multiple paths.
 * Later configs override earlier ones (user config takes precedence).
 */
export function loadMergedConfig(paths: string[]): HookConfig {
  let merged: HookConfig = { hooks: {} };

  for (const path of paths) {
    const config = loadConfigFile(path);
    if (config) {
      merged = mergeConfigs(merged, config);
    }
  }

  return merged;
}

/**
 * Load config from default locations (project + user).
 */
export function loadDefaultConfig(projectDir?: string): HookConfig {
  const paths = findConfigFiles(projectDir);
  return loadMergedConfig(paths);
}

/**
 * Merge two hook configurations.
 * Later config takes precedence for individual hooks.
 */
export function mergeConfigs(base: HookConfig, override: HookConfig): HookConfig {
  const merged: HookConfig = {
    hooks: { ...base.hooks },
    enabled: override.enabled ?? base.enabled,
    defaultTimeout: override.defaultTimeout ?? base.defaultTimeout,
    defaultMaxOutputBytes: override.defaultMaxOutputBytes ?? base.defaultMaxOutputBytes,
    metadata: { ...base.metadata, ...override.metadata },
  };

  // Merge hooks arrays for each event
  for (const [event, scripts] of Object.entries(override.hooks)) {
    if (scripts) {
      const existing = merged.hooks[event as keyof typeof merged.hooks] ?? [];
      merged.hooks[event as keyof typeof merged.hooks] = [...existing, ...scripts];
    }
  }

  return merged;
}

/**
 * Validate a hook configuration.
 * Returns an array of validation errors (empty if valid).
 */
export function validateConfig(config: HookConfig): string[] {
  const errors: string[] = [];

  if (config.hooks) {
    for (const [event, scripts] of Object.entries(config.hooks)) {
      if (!scripts) continue;

      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (!script.command) {
          errors.push(`Hook for event "${event}" at index ${i} is missing "command"`);
        }
        if (script.timeout !== undefined && script.timeout <= 0) {
          errors.push(`Hook for event "${event}" at index ${i} has invalid timeout`);
        }
        if (script.maxOutputBytes !== undefined && script.maxOutputBytes <= 0) {
          errors.push(`Hook for event "${event}" at index ${i} has invalid maxOutputBytes`);
        }
      }
    }
  }

  return errors;
}

/**
 * Get the default config file path for a given scope.
 */
export function getDefaultConfigPath(scope: 'project' | 'user', projectDir?: string): string {
  if (scope === 'project') {
    return projectDir
      ? resolve(join(projectDir, PROJECT_CONFIG_PATH))
      : resolve(PROJECT_CONFIG_PATH);
  }
  return resolve(join(homedir(), USER_CONFIG_PATH));
}
