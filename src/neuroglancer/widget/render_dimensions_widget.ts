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

import './render_dimensions_widget.css';

import {getDimensionNameValidity, validateDimensionNames} from 'neuroglancer/coordinate_transform';
import {TrackableRenderDimensions, TrackableZoomInterface} from 'neuroglancer/navigation_state';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual} from 'neuroglancer/util/array';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent, updateInputFieldWidth} from 'neuroglancer/util/dom';
import {KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap, MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {numberToStringFixed} from 'neuroglancer/util/number_to_string';
import {formatScaleWithUnit} from 'neuroglancer/util/si_units';

const dimensionColors = ['#f00', '#0f0', '#00f'];

interface DimensionWidget {
  container: HTMLDivElement;
  name: HTMLInputElement;
  scaleFactor: HTMLInputElement;
  scale: HTMLSpanElement;
  scaleFactorModified: boolean;
}

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'move-up'},
  'arrowdown': {action: 'move-down'},
  'wheel': {action: 'adjust-via-wheel'},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

function formatScaleFactor(x: number) {
  if (x < 1 || x > 1024) {
    const exponent = Math.log2(x) | 0;
    const coeff = x / 2 ** exponent;
    return `${numberToStringFixed(coeff, 1)}p${exponent}`;
  }
  return x.toString();
}

const widgetFieldGetters: ((dimElements: DimensionWidget) => HTMLInputElement)[] = [
  x => x.name,
  x => x.scaleFactor,
];

export class RenderDimensionsWidget extends RefCounted {
  element = document.createElement('div');
  defaultCheckbox = document.createElement('input');
  defaultCheckboxLabel = document.createElement('label');

  dimensionElements = Array.from(Array(3), (_, i): DimensionWidget => {
    const container = document.createElement('div');
    container.classList.add('neuroglancer-render-dimensions-widget-dimension');
    container.style.display = 'contents';
    registerActionListener<WheelEvent>(container, 'adjust-via-wheel', actionEvent => {
      const event = actionEvent.detail;
      const {deltaY} = event;
      if (deltaY === 0) {
        return;
      }
      this.zoomDimension(i, Math.sign(deltaY));
    });

    const name = document.createElement('input');
    name.classList.add('neuroglancer-render-dimensions-widget-name');
    name.spellcheck = false;
    name.autocomplete = 'off';
    name.style.color = dimensionColors[i];
    name.style.gridColumn = '1';
    name.style.gridRow = `${i + 1}`;
    name.addEventListener('focus', () => {
      name.select();
    });
    container.appendChild(name);

    const scaleFactorContainer = document.createElement('span');
    scaleFactorContainer.classList.add('neuroglancer-render-dimensions-widget-scale-factor');
    const scaleFactor = document.createElement('input');
    scaleFactor.spellcheck = false;
    scaleFactor.autocomplete = 'off';
    scaleFactorContainer.style.gridColumn = '2';
    scaleFactorContainer.style.gridRow = `${i + 1}`;
    scaleFactor.addEventListener('focus', () => {
      scaleFactor.select();
    });
    scaleFactorContainer.appendChild(scaleFactor);
    container.appendChild(scaleFactorContainer);

    const scale = document.createElement('span');
    scale.classList.add('neuroglancer-render-dimensions-widget-scale');
    scale.style.gridColumn = '3';
    scale.style.gridRow = `${i + 1}`;
    container.appendChild(scale);
    this.element.appendChild(container);

    const dimWidget: DimensionWidget = {
      name,
      container,
      scaleFactor,
      scale,
      scaleFactorModified: false,
    };
    name.addEventListener('input', () => {
      updateInputFieldWidth(name);
      this.updateNameValidity();
    });
    registerActionListener(name, 'commit', () => {
      this.updateNames();
    });
    name.addEventListener('blur', (event: FocusEvent) => {
      const {relatedTarget} = event;
      if (this.dimensionElements.some(x => x.name === relatedTarget)) {
        return;
      }
      if (!this.updateNames()) {
        this.updateView();
      }
    });
    scaleFactorContainer.addEventListener('click', (event: MouseEvent) => {
      const {target} = event;
      if (target === scaleFactor) return;
      scaleFactor.focus();
      event.preventDefault();
    });
    scaleFactor.addEventListener('input', () => {
      updateInputFieldWidth(scaleFactor);
      dimWidget.scaleFactorModified = true;
    });
    registerActionListener(scaleFactor, 'commit', () => {
      this.updateScaleFactors();
    });
    scaleFactor.addEventListener('blur', () => {
      if (!this.updateScaleFactors()) {
        this.updateView();
      }
    });
    for (const getter of widgetFieldGetters) {
      registerActionListener(getter(dimWidget), 'move-up', () => {
        if (i !== 0) {
          getter(this.dimensionElements[i - 1]).focus();
        }
      });
      registerActionListener(getter(dimWidget), 'move-down', () => {
        if (i !== 2) {
          getter(this.dimensionElements[i + 1]).focus();
        }
      });
    }
    return dimWidget;
  });

  private zoomDimension(i: number, sign: number) {
    this.updateScaleFactors();
    const {renderDimensions} = this;
    const {renderScaleFactors} = renderDimensions;
    const {dimensionIndices} = renderDimensions.value;
    const dim = dimensionIndices[i];
    if (dim === -1) return;
    const {factors} = renderScaleFactors.value;
    const newFactors = new Float64Array(factors);
    newFactors[dim] *= 2 ** (-sign);
    renderScaleFactors.setFactors(newFactors);
  }

