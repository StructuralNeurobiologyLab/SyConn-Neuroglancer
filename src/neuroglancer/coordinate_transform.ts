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

import {WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual, arraysEqualWithPredicate, getInsertPermutation} from 'neuroglancer/util/array';
import {expectArray, parseArray, parseFiniteVec, parseFixedLengthArray, verifyFiniteFloat, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {supportedUnits, unitFromJson} from 'neuroglancer/util/si_units';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import * as vector from 'neuroglancer/util/vector';

export type DimensionId = number;

let nextDimensionId = 0;

export function newDimensionId(): DimensionId {
  return ++nextDimensionId;
}

export interface CoordinateSpace {
  /**
   * If `true`, has been fully initialized (i.e. based on at least one data source).  If `false`,
   * may be partially initialized.
   */
  readonly valid: boolean;

  readonly rank: number;

  /**
   * Specifies the name of each dimension.
   */
  readonly dimensionNames: readonly string[];

  readonly dimensionIds: readonly DimensionId[];

  /**
   * Timestamp of last user action that changed the name, scale, or unit of each dimension, or
   * `undefined` if there was no user action.
   */
  readonly dimensionTimestamps: readonly number[];

  /**
   * Specifies the physical units corresponding to this dimension.  May be empty to indicate
   * unitless.
   */
  readonly units: readonly string[];

  /**
   * Specifies a scale for this dimension.
   */
  readonly scales: Float64Array;

  readonly bounds: BoundingBox;
  readonly boundingBoxes: readonly TransformedBoundingBox[];
}

export function boundingBoxesEqual(a: TransformedBoundingBox, b: TransformedBoundingBox) {
  return arraysEqual(a.inputScales, b.inputScales) && arraysEqual(a.transform, b.transform) &&
      arraysEqual(a.outputScales, b.outputScales) &&
      arraysEqual(a.box.lowerBounds, b.box.lowerBounds) &&
      arraysEqual(a.box.upperBounds, b.box.upperBounds);
}

export function coordinateSpacesEqual(a: CoordinateSpace, b: CoordinateSpace) {
  return (
      a.valid === b.valid && a.rank === b.rank && arraysEqual(a.dimensionNames, b.dimensionNames) &&
      arraysEqual(a.dimensionIds, b.dimensionIds) &&
      arraysEqual(a.dimensionTimestamps, b.dimensionTimestamps) && arraysEqual(a.units, b.units) &&
      arraysEqual(a.scales, b.scales) &&
      arraysEqualWithPredicate(a.boundingBoxes, b.boundingBoxes, boundingBoxesEqual));
}

function encodeBoundingBox(b: BoundingBox) {
  return {lowerBounds: Array.from(b.lowerBounds), upperBounds: Array.from(b.upperBounds)};
}

export function encodeTransformedBoundingBox(b: TransformedBoundingBox) {
  return {transform: Array.from(b.transform), box: encodeBoundingBox(b.box)};
}

/**
 * Encode a coordinate space as JSON for use in a cache key.
 */
export function encodeCoordinateSpace(space: CoordinateSpace) {
  return {
    dimensions: space.dimensionNames,
    dimensionIds: space.dimensionIds,
    units: space.units,
    scales: Array.from(space.scales),
    boundingBoxes: Array.from(space.boundingBoxes, encodeTransformedBoundingBox)
  };
}

export function unitsFromJson(units: string[], scaleExponents: Float64Array, obj: any) {
  parseFixedLengthArray(units, obj, (x: any, index: number) => {
    const result = unitFromJson(x);
    scaleExponents[index] = result.exponent;
    return result.unit;
  });
}

export function makeCoordinateSpace(space: {
  readonly valid?: boolean,
  readonly dimensionNames: readonly string[],
  readonly units: readonly string[],
  readonly scales: Float64Array,
  readonly rank?: number,
  readonly dimensionTimestamps?: readonly number[],
  readonly dimensionIds?: readonly DimensionId[],
  readonly boundingBoxes?: readonly TransformedBoundingBox[],
  readonly bounds?: BoundingBox
}): CoordinateSpace {
  const {dimensionNames, units, scales} = space;
  const {
    valid = true,
    rank = dimensionNames.length,
    dimensionTimestamps = [],
    dimensionIds = dimensionNames.map((_, i) => -i),
    boundingBoxes = []
  } = space;
  const {bounds = computeCombinedBounds(boundingBoxes, scales)} = space;
  return {
    valid,
    rank,
    dimensionNames,
    dimensionTimestamps,
    dimensionIds,
    units,
    scales,
    boundingBoxes,
    bounds
  };
}

export const emptyCoordinateSpace = makeCoordinateSpace({
  valid: false,
  dimensionNames: [],
  units: [],
  scales: vector.kEmptyFloat64Vec,
  boundingBoxes: [],
});

export function coordinateSpaceFromJson(obj: any): CoordinateSpace {
  if (obj === undefined) return emptyCoordinateSpace;
  verifyObject(obj);
  const dimensionNames = dimensionNamesFromJson(Object.keys(obj));
  const rank = dimensionNames.length;
  const units = new Array<string>(rank);
  const scales = new Float64Array(rank);
  for (let i = 0; i < rank; ++i) {
    verifyObjectProperty(obj, dimensionNames[i], mem => {
      if (!Array.isArray(mem) || mem.length !== 2) {
        throw new Error(`Expected array of length 2, but received: ${JSON.stringify(mem)}`);
      }
      const scale = verifyFinitePositiveFloat(mem[0]);
      const unitString = verifyString(mem[1]);
      const result = supportedUnits.get(unitString);
      if (result === undefined) throw new Error(`Invalid unit: ${JSON.stringify(unitString)}`);
      units[i] = result.unit;
      scales[i] = scale * 10 ** result.exponent;
    });
  }
  return makeCoordinateSpace({valid: false, dimensionNames, units, scales});
}

export function coordinateSpaceToJson(coordinateSpace: CoordinateSpace): any {
  const {rank} = coordinateSpace;
  if (rank === 0) return undefined;
  const {dimensionNames, units, scales} = coordinateSpace;
  const json: any = {};
  for (let i = 0; i < rank; ++i) {
    json[dimensionNames[i]] = [scales[i], units[i]];
  }
  return json;
}

export class TrackableCoordinateSpace extends WatchableValue<CoordinateSpace> {
  constructor() {
    super(emptyCoordinateSpace);
  }

  toJSON() {
    return coordinateSpaceToJson(this.value);
  }
  reset() {
    this.value = emptyCoordinateSpace;
  }
  restoreState(obj: any) {
    this.value = coordinateSpaceFromJson(obj);
  }
}

export interface BoundingBox {
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
}

export function getCenterBound(lower: number, upper: number) {
  let x = (lower + upper) / 2;
  if (!Number.isFinite(x)) x = Math.min(Math.max(0, lower), upper);
  return x;
}

export function getBoundingBoxCenter(out: Float32Array, bounds: BoundingBox): Float32Array {
  const {lowerBounds, upperBounds} = bounds;
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = getCenterBound(lowerBounds[i], upperBounds[i]);
  }
  return out;
}

