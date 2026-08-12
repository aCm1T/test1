export type BuiltInAssetKind =
  | 'gltf'
  | 'ktx2'
  | 'texture'
  | 'image'
  | 'audio'
  | 'json'
  | 'text'
  | 'binary';

export type AssetStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'fallback'
  | 'error';

export interface AssetLicense {
  name: string;
  author?: string;
  source?: string;
  attribution?: string;
}

export interface AssetManifestEntry<Kind extends string = BuiltInAssetKind> {
  id: string;
  kind: Kind;
  url: string;
  /** Assets that must be ready before this entry's loader runs. */
  dependencies?: readonly string[];
  /** Entry returned if loading this asset fails. */
  fallbackId?: string;
  required?: boolean;
  preload?: boolean;
  tags?: readonly string[];
  bytes?: number;
  license?: AssetLicense;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AssetManifest<Kind extends string = BuiltInAssetKind> {
  version: string;
  baseUrl?: string;
  assets: readonly AssetManifestEntry<Kind>[];
}

export interface AssetLoadContext<Kind extends string> {
  entry: AssetManifestEntry<Kind>;
  resolvedUrl: string;
  signal: AbortSignal;
  getDependency<T = unknown>(id: string): T;
}

export interface AssetLoader<Value = unknown, Kind extends string = string> {
  load(context: AssetLoadContext<Kind>): Promise<Value>;
  dispose?(value: Value, entry: AssetManifestEntry<Kind>): void;
}

export type AssetLoaderMap<Kind extends string> = Partial<
  Record<Kind, AssetLoader<unknown, Kind>>
>;

export interface AssetSnapshot {
  id: string;
  status: AssetStatus;
  sourceId?: string;
  error?: unknown;
}

export interface AssetProgress {
  total: number;
  settled: number;
  ready: number;
  failed: number;
  totalBytes: number;
  settledBytes: number;
  ratio: number;
}

export interface AssetPreloadReport {
  loaded: string[];
  fallbacks: string[];
  failed: Array<{ id: string; error: unknown }>;
}

export interface AssetRegistryOptions<Kind extends string> {
  loaders?: AssetLoaderMap<Kind>;
}

interface AssetRecord<Kind extends string> {
  entry: AssetManifestEntry<Kind>;
  status: AssetStatus;
  value?: unknown;
  sourceId?: string;
  error?: unknown;
  promise?: Promise<unknown>;
}

/**
 * Manifest-backed, deduplicating asset cache. Three.js-specific GLTF/texture
 * loaders can be registered beside the built-in fetch loaders while all assets
 * share dependency, fallback, progress, attribution, and disposal behavior.
 */
export class AssetRegistry<Kind extends string = BuiltInAssetKind> {
  private readonly records = new Map<string, AssetRecord<Kind>>();
  private readonly loaders = new Map<string, AssetLoader<unknown, Kind>>();
  private readonly progressListeners = new Set<(progress: AssetProgress) => void>();
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(
    readonly manifest: AssetManifest<Kind>,
    options: AssetRegistryOptions<Kind> = {},
  ) {
    validateManifest(manifest);
    for (const entry of manifest.assets) {
      this.records.set(entry.id, { entry, status: 'idle' });
    }
    for (const [kind, loader] of Object.entries(options.loaders ?? {})) {
      if (loader) this.loaders.set(kind, loader as AssetLoader<unknown, Kind>);
    }
  }

  registerLoader(kind: Kind, loader: AssetLoader<unknown, Kind>): void {
    this.assertActive();
    this.loaders.set(kind, loader);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  getEntry(id: string): AssetManifestEntry<Kind> {
    return this.requireRecord(id).entry;
  }

  getSnapshot(id: string): AssetSnapshot {
    const record = this.requireRecord(id);
    return {
      id,
      status: record.status,
      sourceId: record.sourceId,
      error: record.error,
    };
  }

  get<T = unknown>(id: string): T {
    const record = this.requireRecord(id);
    if (record.status !== 'ready' && record.status !== 'fallback') {
      throw new Error(`Asset "${id}" is not ready (status: ${record.status})`);
    }
    return record.value as T;
  }

  async load<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
    this.assertActive();
    const promise = this.loadRecord(id);
    return raceWithAbort(promise, signal) as Promise<T>;
  }