  private updateNameValidity() {
    const {dimensionElements} = this;
    const {dimensionIndices} = this.renderDimensions.value;
    const names = dimensionElements.map(w => w.name.value);
    const isValid = getDimensionNameValidity(names);
    const coordinateSpace = this.renderDimensions.coordinateSpace.value;
    const {dimensionNames} = coordinateSpace;
    const rank = names.length;
    for (let i = 0; i < rank; ++i) {
      let valid = isValid[i];
      const name = names[i];
      let newIndex = -1;
      if (name.length === 0) {
        valid = true;
      } else {
        newIndex = dimensionNames.indexOf(name);
        if (newIndex === -1) {
          valid = false;
        }
      }
      const dimElements = dimensionElements[i];
      dimElements.name.dataset.isValid = valid.toString();
      dimElements.container.dataset.isModified = (newIndex !== dimensionIndices[i]).toString();
    }
  }

  private scheduleUpdateView = animationFrameDebounce(() => this.updateView());
  constructor(
      public renderDimensions: Owned<TrackableRenderDimensions>,
      public zoom: TrackableZoomInterface, public displayUnit = 'px') {
    super();
    const {element, defaultCheckbox, defaultCheckboxLabel} = this;
    element.classList.add('neuroglancer-render-dimensions-widget');
    element.addEventListener('pointerleave', () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && element.contains(focused)) {
        focused.blur();
      }
    });
    defaultCheckbox.type = 'checkbox';
    defaultCheckboxLabel.appendChild(defaultCheckbox);
    defaultCheckboxLabel.appendChild(document.createTextNode('Default'));
    defaultCheckboxLabel.title = 'Use first 3 dimensions';
    defaultCheckboxLabel.classList.add('neuroglancer-render-dimensions-widget-default');
    defaultCheckbox.addEventListener('change', () => {
      this.updateDefault();
    });
    element.appendChild(defaultCheckboxLabel);
    this.registerDisposer(renderDimensions);
    this.registerDisposer(zoom.changed.add(this.scheduleUpdateView));
    this.registerDisposer(renderDimensions.changed.add(this.scheduleUpdateView));
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    registerActionListener(element, 'cancel', () => {
      this.updateView();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && element.contains(focused)) {
        focused.blur();
      }
    });

    this.updateView();
  }

  private updateNames(): boolean {
    const names = this.dimensionElements.map(x => x.name.value).filter(x => x.length > 0);
    if (!validateDimensionNames(names)) return false;
    const {renderDimensions} = this;
    if (names.length === 0) {
      renderDimensions.reset();
      return true;
    }
    const dimensionIndices = new Int32Array(3);
    dimensionIndices.fill(-1);
    const coordinateSpace = renderDimensions.coordinateSpace.value;
    const {dimensionNames} = coordinateSpace;
    const rank = names.length;
    for (let i = 0; i < rank; ++i) {
      const index = dimensionNames.indexOf(names[i]);
      if (index === -1) return false;
      dimensionIndices[i] = index;
    }
    if (arraysEqual(dimensionIndices, renderDimensions.value.dimensionIndices)) {
      return true;
    }
    renderDimensions.setDimensionIndices(rank, dimensionIndices);
    return true;
  }

  private updateDefault() {
    this.renderDimensions.default = this.defaultCheckbox.checked;
  }

  private updateScaleFactors(): boolean {
    const {renderDimensions} = this;
    const {renderScaleFactors} = renderDimensions;
    const {dimensionIndices, rank} = renderDimensions.value;
    const {factors} = renderScaleFactors.value;
    const {dimensionElements} = this;
    const newFactors = new Float64Array(factors);
    for (let i = 0; i < rank; ++i) {
      const dimElements = dimensionElements[i];
      if (!dimElements.scaleFactorModified) continue;
      const factor = Number(dimElements.scaleFactor.value);
      const dim = dimensionIndices[i];
      if (!Number.isFinite(factor) || factor <= 0) continue;
      newFactors[dim] = factor;
    }
    if (!arraysEqual(newFactors, factors)) {
      renderScaleFactors.setFactors(newFactors);
    }
    return true;
  }

  private updateView() {
    const {dimensionElements, renderDimensions: {value: renderDimensions, default: isDefault}} =
        this;
    const {
      dimensionIndices,
      canonicalVoxelFactors,
      renderScaleFactors: {factors, coordinateSpace: {dimensionNames, units, scales}}
    } = renderDimensions;
    this.defaultCheckbox.checked = isDefault;
    const zoom = this.zoom.value;
    for (let i = 0; i < 3; ++i) {
      const dim = dimensionIndices[i];
      const dimElements = dimensionElements[i];
      delete dimElements.name.dataset.isValid;
      dimElements.container.dataset.isModified = (dim === -1).toString();
      if (dim === -1) {
        dimElements.name.value = '';
        dimElements.scale.textContent = '';
        dimElements.scaleFactor.value = '';
      } else {
        dimElements.name.value = dimensionNames[dim];
        const totalScale = scales[dim] * zoom / canonicalVoxelFactors[i];
        const {unit, prefix, scale} = formatScaleWithUnit(totalScale, units[dim], 2);
        dimElements.scale.textContent = `${scale || 1} ${prefix}${unit}/${this.displayUnit}`;
        dimElements.scaleFactor.value = formatScaleFactor(factors[dim]);
      }
      updateInputFieldWidth(dimElements.name);
      updateInputFieldWidth(dimElements.scaleFactor);
    }
  }

  disposed() {
    removeFromParent(this.element);
    this.dispose();
  }
}
