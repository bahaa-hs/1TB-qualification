"use server";

import { revalidatePath } from "next/cache";
import { setSetting } from "@/lib/config";
import { llmFor } from "@/lib/llm";
import { providerConfigFor } from "@/lib/connections";
import {
  archiveCharacter,
  archivePlaybook,
  createCharacter,
  createPlaybook,
  defaultPlaybook,
  exportBrain,
  getCharacter,
  getPlaybook,
  importBrain,
  saveCharacter,
  savePlaybook,
  toCharacterSpec,
  type BrainExport,
} from "@/lib/brain";
import {
  buildPromptParts,
  builtinPlaceholderKeys,
  DEFAULT_PROMPT_LAYER,
  type PromptLayer,
} from "@/lib/prompt";
import { loadPromptLayer, savePromptLayer } from "@/lib/promptStore";
import {
  nearestKey,
  targetedCriteria,
  unknownPlaceholders,
  validateRegistry,
  type Criterion,
} from "@/lib/criteria";
import { listCriteria, saveCriteria } from "@/lib/criteriaStore";
import type { CharacterSpec, Collected } from "@/lib/playbook";
import { validatePlaybook, type PlaybookSpec } from "@/lib/playbookSpec";
import { runTurn, type TurnOutcome } from "@/lib/qualify";

/**
 * Reject a `{{token}}` that names nothing.
 *
 * Caught here rather than at runtime because the runtime failure is opaque: an
 * unknown token survives substitution by design, reaches the system prompt
 * verbatim, gets copied into the model's reply, and the placeholder guardrail
 * blocks the lead twice with an error naming neither the typo nor the field it
 * was in. An unknown token is an authoring mistake and belongs where the author
 * is looking.
 */
function placeholderProblems(where: string, text: string | undefined): string[] {
  if (!text) return [];
  const known = new Set([...builtinPlaceholderKeys(), ...listCriteria().map((c) => c.key)]);
  return unknownPlaceholders(text, known).map((token) => {
    const suggestion = nearestKey(token, [...known]);
    return `${where}: "{{${token}}}" isn't a criterion.${
      suggestion ? ` Did you mean {{${suggestion}}}?` : ""
    }`;
  });
}

// ─── Playbooks ───────────────────────────────────────────────────────────────

export async function savePlaybookAction(id: number, spec: PlaybookSpec): Promise<string[]> {
  const known = new Set(listCriteria().map((c) => c.key));
  const errors = validatePlaybook(spec, known);
  errors.push(...placeholderProblems("Instructions", spec.instructions));
  if (errors.length) return errors;
  savePlaybook(id, spec);
  revalidatePath("/brain");
  return [];
}

export async function createPlaybookAction(spec: PlaybookSpec): Promise<number> {
  const id = createPlaybook(spec);
  revalidatePath("/brain");
  return id;
}

export async function archivePlaybookAction(id: number): Promise<void> {
  archivePlaybook(id);
  revalidatePath("/brain");
}

// ─── Characters ──────────────────────────────────────────────────────────────

export async function saveCharacterAction(
  id: number,
  c: CharacterSpec,
  connectionId: number | null,
): Promise<void> {
  saveCharacter(id, c, connectionId);
  revalidatePath("/brain");
}

export async function createCharacterAction(
  c: CharacterSpec,
  connectionId: number | null,
): Promise<number> {
  const id = createCharacter(c, connectionId);
  revalidatePath("/brain");
  return id;
}

export async function archiveCharacterAction(id: number): Promise<void> {
  archiveCharacter(id);
  revalidatePath("/brain");
}

export async function setDefaultsAction(playbookId: number, characterId: number): Promise<void> {
  setSetting("brain.defaultPlaybookId", String(playbookId));
  setSetting("brain.defaultCharacterId", String(characterId));
  revalidatePath("/brain");
}

// ─── Sharing ─────────────────────────────────────────────────────────────────

export async function exportBrainAction(): Promise<BrainExport> {
  return exportBrain();
}

export async function importBrainAction(json: string): Promise<{ playbooks: number; characters: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const result = importBrain(parsed);
  revalidatePath("/brain");
  return result;
}

// ─── Qualification criteria ──────────────────────────────────────────────────

/**
 * Save the whole registry at once, the way the workflow editor saves a spec.
 *
 * Returns the problems rather than throwing, so the editor can list them the
 * same way it lists workflow problems.
 */
export async function saveCriteriaAction(registry: Criterion[]): Promise<string[]> {
  const errors = validateRegistry(registry);
  if (errors.length) return errors;
  saveCriteria(registry);
  revalidatePath("/brain");
  revalidatePath("/");
  return [];
}

// ─── The system-prompt layer ─────────────────────────────────────────────────

