import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Dynamic locale discovery — automatically picks up new languages
// ---------------------------------------------------------------------------
const LOCALES_DIR = join(import.meta.dir, "../locales");
const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json"));

const locales: Record<string, Record<string, string>> = {};
for (const file of localeFiles) {
  const lang = file.replace(".json", "");
  locales[lang] = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf-8"));
}

const en = locales["en"];
if (!en) throw new Error("en.json is required as the source-of-truth locale");

const otherLangs = Object.entries(locales).filter(([lang]) => lang !== "en");
const enKeys = Object.keys(en);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract {{variable}} names from a translation string. */
function extractVars(value: string): string[] {
  const matches = value.match(/\{\{(\w+)\}\}/g) ?? [];
  return matches.map((m) => m.replace(/[{}]/g, "")).sort();
}

/** Check if a key is a plural variant (_one, _other, _zero, _few, _many). */
function isPluralKey(key: string): boolean {
  return /_(?:zero|one|two|few|many|other)$/.test(key);
}

/** Get the base key without the plural suffix. */
function pluralBase(key: string): string {
  return key.replace(/_(?:zero|one|two|few|many|other)$/, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("i18n locale parity", () => {
  // Key parity — run for each non-EN locale
  for (const [lang, translations] of otherLangs) {
    const langKeys = Object.keys(translations);

    it(`${lang} has all EN keys`, () => {
      const missing = enKeys.filter((k) => !(k in translations));
      expect(missing).toEqual([]);
    });

    it(`${lang} has no extra keys beyond EN`, () => {
      const extra = langKeys.filter((k) => {
        if (k in en) return false;
        // Allow extra plural forms (_few, _many, _zero, _two) when the
        // base plural pair (_one/_other) exists in EN. Languages like
        // Polish need _few/_many for correct grammar.
        if (isPluralKey(k)) {
          const base = pluralBase(k);
          return !(`${base}_one` in en && `${base}_other` in en);
        }
        return true;
      });
      expect(extra).toEqual([]);
    });

    it(`${lang} interpolation variables match EN`, () => {
      const mismatches: string[] = [];
      for (const key of langKeys) {
        // For keys that exist in EN, compare directly
        let referenceKey = key;
        if (!(key in en) && isPluralKey(key)) {
          // Extra plural form (_few/_many) — compare vars against _one
          referenceKey = `${pluralBase(key)}_one`;
        }
        if (!(referenceKey in en)) continue;
        const enVars = extractVars(en[referenceKey]!);
        const langVars = extractVars(translations[key]!);
        if (enVars.join(",") !== langVars.join(",")) {
          mismatches.push(
            `${key}: EN has {{${enVars.join(", ")}}} but ${lang} has {{${langVars.join(", ")}}}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("localizes every stable Creator Skill error code in every locale", () => {
    const stableCodes = [
      "VALIDATION_ERROR",
      "archive_policy_exceeded",
      "artifact_access_denied",
      "artifact_not_deletable",
      "artifact_not_found",
      "artifact_not_published",
      "artifact_slug_conflict",
      "artifact_type_not_allowed",
      "artifact_version_revoked",
      "checksum_mismatch",
      "content_digest_mismatch",
      "creator_skill_cancelled",
      "creator_skill_conflict",
      "creator_skill_download_failed",
      "creator_skill_feature_disabled",
      "creator_skill_force_delete_credential_required",
      "creator_skill_force_delete_stale",
      "creator_skill_install_failed",
      "creator_skill_not_installed",
      "creator_skill_operation_in_progress",
      "creator_skill_recovery_failed",
      "creator_skill_uninstall_failed",
      "idempotency_conflict",
      "invalid_backup_path",
      "invalid_creator_skill_operation_path",
      "invalid_operation_id",
      "invalid_skill_archive",
      "project_skill_conflict",
      "reference_unavailable",
      "skill_validation_failed",
      "upload_expired",
      "version_conflict",
      "version_not_deletable",
      "workspace_context_mismatch",
      "workspace_read_only",
    ];
    for (const code of stableCodes) {
      const key = `creatorSkills.errors.${code}`;
      expect(en[key]).toBeTruthy();
      for (const [lang, translations] of otherLangs) {
        expect(translations[key], `${lang} is missing ${key}`).toBeTruthy();
        expect(
          translations[key],
          `${lang} still uses the English text for ${key}`,
        ).not.toBe(en[key]);
      }
    }
  });

  it("does not ship English placeholders for representative Creator Skill UI copy", () => {
    const translatedKeys = [
      "creatorSkills.artifact.chooseType",
      "creatorSkills.backups.description",
      "creatorSkills.backups.operation.clean_uninstall_snapshot",
      "creatorSkills.backups.operation.concurrent_recreation",
      "creatorSkills.safety.stale",
      "creatorSkills.version.chooseZip",
      "skillInfo.requestedToolsDesc",
    ];
    for (const key of translatedKeys) {
      for (const [lang, translations] of otherLangs) {
        expect(translations[key], `${lang} is missing ${key}`).toBeTruthy();
        expect(
          translations[key],
          `${lang} still uses the English placeholder for ${key}`,
        ).not.toBe(en[key]);
      }
    }
  });

  // Plural form completeness — check every locale including EN
  for (const [lang, translations] of Object.entries(locales)) {
    it(`${lang} plural forms are complete (_one has _other and vice versa)`, () => {
      const keys = Object.keys(translations);
      const pluralKeys = keys.filter(isPluralKey);
      const orphans: string[] = [];

      for (const key of pluralKeys) {
        const base = pluralBase(key);
        const suffix = key.slice(base.length + 1); // e.g. "one", "other"

        // If _one exists, _other must exist (and vice versa)
        if (suffix === "one" && !(`${base}_other` in translations)) {
          orphans.push(`${key} exists but ${base}_other is missing`);
        }
        if (suffix === "other" && !(`${base}_one` in translations)) {
          orphans.push(`${key} exists but ${base}_one is missing`);
        }
      }
      expect(orphans).toEqual([]);
    });
  }

  // Key sorting — verify alphabetical order in each locale
  for (const [lang, translations] of Object.entries(locales)) {
    it(`${lang} keys are sorted alphabetically`, () => {
      const keys = Object.keys(translations);
      const sorted = [...keys].sort();
      const firstUnsorted = keys.findIndex((k, i) => k !== sorted[i]);
      if (firstUnsorted !== -1) {
        expect.unreachable(
          `Key "${keys[firstUnsorted]}" at index ${firstUnsorted} is out of order ` +
            `(expected "${sorted[firstUnsorted]}")`,
        );
      }
    });
  }
});
