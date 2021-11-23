/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateArray, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/knossos/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {Borrowed} from 'neuroglancer/util/disposable';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {HttpError, isNotFoundError, parseUrl, responseText} from 'neuroglancer/util/http_request';
import {expectArray, parseArray, parseFixedLengthArray, verifyEnumString, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {createHomogeneousScaleMatrix} from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import {scaleByExp10, unitFromJson} from 'neuroglancer/util/si_units';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';


class KnossosVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

//TODO add skeleton and mesh here

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  baseScaleIndex: number;

  modelSpace: CoordinateSpace;

  get rank() {
    return this.modelSpace.rank;
  }

  constructor(
      chunkManager: Borrowed<ChunkManager>,
      public credentialsProvider: SpecialProtocolCredentialsProvider,
      public multiscaleMetadata: MultiscaleMetadata, public scales: (ScaleMetadata|undefined)[]) {
    super(chunkManager);
    let dataType: DataType|undefined;
    let baseScaleIndex: number|undefined;
    scales.forEach((scale, i) => {
      if (scale === undefined) return;
      if (baseScaleIndex === undefined) {
        baseScaleIndex = i;
      }
      if (dataType !== undefined && scale.dataType !== dataType) {
        throw new Error(`Scale s${i} has data type ${DataType[scale.dataType]} but expected ${
            DataType[dataType]}.`);
      }
      dataType = scale.dataType;
    });
    if (dataType === undefined) {
      throw new Error(`At least one scale must be specified.`);
    }
    const baseDownsamplingInfo = multiscaleMetadata.scales[baseScaleIndex!]!;
    const baseScale = scales[baseScaleIndex!]!;
    this.dataType = dataType;
    this.volumeType = VolumeType.IMAGE;
    this.baseScaleIndex = baseScaleIndex!;
    const baseModelSpace = multiscaleMetadata.modelSpace;
    const {rank} = baseModelSpace;
    this.modelSpace = makeCoordinateSpace({
      names: baseModelSpace.names,
      scales: baseModelSpace.scales,
      units: baseModelSpace.units,
      boundingBoxes: [
        {
          transform: createHomogeneousScaleMatrix(
              Float64Array, baseDownsamplingInfo.downsamplingFactor, /*square=*/ false),
          box: {
            lowerBounds: new Float64Array(rank),
            upperBounds: new Float64Array(baseScale.size),
          },
        },
      ],
      coordinateArrays: baseModelSpace.coordinateArrays,
    });
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const {} = this;
    const {scales, rank} = this;
    const scalesDownsamplingInfo = this.multiscaleMetadata.scales;
    return transposeNestedArrays(
        (scales.filter(scale => scale !== undefined) as ScaleMetadata[]).map((scale, i) => {
          const scaleDownsamplingInfo = scalesDownsamplingInfo[i];
          const transform =
              createHomogeneousScaleMatrix(Float32Array, scaleDownsamplingInfo.downsamplingFactor);
          return makeDefaultVolumeChunkSpecifications({
                   rank,
                   chunkToMultiscaleTransform: transform,
                   dataType: scale.dataType,
                   upperVoxelBound: scale.size,
                   volumeType: this.volumeType,
                   chunkDataSizes: [scale.chunkSize],
                   volumeSourceOptions,
                 })
              .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                     chunkSource: this.chunkManager.getChunkSource(KnossosVolumeChunkSource, {
                       credentialsProvider: this.credentialsProvider,
                       spec,
                       parameters: {url: scaleDownsamplingInfo.url, encoding: scale.encoding}
                     }),
                     chunkToMultiscaleTransform: transform,
                   }));
        }));
  }
}

interface MultiscaleMetadata {
  url: string;
  attributes: any;
  modelSpace: CoordinateSpace;
  scales: {readonly url: string; readonly downsamplingFactor: Float64Array;}[];
  dimensions: Float32Array;
  chunk_sizes: Uint32Array;
  compression: string;
  dataType: string;
}
;