export async function savePromptLayerAction(layer: PromptLayer): Promise<string[]> {
  const errors = (["identity", "knowledge", "rules", "opening"] as const).flatMap((k) =>
    placeholderProblems(SECTION_LABELS[k], layer[k]),
  );
  if (errors.length) return errors;
  savePromptLayer(layer);
  revalidatePath("/brain");
  return [];
}

const SECTION_LABELS = {
  identity: "Identity",
  knowledge: "What it knows",
  rules: "Ground rules",
  opening: "First message",
} as const;

export async function resetPromptLayerAction(): Promise<PromptLayer> {
  savePromptLayer(DEFAULT_PROMPT_LAYER);
  revalidatePath("/brain");
  return DEFAULT_PROMPT_LAYER;
}

/**
 * Assemble the prompt for a given character without saving or sending it, so
 * an edit can be checked before it governs a real conversation.
 */
export async function previewPromptAction(
  layer: PromptLayer,
  characterId: number,
  isFirstMessage: boolean,
): Promise<{ heading: string; body: string; source: "yours" | "automatic" }[]> {
  const character = getCharacter(characterId);
  if (!character) throw new Error("That character no longer exists.");
  const registry = listCriteria();
  const playbook = defaultPlaybook();
  const targets = playbook ? targetedCriteria(registry, playbook.spec.criteriaKeys) : registry;

  const parts = buildPromptParts({
    layer,
    character: toCharacterSpec(character),
    lead: { firstName: "Alex", companyWebsite: "example-scraper.com", expectedVolume: "1TB+" },
    playbook: {
      instructions: playbook?.spec.instructions ?? "",
      defaultLanguage: playbook?.spec.defaultLanguage,
    },
    targets,
    collected: {},
    isFirstMessage,
    criteria: registry,
  });

  // Rebuild the same order renderSystemPrompt uses, tagging where each block
  // came from. Keeping one ordering would be better, but the preview needs the
  // provenance that the flattened string throws away.
  const yours = new Map(parts.editable.map((b) => [b.heading, b]));
  const auto = new Map(parts.automatic.map((b) => [b.heading, b]));
  const order: [string, "yours" | "automatic"][] = [
    ["", "yours"],
    ["VOICE", "automatic"],
    ["WHAT YOU KNOW", "yours"],
    ["YOUR PLAYBOOK", "automatic"],
    ["THE LEAD", "automatic"],
    ["ESTABLISHED IN THIS CONVERSATION", "automatic"],
    ["YOUR TASK THIS TURN", "automatic"],
    ["LANGUAGE", "automatic"],
    ["THIS IS THE FIRST MESSAGE", "yours"],
    ["RULES", "yours"],
    ["LIMITS", "automatic"],
    ["NEVER SAY", "yours"],
    ["", "automatic"],
  ];

  return order
    .map(([heading, source]) => {
      const block = source === "yours" ? yours.get(heading) : auto.get(heading);
      return block ? { heading: block.heading, body: block.body, source } : null;
    })
    .filter((b): b is { heading: string; body: string; source: "yours" | "automatic" } =>
      Boolean(b),
    );
}

// ─── The test panel ──────────────────────────────────────────────────────────

/**
 * Run one turn against the configured model without touching a real lead.
 *
 * This is the thing to use before pointing an untried model at a prospect —
 * autonomous sending means the first real message is also the first one you
 * can't take back.
 */
export async function runTestTurnAction(args: {
  playbookId: number;
  characterId: number;
  history: { role: "user" | "assistant"; content: string }[];
  collected: Collected;
}): Promise<TurnOutcome & { error?: string }> {
  const playbook = getPlaybook(args.playbookId);
  const character = getCharacter(args.characterId);
  if (!playbook) throw new Error("That playbook no longer exists.");
  if (!character) throw new Error("That character no longer exists.");

  const registry = listCriteria();
  const targets = targetedCriteria(registry, playbook.spec.criteriaKeys);
  const messagesSent = args.history.filter((m) => m.role === "assistant").length;

  try {
    // Same resolution as the real conversation engine, so the test panel
    // exercises the model this character would actually use.
    return await runTurn(llmFor(providerConfigFor(character.connection_id)), {
      playbook: playbook.spec,
      criteria: registry,
      targets,
      character: toCharacterSpec(character),
      lead: { firstName: "Alex", companyWebsite: "example-scraper.com", expectedVolume: "1TB+" },
      collected: args.collected,
      messagesSent,
      history: args.history,
      promptLayer: loadPromptLayer(),
    });
  } catch (e) {
    // Surface provider/connection problems in the panel rather than as a
    // Next.js error overlay — this is where people diagnose their setup.
    return {
      kind: "blocked",
      errors: [(e as Error).message],
      collected: args.collected,
      attempts: 0,
    };
  }
}
