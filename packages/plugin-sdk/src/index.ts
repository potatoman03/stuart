import type { PluginManifest } from "@stuart/shared";

const PERMISSIONS = new Set(["network", "browser", "filesystem", "secrets"]);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validatePluginManifest(value: unknown): ValidationResult {
  const errors: string[] = [];
  const manifest = value as Partial<PluginManifest>;

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["Manifest must be an object."] };
  }

  for (const field of ["id", "name", "version", "description"] as const) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      errors.push(`Manifest field "${field}" must be a non-empty string.`);
    }
  }

  if (!Array.isArray(manifest.requiredPermissions)) {
    errors.push(`Manifest field "requiredPermissions" must be an array.`);
  } else {
    for (const permission of manifest.requiredPermissions) {
      if (!PERMISSIONS.has(permission)) {
        errors.push(`Unknown permission "${String(permission)}".`);
      }
    }
  }

  if (manifest.mcpServers && !Array.isArray(manifest.mcpServers)) {
    errors.push(`Manifest field "mcpServers" must be an array when provided.`);
  }

  if (manifest.commandForms && !Array.isArray(manifest.commandForms)) {
    errors.push(`Manifest field "commandForms" must be an array when provided.`);
  }

  if (manifest.workerRoles && !Array.isArray(manifest.workerRoles)) {
    errors.push(`Manifest field "workerRoles" must be an array when provided.`);
  }

  if (manifest.artifactTools && !Array.isArray(manifest.artifactTools)) {
    errors.push(`Manifest field "artifactTools" must be an array when provided.`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

