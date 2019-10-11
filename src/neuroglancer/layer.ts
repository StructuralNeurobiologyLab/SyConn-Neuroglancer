/**
 * @license
 * Copyright 2016 Google Inc.
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

import debounce from 'lodash/debounce';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {CoordinateSpace, CoordinateSpaceCombiner, CoordinateTransformSpecification, coordinateTransformSpecificationFromLegacyJson, isLocalDimension, TrackableCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {RenderedPanel} from 'neuroglancer/display_context';
import {LayerDataSource, LayerDataSourceSpecification, layerDataSourceSpecificationFromJson, LoadedLayerDataSource} from 'neuroglancer/layer_data_source';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {Position} from 'neuroglancer/navigation_state';
import {RenderLayer, RenderLayerRole, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {TrackableRefCounted, TrackableValue, WatchableSet, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {LayerDataSourcesTab} from 'neuroglancer/ui/layer_data_sources_tab';
import {restoreTool, Tool} from 'neuroglancer/ui/tool';
import {Borrowed, invokeDisposers, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyObjectProperty, verifyOptionalBoolean, verifyOptionalString, verifyPositiveInt} from 'neuroglancer/util/json';
import {MessageList} from 'neuroglancer/util/message_list';
import {NullarySignal} from 'neuroglancer/util/signal';
import {addSignalBinding, removeSignalBinding, SignalBindingUpdater} from 'neuroglancer/util/signal_binding_updater';
import {Trackable} from 'neuroglancer/util/trackable';
import {Uint64} from 'neuroglancer/util/uint64';
import {kEmptyFloat32Vec} from 'neuroglancer/util/vector';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {TabSpecification} from 'neuroglancer/widget/tab_view';

const TAB_JSON_KEY = 'tab';
const TOOL_JSON_KEY = 'tool';
const LOCAL_POSITION_JSON_KEY = 'layerPosition';
const LOCAL_COORDINATE_SPACE_JSON_KEY = 'layerDimensions';
const SOURCE_JSON_KEY = 'source';
const TRANSFORM_JSON_KEY = 'transform';

export class UserLayer extends RefCounted {
  get localPosition() {
    return this.managedLayer.localPosition;
  }

  get localCoordinateSpace() {
    return this.managedLayer.localCoordinateSpace;
  }

  localCoordinateSpaceCombiner =
      new CoordinateSpaceCombiner(this.localCoordinateSpace, isLocalDimension);

  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();
  private loadingCounter = 1;
  get isReady() {
    return this.loadingCounter === 0;
  }

  tabs = this.registerDisposer(new TabSpecification());
  tool: TrackableRefCounted<Tool> = this.registerDisposer(
      new TrackableRefCounted<Tool>(value => restoreTool(this, value), value => value.toJSON()));

  dataSourcesChanged = new NullarySignal();
  dataSources: LayerDataSource[] = [];

  get manager() {
    return this.managedLayer.manager;
  }

  constructor(public managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super();
    specification;
    this.tabs.changed.add(this.specificationChanged.dispatch);
    this.tool.changed.add(this.specificationChanged.dispatch);
    this.localPosition.changed.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(this.specificationChanged.dispatch);
    this.tabs.add('source', {
      label: 'Source',
      order: -100,
      getter: () => new LayerDataSourcesTab(this),
    });
  }

  canAddDataSource() {
    return true;
  }

  addDataSource(spec: LayerDataSourceSpecification) {
    this.dataSources.push(new LayerDataSource(this, spec));
    this.dataSourcesChanged.dispatch();
  }

  initializeDataSource(loaded: LoadedLayerDataSource, refCounted: RefCounted): void {
    loaded;
    refCounted;
    throw new Error('not implemented');
  }

  private decrementLoadingCounter() {
    if (--this.loadingCounter === 0) {
      this.readyStateChanged.dispatch();
    }
  }

  markLoading() {
    const localRetainer = this.localCoordinateSpaceCombiner.retain();
    const globalRetainer = this.manager.root.coordinateSpaceCombiner.retain();
    if (++this.loadingCounter === 1) {
      this.readyStateChanged.dispatch();
    }
    const disposer = () => {
      localRetainer();
      globalRetainer();
      this.decrementLoadingCounter();
    };
    return disposer;
  }

  addCoordinateSpace(coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    const globalBinding = this.manager.root.coordinateSpaceCombiner.bind(coordinateSpace);
    const localBinding = this.localCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      globalBinding();
      localBinding();
    };
  }

  initializationDone() {
    this.decrementLoadingCounter();
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: string|undefined, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): LayerDataSourceSpecification[] {
    layerSpec;
    if (sourceSpec === undefined) return [];
    return [layerDataSourceSpecificationFromJson(sourceSpec, legacyTransform)];
  }

  getDataSourceSpecifications(layerSpec: any): LayerDataSourceSpecification[] {
    let legacySpec: any = undefined;
    const specs = verifyObjectProperty(layerSpec, SOURCE_JSON_KEY, sourcesObj => {
      if (Array.isArray(sourcesObj)) {
        return sourcesObj.map(source => layerDataSourceSpecificationFromJson(source));
      } else if (typeof sourcesObj === 'object') {
        return [layerDataSourceSpecificationFromJson(sourcesObj)];
      } else {
        legacySpec = sourcesObj;
        return [];
      }
    });
    const legacyTransform = verifyObjectProperty(
        layerSpec, TRANSFORM_JSON_KEY, coordinateTransformSpecificationFromLegacyJson);
    specs.push(...this.getLegacyDataSourceSpecifications(legacySpec, layerSpec, legacyTransform));
    return specs;
  }

  restoreState(specification: any) {
    this.tool.restoreState(specification[TOOL_JSON_KEY]);
    this.tabs.restoreState(specification[TAB_JSON_KEY]);
    this.localCoordinateSpace.restoreState(specification[LOCAL_COORDINATE_SPACE_JSON_KEY]);
    this.localPosition.restoreState(specification[LOCAL_POSITION_JSON_KEY]);
    for (const spec of this.getDataSourceSpecifications(specification)) {
      this.addDataSource(spec);
    }
  }

  addRenderLayer(layer: Owned<RenderLayer>) {
    this.renderLayers.push(layer);
    const {layersChanged, readyStateChanged} = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layer.readyStateChanged.add(readyStateChanged.dispatch);
    readyStateChanged.dispatch();
    layersChanged.dispatch();
    return () => this.removeRenderLayer(layer);
  }

  removeRenderLayer(layer: RenderLayer) {
    const {renderLayers, layersChanged, readyStateChanged} = this;
    const index = renderLayers.indexOf(layer);
    if (index === -1) {
      throw new Error('Attempted to remove invalid RenderLayer');
    }
    renderLayers.splice(index, 1);
    layer.layerChanged.remove(layersChanged.dispatch);
    layer.readyStateChanged.remove(readyStateChanged.dispatch);
    layer.dispose();
    readyStateChanged.dispatch();
    layersChanged.dispatch();
  }

  disposed() {
    const {layersChanged, readyStateChanged} = this;
    invokeDisposers(this.dataSources);
    for (const layer of this.renderLayers) {
      layer.layerChanged.remove(layersChanged.dispatch);
      layer.readyStateChanged.remove(readyStateChanged.dispatch);
      layer.dispose();
    }
    this.renderLayers.length = 0;
    super.disposed();
  }

  getValueAt(position: Float32Array, pickState: PickState) {
    let result: any;
    let {renderLayers} = this;
    let {pickedRenderLayer} = pickState;
    if (pickedRenderLayer !== null && renderLayers.indexOf(pickedRenderLayer) !== -1) {
      result =
          pickedRenderLayer.transformPickedValue(pickState.pickedValue, pickState.pickedOffset);
      return this.transformPickedValue(result);
    }
    for (let layer of renderLayers) {
      if (!layer.ready) {
        continue;
      }
      result = layer.getValueAt(position);
      if (result !== undefined) {
        break;
      }
    }
    return this.transformPickedValue(result);
  }

  transformPickedValue(value: any) {
    return value;
  }

  toJSON(): any {
    return {
      [SOURCE_JSON_KEY]: dataSourcesToJson(this.dataSources),
      [TAB_JSON_KEY]: this.tabs.toJSON(),
      [TOOL_JSON_KEY]: this.tool.toJSON(),
      [LOCAL_COORDINATE_SPACE_JSON_KEY]: this.localCoordinateSpace.toJSON(),
      [LOCAL_POSITION_JSON_KEY]: this.localPosition.toJSON(),
    };
  }

  handleAction(_action: string): void {}
}

function dataSourcesToJson(sources: readonly LayerDataSource[]) {
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0].toJSON();
  return sources.map(x => x.toJSON());
}

export class ManagedUserLayer extends RefCounted {
  sourceUrl: string|undefined;
  localCoordinateSpace = new TrackableCoordinateSpace();
  localPosition = this.registerDisposer(new Position(this.localCoordinateSpace));

  readyStateChanged = new NullarySignal();
  layerChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  wasDisposed = false;
  private layer_: UserLayer|null = null;
  get layer() {
    return this.layer_;
  }
  private unregisterUserLayer: (() => void)|undefined;

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  set layer(layer: UserLayer|null) {
    let oldLayer = this.layer_;
    if (oldLayer != null) {
      this.unregisterUserLayer!();
      oldLayer.dispose();
    }
    this.layer_ = layer;
    if (layer != null) {
      const removers = [
        layer.layersChanged.add(() => this.handleLayerChanged()),
        layer.readyStateChanged.add(this.readyStateChanged.dispatch),
        layer.specificationChanged.add(this.specificationChanged.dispatch)
      ];
      this.unregisterUserLayer = () => {
        removers.forEach(x => x());
      };
      this.readyStateChanged.dispatch();
      this.handleLayerChanged();
    }
  }

  isReady() {
    const {layer} = this;
    return layer !== null && layer.isReady;
  }

  private name_: string;

  get name() {
    return this.name_;
  }

  set name(value: string) {
    if (value !== this.name_) {
      this.name_ = value;
      this.layerChanged.dispatch();
    }
  }

  visible = true;

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  constructor(
      name: string, public initialSpecification: any,
      public manager: Borrowed<LayerListSpecification>) {
    super();
    this.name_ = name;
  }

  toJSON() {
    let userLayer = this.layer;
    if (!userLayer) {
      return this.initialSpecification;
    }
    let layerSpec = userLayer.toJSON();
    layerSpec.name = this.name;
    if (!this.visible) {
      layerSpec['visible'] = false;
    }
    return layerSpec;
  }

  private handleLayerChanged() {
    if (this.visible) {
      this.layerChanged.dispatch();
    }
  }
  setVisible(value: boolean) {
    if (value !== this.visible) {
      this.visible = value;
      this.layerChanged.dispatch();
    }
  }

  disposed() {
    this.wasDisposed = true;
    this.layer = null;
    super.disposed();
  }
}

export class LayerManager extends RefCounted {
  managedLayers = new Array<Owned<ManagedUserLayer>>();
  layerSet = new Set<Borrowed<ManagedUserLayer>>();
  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  boundPositions = new WeakSet<Position>();
  numDirectUsers = 0;
  private renderLayerToManagedLayerMapGeneration = -1;
  private renderLayerToManagedLayerMap_ = new Map<RenderLayer, ManagedUserLayer>();

  constructor() {
    super();
    this.layersChanged.add(this.scheduleRemoveLayersWithSingleRef);
  }

  private scheduleRemoveLayersWithSingleRef =
      this.registerCancellable(debounce(() => this.removeLayersWithSingleRef(), 0));

  get renderLayerToManagedLayerMap() {
    const generation = this.layersChanged.count;
    const map = this.renderLayerToManagedLayerMap_;
    if (this.renderLayerToManagedLayerMapGeneration !== generation) {
      this.renderLayerToManagedLayerMapGeneration = generation;
      map.clear();
      for (const managedLayer of this.managedLayers) {
        const userLayer = managedLayer.layer;
        if (userLayer !== null) {
          for (const renderLayer of userLayer.renderLayers) {
            map.set(renderLayer, managedLayer);
          }
        }
      }
    }
    return map;
  }

  filter(predicate: (layer: ManagedUserLayer) => boolean) {
    let changed = false;
    this.managedLayers = this.managedLayers.filter(layer => {
      if (!predicate(layer)) {
        this.unbindManagedLayer(layer);
        this.layerSet.delete(layer);
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) {
      this.layersChanged.dispatch();
    }
  }

  private removeLayersWithSingleRef() {
    if (this.numDirectUsers > 0) {
      return;
    }
    this.filter(layer => layer.refCount !== 1);
  }

  private updateSignalBindings(
      layer: ManagedUserLayer, callback: SignalBindingUpdater<() => void>) {
    callback(layer.layerChanged, this.layersChanged.dispatch);
    callback(layer.readyStateChanged, this.readyStateChanged.dispatch);
    callback(layer.specificationChanged, this.specificationChanged.dispatch);
  }

  useDirectly() {
    if (++this.numDirectUsers === 1) {
      this.layersChanged.remove(this.scheduleRemoveLayersWithSingleRef);
    }
    return () => {
      if (--this.numDirectUsers === 0) {
        this.layersChanged.add(this.scheduleRemoveLayersWithSingleRef);
        this.scheduleRemoveLayersWithSingleRef();
      }
    };
  }

  /**
   * Assumes ownership of an existing reference to managedLayer.
   */
  addManagedLayer(managedLayer: ManagedUserLayer, index?: number|undefined) {
    this.updateSignalBindings(managedLayer, addSignalBinding);
    this.layerSet.add(managedLayer);
    if (index === undefined) {
      index = this.managedLayers.length;
    }
    this.managedLayers.splice(index, 0, managedLayer);
    this.layersChanged.dispatch();
    this.readyStateChanged.dispatch();
    return managedLayer;
  }

  * readyRenderLayers() {
    for (let managedUserLayer of this.managedLayers) {
      if (!managedUserLayer.visible || !managedUserLayer.layer) {
        continue;
      }
      for (let renderLayer of managedUserLayer.layer.renderLayers) {
        if (!renderLayer.ready) {
          continue;
        }
        yield renderLayer;
      }
    }
  }

  unbindManagedLayer(managedLayer: ManagedUserLayer) {
    this.updateSignalBindings(managedLayer, removeSignalBinding);
    managedLayer.dispose();
  }

  clear() {
    for (let managedLayer of this.managedLayers) {
      this.unbindManagedLayer(managedLayer);
    }
    this.managedLayers.length = 0;
    this.layerSet.clear();
    this.layersChanged.dispatch();
  }

  remove(index: number) {
    const layer = this.managedLayers[index];
    this.unbindManagedLayer(layer);
    this.managedLayers.splice(index, 1);
    this.layerSet.delete(layer);
    this.layersChanged.dispatch();
  }

  removeManagedLayer(managedLayer: ManagedUserLayer) {
    let index = this.managedLayers.indexOf(managedLayer);
    if (index === -1) {
      throw new Error(`Internal error: invalid managed layer.`);
    }
    this.remove(index);
  }

  reorderManagedLayer(oldIndex: number, newIndex: number) {
    const numLayers = this.managedLayers.length;
    if (oldIndex === newIndex || oldIndex < 0 || oldIndex >= numLayers || newIndex < 0 ||
        newIndex >= numLayers) {
      // Don't do anything.
      return;
    }
    let [oldLayer] = this.managedLayers.splice(oldIndex, 1);
    this.managedLayers.splice(newIndex, 0, oldLayer);
    this.layersChanged.dispatch();
  }

  disposed() {
    this.clear();
    super.disposed();
  }

  getLayerByName(name: string) {
    return this.managedLayers.find(x => x.name === name);
  }

  getUniqueLayerName(name: string) {
    let suggestedName = name;
    let suffix = 0;
    while (this.getLayerByName(suggestedName) !== undefined) {
      suggestedName = name + (++suffix);
    }
    return suggestedName;
  }

  has(layer: Borrowed<ManagedUserLayer>) {
    return this.layerSet.has(layer);
  }

  get renderLayers() {
    let layerManager = this;
    return {
      * [Symbol.iterator]() {
          for (let managedLayer of layerManager.managedLayers) {
            if (managedLayer.layer === null) {
              continue;
            }
            for (let renderLayer of managedLayer.layer.renderLayers) {
              yield renderLayer;
            }
          }
        }
    };
  }

  get visibleRenderLayers() {
    let layerManager = this;
    return {
      * [Symbol.iterator]() {
          for (let managedLayer of layerManager.managedLayers) {
            if (managedLayer.layer === null || !managedLayer.visible) {
              continue;
            }
            for (let renderLayer of managedLayer.layer.renderLayers) {
              yield renderLayer;
            }
          }
        }
    };
  }

  invokeAction(action: string) {
    for (let managedLayer of this.managedLayers) {
      if (managedLayer.layer === null || !managedLayer.visible) {
        continue;
      }
      let userLayer = managedLayer.layer;
      userLayer.handleAction(action);
      for (let renderLayer of userLayer.renderLayers) {
        if (!renderLayer.ready) {
          continue;
        }
        renderLayer.handleAction(action);
      }
    }
  }
}

