import tornado.web
import tornado.ioloop
import tornado.iostream
import tornado.concurrent
import os
import json
import numpy as np
import compressed_segmentation as cseg
import gzip
import concurrent.futures
import zipfile
import urllib

try:
    # Newer versions of tornado do not have the asynchronous decorator
    from sockjs.tornado.util import asynchronous
except ImportError:
    from tornado.web import asynchronous

from concurrent.futures import ThreadPoolExecutor
from syconn.analysis.property_filter import PropertyFilter
from syconn.analysis.utils import get_encoded_mesh, get_encoded_skeleton, get_mesh_meta
from syconn.handler.logger import log_main as logger

import neuroglancer
from neuroglancer import local_volume, skeleton, trackable_state
from neuroglancer import url_state
from neuroglancer import config
from neuroglancer.random_token import make_random_token
from neuroglancer.chunks import encode_raw
from neuroglancer.json_utils import json_encoder_default

SHARED_URL_REGEX = r'^/share/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/.+'

INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'

SKELETON_INFO_PATH_REGEX = r'^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$'

MESH_INFO_PATH_REGEX = r'^/neuroglancer/meshinfo/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

ACTION_PATH_REGEX = r'^/action/(?P<viewer_token>[^/]+)$'

PRECOMPUTED_SKELETON_INFO_REGEX = r'^/skeletons/info$'

PRECOMPUTED_SKELETON_REGEX = r'^/skeletons/(?P<ssv_id>[0-9]+)$'

PRECOMPUTED_MESH_INFO_REGEX = r'^/(?P<obj_type>[a-z]{2})/info$'

PRECOMPUTED_MESH_META_REGEX = r'^/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9])$'

PRECOMPUTED_MESH_REGEX = r'^/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9]):\2_mesh$'

PRECOMPUTED_VOLUME_INFO_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/info$'

PRECOMPUTED_VOLUME_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

PRECOMPUTED_SEG_PROPS_INFO_REGEX = r'^/properties/info$'

KNOSSOS_METADATA_REGEX = r'^/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/knossos.conf'  # TODO Andrei source for static seg metadata

KNOSSOS_METADATA_SCALES_REGEX = r'^/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<scale_key>[^/]+)/knossos.conf'  # TODO Andrei source for static seg metadata

KNOSSOS_VOLUME_REGEX = r'^/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)'

class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        # self.set_secure_cookie("session_id", session_key, samesite="None")
        self.server = server


class MainHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("index.html")


class NotFoundHandler(tornado.web.RequestHandler):
    def get(self):  # for all methods
        logger.info('In Not Found Handler')
        logger.info(self.request.uri)
        self.render("notFound.html")


class TutorialsHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("tutorials.html")


class AboutHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("about.html")


# native coroutine
class TokenHandler(BaseRequestHandler):
    def post(self):
        logger.info("TokenHandler invoked")
        from neuroglancer.config import params

        try:
            params.acquisition = self.get_argument("acq_name")
            params.version = self.get_argument("data_version")
            print(params.acquisition)
            print(params.version)

        except tornado.web.MissingArgumentError as e:
            logger.error(e.args[0])
            self.send_error(404)
            return

        token = make_random_token()
        pf = PropertyFilter(params, token, ['mi', 'vc', 'sj'])
        logger.debug(f"Viewer instances in memory: {len(config.global_server.viewers.keys())}")

        try:
            self.redirect(pf.viewer.get_viewer_url())
        except Exception as e:
            self.send_error(404, message=e.args[0])
            return

class SharedURLHandler(BaseRequestHandler):
    def get(self, acquisition, version):
        logger.info('In Shared URL Handler')
        uri = urllib.parse.unquote(self.request.uri)
        no_a_umlaut_url = uri.replace("ä", "!")
        decoded_url = no_a_umlaut_url.replace("ß", "#")
        state = url_state.parse_url(decoded_url)

        from neuroglancer.config import params
        params.acquisition = acquisition
        params.version = version

        # create new viewer with
        token = make_random_token()
        pf = PropertyFilter(params, token, ['mi', 'vc', 'sj'])
        pf.viewer.set_state(state)

        # render the new viewer
        try:
            self.redirect(pf.viewer.get_viewer_url())
        except Exception as e:
            self.send_error(404, message=e.args[0])
            return


