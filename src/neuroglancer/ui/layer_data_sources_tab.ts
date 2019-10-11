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
 * @file Tab for showing layer data sources and coordinate transforms.
 */

import './layer_data_sources_tab.css';

import {UserLayer} from 'neuroglancer/layer';
import {LayerDataSource, LoadedDataSourceSubresource, LoadedLayerDataSource} from 'neuroglancer/layer_data_source';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DataType} from 'neuroglancer/util/data_type';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {CoordinateSpaceTransformWidget} from 'neuroglancer/widget/coordinate_transform';
import {AutocompleteTextInput, makeCompletionElementWithDescription} from 'neuroglancer/widget/multiline_autocomplete';
import {Tab} from 'neuroglancer/widget/tab_view';

class SourceUrlAutocomplete extends AutocompleteTextInput {
  dataSourceView: DataSourceView;
  constructor(dataSourceView: DataSourceView) {
    const {manager} = dataSourceView.source.layer;
    const sourceCompleter = (value: string, cancellationToken: CancellationToken) =>
        manager.dataSourceProviderRegistry
            .completeUrl({url: value, chunkManager: manager.chunkManager, cancellationToken})
            .then(originalResult => ({
                    completions: originalResult.completions,
                    makeElement: makeCompletionElementWithDescription,
                    offset: originalResult.offset,
                    showSingleResult: true,
                  }));

    super({completer: sourceCompleter, delay: 0});
    this.dataSourceView = dataSourceView;
    this.element.classList.add('neuroglancer-layer-data-source-url-input');
    const updateUrlFromView = (url: string) => {
      const {source} = this.dataSourceView;
      const existingSpec = source.spec;
      if (url === existingSpec.url) return;
      source.spec = {...existingSpec, url: this.value};
    };
    this.inputChanged.add(updateUrlFromView);
  }

  cancel() {
    this.value = this.dataSourceView.source.spec.url;
    this.inputElement.blur();
    return true;
  }
}

export class MessagesView extends RefCounted {
  element = document.createElement('ul');
  generation = -1;

  constructor(public model: MessageList) {
    super();
    this.element.classList.add('neuroglancer-layer-data-sources-source-messages');
    const debouncedUpdateView =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(model.changed.add(debouncedUpdateView));
    this.registerDisposer(() => removeFromParent(this.element));
    this.updateView();
  }