  async preload(
    predicate: (entry: AssetManifestEntry<Kind>) => boolean =
      (entry) => entry.preload === true,
  ): Promise<AssetPreloadReport> {
    this.assertActive();
    const selected = this.manifest.assets.filter(predicate);
    const results = await Promise.allSettled(
      selected.map((entry) => this.load(entry.id)),
    );
    const report: AssetPreloadReport = {
      loaded: [],
      fallbacks: [],
      failed: [],
    };

    results.forEach((result, index) => {
      const entry = selected[index];
      const record = this.requireRecord(entry.id);
      if (result.status === 'rejected') {
        report.failed.push({ id: entry.id, error: result.reason });
      } else if (record.status === 'fallback') {
        report.fallbacks.push(entry.id);
      } else {
        report.loaded.push(entry.id);
      }
    });
    return report;
  }

  preloadTag(tag: string): Promise<AssetPreloadReport> {
    return this.preload((entry) => entry.tags?.includes(tag) === true);
  }

  onProgress(listener: (progress: AssetProgress) => void): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    listener(this.getProgress());
    return () => this.progressListeners.delete(listener);
  }

  getProgress(): AssetProgress {
    let settled = 0;
    let ready = 0;
    let failed = 0;
    let totalBytes = 0;
    let settledBytes = 0;

    for (const record of this.records.values()) {
      const bytes = Math.max(0, record.entry.bytes ?? 0);
      totalBytes += bytes;
      if (record.status === 'ready' || record.status === 'fallback') {
        settled += 1;
        ready += 1;
        settledBytes += bytes;
      } else if (record.status === 'error') {
        settled += 1;
        failed += 1;
        settledBytes += bytes;
      }
    }

    const total = this.records.size;
    return {
      total,
      settled,
      ready,
      failed,
      totalBytes,
      settledBytes,
      ratio: total === 0 ? 1 : settled / total,
    };
  }

