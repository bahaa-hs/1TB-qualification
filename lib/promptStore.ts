/**
 * Reading and writing the system-prompt layer.
 *
 * Server-only: this reaches the settings table. Kept out of lib/prompt.ts so a
 * client component can import the types, defaults and assembly helpers without
 * dragging config → db → node:sqlite into the browser bundle, which fails the
 * build with an error that points nowhere near the cause.
 */

import { getSetting, setSetting } from "./config";
import { DEFAULT_PROMPT_LAYER, PROMPT_KEYS, type PromptLayer } from "./prompt";

export function loadPromptLayer(): PromptLayer {
  return {
    identity: getSetting(PROMPT_KEYS.identity) ?? DEFAULT_PROMPT_LAYER.identity,
    knowledge: getSetting(PROMPT_KEYS.knowledge) ?? DEFAULT_PROMPT_LAYER.knowledge,
    rules: getSetting(PROMPT_KEYS.rules) ?? DEFAULT_PROMPT_LAYER.rules,
    opening: getSetting(PROMPT_KEYS.opening) ?? DEFAULT_PROMPT_LAYER.opening,
    neverSay: getSetting(PROMPT_KEYS.neverSay) ?? DEFAULT_PROMPT_LAYER.neverSay,
  };
}

export function savePromptLayer(layer: PromptLayer): void {
  setSetting(PROMPT_KEYS.identity, layer.identity);
  setSetting(PROMPT_KEYS.knowledge, layer.knowledge);
  setSetting(PROMPT_KEYS.rules, layer.rules);
  setSetting(PROMPT_KEYS.opening, layer.opening);
  setSetting(PROMPT_KEYS.neverSay, layer.neverSay);
}
