import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const rules = [
  ['absolute-home', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-key', /\b(?:sk|ghp|gho|github_pat)-?[A-Za-z0-9_]{25,}\b/],
  ['credential-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|xox[baprs]-[A-Za-z0-9-]{15,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/],
  ['signed-token', /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['embedded-url-auth', /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['remote-login', /\b[a-zA-Z0-9_.-]+@(?:\d{1,3}\.){3}\d{1,3}\b/],
]
const excluded = new Set(['.git', 'node_modules'])
const allowed = new Set(['.env.example'])
let count = 0
let failed = false
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(e.name)) continue
    const file = join(dir, e.name)
    const name = relative(root, file)
    if (e.isSymbolicLink()) { console.error(`${name}: symlink`); failed = true; continue }
    if (e.isDirectory()) {
      if (['credentials', 'sessions', 'vault', 'memory', 'logs'].includes(e.name)) {
        console.error(`${name}: disallowed runtime directory`)
        failed = true
      } else walk(file)
      continue
    }
    count++
    if (/^(?:config\.json|\.env(?:\..*)?)$/.test(e.name) && !allowed.has(e.name)
      || /\.(?:png|jpe?g|pdf|docx|jsonl|log|pem|key|sqlite|db|pth|pt|zip)$/.test(e.name)) {
      console.error(`${name}: disallowed release artifact`); failed = true
    }
    const text = readFileSync(file, 'utf8')
    for (const [rule, pattern] of rules) {
      if (pattern.test(text)) { console.error(`${name}: ${rule}`); failed = true }
    }
  }
}
walk(root)
console.log(`Privacy scan: ${count} files; ${failed ? 'REVIEW REQUIRED' : 'no rule matches'}`)
process.exitCode = failed ? 1 : 0
