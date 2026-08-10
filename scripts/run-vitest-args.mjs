export function buildVitestArguments(configuredSuite, forwarded) {
  return configuredSuite === "--all"
    ? forwarded
    : [...forwarded, `--dir=${configuredSuite}`];
}
