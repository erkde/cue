const CUE_PREFIX = /^\s*<!--\s*cue:/i;
const CUE_DIRECTIVE = /^\s*<!--\s*cue:([a-z][a-z0-9-]*)(.*?)-->\s*$/i;
const ATTRIBUTE = /^([a-z][a-z0-9-]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*/i;

const ACTION_ATTRIBUTES = {
  stop: new Set(['message']),
};

export function isCueDirectiveLine(line) {
  return CUE_PREFIX.test(line);
}

export function parseCueDirective(line) {
  if (!isCueDirectiveLine(line)) return null;

  const directive = CUE_DIRECTIVE.exec(line);
  if (!directive) return { error: 'Malformed Cue directive' };

  const action = directive[1].toLowerCase();
  const attributes = {};
  let rest = directive[2].trim();

  while (rest) {
    const attribute = ATTRIBUTE.exec(rest);
    if (!attribute) {
      return { action, attributes, error: `Malformed attributes for cue:${action}` };
    }

    const name = attribute[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      return { action, attributes, error: `Duplicate attribute "${name}" for cue:${action}` };
    }

    try {
      attributes[name] = JSON.parse(`"${attribute[2]}"`);
    } catch {
      return { action, attributes, error: `Invalid value for "${name}" in cue:${action}` };
    }
    rest = rest.slice(attribute[0].length);
  }

  const allowed = ACTION_ATTRIBUTES[action];
  if (!allowed) return { action, attributes, error: `Unsupported Cue action: ${action}` };

  const unknown = Object.keys(attributes).find((name) => !allowed.has(name));
  if (unknown)
    return { action, attributes, error: `Unsupported attribute "${unknown}" for cue:${action}` };

  return { action, attributes };
}

export function directiveIdsBefore(directives, cursor) {
  return new Set(
    directives
      .filter((directive) => !directive.error && directive.afterWordIndex < cursor)
      .map((directive) => directive.id),
  );
}

export function nextDirectiveAtOrBefore(directives, firedIds, cursor) {
  return directives.find(
    (directive) =>
      !directive.error && !firedIds.has(directive.id) && directive.afterWordIndex <= cursor,
  );
}

export function measureDirectiveFiring(directive, matchedCursor, previousCursor, scriptWords) {
  return {
    markerWord: directive.afterWordIndex,
    matchedWord: matchedCursor,
    overshootWords: matchedCursor - directive.afterWordIndex,
    cursorJumpWords: matchedCursor - previousCursor,
    scriptWords,
    markerPct: scriptWords ? Math.round(((directive.afterWordIndex + 1) / scriptWords) * 100) : 0,
    hasMessage: Boolean(directive.attributes?.message?.trim()),
  };
}
