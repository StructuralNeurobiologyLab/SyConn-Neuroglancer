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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, CoordinateSpaceCombiner, isGlobalDimension} from 'neuroglancer/coordinate_transform';
import {DataSourceProviderRegistry} from 'neuroglancer/datasource';
import {LayerManager, LayerSelectedValues, ManagedUserLayer, UserLayer} from 'neuroglancer/layer';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyObject, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {RPC} from 'neuroglancer/worker_rpc';

export function getVolumeWithStatusMessage(
    dataSourceProvider: DataSourceProviderRegistry, chunkManager: ChunkManager, x: string,
    _options: any = {}): Promise<MultiscaleVolumeChunkSource> {
  return StatusMessage.forPromise(
      new Promise(function(resolve) {
        resolve(dataSourceProvider.get({chunkManager, url: x})
                    .then(s => s.resources[0].resource.volume as MultiscaleVolumeChunkSource));
      }),
      {
        initialMessage: `Retrieving metadata for volume ${x}.`,
        delay: true,
        errorPrefix: `Error retrieving metadata for volume ${x}: `,
      });
}

export abstract class LayerListSpecification extends RefCounted {
  changed = new NullarySignal();
  spatialCoordinatesSet: Signal<(coordinates: vec3) => void>;

  /**
   * @deprecated
   */
  get worker() {
    return this.rpc;
  }

  rpc: RPC;

  dataSourceProviderRegistry: Borrowed<DataSourceProviderRegistry>;
  layerManager: Borrowed<LayerManager>;
  chunkManager: Borrowed<ChunkManager>;
  layerSelectedValues: Borrowed<LayerSelectedValues>;
  coordinateSpace: WatchableValueInterface<CoordinateSpace|undefined>;

  readonly root: TopLevelLayerListSpecification;

  abstract initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any): void;

  abstract getLayer(name: string, spec: any): ManagedUserLayer;

  abstract add(layer: Owned<ManagedUserLayer>, index?: number|undefined): void;

  /**
   * Called by user layers to indicate that a voxel position has been selected interactively.
   */
  setSpatialCoordinates(spatialCoordinates: vec3) {
    this.spatialCoordinatesSet.dispatch(spatialCoordinates);
  }

  rootLayers: Borrowed<LayerManager>;
}

export class TopLevelLayerListSpecification extends LayerListSpecification {
  get rpc() {
    return this.chunkManager.rpc!;
  }

  get root() {
    return this;
  }

  spatialCoordinatesSet = new Signal<(coordinates: vec3) => void>();
  coordinateSpaceCombiner = new CoordinateSpaceCombiner(this.coordinateSpace, isGlobalDimension);

  constructor(
      public dataSourceProviderRegistry: DataSourceProviderRegistry,
      public layerManager: LayerManager, public chunkManager: ChunkManager,
      public layerSelectedValues: LayerSelectedValues,
      public coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    this.layerManager.clear();
    if (Array.isArray(x)) {
      // If array, layers have an order
      for (const layerObj of x) {
        verifyObject(layerObj);
        const name = this.layerManager.getUniqueLayerName(
            verifyObjectProperty(layerObj, 'name', verifyString));
        this.layerManager.addManagedLayer(this.getLayer(name, layerObj));
      }
    } else {
      // Keep for backwards compatibility
      verifyObject(x);
      for (let key of Object.keys(x)) {
        this.layerManager.addManagedLayer(this.getLayer(key, x[key]));
      }
    }
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any) {
    managedLayer.initialSpecification = spec;
    if (typeof spec === 'string') {
      spec = {'source': spec};
    }
    verifyObject(spec);
    let layerType = verifyObjectProperty(spec, 'type', verifyOptionalString);
    managedLayer.visible = verifyObjectProperty(spec, 'visible', x => {
      if (x === undefined || x === true) {
        return true;
      }
      if (x === false) {
        return false;
      }
      throw new Error(`Expected boolean, but received: ${JSON.stringify(x)}.`);
    });

    const makeUserLayer = (layerConstructor: UserLayerConstructor, spec: any) => {
      const userLayer = new layerConstructor(managedLayer, spec);
      userLayer.restoreState(spec);
      userLayer.initializationDone();
      managedLayer.layer = userLayer;
    };
    if (layerType === undefined) {
      let sourceUrl = managedLayer.sourceUrl =
          verifyObjectProperty(spec, 'source', verifyOptionalString);
      if (sourceUrl === undefined) {
        throw new Error(`Either layer 'type' or 'source' URL must be specified.`);
      }
      let volumeSourcePromise =
          getVolumeWithStatusMessage(this.dataSourceProviderRegistry, this.chunkManager, sourceUrl);
      volumeSourcePromise.then(source => {
        if (this.layerManager.managedLayers.indexOf(managedLayer) === -1) {
          // Layer was removed before promise became ready.
          return;
        }
        let layerConstructor = volumeLayerTypes.get(source.volumeType);
        if (layerConstructor !== undefined) {
          makeUserLayer(layerConstructor, spec);
        } else {
          throw new Error(`Unsupported volume type: ${VolumeType[source.volumeType]}.`);
        }
      });
    } else {
      let layerConstructor = layerTypes.get(layerType);
      if (layerConstructor !== undefined) {
        makeUserLayer(layerConstructor, spec);
      } else {
        throw new Error(`Unsupported layer type: ${JSON.stringify(layerType)}.`);
      }
    }
  }