export interface TransformedBoundingBox {
  box: BoundingBox;

  inputScales: Float64Array;

  outputScales: Float64Array;

  /**
   * Transform from "box" coordinate space to target coordinate space.
   */
  transform: Float64Array;
}

export function computeCombinedLowerUpperBound(
    boundingBox: TransformedBoundingBox, outputDimension: number,
    outputScale: number): {lower: number, upper: number}|undefined {
  const {
    box: {lowerBounds: baseLowerBounds, upperBounds: baseUpperBounds},
    transform,
    inputScales,
    outputScales: baseOutputScales
  } = boundingBox;
  const inputRank = baseLowerBounds.length;
  const outputRank = baseOutputScales.length;
  const stride = outputRank;
  const offset = transform[stride * inputRank + outputDimension] *
      (boundingBox.outputScales[outputDimension] / outputScale);
  let targetLower = offset, targetUpper = offset;
  let hasCoefficient = false;
  for (let inputDim = 0; inputDim < inputRank; ++inputDim) {
    let c = transform[stride * inputDim + outputDimension];
    if (c === 0) continue;
    const scaleFactor = inputScales[inputDim] / outputScale;
    c *= scaleFactor;
    const lower = c * baseLowerBounds[inputDim];
    const upper = c * baseUpperBounds[inputDim];
    targetLower += Math.min(lower, upper);
    targetUpper += Math.max(lower, upper);
    hasCoefficient = true;
  }
  if (!hasCoefficient) return undefined;
  return {lower: targetLower, upper: targetUpper};
}

export function computeCombinedBounds(
    boundingBoxes: readonly TransformedBoundingBox[], outputScales: Float64Array): BoundingBox {
  const outputRank = outputScales.length;
  const lowerBounds = new Float64Array(outputRank);
  const upperBounds = new Float64Array(outputRank);
  lowerBounds.fill(Number.NEGATIVE_INFINITY);
  upperBounds.fill(Number.POSITIVE_INFINITY);
  for (const boundingBox of boundingBoxes) {
    for (let outputDim = 0; outputDim < outputRank; ++outputDim) {
      const result =
          computeCombinedLowerUpperBound(boundingBox, outputDim, outputScales[outputDim]);
      if (result === undefined) continue;
      const {lower: targetLower, upper: targetUpper} = result;
      lowerBounds[outputDim] = lowerBounds[outputDim] === Number.NEGATIVE_INFINITY ?
          targetLower :
          Math.min(lowerBounds[outputDim], targetLower);
      upperBounds[outputDim] = upperBounds[outputDim] === Number.POSITIVE_INFINITY ?
          targetUpper :
          Math.max(upperBounds[outputDim], targetUpper);
    }
  }
  return {lowerBounds, upperBounds};
}

export function transformToJson(rank: number, transform: Float64Array) {
  if (matrix.isIdentity(transform, rank + 1, rank + 1)) {
    return undefined;
  }
  const json = [];
  for (let i = 0; i <= rank; ++i) {
    const jsonRow: number[] = [];
    json.push(jsonRow);
    for (let j = 0; j <= rank; ++j) {
      jsonRow.push(transform[j * (rank + 1) + i]);
    }
  }
  return json;
}

export function transformFromJson(rank: number, obj: any): Float64Array {
  // FIXME: check for invertibility
  const transform: Float64Array = matrix.createIdentity(Float64Array, rank + 1);
  if (obj === undefined) {
    return transform;
  }
  if (Array.isArray(obj)) {
    if (obj.length === rank + 1) {
      const temp = new Float32Array(rank + 1);
      for (let i = 0; i <= rank; ++i) {
        parseFiniteVec(temp, obj[i]);
        for (let j = 0; j <= rank; ++j) {
          transform[i + j * (rank + 1)] = temp[j];
        }
      }
    }
    if (obj.length === (rank + 1) * (rank + 1)) {
      const temp = new Float64Array((rank + 1) * (rank + 1));
      parseFiniteVec(temp, obj);
      matrix.transpose(transform, rank + 1, temp, rank + 1, rank + 1, rank + 1);
    }
    throw new Error('Invalid transform');
  }
  return transform;
}

