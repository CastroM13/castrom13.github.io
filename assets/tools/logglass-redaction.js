const TOKEN_PATTERNS = [
  [/\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, '[REDACTED_AUTH]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g, '[REDACTED_JWT]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:gh[pousr]_|github_pat_|ghs_)[A-Za-z0-9._-]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/(https?:\/\/[^\s?#]+\?[^\s#]*)/gi, (url) => redactUrl(url)],
  [/\b(?:cookie|set-cookie|x-api-key|x-auth-token)\s*[:=]\s*[^\s,;]+/gi, (value) => `${value.split(/[:=]/)[0]}=[REDACTED]`],
  [/((?:["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|token)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (_value, prefix) => `${prefix}"[REDACTED]"`]
];

export function redactLogLine(value, options = {}) {
  let redacted = value;
  for (const [pattern, replacement] of TOKEN_PATTERNS) { pattern.lastIndex = 0; redacted = redacted.replace(pattern, replacement); }
  if (options.email) redacted = redacted.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
  if (options.ip) redacted = redacted.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');
  return redacted;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) if (/(?:token|key|secret|pass|session|auth|credential|signature|sig|code)/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch (_) { return value; }
}
