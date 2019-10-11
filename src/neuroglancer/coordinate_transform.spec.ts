/**
 * @license
 * Copyright 2019 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {boundingBoxesEqual, emptyCoordinateSpace, encodeTransformedBoundingBox, newDimensionId, TransformedBoundingBox} from 'neuroglancer/coordinate_transform';

describe('newDimensionId', () => {
  it('returns unique values', () => {
    const a = newDimensionId();
    const b = newDimensionId();
    const c = newDimensionId();
    expect(a === b).toBeFalsy();
    expect(a === c).toBeFalsy();
    expect(b === c).toBeFalsy();
  });
});

describe('boundingBoxesEqual', () => {
  it('works for simple examples', () => {
    const boxes: TransformedBoundingBox[] = [
      {
        inputScales: Float64Array.of(1, 2),
        outputScales: Float64Array.of(3, 4, 5),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        inputScales: Float64Array.of(1, 3),
        outputScales: Float64Array.of(3, 4, 5),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        inputScales: Float64Array.of(1, 2),
        outputScales: Float64Array.of(3, 4, 6),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        inputScales: Float64Array.of(1, 2),
        outputScales: Float64Array.of(3, 4, 5),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 10),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        inputScales: Float64Array.of(1, 2),
        outputScales: Float64Array.of(3, 4, 5),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 13), upperBounds: Float64Array.of(13, 14)},
      },
      {
        inputScales: Float64Array.of(1, 2),
        outputScales: Float64Array.of(3, 4, 5),
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 15)},
      }
    ];

    boxes.forEach((x, xIndex) => {
      boxes.forEach((y, yIndex) => {
        expect(boundingBoxesEqual(x, y))
            .toBe(
                x === y,
                `${xIndex}: ${JSON.stringify(encodeTransformedBoundingBox(x))}, ` +
                `${yIndex}: ${JSON.stringify(encodeTransformedBoundingBox(y))}`);
      });
    });
  });
});

describe('emptyCoordinateSpace', () => {
  it('has expected value', () => {
    expect(emptyCoordinateSpace.rank).toEqual(0);
    expect(emptyCoordinateSpace.valid).toEqual(false);
    expect(emptyCoordinateSpace.scales).toEqual(new Float64Array(0));
    expect(emptyCoordinateSpace.units).toEqual([]);
    expect(emptyCoordinateSpace.dimensionIds).toEqual([]);
    expect(emptyCoordinateSpace.dimensionNames).toEqual([]);
    expect(emptyCoordinateSpace.dimensionTimestamps).toEqual([]);
    expect(emptyCoordinateSpace.boundingBoxes).toEqual([]);
    expect(emptyCoordinateSpace.bounds)
        .toEqual({lowerBounds: new Float64Array(0), upperBounds: new Float64Array(0)});
  });
});
