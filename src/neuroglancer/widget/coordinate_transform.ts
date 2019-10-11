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

/**
 * @file Coordinate space transform editor widget.
 */

import './coordinate_transform.css';

import {newDimensionId, validateDimensionNames, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import { KeyboardEventBinder, registerActionListener, ActionEvent} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap, MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {formatScaleWithUnit} from 'neuroglancer/util/si_units';

function updateInputFieldWidth(element: HTMLInputElement, value: string = element.value) {
  element.style.minWidth = (value.length + 1) + 'ch';
}

function formatBounds(lower: number, upper: number) {
  return `[${Math.floor(lower)}, ${Math.floor(upper)})`;
}

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'move-up'},
  'arrowdown': {action: 'move-down'},
  'arrowleft': {action: 'move-left', preventDefault: false},
  'arrowright': {action: 'move-right', preventDefault: false},
  'wheel': {action: 'adjust-via-wheel'},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

export class CoordinateSpaceTransformWidget extends RefCounted {
  element = document.createElement('div');
  coefficientContainer = document.createElement('div');
  translationContainer = document.createElement('div');
  outputNameContainer = document.createElement('div');
  coefficientElements: HTMLInputElement[] = [];
  outputNameElements: HTMLInputElement[] = [];
  outputScaleElements: HTMLDivElement[] = [];
  outputBoundsElements: HTMLDivElement[] = [];
  generation = -1;
  constructor(public transform: WatchableCoordinateSpaceTransform) {
    super();
    const {element} = this;
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    element.classList.add('neuroglancer-coordinate-space-transform-widget');
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    const updateView = animationFrameDebounce(() => this.updateView());
    this.registerDisposer(transform.changed.add(updateView));
    const {transform: {inputSpace}} = this;
    const rank = inputSpace.rank;
    element.style.gridTemplateColumns = `repeat(${rank+3}, auto)`;
    element.style.gridTemplateRows = `repeat(${rank+3}, auto)`;
    const {
      coefficientElements,
      outputNameElements,
      outputScaleElements,
      outputBoundsElements,
      coefficientContainer,
      translationContainer,
      outputNameContainer
    } = this;
    coefficientContainer.style.display = 'contents';
    translationContainer.style.display = 'contents';
    outputNameContainer.style.display = 'contents';
    element.appendChild(coefficientContainer);
    element.appendChild(outputNameContainer);
    coefficientContainer.appendChild(translationContainer);
    const {
      dimensionNames: inputNames,
      scales: inputScales,
      units: inputUnits,
      bounds: {lowerBounds: inputLowerBounds, upperBounds: inputUpperBounds}
    } = inputSpace;
    element.addEventListener('input', (event: UIEvent) => {
      const {target} = event;
      if (target instanceof HTMLInputElement) {
        updateInputFieldWidth(target);
      }
    });
    const registerMoveUpDown = (action: string, rowDelta: number, colDelta: number) => {
      registerActionListener<Event>(element, action, (event: ActionEvent<Event>) => {
        event.stopPropagation();
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (colDelta !== 0) {
          // Only move to another column if the selection is in the correct state.
          if (target.selectionStart !== target.selectionEnd ||
              target.selectionStart !== (colDelta === 1 ? target.value.length : 0)) {
            return;
          }
        }
        const gridPos = this.getElementGridPosition(target);
        if (gridPos === undefined) return;
        const newElement =
            this.getElementByGridPosition(gridPos.row + rowDelta, gridPos.col + colDelta);
        if (newElement !== null) {
          newElement.focus();
          event.preventDefault();
        }
      });
    };
    registerMoveUpDown('move-up', -1, 0);
    registerMoveUpDown('move-down', +1, 0);
    registerMoveUpDown('move-left', 0, -1);
    registerMoveUpDown('move-right', 0, +1);
    const registerFocusout = (container: HTMLDivElement, handler: (event: FocusEvent) => void) => {
      container.addEventListener('focusout', (event: FocusEvent) => {
        const {relatedTarget} = event;
        if ((relatedTarget instanceof Node) && container.contains(relatedTarget)) {
          return;
        }
        handler(event);
      });
    };
    registerFocusout(coefficientContainer, () => {
      if (!this.updateModelTransform()) {
        this.updateViewTransformCoefficients();
      }
    });
    registerFocusout(outputNameContainer, () => {
      if (!this.updateModelOutputNames()) {
        this.updateViewOutputNames();
      }
    });
    registerActionListener(element, 'cancel', event => {
      this.generation = -1;
      this.updateView();
      (event.target! as HTMLElement).blur();
    });
    registerActionListener(coefficientContainer, 'commit', () => {
      this.updateModelTransform();
    });
    registerActionListener(outputNameContainer, 'commit', () => {
      this.updateModelOutputNames();
    });
    element.addEventListener('focusin', (event: FocusEvent) => {
      const {target} = event;
      if (target instanceof HTMLInputElement) {
        target.select();
      }
    });

    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      {
        const cellElement = document.createElement('div');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-input-name');
        cellElement.textContent = inputNames[inputDim];
        cellElement.style.gridRowStart = '1';
        cellElement.style.gridColumnStart = `${inputDim+2}`;
        element.appendChild(cellElement);
      }
      {
        const cellElement = document.createElement('div');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-input-scale');
        const {scale, prefix, unit} = formatScaleWithUnit(inputScales[inputDim], inputUnits[inputDim]);
        cellElement.textContent = `${scale}${prefix}${unit}`;
        cellElement.style.gridRowStart = '2';
        cellElement.style.gridColumnStart = `${inputDim+2}`;
        element.appendChild(cellElement);
      }
      {
        const cellElement = document.createElement('div');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-input-bounds');
        cellElement.textContent =
            formatBounds(inputLowerBounds[inputDim], inputUpperBounds[inputDim]);
        cellElement.style.gridRowStart = '3';
        cellElement.style.gridColumnStart = `${inputDim+2}`;
        element.appendChild(cellElement);
      }
    }
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      {
        const cellElement = document.createElement('input');
        cellElement.spellcheck = false;
        cellElement.autocomplete = 'off';
        cellElement.size = 1;
        cellElement.classList.add('neuroglancer-coordinate-space-transform-output-name');
        outputNameElements.push(cellElement);
        cellElement.style.gridRowStart = `${outputDim+4}`;
        cellElement.style.gridColumnStart = `1`;
        outputNameContainer.appendChild(cellElement);
      }
      for (let inputDim = 0; inputDim <= rank; ++inputDim) {
        const cellElement = document.createElement('input');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-coeff');
        cellElement.spellcheck = false;
        cellElement.autocomplete = 'off';
        cellElement.size = 1;
        cellElement.style.gridRowStart = `${outputDim+4}`;
        cellElement.style.gridColumnStart = `${inputDim+2}`;
        coefficientElements[inputDim * rank + outputDim] = cellElement;
        ((inputDim === rank) ? translationContainer : coefficientContainer)
            .appendChild(cellElement);
      }
      {
        const cellElement = document.createElement('div');
        cellElement.classList.add(
            'neuroglancer-coordinate-space-transform-output-scale-and-bounds');
        cellElement.style.gridRowStart = `${outputDim + 4}`;
        cellElement.style.gridColumnStart = `${rank + 3}`;
        element.appendChild(cellElement);
        {
          const e = document.createElement('div');
          e.classList.add('neuroglancer-coordinate-space-transform-output-scale');
          outputScaleElements.push(e);
          cellElement.appendChild(e);
        }
        {
          const e = document.createElement('div');
          e.classList.add('neuroglancer-coordinate-space-transform-output-bounds');
          outputBoundsElements.push(e);
          cellElement.appendChild(e);
        }
      }
    }
    this.updateView();
  }

  private getElementGridPosition(element: HTMLInputElement) {
    {
      const i = this.outputNameElements.indexOf(element);
      if (i !== -1) {
        return {row: i, col: -1};
      }
    }
    {
      const i = this.coefficientElements.indexOf(element);
      const {rank} = this.transform.inputSpace;
      if (i !== -1) {
        return {row: i % rank, col: Math.floor(i / rank)};
      }
    }
    return undefined;
  }

  private getElementByGridPosition(row: number, col: number) {
    const {rank} = this.transform.inputSpace;
    if (row < 0 || row >= rank || col < -1 || col > rank) return null;
    if (col === -1) {
      return this.outputNameElements[row];
    }
    return this.coefficientElements[col * rank + row];
  }


  private updateModelOutputNames() {
    const outputNames = this.outputNameElements.map(e => e.value);
    if (!validateDimensionNames(outputNames)) return false;
    const {outputSpace} = this.transform;
    const {value: outputSpaceValue} = outputSpace;
    const existingNames = outputSpaceValue.dimensionNames;
    if (arraysEqual(existingNames, outputNames)) return true;
    const dimensionIds = outputSpaceValue.dimensionIds.map(
        (id, i) => (outputNames[i] === existingNames[i]) ? id : newDimensionId());
    const dimensionTimestamps = outputSpaceValue.dimensionIds.map(
      (t, i) => (outputNames[i] === existingNames[i]) ? t : Date.now());
    outputSpace.value =
        {...outputSpaceValue, dimensionIds, dimensionNames: outputNames, dimensionTimestamps};
    return true;
  }

  private updateModelTransform(): boolean {
    const coefficientElements = this.coefficientElements;
    const {rank} = this.transform.inputSpace;
    const newTransform = new Float64Array((rank + 1) ** 2);
    newTransform[newTransform.length - 1] = 1;
    for (let row = 0; row < rank; ++row) {
      for (let col = 0; col <= rank; ++col) {
        const e = coefficientElements[col * rank + row];
        const v = parseFloat(e.value);
        if (!Number.isFinite(v)) {
          return false;
        }
        newTransform[col * (rank + 1) + row] = v;
      }
    }
    this.transform.transform = newTransform;
    return true;
  }

  private updateViewOutputNames() {
    const {transform: {outputSpace: {value: outputSpace}}} = this;
    const {rank} = outputSpace;
    const {outputNameElements} = this;
    const {dimensionNames: outputNames} = outputSpace;
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      const outputNameElement = outputNameElements[outputDim];
      outputNameElement.value = outputNames[outputDim];
      updateInputFieldWidth(outputNameElement);
    }
  }

  private updateViewTransformCoefficients() {
    const {transform: {inputSpace, value: {transform}}} = this;
    const {rank} = inputSpace;
    const {coefficientElements} = this;
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      for (let inputDim = 0; inputDim <= rank; ++inputDim) {
        const coeffElement = coefficientElements[inputDim * rank + outputDim];
        coeffElement.value = transform[inputDim * (rank + 1) + outputDim].toString();
        updateInputFieldWidth(coeffElement);
      }
    }
  }

  updateView() {
    const generation = this.transform.changed.count;
    if (generation === this.generation) return;
    this.generation = generation;
    const {transform: {inputSpace, value: {outputSpace}}} = this;
    const {rank} = inputSpace;
    const {outputScaleElements, outputBoundsElements} = this;
    const {
      units: outputUnits,
      scales: outputScales,
      bounds: {lowerBounds: outputLowerBounds, upperBounds: outputUpperBounds}
    } = outputSpace;
    this.updateViewOutputNames();
    this.updateViewTransformCoefficients();
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      const {scale, prefix, unit} = formatScaleWithUnit(outputScales[outputDim], outputUnits[outputDim]);
      outputScaleElements[outputDim].textContent = `${scale}${prefix}${unit}`;
      outputBoundsElements[outputDim].textContent =
          formatBounds(outputLowerBounds[outputDim], outputUpperBounds[outputDim]);
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