export interface PickState {
  pickedRenderLayer: RenderLayer|null;
  pickedValue: Uint64;
  pickedOffset: number;
}

export class MouseSelectionState implements PickState {
  changed = new NullarySignal();
  coordinateSpace: CoordinateSpace|undefined;
  position: Float32Array = kEmptyFloat32Vec;
  active = false;
  pickedRenderLayer: RenderLayer|null = null;
  pickedValue = new Uint64(0, 0);
  pickedOffset = 0;
  pickedAnnotationLayer: AnnotationLayerState|undefined = undefined;
  pickedAnnotationId: string|undefined = undefined;
  pickedAnnotationBuffer: ArrayBuffer|undefined = undefined;
  pickedAnnotationBufferOffset: number|undefined = undefined;
  pageX: number;
  pageY: number;

  private forcerFunction: (() => void)|undefined = undefined;

  removeForcer(forcer: (() => void)) {
    if (forcer === this.forcerFunction) {
      this.forcerFunction = undefined;
      this.setActive(false);
    }
  }

  setForcer(forcer: (() => void)|undefined) {
    this.forcerFunction = forcer;
    if (forcer === undefined) {
      this.setActive(false);
    }
  }

  updateUnconditionally(): boolean {
    const {forcerFunction} = this;
    if (forcerFunction === undefined) {
      return false;
    }
    forcerFunction();
    return this.active;
  }

