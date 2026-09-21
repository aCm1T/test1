/**
 * Resolve files copied from Vite's public directory against the configured
 * deployment base. This keeps the same runtime valid at `/` and at a GitHub
 * Pages project path such as `/test1/`.
 */
export function assetUrl(path: string): string {
  const base = normalizeBase(import.meta.env.BASE_URL || '/');
  return `${base}${path.replace(/^\/+/, '')}`;
}

function normalizeBase(base: string): string {
  const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}