class ScaleMetadata {
  dataType: DataType;
  encoding: VolumeChunkEncoding;
  size: Float32Array;
  chunkSize: Uint32Array;

  constructor(dataType: string, dimensions: Float32Array, chunk_sizes: Uint32Array, downsamplingArray: Float32Array, compression: string) {
    this.dataType = verifyEnumString(dataType, DataType);
    this.size = dimensions.map((x,i) => x/downsamplingArray[i]);         // TODO support  anisotropic downsampling too
    // console.log(this.size)
    this.chunkSize = chunk_sizes;
    let encoding: VolumeChunkEncoding|undefined;
    encoding = verifyEnumString(compression, VolumeChunkEncoding)
    this.encoding = encoding;
  }
}

function getAllScales(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    multiscaleMetadata: MultiscaleMetadata): Promise<(ScaleMetadata | undefined)[]> {
  return Promise.all(multiscaleMetadata.scales.map(async scale => {
    return new ScaleMetadata(multiscaleMetadata.dataType, multiscaleMetadata.dimensions, multiscaleMetadata.chunk_sizes, scale.downsamplingFactor, multiscaleMetadata.compression);
  }));
}

function getAttributesJsonUrls(url: string): string[] {
  let {protocol, host, path} = parseUrl(url);
  if (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  const urls: string[] = [];
  urls.push(`${protocol}://${host}${path}/knossos.pyk.conf`);
  return urls;
}

function getIndividualAttributesText(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, required: boolean): Promise<any> {
  return chunkManager.memoize.getUncounted(
    {type: 'knossos:attributes.txt', url, credentialsProvider: getObjectId(credentialsProvider)},
    getter = () => cancellableFetchSpecialOk(credentialsProvider, url, {}, responseText)
                .then(j => {
                  try {
                    return verifyString(j);
                  } catch (e) {
                    throw new Error(`Error reading attributes from ${url}: ${e.message}`);
                  }
                })
                .catch(e => {
                  if (isNotFoundError(e)) {
                    if (required) return undefined;
                    return {};
                  }
                  throw e;
                }));
}

async function getAttributes(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, required: boolean): Promise<unknown> {
  const attributesJsonUrls = getAttributesJsonUrls(url);
  const metadata = await Promise.all(attributesJsonUrls.map(
      (u, i) => getIndividualAttributesText(
          chunkManager, credentialsProvider, u, required && i === attributesJsonUrls.length - 1)));
  if (metadata.indexOf(undefined) !== -1) return undefined;
  return metadata[0];
}

function verifyRank(existing: number, n: number) {
  if (existing !== -1 && n !== existing) {
    throw new Error(`Rank mismatch, received ${n} but expected ${existing}`);
  }
  return n;
}

const defaultAxes = ['x', 'y', 'z', 't', 'c'];
const defaultUnits = ['nm', 'nm', 'nm', 'nm', 'nm'];

function getDefaultAxes(rank: number) {
  const axes = defaultAxes.slice(0, rank);
  while (axes.length < rank) {
    axes.push(`d${axes.length + 1}`);
  }
  return axes;
}

function getDefaultUnits(rank: number) {
  return defaultUnits.slice(0, rank);
}

function getMultiscaleMetadata(url: string, attributes: any): MultiscaleMetadata {
  // verifyString(attributes);
  let rank = 3;

  //initialize attributes
  let dimensions = [];
  let axes = [];
  let scales: Array<Float64Array> = [];
  let chunk_sizes = [];
  let downsamplingFactors = [];
  let compression = '';

  let dataType = 'uint64';                        //TODO change here
  // if(url.split('/')[-1] === 'segmentation'){
  //
  // }
  // else if(url.split('/')[-1] === 'image'){
  //
  // }

  // get string properties
  const lines = attributes.split('\n');
  // console.log(lines);

  for(let ind = 0; ind < lines.length; ++ind){
    let split_line = lines[ind].split(' ');
    // console.log(split_line);
    switch (split_line[0]) {
      case '_DataScale':
        temp = lines[ind].split(',');
        temp[0] = temp[0].slice(temp[0].length-2,temp[0].length);
        data_scales = temp.map((elem) => {
          //remove last ',' if there is one
          if (elem[0] === ' ') {
            return elem.substring(1, elem.length);
          }
          return elem;
        });
        for(let i = 0; i < data_scales.length; i=i+3){
          scales.push(Float64Array.of(data_scales[i], data_scales[i+1], data_scales[i+2]));
        }
        break;
      case '_Extent':
        dimensions = Float32Array.from(split_line[2].split(',').map(Number));
        rank = verifyRank(rank, dimensions.length);
        break;
      case '_BaseExt':
        if(split_line[2] === '.seg.sz.zip'){
          compression = 'KNOSSOS';
        }
        break;
      case '_CubeSize':
        chunk_sizes = Uint32Array.from(split_line[2].split(',').map(Number));
        rank = verifyRank(rank, chunk_sizes.length);
        break;
      default:
        continue;
    }
  }

  //set axes and units
  axes = getDefaultAxes(rank);
  units = getDefaultUnits(rank);

  // compute downsampling scales
  // assume mag 1 exists
  downsamplingFactors.push([1,1,1]);
  for(let i = 1; i < scales.length; ++i){
    factor = [];
    for(let j = 0; j < 3; ++j){
       factor.push(scales[i][j]/scales[0][j]);
    }
    downsamplingFactors.push(factor);
  }

  if (units === undefined) {
    units = new Array(rank);
    units.fill(defaultUnit);
  }
  // if (scales === undefined) {
  //   scales = new Float64Array(rank);
  //   scales.fill(1);
  // }
  // scales.forEach((elem) => {
  //   elem.forEach(i => {console.log(`${i}`)});
  // });

  baseScale = [];
  for (let i = 0; i < rank; ++i) {
    baseScale.push(scaleByExp10(scales[0][i], -9));
  }
  console.log(baseScale);
  // if (axes === undefined) {
  //   axes = getDefaultAxes(rank);
  // }
  axes = ['x','y','z'];
  const modelSpace = makeCoordinateSpace({
    rank: rank,
    valid: true,
    names: axes,
    scales: baseScale,
    units: ["m","m","m"],
  });
  console.log("Before return");
  return {
    modelSpace,
    url,
    attributes,
    scales: downsamplingFactors.map((f) => {
      return {url: `${url}/mag${f[0]}`, downsamplingFactor: f};
    }),
    dimensions,
    chunk_sizes,
    compression,
    dataType,
  };
}

export class KnossosDataSource extends DataSourceProvider {
  get description() {
    return 'Knossos data source';
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    let {providerUrl} = options;
    if (providerUrl.endsWith('/')) {
      // remove last '/'
      providerUrl = providerUrl.substring(0, providerUrl.length - 1);
    }
    return options.chunkManager.memoize.getUncounted(
        {'type': 'knossos:MultiscaleVolumeChunkSource', providerUrl}, async () => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          const attributes =
              await getAttributes(options.chunkManager, credentialsProvider, url, false);
          // console.log(attributes);
          const multiscaleMetadata = getMultiscaleMetadata(url, attributes);
          console.log(multiscaleMetadata);
          const scales =
              await getAllScales(options.chunkManager, credentialsProvider, multiscaleMetadata);
          // console.log(scales);
          const volume = new MultiscaleVolumeChunkSource(
              options.chunkManager, credentialsProvider, multiscaleMetadata, scales);
          
          console.log(volume);
          return {
            modelTransform: makeIdentityTransform(volume.modelSpace),
            subsources: [
              {
                id: 'default',
                default: true,
                url: undefined,
                subsource: {volume},
              },
              {
                id: 'bounds',
                default: true,
                url: undefined,
                subsource: {
                  staticAnnotations:
                      makeDataBoundsBoundingBoxAnnotationSet(volume.modelSpace.bounds)
                },
              },
            ],
          };
        })
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
  }