  setActive(value: boolean) {
    if (this.active !== value || value === true) {
      this.active = value;
      this.changed.dispatch();
    }
  }
}

export class LayerSelectedValues extends RefCounted {
  values = new Map<UserLayer, any>();
  changed = new NullarySignal();
  needsUpdate = true;
  constructor(public layerManager: LayerManager, public mouseState: MouseSelectionState) {
    super();
    this.registerDisposer(mouseState.changed.add(() => {
      this.handleChange();
    }));
    this.registerDisposer(layerManager.layersChanged.add(() => {
      this.handleLayerChange();
    }));
  }

  /**
   * This should be called when the layer data may have changed, due to the set of managed layers
   * changing or new data having been received.
   */
  handleLayerChange() {
    if (this.mouseState.active) {
      this.handleChange();
    }
  }

  handleChange() {
    this.needsUpdate = true;
    this.changed.dispatch();
  }

  update() {
    if (!this.needsUpdate) {
      return;
    }
    this.needsUpdate = false;
    let values = this.values;
    let mouseState = this.mouseState;
    values.clear();
    if (mouseState.active) {
      let position = mouseState.position;
      for (let layer of this.layerManager.managedLayers) {
        let userLayer = layer.layer;
        if (layer.visible && userLayer) {
          values.set(userLayer, userLayer.getValueAt(position, mouseState));
        }
      }
    }
  }

