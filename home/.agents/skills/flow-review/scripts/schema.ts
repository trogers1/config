import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const changeStatuses = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  unchanged: 'unchanged',
} as const;
export const verificationStatuses = { passed: 'passed', failed: 'failed', notRun: 'not-run' } as const;
export const findingStatuses = { agreed: 'agreed', disputed: 'disputed' } as const;

export const ChangeStatusSchema = Type.Union(Object.values(changeStatuses).map((value) => Type.Literal(value)));
export const VerificationStatusSchema = Type.Union(Object.values(verificationStatuses).map((value) => Type.Literal(value)));
export const FindingStatusSchema = Type.Union(Object.values(findingStatuses).map((value) => Type.Literal(value)));
export type ChangeStatus = Static<typeof ChangeStatusSchema>;
export type VerificationStatus = Static<typeof VerificationStatusSchema>;
export type FindingStatus = Static<typeof FindingStatusSchema>;

const TextSchema = Type.String({ minLength: 1, pattern: '\\S' });
const IdSchema = Type.String({ pattern: '^[a-z][a-z0-9-]*$' });
const SourceSchema = Type.Object({
  path: TextSchema,
  revision: Type.Optional(TextSchema),
  lines: Type.Optional(Type.Object({
    start: Type.Integer({ minimum: 1 }),
    end: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ExampleSchema = Type.Object({
  id: IdSchema,
  title: TextSchema,
  explanation: Type.Optional(TextSchema),
  before: Type.Optional(TextSchema),
  after: Type.Optional(TextSchema),
  code: Type.Optional(TextSchema),
  language: Type.Optional(TextSchema),
  pseudocode: Type.Optional(Type.Boolean()),
  sources: Type.Array(SourceSchema, { minItems: 1 }),
}, {
  additionalProperties: false,
  // Keep these fields optional in the inferred type while preserving the JSON contract.
  anyOf: [{ required: ['before'] }, { required: ['after'] }, { required: ['code'] }],
});
export type Example = Static<typeof ExampleSchema>;

export const ThemeSchema = Type.Object({
  id: IdSchema,
  title: TextSchema,
  explanation: TextSchema,
  examples: Type.Array(ExampleSchema, { minItems: 1 }),
}, { additionalProperties: false });
export type Theme = Static<typeof ThemeSchema>;

const NodeSchema = Type.Object({
  id: IdSchema,
  label: TextSchema,
  status: ChangeStatusSchema,
  exampleId: Type.Optional(IdSchema),
}, {
  additionalProperties: false,
  anyOf: [
    { properties: { status: { enum: [changeStatuses.unchanged] } } },
    { required: ['exampleId'] },
  ],
});
export const DiagramSchema = Type.Object({
  id: IdSchema,
  title: TextSchema,
  explanation: Type.Optional(TextSchema),
  nodes: Type.Array(NodeSchema, { minItems: 1 }),
  edges: Type.Array(Type.Object({
    from: IdSchema,
    to: IdSchema,
    label: Type.Optional(TextSchema),
    status: Type.Optional(ChangeStatusSchema),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
export type Diagram = Static<typeof DiagramSchema>;

export const ReviewSchema = Type.Object({
  title: TextSchema,
  summary: TextSchema,
  context: TextSchema,
  baseline: Type.Object({ base: TextSchema, head: TextSchema }, { additionalProperties: false }),
  themes: Type.Array(ThemeSchema, { minItems: 1 }),
  coverage: Type.Array(Type.Object({
    paths: Type.Array(TextSchema, { minItems: 1 }),
    explanation: TextSchema,
  }, { additionalProperties: false }), { minItems: 1 }),
  diagrams: Type.Optional(Type.Array(DiagramSchema, { minItems: 1 })),
  sections: Type.Optional(Type.Array(Type.Object({
    id: IdSchema,
    title: TextSchema,
    explanation: TextSchema,
  }, { additionalProperties: false }), { minItems: 1 })),
  verification: Type.Optional(Type.Array(Type.Object({
    command: TextSchema,
    status: VerificationStatusSchema,
    explanation: TextSchema,
  }, { additionalProperties: false }), { minItems: 1 })),
  findings: Type.Optional(Type.Array(Type.Object({
    id: IdSchema,
    title: TextSchema,
    explanation: TextSchema,
    status: FindingStatusSchema,
    exampleIds: Type.Array(IdSchema, { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }), { minItems: 1 })),
}, {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Narrative flow review',
  description: 'All prose is plain text, not Markdown or HTML. Paths are displayed as labels, never executed or linked. IDs are globally unique. Diagram endpoints refer to local nodes; example references refer to examples. Changed nodes require exampleId.',
  additionalProperties: false,
});
export type Review = Static<typeof ReviewSchema>;

export function parseOrThrow<T extends TSchema>({ unverifiedData, schema }: {
  unverifiedData: unknown;
  schema: T;
}): Static<T> {
  if (!Value.Check(schema, unverifiedData)) {
    const details = [...Value.Errors(schema, unverifiedData)]
      .map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
    throw new Error(`Invalid review: ${details}`);
  }
  return unverifiedData;
}

export function validateReferences({ data }: { data: Review }): void {
  const ids = new Set<string>();
  const register = ({ id }: { id: string }): void => {
    if (ids.has(id)) throw new Error(`Duplicate id: ${id}`);
    ids.add(id);
  };
  const examples = new Set(data.themes.flatMap((theme) => theme.examples.map((example) => example.id)));
  const reference = ({ id }: { id: string }): void => {
    if (!examples.has(id)) throw new Error(`Unknown example reference: ${id}`);
  };
  for (const theme of data.themes) {
    register(theme);
    for (const example of theme.examples) {
      register(example);
      if (example.before === undefined && example.after === undefined && example.code === undefined) {
        throw new Error(`Example ${example.id} requires before, after, or code`);
      }
      for (const source of example.sources) {
        if (source.lines?.end !== undefined && source.lines.end < source.lines.start) {
          throw new Error(`Reversed source lines in example ${example.id}`);
        }
      }
    }
  }
  for (const section of data.sections ?? []) register(section);
  for (const diagram of data.diagrams ?? []) {
    register(diagram);
    const nodes = new Set(diagram.nodes.map((node) => node.id));
    for (const node of diagram.nodes) {
      register(node);
      if (node.status !== changeStatuses.unchanged && node.exampleId === undefined) {
        throw new Error(`Changed node ${node.id} requires exampleId`);
      }
      if (node.exampleId !== undefined) reference({ id: node.exampleId });
    }
    for (const edge of diagram.edges) {
      for (const id of [edge.from, edge.to]) {
        if (!nodes.has(id)) throw new Error(`Unknown node reference ${id} in diagram ${diagram.id}`);
      }
    }
  }
  for (const finding of data.findings ?? []) {
    register(finding);
    for (const id of finding.exampleIds) reference({ id });
  }
}

export function parseReview({ unverifiedData }: { unverifiedData: unknown }): Review {
  const data = parseOrThrow({ unverifiedData, schema: ReviewSchema });
  validateReferences({ data });
  return data;
}