/**
 * Class for representing a coordinate transform specified by a user.
 *
 * Typically it represents a transform from a local coordinate space to a global coordinate space.
 */
export class WatchableCoordinateTransform implements WatchableValueInterface<Float64Array> {
  transform: Float64Array;
  private inverseTransform_: Float64Array;
  private inverseTransformGeneration: number;

  changed = new NullarySignal();

  get value() {
    return this.transform;
  }

  constructor(public rank: number) {
    this.transform = matrix.identity(new Float64Array((rank + 1) * (rank + 1)), rank + 1, rank + 1);
    this.inverseTransform_ =
        matrix.identity(new Float64Array((rank + 1) * (rank + 1)), rank + 1, rank + 1);
    this.inverseTransformGeneration = this.changed.count;
  }

  get inverseTransform() {
    const generation = this.changed.count;
    const {inverseTransform_} = this;
    if (this.inverseTransformGeneration !== generation) {
      this.inverseTransformGeneration = generation;
      const {rank} = this;
      matrix.inverse(inverseTransform_, rank + 1, this.transform, rank + 1, rank + 1);
    }
    return inverseTransform_;
  }

  /**
   * Resets to the identity transform.
   */
  reset() {
    const {rank, transform} = this;
    matrix.identity(transform, rank + 1, rank + 1);
    this.changed.dispatch();
  }

  toJSON() {
    return transformToJson(this.rank, this.transform);
  }

  restoreState(obj: any) {
    if (obj == null) {
      this.reset();
      return;
    }
    try {
      this.transform = transformFromJson(this.rank, obj);
      this.changed.dispatch();
    } catch {
      this.reset();
    }
  }
}

export function makeDerivedCoordinateTransform(
    derivedTransform: WatchableCoordinateTransform, baseTransform: WatchableCoordinateTransform,
    update: (output: Float64Array, input: Float64Array) => void): () => void {
  update(derivedTransform.transform, baseTransform.transform);
  return baseTransform.changed.add(() => {
    update(derivedTransform.transform, baseTransform.transform);
    derivedTransform.changed.dispatch();
  });
}

export function extendTransformedBoundingBox(
    boundingBox: TransformedBoundingBox, newOutputRank: number,
    newOutputDims: readonly number[]): TransformedBoundingBox {
  const {transform: oldTransform, box, outputScales: oldOutputScales} = boundingBox;
  const inputRank = box.lowerBounds.length;
  const oldOutputRank = oldOutputScales.length;
  const newTransform = new Float64Array((inputRank + 1) * newOutputRank);
  const newOutputScales = new Float64Array(newOutputRank);
  newOutputScales.fill(1);
  for (let oldOutputDim = 0; oldOutputDim < oldOutputRank; ++oldOutputDim) {
    const newOutputDim = newOutputDims[oldOutputDim];
    if (newOutputDim === -1) continue;
    for (let inputDim = 0; inputDim <= inputRank; ++inputDim) {
      newTransform[inputDim * newOutputRank + newOutputDim] =
          oldTransform[inputDim * oldOutputRank + oldOutputDim];
    }
    newOutputScales[newOutputDim] = oldOutputScales[oldOutputDim];
  }
  return {
    transform: newTransform,
    box,
    inputScales: boundingBox.inputScales,
    outputScales: newOutputScales,
  };
}

// export function mergeCoordinateSpaces(spaces: CoordinateSpace[]): CoordinateSpace {
//   const mergedDimensions: string[] = [];
//   const mergedUnits: string[] = [];
//   const mergedScales: number[] = [];

//   for (const space of spaces) {
//     const {dimensionNames, units, scales} = space;
//     const rank = dimensionNames.length;
//     for (let i = 0; i < rank; ++i) {
//       const dimension = dimensionNames[i];
//       const unit = units[i];
//       const scale = scales[i];
//       let j = mergedDimensions.indexOf(dimension);
//       if (j === -1) {
//         j = mergedDimensions.length;
//         mergedDimensions.push(dimension);
//         mergedUnits.push(unit);
//         mergedScales.push(scale);
//       } else {
//         if (mergedUnits[j] !== unit) {
//           mergedUnits[j] = '';
//           mergedScales[j] = 0;
//         }
//       }
//     }
//   }
//   const boundingBoxes: TransformedBoundingBox[] = [];
//   const newRank = mergedDimensions.length;
//   const newScales = Float64Array.from(mergedScales);
//   for (const space of spaces) {
//     const {dimensionNames, boundingBoxes: oldBoundingBoxes} = space;
//     if (oldBoundingBoxes.length === 0) continue;
//     const newDims = dimensionNames.map(x => mergedDimensions.indexOf(x));
//     for (const oldBoundingBox of oldBoundingBoxes) {
//       boundingBoxes.push(
//           extendTransformedBoundingBox(oldBoundingBox, newRank, newDims, space.scales,
//           newScales));
//     }
//   }
//   return makeCoordinateSpace({
//     dimensionNames: mergedDimensions,
//     units: mergedUnits,
//     scales: newScales,
//     boundingBoxes,
//   });
// }

// class WatchableCoordinateSpaceList extends RefCounted {
//   value: {space: WatchableValueInterface<CoordinateSpace>, order: number}[] = [];
//   changed = new NullarySignal();