class PrecomputedSkeletonInfoHandler(BaseRequestHandler):
    def get(self):
        try:
            info = {
                "@type": "neuroglancer_skeletons",
                "transform": [  # identity (no) transformation
                    1,
                    0,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    0,
                    0,
                    1,
                    0
                ],
                "vertex_attributes": [],
                "spatial_index": None
            }

            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(info))

        except Exception as e:
            logger.error('Error retrieving skeletons info. {}'.format(e.args[0]))
            self.send_error(404)
            return


class PrecomputedSkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, ssv_id):
        from neuroglancer.config import params
        def handle_result(f):
            try:
                encoded_skeleton = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            # self.server.thread_executor.shutdown()

            if encoded_skeleton == -1:
                logger.error('Skeleton not available for ssv_id: {}'.format(ssv_id))
                self.send_error(404)
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_skeleton, compresslevel=6))

        future = self.server.thread_executor.submit(
            get_encoded_skeleton, params["backend"], ssv_id, params["segmentation"].scale
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


class PrecomputedMeshInfoHandler(BaseRequestHandler):
    def get(self, obj_type):
        try:
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps({"@type": "neuroglancer_legacy_mesh"}))

        except Exception as e:
            logger.error('Error retrieving {} mesh info. {}'.format(obj_type, e.args[0]))
            self.send_error(404)
            return


class PrecomputedMeshMetaHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
        def handle_result(f):
            try:
                meta = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/json')
            # self.set_header('Content-encoding', 'gzip')
            self.finish(meta)

        future = self.server.thread_executor.submit(
            get_mesh_meta, ssv_id, lod
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


class PrecomputedMeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
        from neuroglancer.config import params
        def handle_result(f):
            try:
                encoded_mesh = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            if encoded_mesh == -1:
                logger.error('{} mesh not available for ssv_id: {}'.format(obj_type, ssv_id))
                self.send_error(404)
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_mesh, compresslevel=6))

        future = self.server.thread_executor.submit(
            get_encoded_mesh, params["backend"], ssv_id, obj_type
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


class PrecomputedVolumeInfoHandler(BaseRequestHandler):
    def get(self, volume_type):
        from neuroglancer.config import params
        try:
            info = config.volume_info
            info["type"] = volume_type

            if volume_type == "segmentation":
                info["data_type"] = "uint64"
                for level in range(len(params["segmentation"].available_mags)):
                    info["scales"][level]["encoding"] = "compressed_segmentation"
                    info["scales"][level]["compressed_segmentation_block_size"] = [8, 8, 8]

            elif volume_type == "image":
                info["data_type"] = "uint8"
                for level in range(len(params["image"].available_mags)):
                    info["scales"][level]["encoding"] = "raw"

            self.set_header('Content-type', 'application/json')
            self.set_header('Content-encoding', 'gzip')
            info = bytes(json.dumps(info), 'utf-8')
            self.finish(gzip.compress(info, compresslevel=6))

        except Exception as e:
            logger.error('Error retrieving {} info. {}'.format(volume_type, e.args[0]))
            self.send_error(404)
            return


class PrecomputedVolumeHandler(BaseRequestHandler):
    @asynchronous
    def get(self, volume_type, scale_key, chunk):
        from neuroglancer.config import params
        mag = np.array(scale_key.split('_'), dtype=np.int32)[0]
        x, y, z = chunk.split('_')
        xBegin, xEnd = map(int, x.split('-'))
        yBegin, yEnd = map(int, y.split('-'))
        zBegin, zEnd = map(int, z.split('-'))

        begin_offset = tuple(np.s_[xBegin * mag, yBegin * mag, zBegin * mag])
        end_offset = tuple(np.s_[xEnd * mag, yEnd * mag, zEnd * mag])

        size = tuple(np.subtract(end_offset, begin_offset))
        # print(begin_offset, size, scale_key)

        kwargs = dict(offset=begin_offset, size=size, mag=mag)

        def handle_result(f):
            try:
                data = f.result()

            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')

            if volume_type == "segmentation":
                compressed_data = cseg.compress(data, block_size=(8, 8, 8), order='F')
                # self.finish(compressed_data)
                self.finish(gzip.compress(compressed_data, compresslevel=6))
            else:
                self.finish(gzip.compress(encode_raw(data), compresslevel=6))

        if volume_type == "segmentation":
            # kwargs.update({'cube_type': 'segmentation', 'path': params['segmentation_path']})
            future = self.server.thread_executor.submit(
                params["segmentation"].load_seg, **kwargs
            )

        elif volume_type == "image":
            future = self.server.thread_executor.submit(
                params["image"].load_raw, **kwargs
            )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


from_overlay = True
# _ordinal_mags = True
scales = [np.array([10., 10., 25.], dtype=np.float32), np.array([20., 20., 50.], dtype=np.float32),
          np.array([40., 40., 100.], dtype=np.float32),
          np.array([80., 80., 200.], dtype=np.float32),
          np.array([160., 160., 400.], dtype=np.float32),
          np.array([320., 320., 800.], dtype=np.float32),
          np.array([640., 640., 1600.], dtype=np.float32),
          np.array([1280., 1280., 3200.], dtype=np.float32)]
cube_shape = [128, 128, 128]


def is_mag_ordinal(mag):
    if mag == 1 or mag == 2:
        return True
    else:
        return False


def scale_ratio(mag, base_mag):  # ratio between scale in mag and scale in base_mag
    return (mag_scale(mag) / mag_scale(base_mag)) if is_mag_ordinal(mag) else np.array(
        3 * [float(mag) / base_mag])


def mag_scale(mag):  # get scale in specific mag
    index = mag - 1 if is_mag_ordinal(mag) else int(np.log2(mag))
    # print(index)
    return scales[index]


def get_first_blocks(offset):
    return offset // cube_shape


def get_last_blocks(offset, size):
    return ((offset + size - 1) // cube_shape) + 1


def read_file(filename):
    with open(os.path.join("/home/hashir", filename), "rb") as f:
        data = f.read()

    return data


def get_intervals(offset, size, cube_coord):
    cube_shape = np.array([256,256,256])
    global_end = offset + size
    out_start = np.maximum(0, cube_coord * cube_shape - offset)
    out_end = (cube_coord + 1) * cube_shape - global_end
    out_end = size * (out_end >= 0) + out_end * (out_end < 0) # cube contains this output edge
    incube_start = np.maximum(0, offset - cube_coord * cube_shape)
    incube_end = global_end - (cube_coord + 1) * cube_shape
    incube_end = cube_shape * (incube_end >= 0) + incube_end * (incube_end < 0) # output contains this cube edge
    return out_start, out_end, incube_start, incube_end

class PrecomputedSegPropsInfoHandler(BaseRequestHandler):
    @asynchronous
    def get(self):
        from neuroglancer.config import params
        def handle_result(f):
            try:
                data = f.result()

            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/json')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(data, compresslevel=6))

        filename = params.acquisition + "_" + params.version + ".json"
        future = self.server.thread_executor.submit(read_file, filename)

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


class ActionHandler(BaseRequestHandler):
    def post(self, viewer_token):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        action = json.loads(self.request.body)
        self.server.ioloop.add_callback(viewer.actions.invoke, action['action'], action['state'])
        self.finish('')


class VolumeInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class SkeletonInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class KnossosMetadataHandler(BaseRequestHandler):
    def get(self, acquisition, version):
        file_path_pyk_conf = '/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/j0251_72_seg_20210127_agglo2.pyk.conf'
        # file_path_conf = '/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/'

        # TODO quality check acquisition and version

        # TODO make this static in config.py

        attr_dic = {}
        with open(file_path_pyk_conf, 'r') as f:
            for line in f:
                words = line.split()
                if words[0] == '[Dataset]' or words[0] == '_BaseName':
                    continue
                elif words[0] == '_DataScale':
                    dataScales = []
                    for i in range(7):
                        dataScales.append([float(x) for x in words[2+i].split(",")[:3]])
                    attr_dic[words[0][1:]] = dataScales[0]
                    # attr_dic[words[0][1:]] = [float(x[0].split(",")) for x in words[2].split(",")]
                elif words[0] == '_Extent':
                    attr_dic[words[0][1:]] = [int(x) for x in words[2].split(",")]
                elif words[0] == '_CubeSize':
                    attr_dic[words[0][1:]] = [int(x) for x in words[2].split(",")]
                elif words[0] == '_Axes':
                    attr_dic[words[0][1:]] = [x for x in words[2].split(",")]
                elif words[0] == '_Units':
                    attr_dic[words[0][1:]] = [x for x in words[2].split(",")]
                elif words[0] == '_DownsamplingFactors':
                    downsamplingArray = []
                    for i in range(7):
                        downsamplingArray.append([float(x) for x in words[2+i].split(",")[:3]])
                    attr_dic[words[0][1:]] = downsamplingArray
                    print(f'{downsamplingArray}')
                else:
                    attr_dic[words[0][1:]] = words[2]
        attr_dic['Compression'] = {"type": "KNOSSOS"}
        # attr_dic['downsamplingFactors'] = [[1,1,1],[2,2,2],[4,4,4],[8,8,8],[16,16,16],[32,32,32],[64,64,64]]


        self.set_header('Content-type', 'application/json')
        self.set_header('Cache-control', 'no-cache')  # TODO remove this afterwards
        self.set_header('Content-encoding', 'knossos')

        self.finish(json.dumps(attr_dic, default=json_encoder_default).encode())

        # except Exception as e:
        #     logger.error(f'Error retrieving metadata. {e}')
        #     self.send_error(404)
        #     return

class KnossosMetadataScalesHandler(BaseRequestHandler):
    def get(self, acquisition, version, scale_key):
        file_path_pyk_conf = '/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/j0251_72_seg_20210127_agglo2.pyk.conf'
        # file_path_conf = '/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/'

        # TODO quality check acquisition and version

        # TODO make this static in config.py

        attr_dic = {}
        with open(file_path_pyk_conf, 'r') as f:
            for line in f:
                words = line.split()
                if words[0] == '[Dataset]' or words[0] == '_BaseName':
                    continue
                elif words[0] == '_DataScale':
                    dataScales = []
                    for i in range(7):
                        dataScales.append([float(x) for x in words[2+i].split(",")[:3]])
                    attr_dic[words[0][1:]] = dataScales[0]
                    # attr_dic[words[0][1:]] = [float(x[0].split(",")) for x in words[2].split(",")]
                elif words[0] == '_Extent':
                    attr_dic[words[0][1:]] = [int(x) for x in words[2].split(",")]
                elif words[0] == '_CubeSize':
                    attr_dic[words[0][1:]] = [int(x) for x in words[2].split(",")]
                elif words[0] == '_Axes':
                    attr_dic[words[0][1:]] = [x for x in words[2].split(",")]
                elif words[0] == '_Units':
                    attr_dic[words[0][1:]] = [x for x in words[2].split(",")]
                elif words[0] == '_DownsamplingFactors':
                    downsamplingArray = []
                    for i in range(7):
                        downsamplingArray.append([float(x) for x in words[2+i].split(",")[:3]])
                    attr_dic[words[0][1:]] = downsamplingArray
                    print(f'{downsamplingArray}')
                else:
                    attr_dic[words[0][1:]] = words[2]
        attr_dic['Compression'] = {"type": "KNOSSOS"}
        # attr_dic['downsamplingFactors'] = [[1,1,1],[2,2,2],[4,4,4],[8,8,8],[16,16,16],[32,32,32],[64,64,64]]


        self.set_header('Content-type', 'application/json')
        self.set_header('Cache-control', 'no-cache')  # TODO remove this afterwards
        self.set_header('Content-encoding', 'knossos')

        self.finish(json.dumps(attr_dic, default=json_encoder_default).encode())

class PrecompSnappyVolHandler(BaseRequestHandler):
    @asynchronous
    def get(self, acquisition, version, scale_key, chunk):
        from neuroglancer.config import params
        boundary = [27119, 27350, 15494]

        mag = np.array(scale_key.split('_'), dtype=np.int32)[0]
        x, y, z = chunk.split('_')
        xBegin, xEnd = map(int, x.split('-'))
        yBegin, yEnd = map(int, y.split('-'))
        zBegin, zEnd = map(int, z.split('-'))

        begin_offset = tuple(np.s_[xBegin * mag, yBegin * mag, zBegin * mag])
        end_offset = tuple(np.s_[xEnd * mag, yEnd * mag, zEnd * mag])

        size = tuple(np.subtract(end_offset, begin_offset))
        ratio = scale_ratio(mag, 1)

        size = (np.array(size, dtype=int) // ratio).astype('<i8')
        offset = (np.array(begin_offset, dtype=int) // ratio).astype('<i8')
        print(size.dtype, offset.dtype)
        boundary = (np.array(boundary, dtype=int) // ratio).astype(int)

        start = get_first_blocks(offset).astype(int)
        end = get_last_blocks(offset, size).astype(int)

        output = np.zeros(size[::-1].reshape(-1), dtype=object)

        cube_coordinates = []

        for z in range(start[2], end[2]):
            for y in range(start[1], end[1]):
                for x in range(start[0], end[0]):
                    cube_coordinates.append([x, y, z])

        length_of_cubes = []

        def read_snappy_cube(c):
            out_start, out_end, incube_start, incube_end = get_intervals(offset, size, c)
            # local_offset = np.subtract([c[0], c[1], c[2]], start) * cube_shape
            # print(c)
            filename = f'{params["segmentation"].experiment_name}_{params["segmentation"].name_mag_folder}{mag}_x{c[0]:04d}_y{c[1]:04d}_z{c[2]:04d}.{"seg.sz.zip" if from_overlay else params["segmentation"]._raw_ext}'
            path = f'{params["segmentation"].knossos_path}/{params["segmentation"].name_mag_folder}{mag}/x{c[0]:04d}/y{c[1]:04d}/z{c[2]:04d}/{filename}'

            snappy_zipped_cube = None

            if os.path.exists(path):
                with open(path, 'rb') as zf:
                    snappy_cube = zf.read()

                return snappy_cube

        futures = {self.server.thread_executor.submit(read_snappy_cube, cube_coord) for cube_coord in cube_coordinates}

        self.write(offset.tobytes())
        self.write(size.tobytes())
        self.write(len(cube_coordinates).to_bytes(1, byteorder="little"))
        
        for f in concurrent.futures.as_completed(futures):
            try:
                snappy_cube = f.result()

                if snappy_cube is not None:
                    length_of_cubes.append(len(snappy_cube))  # get length of byte string of each cube
                    self.set_header('Content-encoding', 'application/octet-stream')
                    self.write(len(snappy_cube).to_bytes(8, byteorder='little'))
                    print(len(snappy_cube))
                    self.write(snappy_cube)  # send cube
                else:
                    logger.error('Snappy cube is None')
                    self.send_error(404)

            except Exception as e:
                logger.error(e, e.args[0])
                self.send_error(404)
                return

        logger.info(f"Total length of cubes: {sum(length_of_cubes)}")
        # logger.info(f"Attaching cubes meta information to the request [#cubes: {len(length_of_cubes)}, cube_lengths: {length_of_cubes}]")

        # for l in length_of_cubes:
        #     self.write(l.to_bytes(8, "little"))  # send length of each cube

        # self.write(len(length_of_cubes).to_bytes(4, "little"))  # send number of cubes to be read

        self.finish()  # finish request