  get(userLayer: UserLayer) {
    this.update();
    return this.values.get(userLayer);
  }

  toJSON() {
    this.update();
    const result: {[key: string]: any} = {};
    const {values} = this;
    for (const layer of this.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer) {
        let v = values.get(userLayer);
        if (v !== undefined) {
          if (v instanceof Uint64) {
            v = {'t': 'u64', 'v': v};
          }
          result[layer.name] = v;
        }
      }
    }
    return result;
  }
}

export class VisibleLayerInfo extends RefCounted {
  messages = new MessageList();
  seenGeneration = -1;
}

let visibleLayerInfoGeneration = 0;

export class VisibleRenderLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer> extends
    RefCounted {
  /**
   * Maps a layer to the disposer to call when it is no longer visible.
   */
  private visibleLayers_ = new Map<RenderLayerType, VisibleLayerInfo>();

  private debouncedUpdateVisibleLayers =
      this.registerCancellable(debounce(() => this.updateVisibleLayers(), 0));

  constructor(
      public layerManager: LayerManager,
      public renderLayerType: {new(...args: any[]): RenderLayerType},
      public roles: WatchableSet<RenderLayerRole>,
      private layerAdded: (layer: RenderLayerType, info: VisibleLayerInfo) => void,
      public visibility: WatchableVisibilityPriority) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.debouncedUpdateVisibleLayers));
    this.registerDisposer(roles.changed.add(this.debouncedUpdateVisibleLayers));
    this.updateVisibleLayers();
  }

  disposed() {
    this.visibleLayers.forEach(x => x.dispose());
    this.visibleLayers.clear();
    super.disposed();
  }

  private updateVisibleLayers() {
    const curGeneration = ++visibleLayerInfoGeneration;
    const {visibleLayers_: visibleLayers, renderLayerType, layerAdded, roles} = this;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof renderLayerType && roles.has(renderLayer.role)) {
        let typedLayer = <RenderLayerType>renderLayer;
        let info = visibleLayers.get(typedLayer);
        if (info === undefined) {
          info = new VisibleLayerInfo();
          info.registerDisposer(typedLayer.messages.addChild(info.messages));
          info.registerDisposer(typedLayer.addRef());
          info.registerDisposer(typedLayer.visibility.add(this.visibility));
          visibleLayers.set(typedLayer, info);
          layerAdded(typedLayer, info);
        }
        info.seenGeneration = curGeneration;
      }
    }
    for (const [renderLayer, info] of visibleLayers) {
      if (info.seenGeneration !== curGeneration) {
        visibleLayers.delete(renderLayer);
        info.dispose();
      }
    }
  }

  get visibleLayers() {
    this.debouncedUpdateVisibleLayers.flush();
    return this.visibleLayers_;
  }
}

