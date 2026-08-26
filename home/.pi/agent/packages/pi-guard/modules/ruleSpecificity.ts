export type Specificity = {
  literalSegments: number;
  literalCharacters: number;
};

type TiebreakReason =
  "literal-segments" | "literal-characters" | "composition-order";

type ScoredRule = Specificity & {
  index: number;
};

export type RankedItem<T> = {
  item: T;
  index: number;
  score: Specificity;
  tiebreak?: TiebreakReason;
};

function compareSpecificity(left: ScoredRule, right: ScoredRule): number {
  if (left.literalSegments !== right.literalSegments) {
    return left.literalSegments - right.literalSegments;
  }
  if (left.literalCharacters !== right.literalCharacters) {
    return left.literalCharacters - right.literalCharacters;
  }
  return left.index - right.index;
}

function tiebreakReason(
  winner: Specificity,
  loser: Specificity,
): TiebreakReason {
  if (winner.literalSegments !== loser.literalSegments) {
    return "literal-segments";
  }
  if (winner.literalCharacters !== loser.literalCharacters) {
    return "literal-characters";
  }
  return "composition-order";
}

export function rankMatchingRules<T>(
  items: readonly T[],
  isMatch: (item: T) => boolean,
  score: (item: T) => Specificity,
): RankedItem<T>[] {
  const matches: RankedItem<T>[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isMatch(item)) continue;
    matches.push({ item, index, score: score(item) });
  }

  matches.sort((left, right) => {
    const comparison = compareSpecificity(
      { ...left.score, index: left.index },
      { ...right.score, index: right.index },
    );
    // Sort descending: most specific first.
    return comparison === 0 ? right.index - left.index : -comparison;
  });

  for (let rank = 0; rank < matches.length; rank++) {
    const current = matches[rank];
    const next = matches[rank + 1];
    if (!next) continue;
    current.tiebreak = tiebreakReason(current.score, next.score);
  }

  return matches;
}

export function chooseMostSpecific<T>(
  items: readonly T[],
  isMatch: (item: T) => boolean,
  score: (item: T) => Specificity,
): { item: T; index: number; score: Specificity } | undefined {
  const ranked = rankMatchingRules(items, isMatch, score);
  return ranked[0];
}

export function commandPatternSpecificity(pattern: string): Specificity {
  return patternSpecificity(pattern, /\s+/);
}

export function pathPatternSpecificity(pattern: string): Specificity {
  return patternSpecificity(pattern, /\//);
}

export function customToolMatchSpecificity(
  match: Record<string, string> | undefined,
): Specificity {
  if (!match) {
    return { literalSegments: 0, literalCharacters: 0 };
  }

  let literalSegments = 0;
  let literalCharacters = 0;

  for (const [propertyPath, pattern] of Object.entries(match)) {
    literalSegments += propertyPath.split(".").filter(Boolean).length;
    const specificity = patternSpecificity(pattern, /\s+/);
    literalSegments += specificity.literalSegments;
    literalCharacters += specificity.literalCharacters;
  }

  return { literalSegments, literalCharacters };
}

function patternSpecificity(
  pattern: string,
  tokenSeparator: RegExp,
): Specificity {
  const tokens = pattern
    .trim()
    .split(tokenSeparator)
    .map((token) => token.trim())
    .filter(Boolean);

  let literalSegments = 0;
  let literalCharacters = 0;

  for (const token of tokens) {
    const literalCharacterCount = countLiteralCharacters(token);
    if (literalCharacterCount > 0) {
      literalSegments += 1;
    }
    literalCharacters += literalCharacterCount;
  }

  return { literalSegments, literalCharacters };
}

function countLiteralCharacters(token: string): number {
  return token.replace(/[?*]/g, "").length;
}