  updateView() {
    const {model} = this;
    const generation = model.changed.count;
    if (generation === this.generation) return;
    this.generation = generation;
    const {element} = this;
    removeChildren(element);
    const seen = new Set<string>();
    for (const message of model) {
      const key = `${message.severity} ${message.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const li = document.createElement('li');
      element.appendChild(li);
      li.classList.add(`neuroglancer-message-${MessageSeverity[message.severity]}`);
      li.textContent = message.message;
    }
  }
}

export class DataSourceSubresourceView extends RefCounted {
  element = document.createElement('div');

  constructor(
      loadedSource: LoadedLayerDataSource, public loadedSubresource: LoadedDataSourceSubresource) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-layer-data-source-subresource');
    const sourceInfoLine = document.createElement('label');
    const sourceType = document.createElement('span');
    const enabledCheckbox = this.registerDisposer(new TrackableBooleanCheckbox({
      get value() {
        return loadedSubresource.enabled;
      },
      set value(value: boolean) {
        loadedSubresource.enabled = value;
        loadedSource.enableDefaultSubresources = false;
        loadedSource.enabledResourcesChanged.dispatch();
      },
      changed: loadedSource.enabledResourcesChanged,
    }));
    sourceInfoLine.classList.add('neuroglancer-layer-data-sources-info-line');
    sourceInfoLine.appendChild(enabledCheckbox.element);

    const sourceId = document.createElement('span');
    sourceId.classList.add('neuroglancer-layer-data-sources-source-id');
    sourceId.textContent = loadedSubresource.subresource.id;
    sourceInfoLine.appendChild(sourceId);
    sourceType.classList.add('neuroglancer-layer-data-sources-source-type');
    const messagesView = this.registerDisposer(new MessagesView(this.loadedSubresource.messages));
    element.appendChild(sourceInfoLine);
    sourceInfoLine.appendChild(sourceType);
    element.appendChild(messagesView.element);
    let sourceTypeStr = '';
    const {resource} = loadedSubresource.subresource;
    const {volume} = resource;
    if (volume instanceof MultiscaleVolumeChunkSource) {
      sourceTypeStr = `${DataType[volume.dataType].toLowerCase()} volume`;
    } else if (resource.mesh instanceof MeshSource) {
      sourceTypeStr = 'meshes (single-res.)';
    } else if (resource.mesh instanceof MultiscaleMeshSource) {
      sourceTypeStr = 'meshes (multi-res.)';
    } else if (resource.mesh instanceof SkeletonSource) {
      sourceTypeStr = 'skeletons';
    }
    sourceType.textContent = sourceTypeStr;
  }
}

export class LoadedDataSourceView extends RefCounted {
  element = document.createElement('div');

  constructor(public source: Borrowed<LoadedLayerDataSource>) {
    super();
    const {element} = this;
    const enableDefaultSubresourcesLabel = document.createElement('label');
    enableDefaultSubresourcesLabel.classList.add('neuroglancer-layer-data-sources-source-default');
    enableDefaultSubresourcesLabel.appendChild(
        this.registerDisposer(new TrackableBooleanCheckbox({
              changed: source.enabledResourcesChanged,
              get value() {
                return source.enableDefaultSubresources;
              },
              set value(value: boolean) {
                if (source.enableDefaultSubresources === value) return;
                source.enableDefaultSubresources = value;
                if (value) {
                  for (const subresource of source.subresources) {
                    subresource.enabled = subresource.subresource.default;
                  }
                }
                source.enabledResourcesChanged.dispatch();
              },
            }))
            .element);
    enableDefaultSubresourcesLabel.appendChild(document.createTextNode('Enable default resources'));
    enableDefaultSubresourcesLabel.title = 'Enable the default resources for this data source.';
    element.appendChild(enableDefaultSubresourcesLabel);
    for (const subresource of source.subresources) {
      element.appendChild(
          this.registerDisposer(new DataSourceSubresourceView(source, subresource)).element);
    }
    const transformWidget =
        this.registerDisposer(new CoordinateSpaceTransformWidget(source.transform));
    this.element.appendChild(transformWidget.element);
    this.registerDisposer(() => removeFromParent(this.element));
  }
}

export class DataSourceView extends RefCounted {
  element = document.createElement('div');
  urlInput: AutocompleteTextInput;

  seenGeneration = 0;
  generation = -1;
  private loadedView: LoadedDataSourceView|undefined;

  constructor(public source: LayerDataSource) {
    super();
    const urlInput = this.urlInput = this.registerDisposer(new SourceUrlAutocomplete(this));
    const {element} = this;
    element.classList.add('neuroglancer-layer-data-source');
    element.appendChild(urlInput.element);
    element.appendChild(this.registerDisposer(new MessagesView(source.messages)).element);
    this.updateView();
  }

  updateView() {
    const generation = this.source.changed.count;
    if (generation === this.generation) return;
    this.generation = generation;
    this.urlInput.value = this.source.spec.url;
    const {loadState} = this.source;
    let {loadedView} = this;
    if (loadedView !== undefined) {
      if (loadedView.source === loadState) {
        return;
      }
      loadedView.dispose();
      loadedView = this.loadedView = undefined;
    }
    if (loadState instanceof LoadedLayerDataSource) {
      loadedView = this.loadedView = new LoadedDataSourceView(loadState);
      this.element.appendChild(loadedView.element);
    }
  }

  disposed() {
    const {loadedView} = this;
    if (loadedView !== undefined) {
      loadedView.dispose();
    }
    removeFromParent(this.element);
    super.disposed();
  }
}

export class LayerDataSourcesTab extends Tab {
  generation = -1;
  private sourceViews = new Map<LayerDataSource, DataSourceView>();
  constructor(public layer: Borrowed<UserLayer>) {
    super();
    this.element.classList.add('neuroglancer-layer-data-sources-tab');
    const reRender = animationFrameDebounce(() => this.updateView());
    this.registerDisposer(layer.dataSourcesChanged.add(reRender));
    this.registerDisposer(this.visibility.changed.add(reRender));
    this.updateView();
  }

  disposed() {
    const {sourceViews} = this;
    for (const dataSource of sourceViews.values()) {
      dataSource.dispose();
    }
    sourceViews.clear();
    super.disposed();
  }

  private updateView() {
    if (!this.visible) return;
    const generation = this.layer.dataSourcesChanged.count;
    if (generation === this.generation) return;
    this.generation = generation;
    const {element} = this;
    let nextChild = element.firstElementChild;
    const {sourceViews} = this;
    const curSeenGeneration = Date.now();
    for (const source of this.layer.dataSources) {
      let view = sourceViews.get(source);
      if (view === undefined) {
        view = new DataSourceView(source);
        sourceViews.set(source, view);
      }
      const viewElement = view.element;
      if (viewElement !== nextChild) {
        element.insertBefore(viewElement, nextChild);
      }
      nextChild = viewElement.nextElementSibling;
      view.seenGeneration = curSeenGeneration;
      view.updateView();
    }
    for (const [source, view] of sourceViews) {
      if (view.seenGeneration !== curSeenGeneration) {
        view.dispose();
        sourceViews.delete(source);
      }
    }
  }
}
