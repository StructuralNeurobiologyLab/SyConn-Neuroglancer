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

import './image_user_layer.css';

import svg_maximize from 'ikonate/icons/maximise.svg';
import {ManagedUserLayer, UserLayer} from 'neuroglancer/layer';
import {LoadedLayerDataSource} from 'neuroglancer/layer_data_source';
import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {getWatchableRenderLayerTransform} from 'neuroglancer/renderlayer';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {FRAGMENT_MAIN_START, getTrackableFragmentMain, ImageRenderLayer} from 'neuroglancer/sliceview/volume/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableBlendModeValue} from 'neuroglancer/trackable_blend';
import {UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {MessageSeverity} from 'neuroglancer/util/message_list';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeIcon} from 'neuroglancer/widget/icon';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const OPACITY_JSON_KEY = 'opacity';
const BLEND_JSON_KEY = 'blend';
const SHADER_JSON_KEY = 'shader';
const SHADER_CONTROLS_JSON_KEY = 'shaderControls';

const Base = UserLayerWithVolumeSourceMixin(UserLayer);
export class ImageUserLayer extends Base {
  opacity = trackableAlphaValue(0.5);
  blendMode = trackableBlendModeValue();
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  shaderControlState = new ShaderControlState(this.fragmentMain);
  constructor(managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super(managedLayer, specification);
    this.registerDisposer(this.blendMode.changed.add(this.specificationChanged.dispatch));
    this.registerDisposer(this.fragmentMain.changed.add(this.specificationChanged.dispatch));
    this.registerDisposer(this.shaderControlState.changed.add(this.specificationChanged.dispatch));
    this.tabs.add(
        'rendering',
        {label: 'Rendering', order: -100, getter: () => new RenderingOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  initializeDataSource(loaded: LoadedLayerDataSource, refCounted: RefCounted) {
    for (const loadedSubresource of loaded.enabledSubresources) {
      const {volume} = loadedSubresource.subresource.resource;
      if (!(volume instanceof MultiscaleVolumeChunkSource)) {
        loaded.messages.addMessage(
            {severity: MessageSeverity.error, message: 'Not compatible with image layer'});
        continue;
      }
      const renderLayer = new ImageRenderLayer(volume, {
        opacity: this.opacity,
        blendMode: this.blendMode,
        shaderControlState: this.shaderControlState,
        shaderError: this.shaderError,
        transform: refCounted.registerDisposer(getWatchableRenderLayerTransform(
            this.manager.root.coordinateSpace, this.localPosition.coordinateSpace,
            volume.modelSpace, loaded.transform)),
        renderScaleTarget: this.sliceViewRenderScaleTarget,
        renderScaleHistogram: this.sliceViewRenderScaleHistogram,
        localPosition: this.localPosition,
      });
      refCounted.registerDisposer(this.addRenderLayer(renderLayer));
      refCounted.registerDisposer(loadedSubresource.messages.addChild(renderLayer.messages));
      this.shaderError.changed.dispatch();
    }
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.opacity.restoreState(specification[OPACITY_JSON_KEY]);
    const blendValue = specification[BLEND_JSON_KEY];
    if (blendValue !== undefined) {
      this.blendMode.restoreState(blendValue);
    }
    this.fragmentMain.restoreState(specification[SHADER_JSON_KEY]);
    this.shaderControlState.restoreState(specification[SHADER_CONTROLS_JSON_KEY]);
  }
  toJSON() {
    const x = super.toJSON();
    x['type'] = 'image';
    x[OPACITY_JSON_KEY] = this.opacity.toJSON();
    x[BLEND_JSON_KEY] = this.blendMode.toJSON();
    x[SHADER_JSON_KEY] = this.fragmentMain.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] = this.shaderControlState.toJSON();
    return x;
  }
  }

function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
    shaderControlState: layer.shaderControlState,
  });
}

class RenderingOptionsTab extends Tab {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    const {element} = this;
    element.classList.add('image-dropdown');
    let {opacityWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';

    {
      const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
          this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
      renderScaleWidget.label.textContent = 'Resolution (slice)';
      element.appendChild(renderScaleWidget.element);
    }

    {
      const label = document.createElement('label');
      label.textContent = 'Blending';
      label.appendChild(this.registerDisposer(new EnumSelectWidget(layer.blendMode)).element);
      element.appendChild(label);
    }

    let spacer = document.createElement('div');
    spacer.style.flex = '1';
    const helpLink = makeIcon({
      text: '?',
      title: 'Documentation on image layer rendering',
      href:
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md',
    });

    const maximizeButton = makeIcon({
      svg: svg_maximize,
      title: 'Show larger editor view',
      onClick: () => {
        new ShaderCodeOverlay(this.layer);
      }
    });

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.codeWidget.element);
    element.appendChild(
        this.registerDisposer(new ShaderControls(layer.shaderControlState)).element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    this.content.classList.add('image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('image', ImageUserLayer);
registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);
