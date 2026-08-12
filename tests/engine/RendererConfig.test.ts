import { describe, expect, it } from 'vitest';
import {
  isQACaptureBufferRequested,
  QA_CAPTURE_BUFFER_QUERY,
} from '../../src/engine/Renderer.ts';

describe('QA framebuffer opt-in', () => {
  it('is disabled unless the exact capture query value is supplied', () => {
    expect(isQACaptureBufferRequested('')).toBe(false);
    expect(isQACaptureBufferRequested('?qaCaptureBuffer=true')).toBe(false);
    expect(isQACaptureBufferRequested('?qaCaptureBuffer=0')).toBe(false);
    expect(isQACaptureBufferRequested('?unrelated=1')).toBe(false);
  });

  it('accepts the documented construction-time QA query regardless of parameter order', () => {
    expect(isQACaptureBufferRequested(`?${QA_CAPTURE_BUFFER_QUERY}=1`)).toBe(true);
    expect(isQACaptureBufferRequested(`quality=high&${QA_CAPTURE_BUFFER_QUERY}=1`)).toBe(true);
  });
});
