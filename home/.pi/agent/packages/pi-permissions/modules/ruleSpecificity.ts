type Specificity = {
  literalSegments: number;
  literalCharacters: number;
};

type ScoredRule = Specificity & {
  index: number;
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

export function chooseMostSpecific<T>(
  items: readonly T[],
  isMatch: (item: T) => boolean,
  score: (item: T) => Specificity,
): { item: T; index: number; score: Specificity } | undefined {
  let winner: { item: T; index: number; score: Specificity } | undefined;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isMatch(item)) continue;
    const candidate = { item, index, score: score(item) };
    if (!winner) {
      winner = candidate;
      continue;
    }

    if (
      compareSpecificity(
        { ...candidate.score, index: candidate.index },
        { ...winner.score, index: winner.index },
      ) > 0
    ) {
      winner = candidate;
    }
  }

  return winner;
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
