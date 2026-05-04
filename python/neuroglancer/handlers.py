from distutils.log import error
import tornado.web
import tornado.ioloop
import tornado.iostream
import tornado.concurrent
import os
import json
import numpy as np
import compressed_segmentation as cseg
import gzip
import urllib
import re
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import pandas as pd

try:
    # Newer versions of tornado do not have the asynchronous decorator
    from sockjs.tornado.util import asynchronous
except ImportError:
    from tornado.web import asynchronous


from syconn.analysis.property_filter import PropertyFilter
from syconn.analysis.utils import get_encoded_mesh, get_encoded_skeleton, get_mesh_meta
from syconn.handler.logger import log_main as logger

import neuroglancer
from neuroglancer import local_volume, skeleton, trackable_state
from neuroglancer import url_state
from neuroglancer import config
from neuroglancer.random_token import make_random_token
from neuroglancer.chunks import encode_raw
from neuroglancer.json_utils import encode_json, json_encoder_default


SHARED_URL_REGEX = r'^/share/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/.+'

INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'

SKELETON_INFO_PATH_REGEX = r'^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$'

MESH_INFO_PATH_REGEX = r'^/neuroglancer/meshinfo/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

ACTION_PATH_REGEX = r'^/action/(?P<viewer_token>[^/]+)$'

PRECOMPUTED_SKELETON_INFO_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/skeletons/info$'

PRECOMPUTED_SKELETON_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/skeletons/(?P<ssv_id>[0-9]+)$'

PRECOMPUTED_MESH_INFO_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]+)/info$'

PRECOMPUTED_MESH_META_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]+)/(?P<ssv_id>[0-9]+):(?P<lod>[0-9])$'

PRECOMPUTED_MESH_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]+)/(?P<ssv_id>[0-9]+):(?P<lod>[0-9]):\5_mesh$'

PRECOMPUTED_VOLUME_INFO_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/info$'

PRECOMPUTED_VOLUME_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

PRECOMPUTED_SEG_PROPS_INFO_REGEX = r'^/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/properties/info$'

# ZEBRAFISH_SYN_COORD_REGEX = r'^/(?P<sv_ids>[0-9]+)$'
ZEBRAFISH_SYN_COORD_REGEX_HTML = r'^/zf/html'

ZEBRAFISH_SYN_COORD_REGEX_JSON = r'^/zf/json'
J0251_SYNAPSES_REGEX_JSON = r"^/j0251/synapses/json"
J0251_NEURONS_REGEX_JSON = r"^/j0251/neurons/json"
J0251_SKELETON_REGEX = r"^/j0251/skeleton"
J0251_MESH_REGEX = r"^/j0251/mesh"

EVENTS_PATH_REGEX = r'^/events/(?P<viewer_token>[^/]+)$'

SET_STATE_PATH_REGEX = r'^/state/(?P<viewer_token>[^/]+)$'

CREDENTIALS_PATH_REGEX = r'^/credentials/(?P<viewer_token>[^/]+)$'



class BaseRequestHandler(tornado.web.RequestHandler):
    # def set_default_headers(self):
    #     self.set_header("Access-Control-Allow-Origin", "*")
    #     self.set_header("Access-Control-Allow-Headers", "x-requested-with")
    #     self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    #     self.set_header('Access-Control-Allow-Credentials', 'true')
    #     self.set_header("DNT", "Authorization, Content-Type, Depth, User-Agent, X-File-Size, X-Requested-With, If-Modified-Since, Keep-Alive, Cache-Control")

    def initialize(self, server):
        # self.set_secure_cookie("session_id", session_key, samesite="None")
        self.server = server


class MainHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("index.html")


class NotFoundHandler(tornado.web.RequestHandler):
    def get(self):  # for all methods
        if self.request.uri.split('/')[1] == 'socket':
            self.render("notFound.html")
        else:
            logger.info('In Not Found Handler')
            logger.debug(f"URI not found: {self.request.uri}")
            self.render("notFound.html")


class TutorialsHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("tutorials.html")


class AboutHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("about.html")

class DataHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("data.html")

class ZebraFishButtonHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("zebrafish_button.html")

class TokenHandler(BaseRequestHandler):

    # def set_default_headers(self):
    #     self.set_header("Access-Control-Allow-Origin", "*")
    #     self.set_header("Access-Control-Allow-Headers", "x-requested-with")
    #     self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    #     self.set_header('Access-Control-Allow-Credentials', 'true')
    #     self.set_header("DNT", "Authorization, Content-Type, Depth, User-Agent, X-File-Size, X-Requested-With, If-Modified-Since, Keep-Alive, Cache-Control")
        
    def post(self):
        logger.info("TokenHandler invoked")
        from neuroglancer.config import params

        try:
            params.acquisition = self.get_argument("acq_name")
            params.version = self.get_argument("data_version")
            print(params.acquisition, params.version)

        except tornado.web.MissingArgumentError as e:
            logger.error(e.args[0])
            self.send_error(404)
            return

        prefix = 'precomputed://'
        use_tpl_mask = False
        seg_src = None
        img_src = None
        if config.dev_environ:
            # Development mode without nginx
            host = config.global_server_args['host']
            port = config.global_server_args['port']
            source = f'http://{host}:{port}'
            prefix += source + '/in_memory_volume'
            if params.acquisition == 'zf':
                seg_src = 'precomputed://http://knossosstreaming-mf.esc.rzg.mpg.de/fw363_seg_140180724fb_rsg_or_sc06_cbsplit_neuroglancer/mesh'
                img_src = 'precomputed://http://knossosstreaming-mf.esc.rzg.mpg.de/fw363_raw_neuroglancer'
            else:
                seg_src = prefix + '/segmentation'
                img_src = prefix + '/image' 
        else:
            if config.dev_environ_nginx:
                # Development mode with nginx
                # Note: This is not the same as the dev_environ
                # The port here is the port of the nginx server
                # with the dev.syconn.esc.mpcdf.mpg.de domain
                source = f'http://localhost:9000'
            else:
                # Production mode
                # Nginx server reverse proxies to the neuroglancer 
                # server running at https://localhost:5000
                source = f'https://syconn.esc.mpcdf.mpg.de'
            
            prefix += source
            if params.acquisition == 'j0126':
                seg_src = prefix + '/volume/segmentation'
                img_src = prefix + '/j0126/volume/image'
            elif params.acquisition == 'zf':
                seg_src = 'precomputed://http://knossosstreaming-mf.esc.rzg.mpg.de/fw363_seg_140180724fb_rsg_or_sc06_cbsplit_neuroglancer/mesh'
                img_src = 'precomputed://http://knossosstreaming-mf.esc.rzg.mpg.de/fw363_raw_neuroglancer'
            else:
                use_tpl_mask = True
                seg_src = prefix + f'/{params.acquisition}_{params.version}' + '/segmentation'
                if params.version == 'rag_flat_Jan2019_v3':
                    img_src = prefix + f'/{params.acquisition}_{params.version}' + '/image/test'
                elif params.version in ('72_seg_20210127_agglo2', '72_seg_20210127_agglo2_syn_20220811_celltypes_20230822'):
                    img_src = prefix + f'/{params.acquisition}_{params.version}' + '/image'
            
        token = make_random_token()
        
        # use_tpl_mask = True
        # if params.version == "rag_flat_Jan2019_v3":
        #     logger.debug("Using j0251_rag_flat_Jan2019_v3")
        #     # sharded precomputed
        #     seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
        #     img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image/test'
            
        # elif params.version == "":
        #     logger.debug("Using j0251_72_seg_20210127_agglo2")
        #     # sharded precomputed
        #     seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
        #     img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image'

        # else: 
        #     logger.debug("Using j0126")
        #     seg_src = 'precomputed://' + source + '/volume/segmentation'  # unsharded precomputed segmentation
        #     img_src = 'precomputed://' + source + '/j0126/volume/image'  # sharded precomputed image
        #     use_tpl_mask = False
        organelles = ['mi', 'vc', 'sj']
        if params.version == "72_seg_20210127_agglo2_syn_20220811_celltypes_20230822":
            organelles.append('golgi')
            organelles.append('er')

        pf = PropertyFilter(params, token, organelles, use_tpl_mask=use_tpl_mask, seg_src=seg_src, img_src=img_src)
        # logger.debug(f"Viewer instances in memory: {len(config.global_server.viewers.keys())}")

        try:
            self.redirect(pf.viewer.get_viewer_url())
        except Exception as e:
            self.send_error(404, message=e.args[0])
            return

