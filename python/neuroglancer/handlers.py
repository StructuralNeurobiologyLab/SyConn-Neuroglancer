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
import concurrent.futures
import zipfile
import urllib
import re
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict

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

PRECOMPUTED_SKELETON_INFO_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/skeletons/info$'

PRECOMPUTED_SKELETON_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/skeletons/(?P<ssv_id>[0-9]+)$'

PRECOMPUTED_MESH_INFO_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]{2})/info$'

PRECOMPUTED_MESH_META_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9])$'

PRECOMPUTED_MESH_REGEX = r'^/(?P<viewer_token>[^/]+)/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9]):\5_mesh$'

PRECOMPUTED_VOLUME_INFO_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/info$'

PRECOMPUTED_VOLUME_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

PRECOMPUTED_SEG_PROPS_INFO_REGEX = r'^/(?P<acquisition>[^/]+)/(?P<version>[^/]+)/properties/info$'

ZEBRAFISH_SYN_COORD_REGEX = r'^/(?P<sv_ids>[0-9]+)$'


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
        logger.debug(f"URI not found: {self.request.uri}")
        self.render("notFound.html")


class TutorialsHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("tutorials.html")


class AboutHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("about.html")


class TokenHandler(BaseRequestHandler):
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

        if config.dev_environ:
            source = f'http://localhost:9002'  
        
        else:
            source = f'https://syconn.esc.mpcdf.mpg.de'

        token = make_random_token()
        
        use_tpl_mask = True
        if params.version == "rag_flat_Jan2019_v3":
            logger.debug("Using j0251_rag_flat_Jan2019_v3")
            # sharded precomputed
            seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image/test'
            
        elif params.version == "72_seg_20210127_agglo2":
            logger.debug("Using j0251_72_seg_20210127_agglo2")
            # sharded precomputed
            seg_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.acquisition}_{params.version}/image'

        else:  # for j0126
            logger.debug("Using j0126")
            seg_src = 'precomputed://' + source + '/volume/segmentation'  # unsharded precomputed segmentation
            img_src = 'precomputed://' + source + '/j0126/volume/image'  # sharded precomputed image
            use_tpl_mask = False

        pf = PropertyFilter(params, token, ['mi', 'vc', 'sj'], use_tpl_mask=use_tpl_mask, seg_src=seg_src, img_src=img_src)
        # logger.debug(f"Viewer instances in memory: {len(config.global_server.viewers.keys())}")

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

        if config.dev_environ:
            source = f'http://localhost:9002'  
        
        else:
            source = f'https://syconn.esc.mpcdf.mpg.de'

        token = make_random_token()

        use_tpl_mask = True
        if params.version == "j0251_rag_flat_Jan2019_v3":
            logger.debug("Shared URL: Using j0251_rag_flat_Jan2019_v3")
            seg_src = 'precomputed://' + source + f'/{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.version}/image/test'

        elif params.version == "j0251_72_seg_20210127_agglo2":
            logger.debug("Shared URL: Using j0251_72_seg_20210127_agglo2")
            seg_src = 'precomputed://' + source + f'/{params.version}/segmentation'
            img_src = 'precomputed://' + source + f'/{params.version}/image'

        else:  # for j0126
            logger.debug("Shared URL: Using j0126")
            seg_src = 'precomputed://' + source + '/volume/segmentation'
            img_src = 'precomputed://' + source + '/j0126/volume/image'
            use_tpl_mask = False  # total path length filtering is not required

        pf = PropertyFilter(params, token, ['mi', 'vc', 'sj'], use_tpl_mask=use_tpl_mask, seg_src=seg_src, img_src=img_src)
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

        if acquisition == "j0126":
            viewer = self.server.viewers.get(viewer_token)
            
            with viewer.txn() as s:
                # for l in s.layers:
                #     if isinstance(l.layer, neuroglancer.SegmentationLayer) and (l.name == acquisition + "_" + version):
                #         seg_layer = l
                #         break
                try:
                    if not (params["ssd"].ssv_ids == ssv_id).any():
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
            get_encoded_mesh, params["ssd"], new_ssv_id, obj_type
        )

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

        def handle_result(f):
            try:
                encoded_mesh = f.result()

            except Exception as e:
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


class ZebraFishSyn2CoordHandler(BaseRequestHandler):
    def get(self, sv_ids):
        from neuroglancer.config import zf_params

        ssv_lookup = zf_params["ssd"].sv2ssv_ids(sv_ids)
        result = {}
        for ssv_id in ssv_lookup.keys():
            queried_svs = zf_params["ssd"].mapping_dict[ssv_id]
            result[ssv_id] = extract_syn_coords(queried_svs)

        self.finish(json.dumps(result, 'utf-8'))

        def extract_syn_coords(svs):
            syn_coords = defaultdict(list)
            syn_indexes = defaultdict(list)
            
            for syn_index, cs in enumerate(zf_params["cs_ids"]):
                cs1, cs2 = cs[0]
                if cs1 in svs:
                    if cs1 in ssv_lookup.keys():
                        syn_indexes[ssv_lookup[cs1]].append(syn_index)
                if cs2 in svs:
                    if cs2 in ssv_lookup.keys():
                        syn_indexes[ssv_lookup[cs2]].append(syn_index)

            for ssv_id, syn_indexs in syn_indexes.items():
                for syn_index in syn_indexs:
                    syn_coords[ssv_id].append(zf_params["rep_coord"][syn_index])
            return syn_coords


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
