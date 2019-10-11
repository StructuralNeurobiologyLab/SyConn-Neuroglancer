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

import {CoordinateTransformSpecification, coordinateTransformSpecificationFromJson, coordinateTransformSpecificationToJson, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {DataSource, DataSourceSubresource} from 'neuroglancer/datasource';
import {UserLayer} from 'neuroglancer/layer';
import {CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {Borrowed, disposableOnce, RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {NullarySignal} from 'neuroglancer/util/signal';

export interface LayerDataSourceSpecification {
  url: string;
  transform: CoordinateTransformSpecification|undefined;
  resources: string[]|undefined;
}

export function layerDataSourceSpecificationFromJson(
    obj: unknown, legacyTransform: CoordinateTransformSpecification|undefined = undefined):
    LayerDataSourceSpecification {
  if (typeof obj === 'string') {
    return {url: obj, transform: legacyTransform, resources: undefined};
  }
  verifyObject(obj);
  return {
    url: verifyObjectProperty(obj, 'url', verifyString),
    transform: verifyObjectProperty(obj, 'transform', coordinateTransformSpecificationFromJson) ||
        legacyTransform,
    resources: verifyOptionalObjectProperty(obj, 'resources', verifyStringArray),
  };
}

export function layerDataSourceSpecificationToJson(spec: LayerDataSourceSpecification) {
  const {resources} = spec;
  const transform = coordinateTransformSpecificationToJson(spec.transform);
  if (transform === undefined && resources === undefined) {
    return spec.url;
  }
  return {
    url: spec.url,
    transform,
    resources,
  };
}

export interface LoadedDataSourceSubresource {
  subresource: DataSourceSubresource;
  enabled: boolean;
  messages: MessageList;
}

export class LoadedLayerDataSource extends RefCounted {
  error = undefined;
  enabledResourcesChanged = new NullarySignal();
  messages = new MessageList();
  transform = new WatchableCoordinateSpaceTransform(this.dataSource.modelSpace);
  subresources: LoadedDataSourceSubresource[];
  enableDefaultSubresources: boolean;
  get enabledSubresources() {
    return this.subresources.filter(x => x.enabled);
  }
  initialization: RefCounted|undefined = undefined;

  constructor(public dataSource: DataSource, spec: LayerDataSourceSpecification) {
    super();
    this.transform.spec = spec.transform;
    const enabledResources = spec.resources;
    this.enableDefaultSubresources = enabledResources === undefined;
    this.subresources = dataSource.resources.map((subresource): LoadedDataSourceSubresource => {
      return {
        subresource,
        enabled: enabledResources === undefined ? subresource.default :
                                                  enabledResources.includes(subresource.id),
        messages: new MessageList(),
      };
    });
  }
}

export type LayerDataSourceLoadState = {
  error: Error
}|LoadedLayerDataSource|undefined;

export class LayerDataSource extends RefCounted {
  changed = new NullarySignal();
  messages = new MessageList();
  private loadState_: LayerDataSourceLoadState = undefined;
  private spec_: LayerDataSourceSpecification;
  private refCounted_: RefCounted|undefined = undefined;

  constructor(
      public layer: Borrowed<UserLayer>, spec: LayerDataSourceSpecification|undefined = undefined) {
    super();
    this.registerDisposer(this.changed.add(layer.dataSourcesChanged.dispatch));
    if (spec === undefined) {
      this.spec_ = {url: '', transform: undefined, resources: undefined};
    } else {
      this.spec = spec;
    }
  }

  get spec() {
    return this.spec_;
  }

  get loadState() {
    return this.loadState_;
  }

  set spec(spec: LayerDataSourceSpecification) {
    const {layer} = this;
    const refCounted = new RefCounted();
    const retainer = refCounted.registerDisposer(disposableOnce(layer.markLoading()));
    if (this.refCounted_ !== undefined) {
      this.refCounted_.dispose();
    }
    this.refCounted_ = refCounted;
    this.spec_ = spec;
    const chunkManager = layer.manager.chunkManager;
    const registry = layer.manager.dataSourceProviderRegistry;
    const cancellationToken = new CancellationTokenSource();
    this.messages.clearMessages();
    this.messages.addMessage({severity: MessageSeverity.info, message: 'Loading data source'});
    registry.get({chunkManager, url: spec.url, cancellationToken: cancellationToken})
        .then((source: DataSource) => {
          if (refCounted.wasDisposed) return;
          this.messages.clearMessages();
          const loaded = refCounted.registerDisposer(new LoadedLayerDataSource(source, spec));
          loaded.registerDisposer(layer.addCoordinateSpace(loaded.transform.outputSpace));
          loaded.registerDisposer(loaded.transform.changed.add(this.changed.dispatch));
          loaded.registerDisposer(loaded.enabledResourcesChanged.add(this.changed.dispatch));
          const disposeInitialization = () => {
            const {initialization} = loaded;
            if (initialization !== undefined) {
              initialization.dispose();
              loaded.initialization = undefined;
            }
          };
          loaded.registerDisposer(disposeInitialization);
          const initialize = () => {
            const initialization = new RefCounted();
            for (const subresource of loaded.subresources) {
              subresource.messages.clearMessages();
            }
            layer.initializeDataSource(loaded, initialization);
            disposeInitialization();
            loaded.initialization = initialization;
            this.changed.dispatch();
          };
          loaded.enabledResourcesChanged.add(initialize);
          this.loadState_ = loaded;
          initialize();
          retainer();
        })
        .catch((error: Error) => {
          if (this.wasDisposed) return;
          this.loadState_ = {error};
          this.messages.clearMessages();
          this.messages.addMessage({severity: MessageSeverity.error, message: error.message});
          this.changed.dispatch();
        });
    refCounted.registerDisposer(() => {
      cancellationToken.cancel();
    });
    this.changed.dispatch();
  }

  disposed() {
    const refCounted = this.refCounted_;
    if (refCounted !== undefined) {
      refCounted.dispose();
    }
  }

  toJSON() {
    const {loadState} = this;
    if (loadState === undefined || loadState.error !== undefined) {
      return layerDataSourceSpecificationToJson(this.spec);
    }
    return layerDataSourceSpecificationToJson({
      url: this.spec.url,
      transform: loadState.transform.spec,
      resources: loadState.enableDefaultSubresources ?
          undefined :
          loadState.subresources.filter(x => x.enabled).map(x => x.subresource.id),
    });
  }
}
