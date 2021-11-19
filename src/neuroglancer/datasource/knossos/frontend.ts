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
import {isNotFoundError, parseUrl, responseJson} from 'neuroglancer/util/http_request';
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
}
;

class ScaleMetadata {
  dataType: DataType;
  encoding: VolumeChunkEncoding;
  size: Float32Array;
  chunkSize: Uint32Array;

  constructor(obj: any, downsamplingArray: Float32Array) {
    verifyObject(obj);
    this.dataType = verifyObjectProperty(obj, 'DataType', x => verifyEnumString(x, DataType));
    this.size = Float32Array.from(
      verifyObjectProperty(obj, 'Extent', x => parseArray(x, verifyPositiveInt))).map(x => x/downsamplingArray[0]);         // TODO support  anisotropic downsampling too
    // console.log(this.size)
    this.chunkSize = verifyObjectProperty(
        obj, 'CubeSize',
        x => parseFixedLengthArray(new Uint32Array(this.size.length), x, verifyPositiveInt));

    let encoding: VolumeChunkEncoding|undefined;
    verifyOptionalObjectProperty(obj, 'Compression', compression => {
      encoding =
          verifyObjectProperty(compression, 'type', x => verifyEnumString(x, VolumeChunkEncoding));
    });
    if (encoding === undefined) {
      encoding = verifyObjectProperty(
          obj, 'compressionType', x => verifyEnumString(x, VolumeChunkEncoding));
    }
    this.encoding = encoding;
  }
}

function getAllScales(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    multiscaleMetadata: MultiscaleMetadata): Promise<(ScaleMetadata | undefined)[]> {
  return Promise.all(multiscaleMetadata.scales.map(async scale => {

    const attributes = await getAttributes(chunkManager, credentialsProvider, scale.url, true);
    if (attributes === undefined) return undefined;
    return new ScaleMetadata(attributes, scale.downsamplingFactor);
  }));
}