//   add(space: WatchableValueInterface<CoordinateSpace>, order: number): () => void {
//     const obj = {space, order};
//     const {value: inputSpaces} = this;
//     inputSpaces.splice(
//         binarySearchLowerBound(0, inputSpaces.length, i => inputSpaces[i].order < order), 0,
//         obj);
//     const disposer = space.changed.add(this.changed.dispatch);
//     this.changed.dispatch();
//     return () => {
//       const i = inputSpaces.indexOf(obj);
//       inputSpaces.splice(i, 1);
//       disposer();
//       this.changed.dispatch();
//     };
//   }
// }

export interface CoordinateSpaceTransform {
  readonly rank: number;
  readonly inputSpace: CoordinateSpace;
  readonly outputSpace: CoordinateSpace;
  readonly transform: Float64Array;
}

function makeIdentityTransform(inputSpace: CoordinateSpace): CoordinateSpaceTransform {
  return {
    rank: inputSpace.rank,
    inputSpace,
    outputSpace: inputSpace,
    transform: matrix.createIdentity(Float64Array, inputSpace.rank + 1),
  };
}

function transformBoundingBox(
    boundingBox: TransformedBoundingBox, transform: Float64Array,
    targetSpace: CoordinateSpace): TransformedBoundingBox {
  const {transform: oldBoxTransform, outputScales: sourceScales} = boundingBox;
  const inputRank = sourceScales.length;
  const {scales: targetScales} = targetSpace;
  const outputRank = targetSpace.rank;
  const newBoxTransform = new Float64Array((inputRank + 1) * outputRank);
  // Compute the rotation/scaling component
  matrix.multiply(
      newBoxTransform, inputRank + 1, oldBoxTransform, inputRank + 1, transform, outputRank + 1,
      inputRank, outputRank, outputRank);
  // Compute the translation component
  for (let targetDim = 0; targetDim < outputRank; ++targetDim) {
    let sum = transform[(outputRank + 1) * outputRank + targetDim];
    const targetScale = targetScales[targetDim];
    for (let sourceDim = 0; sourceDim < outputRank; ++sourceDim) {
      const sourceScale = sourceScales[sourceDim];
      sum += transform[(outputRank + 1) * sourceDim + targetDim] *
          oldBoxTransform[inputRank * outputRank + sourceDim] * (sourceScale / targetScale);
    }
    newBoxTransform[inputRank * outputRank + targetDim] = sum;
  }
  return {
    transform: newBoxTransform,
    outputScales: targetScales,
    inputScales: boundingBox.inputScales,
    box: boundingBox.box,
  };
}

function getOutputSpaceWithTransformedBoundingBoxes(
    inputSpace: CoordinateSpace, transform: Float64Array, oldOutputSpace: CoordinateSpace) {
  const boundingBoxes = inputSpace.boundingBoxes.map(
      boundingBox => transformBoundingBox(boundingBox, transform, oldOutputSpace));
  const newSpace = makeCoordinateSpace({
    valid: inputSpace.valid,
    rank: oldOutputSpace.rank,
    dimensionIds: oldOutputSpace.dimensionIds,
    dimensionNames: oldOutputSpace.dimensionNames,
    dimensionTimestamps: oldOutputSpace.dimensionTimestamps,
    scales: oldOutputSpace.scales,
    units: oldOutputSpace.units,
    boundingBoxes,
  });
  if (coordinateSpacesEqual(newSpace, oldOutputSpace)) return oldOutputSpace;
  return newSpace;
}

// function getOutputSpace(
//     inputSpace: CoordinateSpace, transform: Float64Array,
//     dimensions: readonly string[]): CoordinateSpace {
//   const rank = inputSpace.rank;
//   const units: string[] = [];
//   const inputScales = inputSpace.scales;
//   const scales = new Float64Array(rank);
//   for (let outputDim = 0; outputDim < rank; ++outputDim) {
//     const inputDims = getDependentTransformInputDimensions(transform, rank, [outputDim]);
//     let unit: string|undefined;
//     for (const inputDim of inputDims) {
//       const inputUnit = inputSpace.units[inputDim];
//       if (unit === undefined) {
//         unit = inputUnit;
//       } else if (unit !== inputUnit) {
//         unit = '';
//       }
//     }
//     if (unit === undefined) unit = '';
//     let scale: number;
//     if (inputDims.length === 1) {
//       const inputDim = inputDims[0];
//       scale = inputScales[inputDim] * Math.abs(transform[(rank + 1) * inputDim + outputDim]);
//     } else {
//       scale = 0;
//       for (const inputDim of inputDims) {
//         scale += (transform[(rank + 1) * inputDim + outputDim] * inputScales[inputDim]) ** 2;
//       }
//       scale = Math.sqrt(scale);
//     }
//     units[outputDim] = unit;
//     scales[outputDim] = scale;
//   }
//   const scaledTransform = new Float64Array((rank + 1) ** 2);
//   const stride = rank + 1;
//   scaledTransform[stride * rank + rank] = 1;
//   for (let outputDim = 0; outputDim < rank; ++outputDim) {
//     const outputScale = scales[outputDim];
//     for (let inputDim = 0; inputDim < rank; ++inputDim) {
//       const inputScale = inputScales[inputDim];
//       const scaleFactor = inputScale / outputScale;
//       scaledTransform[inputDim * stride + outputDim] =
//           scaleFactor * transform[inputDim * stride + outputDim];
//     }
//     scaledTransform[stride * rank + outputDim] = transform[stride * rank + outputDim] /
//     outputScale;
//   }
//   return makeCoordinateSpace({
//     dimensionNames,
//     rank,
//     units,
//     scales,
//     boundingBoxes: inputSpace.boundingBoxes.map(({
//                                                   transform: oldTransform,
//                                                   box,
//                                                 }) => {
//       const newTransform = new Float64Array((rank + 1) ** 2);
//       matrix.multiply(
//           newTransform, rank + 1, oldTransform, rank + 1, scaledTransform, rank + 1, rank + 1,
//           rank + 1, rank + 1);
//       return {transform: newTransform, box};
//     })
//   });
// }