class SetStateHandler(BaseRequestHandler):
    def post(self, viewer_token: str):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        msg = json.loads(self.request.body)
        generation = msg['g']
        state = msg['s']
        client_id = msg['c']
        viewer.set_state(state, f'{client_id}/{generation}')

class CredentialsHandler(BaseRequestHandler):
    async def post(self, viewer_token: str):
        print('in credentials')
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        if not viewer.allow_credentials:
            self.send_error(403)
            return
        if self.server._credentials_manager is None:
            from .default_credentials_manager import default_credentials_manager
            self.server._credentials_manager = default_credentials_manager
        msg = json.loads(self.request.body)
        invalid = msg.get('invalid')
        provider = self.server._credentials_manager.get(msg['key'], msg.get('parameters'))
        if provider is None:
            self.send_error(400)
            return
        try:
            credentials = await asyncio.wrap_future(provider.get(invalid))
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(credentials))
        except:
            import traceback
            traceback.print_exc()
            self.send_error(401)

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

        if config.dev_environ:
            host = config.global_server_args['host']
            port = config.global_server_args['port']
            source = f'http://{host}:{port}' 

        elif config.dev_environ_nginx:
            source = f'http://localhost:9005'
            
        else:
            source = f'https://syconn.esc.mpcdf.mpg.de'

        token = make_random_token()

        use_tpl_mask = True
        if params.version == "rag_flat_Jan2019_v3":
            logger.debug("Shared URL: Using j0251_rag_flat_Jan2019_v3")
            seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image/test'

        elif params.version in ("72_seg_20210127_agglo2", "72_seg_20210127_agglo2_syn_20220811_celltypes_20230822"):
            logger.debug("Shared URL: Using j0251")
            seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image'

        else:  # for j0126
            logger.debug("Shared URL: Using j0126")
            seg_src = 'precomputed://' + source + '/volume/segmentation'
            img_src = 'precomputed://' + source + '/j0126/volume/image'
            use_tpl_mask = False  # total path length filtering is not required

        organelles = ['mi', 'vc', 'sj']
        if params.version == "72_seg_20210127_agglo2_syn_20220811_celltypes_20230822":
            organelles.append('golgi')
            organelles.append('er')

        pf = PropertyFilter(params, token, organelles, use_tpl_mask=use_tpl_mask, seg_src=seg_src, img_src=img_src)
        pf.viewer.set_state(state)

        # logger.debug(f"Viewer instances in memory: {len(config.global_server.viewers.keys())}")

        # render the new viewer
        try:
            self.redirect(pf.viewer.get_viewer_url())
        except Exception as e:
            self.send_error(404, message=e.args[0])
            return


class PrecomputedSkeletonInfoHandler(BaseRequestHandler):
    def get(self, viewer_token, acquisition, version):
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

            self.set_header('Access-Control-Allow-Origin', '*')
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(info))

        except Exception as e:
            logger.error('Error retrieving skeletons info. {}'.format(e.args[0]))
            self.send_error(404)
            return


class PrecomputedSkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, viewer_token, acquisition, version, ssv_id):
        ssv_id = int(ssv_id)
        from neuroglancer.config import params
        # from syconn.cli.property_filter import get_segmentation_layer

        if acquisition == "j0126":
            viewer = self.server.viewers.get(viewer_token)
            
            with viewer.txn() as s:
                # for l in s.layers:
                #     if isinstance(l.layer, neuroglancer.SegmentationLayer) and (l.name == acquisition + "_" + version):
                #         seg_layer = l
                #         break
                try:
                    # TODO(hashir): use equivalenes to
                    # treat all sv ids of an ssv together
                    if not (params["ssd"].ssv_ids == ssv_id).any():  # supervoxel id
                        logger.info("Cell ID not found in ssv_ids. Trying to load cell ID from sv2ssv mapping")
                        new_ssv_id = params["ssd"].sv2ssv_ids(ids=np.array([ssv_id]))[ssv_id]
                        # seg_layer.equivalences = [tuple(params["ssd"].mapping_dict[new_ssv_id])]
                    else:  # super-supervoxel id
                        new_ssv_id = ssv_id

                except Exception as e:
                    error_msg = f"Error setting equivalences for {ssv_id}"
                    logger.error(e.args[0], error_msg)
                    self.send_error(404, message=error_msg)
                    return

        else:
            new_ssv_id = ssv_id

        future = self.server.thread_executor.submit(
            get_encoded_skeleton, params["ssd"], new_ssv_id
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        def handle_result(f):
            try:
                encoded_skeleton = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            if len(encoded_skeleton) == 0:
                logger.error('Skeleton not available for ssv_id: {}'.format(ssv_id))
                self.send_error(404)
                return

            self.set_header('Access-Control-Allow-Origin', '*')
            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_skeleton, compresslevel=6))


class PrecomputedMeshInfoHandler(BaseRequestHandler):
    def get(self, viewer_token, acquisition, version, obj_type):
        try:
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps({"@type": "neuroglancer_legacy_mesh"}))

        except Exception as e:
            logger.error('Error retrieving {} mesh info. {}'.format(obj_type, e.args[0]))
            self.send_error(404)
            return


class PrecomputedMeshMetaHandler(BaseRequestHandler):
    @asynchronous
    def get(self, viewer_token, acquisition, version, obj_type, ssv_id, lod):

        future = self.server.thread_executor.submit(
            get_mesh_meta, ssv_id, lod
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        def handle_result(f):
            try:
                meta = f.result()

            except Exception as e:
                logger.error(f"Error sending {obj_type} mesh manifest file for {ssv_id}. {e}")
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/json')
            # self.set_header('Content-encoding', 'gzip')
            self.finish(meta)


class PrecomputedMeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, viewer_token, acquisition, version, obj_type, ssv_id, lod):
        ssv_id = int(ssv_id)
        from neuroglancer.config import params

        if acquisition == "j0126":
            viewer = self.server.viewers.get(viewer_token)

            with viewer.txn() as s:
                try:
                    if not(params["ssd"].ssv_ids == ssv_id).any():
                        logger.info("Cell ID not found in ssv_ids. Trying to load cell ID from sv2ssv mapping")
                        new_ssv_id = params["ssd"].sv2ssv_ids(ids=np.array([ssv_id]))[ssv_id]
                        # seg_layer.equivalences = [tuple(params["ssd"].mapping_dict[new_ssv_id])]
                    else:
                        new_ssv_id = ssv_id
                    
                except Exception as e:
                    error_msg = f"Error setting equivalences for {ssv_id}"
                    logger.error(e.args[0], error_msg)
                    self.send_error(404, message=error_msg)
                    return

        else:
            new_ssv_id = ssv_id

        future = self.server.thread_executor.submit(
            get_encoded_mesh, params["ssd"] if obj_type != "er" else params["sd_er"], new_ssv_id, obj_type
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        def handle_result(f):
            try:
                encoded_mesh = f.result()

            except Exception as e:
                logger.error(f"Error sending {obj_type} mesh for {ssv_id}. {e}")
                self.send_error(500, message=e.args[0])
                return

            if len(encoded_mesh) == 0:
                logger.error('{} mesh not available for ssv_id: {}'.format(obj_type, ssv_id))
                self.send_error(404)
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_mesh, compresslevel=6))


