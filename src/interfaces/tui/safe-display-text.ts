export function safeDisplayLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map(stripControls)
    .filter((line) => !/(authorization|bearer|api[_ -]?key|token)/iu.test(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function stripControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = character.charCodeAt(0);
    if (code === 0x1b) {
      const next = value[index + 1];
      if (next === "[") {
        index += 2;
        while (index < value.length && !isAnsiTerminator(value[index]!)) index += 1;
      } else if (next === "]") {
        index += 2;
        while (index < value.length && value[index] !== "\u0007") index += 1;
      }
      continue;
    }
    if (code >= 0x20 && (code < 0x7f || code > 0x9f)) result += character;
  }
  return result;
}

function isAnsiTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}
