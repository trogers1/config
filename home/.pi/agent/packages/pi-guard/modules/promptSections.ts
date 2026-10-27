import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const PromptSectionsEventSchema = Type.Object({
  systemPromptOptions: Type.Object({
    sections: Type.Record(Type.String(), Type.String()),
  }),
});

/** Require Pi 0.99.1's structured transcript contract; never replace prompt text. */
export function setPromptSection({
  event,
  name,
  content,
}: {
  event: unknown;
  name: string;
  content: string;
}): void {
  if (
    !Value.Check(PromptSectionsEventSchema, event) ||
    Array.isArray(event.systemPromptOptions.sections)
  ) {
    throw new Error(
      "Pi >=0.99.1 is required: before_agent_start structured prompt sections are missing or invalid",
    );
  }
  const sections = event.systemPromptOptions
    .sections satisfies BeforeAgentStartEvent["systemPromptOptions"]["sections"];
  sections[name] = content;
}