  listAttributions(): Array<{ id: string; license: AssetLicense }> {
    return this.manifest.assets
      .filter(
        (entry): entry is AssetManifestEntry<Kind> & { license: AssetLicense } =>
          entry.license !== undefined,
      )
      .map((entry) => ({ id: entry.id, license: entry.license }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort(new DOMException('Asset registry disposed', 'AbortError'));

    for (const record of this.records.values()) {
      // Fallback records alias another record's value and must not double-dispose.
      if (record.status === 'ready' && record.value !== undefined) {
        const loader = this.loaders.get(record.entry.kind);
        loader?.dispose?.(record.value, record.entry);
      }
      record.promise = undefined;
      record.value = undefined;
      record.status = 'idle';
    }
    this.progressListeners.clear();
  }

  private loadRecord(id: string): Promise<unknown> {
    const record = this.requireRecord(id);
    if (record.status === 'ready' || record.status === 'fallback') {
      return Promise.resolve(record.value);
    }
    if (record.promise) return record.promise;

    record.status = 'loading';
    record.error = undefined;
    this.notifyProgress();

    record.promise = this.performLoad(record)
      .then((value) => value)
      .finally(() => {
        record.promise = undefined;
        this.notifyProgress();
      });
    return record.promise;
  }

  private async performLoad(record: AssetRecord<Kind>): Promise<unknown> {
    const { entry } = record;
    try {
      await Promise.all(
        (entry.dependencies ?? []).map((dependency) =>
          this.loadRecord(dependency),
        ),
      );
      const loader = this.loaders.get(entry.kind);
      if (!loader) {
        throw new Error(`No asset loader registered for kind "${entry.kind}"`);
      }

      const value = await loader.load({
        entry,
        resolvedUrl: resolveAssetUrl(this.manifest.baseUrl, entry.url),
        signal: this.abortController.signal,
        getDependency: <T>(id: string): T => this.get<T>(id),
      });
      if (this.disposed) {
        loader.dispose?.(value, entry);
        throw new DOMException('Asset registry disposed', 'AbortError');
      }

      record.value = value;
      record.sourceId = entry.id;
      record.status = 'ready';
      return value;
    } catch (error) {
      record.error = error;
      if (entry.fallbackId && !isAbortError(error) && !this.disposed) {
        try {
          const fallbackValue = await this.loadRecord(entry.fallbackId);
          const fallbackRecord = this.requireRecord(entry.fallbackId);
          record.value = fallbackValue;
          record.sourceId = fallbackRecord.sourceId ?? entry.fallbackId;
          record.status = 'fallback';
          return fallbackValue;
        } catch (fallbackError) {
          const combined = new AggregateError(
            [error, fallbackError],
            `Asset "${entry.id}" and fallback "${entry.fallbackId}" failed`,
          );
          record.error = combined;
        }
      }
      record.status = 'error';
      throw record.error;
    }
  }

  private requireRecord(id: string): AssetRecord<Kind> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown asset id "${id}"`);
    return record;
  }

  private notifyProgress(): void {
    if (this.progressListeners.size === 0) return;
    const progress = this.getProgress();
    for (const listener of [...this.progressListeners]) listener(progress);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('AssetRegistry has been disposed');
  }
}

/** Standard fetch-based loaders; Three.js loaders are registered separately. */
export function createFetchAssetLoaders(
  fetcher: typeof fetch = fetch,
): AssetLoaderMap<BuiltInAssetKind> {
  const request = async (
    context: AssetLoadContext<BuiltInAssetKind>,
  ): Promise<Response> => {
    const response = await fetcher(context.resolvedUrl, {
      signal: context.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to load "${context.entry.id}": ${response.status} ${response.statusText}`,
      );
    }
    return response;
  };

  return {
    json: { load: async (context) => (await request(context)).json() },
    text: { load: async (context) => (await request(context)).text() },
    binary: { load: async (context) => (await request(context)).arrayBuffer() },
    audio: { load: async (context) => (await request(context)).arrayBuffer() },
    image: { load: async (context) => (await request(context)).blob() },
  };
}

export function validateManifest<Kind extends string>(
  manifest: AssetManifest<Kind>,
): void {
  if (!manifest.version.trim()) throw new Error('Asset manifest version is required');
  const ids = new Set<string>();
  for (const entry of manifest.assets) {
    if (!entry.id.trim()) throw new Error('Asset ids must not be empty');
    if (ids.has(entry.id)) throw new Error(`Duplicate asset id "${entry.id}"`);
    if (!entry.kind.trim()) throw new Error(`Asset "${entry.id}" has no kind`);
    if (!entry.url.trim()) throw new Error(`Asset "${entry.id}" has no URL`);
    if (entry.bytes !== undefined && (!Number.isFinite(entry.bytes) || entry.bytes < 0)) {
      throw new Error(`Asset "${entry.id}" has invalid byte size`);
    }
    ids.add(entry.id);
  }

  for (const entry of manifest.assets) {
    for (const dependency of entry.dependencies ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`Asset "${entry.id}" references unknown dependency "${dependency}"`);
      }
    }
    if (entry.fallbackId && !ids.has(entry.fallbackId)) {
      throw new Error(`Asset "${entry.id}" references unknown fallback "${entry.fallbackId}"`);
    }
  }

  const entries = new Map(manifest.assets.map((entry) => [entry.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Asset manifest contains a cycle at "${id}"`);
    if (visited.has(id)) return;
    visiting.add(id);
    const entry = entries.get(id)!;
    for (const dependency of entry.dependencies ?? []) visit(dependency);
    if (entry.fallbackId) visit(entry.fallbackId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function resolveAssetUrl(baseUrl: string | undefined, url: string): string {
  if (!baseUrl || /^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:')) {
    return url;
  }
  return `${baseUrl.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort),
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