export function
makeRenderedPanelVisibleLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer>(
    layerManager: LayerManager, renderLayerType: {new (...args: any[]): RenderLayerType},
    roles: WatchableSet<RenderLayerRole>, panel: RenderedPanel,
    layerAdded?: (layer: RenderLayerType, info: VisibleLayerInfo) => void) {
  return panel.registerDisposer(
      new VisibleRenderLayerTracker(layerManager, renderLayerType, roles, (layer, info) => {
        info.registerDisposer(layer.redrawNeeded.add(() => panel.scheduleRedraw()));
        if (layerAdded !== undefined) {
          layerAdded(layer, info);
        }
        panel.scheduleRedraw();
        info.registerDisposer(() => panel.scheduleRedraw());
      }, panel.visibility));
}

export class SelectedLayerState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  visible_ = false;
  layer_: ManagedUserLayer|undefined;
  size = new TrackableValue<number>(300, verifyPositiveInt)

  get layer() {
    return this.layer_;
  }

  get visible() {
    return this.visible_;
  }

  set visible(value: boolean) {
    if (this.layer_ === undefined) {
      value = false;
    }
    if (this.visible_ !== value) {
      this.visible_ = value;
      this.changed.dispatch();
    }
  }

  private existingLayerDisposer?: () => void;

  constructor(public layerManager: Owned<LayerManager>) {
    super();
    this.registerDisposer(layerManager);
    this.size.changed.add(this.changed.dispatch);
  }

  set layer(layer: ManagedUserLayer|undefined) {
    if (layer === this.layer_) {
      return;
    }
    if (this.layer_ !== undefined) {
      this.existingLayerDisposer!();
      this.existingLayerDisposer = undefined;
    }
    this.layer_ = layer;
    if (layer !== undefined) {
      const layerDisposed = () => {
        this.layer_ = undefined;
        this.visible = false;
        this.existingLayerDisposer = undefined;
        this.changed.dispatch();
      };
      layer.registerDisposer(layerDisposed);
      const layerChangedDisposer = layer.specificationChanged.add(() => {
        this.changed.dispatch();
      });
      this.existingLayerDisposer = () => {
        const userLayer = layer.layer;
        if (userLayer !== null) {
          const tool = userLayer.tool.value;
          if (tool !== undefined) {
            tool.deactivate();
          }
        }
        layer.unregisterDisposer(layerDisposed);
        layerChangedDisposer();
      };
    } else {
      this.visible_ = false;
    }
    this.changed.dispatch();
  }

  toJSON() {
    if (this.layer === undefined) {
      return undefined;
    }
    return {
      'layer': this.layer.name,
      'visible': this.visible === true ? true : undefined,
      'size': this.size.toJSON(),
    };
  }

  restoreState(obj: any) {
    if (obj === undefined) {
      this.reset();
      return;
    }
    verifyObject(obj);
    const layerName = verifyObjectProperty(obj, 'layer', verifyOptionalString);
    const layer = layerName !== undefined ? this.layerManager.getLayerByName(layerName) : undefined;
    this.layer = layer;
    this.visible = verifyObjectProperty(obj, 'visible', verifyOptionalBoolean) ? true : false;
    verifyObjectProperty(obj, 'size', x => this.size.restoreState(x));
  }

  reset() {
    this.layer = undefined;
  }
}