  getLayer(name: string, spec: any): ManagedUserLayer {
    let managedLayer = new ManagedUserLayer(name, spec, this);
    this.initializeLayerFromSpec(managedLayer, spec);
    return managedLayer;
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
    if (this.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.layerManager.getUniqueLayerName(layer.name);
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  toJSON() {
    const result = [];
    let numResults = 0;
    for (let managedLayer of this.layerManager.managedLayers) {
      const layerJson = (<ManagedUserLayer>managedLayer).toJSON();
      // A `null` layer specification is used to indicate a transient drag target, and should not be
      // serialized.
      if (layerJson != null) {
        result.push(layerJson);
        ++numResults;
      }
    }
    if (numResults === 0) {
      return undefined;
    }
    return result;
  }

  get rootLayers() {
    return this.layerManager;
  }
}

/**
 * Class for specifying a subset of a TopLevelLayerListsSpecification.
 */
export class LayerSubsetSpecification extends LayerListSpecification {
  changed = new NullarySignal();

  get spatialCoordinatesSet() {
    return this.master.spatialCoordinatesSet;
  }
  get rpc() {
    return this.master.rpc;
  }
  get dataSourceProviderRegistry() {
    return this.master.dataSourceProviderRegistry;
  }
  get chunkManager() {
    return this.master.chunkManager;
  }
  get layerSelectedValues() {
    return this.master.layerSelectedValues;
  }

  get root() {
    return this.master;
  }

  layerManager = this.registerDisposer(new LayerManager());

  constructor(public master: Owned<TopLevelLayerListSpecification>) {
    super();
    this.registerDisposer(master);
    const {layerManager} = this;
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    const masterLayerManager = this.master.layerManager;
    const layers: ManagedUserLayer[] = [];
    for (const name of new Set(parseArray(x, verifyString))) {
      const layer = masterLayerManager.getLayerByName(name);
      if (layer === undefined) {
        throw new Error(
            `Undefined layer referenced in subset specification: ${JSON.stringify(name)}`);
      }
      layers.push(layer);
    }
    this.layerManager.clear();
    for (const layer of layers) {
      this.layerManager.addManagedLayer(layer.addRef());
    }
  }

  toJSON() {
    return this.layerManager.managedLayers.map(x => x.name);
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any) {
    this.master.initializeLayerFromSpec(managedLayer, spec);
  }

  getLayer(name: string, spec: any): ManagedUserLayer {
    return this.master.getLayer(name, spec);
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
    if (this.master.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.master.layerManager.getUniqueLayerName(layer.name);
      this.master.layerManager.addManagedLayer(layer.addRef());
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  get rootLayers() {
    return this.master.rootLayers;
  }
}

interface UserLayerConstructor {
  new(managedLayer: Borrowed<ManagedUserLayer>, specification: any): UserLayer;
}

const layerTypes = new Map<string, UserLayerConstructor>();
const volumeLayerTypes = new Map<VolumeType, UserLayerConstructor>();

export function registerLayerType(name: string, layerConstructor: UserLayerConstructor) {
  layerTypes.set(name, layerConstructor);
}

export function registerVolumeLayerType(
    volumeType: VolumeType, layerConstructor: UserLayerConstructor) {
  volumeLayerTypes.set(volumeType, layerConstructor);
}