export function isValidDimensionName(name: string) {
  return name.match(/^[a-zA-Z][a-zA-Z_0-9\-]*'?$/) !== null;
}

export function validateDimensionNames(names: string[]) {
  const seenNames = new Set<string>();
  for (const name of names) {
    if (!isValidDimensionName(name)) return false;
    if (seenNames.has(name)) return false;
    seenNames.add(name);
  }
  return true;
}

export function getDimensionNameValidity(names: readonly string[]): boolean[] {
  const rank = names.length;
  const isValid = new Array<boolean>(rank);
  isValid.fill(true);
  for (let i = 0; i < rank; ++i) {
    const name = names[i];
    if (!isValidDimensionName(name)) {
      isValid[i] = false;
      continue;
    }
    const otherIndex = names.indexOf(name, i + 1);
    if (otherIndex !== -1) {
      isValid[i] = false;
      isValid[otherIndex] = false;
    }
  }
  return isValid;
}

export function isLocalDimension(name: string) {
  return name.endsWith('\'');
}

export function isGlobalDimension(name: string) {
  return !isLocalDimension(name);
}

export class WatchableCoordinateSpaceTransform implements
    Trackable, WatchableValueInterface<CoordinateSpaceTransform> {
  private value_: CoordinateSpaceTransform|undefined = undefined;
  readonly outputSpace = new WatchableValue(this.inputSpace);
  changed = new NullarySignal();

  constructor(public readonly inputSpace: CoordinateSpace) {
    this.outputSpace.changed.add(this.changed.dispatch);
  }

  get value() {
    let {value_: value} = this;
    if (value === undefined) {
      const {inputSpace} = this;
      value = this.value_ = makeIdentityTransform(inputSpace);
    }
    const {outputSpace: {value: outputSpace}} = this;
    if (value.outputSpace !== outputSpace) {
      value = this.value_ = {
        rank: outputSpace.rank,
        transform: convertTransformOutputScales(
            value.transform, value.outputSpace.scales, outputSpace.scales),
        inputSpace: this.inputSpace,
        outputSpace,
      };
    }
    return value;
  }

  reset() {
    this.value_ = undefined;
    this.outputSpace.value = this.inputSpace;
    this.changed.dispatch();
  }

  get spec(): Readonly<CoordinateTransformSpecification>|undefined {
    const {value} = this;
    const {rank, transform, inputSpace, outputSpace} = value;
    if (matrix.isIdentity(transform, rank + 1, rank + 1) &&
        arraysEqual(inputSpace.dimensionNames, outputSpace.dimensionNames)) {
      return undefined;
    }
    return {transform, outputSpace: value.outputSpace};
  }

  set transform(transform: Float64Array) {
    const {inputSpace} = this;
    const {outputSpace} = this;
    const outputSpaceValue = outputSpace.value;
    const newOutputSpace =
        getOutputSpaceWithTransformedBoundingBoxes(inputSpace, transform, outputSpaceValue);
    const newValue: CoordinateSpaceTransform = {
      rank: newOutputSpace.rank,
      inputSpace,
      transform,
      outputSpace: newOutputSpace,
    };
    this.value_ = newValue;
    outputSpace.value = newOutputSpace;
    this.changed.dispatch();
  }

  set spec(spec: Readonly<CoordinateTransformSpecification>|undefined) {
    const {inputSpace} = this;
    if (spec === undefined || spec.outputSpace.rank !== inputSpace.rank) {
      this.reset();
      return;
    }
    const {transform} = spec;
    const outputSpace =
        getOutputSpaceWithTransformedBoundingBoxes(inputSpace, transform, spec.outputSpace);
    this.value_ = {
      rank: inputSpace.rank,
      inputSpace,
      transform,
      outputSpace,
    };
    this.outputSpace.value = outputSpace;
    this.changed.dispatch();
  }

  toJSON() {
    return coordinateTransformSpecificationToJson(this.spec);
  }

  restoreState(obj: unknown) {
    this.spec = coordinateTransformSpecificationFromJson(obj);
  }
}

// export class WatchableMultiCoordinateSpaceTransform extends RefCounted implements Trackable {
//   private inputSpaces = this.registerDisposer(new WatchableCoordinateSpaceList);

//   readonly inputSpace: WatchableValueInterface<CoordinateSpace> =
//       this.registerDisposer(makeCachedLazyDerivedWatchableValue(
//           inputSpaces => mergeCoordinateSpaces(inputSpaces.map(x => x.space.value)),
//           this.inputSpaces));

//   readonly transform =
//       this.registerDisposer(new WatchableCoordinateSpaceTransform(this.inputSpace));

//   readonly changed = this.transform.changed;

//   addInputSpace(space: WatchableValueInterface<CoordinateSpace>, order: number) {
//     return this.inputSpaces.add(space, order);
//   }

//   toJSON() {
//     return this.transform.toJSON();
//   }

//   reset() {
//     this.transform.reset();
//   }

//   restoreState(obj: any) {
//     return this.transform.restoreState(obj);
//   }
// }

export function expectDimensionName(obj: unknown): string {
  const name = verifyString(obj);
  if (!isValidDimensionName(name)) {
    throw new Error(`Invalid dimension name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function dimensionNamesFromJson(obj: any) {
  const dimensions = parseArray(obj, expectDimensionName);
  if (!validateDimensionNames(dimensions)) {
    throw new Error(`Invalid dimensions: ${JSON.stringify(dimensions)}`);
  }
  return dimensions;
}

// export function getCoordinateSubspace(
//     coordinateSpace: CoordinateSpace, subspaceDimensions: readonly number[]): CoordinateSpace {
//   const {
//     dimensionNames,
//     dimensionIds,
//     units,
//     scales,
//     bounds: {lowerBounds, upperBounds}
//   } = coordinateSpace;
//   const newRank = subspaceDimensions.length;
//   const newDimensions: string[] = [];
//   const newDimensionIds: DimensionId[] = [];
//   const newUnits: string[] = [];
//   const newScales = new Float64Array(newRank);
//   const newLowerBounds = new Float64Array(newRank);
//   const newUpperBounds = new Float64Array(newRank);
//   const newBounds = {lowerBounds: newLowerBounds, upperBounds: newUpperBounds};
//   for (let newDim = 0; newDim < newRank; ++newDim) {
//     const oldDim = subspaceDimensions[newDim];
//     newUnits[newDim] = units[oldDim];
//     newScales[newDim] = scales[oldDim];
//     newDimensions[newDim] = dimensionNames[oldDim];
//     newDimensionIds[newDim] = dimensionIds[oldDim];
//     newLowerBounds[newDim] = lowerBounds[oldDim];
//     newUpperBounds[newDim] = upperBounds[oldDim];
//   }
//   // We use the combined bounding box, since it may not be possible to transform the individual
//   // bounding boxes.
//   return makeCoordinateSpace({
//     dimensionNames: newDimensions,
//     dimensionIds: newDimensionIds,
//     units: newUnits,
//     scales: newScales,
//     bounds: newBounds,
//     boundingBoxes: [{
//       box: newBounds,
//       outputScales: newScales,
//       transform: matrix.createIdentity(Float64Array, newRank + 1)
//     }]
//   });
// }

// export function getLocalOrGlobalCoordinateSubspace(
//     coordinateSpace: CoordinateSpace, local: boolean) {
//   const subspaceDimensions: number[] = [];
//   const {rank, dimensionNames} = coordinateSpace;
//   for (let i = 0; i < rank; ++i) {
//     if (isLocalDimension(dimensionNames[i]) === local) {
//       subspaceDimensions.push(i);
//     }
//   }
//   return getCoordinateSubspace(coordinateSpace, subspaceDimensions);
// }

export function convertTransformOutputScales(
    existingTransform: Float64Array, existingOutputScales: Float64Array,
    newOutputScales: Float64Array) {
  const newTransform = new Float64Array(existingTransform);
  const rank = existingOutputScales.length;
  const baseIndex = (rank + 1) * rank;
  for (let i = 0; i < rank; ++i) {
    newTransform[baseIndex + i] *= (existingOutputScales[i] / newOutputScales[i]);
  }
  return newTransform;
}

interface BoundCoordinateSpace {
  space: WatchableValueInterface<CoordinateSpace>;
  prevValue: CoordinateSpace|undefined;
  mappedDimensionIds: (DimensionId|undefined)[];
}

export class CoordinateSpaceCombiner {
  private bindings = new Set<BoundCoordinateSpace>();

  private retainCount = 0;

  private prevCombined: CoordinateSpace|undefined = this.combined.value;

  constructor(
      public combined: WatchableValueInterface<CoordinateSpace>,
      public includeDimension: (name: string) => boolean) {}

  private update() {
    const {combined, bindings} = this;
    const retainExisting = this.retainCount !== 0;
    if (bindings.size === 0 && !retainExisting) {
      combined.value = emptyCoordinateSpace;
      return;
    }
    const include = this.includeDimension;
    const existing = combined.value;
    let mergedDimensionNames = Array.from(existing.dimensionNames);
    let mergedUnits = Array.from(existing.units);
    let mergedScales = Array.from(existing.scales);
    let mergedDimensionIds = Array.from(existing.dimensionIds);
    let mergedDimensionTimestamps = Array.from(existing.dimensionTimestamps);
    const dimensionRefs = existing.dimensionNames.map(() => retainExisting ? 1 : 0);
    const bindingCombinedIndices: (number|undefined)[][] = [];
    let valid = false;
    for (const binding of bindings) {
      const {space: {value: space}, prevValue, mappedDimensionIds} = binding;
      valid = valid || space.valid;
      const {dimensionNames, units, scales, dimensionIds, dimensionTimestamps} = space;
      const newMappedDimensionIds: (DimensionId|undefined)[] = [];
      const combinedIndices: (number|undefined)[] = [];
      bindingCombinedIndices.push(combinedIndices);
      binding.mappedDimensionIds = newMappedDimensionIds;
      binding.prevValue = space;
      const rank = dimensionNames.length;
      for (let i = 0; i < rank; ++i) {
        const name = dimensionNames[i];
        if (!include(name)) continue;
        if (prevValue !== undefined) {
          const id = dimensionIds[i];
          const prevIndex = prevValue.dimensionIds.indexOf(id);
          if (prevIndex !== -1) {
            const combinedId = mappedDimensionIds[prevIndex];
            if (combinedId !== undefined) {
              const combinedIndex = mergedDimensionIds.indexOf(combinedId);
              if (combinedIndex !== -1) {
                newMappedDimensionIds[i] = combinedId;
                ++dimensionRefs[combinedIndex];
                combinedIndices[i] = combinedIndex;
                const dimensionTimestamp = dimensionTimestamps[i];
                if (dimensionTimestamp !== undefined &&
                    !(dimensionTimestamp <= mergedDimensionTimestamps[combinedIndex])) {
                  mergedDimensionNames[combinedIndex] = name;
                  mergedScales[combinedIndex] = scales[i];
                  mergedUnits[combinedIndex] = units[i];
                  mergedDimensionTimestamps[combinedIndex] = dimensionTimestamp;
                }
                continue;
              }
            }
          }
        }
        let combinedIndex = mergedDimensionNames.indexOf(name);
        if (combinedIndex !== -1) {
          newMappedDimensionIds[i] = mergedDimensionIds[combinedIndex];
          ++dimensionRefs[combinedIndex];
          combinedIndices[i] = combinedIndex;
          continue;
        }
        combinedIndex = mergedDimensionNames.length;
        combinedIndices[i] = combinedIndex;
        dimensionRefs[combinedIndex] = 1;
        mergedDimensionNames[combinedIndex] = name;
        mergedUnits[combinedIndex] = units[i];
        mergedScales[combinedIndex] = scales[i];
        mergedDimensionTimestamps[combinedIndex] = dimensionTimestamps[i];
        const combinedId = newDimensionId();
        mergedDimensionIds[combinedIndex] = combinedId;
        newMappedDimensionIds[i] = combinedId;
      }
    }
    // Propagate names, units, and scales back
    let bindingIndex = 0;
    const newScales = Float64Array.from(mergedScales);
    const mergedBoundingBoxes: TransformedBoundingBox[] = [];
    let newRank = mergedDimensionNames.length;
    for (const binding of bindings) {
      const {space: {value: space}} = binding;
      const combinedIndices = bindingCombinedIndices[bindingIndex++];
      const {rank} = space;
      const dimensionNames = Array.from(space.dimensionNames);
      const dimensionTimestamps = Array.from(space.dimensionTimestamps);
      const scales = Float64Array.from(space.scales);
      const units = Array.from(space.units);
      for (let i = 0; i < rank; ++i) {
        const combinedIndex = combinedIndices[i];
        if (combinedIndex === undefined) continue;
        units[i] = mergedUnits[combinedIndex];
        scales[i] = mergedScales[combinedIndex];
        dimensionTimestamps[i] = mergedDimensionTimestamps[combinedIndex];
        dimensionNames[i] = mergedDimensionNames[combinedIndex];
      }
      if (!arraysEqual(units, space.units) || !arraysEqual(scales, space.scales) ||
          !arraysEqual(dimensionNames, space.dimensionNames) ||
          !arraysEqual(dimensionTimestamps, space.dimensionTimestamps)) {
        const newSpace = makeCoordinateSpace({
          valid: space.valid,
          dimensionIds: space.dimensionIds,
          scales,
          units,
          dimensionNames,
          dimensionTimestamps,
          boundingBoxes: space.boundingBoxes,
        });
        binding.prevValue = newSpace;
        binding.space.value = newSpace;
      }
    }

    {
      for (let i = 0; i < newRank; ++i) {
        if (!include(mergedDimensionNames[i])) {
          dimensionRefs[i] = 0;
        }
      }
      const hasRefs = (_: any, i: number) => dimensionRefs[i] !== 0;
      mergedDimensionNames = mergedDimensionNames.filter(hasRefs);
      mergedUnits = mergedUnits.filter(hasRefs);
      mergedScales = mergedScales.filter(hasRefs);
      mergedDimensionIds = mergedDimensionIds.filter(hasRefs);
      mergedDimensionTimestamps = mergedDimensionTimestamps.filter(hasRefs);
      newRank = mergedDimensionNames.length;
    }

    for (const binding of bindings) {
      const {space: {value: space}} = binding;
      const {boundingBoxes} = space;
      if (boundingBoxes.length === 0) continue;
      const newDims = space.dimensionNames.map(x => mergedDimensionNames.indexOf(x));
      for (const oldBoundingBox of boundingBoxes) {
        mergedBoundingBoxes.push(extendTransformedBoundingBox(oldBoundingBox, newRank, newDims));
      }
    }
    const newCombined = makeCoordinateSpace({
      valid,
      dimensionIds: mergedDimensionIds,
      dimensionNames: mergedDimensionNames,
      units: mergedUnits,
      scales: newScales,
      boundingBoxes: mergedBoundingBoxes,
    });
    if (!coordinateSpacesEqual(existing, newCombined)) {
      this.prevCombined = newCombined;
      combined.value = newCombined;
    }
  }

  private handleCombinedChanged = () => {
    if (this.combined.value === this.prevCombined) return;
    this.update();
  };

  retain() {
    ++this.retainCount;
    return () => {
      if (--this.retainCount === 0) {
        this.update();
      }
    };
  }

  bind(space: WatchableValueInterface<CoordinateSpace>) {
    const binding = {space, mappedDimensionIds: [], prevValue: undefined};
    const {bindings} = this;
    if (bindings.size === 0) {
      this.combined.changed.add(this.handleCombinedChanged);
    }
    bindings.add(binding);

    const changedDisposer = space.changed.add(() => {
      if (space.value === binding.prevValue) return;
      this.update();
    });
    const disposer = () => {
      changedDisposer();
      const {bindings} = this;
      bindings.delete(binding);
      if (bindings.size === 0) {
        this.combined.changed.remove(this.handleCombinedChanged);
      }
      this.update();
    };
    this.update();
    return disposer;
  }
}

export function transformSubmatrix(
    oldTransform: Float64Array, oldRank: number, oldRows: readonly number[],
    oldCols: readonly number[]): Float32Array {
  const newRank = oldRows.length;
  const newTransform = new Float32Array((newRank + 1) ** 2);
  newTransform[newTransform.length - 1] = 1;
  for (let newCol = 0; newCol < newRank; ++newCol) {
    const oldCol = oldCols[newCol];
    newTransform[(newRank + 1) * newRank + newCol] = oldTransform[(oldRank + 1) * oldRank + oldCol];
    for (let newRow = 0; newRow < newRank; ++newRow) {
      const oldRow = oldRows[newRow];
      newTransform[(newRank + 1) * newRow + newCol] = oldTransform[(oldRank + 1) * oldRow + oldCol];
    }
  }
  return newTransform;
}

export interface CoordinateTransformSpecification {
  transform: Float64Array;
  outputSpace: CoordinateSpace;
}

export function coordinateTransformSpecificationFromLegacyJson(obj: unknown):
    CoordinateTransformSpecification|undefined {
  if (obj === undefined) return undefined;
  const arr = expectArray(obj);
  const transform = new Float64Array(16);
  if (arr.length === 16) {
    for (let i = 0; i < 4; ++i) {
      for (let j = 0; j < 4; ++j) {
        transform[i * 4 + j] = verifyFiniteFloat(arr[j * 4 + i]);
      }
    }
  } else if (arr.length === 4) {
    for (let i = 0; i < 4; ++i) {
      const row = expectArray(arr[i]);
      if (row.length !== 4) {
        throw new Error(`Expected length 4 array, but received: ${JSON.stringify(row)}`);
      }
      for (let j = 0; j < 4; ++j) {
        transform[j * 4 + i] = verifyFiniteFloat(row[j]);
      }
    }
  } else {
    throw new Error(`Expected length 4 array, but received: ${JSON.stringify(arr)}`);
  }
  return {
    transform,
    outputSpace: makeCoordinateSpace({
      valid: true,
      dimensionNames: ['x', 'y', 'z'],
      units: ['m', 'm', 'm'],
      scales: Float64Array.of(1e-9, 1e-9, 1e-9)
    })
  };
}

export function coordinateTransformSpecificationFromJson(j: unknown):
    CoordinateTransformSpecification|undefined {
  if (j === undefined) return undefined;
  const obj = verifyObject(j);
  const outputSpace = verifyObjectProperty(obj, 'outputDimensions', coordinateSpaceFromJson);
  const rank = outputSpace.rank;
  const a = verifyObjectProperty(obj, 'matrix', x => {
    if (!Array.isArray(x) || x.length !== rank) {
      throw new Error(`Expected array of length ${rank}, but received: ${JSON.stringify(x)}`);
    }
    return x;
  });
  const transform = new Float64Array((rank + 1) ** 2);
  transform[transform.length - 1] = 1;
  for (let i = 0; i < rank; ++i) {
    try {
      const row = expectArray(a[i]);
      if (row.length !== rank + 1) {
        throw new Error(`Expected length ${rank + 1} array, but received: ${JSON.stringify(row)}`);
      }
      for (let j = 0; j <= rank; ++j) {
        transform[(rank + 1) * j + i] = verifyFiniteFloat(row[j]);
      }
    } catch (e) {
      throw new Error(`Error in row ${i}: ${e.message}`);
    }
  }
  return {transform, outputSpace};
}

export function coordinateTransformSpecificationToJson(spec: CoordinateTransformSpecification|
                                                       undefined) {
  if (spec === undefined) return undefined;
  const {transform, outputSpace} = spec;
  const matrix: number[][] = [];
  const rank = outputSpace.rank;
  for (let i = 0; i < rank; ++i) {
    const row: number[] = [];
    matrix[i] = row;
    for (let j = 0; j <= rank; ++j) {
      row[j] = transform[(rank + 1) * j + i];
    }
  }
  return {matrix, outputDimensions: coordinateSpaceToJson(outputSpace)};
}

export function permuteTransformedBoundingBox(
    boundingBox: TransformedBoundingBox, newToOld: readonly number[]): TransformedBoundingBox {
  const {box, inputScales, outputScales, transform} = boundingBox;
  const inputRank = inputScales.length;
  const outputRank = outputScales.length;
  const newTransform = new Float64Array((inputRank + 1) * outputRank);
  for (let outputDim = 0; outputDim < outputRank; ++outputDim) {
    for (let inputDim = 0; inputDim <= inputRank; ++inputDim) {
      const oldOutputDim = newToOld[outputDim];
      newTransform[outputDim + inputDim * outputRank] =
          transform[oldOutputDim + inputDim * outputRank];
    }
  }
  return {
    inputScales,
    outputScales: Float64Array.from(newToOld, i => outputScales[i]),
    transform: newTransform,
    box,
  };
}

export function permuteCoordinateSpace(existing: CoordinateSpace, newToOld: readonly number[]) {
  const {dimensionIds, dimensionNames, scales, units, dimensionTimestamps} = existing;
  return makeCoordinateSpace({
    rank: newToOld.length,
    valid: existing.valid,
    dimensionIds: newToOld.map(i => dimensionIds[i]),
    dimensionNames: newToOld.map(i => dimensionNames[i]),
    dimensionTimestamps: newToOld.map(i => dimensionTimestamps[i]),
    scales: Float64Array.from(newToOld, i => scales[i]),
    units: newToOld.map(i => units[i]),
    boundingBoxes: existing.boundingBoxes.map(b => permuteTransformedBoundingBox(b, newToOld)),
  });
}

export function insertDimensionAt(
    existing: CoordinateSpace, targetIndex: number, sourceIndex: number) {
  if (targetIndex === sourceIndex) return existing;
  return permuteCoordinateSpace(
      existing, getInsertPermutation(existing.rank, sourceIndex, targetIndex));
}
