export const PERFORMANCE_SAMPLE_FIELDS = Object.freeze([
  'timestampMs',
  'frameMs',
  'gpuMs',
  'mainThreadMs',
  'drawCalls',
  'triangles',
]);

export const PERFORMANCE_TOOL = 'NIGHTGLASS built-in WebGL2 sampler v1';
export const GPU_ASSET_ESTIMATION = 'unique scene buffer and texture payload bytes';

export function derivePerformanceMetrics(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error('raw performance evidence must contain at least two frames');
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    for (const field of PERFORMANCE_SAMPLE_FIELDS) {
      if (!Number.isFinite(sample?.[field]) || sample[field] < 0) {
        throw new Error(`sample ${index + 1}.${field} must be a finite non-negative number`);
      }
    }
    if (sample.frameMs <= 0) throw new Error(`sample ${index + 1}.frameMs must be positive`);
    if (sample.gpuDisjoint !== false) {
      throw new Error(`sample ${index + 1}.gpuDisjoint must be false`);
    }
    if (index > 0 && sample.timestampMs <= samples[index - 1].timestampMs) {
      throw new Error(`sample ${index + 1}.timestampMs must be strictly increasing`);
    }
  }
  const durationSeconds = (samples.at(-1).timestampMs - samples[0].timestampMs) / 1000;
  if (!(durationSeconds > 0)) throw new Error('raw sample duration must be positive');
  const frames = samples.map((sample) => sample.frameMs);
  const gpu = samples.map((sample) => sample.gpuMs);
  const main = samples.map((sample) => sample.mainThreadMs);
  const calls = samples.map((sample) => sample.drawCalls);
  const triangles = samples.map((sample) => sample.triangles);
  return {
    sustainedFps: (samples.length - 1) / durationSeconds,
    p95FrameMs: percentile(frames, 0.95),
    gpuMs: percentile(gpu, 0.95),
    mainThreadMs: percentile(main, 0.95),
    onePercentLowFps: 1000 / percentile(frames, 0.99),
    typicalDrawCalls: percentile(calls, 0.5),
    peakDrawCalls: Math.max(...calls),
    typicalTriangles: percentile(triangles, 0.5),
    peakTriangles: Math.max(...triangles),
    durationSeconds,
  };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile requires values');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
