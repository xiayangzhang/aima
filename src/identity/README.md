# src/identity

Filesystem-based identity loader. Reads Markdown files from a directory and parses YAML frontmatter to build an `IdentityCache`.

## IdentityLoader

```typescript
class IdentityLoader {
  constructor(identityDir: string)
  load(): Promise<IdentityCache>
}
```

`load()` reads the following files (all optional):

| File | Field in IdentityCache |
|------|----------------------|
| `soul.md` | `cache.soul` — injected into Block 1 of all brains |
| `skill-index.md` | `cache.skillIndex` — injected into Block 1 of all brains |
| `limbic.md` | `cache.roles.limbic` |
| `cortex.md` | `cache.roles.cortex` |
| `brainstem.md` | `cache.roles.brainstem` |

## IdentityCache

```typescript
interface IdentityCache {
  soul?: string
  skillIndex?: string
  roles: Partial<Record<CognitiveBrainType, RoleEntry>>
}
```

## RoleEntry

```typescript
interface RoleEntry {
  role: string          // from frontmatter 'role' field
  body: string          // Markdown body (after frontmatter), used as instructions
  allowedTools: string[] // from frontmatter 'allowed_tools' field
}
```

## Frontmatter Format

```markdown
---
role: Limbic — Communication & Routing
allowed_tools:
  - read
  - grep
  - workspace_read_slot
---

You are the Limbic brain. Your job is to ...
```

`parseFrontmatter(content)` — exported utility. Splits YAML frontmatter from Markdown body. Returns `{ data, body }`.

## Hot Reload

`AIMAInstance.reloadIdentity()` calls `identityLoader.load()` and then `threadRunner.updateAssemblerConfig()`. Already-running brain sessions retain their original tool policy; only new `brain:threadId` sessions pick up the updated identity.

## Dependencies

- `src/types/` — `CognitiveBrainType`
- Node `fs/promises` — file reading