function getAttributesJsonUrls(url: string): string[] {
  let {protocol, host, path} = parseUrl(url);
  if (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  const urls: string[] = [];
  urls.push(`${protocol}://${host}${path}/knossos.conf`);
  return urls;
}

function getIndividualAttributesJson(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, required: boolean): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {type: 'knossos:attributes.json', url, credentialsProvider: getObjectId(credentialsProvider)},
      () => cancellableFetchSpecialOk(credentialsProvider, url, {}, responseJson)
                .then(j => {
                  try {
                    return verifyObject(j);
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
      (u, i) => getIndividualAttributesJson(
          chunkManager, credentialsProvider, u, required && i === attributesJsonUrls.length - 1)));
  if (metadata.indexOf(undefined) !== -1) return undefined;
  metadata.reverse();
  return Object.assign({}, ...metadata);
}

function verifyRank(existing: number, n: number) {
  if (existing !== -1 && n !== existing) {
    throw new Error(`Rank mismatch, received ${n} but expected ${existing}`);
  }
  return n;
}

function parseSingleResolutionDownsamplingFactors(obj: any) {
  return Float64Array.from(parseArray(obj, verifyFinitePositiveFloat));
}

function parseMultiResolutionDownsamplingFactors(obj: any) {
  const a = expectArray(obj);
  if (a.length === 0) throw new Error('Expected non-empty array');
  let rank = -1;
  const allFactors = parseArray(a, x => {
    const f = parseSingleResolutionDownsamplingFactors(x);
    rank = verifyRank(rank, f.length);
    return f;
  });
  return {all: allFactors, single: undefined, rank};
}

function parseDownsamplingFactors(obj: any) {
  // console.log("in parse downsample factors")
  // console.log(obj)
  const a = expectArray(obj);
  // console.log(a);
  if (a.length === 0) throw new Error('Expected non-empty array');
  if (Array.isArray(a[0])) {
    return parseMultiResolutionDownsamplingFactors(a);
  }
  const f = parseSingleResolutionDownsamplingFactors(obj);
  return {all: undefined, single: f, rank: f.length};
}

const defaultAxes = ['x', 'y', 'z', 't', 'c'];

function getDefaultAxes(rank: number) {
  const axes = defaultAxes.slice(0, rank);
  while (axes.length < rank) {
    axes.push(`d${axes.length + 1}`);
  }
  return axes;
}

function getMultiscaleMetadata(url: string, attributes: any): MultiscaleMetadata {
  verifyObject(attributes);
  let rank = -1;

  // get json properties
  let scales = verifyOptionalObjectProperty(attributes, 'DataScale', x => {
    const scales = Float64Array.from(parseArray(x, verifyFinitePositiveFloat));
    rank = verifyRank(rank, scales.length);
    return scales;
  });
  console.log(scales)
  let axes = verifyOptionalObjectProperty(attributes, 'Axes', x => {
    const names = parseArray(x, verifyString);
    rank = verifyRank(rank, names.length);
    return names;
  });
  let units = verifyOptionalObjectProperty(attributes, 'Units', x => {
    const units = parseArray(x, unitFromJson);
    rank = verifyRank(rank, units.length);
    return units;
  });

  // let scales = verifyOptionalObjectProperty(attributes, 'resolution', x => {
  //   const scales = Float64Array.from(parseArray(x, verifyFinitePositiveFloat));
  //   rank = verifyRank(rank, scales.length);
  //   return scales;
  // });
  // let axes = verifyOptionalObjectProperty(attributes, 'axes', x => {
  //   const names = parseArray(x, verifyString);
  //   rank = verifyRank(rank, names.length);
  //   return names;
  // });
  // let units = verifyOptionalObjectProperty(attributes, 'Units', x => {
  //   const units = parseArray(x, unitFromJson);
  //   rank = verifyRank(rank, units.length);
  //   return units;
  // });

  let defaultUnit = {unit: 'm', exponent: -9};
  let singleDownsamplingFactors: Float64Array|undefined;
  let allDownsamplingFactors: Float64Array[]|undefined;
  verifyOptionalObjectProperty(attributes, 'DownsamplingFactors', dObj => {
    // console.log(dObj);
    const {single, all, rank: curRank} = parseDownsamplingFactors(dObj);
    rank = verifyRank(rank, curRank);
    if (single !== undefined) {
      singleDownsamplingFactors = single;
    }
    if (all !== undefined) {
      allDownsamplingFactors = all;
    }
  });
  const dimensions = verifyOptionalObjectProperty(attributes, 'Extent', x => {
    const dimensions = parseArray(x, verifyPositiveInt);
    rank = verifyRank(rank, dimensions.length);
    return dimensions;
  });

  if (rank === -1) {
    throw new Error('Unable to determine rank of dataset');
  }
  if (units === undefined) {
    units = new Array(rank);
    units.fill(defaultUnit);
  }
  if (scales === undefined) {
    scales = new Float64Array(rank);
    scales.fill(1);
  }
  for (let i = 0; i < rank; ++i) {
    scales[i] = scaleByExp10(scales[i], units[i].exponent);
  }

  if (axes === undefined) {
    axes = getDefaultAxes(rank);
  }
  const modelSpace = makeCoordinateSpace({
    rank,
    valid: true,
    names: axes,
    scales,
    units: units.map(x => x.unit),
  });
  // TODO FIX THIS
  // if (dimensions === undefined) {
  if (allDownsamplingFactors === undefined) {
    throw new Error('Not valid single-resolution or multi-resolution dataset');
  }
  return {
    modelSpace,
    url,
    attributes,
    scales: allDownsamplingFactors.map((f) => {
      return {url: `${url}/mag${f[0]}`, downsamplingFactor: f};
    }),
  };
  if (singleDownsamplingFactors === undefined) {
    singleDownsamplingFactors = new Float64Array(rank);
    singleDownsamplingFactors.fill(1);
  }
  return {
    modelSpace,
    url,
    attributes,
    scales: [{url, downsamplingFactor: singleDownsamplingFactors}]
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
          // console.log('attributes');
          // console.log(attributes);
          const multiscaleMetadata = getMultiscaleMetadata(url, attributes);
          // console.log(`multiscaleMetadata ${multiscaleMetadata}`);
          // console.log(multiscaleMetadata);
          const scales =
              await getAllScales(options.chunkManager, credentialsProvider, multiscaleMetadata);
          const volume = new MultiscaleVolumeChunkSource(
              options.chunkManager, credentialsProvider, multiscaleMetadata, scales);
          // console.log('scales');
          // console.log(scales);
          // console.log(`volume`);
          // console.log(volume);
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