class PrecomputedVolumeInfoHandler(BaseRequestHandler):
    def get(self, volume_type):
        from neuroglancer.config import params
        try:
            # logger.debug(f"Retrieving info for {params["acquisition"]}_{version}")
            info = params["info"]
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

        kwargs = dict(offset=begin_offset, size=size, mag=mag)

        if volume_type == "segmentation":
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

        def handle_result(f):
            try:
                data = f.result()

            except Exception as e:
                logger.error(e, e.args[0])
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')

            if volume_type == "segmentation":
                compressed_data = cseg.compress(data, block_size=(8, 8, 8), order='F')
                self.finish(gzip.compress(compressed_data, compresslevel=6))
            else:
                self.finish(gzip.compress(encode_raw(data), compresslevel=6))


class PrecomputedSegPropsInfoHandler(BaseRequestHandler):
    @asynchronous
    def get(self, acquisition, version):
        from neuroglancer.config import params

        filename = params.acquisition + "_" + params.version + ".json"
        future = self.server.thread_executor.submit(read_file, params, filename)

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

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


class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        else:
            return super(NumpyEncoder, self).default(obj)


class ZebraFishSyn2CoordHandlerJSON(BaseRequestHandler):

    @asynchronous
    def get(self):
        
        logger.debug('Zebrafish synapse coordinates requested')
        # sv_ids is a comma separated list of supervoxel ids
        sv_ids = self.get_arguments('sv_ids')
        if len(sv_ids) == 0:
            m = "Query argument 'sv_ids' is not found"
            logger.error(m)
            self.send_error(400, message=m)
            return

        if sv_ids[0] == '':
            m = "No supervoxel ids provided"
            logger.error(m)
            self.send_error(400, message=m)
            return

        # sv_ids is a list of string, need to convert to list of ints
        try:
            sv_ids = sv_ids[0].replace(' ', '').split(',')
            sv_ids = list(map(int, sv_ids))
        except ValueError as e:
            logger.error(e)
            self.send_error(400, message=e)
            return


        from neuroglancer.config import zf_params

        def extract_syn_coords(svs):
            svs = set(svs)
            data = []

            for sv in svs:  # Iterate through the list of supervoxels
                # From the back to the front:
                # 1. Check whether the current sv is a cs sv of a synapse
                # 2. Iterate through the indices of the cs sv which will be the same as the indices of the stored synapse(s)
                # 3. For each index retrieve the representative coordinates of the synapse(s)
                
                # syn_coords[sv].extend([zf_params['rep_coord'][cs_index].tolist() for cs_index in
                #                        zf_params['cs_lookup'][sv] if zf_params['cs_lookup'][sv]])
                # if zf_params['cs_lookup'][sv]:
                #     partners[sv].extend(list(zf_params['partner_lookup'][sv]))

                if zf_params['cs_lookup'][sv]:
                    for cs_index in zf_params['cs_lookup'][sv]:
                        partners = set(list(sum(zf_params['cs_ids'][cs_index], ())))
                        partners.discard(sv)
                        data.append([sv, zf_params['rep_coord'][cs_index], partners])

            
            df = pd.DataFrame(data, columns=['Queried SV', 'SYN Coordinates', 'CS Partner(s)'])
            return df.to_json(orient='records')
            
        
        future = self.server.thread_executor.submit(
            extract_syn_coords, sv_ids
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        
        def handle_result(f):
            try:
                data = f.result()
            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            # Convert JSON string back to DataFrame
            df = pd.read_json(data)
            
            # Send JSON response
            self.set_header('Content-Type', 'application/json')
            self.finish(json.dumps(data))
            
class ZebraFishSyn2CoordHandlerHTML(BaseRequestHandler):

    @asynchronous
    def get(self):
        
        logger.debug('Zebrafish synapse coordinates requested')
        # sv_ids is a comma separated list of supervoxel ids
        sv_ids = self.get_arguments('sv_ids')
        if len(sv_ids) == 0:
            m = "Query argument 'sv_ids' is not found"
            logger.error(m)
            self.send_error(400, message=m)
            return

        if sv_ids[0] == '':
            m = "No supervoxel ids provided"
            logger.error(m)
            self.send_error(400, message=m)
            return

        # sv_ids is a list of string, need to convert to list of ints
        try:
            sv_ids = sv_ids[0].replace(' ', '').split(',')
            sv_ids = list(map(int, sv_ids))
        except ValueError as e:
            logger.error(e)
            self.send_error(400, message=e)
            return


        from neuroglancer.config import zf_params

        def extract_syn_coords(svs):
            svs = set(svs)
            data = []

            for sv in svs:  # Iterate through the list of supervoxels
                # From the back to the front:
                # 1. Check whether the current sv is a cs sv of a synapse
                # 2. Iterate through the indices of the cs sv which will be the same as the indices of the stored synapse(s)
                # 3. For each index retrieve the representative coordinates of the synapse(s)
                
                # syn_coords[sv].extend([zf_params['rep_coord'][cs_index].tolist() for cs_index in
                #                        zf_params['cs_lookup'][sv] if zf_params['cs_lookup'][sv]])
                # if zf_params['cs_lookup'][sv]:
                #     partners[sv].extend(list(zf_params['partner_lookup'][sv]))

                if zf_params['cs_lookup'][sv]:
                    for cs_index in zf_params['cs_lookup'][sv]:
                        partners = set(list(sum(zf_params['cs_ids'][cs_index], ())))
                        partners.discard(sv)
                        data.append([sv, zf_params['rep_coord'][cs_index], partners])

            
            df = pd.DataFrame(data, columns=['Queried SV', 'SYN Coordinates', 'CS Partner(s)'])
            return df.to_json(orient='records')
        
        future = self.server.thread_executor.submit(
            extract_syn_coords, sv_ids
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        def handle_result(f):
            try:
                data = f.result()
            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            # Convert JSON string back to DataFrame
            df = pd.read_json(data)
            # Render DataFrame as HTML table
            html_table = df.to_html(index=False)
            self.set_header('Content-type', 'text/html')
            self.finish(html_table)
            
            



class J0251SynapsesHandlerJSON(BaseRequestHandler):

    @asynchronous
    def get(self):

        logger.debug('J0251 synapses requested')

        # Get query parameters
        pre_celltype = self.get_argument('pre_celltype', default=None)
        post_celltype = self.get_argument('post_celltype', default=None)
        pre_neuron_ids_str = self.get_argument('pre_neuron_ids', default=None)
        post_neuron_ids_str = self.get_argument('post_neuron_ids', default=None)
        prob_min = float(self.get_argument('prob_min', default='0.6'))
        post_morph = int(self.get_argument('post_morph', default='-1'))
        size_min = float(self.get_argument('size_min', default='0.0'))
        min_pre_axon = float(self.get_argument('min_pre_axon', default='0.0'))
        min_pre_soma = float(self.get_argument('min_pre_soma', default='0.0'))
        min_pre_dend = float(self.get_argument('min_pre_dend', default='0.0'))
        min_post_axon = float(self.get_argument('min_post_axon', default='0.0'))
        min_post_soma = float(self.get_argument('min_post_soma', default='0.0'))
        min_post_dend = float(self.get_argument('min_post_dend', default='0.0'))
        method = self.get_argument('method', default='auto')
        return_fields_str = self.get_argument('return_fields', default='size')
        max_results = self.get_argument('max_results', default=None)

        # Cell types are now optional - if both omitted, query all synapses
        # When querying all synapses, ensure pre_celltype and post_celltype are in return_fields
        if pre_celltype is None and post_celltype is None:
            # Ensure cell type fields are returned when querying all synapses
            fields_list = [f.strip() for f in return_fields_str.split(',')]
            if 'pre_celltype' not in fields_list:
                fields_list.insert(0, 'pre_celltype')
            if 'post_celltype' not in fields_list:
                fields_list.insert(1, 'post_celltype')
            return_fields_str = ','.join(fields_list)

        # Parse return fields
        return_fields = tuple(f.strip() for f in return_fields_str.split(','))

        # Parse max_results
        if max_results is not None:
            try:
                max_results = int(max_results)
            except ValueError:
                logger.error("Invalid max_results parameter")
                self.send_error(400, message="max_results must be an integer")
                return

        # Parse neuron IDs if provided
        pre_neuron_ids = None
        post_neuron_ids = None

        if pre_neuron_ids_str:
            try:
                pre_neuron_ids = [int(x.strip()) for x in pre_neuron_ids_str.split(',')]
            except ValueError as e:
                logger.error(f"Invalid pre_neuron_ids: {e}")
                self.send_error(400, message=f"Invalid pre_neuron_ids: {e}")
                return

        if post_neuron_ids_str:
            try:
                post_neuron_ids = [int(x.strip()) for x in post_neuron_ids_str.split(',')]
            except ValueError as e:
                logger.error(f"Invalid post_neuron_ids: {e}")
                self.send_error(400, message=f"Invalid post_neuron_ids: {e}")
                return

        # Import backend and query synapses
        try:
            from neuroglancer import j0251_connectome_backend

            # Use new function that supports multiple fields
            data = j0251_connectome_backend.get_synapses_with_fields(
                pre_celltype=pre_celltype,
                post_celltype=post_celltype,
                pre_neuron_ids=pre_neuron_ids,
                post_neuron_ids=post_neuron_ids,
                method=method,
                return_fields=return_fields,
                prob_min=prob_min,
                post_morph=post_morph,
                size_min=size_min,
                min_pre_axon=min_pre_axon,
                min_pre_soma=min_pre_soma,
                min_pre_dend=min_pre_dend,
                min_post_axon=min_post_axon,
                min_post_soma=min_post_soma,
                min_post_dend=min_post_dend,
                max_results=max_results
            )

            # Convert numpy arrays to lists for JSON serialization
            result = {
                field: data[field].tolist() for field in return_fields
            }

            # Add metadata
            result['count'] = len(data[return_fields[0]])

            # Add summary stats for 'size' if requested
            if 'size' in return_fields:
                sizes = data['size']
                result['total_size'] = float(sizes.sum()) if len(sizes) > 0 else 0.0
                result['mean_size'] = float(sizes.mean()) if len(sizes) > 0 else 0.0

            self.set_header('Content-Type', 'application/json')
            self.set_header('Access-Control-Allow-Origin', '*')
            self.finish(json.dumps(result))

        except Exception as e:
            logger.error(f"Error querying synapses: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, message=str(e))
            return
            return


class J0251NeuronsHandlerJSON(BaseRequestHandler):
    """
    Handler for neuron filtering queries.
    Returns neurons matching specified criteria including synapse count thresholds.
    """

    @asynchronous
    def get(self):

        logger.debug('J0251 neurons filter requested')

        # Get query parameters
        celltype = self.get_argument('celltype', default=None)
        target_celltype = self.get_argument('target_celltype', default=None)
        direction = self.get_argument('direction', default='outgoing')
        min_synapses = int(self.get_argument('min_synapses', default='0'))
        min_celltype_certainty = float(self.get_argument('min_celltype_certainty', default='0.0'))
        min_axon_length = float(self.get_argument('min_axon_length', default='0.0'))
        min_soma_length = float(self.get_argument('min_soma_length', default='0.0'))
        min_dendrite_length = float(self.get_argument('min_dendrite_length', default='0.0'))
        prob_min = float(self.get_argument('prob_min', default='0.6'))

        if celltype is None:
            m = "Query parameter 'celltype' is required"
            logger.error(m)
            self.send_error(400, message=m)
            return

        # Import backend and query neurons
        try:
            from neuroglancer import j0251_connectome_backend

            data = j0251_connectome_backend.get_filtered_neurons(
                celltype=celltype,
                target_celltype=target_celltype,
                direction=direction,
                min_synapses=min_synapses,
                min_celltype_certainty=min_celltype_certainty,
                min_axon_length=min_axon_length,
                min_soma_length=min_soma_length,
                min_dendrite_length=min_dendrite_length,
                prob_min=prob_min
            )

            # Convert numpy arrays to lists for JSON serialization
            result = {
                'neuron_ids': data['neuron_ids'].tolist(),
                'synapse_counts': data['synapse_counts'].tolist(),
                'count': len(data['neuron_ids'])
            }

            self.set_header('Content-Type', 'application/json')
            self.set_header('Access-Control-Allow-Origin', '*')
            self.finish(json.dumps(result))

        except Exception as e:
            logger.error(f"Error querying neurons: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, message=str(e))
            return


class J0251SkeletonHandlerJSON(BaseRequestHandler):
    """
    Handler for fetching neuron skeletons.
    Returns skeleton data in neuroglancer precomputed format.
    """

    @asynchronous
    def get(self):
        logger.debug("J0251 skeleton requested")

        neuron_id = self.get_argument("neuron_id", default=None)
        
        if neuron_id is None:
            m = "Query parameter 'neuron_id' is required"
            logger.error(m)
            self.send_error(400, message=m)
            return

        try:
            neuron_id = int(neuron_id)
        except ValueError:
            m = "neuron_id must be an integer"
            logger.error(m)
            self.send_error(400, message=m)
            return

        try:
            from neuroglancer.config import params
            from syconn.analysis.utils import get_encoded_skeleton
            
            # Get skeleton for the neuron
            future = self.server.thread_executor.submit(
                get_encoded_skeleton, params["ssd"], neuron_id
            )

            tornado.concurrent.future_add_done_callback(
                future,
                lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
            )

            def handle_result(f):
                try:
                    encoded_skeleton = f.result()
                except Exception as e:
                    logger.error(f"Error getting skeleton: {e}")
                    self.send_error(500, message=str(e))
                    return

                if len(encoded_skeleton) == 0:
                    logger.error(f"Skeleton not available for neuron_id: {neuron_id}")
                    self.send_error(404, message=f"Skeleton not found for neuron {neuron_id}")
                    return

                # Return gzip-compressed binary data (neuroglancer format)
                self.set_header("Access-Control-Allow-Origin", "*")
                self.set_header("Content-Type", "application/octet-stream")
                self.set_header("Content-Encoding", "gzip")
                self.finish(gzip.compress(encoded_skeleton, compresslevel=6))

        except Exception as e:
            logger.error(f"Error processing skeleton request: {e}")


class J0251MeshHandlerJSON(BaseRequestHandler):
    @asynchronous
    def get(self):
        logger.debug('J0251 mesh requested')
        neuron_id = self.get_argument('neuron_id', default=None)
        obj_type = self.get_argument('obj_type', default='ax')
        
        if neuron_id is None:
            m = "Query parameter 'neuron_id' is required"
            logger.error(m)
            self.send_error(400, message=m)
            return

        try:
            neuron_id = int(neuron_id)
        except ValueError:
            m = "neuron_id must be an integer"
            logger.error(m)
            self.send_error(400, message=m)
            return

        try:
            from neuroglancer.config import params
            from syconn.analysis.utils import get_encoded_mesh
            
            future = self.server.thread_executor.submit(
                get_encoded_mesh, params["ssd"], neuron_id, obj_type
            )

            tornado.concurrent.future_add_done_callback(
                future,
                lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
            )

            def handle_result(f):
                try:
                    encoded_mesh = f.result()
                except Exception as e:
                    logger.error(f"Error getting mesh: {e}")
                    self.send_error(500, message=str(e))
                    return

                if len(encoded_mesh) == 0:
                    logger.error(f'Mesh not available for neuron_id: {neuron_id}, obj_type: {obj_type}')
                    self.send_error(404, message=f'Mesh not found for neuron {neuron_id}, type {obj_type}')
                    return

                self.set_header('Access-Control-Allow-Origin', '*')
                self.set_header('Content-Type', 'application/octet-stream')
                self.finish(encoded_mesh)

        except Exception as e:
            logger.error(f"Error processing mesh request: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, message=str(e))
            return

            import traceback
            traceback.print_exc()
            self.send_error(500, message=str(e))
            return

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


def read_file(params, filename):
    with open(os.path.join("/home/shared", f"{params.acquisition}", f"{params.acquisition}_{params.version}", filename), "rb") as f:
        data = f.read()

    return data
