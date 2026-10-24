const PATTERNS = [
  [/([?&]token=)[^&\s]+/gi, '$1<redacted>'],
  [/(authorization:\s*bearer\s+)[^\s]+/gi, '$1<redacted>'],
  [/(x-qoder-token:\s*)[^\s]+/gi, '$1<redacted>'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-<redacted>'],
]

export function redactSecrets(value) {
  let text = String(value ?? '')
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement)
  return text
}