export class LayerReference extends RefCounted implements Trackable {
  private layerName_: string|undefined;
  private layer_: ManagedUserLayer|undefined;
  changed = new NullarySignal();
  constructor(
      public layerManager: Owned<LayerManager>,
      public filter: (layer: ManagedUserLayer) => boolean) {
    super();
    this.registerDisposer(layerManager);
    this.registerDisposer(layerManager.specificationChanged.add(() => {
      const {layer_} = this;
      if (layer_ !== undefined) {
        if (!this.layerManager.layerSet.has(layer_) || !this.filter(layer_)) {
          this.layer_ = undefined;
          this.layerName_ = undefined;
          this.changed.dispatch();
        } else {
          const {name} = layer_;
          if (name !== this.layerName_) {
            this.layerName_ = name;
            this.changed.dispatch();
          }
        }
      }
    }));
  }

  get layer() {
    return this.layer_;
  }

  get layerName() {
    return this.layerName_;
  }

  set layer(value: ManagedUserLayer|undefined) {
    if (this.layer_ === value) {
      return;
    }
    if (value !== undefined && this.layerManager.layerSet.has(value) && this.filter(value)) {
      this.layer_ = value;
      this.layerName_ = value.name;
    } else {
      this.layer_ = undefined;
      this.layerName_ = undefined;
    }
    this.changed.dispatch();
  }

  set layerName(value: string|undefined) {
    if (value === this.layerName_) {
      return;
    }
    this.layer_ = undefined;
    this.layerName_ = value;
    this.changed.dispatch();
    this.validate();
  }

  private validate = debounce(() => {
    const {layerName_} = this;
    if (layerName_ !== undefined) {
      const layer = this.layerManager.getLayerByName(layerName_);
      if (layer !== undefined && this.filter(layer)) {
        this.layer_ = layer;
        this.changed.dispatch();
      } else {
        this.layer_ = undefined;
        this.layerName_ = undefined;
        this.changed.dispatch();
      }
    }
  }, 0);

  restoreState(obj: any) {
    const layerName = verifyOptionalString(obj);
    this.layerName = layerName;
  }

  toJSON() {
    const {layer_} = this;
    if (layer_ !== undefined) {
      return layer_.name;
    }
    return this.layerName_;
  }

  reset() {
    this.layerName_ = undefined;
    this.layer_ = undefined;
    this.changed.dispatch();
  }
}
