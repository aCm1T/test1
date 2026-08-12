import { test, assert } from 'vitest';
import {
  AssetRegistry,
  validateManifest,
  type AssetLoader,
  type AssetManifest,
} from '../../src/engine/AssetRegistry.ts';

type Kind = 'mock';

function manifest(): AssetManifest<Kind> {
  return {
    version: '1',
    baseUrl: '/assets',
    assets: [
      { id: 'base', kind: 'mock', url: 'base.dat', bytes: 10 },
      {
        id: 'hero',
        kind: 'mock',
        url: 'hero.dat',
        dependencies: ['base'],
        preload: true,
        bytes: 30,
        license: { name: 'CC0' },
      },
      { id: 'missing', kind: 'mock', url: '404.dat', fallbackId: 'base' },
    ],
  };
}

test('registry deduplicates loads, resolves dependencies, and reports progress', async () => {
  const calls: string[] = [];
  const loader: AssetLoader<string, Kind> = {
    async load(context) {
      calls.push(context.entry.id);
      return context.resolvedUrl;
    },
  };
  const registry = new AssetRegistry(manifest(), { loaders: { mock: loader } });

  const [left, right] = await Promise.all([
    registry.load<string>('hero'),
    registry.load<string>('hero'),
  ]);
  assert.equal(left, '/assets/hero.dat');
  assert.equal(right, left);
  assert.deepEqual(calls, ['base', 'hero']);
  assert.equal(registry.getProgress().ready, 2);
  assert.deepEqual(registry.listAttributions(), [
    { id: 'hero', license: { name: 'CC0' } },
  ]);
});

test('failed assets resolve through a manifest fallback without double loading', async () => {
  const loader: AssetLoader<string, Kind> = {
    async load(context) {
      if (context.entry.id === 'missing') throw new Error('missing');
      return context.entry.id;
    },
  };
  const registry = new AssetRegistry(manifest(), { loaders: { mock: loader } });

  assert.equal(await registry.load('missing'), 'base');
  assert.equal(registry.getSnapshot('missing').status, 'fallback');
  assert.equal(registry.getSnapshot('missing').sourceId, 'base');
});

test('manifest validation rejects unknown references and dependency cycles', () => {
  assert.throws(
    () =>
      validateManifest<Kind>({
        version: '1',
        assets: [{ id: 'a', kind: 'mock', url: 'a', dependencies: ['nope'] }],
      }),
    /unknown dependency/,
  );
  assert.throws(
    () =>
      validateManifest<Kind>({
        version: '1',
        assets: [
          { id: 'a', kind: 'mock', url: 'a', dependencies: ['b'] },
          { id: 'b', kind: 'mock', url: 'b', dependencies: ['a'] },
        ],
      }),
    /cycle/,
  );
});
