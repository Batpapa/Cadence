import { describe, it, expect } from 'vitest';
import { detectionReviewId, isAnalysisReviewId, reviewEntryTs } from './reviewLink';

const SESSION = '9f1c2d3e-0000-4000-8000-000000000001';
const OTHER = '9f1c2d3e-0000-4000-8000-000000000002';
const DETECTION = 'ab12cd34-0000-4000-8000-00000000000a';

describe('detectionReviewId', () => {
  it('names the analysis and the detection a rating came from', () => {
    expect(detectionReviewId(SESSION, DETECTION)).toBe(`analysis:${SESSION}:${DETECTION}`);
  });

  it('gives two detections of one analysis different ids', () => {
    expect(detectionReviewId(SESSION, DETECTION)).not.toBe(detectionReviewId(SESSION, 'other-detection'));
  });
});

describe('isAnalysisReviewId', () => {
  it('recognises its own analysis', () => {
    expect(isAnalysisReviewId(detectionReviewId(SESSION, DETECTION), SESSION)).toBe(true);
  });

  it('leaves another analysis alone', () => {
    expect(isAnalysisReviewId(detectionReviewId(OTHER, DETECTION), SESSION)).toBe(false);
  });

  // Whatever else may come to file ratings one day, this module answers for
  // its own ids and no others.
  it('leaves an id from somewhere else alone', () => {
    expect(isAnalysisReviewId(`something-else:${SESSION}:x`, SESSION)).toBe(false);
  });
});

describe('reviewEntryTs', () => {
  it('files the rating at the wall-clock instant the tune ended', () => {
    const start = Date.parse('2026-09-12T20:30:00.000Z');
    expect(reviewEntryTs(start, 754.5)).toBe(start + 754_500);
  });
});
